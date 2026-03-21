function setText(id, value) {
    const elements = document.querySelectorAll(`#${id}`);
    elements.forEach(el => el.textContent = value);
}

function formatNumber(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return '0';
    return num.toLocaleString();
}

function toggleUserDropdown() {
    const menu = document.getElementById('userDropdownMenu');
    const trigger = document.querySelector('.user-dropdown-trigger');
    if (menu && trigger) {
        menu.classList.toggle('show');
        trigger.classList.toggle('active');
    }
}

function closePunishmentHistory() {
    const modal = document.getElementById('punishmentHistoryModal');
    if (modal) modal.style.display = 'none';
}

function showDashboardInfo(title, description) {
    const modal = document.getElementById('infoModal');
    if (!modal) return;
    document.getElementById('infoModalTitle').textContent = title;
    document.getElementById('infoModalText').textContent = description;
    modal.style.display = 'flex';
}

function closeInfoModal() {
    const modal = document.getElementById('infoModal');
    if (modal) modal.style.display = 'none';
}

async function loadAccountHeader() {
    try {
        if (!window.AdminPanel?.api?.getAccountInfo) return;
        const accountInfo = await window.AdminPanel.api.getAccountInfo();
        const username = accountInfo?.username || 'User';
        const roleLabel = String(accountInfo?.role || 'user').toUpperCase();

        setText('headerUsername', username);
        setText('headerRole', roleLabel);
        setText('dropdownUsername', username);
        setText('dropdownRole', roleLabel);

        if (typeof window.AdminPanel.api.applyRoleVisibility === 'function') {
            window.AdminPanel.api.applyRoleVisibility(accountInfo || {});
        }
    } catch {
    }
}

function setDbStatus(dbHealth) {
    if (!dbHealth) {
        setText('statDbStatus', 'Unavailable');
        return;
    }

    if (dbHealth.ok) {
        const latency = Number.isFinite(Number(dbHealth.latencyMs)) ? `${Number(dbHealth.latencyMs)}ms` : 'online';
        setText('statDbStatus', `Online (${latency})`);
        return;
    }

    setText('statDbStatus', 'Offline');
}

async function loadDashboardStats() {
    if (!window.AdminPanel?.api?.getJson) return;

    const [statsRes, todayRes, allRes] = await Promise.allSettled([
        window.AdminPanel.api.getJson('/api/stats', { cache: 'no-store' }),
        window.AdminPanel.api.getJson('/api/stats/today', { cache: 'no-store' }),
        window.AdminPanel.api.getJson('/api/dashboard/all', { cache: 'no-store' })
    ]);

    const readData = (result) => {
        if (result.status !== 'fulfilled') return null;
        const payload = result.value;
        if (!payload?.response?.ok) return null;
        return payload.data || null;
    };

    const stats = readData(statsRes) || {};
    const today = readData(todayRes) || {};
    const combined = readData(allRes) || {};

    const levels = Array.isArray(combined.levels) ? combined.levels : [];
    const warns = Array.isArray(combined.warns) ? combined.warns : [];
    const reminders = Array.isArray(combined.reminders) ? combined.reminders : [];

    const totalUsers = Number(stats.totalUsers ?? levels.length ?? 0);
    const totalWarns = Number(stats.totalWarns ?? stats.totalWarnings ?? warns.reduce((sum, row) => sum + (Number(row.warnCount) || 0), 0));
    const activeReminders = Number(stats.activeReminders ?? stats.totalReminders ?? reminders.length ?? 0);
    const totalGiveaways = Number(stats.totalGiveaways ?? combined.giveawaysCount ?? 0);
    const totalBanned = Number(stats.bannedUsers ?? combined.bannedUsersCount ?? 0);
    const activeTickets = Number(stats.activeTickets ?? 0);

    const avgLevel = Number(stats.avgLevel ?? 0);
    const totalXP = Number(stats.totalXP ?? levels.reduce((sum, row) => sum + (Number(row.xp) || 0), 0));
    const avgWarns = Number(stats.avgWarns ?? (totalUsers > 0 ? totalWarns / totalUsers : 0));
    const banRate = Number(stats.banRate ?? (totalUsers > 0 ? (totalBanned / totalUsers) * 100 : 0));

    setText('statTotalUsers', formatNumber(totalUsers));
    setText('statTotalWarns', formatNumber(totalWarns));
    setText('statActiveReminders', formatNumber(activeReminders));
    setText('statTotalGiveaways', formatNumber(totalGiveaways));
    setText('statTotalBanned', formatNumber(totalBanned));
    setText('statActiveTickets', formatNumber(activeTickets));
    setText('warnsToday', formatNumber(today.warnsToday || 0));
    setText('commandsToday', formatNumber(today.commandsToday || 0));

    setText('avgLevel', Number.isFinite(avgLevel) ? avgLevel.toFixed(2) : '0.00');
    setText('totalXP', formatNumber(totalXP));
    setText('avgWarns', Number.isFinite(avgWarns) ? avgWarns.toFixed(2) : '0.00');
    setText('banRate', `${Number.isFinite(banRate) ? banRate.toFixed(2) : '0.00'}%`);
    setText('summaryActiveReminders', formatNumber(activeReminders));

    setText('statAdminCount', formatNumber(stats.adminCount || 0));
    setText('statTopUser', stats.topUserName || 'None');
    setText('statMostWarned', stats.mostWarnedUserName || 'None');

    setDbStatus(combined.dbHealth);

    try {
        renderRiskMatrix(levels, warns);
        renderRetentionChart(levels);
    } catch (e) {
        console.error("Error rendering advanced dashboard components:", e);
    }
}

let riskMatrixChart = null;
let retentionChart = null;

function renderRiskMatrix(levelsList, warnsList) {
    const ctx = document.getElementById('riskMatrixChart');
    if (!ctx) return;

    if (riskMatrixChart) riskMatrixChart.destroy();

    const userData = {};

    (levelsList || []).forEach(u => {
        userData[u.userId || u.user_id] = {
            x: u.level || 0,
            y: 0,
            r: 5,
            userId: u.userId || u.user_id
        };
    });

    (warnsList || []).forEach(w => {
        const uid = w.userId || w.user_id;
        if (!userData[uid]) {
            userData[uid] = { x: 0, y: 0, r: 5, userId: uid };
        }
        userData[uid].y = Number(w.warnCount) || 0;
    });

    const dataset = Object.values(userData).filter(p => p.x > 0 || p.y > 0);

    const pointColors = dataset.map(p => {
        if (p.y > 5) return 'rgba(239, 68, 68, 0.8)';
        if (p.y > 2) return 'rgba(245, 158, 11, 0.8)';
        if (p.x > 10) return 'rgba(16, 185, 129, 0.8)';
        return 'rgba(59, 130, 246, 0.6)';
    });

    riskMatrixChart = new Chart(ctx, {
        type: 'scatter',
        data: {
            datasets: [{
                label: 'User Analysis',
                data: dataset,
                backgroundColor: pointColors,
                borderColor: 'transparent',
                pointHoverRadius: 8
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (ctx) => `User: ${ctx.raw.userId} (Lvl: ${ctx.raw.x}, Warns: ${ctx.raw.y})`
                    }
                }
            },
            scales: {
                x: {
                    title: { display: true, text: 'Experience Level (Loyalty)', color: '#6b7280' },
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: '#9ca3af' },
                    beginAtZero: true
                },
                y: {
                    title: { display: true, text: 'Warning Count (Risk)', color: '#6b7280' },
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: '#9ca3af' },
                    beginAtZero: true
                }
            }
        }
    });
}

function renderRetentionChart(levelsList) {
    const ctx = document.getElementById('retentionChart');
    if (!ctx) return;

    if (retentionChart) retentionChart.destroy();

    let buckets = { 'New (1-5)': 0, 'Regular (6-15)': 0, 'Veteran (16-30)': 0, 'Elite (30+)': 0 };

    (levelsList || []).forEach(u => {
        const lvl = u.level || 0;
        if (lvl <= 5) buckets['New (1-5)']++;
        else if (lvl <= 15) buckets['Regular (6-15)']++;
        else if (lvl <= 30) buckets['Veteran (16-30)']++;
        else buckets['Elite (30+)']++;
    });

    retentionChart = new Chart(ctx, {
        type: 'polarArea',
        data: {
            labels: Object.keys(buckets),
            datasets: [{
                data: Object.values(buckets),
                backgroundColor: [
                    'rgba(59, 130, 246, 0.5)',
                    'rgba(16, 185, 129, 0.5)',
                    'rgba(139, 92, 246, 0.5)',
                    'rgba(245, 158, 11, 0.5)'
                ],
                borderWidth: 1,
                borderColor: [
                    'rgba(59, 130, 246, 1)',
                    'rgba(16, 185, 129, 1)',
                    'rgba(139, 92, 246, 1)',
                    'rgba(245, 158, 11, 1)'
                ]
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                r: {
                    grid: { color: 'rgba(255, 255, 255, 0.1)' },
                    ticks: { display: false, backdropColor: 'transparent' }
                }
            },
            plugins: {
                legend: {
                    position: 'right',
                    labels: { color: '#9ca3af', font: { size: 11 } }
                }
            }
        }
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    await loadAccountHeader();
    await loadDashboardStats();
});

function refreshDashboardVisibleData() {
    loadDashboardStats().catch(() => { });
}

if (window.AdminPanel) {
    window.AdminPanel.refreshVisibleData = refreshDashboardVisibleData;
}

document.addEventListener('adminpanel:refresh-visible-data', refreshDashboardVisibleData);

document.addEventListener('click', function (event) {
    const dropdown = document.querySelector('.user-dropdown');
    if (dropdown && !dropdown.contains(event.target)) {
        const menu = document.getElementById('userDropdownMenu');
        const trigger = document.querySelector('.user-dropdown-trigger');
        if (menu) menu.classList.remove('show');
        if (trigger) trigger.classList.remove('active');
    }
});
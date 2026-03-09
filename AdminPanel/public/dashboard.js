function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
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

    setDbStatus(combined.dbHealth);
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
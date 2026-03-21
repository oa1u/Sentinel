fetch('/Config/main.json')
    .then((response) => {
        if (!response.ok) throw new Error(`Config request failed with status ${response.status}`);
        return response.json();
    })
    .then((config) => {
        document.querySelectorAll('.websiteName').forEach((el) => {
            el.textContent = config.websiteName;
        });
    })
    .catch((error) => {
        console.warn('Failed to load panel config:', error);
    });

window.currentAdminRole = window.currentAdminRole || '';
window._appealsPending = [];
window._appealsHistory = [];
window._autoModConfig = null;
window._appealsLoadNonce = 0;
window._appealHistoryLoadNonce = 0;


const safeHtml = (t) => String(t).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": "&#039;"
})[c]);

const getCurrentRole = () => String(window.currentAdminRole || '').toLowerCase();
const isOwner = () => getCurrentRole() === 'owner';

document.addEventListener('DOMContentLoaded', async () => {
    if (window.setWebsiteNameTitle) window.setWebsiteNameTitle();
    try {
        let api = window.api || (window.AdminPanel && window.AdminPanel.api);
        if (api && typeof api.getAccountInfo === 'function') {
            const accountInfo = await api.getAccountInfo();
            if (accountInfo) {
                window.currentAdminRole = String(accountInfo.role || '').toLowerCase();
                const userDisplay = document.getElementById('headerUsername');
                if (userDisplay) userDisplay.textContent = accountInfo.username || 'User';
                const roleBadge = document.getElementById('headerRole');
                if (roleBadge) roleBadge.textContent = (accountInfo.role || 'User').toUpperCase();
                const dropdownUsername = document.getElementById('dropdownUsername');
                if (dropdownUsername) dropdownUsername.textContent = accountInfo.username || 'User';
                const dropdownRole = document.getElementById('dropdownRole');
                if (dropdownRole) dropdownRole.textContent = (accountInfo.role || 'User').toUpperCase();

                if (typeof api.applyRoleVisibility === 'function') {
                    api.applyRoleVisibility(accountInfo || {});
                }
            }
        }
    } catch (err) { console.error("Account sync failed", err); }

    const automodTabButton = document.querySelector('.tab[data-tab="automod"]');
    if (automodTabButton && !isOwner()) {
        automodTabButton.style.display = 'none';
    }

    document.querySelectorAll('.tab').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const tabName = btn.dataset.tab;
            if (tabName) switchTab(e, tabName, btn);
        });
    });

    await runAdminPanel();

    setupAppealsQueueInteractions();

    loadDashboardStats();

    const activeTabName = document.querySelector('.tab.active')?.dataset?.tab;
    if (activeTabName) {
        switchTab(null, activeTabName);
    }
});

async function getAdminApiClient(timeoutMs = 3000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const api = window?.AdminPanel?.api || window?.api;
        if (api && typeof api.getJson === 'function') return api;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return null;
}

function switchTab(e, tabName, btn) {
    if (e && e.preventDefault) e.preventDefault();

    const tabButtons = document.querySelectorAll('.tab');
    const tabContents = document.querySelectorAll('.tab-content');

    tabButtons.forEach(b => b.classList.remove('active'));
    tabContents.forEach(tc => {
        tc.classList.remove('active');
        tc.style.display = 'none';
    });

    const activeBtn = tabName ? document.querySelector(`.tab[data-tab="${tabName}"]`) : btn;
    if (activeBtn) activeBtn.classList.add('active');

    const content = document.getElementById(tabName);
    if (content) {
        content.classList.add('active');
        content.style.display = '';
    }

    if (tabName === 'banned-users' && typeof loadBannedUsers === 'function') loadBannedUsers();
    else if (tabName === 'appeals') loadAppeals();
    else if (tabName === 'appeals-history') loadAppealHistory();
    else if (tabName === 'xp-leaderboard') loadAdminXpLeaderboard();
    else if (tabName === 'ghostpings') loadGhostPings();
    else if (tabName === 'suggestions') loadSuggestions();
    else if (tabName === 'automod') {
        if (isOwner()) loadAutoModConfig();
        else {
            const statusEl = document.getElementById('automodStatusMessage');
            if (statusEl) statusEl.textContent = 'AutoMod settings are owner-only.';
        }
    }
}

async function loadAdminXpLeaderboard() {
    const container = document.getElementById('adminXpLeaderboardContainer');
    if (!container) return;

    container.innerHTML = '<div class="loading show">Loading leaderboard...</div>';

    try {
        const { response, data } = await window.AdminPanel.api.getJson('/api/admin/search-users-advanced');
        if (!response?.ok) {
            throw new Error(data?.error || 'Failed to load leaderboard');
        }

        const rows = Array.isArray(data?.results) ? data.results : [];
        const ranked = rows
            .map((item) => ({
                userId: String(item?.userId || ''),
                username: String(item?.username || 'Unknown'),
                level: Number(item?.level || 0),
                xp: Number(item?.xp || 0)
            }))
            .filter((item) => item.userId)
            .sort((a, b) => (b.level - a.level) || (b.xp - a.xp))
            .slice(0, 10);

        if (!ranked.length) {
            container.innerHTML = '<p class="text-center text-muted" style="padding: 1rem;">No XP data available yet.</p>';
            return;
        }

        let html = `
            <table>
                <thead>
                    <tr>
                        <th style="width:72px;">Rank</th>
                        <th>User</th>
                        <th>User ID</th>
                        <th style="width:100px;">Level</th>
                        <th style="width:140px;">XP</th>
                    </tr>
                </thead>
                <tbody>
        `;

        ranked.forEach((entry, index) => {
            const rank = index + 1;
            const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '';
            html += `
                <tr>
                    <td><strong>#${rank}</strong> ${medal}</td>
                    <td>${safeHtml(entry.username)}</td>
                    <td>${safeHtml(entry.userId)}</td>
                    <td>${entry.level.toLocaleString()}</td>
                    <td>${entry.xp.toLocaleString()}</td>
                </tr>
            `;
        });

        html += '</tbody></table>';
        container.innerHTML = html;
    } catch (error) {
        console.error('Failed to load XP leaderboard:', error);
        container.innerHTML = '<p class="text-center text-danger" style="padding: 1rem;">Failed to load XP leaderboard.</p>';
    }
}

window.currentAppealsPendingPage = 1;
window.currentAppealsHistoryPage = 1;
window._appealHistoryRenderRows = [];
window._appealHistorySelectedIndex = -1;
window._appealsPendingRenderRows = [];
window._appealsPendingSelectedIndex = -1;

async function loadAppeals() {
    const list = document.getElementById('appealsQueueList');
    if (!list) return;
    list.innerHTML = `<div class="appeals-queue-empty">Loading appeals...</div>`;

    const loadNonce = ++window._appealsLoadNonce;

    try {
        const api = await getAdminApiClient();
        if (!api) throw new Error('Admin API is not ready');

        const { response, data } = await api.getJson('/api/appeals/pending', { cache: 'no-store' });
        if (!response?.ok) throw new Error("Failed to fetch");

        if (loadNonce !== window._appealsLoadNonce) return;

        window._appealsPending = Array.isArray(data) ? data : (data?.appeals || []);
        renderAppealsPage(window.currentAppealsPendingPage);
    } catch (err) {
        console.error("Error loading pending appeals:", err);
        adminShowNotification('Could not load appeals', 'error');
        list.innerHTML = `<div class="appeals-queue-empty text-danger">Could not load appeals. Try refreshing.</div>`;
    }
}

window.resetAppealsFilters = function () {
    const setValue = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.value = value;
    };
    setValue('appealsSearchInput', '');
    setValue('appealsUserFilter', '');
    setValue('appealsDateFilter', 'all');
    setValue('appealsSort', 'newest');
    setValue('appealsPageSize', '10');
    renderAppealsPage(1);
};

function formatAppealsRelativeTime(value) {
    const date = new Date(value || 0);
    if (Number.isNaN(date.getTime())) return '-';

    const diffMs = Date.now() - date.getTime();
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;

    if (diffMs < hour) return `${Math.max(1, Math.floor(diffMs / minute))}m ago`;
    if (diffMs < day) return `${Math.floor(diffMs / hour)}h ago`;
    return `${Math.floor(diffMs / day)}d ago`;
}

function renderAppealsMetrics(rows) {
    const total = rows.length;
    const cutoff24h = Date.now() - (24 * 60 * 60 * 1000);
    const recent24h = rows.filter((item) => {
        const ts = new Date(item.created_at || item.submitted_at || item.updated_at || 0).getTime();
        return Number.isFinite(ts) && ts >= cutoff24h;
    }).length;
    const uniqueUsers = new Set(
        rows
            .map((item) => String(item.user_id || item.user_tag || item.user || '').trim().toLowerCase())
            .filter(Boolean)
    ).size;
    const priority = rows.filter((item) => {
        const text = `${item.reason || ''} ${item.user_tag || item.user || ''}`.toLowerCase();
        return text.includes('false ban') || text.includes('wrongful') || text.includes('urgent') || text.includes('mistake');
    }).length;

    const setVal = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.textContent = Number(value || 0).toLocaleString();
    };

    setVal('appealsMetricPending', total);
    setVal('appealsMetricPriority', priority);
    setVal('appealsMetricRecent', recent24h);
    setVal('appealsMetricUsers', uniqueUsers);

    const summaryEl = document.getElementById('appealsQueueStats');
    if (summaryEl) {
        const queueLoad = total > 0 ? `${Math.round((recent24h / total) * 100)}` : '0';
        summaryEl.innerHTML = `
            <span class="stat-pill">${total.toLocaleString()} Pending</span>
            <span class="stat-pill text-muted">${recent24h.toLocaleString()} New (24h)</span>
        `;
    }
}

function renderAppealPendingDetails(item) {
    const record = item || {};
    const reason = String(record.reason || 'No reason provided.').replace(/\r\n/g, '\n').trim();
    const responseGiven = String(
        record.response
        || record.moderator_response
        || record.review_response
        || record.decision_response
        || ''
    ).replace(/\r\n/g, '\n').trim();
    const setText = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.textContent = value || '-';
    };

    setText('appealsDetailUser', record.user_tag || record.user || 'Unknown');
    setText('appealsDetailUserId', record.user_id || 'N/A');
    setText('appealsDetailCaseId', record.ban_case_id || 'N/A');
    setText('appealsDetailSubmitted', record.created_at ? new Date(record.created_at).toLocaleString() : '-');
    setText('appealsDetailReason', reason || 'No reason provided.');
    setText('appealsDetailResponse', responseGiven || 'No response yet.');

    const acceptBtn = document.getElementById('appealsDetailAcceptBtn');
    const denyBtn = document.getElementById('appealsDetailDenyBtn');
    const hasRecord = Boolean(record && record.id);

    if (acceptBtn) {
        acceptBtn.disabled = !hasRecord;
        acceptBtn.onclick = hasRecord
            ? () => acceptAppeal(record.id, record.user_tag || record.user || 'Unknown')
            : null;
    }
    if (denyBtn) {
        denyBtn.disabled = !hasRecord;
        denyBtn.onclick = hasRecord
            ? () => denyAppeal(record.id, record.user_tag || record.user || 'Unknown')
            : null;
    }

    const panel = document.getElementById('appealsQueueDetailPanel');
    if (panel) {
        panel.classList.remove('appeals-queue-detail-panel--flash');
        void panel.offsetWidth;
        panel.classList.add('appeals-queue-detail-panel--flash');
    }
}

window.openAppealPendingDetails = function (index) {
    const selectedIndex = Number(index);
    const item = window._appealsPendingRenderRows?.[selectedIndex];
    if (!item) return;
    window._appealsPendingSelectedIndex = selectedIndex;
    renderAppealPendingDetails(item);
    syncAppealsPendingSelectedRow();
};

function syncAppealsPendingSelectedRow() {
    const selected = Number(window._appealsPendingSelectedIndex);
    document.querySelectorAll('#appealsQueueList .appeals-queue-item[data-appeal-index]').forEach((row) => {
        const rowIndex = Number(row.getAttribute('data-appeal-index'));
        if (rowIndex === selected) row.classList.add('appeals-queue-row-selected');
        else row.classList.remove('appeals-queue-row-selected');
    });
}

function getFilteredAppeals() {
    const all = window._appealsPending || [];
    const q = (document.getElementById('appealsSearchInput')?.value || '').trim().toLowerCase();
    const userFilter = (document.getElementById('appealsUserFilter')?.value || '').trim().toLowerCase();
    const dateDays = Number(document.getElementById('appealsDateFilter')?.value || 0);
    const minDate = dateDays > 0 ? (Date.now() - dateDays * 24 * 60 * 60 * 1000) : null;

    return all.filter(a => {
        const username = String(a.user_tag || a.user || '').toLowerCase();
        const caseId = String(a.ban_case_id || '').toLowerCase();
        const userId = String(a.user_id || '').toLowerCase();
        const createdAtMs = new Date(a.created_at || a.submitted_at || a.updated_at || 0).getTime();

        if (userFilter && !userId.includes(userFilter)) return false;
        if (minDate && (!Number.isFinite(createdAtMs) || createdAtMs < minDate)) return false;
        if (!q) return true;

        return username.includes(q) || caseId.includes(q) || userId.includes(q);
    });
}

function renderAppealsPage(page = 1) {
    const list = document.getElementById('appealsQueueList');
    const controls = document.getElementById('appealsControls');
    if (!list) return;

    window.currentAppealsPendingPage = page;

    const pageSize = parseInt(document.getElementById('appealsPageSize')?.value) || 10;
    const sortMode = document.getElementById('appealsSort')?.value || 'newest';
    const searchValue = (document.getElementById('appealsSearchInput')?.value || '').trim();
    const userFilterValue = (document.getElementById('appealsUserFilter')?.value || '').trim();
    const dateFilterValue = document.getElementById('appealsDateFilter')?.value || 'all';
    const hasActiveFilters = Boolean(searchValue || userFilterValue || dateFilterValue !== 'all');

    const rows = getFilteredAppeals();

    if (sortMode === 'oldest') {
        rows.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
    } else if (sortMode === 'user') {
        rows.sort((a, b) => String(a.user_tag || a.user || '').localeCompare(String(b.user_tag || b.user || '')));
    } else if (sortMode === 'case') {
        rows.sort((a, b) => String(a.ban_case_id || '').localeCompare(String(b.ban_case_id || '')));
    } else {
        rows.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    }

    renderAppealsMetrics(rows);
    window._appealsPendingRenderRows = rows;

    const pages = Math.max(1, Math.ceil(rows.length / pageSize));
    if (page > pages) page = pages;

    const start = (page - 1) * pageSize;
    const slice = rows.slice(start, start + pageSize);

    if (!slice.length) {
        const message = hasActiveFilters ? 'No appeals match the current filters.' : 'No pending appeals right now.';
        const subMessage = hasActiveFilters ? 'Try adjusting your search terms.' : "Great job! You're all caught up.";

        list.innerHTML = `
        <div class="appeals-queue-empty">
            <div class="icon">📭</div>
            <div class="message">${message}</div> 
            <div class="sub-message">${subMessage}</div>
        </div>`;

        window._appealsPendingSelectedIndex = -1;
        renderAppealPendingDetails(null);
    } else {
        const hasExistingSelection = Number.isFinite(Number(window._appealsPendingSelectedIndex))
            && Number(window._appealsPendingSelectedIndex) >= start
            && Number(window._appealsPendingSelectedIndex) < (start + slice.length);

        if (!hasExistingSelection) {
            window._appealsPendingSelectedIndex = start;
        }

        list.innerHTML = slice.map((a, idx) => {
            const globalIndex = start + idx;
            const submitted = a.created_at ? new Date(a.created_at).toLocaleString() : '-';
            const submittedRelative = formatAppealsRelativeTime(a.created_at || a.submitted_at || a.updated_at);
            const reason = String(a.reason || 'No reason provided').replace(/\r\n/g, '\n').trim();
            const reasonPreview = reason.length > 165 ? `${reason.slice(0, 165)}...` : reason;
            const isSelected = globalIndex === Number(window._appealsPendingSelectedIndex);

            return `
            <article class="appeals-queue-item ${isSelected ? 'appeals-queue-row-selected' : ''}" data-appeal-index="${globalIndex}" role="button" tabindex="0">
                <div class="appeals-queue-item-head">
                    <div class="appeals-queue-user-cell">
                        <strong>${safeHtml(a.user_tag || a.user || 'Unknown')}</strong>
                        <small class="text-muted">${safeHtml(a.user_id || 'N/A')}</small>
                    </div>
                    <div class="appeals-queue-item-meta">
                        <code>${safeHtml(a.ban_case_id || 'N/A')}</code>
                        <span class="text-muted">${submittedRelative}</span>
                    </div>
                </div>
                <div class="appeals-queue-item-reason" title="${safeHtml(reason)}">${safeHtml(reasonPreview)}</div>
                <div class="appeals-queue-item-foot">
                    <span class="text-muted">${submitted}</span>
                    <span class="appeals-pending-badge">Pending</span>
                </div>
            </article>
        `;
        }).join('');

        renderAppealPendingDetails(window._appealsPendingRenderRows[Number(window._appealsPendingSelectedIndex)] || slice[0]);
        syncAppealsPendingSelectedRow();
    }

    if (controls) {
        controls.innerHTML = `
            <button class="btn" ${page <= 1 ? 'disabled' : ''} data-appeals-page="${page - 1}" title="Previous">◀</button>
            <span>${page} / ${pages}</span>
            <button class="btn" ${page >= pages ? 'disabled' : ''} data-appeals-page="${page + 1}" title="Next">▶</button>
        `;
    }
}

function setupAppealsQueueInteractions() {
    const list = document.getElementById('appealsQueueList');
    const controls = document.getElementById('appealsControls');
    if (list && !list.dataset.appealsBound) {
        list.dataset.appealsBound = 'true';
        list.addEventListener('click', (event) => {
            const row = event.target.closest('.appeals-queue-item[data-appeal-index]');
            if (!row) return;
            const index = Number(row.getAttribute('data-appeal-index'));
            if (Number.isFinite(index)) {
                window.openAppealPendingDetails(index);
            }
        });
        list.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            const row = event.target.closest('.appeals-queue-item[data-appeal-index]');
            if (!row) return;
            event.preventDefault();
            const index = Number(row.getAttribute('data-appeal-index'));
            if (Number.isFinite(index)) {
                window.openAppealPendingDetails(index);
            }
        });
    }

    if (controls && !controls.dataset.appealsBound) {
        controls.dataset.appealsBound = 'true';
        controls.addEventListener('click', (event) => {
            const button = event.target.closest('button[data-appeals-page]');
            if (!button || button.disabled) return;
            const page = Number(button.getAttribute('data-appeals-page'));
            if (Number.isFinite(page)) {
                renderAppealsPage(page);
            }
        });
    }
}

async function loadAppealHistory() {
    const list = document.getElementById('appealsHistoryList');
    if (!list) return;
    list.innerHTML = `<div class="appeal-history-empty">Loading appeal history...</div>`;

    const loadNonce = ++window._appealHistoryLoadNonce;

    try {
        const api = await getAdminApiClient();
        if (!api) throw new Error('Admin API is not ready');

        const { response, data } = await api.getJson('/api/appeals/decided', { cache: 'no-store' });
        if (!response?.ok) throw new Error("Failed to fetch");

        if (loadNonce !== window._appealHistoryLoadNonce) return;

        window._appealsHistory = Array.isArray(data) ? data : [];
        renderAppealHistoryPage(window.currentAppealsHistoryPage);
    } catch (err) {
        console.error("Error loading appeal history:", err);
        adminShowNotification('Could not load appeal history', 'error');
        list.innerHTML = `<div class="appeal-history-empty text-danger">Could not load appeal history. Try refreshing.</div>`;
    }
}

window.resetAppealHistoryFilters = function () {
    const setValue = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.value = value;
    };
    setValue('appealHistorySearchInput', '');
    setValue('appealHistoryModeratorFilter', '');
    setValue('appealHistoryStatusFilter', 'all');
    setValue('appealHistoryDateFilter', 'all');
    setValue('appealHistorySort', 'newest');
    setValue('appealHistoryPageSize', '25');
    renderAppealHistoryPage(1);
};

function formatAppealRelativeTime(value) {
    const date = new Date(value || 0);
    if (Number.isNaN(date.getTime())) return '-';

    const diffMs = Date.now() - date.getTime();
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;

    if (diffMs < hour) return `${Math.max(1, Math.floor(diffMs / minute))}m ago`;
    if (diffMs < day) return `${Math.floor(diffMs / hour)}h ago`;
    return `${Math.floor(diffMs / day)}d ago`;
}

function resolveAppealHistoryModerator(record) {
    const raw = record?.moderator_tag
        || record?.moderator
        || record?.moderator_name
        || record?.decided_by_name
        || record?.decidedByName
        || record?.moderator_id
        || record?.decided_by_id
        || '';
    const cleaned = String(raw).trim();
    return cleaned || 'Owner';
}

function getFilteredAppealHistory() {
    const all = window._appealsHistory || [];
    const q = (document.getElementById('appealHistorySearchInput')?.value || '').trim().toLowerCase();
    const statusFilter = document.getElementById('appealHistoryStatusFilter')?.value || 'all';
    const moderatorFilter = (document.getElementById('appealHistoryModeratorFilter')?.value || '').trim().toLowerCase();
    const dateFilterDays = Number(document.getElementById('appealHistoryDateFilter')?.value || 0);
    const minDate = dateFilterDays > 0 ? (Date.now() - dateFilterDays * 24 * 60 * 60 * 1000) : null;

    return all.filter((a) => {
        const username = String(a.user_tag || a.user || '').toLowerCase();
        const caseId = String(a.ban_case_id || '').toLowerCase();
        const moderator = resolveAppealHistoryModerator(a).toLowerCase();
        const userId = String(a.user_id || '').toLowerCase();
        const status = String(a.status || '').toLowerCase();
        const createdAtMs = new Date(a.created_at || a.submitted_at || a.updated_at || 0).getTime();

        if (statusFilter !== 'all' && status !== statusFilter) return false;
        if (moderatorFilter && !moderator.includes(moderatorFilter)) return false;
        if (minDate && (!Number.isFinite(createdAtMs) || createdAtMs < minDate)) return false;

        if (!q) return true;
        return username.includes(q) || caseId.includes(q) || moderator.includes(q) || userId.includes(q);
    });
}

function renderAppealHistoryMetrics(rows) {
    const total = rows.length;
    const accepted = rows.filter((item) => String(item.status || '').toLowerCase() === 'accepted').length;
    const denied = rows.filter((item) => String(item.status || '').toLowerCase() === 'denied').length;
    const recent7dCutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
    const recent7d = rows.filter((item) => {
        const ts = new Date(item.created_at || item.submitted_at || item.updated_at || 0).getTime();
        return Number.isFinite(ts) && ts >= recent7dCutoff;
    }).length;
    const moderatorSet = new Set(
        rows
            .map((item) => String(item.moderator_tag || item.moderator || '').trim().toLowerCase())
            .filter(Boolean)
    );

    const setVal = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.textContent = Number(value || 0).toLocaleString();
    };

    setVal('appealHistoryMetricTotal', total);
    setVal('appealHistoryMetricAccepted', accepted);
    setVal('appealHistoryMetricDenied', denied);
    setVal('appealHistoryMetricRecent7d', recent7d);

    const summaryEl = document.getElementById('appealHistorySummaryText');
    if (summaryEl) {
        const acceptanceRate = total > 0 ? `${Math.round((accepted / total) * 100)}%` : '0%';
        summaryEl.textContent = `${total.toLocaleString()} records • ${acceptanceRate} accepted • ${moderatorSet.size.toLocaleString()} moderators`;
    }
}

const APPEAL_HISTORY_DECISION_TEXT = {
    accepted_standard: 'Appeal accepted. You may rejoin the server.',
    accepted_rejoin: 'Appeal accepted and restriction lifted. Rejoin is allowed.',
    accepted_warning: 'Appeal accepted with a final warning to follow server rules.',
    accepted_context: 'Appeal accepted after contextual review and case reversal.',
    accepted_custom: 'Appeal accepted with a custom moderator response (not stored).',
    denied_standard: 'Appeal denied. The original moderation action stands.',
    denied_policy: 'Appeal denied due to policy violation findings.',
    denied_insufficient: 'Appeal denied due to insufficient new evidence.',
    denied_wait: 'Appeal denied. Another appeal may be submitted after the cooldown window.',
    denied_custom: 'Appeal denied with a custom moderator response (not stored).'
};

function resolveAppealHistoryDecisionText(record) {
    const normalizedStatus = String(record?.status || 'unknown').toLowerCase();
    const rawCode = String(record?.decision_code || record?.owner_response || '').trim();
    const decisionCode = rawCode.toLowerCase();

    if (decisionCode && APPEAL_HISTORY_DECISION_TEXT[decisionCode]) {
        return APPEAL_HISTORY_DECISION_TEXT[decisionCode];
    }

    if (rawCode && /\s/.test(rawCode)) {
        return rawCode;
    }

    if (normalizedStatus === 'accepted') return APPEAL_HISTORY_DECISION_TEXT.accepted_standard;
    if (normalizedStatus === 'denied') return APPEAL_HISTORY_DECISION_TEXT.denied_standard;
    return 'No decision note was saved.';
}

function renderAppealHistoryDetails(item) {
    const record = item || {};
    const status = String(record.status || 'unknown').toLowerCase();
    const normalizedReason = String(record.reason || 'No reason provided.').replace(/\r\n/g, '\n').trim();
    const decisionResponse = resolveAppealHistoryDecisionText(record);
    const setText = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.textContent = value || '-';
    };

    setText('appealHistoryDetailUser', `${record.user_tag || record.user || 'Unknown'} (${record.user_id || 'N/A'})`);
    setText('appealHistoryDetailCase', record.ban_case_id || 'N/A');
    setText('appealHistoryDetailSubmitted', record.created_at ? new Date(record.created_at).toLocaleString() : '-');
    setText('appealHistoryDetailModerator', resolveAppealHistoryModerator(record));
    setText('appealHistoryDetailReason', normalizedReason || 'No reason provided.');
    setText('appealHistoryDetailOutcome', decisionResponse || 'No decision note was saved.');

    const statusEl = document.getElementById('appealHistoryDetailStatus');
    if (statusEl) {
        statusEl.className = `appeal-history-status-badge ${status}`;
        statusEl.textContent = status ? `${status.charAt(0).toUpperCase()}${status.slice(1)}` : 'Unknown';
    }

    const panel = document.getElementById('appealHistoryDetailPanel');
    if (panel) {
        panel.classList.remove('appeal-history-detail-panel--flash');
        void panel.offsetWidth;
        panel.classList.add('appeal-history-detail-panel--flash');
    }
}

window.openAppealHistoryDetails = function (index) {
    const selectedIndex = Number(index);
    const item = window._appealHistoryRenderRows?.[selectedIndex];
    if (!item) return;
    window._appealHistorySelectedIndex = selectedIndex;
    renderAppealHistoryDetails(item);
    syncAppealHistorySelectedRow();
};

function syncAppealHistorySelectedRow() {
    const selected = Number(window._appealHistorySelectedIndex);
    document.querySelectorAll('#appealsHistoryList .appeal-card').forEach((row) => {
        const rowIndex = Number(row.getAttribute('data-history-index'));
        if (rowIndex === selected) {
            row.classList.add('active');
            row.style.borderLeftColor = '#6366f1';
        } else {
            row.classList.remove('active');
            row.style.borderLeftColor = 'transparent';
        }
    });
}

function renderAppealHistoryPage(page = 1) {
    const list = document.getElementById('appealsHistoryList');
    const controls = document.getElementById('appealsHistoryControls');
    const summaryText = document.getElementById('appealHistorySummaryText');
    if (!list) return;

    window.currentAppealsHistoryPage = page;

    const pageSize = parseInt(document.getElementById('appealHistoryPageSize')?.value) || 10;
    const sortMode = document.getElementById('appealHistorySort')?.value || 'newest';
    const searchValue = (document.getElementById('appealHistorySearchInput')?.value || '').trim();
    const moderatorValue = (document.getElementById('appealHistoryModeratorFilter')?.value || '').trim();
    const statusValue = document.getElementById('appealHistoryStatusFilter')?.value || 'all';
    const dateValue = document.getElementById('appealHistoryDateFilter')?.value || 'all';
    const hasActiveFilters = Boolean(searchValue || moderatorValue || statusValue !== 'all' || dateValue !== 'all');
    let rows = getFilteredAppealHistory();

    if (summaryText) {
        summaryText.innerText = `${rows.length} records`;
    }

    if (sortMode === 'oldest') {
        rows.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
    } else if (sortMode === 'status') {
        rows.sort((a, b) => String(a.status || '').localeCompare(String(b.status || '')));
    } else if (sortMode === 'moderator') {
        rows.sort((a, b) => resolveAppealHistoryModerator(a).localeCompare(resolveAppealHistoryModerator(b)));
    } else {
        rows.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    }

    window._appealHistoryRenderRows = rows;

    const pages = Math.max(1, Math.ceil(rows.length / pageSize));
    if (page > pages) page = pages;

    const start = (page - 1) * pageSize;
    const slice = rows.slice(start, start + pageSize);

    if (!slice.length) {
        list.innerHTML = `<div class="appeals-queue-empty"><div class="icon">📭</div><div class="message">${hasActiveFilters ? 'No matching records found.' : 'No appeal history yet.'}</div></div>`;
        window._appealHistorySelectedIndex = -1;
        renderAppealHistoryDetails(null);
    } else {
        const hasExistingSelection = Number.isFinite(Number(window._appealHistorySelectedIndex))
            && Number(window._appealHistorySelectedIndex) >= start
            && Number(window._appealHistorySelectedIndex) < (start + slice.length);

        if (!hasExistingSelection) {
            window._appealHistorySelectedIndex = start;
        }

        list.innerHTML = slice.map((a, idx) => {
            const normalizedStatus = String(a.status || 'unknown').toLowerCase();
            const badgeStyle = normalizedStatus === 'accepted'
                ? 'background:rgba(34,197,94,0.1); color:#4ade80; border:1px solid rgba(34,197,94,0.2);'
                : normalizedStatus === 'denied'
                    ? 'background:rgba(239,68,68,0.1); color:#f87171; border:1px solid rgba(239,68,68,0.2);'
                    : 'background:rgba(255,255,255,0.1); color:#9ca3af;';

            const statusBadge = `<span style="padding:0.2rem 0.6rem; border-radius:6px; font-size:0.7rem; font-weight:700; text-transform:uppercase; ${badgeStyle}">${safeHtml(normalizedStatus)}</span>`;

            const created = a.created_at ? new Date(a.created_at).toLocaleString() : '-';
            const createdRelative = formatAppealRelativeTime(a.created_at || a.submitted_at || a.updated_at);
            const globalIndex = start + idx;
            const displayName = String(a.user_tag || a.user || 'Unknown');
            const moderatorLabel = resolveAppealHistoryModerator(a);
            const reason = String(a.reason || 'No reason provided').replace(/\r\n/g, '\n').trim();
            const reasonPreview = reason.length > 120 ? `${reason.slice(0, 120)}...` : reason;
            const isSelected = globalIndex === Number(window._appealHistorySelectedIndex);

            return `
                <div class="appeal-card ${isSelected ? 'active' : ''}" 
                     data-history-index="${globalIndex}"
                     style="margin-bottom:0.75rem; background:var(--bg-card); border:1px solid var(--border-color); border-radius:12px; padding:1rem; cursor:pointer; border-left:3px solid ${isSelected ? '#6366f1' : 'transparent'}; transition:all 0.2s;"
                     onclick="openAppealHistoryDetails(${globalIndex})">
                    
                    <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:0.75rem;">
                        <div style="display:flex; gap:0.75rem; align-items:center;">
                            <div style="width:36px; height:36px; background:rgba(255,255,255,0.05); border-radius:10px; display:flex; align-items:center; justify-content:center; font-size:1.1rem;">
                                👤
                            </div>
                            <div>
                                <div style="font-weight:600; font-size:0.95rem; color:var(--text-primary);">${safeHtml(displayName)}</div>
                                <div style="font-size:0.75rem; color:var(--text-muted);">Case ${safeHtml(a.ban_case_id || '#?')} • ${createdRelative}</div>
                            </div>
                        </div>
                        ${statusBadge}
                    </div>

                    <div style="font-size:0.9rem; color:var(--text-secondary); line-height:1.5; margin-bottom:0.5rem; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;">
                        ${safeHtml(reasonPreview)}
                    </div>
                    
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-top:0.75rem; padding-top:0.75rem; border-top:1px solid var(--border-color); font-size:0.75rem; color:var(--text-muted);">
                         <span>Reviewed by <strong>${safeHtml(moderatorLabel)}</strong></span>
                         <span>${safeHtml(created.split(',')[0])}</span>
                    </div>
                </div>
            `;
        }).join('');

        renderAppealHistoryDetails(window._appealHistoryRenderRows[Number(window._appealHistorySelectedIndex)] || slice[0]);
    }

    if (controls) {
        controls.innerHTML = `
            <button class="btn" ${page <= 1 ? 'disabled' : ''} onclick="renderAppealHistoryPage(${page - 1})">◀</button>
            <span>${page} / ${pages}</span>
            <button class="btn" ${page >= pages ? 'disabled' : ''} onclick="renderAppealHistoryPage(${page + 1})">▶</button>
        `;
    }
}


function adminShowNotification(message, type = 'info') {
    if (typeof window.showNotification === 'function') {
        return window.showNotification(message, type);
    }

    console.log(`[${type}] ${message}`);
}

const APPEAL_DECISION_TEMPLATES = {
    accept: [
        {
            code: 'accepted_rejoin',
            label: 'Accepted • Rejoin Allowed',
            message: 'After review, your appeal has been accepted and your restriction has been lifted.'
        },
        {
            code: 'accepted_warning',
            label: 'Accepted • Final Warning',
            message: 'Your appeal was accepted. Please follow server rules moving forward to avoid future action.'
        },
        {
            code: 'accepted_context',
            label: 'Accepted • Context Reversal',
            message: 'Appeal accepted. The moderation team has reversed this case after reviewing the context.'
        }
    ],
    deny: [
        {
            code: 'denied_policy',
            label: 'Denied • Policy Violation',
            message: 'After review, your appeal has been denied. The original moderation action stands.'
        },
        {
            code: 'denied_insufficient',
            label: 'Denied • Insufficient Evidence',
            message: 'Your appeal was denied due to insufficient new context to reverse the case.'
        },
        {
            code: 'denied_wait',
            label: 'Denied • Appeal Cooldown',
            message: 'Appeal denied. You may submit another appeal later if new evidence is available.'
        }
    ]
};

const APPEAL_DECISION_DEFAULT_CODE = {
    accept: 'accepted_standard',
    deny: 'denied_standard'
};

function openAppealDecisionModal(action, username) {
    const mode = String(action || 'accept').toLowerCase() === 'deny' ? 'deny' : 'accept';
    const title = mode === 'deny' ? 'Deny Appeal' : 'Accept Appeal';
    const confirmLabel = mode === 'deny' ? 'Confirm Deny' : 'Confirm Accept';
    const defaultReply = mode === 'deny' ? 'Denied' : 'Accepted';
    const templates = APPEAL_DECISION_TEMPLATES[mode] || [];
    const templateStorageKey = `appealDecisionTemplate:${mode}`;
    const customMessageStorageKey = `appealDecisionCustomMessage:${mode}`;
    let savedTemplate = '';
    let savedCustomMessage = '';

    try {
        savedTemplate = String(localStorage.getItem(templateStorageKey) || '');
        savedCustomMessage = String(localStorage.getItem(customMessageStorageKey) || '');
    } catch (_) {
        savedTemplate = '';
        savedCustomMessage = '';
    }

    if (typeof document === 'undefined' || !document.body) {
        const fallback = prompt(`Optional message for ${username}:`);
        if (fallback === null) return Promise.resolve({ confirmed: false, message: '' });
        return Promise.resolve({
            confirmed: true,
            message: fallback.trim() || defaultReply,
            decisionCode: `${mode}_custom`
        });
    }

    return new Promise((resolve) => {
        const modal = document.createElement('div');
        modal.className = 'appeal-decision-modal';
        const safeUser = safeHtml(username || 'Unknown');
        modal.innerHTML = `
            <div class="appeal-decision-modal-backdrop"></div>
            <div class="appeal-decision-modal-card" role="dialog" aria-modal="true" aria-label="${title}">
                <div class="appeal-decision-modal-header">
                    <h3>${title}</h3>
                    <button type="button" class="appeal-decision-modal-close" aria-label="Close">&times;</button>
                </div>
                <p class="appeal-decision-modal-subtitle">User: <strong>${safeUser}</strong></p>
                <div class="appeal-decision-modal-field">
                    <label class="form-label" for="appealDecisionTemplateSelect">Template</label>
                    <select id="appealDecisionTemplateSelect" class="form-input"></select>
                </div>
                <div class="appeal-decision-modal-field">
                    <label class="form-label" for="appealDecisionMessageInput">Message</label>
                    <textarea id="appealDecisionMessageInput" class="form-input appeal-decision-message" placeholder="Write a response..."></textarea>
                </div>
                <div class="appeal-decision-modal-actions">
                    <button type="button" class="btn btn-secondary" data-action="cancel">Cancel</button>
                    <button type="button" class="btn ${mode === 'deny' ? 'btn-danger' : 'btn-success'}" data-action="confirm">${confirmLabel}</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        const templateSelect = modal.querySelector('#appealDecisionTemplateSelect');
        const messageInput = modal.querySelector('#appealDecisionMessageInput');
        const confirmButton = modal.querySelector('[data-action="confirm"]');
        const cancelButton = modal.querySelector('[data-action="cancel"]');
        const closeButton = modal.querySelector('.appeal-decision-modal-close');
        const backdrop = modal.querySelector('.appeal-decision-modal-backdrop');

        if (templateSelect) {
            const defaultOption = document.createElement('option');
            defaultOption.value = '';
            defaultOption.textContent = 'Custom message';
            templateSelect.appendChild(defaultOption);
            templates.forEach((template) => {
                const option = document.createElement('option');
                option.value = template.code;
                option.textContent = template.label;
                templateSelect.appendChild(option);
            });
        }

        if (messageInput) {
            if (savedTemplate) messageInput.value = savedTemplate;
            else if (savedCustomMessage) messageInput.value = savedCustomMessage;
            else messageInput.value = templates[0]?.message || '';
        }

        if (templateSelect && messageInput) {
            const templateMap = new Map(templates.map((template) => [template.code, template.message]));
            const availableValues = new Set(['', ...templateMap.keys()]);
            templateSelect.value = availableValues.has(savedTemplate) ? savedTemplate : (templates[0]?.code || '');
            if (templateSelect.value) messageInput.value = templateMap.get(templateSelect.value) || '';
            else messageInput.value = savedCustomMessage || messageInput.value || '';
            templateSelect.addEventListener('change', () => {
                if (templateSelect.value) messageInput.value = templateMap.get(templateSelect.value) || '';
                else messageInput.value = savedCustomMessage || '';
            });
        }

        const cleanup = () => {
            document.removeEventListener('keydown', onKeydown);
            modal.remove();
        };

        const close = (confirmed) => {
            const message = (messageInput?.value || '').trim();
            const selectedTemplate = String(templateSelect?.value || '');
            const decisionCode = selectedTemplate || `${mode}_custom`;
            try {
                localStorage.setItem(templateStorageKey, selectedTemplate);
                if (!selectedTemplate) localStorage.setItem(customMessageStorageKey, message);
            } catch (_) {
            }
            cleanup();
            resolve({
                confirmed,
                message: message || defaultReply,
                decisionCode: decisionCode || APPEAL_DECISION_DEFAULT_CODE[mode]
            });
        };

        const cancel = () => {
            cleanup();
            resolve({ confirmed: false, message: '' });
        };

        confirmButton?.addEventListener('click', () => close(true));
        cancelButton?.addEventListener('click', cancel);
        closeButton?.addEventListener('click', cancel);
        backdrop?.addEventListener('click', cancel);

        const onKeydown = (event) => {
            if (event.key === 'Escape') {
                cancel();
            }
        };
        document.addEventListener('keydown', onKeydown);
    });
}

async function acceptAppeal(appealId, username) {
    const decision = await openAppealDecisionModal('accept', username);
    if (!decision?.confirmed) return;
    try {
        const res = await fetchWithCsrf(`/api/appeals/${appealId}/accept`, {
            method: 'POST',
            body: JSON.stringify({
                response: decision.message || 'Accepted',
                decisionCode: decision.decisionCode || APPEAL_DECISION_DEFAULT_CODE.accept
            })
        });
        if (res.ok) {
            adminShowNotification('Appeal accepted successfully', 'success');
            loadAppeals();
            loadAppealHistory();
            if (window.socket) window.socket.emit('admin:appealAccepted', { appealId, username });
        } else {
            const errorData = await res.json();
            adminShowNotification(errorData.message || 'Failed to accept appeal', 'error');
        }
    } catch (err) {
        console.error(err);
        adminShowNotification('An error occurred while accepting appeal', 'error');
    }
}

async function denyAppeal(appealId, username) {
    const decision = await openAppealDecisionModal('deny', username);
    if (!decision?.confirmed) return;
    try {
        const res = await fetchWithCsrf(`/api/appeals/${appealId}/deny`, {
            method: 'POST',
            body: JSON.stringify({
                response: decision.message || 'Denied',
                decisionCode: decision.decisionCode || APPEAL_DECISION_DEFAULT_CODE.deny
            })
        });
        if (res.ok) {
            adminShowNotification('Appeal denied successfully', 'success');
            loadAppeals();
            loadAppealHistory();
            if (window.socket) window.socket.emit('admin:appealDenied', { appealId, username });
        } else {
            const errorData = await res.json();
            adminShowNotification(errorData.message || 'Failed to deny appeal', 'error');
        }
    } catch (err) {
        console.error(err);
        adminShowNotification('An error occurred while denying appeal', 'error');
    }
}

function createSocketConnection(options = {}) {
    if (typeof io === 'undefined') return null;
    if (window.socket) return window.socket;

    const socket = io({
        withCredentials: true,
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: 20,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 10000,
        randomizationFactor: 0.5,
        timeout: 10000,
        ...options
    });

    window.socket = socket;
    return socket;
}

async function runAdminPanel() {
    if (!window.currentAdminRole) {
        console.warn("Role missing");
        return;
    }

    if (typeof io !== 'undefined') {
        const socket = createSocketConnection();
        if (!socket) return;

        socket.on('connect', () => {
            console.log('Connected to WebSocket server');
            adminShowNotification('Live updates connected', 'success');
        });

        socket.on('disconnect', () => {
            console.warn('Disconnected from WebSocket server');
            adminShowNotification('Live updates disconnected', 'warning');
        });

        socket.on('connect_error', () => {
            adminShowNotification('Live updates failed. Retrying...', 'warning');
        });

        socket.on('admin:appealUpdated', (data) => {
            adminShowNotification(`Appeal for ${data.username} was ${data.status}`, 'info');
            loadAppeals();
            loadAppealHistory();
        });

        socket.on('admin:newAppeal', (data) => {
            adminShowNotification(`New appeal submitted by ${data.username}`, 'info');
            loadAppeals();
        });
    }

    if (!window._adminLookupInitialized) {
        initAdvancedLookup();
        window._adminLookupInitialized = true;
    }

    loadAdminXpLeaderboard();
}

window._lookupState = window._lookupState || {
    currentUser: null,
    recentUsers: [],
    suggestionsTimer: null,
    activeTab: 'overview'
};

function getLookupApi() {
    return window.AdminPanel?.api || window.api;
}

function showLookupLoading(visible) {
    const loadingEl = document.getElementById('lookupLoading');
    if (loadingEl) {
        loadingEl.style.display = visible ? '' : 'none';
    }
}

function toggleFilters() {
    const panel = document.getElementById('lookupFiltersPanel');
    if (!panel) return;
    panel.classList.toggle('show');
}

async function initAdvancedLookup() {
    const input = document.getElementById('advancedLookupInput');
    const suggestions = document.getElementById('lookupSuggestions');
    const resultsPanel = document.getElementById('lookupResultsPanel');

    if (!input || !suggestions || !resultsPanel) return;

    document.addEventListener('click', (event) => {
        if (!suggestions.contains(event.target) && event.target !== input) {
            suggestions.classList.remove('show');
        }
    });

    await loadRecentLookups();
}

function getAdvancedLookupFilters() {
    const status = String(document.getElementById('filterStatus')?.value || '').trim();
    const minLevelRaw = String(document.getElementById('filterMinLevel')?.value || '').trim();
    const maxLevelRaw = String(document.getElementById('filterMaxLevel')?.value || '').trim();
    const minWarningsRaw = String(document.getElementById('filterMinWarnings')?.value || '').trim();

    const filters = {};
    if (status) filters.status = status;

    const minLevel = minLevelRaw === '' ? NaN : Number(minLevelRaw);
    const maxLevel = maxLevelRaw === '' ? NaN : Number(maxLevelRaw);
    const minWarnings = minWarningsRaw === '' ? NaN : Number(minWarningsRaw);

    if (Number.isFinite(minLevel) && minLevel >= 0) filters.minLevel = minLevel;
    if (Number.isFinite(maxLevel) && maxLevel >= 0) filters.maxLevel = maxLevel;
    if (Number.isFinite(minWarnings) && minWarnings >= 0) filters.minWarnings = minWarnings;

    return filters;
}

function getRiskBadgeClass(level, score) {
    const normalized = String(level || '').toLowerCase();
    if (Number(score) >= 90) return 'lookup-risk-critical';
    if (normalized === 'high') return 'lookup-risk-high';
    if (normalized === 'medium') return 'lookup-risk-moderate';
    if (normalized === 'low') return 'lookup-risk-low';
    return 'lookup-risk-stable';
}

function renderLookupSearchResults(results = []) {
    const shell = document.getElementById('lookupSearchResults');
    const list = document.getElementById('lookupResultsList');
    if (!shell || !list) return;

    if (!results.length) {
        shell.style.display = 'none';
        list.innerHTML = '';
        return;
    }

    shell.style.display = '';
    list.innerHTML = results.slice(0, 15).map((item) => {
        const flags = [];
        if (item.banned) flags.push('Banned');
        if (item.isTimedOut) flags.push('Timed Out');
        if (!item.inServer) flags.push('Not In Server');
        const userId = safeJsString(String(item.userId || ''));

        return `
            <button class="lookup-recent-badge" onclick="performLookup('${userId}')">
                ${safeHtml(String(item.username || 'Unknown'))}
                <span class="text-muted">• Lv${Number(item.level || 0)} • W${Number(item.warnCount || 0)}${flags.length ? ` • ${safeHtml(flags.join(', '))}` : ''}</span>
            </button>
        `;
    }).join('');
}

function renderLookupSuggestions(suggestions = []) {
    const box = document.getElementById('lookupSuggestions');
    if (!box) return;

    if (!suggestions.length) {
        box.classList.remove('show');
        box.innerHTML = '';
        return;
    }

    box.innerHTML = suggestions.map((item) => {
        const userId = safeJsString(String(item.userId || ''));
        const username = safeHtml(String(item.username || 'Unknown'));
        const level = Number(item.level || 0);
        return `
            <div class="lookup-suggestion-item" onclick="performLookup('${userId}')">
                <div class="lookup-suggestion-username">${username}</div>
                <div class="lookup-suggestion-details">ID: ${safeHtml(String(item.userId || ''))} • Level ${level}</div>
            </div>
        `;
    }).join('');
    box.classList.add('show');
}

async function handleLookupInput() {
    const inputEl = document.getElementById('advancedLookupInput');
    const api = getLookupApi();
    if (!inputEl || !api) return;

    const value = String(inputEl.value || '').trim();

    if (window._lookupState.suggestionsTimer) {
        clearTimeout(window._lookupState.suggestionsTimer);
        window._lookupState.suggestionsTimer = null;
    }

    if (value.length < 2) {
        renderLookupSuggestions([]);
        return;
    }

    window._lookupState.suggestionsTimer = setTimeout(async () => {
        try {
            const { response, data } = await api.getJson(`/api/admin/search-suggestions?q=${encodeURIComponent(value)}`);
            if (!response?.ok) {
                renderLookupSuggestions([]);
                return;
            }
            renderLookupSuggestions(Array.isArray(data?.suggestions) ? data.suggestions : []);
        } catch (error) {
            console.error('Lookup suggestions failed:', error);
            renderLookupSuggestions([]);
        }
    }, 220);
}

function renderLookupProfile(user) {
    const container = document.getElementById('lookupProfileContainer');
    const panel = document.getElementById('lookupResultsPanel');
    if (!container || !panel) return;

    panel.classList.add('show');

    if (!user) {
        container.innerHTML = '<div class="lookup-recent-section">No member selected yet.</div>';
        return;
    }

    const riskLevel = String(user.riskLevel || 'MINIMAL').toUpperCase();
    const riskScore = Number(user.riskScore || 0);
    const badgeClass = getRiskBadgeClass(riskLevel, riskScore);

    const avatarUrl = String(user.avatar || '').trim();
    const initial = safeHtml(String(user.username || '?').charAt(0).toUpperCase());

    const createdDate = user.createdAt ? new Date(user.createdAt).toLocaleString() : '-';
    const joinedDate = user.member?.joinedAt ? new Date(user.member.joinedAt).toLocaleString() : 'Not in server';
    const timeoutUntil = user.member?.communicationDisabledUntil
        ? new Date(user.member.communicationDisabledUntil).toLocaleString()
        : 'None';

    const roles = Array.isArray(user.member?.roles) ? user.member.roles : [];
    const warnings = Array.isArray(user.db?.warningsList) ? user.db.warningsList : [];
    const notes = Array.isArray(user.db?.notes) ? user.db.notes : [];
    const timeouts = Array.isArray(user.db?.timeouts) ? user.db.timeouts : [];
    const bans = Array.isArray(user.db?.banHistory) ? user.db.banHistory : [];

    const rolesHtml = roles.length
        ? roles.map((role) => `<span class="lookup-mini-badge">@${safeHtml(String(role.name || 'Unknown'))}</span>`).join('')
        : '<span class="text-muted">No roles found</span>';

    const warningsHtml = warnings.length
        ? warnings.slice(0, 12).map((row) => `
            <div class="lookup-info-item lookup-info-item-full">
                <span class="lookup-info-label">${safeHtml(String(row.caseId || 'No Case ID'))} • ${row.timestamp ? new Date(row.timestamp).toLocaleString() : 'Unknown date'}</span>
                <span class="lookup-info-value">${safeHtml(String(row.reason || 'No reason provided'))}</span>
                <span class="lookup-info-label">Moderator: ${safeHtml(String(row.moderatorName || 'Unknown'))}</span>
            </div>
        `).join('')
        : '<div class="lookup-info-item lookup-info-item-full"><span class="lookup-info-value">No warning history.</span></div>';

    const timeoutHtml = timeouts.length
        ? timeouts.slice(0, 10).map((row) => `
            <div class="lookup-info-item lookup-info-item-full">
                <span class="lookup-info-label">${safeHtml(String(row.caseId || 'No Case ID'))} • ${row.timestamp ? new Date(row.timestamp).toLocaleString() : 'Unknown date'}</span>
                <span class="lookup-info-value">${safeHtml(String(row.reason || 'No reason provided'))}</span>
                <span class="lookup-info-label">Moderator: ${safeHtml(String(row.moderatorName || 'Unknown'))} • ${row.active ? 'Active' : 'Inactive'}</span>
            </div>
        `).join('')
        : '<div class="lookup-info-item lookup-info-item-full"><span class="lookup-info-value">No timeout history.</span></div>';

    const bansHtml = bans.length
        ? bans.slice(0, 10).map((row) => `
            <div class="lookup-info-item lookup-info-item-full">
                <span class="lookup-info-label">${safeHtml(String(row.caseId || 'No Case ID'))} • ${row.bannedAt ? new Date(row.bannedAt).toLocaleString() : 'Unknown date'}</span>
                <span class="lookup-info-value">${safeHtml(String(row.reason || 'No reason provided'))}</span>
                <span class="lookup-info-label">Moderator: ${safeHtml(String(row.moderatorName || 'Unknown'))} • ${row.active ? 'Active Ban' : 'Historical Ban'}</span>
            </div>
        `).join('')
        : '<div class="lookup-info-item lookup-info-item-full"><span class="lookup-info-value">No ban history.</span></div>';

    const notesHtml = notes.length
        ? notes.slice(0, 15).map((row) => `
            <div class="lookup-info-item lookup-info-item-full">
                <span class="lookup-info-label">${row.createdAt ? new Date(row.createdAt).toLocaleString() : 'Unknown date'} • ${safeHtml(String(row.createdBy || 'Unknown'))}</span>
                <span class="lookup-info-value">${safeHtml(String(row.note || ''))}</span>
            </div>
        `).join('')
        : '<div class="lookup-info-item lookup-info-item-full"><span class="lookup-info-value">No moderator notes yet.</span></div>';

    container.innerHTML = `
        <div class="lookup-advanced-profile">
            <div class="lookup-profile-header">
                <div class="lookup-risk-badge ${badgeClass}">
                    <span>⚠</span>
                    <span>${safeHtml(riskLevel)} RISK • ${riskScore}</span>
                </div>
                <div class="lookup-identity-section">
                    <div class="lookup-avatar-wrapper">
                        ${avatarUrl
            ? `<img class="lookup-avatar-image" src="${safeHtml(avatarUrl)}" alt="${safeHtml(String(user.username || 'User'))}">`
            : `<div class="lookup-avatar-initial">${initial}</div>`}
                    </div>
                    <div class="lookup-identity-info">
                        <h2 class="lookup-username">${safeHtml(String(user.globalName || user.username || 'Unknown User'))}</h2>
                        <div class="lookup-metadata-badges">
                            <span class="lookup-mini-badge">🆔 ${safeHtml(String(user.id || 'N/A'))}</span>
                            <span class="lookup-mini-badge">👤 @${safeHtml(String(user.username || 'unknown'))}</span>
                            ${user.bot ? '<span class="lookup-mini-badge lookup-badge-bot">🤖 Bot</span>' : ''}
                            ${user.db?.ban?.banned ? '<span class="lookup-mini-badge lookup-badge-status">🚫 Banned</span>' : ''}
                        </div>
                    </div>
                </div>
            </div>

            <div class="lookup-stats-grid">
                <div class="lookup-stat-card">
                    <div class="lookup-stat-icon">⭐</div>
                    <div class="lookup-stat-content">
                        <span class="lookup-stat-label">Level</span>
                        <span class="lookup-stat-value">${Number(user.db?.level || 0).toLocaleString()}</span>
                    </div>
                </div>
                <div class="lookup-stat-card">
                    <div class="lookup-stat-icon">💬</div>
                    <div class="lookup-stat-content">
                        <span class="lookup-stat-label">Messages</span>
                        <span class="lookup-stat-value">${Number(user.db?.messages || 0).toLocaleString()}</span>
                    </div>
                </div>
                <div class="lookup-stat-card">
                    <div class="lookup-stat-icon">⚠️</div>
                    <div class="lookup-stat-content">
                        <span class="lookup-stat-label">Warnings</span>
                        <span class="lookup-stat-value">${Number(user.db?.warnings || 0).toLocaleString()}</span>
                    </div>
                </div>
                <div class="lookup-stat-card">
                    <div class="lookup-stat-icon">📅</div>
                    <div class="lookup-stat-content">
                        <span class="lookup-stat-label">Account Age</span>
                        <span class="lookup-stat-value">${Number(user.accountAge || 0).toLocaleString()}d</span>
                    </div>
                </div>
            </div>

            <div class="lookup-tabs-wrapper">
                <div class="lookup-tabs">
                    <button class="lookup-tab active" data-lookup-tab="overview" onclick="switchLookupTab('overview')"><span>🧾</span>Overview</button>
                    <button class="lookup-tab" data-lookup-tab="moderation" onclick="switchLookupTab('moderation')"><span>🛡️</span>Moderation</button>
                    <button class="lookup-tab" data-lookup-tab="notes" onclick="switchLookupTab('notes')"><span>📝</span>Notes</button>
                </div>
            </div>

            <div class="lookup-tab-content-wrapper">
                <div class="lookup-tab-content active" data-lookup-content="overview">
                    <div class="lookup-info-sections">
                        <section class="lookup-info-section">
                            <div class="lookup-section-header">
                                <div class="lookup-section-icon">👤</div>
                                <h3 class="lookup-section-title">Identity & Account</h3>
                            </div>
                            <div class="lookup-info-grid">
                                <div class="lookup-info-item"><span class="lookup-info-label">Created</span><span class="lookup-info-value">${safeHtml(createdDate)}</span></div>
                                <div class="lookup-info-item"><span class="lookup-info-label">Joined Server</span><span class="lookup-info-value">${safeHtml(joinedDate)}</span></div>
                                <div class="lookup-info-item"><span class="lookup-info-label">Timeout Until</span><span class="lookup-info-value">${safeHtml(timeoutUntil)}</span></div>
                                <div class="lookup-info-item lookup-info-item-full"><span class="lookup-info-label">Bio</span><span class="lookup-info-value">${safeHtml(String(user.bio || user.db?.bio || 'No bio available'))}</span></div>
                                <div class="lookup-info-item lookup-info-item-full"><span class="lookup-info-label">Roles</span><div class="lookup-roles-list">${rolesHtml}</div></div>
                            </div>
                        </section>
                    </div>
                </div>

                <div class="lookup-tab-content" data-lookup-content="moderation">
                    <div class="lookup-info-sections">
                        <section class="lookup-info-section">
                            <div class="lookup-section-header">
                                <div class="lookup-section-icon">⚠️</div>
                                <h3 class="lookup-section-title">Warnings</h3>
                            </div>
                            <div class="lookup-info-grid">${warningsHtml}</div>
                        </section>
                        <section class="lookup-info-section">
                            <div class="lookup-section-header">
                                <div class="lookup-section-icon">⏳</div>
                                <h3 class="lookup-section-title">Timeouts</h3>
                            </div>
                            <div class="lookup-info-grid">${timeoutHtml}</div>
                        </section>
                        <section class="lookup-info-section">
                            <div class="lookup-section-header">
                                <div class="lookup-section-icon">🔨</div>
                                <h3 class="lookup-section-title">Ban History</h3>
                            </div>
                            <div class="lookup-info-grid">${bansHtml}</div>
                        </section>
                    </div>
                </div>

                <div class="lookup-tab-content" data-lookup-content="notes">
                    <div class="lookup-notes-input-wrapper">
                        <textarea id="lookupNoteInput" class="lookup-notes-textarea" rows="4" placeholder="Add moderator context, escalation notes, or follow-up actions..."></textarea>
                        <div class="lookup-notes-actions">
                            <span class="lookup-notes-meta">Saves to member notes log</span>
                            <button class="btn btn-primary" onclick="saveLookupNote()">Save Note</button>
                        </div>
                    </div>
                    <div class="lookup-info-grid">${notesHtml}</div>
                </div>
            </div>
        </div>
    `;

    switchLookupTab(window._lookupState.activeTab || 'overview');
}

function switchLookupTab(tabName) {
    const tab = String(tabName || 'overview');
    window._lookupState.activeTab = tab;

    document.querySelectorAll('[data-lookup-tab]').forEach((el) => {
        if (el.getAttribute('data-lookup-tab') === tab) el.classList.add('active');
        else el.classList.remove('active');
    });

    document.querySelectorAll('[data-lookup-content]').forEach((el) => {
        if (el.getAttribute('data-lookup-content') === tab) el.classList.add('active');
        else el.classList.remove('active');
    });
}

function getLookupStorageKey() {
    return 'admin.lookup.recent.v1';
}

function persistRecentLookups(list) {
    try {
        localStorage.setItem(getLookupStorageKey(), JSON.stringify(list || []));
    } catch (err) {
        console.error('Failed to persist recent lookups:', err);
    }
}

function readRecentLookups() {
    try {
        const raw = localStorage.getItem(getLookupStorageKey());
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function renderRecentLookups(users = []) {
    const list = document.getElementById('lookupRecentList');
    if (!list) return;

    if (!users.length) {
        list.innerHTML = '<div class="empty-state" style="padding: 1rem;"><span style="font-size: 0.9rem;">No recent searches</span></div>';
        return;
    }

    list.innerHTML = users.slice(0, 10).map((item) => {
        const userId = safeJsString(String(item.userId || item.id || ''));
        const username = safeHtml(String(item.username || item.globalName || 'Unknown'));
        const level = Number(item.level || 0);
        return `<button class="lookup-recent-badge" onclick="performLookup('${userId}')">${username}<span class="text-muted"> • Lv${level}</span></button>`;
    }).join('');
}

function addRecentLookup(user) {
    if (!user?.id) return;
    const current = readRecentLookups();
    const normalized = current.filter((item) => String(item.userId || item.id) !== String(user.id));
    normalized.unshift({
        userId: String(user.id),
        username: String(user.globalName || user.username || 'Unknown'),
        level: Number(user.db?.level || 0),
        at: Date.now()
    });

    const trimmed = normalized.slice(0, 10);
    window._lookupState.recentUsers = trimmed;
    persistRecentLookups(trimmed);
    renderRecentLookups(trimmed);
}

async function loadRecentLookups() {
    const api = getLookupApi();
    const cached = readRecentLookups();
    if (cached.length) {
        window._lookupState.recentUsers = cached;
        renderRecentLookups(cached);
        return;
    }

    if (!api) return;

    try {
        const { response, data } = await api.getJson('/api/admin/recent-lookups');
        if (!response?.ok) {
            renderRecentLookups([]);
            return;
        }
        const users = Array.isArray(data?.users) ? data.users : [];
        window._lookupState.recentUsers = users;
        persistRecentLookups(users);
        renderRecentLookups(users);
    } catch (error) {
        console.error('Failed to load recent lookups:', error);
        renderRecentLookups([]);
    }
}

async function fetchLookupProfile(query) {
    const api = getLookupApi();
    if (!api) throw new Error('API unavailable');

    const encoded = encodeURIComponent(String(query || '').trim());
    const { response, data } = await api.getJson(`/api/admin/system/lookup/${encoded}`);
    if (!response?.ok) {
        throw new Error(data?.error || 'Lookup failed');
    }
    return data;
}

function normalizeLookupResults(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter((item) => item && item.userId)
        .map((item) => ({
            userId: String(item.userId),
            username: String(item.username || 'Unknown'),
            nickname: item.nickname ? String(item.nickname) : null,
            level: Number(item.level || 0),
            warnCount: Number(item.warnCount || 0),
            banned: Boolean(item.banned),
            isTimedOut: Boolean(item.isTimedOut),
            inServer: Boolean(item.inServer)
        }));
}

async function performLookup(prefillQuery = '') {
    const inputEl = document.getElementById('advancedLookupInput');
    const hiddenInput = document.getElementById('userLookupInput');
    const panel = document.getElementById('lookupResultsPanel');
    const profileContainer = document.getElementById('lookupProfileContainer');
    const api = getLookupApi();

    if (!inputEl || !hiddenInput || !panel || !profileContainer || !api) return;

    const query = String(prefillQuery || inputEl.value || '').trim();
    if (!query) {
        adminShowNotification('Enter a username or user ID', 'warning');
        return;
    }

    inputEl.value = query;
    hiddenInput.value = query;
    panel.classList.add('show');
    renderLookupSuggestions([]);
    showLookupLoading(true);

    const filters = getAdvancedLookupFilters();
    let searchResults = [];

    try {
        const searchParams = new URLSearchParams({ query });
        if (filters.status) searchParams.set('status', String(filters.status));
        if (filters.minLevel !== undefined) searchParams.set('minLevel', String(filters.minLevel));
        if (filters.maxLevel !== undefined) searchParams.set('maxLevel', String(filters.maxLevel));
        if (filters.minWarnings !== undefined) searchParams.set('minWarnings', String(filters.minWarnings));

        const { response, data } = await api.getJson(`/api/admin/search-users-advanced?${searchParams.toString()}`);
        if (response?.ok) {
            searchResults = normalizeLookupResults(data?.results);
        }
    } catch (error) {
        console.error('Advanced search failed:', error);
    }

    renderLookupSearchResults(searchResults);

    try {
        const lookupTarget = /^\d{17,20}$/.test(query)
            ? query
            : (searchResults[0]?.userId || query);

        const profile = await fetchLookupProfile(lookupTarget);
        window._lookupState.currentUser = profile;
        renderLookupProfile(profile);
        addRecentLookup(profile);
    } catch (error) {
        window._lookupState.currentUser = null;
        profileContainer.innerHTML = `<div class="lookup-recent-section">${safeHtml(error.message || 'User lookup failed')}</div>`;
        adminShowNotification(error.message || 'Lookup failed', 'error');
    } finally {
        showLookupLoading(false);
    }
}

async function saveLookupNote() {
    const user = window._lookupState.currentUser;
    const noteEl = document.getElementById('lookupNoteInput');
    const api = getLookupApi();

    if (!user?.id || !noteEl || !api) {
        adminShowNotification('No selected user for note save', 'warning');
        return;
    }

    const note = String(noteEl.value || '').trim();
    if (!note) {
        adminShowNotification('Write a note before saving', 'warning');
        return;
    }

    try {
        const { response, data } = await api.postJson(`/api/admin/system/lookup/${encodeURIComponent(String(user.id))}/notes`, { note });
        if (!response?.ok) throw new Error(data?.error || 'Failed to save note');
        noteEl.value = '';
        adminShowNotification('Moderator note saved', 'success');
        const refreshedProfile = await fetchLookupProfile(String(user.id));
        window._lookupState.currentUser = refreshedProfile;
        renderLookupProfile(refreshedProfile);
    } catch (error) {
        console.error('Failed to save lookup note:', error);
        adminShowNotification(error.message || 'Failed to save note', 'error');
    }
}

window._autoModAdvanced = null;
window._autoModQueuePage = 1;
window._autoModQueueIndex = {};

async function loadAutoModConfig() {
    try {
        const res = await fetchWithCsrf('/api/automod/config');
        if (!res.ok) {
            const data = await res.json();
            throw new Error(data.error || 'Failed to fetch AutoMod config');
        }

        const data = await res.json();
        window._autoModConfig = data;
        renderAutoModUI();
        await loadAutoModAdvancedData(1);
        adminShowNotification('AutoMod settings loaded', 'success');
    } catch (err) {
        console.error("Error loading AutoMod config:", err);
        adminShowNotification('Failed to load AutoMod config', 'error');
    }
}

function setAutoModStatus(message, type = 'info') {
    const el = document.getElementById('automodStatusMessage');
    if (!el) return;
    el.textContent = message || '';
    el.classList.remove('text-danger', 'text-muted');
    if (type === 'error') el.classList.add('text-danger');
    else el.classList.add('text-muted');
}

function setTextContent(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = value;
}

function formatLocalTime(input) {
    if (!input) return '-';
    const date = new Date(input);
    return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
}

function formatCount(value) {
    const numeric = Number(value || 0);
    if (!Number.isFinite(numeric)) return '0';
    return numeric.toLocaleString();
}

function safeJsString(str) {
    return str.replace(/'/g, "\\'").replace(/"/g, '\\"');
}

window._autoModSelectedProfile = null;

function renderAutoModUI() {
    if (!window._autoModConfig) return;

    const config = window._autoModConfig;
    const profiles = Object.keys(config.autoModProfiles?.profiles || {});
    const activeProfile = config.autoModProfiles?.activeProfile || 'balanced';

    if (!window._autoModSelectedProfile || !profiles.includes(window._autoModSelectedProfile)) {
        window._autoModSelectedProfile = activeProfile;
    }

    const listEl = document.getElementById('automodProfileList');
    if (listEl) {
        const itemsInfo = profiles.map(p => {
            const isActive = p === activeProfile;
            const isSelected = p === window._autoModSelectedProfile;
            return { name: p, isActive, isSelected };
        });

        let html = `
            <div class="user-list-item special-create-btn" onclick="promptCreateAutoModProfile()" style="border-bottom:1px solid rgba(255,255,255,0.1); margin-bottom:0.5rem;">
                <div class="user-item-info">
                    <span style="font-size:1.2em; font-weight:bold; color:var(--primary); margin-right:0.5rem;">+</span>
                    <span class="user-item-name" style="color:var(--primary);">New Profile</span>
                </div>
            </div>
        `;

        html += itemsInfo.map(item => `
            <div class="user-list-item ${item.isSelected ? 'active' : ''}" onclick="selectAutoModProfile('${safeJsString(item.name)}', true)">
                <div class="user-item-info">
                    ${item.isActive ? '<span class="status-indicator status-active" title="Active Policy"></span>' : ''}
                    <span class="user-item-name">${safeHtml(item.name)}</span>
                    ${item.isActive ? '<span class="role-badge" style="margin-left:auto; font-size:0.7em;">ACTIVE</span>' : ''}
                </div>
            </div>
        `).join('');

        listEl.innerHTML = html;
    }

    selectAutoModProfile(window._autoModSelectedProfile, false);

    const effective = config.effectiveAutoMod || {};
    const effectiveAutoMod = effective.autoMod || {};
    const effectiveAdvanced = effective.autoModAdvanced || {};
    const summaryEl = document.getElementById('automodSummary');
    if (summaryEl) {
        summaryEl.innerHTML = `
            <strong>Active settings (${safeHtml(activeProfile)}):</strong>
            Wait=${effectiveAutoMod.baseTimeoutMs / 1000}s,
            Spam=${effectiveAutoMod.spamThreshold},
            Sim=${effectiveAutoMod.similarityThreshold},
            Kick24h=${effectiveAdvanced.kickThreshold24h ?? '-'}
        `;
    }
}

function selectAutoModProfile(profileName, refreshList = false) {
    if (!profileName) return;
    window._autoModSelectedProfile = profileName;

    if (refreshList) {
        renderAutoModUI();
        return;
    }

    const titleEl = document.getElementById('automodSelectedProfileTitle');
    if (titleEl) titleEl.textContent = profileName.charAt(0).toUpperCase() + profileName.slice(1);

    const badgeEl = document.getElementById('automodProfileStatusBadge');
    if (badgeEl) {
        const isActive = (window._autoModConfig?.autoModProfiles?.activeProfile === profileName);
        if (isActive) {
            badgeEl.innerHTML = '✅ <strong>Active Runtime Policy</strong>';
            badgeEl.className = 'text-success';
        } else {
            badgeEl.textContent = 'Editing this profile';
            badgeEl.className = 'text-muted';
        }
        badgeEl.style.display = 'block';
    }

    renderAutoModForm(profileName);
}

function renderAutoModForm(profileName) {
    const config = window._autoModConfig;
    if (!config || !config.autoModProfiles?.profiles) return;

    const profile = config.autoModProfiles.profiles[profileName];
    if (!profile) return;

    const setVal = (id, val) => {
        const el = document.getElementById(id);
        if (el) {
            if (el.type === 'checkbox') el.checked = Boolean(val);
            else el.value = val !== undefined && val !== null ? val : '';
        }
    };


    const am = profile.autoMod || {};
    setVal('automodSpamThreshold', am.spamThreshold);
    setVal('automodSpamWindowMs', am.spamWindow);
    setVal('automodSpamWarningThreshold', am.spamWarningThreshold);
    setVal('automodSpamTimeoutMs', am.spamTimeout);
    setVal('automodCapsThreshold', am.capsThreshold);
    setVal('automodSimilarityWindowMs', am.similarityWindowMs);
    setVal('automodSimilarityThreshold', am.similarityThreshold);
    setVal('automodSimilarityMinLength', am.similarityMinLength);
    setVal('automodSimilarityRepeatThreshold', am.similarityRepeatThreshold);
    setVal('automodRiskWarnThreshold', am.riskWarnThreshold);
    setVal('automodRiskDeleteThreshold', am.riskDeleteThreshold);
    setVal('automodRiskTimeoutThreshold', am.riskTimeoutThreshold);
    setVal('automodBaseTimeoutMs', am.baseTimeoutMs);
    setVal('automodMaxTimeoutMs', am.maxTimeoutMs);

    const adv = profile.autoModAdvanced || {};
    setVal('automodEscalationThreshold', adv.escalationThreshold24h);
    setVal('automodEscalationTimeoutMs', adv.escalationTimeoutMs);
    setVal('automodProgressiveTimeoutMultiplier', adv.progressiveTimeoutMultiplier);
    setVal('automodKickThreshold24h', adv.kickThreshold24h);
    setVal('automodRegexMaxPatternLength', adv.regexMaxPatternLength);

    const rw = adv.riskWeights || {};
    setVal('automodRiskWeightSpam', rw.spam);
    setVal('automodRiskWeightSimilarity', rw.similarity);
    setVal('automodRiskWeightCaps', rw.caps);
    setVal('automodRiskWeightProfanity', rw.profanity);
    setVal('automodRiskWeightRegex', rw.regex);
    setVal('automodRiskWeightInvites', rw.invites);
    setVal('automodRiskWeightMentions', rw.mentions);

    setVal('automodRegexPatterns', (adv.blockedRegexPatterns || []).join('\n'));
    setVal('automodExemptChannels', (adv.exemptChannelIds || []).join('\n'));
    setVal('automodExemptRoles', (adv.exemptRoleIds || []).join('\n'));
}

async function setActiveAutoModProfile() {
    const target = window._autoModSelectedProfile;
    if (!target) return adminShowNotification('No profile selected', 'warning');

    try {
        const res = await fetchWithCsrf('/api/automod/config', {
            method: 'POST',
            body: JSON.stringify({ activeProfile: target })
        });
        const data = await res.json();

        if (res.ok) {
            adminShowNotification(`Active profile set to: ${target}`, 'success');
            await loadAutoModConfig();
        } else {
            adminShowNotification(data.error || 'Failed to set active profile', 'error');
        }
    } catch (err) {
        console.error(err);
        adminShowNotification('Error setting active profile', 'error');
    }
}

async function promptCreateAutoModProfile() {
    const name = await window.showConfirmModal("New AutoMod Profile", "Enter a name for the new AutoMod profile:", true, "Profile Name (e.g. Strict Mode)");
    if (!name) return;
    if (name.length < 3) return adminShowNotification('Name too short', 'warning');

    const currentName = window._autoModSelectedProfile || 'balanced';
    const baseProfile = window._autoModConfig.autoModProfiles?.profiles[currentName] || {};

    try {
        const res = await fetchWithCsrf('/api/automod/config', {
            method: 'POST',
            body: JSON.stringify({
                profileName: name,
                profileConfig: baseProfile
            })
        });
        const data = await res.json();

        if (res.ok) {
            adminShowNotification(`Profile ${name} created`, 'success');
            await loadAutoModConfig();
            selectAutoModProfile(name, true);
        } else {
            adminShowNotification(data.error || 'Failed to create profile', 'error');
        }
    } catch (err) {
        console.error(err);
        adminShowNotification('Error creating profile', 'error');
    }
}

async function deleteAutoModProfile() {
    const name = window._autoModSelectedProfile;
    if (!name) return;

    if (['balanced', 'strict', 'relaxed'].includes(name)) {
        return adminShowNotification('Cannot delete default system profiles', 'warning');
    }

    const confirmed = await window.showConfirmModal("Delete AutoMod Profile", `Are you sure you want to delete profile "${name}"? This action cannot be undone.`);
    if (!confirmed) return;

    try {
        const res = await fetchWithCsrf('/api/automod/config', {
            method: 'POST',
            body: JSON.stringify({ deleteProfile: name })
        });
        const data = await res.json();

        if (res.ok) {
            adminShowNotification(`Profile ${name} deleted`, 'success');
            window._autoModSelectedProfile = null;
            await loadAutoModConfig();
        } else {
            adminShowNotification(data.error || 'Failed to delete profile', 'error');
        }
    } catch (err) {
        console.error(err);
        adminShowNotification('Error deleting profile', 'error');
    }
}

async function saveSelectedAutoModProfileSettings() {
    const profileName = window._autoModSelectedProfile;
    if (!profileName) return adminShowNotification('No profile selected', 'warning');

    const getVal = (id) => document.getElementById(id)?.value;
    const getNum = (id) => Number(document.getElementById(id)?.value);
    const getBool = (id) => document.getElementById(id)?.value === 'true';
    const getList = (id) => (document.getElementById(id)?.value || '').split('\n').map(s => s.trim()).filter(Boolean);
    const getOptionalNum = (id) => {
        const raw = document.getElementById(id)?.value;
        if (raw === undefined || raw === null || raw === '') return undefined;
        const numeric = Number(raw);
        return Number.isFinite(numeric) ? numeric : undefined;
    };

    const payload = {
        profileName: profileName,
        profileConfig: {
            blockExternalInvites: getBool('automodBlockInvites'),
            maxMentionsBeforeFlag: getNum('automodMaxMentions'),
            autoMod: {
                spamThreshold: getNum('automodSpamThreshold'),
                spamWindow: getNum('automodSpamWindowMs'),
                spamWarningThreshold: getNum('automodSpamWarningThreshold'),
                spamTimeout: getNum('automodSpamTimeoutMs'),
                capsThreshold: parseFloat(getVal('automodCapsThreshold')),
                similarityWindowMs: getNum('automodSimilarityWindowMs'),
                similarityThreshold: parseFloat(getVal('automodSimilarityThreshold')),
                similarityMinLength: getNum('automodSimilarityMinLength'),
                similarityRepeatThreshold: getNum('automodSimilarityRepeatThreshold'),
                riskWarnThreshold: getNum('automodRiskWarnThreshold'),
                riskDeleteThreshold: getNum('automodRiskDeleteThreshold'),
                riskTimeoutThreshold: getNum('automodRiskTimeoutThreshold'),
                baseTimeoutMs: getNum('automodBaseTimeoutMs'),
                maxTimeoutMs: getNum('automodMaxTimeoutMs')
            },
            autoModAdvanced: {
                escalationThreshold24h: getNum('automodEscalationThreshold'),
                escalationTimeoutMs: getNum('automodEscalationTimeoutMs'),
                progressiveTimeoutMultiplier: getOptionalNum('automodProgressiveTimeoutMultiplier'),
                kickThreshold24h: getNum('automodKickThreshold24h'),
                regexMaxPatternLength: getNum('automodRegexMaxPatternLength'),
                blockedRegexPatterns: getList('automodRegexPatterns'),
                exemptChannelIds: getList('automodExemptChannels'),
                exemptRoleIds: getList('automodExemptRoles'),
                riskWeights: {
                    spam: getNum('automodRiskWeightSpam'),
                    similarity: getNum('automodRiskWeightSimilarity'),
                    caps: getNum('automodRiskWeightCaps'),
                    profanity: getNum('automodRiskWeightProfanity'),
                    regex: getNum('automodRiskWeightRegex'),
                    invites: getNum('automodRiskWeightInvites'),
                    mentions: getNum('automodRiskWeightMentions')
                }
            }
        }
    };

    try {
        const res = await fetchWithCsrf('/api/automod/config', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        const data = await res.json();

        if (res.ok) {
            adminShowNotification(`Settings saved for ${profileName}`, 'success');
            await loadAutoModConfig();
        } else {
            adminShowNotification(data.error || 'Failed to save settings', 'error');
        }
    } catch (err) {
        console.error(err);
        adminShowNotification('Error saving settings', 'error');
    }
}

async function runAutoModSimulation() {
    const message = document.getElementById('automodSimMessage')?.value;
    if (!message) return adminShowNotification('Please enter a message to test', 'warning');

    const recentCount = Number(document.getElementById('automodSimRecentCount')?.value) || 1;
    const priorViolations = Number(document.getElementById('automodSimPriorViolations')?.value) || 0;
    const useSaved = document.getElementById('automodSimUseSavedOnly')?.checked;

    let payload = {
        message,
        recentMessageCount: recentCount,
        priorViolations24h: priorViolations
    };

    if (!useSaved) {
        const getVal = (id) => document.getElementById(id)?.value;
        const getNum = (id) => Number(document.getElementById(id)?.value);
        const getBool = (id) => document.getElementById(id)?.value === 'true';
        const getList = (id) => (document.getElementById(id)?.value || '').split('\n').map(s => s.trim()).filter(Boolean);
        const getOptionalNum = (id) => {
            const raw = document.getElementById(id)?.value;
            if (raw === undefined || raw === null || raw === '') return undefined;
            const numeric = Number(raw);
            return Number.isFinite(numeric) ? numeric : undefined;
        };

        payload.draftConfig = {
            blockExternalInvites: getBool('automodBlockInvites'),
            maxMentionsBeforeFlag: getNum('automodMaxMentions'),
            autoMod: {
                spamThreshold: getNum('automodSpamThreshold'),
                spamWindow: getNum('automodSpamWindowMs'),
                spamWarningThreshold: getNum('automodSpamWarningThreshold'),
                spamTimeout: getNum('automodSpamTimeoutMs'),
                capsThreshold: parseFloat(getVal('automodCapsThreshold')),
                similarityWindowMs: getNum('automodSimilarityWindowMs'),
                similarityThreshold: parseFloat(getVal('automodSimilarityThreshold')),
                similarityMinLength: getNum('automodSimilarityMinLength'),
                similarityRepeatThreshold: getNum('automodSimilarityRepeatThreshold'),
                riskWarnThreshold: getNum('automodRiskWarnThreshold'),
                riskDeleteThreshold: getNum('automodRiskDeleteThreshold'),
                riskTimeoutThreshold: getNum('automodRiskTimeoutThreshold'),
                baseTimeoutMs: getNum('automodBaseTimeoutMs'),
                maxTimeoutMs: getNum('automodMaxTimeoutMs')
            },
            autoModAdvanced: {
                escalationThreshold24h: getNum('automodEscalationThreshold'),
                escalationTimeoutMs: getNum('automodEscalationTimeoutMs'),
                progressiveTimeoutMultiplier: getOptionalNum('automodProgressiveTimeoutMultiplier'),
                kickThreshold24h: getNum('automodKickThreshold24h'),
                regexMaxPatternLength: getNum('automodRegexMaxPatternLength'),
                blockedRegexPatterns: getList('automodRegexPatterns'),
                exemptChannelIds: getList('automodExemptChannels'),
                exemptRoleIds: getList('automodExemptRoles'),
                riskWeights: {
                    spam: getNum('automodRiskWeightSpam'),
                    similarity: getNum('automodRiskWeightSimilarity'),
                    caps: getNum('automodRiskWeightCaps'),
                    profanity: getNum('automodRiskWeightProfanity'),
                    regex: getNum('automodRiskWeightRegex'),
                    invites: getNum('automodRiskWeightInvites'),
                    mentions: getNum('automodRiskWeightMentions')
                }
            }
        };
    }

    const resultBox = document.getElementById('automodSimResult');
    resultBox.innerHTML = 'Running simulation...';
    resultBox.className = 'automod-result-box';

    try {
        const res = await fetchWithCsrf('/api/automod/simulate', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        const data = await res.json();

        if (res.ok && data.result) {
            const r = data.result;
            const isFlagged = r.verdict === 'flagged';
            const findings = Array.isArray(r.findings) ? r.findings : [];
            const actions = Array.isArray(r.actions) ? r.actions : [];
            const riskScore = Number(r.riskScore || 0);
            const riskLevel = String(r.riskLevel || 'low').toUpperCase();
            const predictedAction = String(r.predictedAction || 'warn').toUpperCase();

            let html = `<strong>Verdict:</strong> <span class="${isFlagged ? 'text-danger' : 'text-success'}">${safeHtml(String(r.verdict || 'unknown').toUpperCase())}</span>`;
            html += `<br><strong>Risk:</strong> ${safeHtml(String(riskScore))} (${safeHtml(riskLevel)})`;
            html += `<br><strong>Predicted Action:</strong> ${safeHtml(predictedAction)}${r.predictedTimeoutMs ? ` (${safeHtml(String(r.predictedTimeoutMs))}ms)` : ''}`;
            html += `<br><strong>Findings:</strong> ${findings.length ? findings.map(safeHtml).join('; ') : 'None'}`;
            html += `<br><strong>Predicted Actions:</strong> ${actions.length ? actions.map(safeHtml).join('; ') : 'None'}`;

            resultBox.innerHTML = html;
            resultBox.classList.add(isFlagged ? 'border-danger' : 'border-success');
        } else {
            resultBox.textContent = 'Simulation failed.';
            adminShowNotification(data.error || 'Simulation failed', 'error');
        }
    } catch (err) {
        console.error(err);
        resultBox.textContent = 'Error running simulation.';
    }
}

function getAutoModQueueFilters() {
    const windowHours = Number(document.getElementById('automodAnalyticsWindow')?.value) || 168;
    const status = document.getElementById('automodQueueStatusFilter')?.value || 'all';
    const severity = document.getElementById('automodQueueSeverityFilter')?.value || 'all';
    return { windowHours, status, severity };
}

async function loadAutoModAdvancedData(page = 1) {
    try {
        const safePage = Math.max(1, Number(page) || 1);
        window._autoModQueuePage = safePage;
        const { windowHours, status, severity } = getAutoModQueueFilters();

        const query = new URLSearchParams({
            windowHours: String(windowHours),
            page: String(safePage),
            limit: '25',
            status,
            severity
        });

        const res = await fetchWithCsrf(`/api/automod/advanced?${query.toString()}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || 'Failed to load AutoMod advanced data');

        window._autoModAdvanced = data;
        renderAutoModAdvancedData(data);
        setAutoModStatus(`Loaded AutoMod analytics (${windowHours}h window).`);
    } catch (error) {
        console.error('Error loading advanced AutoMod data:', error);
        setAutoModStatus('Failed to load advanced AutoMod data.', 'error');
    }
}

function renderAutoModAdvancedData(data) {
    const summary = data?.summary || {};
    setTextContent('automodMetricTotal', formatCount(summary.total));
    setTextContent('automodMetricPending', formatCount(summary.pending));
    setTextContent('automodMetricHighRisk', formatCount(summary.highRisk));
    setTextContent('automodMetricResolved', formatCount((summary.approved || 0) + (summary.dismissed || 0)));

    const avgRisk = Number(summary.avgRiskScore || 0).toFixed(2);
    const falsePositiveRate = Number(summary.falsePositiveRate || 0).toFixed(2);
    const appealAware = formatCount(summary.appealAwareActions || 0);
    setAutoModStatus(`Analytics updated: avg risk ${avgRisk}, false-positive proxy ${falsePositiveRate}%, appeal-aware actions ${appealAware}.`);

    const trendBody = document.getElementById('automodTrendRows');
    if (trendBody) {
        const trendRows = Array.isArray(data?.trends) ? data.trends : [];
        trendBody.innerHTML = trendRows.length
            ? trendRows.map((row) => `
                <tr>
                    <td>${safeHtml(String(row.day || '-'))}</td>
                    <td>${formatCount(row.total)}</td>
                    <td>${formatCount(row.pending)}</td>
                    <td>${formatCount((row.approved || 0) + (row.dismissed || 0))}</td>
                </tr>
            `).join('')
            : '<tr><td colspan="4" class="text-center text-muted">No trend data yet.</td></tr>';
    }

    const typesBody = document.getElementById('automodTypeRows');
    if (typesBody) {
        const typeRows = Array.isArray(data?.types) ? data.types : [];
        typesBody.innerHTML = typeRows.length
            ? typeRows.map((row) => `
                <tr>
                    <td>${safeHtml(String(row.type || 'unknown'))}</td>
                    <td>${formatCount(row.count)}</td>
                </tr>
            `).join('')
            : '<tr><td colspan="2" class="text-center text-muted">No type data yet.</td></tr>';
    }

    const topUsersBody = document.getElementById('automodTopUsersRows');
    if (topUsersBody) {
        const users = Array.isArray(data?.topUsers) ? data.topUsers : [];
        topUsersBody.innerHTML = users.length
            ? users.map((row) => `
                <tr>
                    <td>${safeHtml(String(row.user_id || '-'))}</td>
                    <td>${formatCount(row.count)}</td>
                </tr>
            `).join('')
            : '<tr><td colspan="2" class="text-center text-muted">No user data yet.</td></tr>';
    }

    renderAutoModQueue(data);
}

function renderAutoModQueue(data) {
    const body = document.getElementById('automodQueueTable');
    if (!body) return;

    const queue = Array.isArray(data?.queue) ? data.queue : [];
    window._autoModQueueIndex = {};
    queue.forEach((item) => {
        window._autoModQueueIndex[String(item.id)] = item;
    });

    body.innerHTML = queue.length
        ? queue.map((item) => {
            const id = Number(item.id);
            const severity = String(item.review_severity || 'medium').toLowerCase();
            const status = String(item.review_status || 'pending').toLowerCase();
            const snippet = String(item.message_content || '').slice(0, 85);
            return `
                <tr title="${safeHtml(String(item.message_content || ''))}">
                    <td>${id}</td>
                    <td><code>${safeHtml(String(item.user_id || '-'))}</code></td>
                    <td>${safeHtml(String(item.violation_type || '-'))}</td>
                    <td>${safeHtml(String(item.action_taken || '-'))}</td>
                    <td>
                        <span class="automod-severity-chip ${safeHtml(severity)}">${safeHtml(severity)}</span>
                        <select id="automodRowSeverity-${id}" class="form-input" style="margin-top:0.35rem; min-width: 120px;">
                            <option value="critical" ${severity === 'critical' ? 'selected' : ''}>Critical</option>
                            <option value="high" ${severity === 'high' ? 'selected' : ''}>High</option>
                            <option value="medium" ${severity === 'medium' ? 'selected' : ''}>Medium</option>
                            <option value="low" ${severity === 'low' ? 'selected' : ''}>Low</option>
                        </select>
                    </td>
                    <td><span class="automod-status-chip ${safeHtml(status)}">${safeHtml(status)}</span></td>
                    <td>${formatLocalTime(item.timestamp)}</td>
                    <td>
                        <div class="automod-inline-actions" style="gap:0.4rem;">
                            <button class="btn btn-sm btn-secondary" onclick="setAutoModWorkflowTarget(${id})">Select</button>
                            <button class="btn btn-sm btn-primary" onclick="updateAutoModWorkflow(${id}, null, document.getElementById('automodRowSeverity-${id}')?.value)">Severity</button>
                            <button class="btn btn-sm btn-success" onclick="updateAutoModWorkflow(${id}, 'approved')">Approve</button>
                            <button class="btn btn-sm btn-danger" onclick="updateAutoModWorkflow(${id}, 'dismissed')">Dismiss</button>
                        </div>
                        <div class="text-muted" style="margin-top:0.35rem; max-width: 260px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${safeHtml(snippet || '-')}</div>
                    </td>
                </tr>
            `;
        }).join('')
        : '<tr><td colspan="8" class="text-center text-muted">No incidents match the current filters.</td></tr>';

    const page = Number(data?.pagination?.page || 1);
    const pages = Number(data?.pagination?.pages || 1);
    const pageInfo = document.getElementById('automodQueuePaginationInfo');
    if (pageInfo) pageInfo.textContent = `Page ${page} / ${pages}`;
}

function changeAutoModQueuePage(delta) {
    const current = Number(window._autoModAdvanced?.pagination?.page || window._autoModQueuePage || 1);
    const pages = Number(window._autoModAdvanced?.pagination?.pages || 1);
    const next = Math.max(1, Math.min(pages, current + Number(delta || 0)));
    if (next === current) return;
    loadAutoModAdvancedData(next);
}

function setAutoModWorkflowTarget(violationId) {
    const item = window._autoModQueueIndex?.[String(violationId)];
    const idInput = document.getElementById('automodWorkflowSelectedId');
    const noteInput = document.getElementById('automodWorkflowNote');
    if (idInput) idInput.value = String(violationId);
    if (noteInput) noteInput.value = String(item?.note || '');
    setAutoModStatus(`Selected incident #${violationId} for review notes.`);
}

async function updateAutoModWorkflow(violationId, status = null, severity = null, note = null) {
    const id = Number(violationId);
    if (!Number.isFinite(id) || id <= 0) {
        adminShowNotification('Invalid incident id', 'error');
        return;
    }

    const payload = {};
    if (status) payload.status = String(status);
    if (severity) payload.severity = String(severity);
    if (note !== null && note !== undefined) payload.note = String(note);

    if (!Object.keys(payload).length) {
        adminShowNotification('Nothing to update', 'warning');
        return;
    }

    try {
        const res = await fetchWithCsrf(`/api/automod/workflow/${id}`, {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || 'Workflow update failed');

        adminShowNotification(`Incident #${id} updated`, 'success');
        const activePage = Number(window._autoModAdvanced?.pagination?.page || 1);
        await loadAutoModAdvancedData(activePage);
    } catch (error) {
        console.error('Error updating workflow item:', error);
        adminShowNotification(error.message || 'Failed to update incident workflow', 'error');
    }
}

async function saveAutoModWorkflowNote() {
    const id = Number(document.getElementById('automodWorkflowSelectedId')?.value);
    const note = String(document.getElementById('automodWorkflowNote')?.value || '');
    if (!Number.isFinite(id) || id <= 0) {
        adminShowNotification('Select an incident first', 'warning');
        return;
    }
    await updateAutoModWorkflow(id, null, null, note);
}

async function bulkResolveAutoModPending() {
    const queue = Array.isArray(window._autoModAdvanced?.queue) ? window._autoModAdvanced.queue : [];
    const pending = queue.filter((item) => String(item.review_status || 'pending').toLowerCase() === 'pending').slice(0, 15);
    if (!pending.length) {
        adminShowNotification('There are no visible pending incidents to resolve', 'info');
        return;
    }

    const confirmed = await (window.modalManager
        ? window.modalManager.showConfirm(`Resolve ${pending.length} visible pending incidents as approved?`)
        : Promise.resolve(confirm(`Resolve ${pending.length} visible pending incidents as approved?`)));
    if (!confirmed) return;

    try {
        await Promise.all(pending.map((item) => fetchWithCsrf(`/api/automod/workflow/${item.id}`, {
            method: 'POST',
            body: JSON.stringify({ status: 'approved' })
        })));
        adminShowNotification(`Resolved ${pending.length} incidents`, 'success');
        await loadAutoModAdvancedData(Number(window._autoModAdvanced?.pagination?.page || 1));
    } catch (error) {
        console.error('Bulk resolve failed:', error);
        adminShowNotification('Bulk resolve failed', 'error');
    }
}

window.switchTab = switchTab;
window.renderAppealsPage = renderAppealsPage;
window.loadAppeals = loadAppeals;
window.acceptAppeal = acceptAppeal;
window.denyAppeal = denyAppeal;
window.loadAppealHistory = loadAppealHistory;
window.renderAppealHistoryPage = renderAppealHistoryPage;
window.getFilteredAppeals = getFilteredAppeals;
window.getFilteredAppealHistory = getFilteredAppealHistory;
window.adminShowNotification = adminShowNotification;
window.toggleFilters = toggleFilters;
window.handleLookupInput = handleLookupInput;
window.performLookup = performLookup;
window.switchLookupTab = switchLookupTab;
window.saveLookupNote = saveLookupNote;



async function loadGhostPings() {
    try {
        const api = window.api || (window.AdminPanel && window.AdminPanel.api);
        if (!api || typeof api.getJson !== 'function') throw new Error('API client not available');

        const { response, data } = await api.getJson('/api/admin/ghost-pings?limit=100', { cache: 'no-store' });
        if (!response?.ok || !data?.data) throw new Error(data?.error || 'Failed to fetch ghost pings');

        window._allGhostPings = Array.isArray(data.data) ? data.data : [];
        renderGhostPingMetrics(window._allGhostPings);
        filterGhostPings();
    } catch (err) {
        console.error('Failed to load ghost pings:', err);
        window._allGhostPings = [];
        renderGhostPingMetrics([]);
        filterGhostPings();
        adminShowNotification('Could not load ghost ping data', 'error');
    }
}


window.loadSuggestions = loadSuggestions;
window.loadGhostPings = loadGhostPings;
window.loadAdminXpLeaderboard = loadAdminXpLeaderboard;

window.loadAutoModProfiles = loadAutoModConfig;
window.loadAutoModConfig = loadAutoModConfig;
window.setActiveAutoModProfile = setActiveAutoModProfile;
window.promptCreateAutoModProfile = promptCreateAutoModProfile;
window.deleteAutoModProfile = deleteAutoModProfile;
window.saveSelectedAutoModProfileSettings = saveSelectedAutoModProfileSettings;
window.runAutoModSimulation = runAutoModSimulation;
window.loadAutoModAdvancedData = loadAutoModAdvancedData;
window.changeAutoModQueuePage = changeAutoModQueuePage;
window.updateAutoModWorkflow = updateAutoModWorkflow;
window.setAutoModWorkflowTarget = setAutoModWorkflowTarget;
window.saveAutoModWorkflowNote = saveAutoModWorkflowNote;
window.bulkResolveAutoModPending = bulkResolveAutoModPending;

function refreshAdminVisibleData() {
    const activeTab = document.querySelector('.tab.active')?.dataset?.tab || '';

    if (activeTab === 'banned-users' && typeof loadBannedUsers === 'function') {
        loadBannedUsers();
        return;
    }
    if (activeTab === 'appeals' && typeof loadAppeals === 'function') {
        loadAppeals();
        return;
    }
    if (activeTab === 'appeals-history' && typeof loadAppealHistory === 'function') {
        loadAppealHistory();
        return;
    }
    if (activeTab === 'xp-leaderboard' && typeof loadAdminXpLeaderboard === 'function') {
        loadAdminXpLeaderboard();
        return;
    }
    if (activeTab === 'automod' && typeof loadAutoModConfig === 'function') {
        if (typeof isOwner === 'function' && !isOwner()) return;
        loadAutoModConfig();
        return;
    }
}

if (window.AdminPanel) {
    window.AdminPanel.refreshVisibleData = refreshAdminVisibleData;
}

document.addEventListener('adminpanel:refresh-visible-data', refreshAdminVisibleData);

let _confirmResolve = null;

window.closeConfirmModal = function () {
    const modal = document.getElementById('universalConfirmModal');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.remove('show');
    }
    if (_confirmResolve) {
        _confirmResolve(null);
        _confirmResolve = null;
    }
};


window.showConfirmModal = function (title, message, isPrompt = false, placeholder = '') {
    return new Promise((resolve) => {
        _confirmResolve = resolve;

        const modal = document.getElementById('universalConfirmModal');
        const titleEl = document.getElementById('universalConfirmTitle');
        const msgEl = document.getElementById('universalConfirmMessage');
        const promptContainer = document.getElementById('universalPromptContainer');
        const promptInput = document.getElementById('universalPromptInput');
        const confirmBtn = document.getElementById('universalConfirmBtn');

        if (!modal) {
            console.error('Universal Confirm Modal not found in DOM');
            return resolve(isPrompt ? null : false);
        }

        titleEl.textContent = title;
        msgEl.textContent = message;

        if (isPrompt) {
            promptContainer.style.display = 'block';
            promptInput.value = '';
            promptInput.placeholder = placeholder || 'Enter details...';
            setTimeout(() => promptInput.focus(), 100);
        } else {
            promptContainer.style.display = 'none';
        }

        confirmBtn.onclick = () => {
            if (isPrompt) {
                const val = promptInput.value.trim();
                if (!val && isPrompt) {
                }
                resolve(val);
            } else {
                resolve(true);
            }
            _confirmResolve = null;
            modal.style.display = 'none';
            modal.classList.remove('show');
        };

        modal.style.display = 'flex';
        setTimeout(() => modal.classList.add('show'), 10);
    });
};







function renderGhostPingMetrics(pings) {
    if (!Array.isArray(pings)) return;

    const total = pings.length;
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
    const recent = pings.filter(p => (now - new Date(p.createdAt).getTime()) < oneDay).length;

    const userCounts = {};
    const channelCounts = {};

    pings.forEach(p => {
        const u = String(p.userTag || p.userId || 'Unknown');
        const c = String(p.channelName ? `#${p.channelName}` : (p.channelId || 'Unknown'));
        userCounts[u] = (userCounts[u] || 0) + 1;
        channelCounts[c] = (channelCounts[c] || 0) + 1;
    });

    const getTop = (obj) => {
        let topKey = '-';
        let topVal = 0;
        for (const [k, v] of Object.entries(obj)) {
            if (v > topVal) {
                topKey = k;
                topVal = v;
            }
        }
        return topKey;
    };

    const topUser = getTop(userCounts);
    const topChannel = getTop(channelCounts);

    const setTxt = (id, txt) => {
        const el = document.getElementById(id);
        if (el) el.textContent = txt;
    };

    setTxt('ghostMetricTotal', total.toLocaleString());
    setTxt('ghostMetric24h', recent.toLocaleString());
    setTxt('ghostMetricTopUser', topUser.length > 20 ? topUser.substring(0, 18) + '..' : topUser);
    setTxt('ghostMetricTopChannel', topChannel);
}

function filterGhostPings() {
    const list = document.getElementById('ghostPingList');
    if (!list) {
        const tbody = document.getElementById('ghostPingTableBody');
        if (tbody) tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;">Please hard-refresh (Ctrl+F5) to see the new UI.</td></tr>';
        return;
    }

    const allPings = window._allGhostPings || [];

    const searchInput = document.getElementById('ghostPingSearchInput');
    const query = searchInput ? searchInput.value.toLowerCase() : '';

    const pings = allPings.filter(p => {
        const q = query.replaceAll('@', '');
        if (!q) return true;
        return (
            (p.userTag && p.userTag.toLowerCase().includes(q)) ||
            (p.content && p.content.toLowerCase().includes(q)) ||
            (p.userId && p.userId.includes(q)) ||
            (p.channelId && p.channelId.includes(q)) ||
            (p.channelName && p.channelName.toLowerCase().includes(q))
        );
    });

    list.innerHTML = '';

    if (pings.length === 0) {
        list.innerHTML = '<div style="text-align:center; padding:2rem; color:var(--text-muted);">No ghost pings found for the current filter.</div>';
        return;
    }

    pings.forEach(p => {
        const card = document.createElement('div');
        card.className = 'ghost-ping-card';

        let channelDisplay = p.channelName ? `#${safeHtml(p.channelName)}` : `<span style="opacity:0.6;">${safeHtml(p.channelId)}</span>`;
        let contentDisplay = p.resolvedContent ? safeHtml(p.resolvedContent) : safeHtml(p.content);

        contentDisplay = contentDisplay.replace(/&lt;@!?(\d+)&gt;/g, '<span class="mention-tag">@$1</span>');
        contentDisplay = contentDisplay.replace(/@(\d{17,19})/g, '<span class="mention-tag">@$1</span>');
        contentDisplay = contentDisplay.replace(new RegExp(`@(${p.userTag?.split('#')[0]}|[a-zA-Z0-9_.-]+)`, 'g'), (match) => {
            return `<span class="mention-tag">${match}</span>`;
        });

        let mentionsHtml = '';
        if (p.mentions) {
            let m = p.resolvedMentions ? safeHtml(p.resolvedMentions) : safeHtml(p.mentions);
            m = m.replace(/&lt;@!?(\d+)&gt;/g, '<span class="mention-tag">@$1</span>');
            m = m.replace(/@(\d{17,19})/g, '<span class="mention-tag">@$1</span>');
            m = m.replace(new RegExp(`@([a-zA-Z0-9_.-]+)`, 'g'), `<span class="mention-tag">@$1</span>`);
            mentionsHtml = `<div class="ghost-ping-mentions"><span style="margin-right:5px;">🔔</span> <strong>Pinged:</strong> ${m}</div>`;
        }

        const dateStr = new Date(p.createdAt).toLocaleString();

        const avatarHtml = p.avatarUrl
            ? `<img src="${p.avatarUrl}" class="ghost-ping-avatar" style="object-fit: cover;" alt="Avatar" />`
            : `<div class="ghost-ping-avatar">👤</div>`;

        card.innerHTML = `
            ${avatarHtml}
            <div class="ghost-ping-body">
                <div class="ghost-ping-header">
                    <span class="ghost-ping-username" title="ID: ${p.userId}">${safeHtml(p.userTag || 'Unknown')}</span>
                    <span class="ghost-ping-timestamp">${dateStr}</span>
                    ${p.channelName || p.channelId ? `<span class="ghost-ping-channel-tag">📌 ${channelDisplay}</span>` : ''}
                </div>
                <div class="ghost-ping-content">${contentDisplay}</div>
                ${mentionsHtml}
            </div>
        `;
        list.appendChild(card);
    });
}

async function loadSnipes() {
    try {
        const api = window.api || (window.AdminPanel && window.AdminPanel.api);
        if (!api || typeof api.getJson !== 'function') throw new Error('API client not available');

        const { response, data } = await api.getJson('/api/admin/snipes?limit=100', { cache: 'no-store' });
        if (!response?.ok || !data?.data) throw new Error(data?.error || 'Failed to fetch snipes');

        window._allSnipes = Array.isArray(data.data) ? data.data : [];
        renderSnipeMetrics(window._allSnipes);
        filterSnipes();
    } catch (err) {
        console.error('Failed to load snipes:', err);
        window._allSnipes = [];
        renderSnipeMetrics([]);
        filterSnipes();
        adminShowNotification('Could not load snipe data', 'error');
    }
}

function renderSnipeMetrics(snipes) {
    if (!Array.isArray(snipes)) return;

    const total = snipes.length;
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
    const recent = snipes.filter(s => (now - new Date(s.createdAt).getTime()) < oneDay).length;

    const userCounts = {};
    const channelCounts = {};

    snipes.forEach(s => {
        const u = String(s.userTag || s.userId || 'Unknown');
        const c = String(s.channelName ? `#${s.channelName}` : (s.channelId || 'Unknown'));
        userCounts[u] = (userCounts[u] || 0) + 1;
        channelCounts[c] = (channelCounts[c] || 0) + 1;
    });

    const getTop = (obj) => {
        let topKey = '-';
        let topVal = 0;
        for (const [k, v] of Object.entries(obj)) {
            if (v > topVal) {
                topKey = k;
                topVal = v;
            }
        }
        return topKey;
    };

    const setTxt = (id, txt) => {
        const el = document.getElementById(id);
        if (el) el.textContent = txt;
    };

    setTxt('snipeMetricTotal', total.toLocaleString());
    setTxt('snipeMetric24h', recent.toLocaleString());
    setTxt('snipeMetricTopUser', getTop(userCounts).length > 20 ? getTop(userCounts).substring(0, 18) + '..' : getTop(userCounts));
    setTxt('snipeMetricTopChannel', getTop(channelCounts));
}

function filterSnipes() {
    const tbody = document.getElementById('snipeTableBody');
    if (!tbody) return;

    const allSnipes = window._allSnipes || [];
    const searchInput = document.getElementById('snipeSearchInput');
    const query = searchInput ? searchInput.value.toLowerCase() : '';

    const snipes = allSnipes.filter(s => {
        const q = query.replaceAll('@', '');
        if (!q) return true;
        return (
            (s.userTag && s.userTag.toLowerCase().includes(q)) ||
            (s.content && s.content.toLowerCase().includes(q)) ||
            (s.userId && s.userId.includes(q)) ||
            (s.channelId && s.channelId.includes(q)) ||
            (s.channelName && s.channelName.toLowerCase().includes(q))
        );
    });

    tbody.innerHTML = '';

    if (snipes.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:1rem;">No snipes recorded (or none match filter).</td></tr>';
        return;
    }

    snipes.forEach(s => {
        const tr = document.createElement('tr');
        let channelDisplay = s.channelName ? `#${safeHtml(s.channelName)}` : `<span style="opacity:0.6;">${safeHtml(s.channelId)}</span>`;
        let contentDisplay = safeHtml(s.content);

        contentDisplay = contentDisplay.replace(/&lt;@!?(\d+)&gt;/g, '<span class="mention">@$1</span>');
        contentDisplay = contentDisplay.replace(/@(\d{17,19})/g, '<span class="mention">@$1</span>');

        tr.innerHTML = `
            <td>
                <div>${safeHtml(s.userTag || 'Unknown')}</div>
                <small style="color:#aaa">${s.userId}</small>
            </td>
            <td>
                ${channelDisplay}
                ${s.channelName ? `<br><small style="color:#aaa; font-size:0.7em;">${safeHtml(s.channelId)}</small>` : ''}
            </td>
            <td>
                <div style="max-width:300px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${safeHtml(s.content)}">
                    ${contentDisplay}
                </div>
            </td>
            <td>${new Date(s.createdAt).toLocaleString()}</td>
        `;
        tbody.appendChild(tr);
    });
}


async function loadSuggestions() {
    try {
        const api = window.api || (window.AdminPanel && window.AdminPanel.api);
        if (!api || typeof api.getJson !== 'function') return;

        const { response, data } = await api.getJson('/api/admin/suggestions', { cache: 'no-store' });
        if (!response?.ok || !data?.success) throw new Error(data?.error || 'Failed to fetch suggestions');

        const returnedData = data.data || data.suggestions || [];
        window._allSuggestions = Array.isArray(returnedData) ? returnedData : [];

        filterSuggestions();
    } catch (err) {
        console.error('Failed to load suggestions:', err);
        window._allSuggestions = [];
        filterSuggestions();
        if (typeof adminShowNotification === 'function') {
            adminShowNotification('Could not load suggestions', 'error');
        }
    }
}

function filterSuggestions() {
    const list = document.getElementById('suggestionList');
    if (!list) return;

    const all = window._allSuggestions || [];
    const search = (document.getElementById('suggestionSearchInput')?.value || '').toLowerCase();
    const status = document.getElementById('suggestionStatusFilter')?.value || 'all';

    let total = all.length;
    let pending = 0;
    let approved = 0;
    let denied = 0;

    const filtered = all.filter(s => {
        const sStatus = (s.status || 'pending').toLowerCase();
        if (sStatus === 'pending') pending++;
        else if (sStatus === 'approved') approved++;
        else if (sStatus === 'denied') denied++;

        const matchesSearch = (s.content && s.content.toLowerCase().includes(search)) ||
            (s.username && s.username.toLowerCase().includes(search)) ||
            (s.userId && s.userId.includes(search));
        const matchesStatus = status === 'all' || sStatus === status.toLowerCase();
        return matchesSearch && matchesStatus;
    });

    const tryUpdateCard = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.innerText = val;
    };
    tryUpdateCard('sugMetricTotal', total);
    tryUpdateCard('sugMetricPending', pending);
    tryUpdateCard('sugMetricApproved', approved);
    tryUpdateCard('sugMetricDenied', denied);

    if (filtered.length === 0) {
        list.innerHTML = `
            <div class="appeals-queue-empty" style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; color:#949ba4;">
                <div style="font-size:3rem; margin-bottom:1rem;">📭</div>
                <div style="font-size:1.2rem; font-weight:500; color:#f2f3f5;">No suggestions found</div>
                <div style="margin-top:0.5rem;">Try changing your search or filter criteria.</div>
            </div>`;
        return;
    }

    list.innerHTML = filtered.map(s => {
        const sStatus = (s.status || 'pending').toLowerCase();
        let stText = 'Pending';
        let statusBadgeColor = '#fcee7e';
        let statusBgColor = 'rgba(252, 238, 126, 0.1)';

        if (sStatus === 'approved') {
            stText = 'Approved';
            statusBadgeColor = '#57F287';
            statusBgColor = 'rgba(87, 242, 135, 0.1)';
        } else if (sStatus === 'denied') {
            stText = 'Denied';
            statusBadgeColor = '#ED4245';
            statusBgColor = 'rgba(237, 66, 69, 0.1)';
        }

        const avatarUrl = s.avatarUrl || 'https://cdn.discordapp.com/embed/avatars/0.png';
        const suggestionId = safeJsString(String(s.id || ''));

        return `
            <div class="suggestion-card" onclick="selectSuggestion('${suggestionId}')" style="cursor: pointer; background: #2b2d31; border-radius: 8px; padding: 16px; transition: transform 0.2s, background 0.2s; border: 1px solid #1e1f22; display: flex; flex-direction: column; gap: 12px; margin-bottom: 8px; flex-shrink: 0;" onmouseover="this.style.background='#313338'" onmouseout="this.style.background='#2b2d31'">
                <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                    <div style="display: flex; gap: 12px; align-items: center;">
                        <img src="${avatarUrl}" alt="Avatar" style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover;" onerror="this.src='https://cdn.discordapp.com/embed/avatars/0.png'">
                        <div style="display: flex; flex-direction: column;">
                            <span style="font-weight: 600; color: #f2f3f5; font-size: 1rem;">${safeHtml(s.username || 'Unknown')}</span>
                            <span style="color: #949ba4; font-size: 0.8rem;">${new Date(s.createdAt).toLocaleString()}</span>
                        </div>
                    </div>
                    <div style="display: flex; padding: 4px 10px; border-radius: 12px; background: ${statusBgColor}; color: ${statusBadgeColor}; font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;">
                        ${stText}
                    </div>
                </div>
                <div style="color: #dbdee1; font-size: 0.95rem; line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; text-overflow: ellipsis;">
                    ${safeHtml(s.content)}
                </div>
                <div style="display: flex; gap: 16px; margin-top: auto; padding-top: 12px; border-top: 1px solid #1e1f22;">
                    <span style="display: flex; align-items: center; color: #57F287; font-weight: 600; font-size: 0.85rem;">
                        👍 ${s.upvotes || 0}
                    </span>
                    <span style="display: flex; align-items: center; color: #ED4245; font-weight: 600; font-size: 0.85rem;">
                        👎 ${s.downvotes || 0}
                    </span>
                    <span style="margin-left: auto; color: #949ba4; font-size: 0.75rem;">
                        ID: ${s.id.substring(0, 8)}...
                    </span>
                </div>
            </div>
        `;
    }).join('');
}

function selectSuggestion(id) {
    const s = (window._allSuggestions || []).find(x => x.id === id);
    if (!s) return;

    window._selectedSuggestionId = id;

    const els = {
        user: document.getElementById('detailSuggestionUser'),
        userId: document.getElementById('detailSuggestionUserId'),
        id: document.getElementById('detailSuggestionId'),
        date: document.getElementById('detailSuggestionDate'),
        content: document.getElementById('detailSuggestionContent'),
        avatar: document.getElementById('detailSuggestionAvatar'),
        placeholder: document.getElementById('detailSuggestionAvatarPlaceholder'),
        up: document.getElementById('detailSuggestionUpvotes'),
        down: document.getElementById('detailSuggestionDownvotes'),
        response: document.getElementById('detailSuggestionResponse'),
        responseBlock: document.getElementById('detailSuggestionResponseBlock'),
        status: document.getElementById('detailSuggestionStatus'),
        panel: document.getElementById('suggestionDetailPanel')
    };

    if (els.panel) els.panel.style.display = 'flex';

    if (els.user) els.user.textContent = s.username || 'Unknown';
    if (els.userId) els.userId.textContent = s.userId || '-';
    if (els.id) els.id.textContent = s.id || '-';
    if (els.date) els.date.textContent = new Date(s.createdAt).toLocaleString();
    if (els.content) els.content.innerHTML = safeHtml(s.content).replace(/\n/g, '<br>');
    if (els.up) els.up.innerHTML = `👍 ${s.upvotes || 0}`;
    if (els.down) els.down.innerHTML = `👎 ${s.downvotes || 0}`;

    if (els.avatar && els.placeholder) {
        if (s.avatarUrl) {
            els.avatar.src = s.avatarUrl;
            els.avatar.style.display = 'block';
            els.placeholder.style.display = 'none';
        } else {
            els.avatar.style.display = 'none';
            els.placeholder.style.display = 'flex';
        }
    }

    if (els.status) {
        const sStatus = (s.status || 'pending').toLowerCase();
        let stText = 'PENDING';
        let statusBadgeColor = '#fcee7e';
        let statusBgColor = 'rgba(252, 238, 126, 0.1)';

        if (sStatus === 'approved') {
            stText = 'APPROVED';
            statusBadgeColor = '#57F287';
            statusBgColor = 'rgba(87, 242, 135, 0.1)';
        } else if (sStatus === 'denied') {
            stText = 'DENIED';
            statusBadgeColor = '#ED4245';
            statusBgColor = 'rgba(237, 66, 69, 0.1)';
        }

        els.status.textContent = stText;
        els.status.style.color = statusBadgeColor;
        els.status.style.background = statusBgColor;
        els.status.style.display = 'inline-block';
    }

    if (els.responseBlock && els.response) {
        if (s.response) {
            els.responseBlock.style.display = 'block';
            els.response.textContent = s.response;
        } else {
            els.responseBlock.style.display = 'none';
        }
    }

    const btnApprove = document.getElementById('btnApproveSuggestion');
    const btnDeny = document.getElementById('btnDenySuggestion');

    if (btnApprove && btnDeny) {
        const isPending = (s.status || 'pending').toLowerCase() === 'pending';
        btnApprove.style.display = isPending ? 'block' : 'none';
        btnDeny.style.display = isPending ? 'block' : 'none';

        btnApprove.onclick = () => approveSuggestion(s.id);
        btnDeny.onclick = () => denySuggestion(s.id);
    }
}

async function approveSuggestion(id) {
    const reason = await window.showConfirmModal("Approve Suggestion", "Provide a reason for approval (required):", true, "Enter reason here...");
    if (reason === null || reason === false) return;
    if (!reason.trim()) {
        adminShowNotification('A reason is required to approve a suggestion.', 'error');
        return;
    }

    try {
        const response = await window.fetchWithCsrf(`/api/admin/suggestions/${id}/approve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason })
        });
        const data = await response.json();
        if (data.success) {
            adminShowNotification("Suggestion approved", "success");
            loadSuggestions();
        } else {
            adminShowNotification('Failed: ' + (data.error || 'Unknown error'), 'error');
        }
    } catch (e) {
        console.error(e);
        adminShowNotification('Error approving suggestion: ' + e.message, 'error');
    }
}

async function denySuggestion(id) {
    const reason = await window.showConfirmModal("Deny Suggestion", "Provide a reason for denial (required):", true, "Enter reason here...");
    if (reason === null || reason === false) return;
    if (!reason.trim()) {
        adminShowNotification('A reason is required to deny a suggestion.', 'error');
        return;
    }
    try {
        const response = await window.fetchWithCsrf(`/api/admin/suggestions/${id}/deny`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason })
        });
        const data = await response.json();
        if (data.success) {
            adminShowNotification("Suggestion denied", "success");
            loadSuggestions();
        } else {
            adminShowNotification('Failed: ' + (data.error || 'Unknown error'), 'error');
        }
    } catch (e) {
        console.error(e);
        adminShowNotification('Error denying suggestion: ' + e.message, 'error');
    }
}

async function clearGhostPings() {
    const confirmed = await window.showConfirmModal(
        "Clear Ghost Ping Log",
        "Are you sure you want to clear the full ghost ping log? This action cannot be undone."
    );
    if (!confirmed) return;

    try {
        const response = await window.fetchWithCsrf('/api/admin/clear-ghost-pings', { method: 'POST' });
        const data = await response.json();
        if (response.ok && data.success) {
            loadGhostPings();
            adminShowNotification('Successfully cleared all ghost pings.', 'success');
        } else {
            adminShowNotification('Failed to clear ghost pings.', 'error');
        }
    } catch (error) {
        console.error('Error clearing ghost pings:', error);
        adminShowNotification('Error clearing ghost pings.', 'error');
    }
}

async function clearSnipes() {
    const confirmed = await window.showConfirmModal(
        "Clear Snipe History",
        "Are you sure you want to clear ALL snipe history? This action cannot be undone."
    );
    if (!confirmed) return;

    try {
        const response = await window.fetchWithCsrf('/api/admin/clear-snipes', { method: 'POST' });
        const data = await response.json();
        if (response.ok && data.success) {
            loadSnipes();
            adminShowNotification('Successfully cleared all snipes.', 'success');
        } else {
            adminShowNotification('Failed to clear snipes.', 'error');
        }
    } catch (error) {
        console.error('Error clearing snipes:', error);
        adminShowNotification('Error clearing snipes.', 'error');
    }
}

window.loadSuggestions = loadSuggestions;
window.filterSuggestions = filterSuggestions;
window.selectSuggestion = selectSuggestion;
window.approveSuggestion = approveSuggestion;
window.denySuggestion = denySuggestion;
window.loadGhostPings = loadGhostPings;
window.clearGhostPings = clearGhostPings;
window.filterGhostPings = filterGhostPings;
window.loadSnipes = loadSnipes;
window.clearSnipes = clearSnipes;
window.filterSnipes = filterSnipes;

// Dashboard stats
async function loadDashboardStats() {
    try {
        const api = window.api || (window.AdminPanel && window.AdminPanel.api);
        if (!api) return;

        const { response, data } = await api.getJson('/api/stats');
        if (!response?.ok) return;

        const setVal = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = val;
        };

        setVal('kpiTotalUsers', (data.totalUsers || 0).toLocaleString());
        setVal('kpiActiveTickets', (data.activeTickets || 0).toLocaleString());

        const banned = data.bannedUsers || 0;
        setVal('kpiBannedUsers', banned.toLocaleString());

        const totalWarns = data.totalWarnings || 0;
        setVal('kpiTotalWarns', totalWarns.toLocaleString());

    } catch (err) {
        console.error('Failed to load dashboard stats:', err);
    }
}
window.loadDashboardStats = loadDashboardStats;
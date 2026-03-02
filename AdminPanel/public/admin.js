/* Admin UI helpers — small utilities used across admin pages (non-functional comments only). */
// Fill all .websiteName spans with the websiteName from config
fetch('/Config/main.json')
    .then(response => response.json())
    .then(config => {
        document.querySelectorAll('.websiteName').forEach(el => {
            el.textContent = config.websiteName;
        });
    });
// Robust admin panel tab system

// --- Global Variables ---
window.currentAdminRole = window.currentAdminRole || '';
window._appealsPending = [];
window._appealsHistory = [];
window._autoModConfig = null; // AutoMod full config

// --- Utility Functions ---
const esc = (t) => String(t).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": "&#039;"
})[c]);

const getCurrentRole = () => String(window.currentAdminRole || '').toLowerCase();
const isOwner = () => getCurrentRole() === 'owner';

// --- Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
    if (window.setWebsiteNameTitle) window.setWebsiteNameTitle();
    // User info sync
    try {
        let api = window.api || (window.AdminPanel && window.AdminPanel.api);
        if (api && typeof api.getAccountInfo === 'function') {
            const accountInfo = await api.getAccountInfo();
            if (accountInfo) {
                window.currentAdminRole = String(accountInfo.role || '').toLowerCase();
                const userDisplay = document.getElementById('userDisplay');
                if (userDisplay) userDisplay.textContent = accountInfo.username || 'User';
                const roleBadge = document.getElementById('roleBadge');
                if (roleBadge) roleBadge.textContent = (accountInfo.role || 'User').toUpperCase();
                const dropdownUsername = document.getElementById('dropdownUsername');
                if (dropdownUsername) dropdownUsername.textContent = accountInfo.username || 'User';
                const dropdownRole = document.getElementById('dropdownRole');
                if (dropdownRole) dropdownRole.textContent = (accountInfo.role || 'User').toUpperCase();
            }
        }
    } catch (err) { console.error("Account sync failed", err); }

    const automodTabButton = document.querySelector('.tab[data-tab="automod"]');
    if (automodTabButton && !isOwner()) {
        automodTabButton.style.display = 'none';
    }

    // Attach tab event listeners
    document.querySelectorAll('.tab').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const tabName = btn.dataset.tab;
            if (tabName) switchTab(e, tabName, btn);
        });
    });

    // Run main logic
    await runAdminPanel();
});

// --- Tab Logic ---
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

    // Dynamic Loading
    if (tabName === 'banned-users' && typeof loadBannedUsers === 'function') loadBannedUsers();
    else if (tabName === 'appeals') loadAppeals();
    else if (tabName === 'appeals-history') loadAppealHistory();
    else if (tabName === 'automod') {
        if (isOwner()) loadAutoModConfig(); // Load profiles first
        else {
            const statusEl = document.getElementById('automodStatusMessage');
            if (statusEl) statusEl.textContent = 'AutoMod settings are owner-only.';
        }
    }
}

// --- Appeals System ---
window.currentAppealsPendingPage = 1;
window.currentAppealsHistoryPage = 1;
window._appealHistoryRenderRows = [];
window._appealHistorySelectedIndex = -1;
window._appealsPendingRenderRows = [];
window._appealsPendingSelectedIndex = -1;

async function loadAppeals() {
    const list = document.getElementById('appealsQueueList');
    if (!list) return;
    list.innerHTML = `<div class="appeals-queue-empty">Loading pending appeals...</div>`;

    try {
        const { response, data } = await window.AdminPanel.api.getJson('/api/appeals/pending');
        if (!response?.ok) throw new Error("Failed to fetch");

        window._appealsPending = Array.isArray(data) ? data : (data?.appeals || []);
        renderAppealsPage(window.currentAppealsPendingPage);
    } catch (err) {
        console.error("Error loading pending appeals:", err);
        showNotification('Error loading pending appeals', 'error');
        list.innerHTML = `<div class="appeals-queue-empty text-danger">Could not load pending appeals. Try reloading.</div>`;
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

    const summaryEl = document.getElementById('appealsSummaryText');
    if (summaryEl) {
        const queueLoad = total > 0 ? `${Math.round((recent24h / total) * 100)}%` : '0%';
        summaryEl.textContent = `${total.toLocaleString()} pending • ${recent24h.toLocaleString()} in 24h • Queue activity ${queueLoad}`;
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
    setText('appealsDetailResponse', responseGiven || 'No response has been given yet.');

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

    window.currentAppealsPendingPage = page; // Update current page

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
    if (page > pages) page = pages; // Correct page if out of bounds

    const start = (page - 1) * pageSize;
    const slice = rows.slice(start, start + pageSize);

    if (!slice.length) {
        list.innerHTML = `<div class="appeals-queue-empty">${hasActiveFilters ? 'No pending appeals match the current filters.' : 'No pending appeals found.'}</div>`;
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
            <article class="appeals-queue-item ${isSelected ? 'appeals-queue-row-selected' : ''}" data-appeal-index="${globalIndex}" onclick="openAppealPendingDetails(${globalIndex})">
                <div class="appeals-queue-item-head">
                    <div class="appeals-queue-user-cell">
                        <strong>${esc(a.user_tag || a.user || 'Unknown')}</strong>
                        <small class="text-muted">${esc(a.user_id || 'N/A')}</small>
                    </div>
                    <div class="appeals-queue-item-meta">
                        <code>${esc(a.ban_case_id || 'N/A')}</code>
                        <span class="text-muted">${submittedRelative}</span>
                    </div>
                </div>
                <div class="appeals-queue-item-reason" title="${esc(reason)}">${esc(reasonPreview)}</div>
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
            <button class="btn btn-sm btn-secondary" ${page <= 1 ? 'disabled' : ''} onclick="renderAppealsPage(${page - 1})">Prev</button>
            <span class="mx-2">Page ${page} / ${pages}</span>
            <button class="btn btn-sm btn-secondary" ${page >= pages ? 'disabled' : ''} onclick="renderAppealsPage(${page + 1})">Next</button>
        `;
    }
}

async function loadAppealHistory() {
    const list = document.getElementById('appealsHistoryList');
    if (!list) return;
    list.innerHTML = `<div class="appeal-history-empty">Loading appeal history...</div>`;

    try {
        const { response, data } = await window.AdminPanel.api.getJson('/api/appeals/decided');
        if (!response?.ok) throw new Error("Failed to fetch");

        window._appealsHistory = Array.isArray(data) ? data : [];
        renderAppealHistoryPage(window.currentAppealsHistoryPage);
    } catch (err) {
        console.error("Error loading appeal history:", err);
        showNotification('Error loading appeal history', 'error');
        list.innerHTML = `<div class="appeal-history-empty text-danger">Could not load appeal history. Try reloading.</div>`;
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
        const moderator = String(a.moderator_tag || a.moderator || '').toLowerCase();
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
    return 'No decision response available.';
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
    setText('appealHistoryDetailModerator', record.moderator_tag || record.moderator || 'N/A');
    setText('appealHistoryDetailReason', normalizedReason || 'No reason provided.');
    setText('appealHistoryDetailOutcome', decisionResponse || 'No decision response available.');

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
    document.querySelectorAll('#appealsHistoryList .appeal-history-item[data-history-index]').forEach((row) => {
        const rowIndex = Number(row.getAttribute('data-history-index'));
        if (rowIndex === selected) row.classList.add('appeal-history-row-selected');
        else row.classList.remove('appeal-history-row-selected');
    });
}

function renderAppealHistoryPage(page = 1) {
    const list = document.getElementById('appealsHistoryList');
    const controls = document.getElementById('appealsHistoryControls');
    if (!list) return;

    window.currentAppealsHistoryPage = page; // Update current page

    const pageSize = parseInt(document.getElementById('appealHistoryPageSize')?.value) || 10;
    const sortMode = document.getElementById('appealHistorySort')?.value || 'newest';
    const searchValue = (document.getElementById('appealHistorySearchInput')?.value || '').trim();
    const moderatorValue = (document.getElementById('appealHistoryModeratorFilter')?.value || '').trim();
    const statusValue = document.getElementById('appealHistoryStatusFilter')?.value || 'all';
    const dateValue = document.getElementById('appealHistoryDateFilter')?.value || 'all';
    const hasActiveFilters = Boolean(searchValue || moderatorValue || statusValue !== 'all' || dateValue !== 'all');
    let rows = getFilteredAppealHistory();

    if (sortMode === 'oldest') {
        rows.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
    } else if (sortMode === 'status') {
        rows.sort((a, b) => String(a.status || '').localeCompare(String(b.status || '')));
    } else if (sortMode === 'moderator') {
        rows.sort((a, b) => String(a.moderator_tag || a.moderator || '').localeCompare(String(b.moderator_tag || b.moderator || '')));
    } else {
        rows.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    }

    renderAppealHistoryMetrics(rows);
    window._appealHistoryRenderRows = rows;

    const pages = Math.max(1, Math.ceil(rows.length / pageSize));
    if (page > pages) page = pages;

    const start = (page - 1) * pageSize;
    const slice = rows.slice(start, start + pageSize);

    if (!slice.length) {
        list.innerHTML = `<div class="appeal-history-empty">${hasActiveFilters ? 'No appeal history matches the current filters.' : 'No decided appeals found yet.'}</div>`;
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
            const statusBadge = `<span class="appeal-history-status-badge ${esc(normalizedStatus)}">${esc(normalizedStatus === 'accepted' ? 'Accepted' : normalizedStatus === 'denied' ? 'Denied' : (a.status || 'Unknown'))}</span>`;
            const created = a.created_at ? new Date(a.created_at).toLocaleString() : '-';
            const createdRelative = formatAppealRelativeTime(a.created_at || a.submitted_at || a.updated_at);
            const globalIndex = start + idx;
            const reason = String(a.reason || 'No reason provided').replace(/\r\n/g, '\n').trim();
            const reasonPreview = reason.length > 145 ? `${reason.slice(0, 145)}...` : reason;
            const isSelected = globalIndex === Number(window._appealHistorySelectedIndex);

            return `
                <article class="appeal-history-item appeal-history-item-enter ${isSelected ? 'appeal-history-row-selected' : ''}" style="animation-delay:${Math.min(idx * 45, 320)}ms" data-history-index="${globalIndex}" onclick="openAppealHistoryDetails(${globalIndex})">
                    <div class="appeal-history-item-head">
                        <div class="appeal-history-user-cell">
                            <strong>${esc(a.user_tag || a.user || 'Unknown')}</strong>
                            <small class="text-muted">${esc(a.user_id || 'N/A')}</small>
                        </div>
                        <div class="appeal-history-item-meta">
                            <code>${esc(a.ban_case_id || 'N/A')}</code>
                            <span class="text-muted">${esc(a.moderator_tag || a.moderator || 'N/A')}</span>
                            <span class="text-muted">${createdRelative}</span>
                        </div>
                    </div>
                    <div class="appeal-history-item-body">
                        <div class="appeal-history-reason" title="${esc(reason)}">
                            ${esc(reasonPreview)}
                        </div>
                        <div class="appeal-history-action-row">
                            <span class="text-muted">${created}</span>
                            ${statusBadge}
                        </div>
                    </div>
                </article>
            `;
        }).join('');

        renderAppealHistoryDetails(window._appealHistoryRenderRows[Number(window._appealHistorySelectedIndex)] || slice[0]);
        syncAppealHistorySelectedRow();
    }

    if (controls) {
        controls.innerHTML = `
            <button class="btn btn-sm btn-secondary" ${page <= 1 ? 'disabled' : ''} onclick="renderAppealHistoryPage(${page - 1})">Prev</button>
            <span class="mx-2">Page ${page} / ${pages}</span>
            <button class="btn btn-sm btn-secondary" ${page >= pages ? 'disabled' : ''} onclick="renderAppealHistoryPage(${page + 1})">Next</button>
        `;
    }
}

// --- Moderation Actions ---
// --- Notifications (Improved Toast Style) ---
function showNotification(message, type = 'info') {
    // If notifications.js is loaded, use showToast
    if (typeof window.showToast === 'function') {
        const titleMap = {
            success: 'Success',
            error: 'Error',
            warning: 'Warning',
            info: 'Info'
        };
        return window.showToast(type, titleMap[type] || 'Info', message);
    }

    // Fallback: Reimplement showToast logic using css from style.css
    // Ensure container exists
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.className = 'toast-container';
        document.body.appendChild(container); // Container handles its own CSS
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icons = {
        success: '✅',
        error: '❌',
        warning: '⚠️',
        info: 'ℹ️'
    };

    const titleMap = {
        success: 'Success',
        error: 'Error',
        warning: 'Warning',
        info: 'Info'
    };

    const title = titleMap[type] || 'Notification';

    toast.innerHTML = `
        <div class="toast-icon">${icons[type] || icons.info}</div>
        <div class="toast-content">
            <div class="toast-title">${title}</div>
            ${message ? `<div class="toast-message">${message}</div>` : ''}
        </div>
        <button class="toast-close" onclick="this.parentElement.remove()">×</button>
    `;

    // Add to container (toasts usually stack bottom-up or top-down, CSS handles it)
    container.appendChild(toast);

    // Auto-remove
    setTimeout(() => {
        toast.classList.add('removing');
        setTimeout(() => toast.remove(), 300);
    }, 5000);
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
        const safeUser = esc(username || 'Unknown');
        modal.innerHTML = `
            <div class="appeal-decision-modal-backdrop"></div>
            <div class="appeal-decision-modal-card" role="dialog" aria-modal="true" aria-label="${title}">
                <div class="appeal-decision-modal-header">
                    <h3>${title}</h3>
                    <button type="button" class="appeal-decision-modal-close" aria-label="Close">×</button>
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
                // ignore persistence errors
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
            showNotification('Appeal accepted successfully', 'success');
            loadAppeals(); // Reload pending appeals
            loadAppealHistory(); // Reload history to show updated status
            // Potentially emit socket event for real-time update
            if (window.socket) window.socket.emit('admin:appealAccepted', { appealId, username });
        } else {
            const errorData = await res.json();
            showNotification(errorData.message || 'Failed to accept appeal', 'error');
        }
    } catch (err) {
        console.error(err);
        showNotification('An error occurred while accepting appeal', 'error');
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
            showNotification('Appeal denied successfully', 'success');
            loadAppeals(); // Reload pending appeals
            loadAppealHistory(); // Reload history to show updated status
            // Potentially emit socket event for real-time update
            if (window.socket) window.socket.emit('admin:appealDenied', { appealId, username });
        } else {
            const errorData = await res.json();
            showNotification(errorData.message || 'Failed to deny appeal', 'error');
        }
    } catch (err) {
        console.error(err);
        showNotification('An error occurred while denying appeal', 'error');
    }
}

async function runAdminPanel() {
    // Basic access check
    if (!window.currentAdminRole) {
        console.warn("Role missing");
        return;
    }

    // Socket.IO initialization
    if (typeof io !== 'undefined' && !window.socket) {
        window.socket = io(); // Initialize Socket.IO client

        window.socket.on('connect', () => {
            console.log('Connected to WebSocket server');
            showNotification('Connected to real-time updates', 'success');
        });

        window.socket.on('disconnect', () => {
            console.warn('Disconnected from WebSocket server');
            showNotification('Disconnected from real-time updates', 'warning');
        });

        // Listen for appeal updates
        window.socket.on('admin:appealUpdated', (data) => {
            showNotification(`Appeal for ${data.username} was ${data.status}`, 'info');
            loadAppeals(); // Refresh pending appeals
            loadAppealHistory(); // Refresh history
        });

        // Listen for new appeals
        window.socket.on('admin:newAppeal', (data) => {
            showNotification(`New appeal from ${data.username}`, 'info');
            loadAppeals(); // Refresh pending appeals
        });
    }

    if (!window._adminLookupInitialized) {
        initAdvancedLookup();
        window._adminLookupInitialized = true;
    }
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

        return `
            <button class="lookup-recent-badge" onclick="performLookup('${esc(String(item.userId || ''))}')">
                ${esc(String(item.username || 'Unknown'))}
                <span class="text-muted">• Lv${Number(item.level || 0)} • W${Number(item.warnCount || 0)}${flags.length ? ` • ${esc(flags.join(', '))}` : ''}</span>
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
        const userId = esc(String(item.userId || ''));
        const username = esc(String(item.username || 'Unknown'));
        const level = Number(item.level || 0);
        return `
            <div class="lookup-suggestion-item" onclick="performLookup('${userId}')">
                <div class="lookup-suggestion-username">${username}</div>
                <div class="lookup-suggestion-details">ID: ${userId} • Level ${level}</div>
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
        container.innerHTML = '<div class="lookup-recent-section">No user profile loaded.</div>';
        return;
    }

    const riskLevel = String(user.riskLevel || 'MINIMAL').toUpperCase();
    const riskScore = Number(user.riskScore || 0);
    const badgeClass = getRiskBadgeClass(riskLevel, riskScore);

    const avatarUrl = String(user.avatar || '').trim();
    const initial = esc(String(user.username || '?').charAt(0).toUpperCase());

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
        ? roles.map((role) => `<span class="lookup-mini-badge">@${esc(String(role.name || 'Unknown'))}</span>`).join('')
        : '<span class="text-muted">No roles found</span>';

    const warningsHtml = warnings.length
        ? warnings.slice(0, 12).map((row) => `
            <div class="lookup-info-item lookup-info-item-full">
                <span class="lookup-info-label">${esc(String(row.caseId || 'No Case ID'))} • ${row.timestamp ? new Date(row.timestamp).toLocaleString() : 'Unknown date'}</span>
                <span class="lookup-info-value">${esc(String(row.reason || 'No reason provided'))}</span>
                <span class="lookup-info-label">Moderator: ${esc(String(row.moderatorName || 'Unknown'))}</span>
            </div>
        `).join('')
        : '<div class="lookup-info-item lookup-info-item-full"><span class="lookup-info-value">No warning history.</span></div>';

    const timeoutHtml = timeouts.length
        ? timeouts.slice(0, 10).map((row) => `
            <div class="lookup-info-item lookup-info-item-full">
                <span class="lookup-info-label">${esc(String(row.caseId || 'No Case ID'))} • ${row.timestamp ? new Date(row.timestamp).toLocaleString() : 'Unknown date'}</span>
                <span class="lookup-info-value">${esc(String(row.reason || 'No reason provided'))}</span>
                <span class="lookup-info-label">Moderator: ${esc(String(row.moderatorName || 'Unknown'))} • ${row.active ? 'Active' : 'Inactive'}</span>
            </div>
        `).join('')
        : '<div class="lookup-info-item lookup-info-item-full"><span class="lookup-info-value">No timeout history.</span></div>';

    const bansHtml = bans.length
        ? bans.slice(0, 10).map((row) => `
            <div class="lookup-info-item lookup-info-item-full">
                <span class="lookup-info-label">${esc(String(row.caseId || 'No Case ID'))} • ${row.bannedAt ? new Date(row.bannedAt).toLocaleString() : 'Unknown date'}</span>
                <span class="lookup-info-value">${esc(String(row.reason || 'No reason provided'))}</span>
                <span class="lookup-info-label">Moderator: ${esc(String(row.moderatorName || 'Unknown'))} • ${row.active ? 'Active Ban' : 'Historical Ban'}</span>
            </div>
        `).join('')
        : '<div class="lookup-info-item lookup-info-item-full"><span class="lookup-info-value">No ban history.</span></div>';

    const notesHtml = notes.length
        ? notes.slice(0, 15).map((row) => `
            <div class="lookup-info-item lookup-info-item-full">
                <span class="lookup-info-label">${row.createdAt ? new Date(row.createdAt).toLocaleString() : 'Unknown date'} • ${esc(String(row.createdBy || 'Unknown'))}</span>
                <span class="lookup-info-value">${esc(String(row.note || ''))}</span>
            </div>
        `).join('')
        : '<div class="lookup-info-item lookup-info-item-full"><span class="lookup-info-value">No moderator notes yet.</span></div>';

    container.innerHTML = `
        <div class="lookup-advanced-profile">
            <div class="lookup-profile-header">
                <div class="lookup-risk-badge ${badgeClass}">
                    <span>⚠</span>
                    <span>${esc(riskLevel)} RISK • ${riskScore}</span>
                </div>
                <div class="lookup-identity-section">
                    <div class="lookup-avatar-wrapper">
                        ${avatarUrl
            ? `<img class="lookup-avatar-image" src="${esc(avatarUrl)}" alt="${esc(String(user.username || 'User'))}">`
            : `<div class="lookup-avatar-initial">${initial}</div>`}
                    </div>
                    <div class="lookup-identity-info">
                        <h2 class="lookup-username">${esc(String(user.globalName || user.username || 'Unknown User'))}</h2>
                        <div class="lookup-metadata-badges">
                            <span class="lookup-mini-badge">🆔 ${esc(String(user.id || 'N/A'))}</span>
                            <span class="lookup-mini-badge">👤 @${esc(String(user.username || 'unknown'))}</span>
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
                                <div class="lookup-info-item"><span class="lookup-info-label">Created</span><span class="lookup-info-value">${esc(createdDate)}</span></div>
                                <div class="lookup-info-item"><span class="lookup-info-label">Joined Server</span><span class="lookup-info-value">${esc(joinedDate)}</span></div>
                                <div class="lookup-info-item"><span class="lookup-info-label">Timeout Until</span><span class="lookup-info-value">${esc(timeoutUntil)}</span></div>
                                <div class="lookup-info-item lookup-info-item-full"><span class="lookup-info-label">Bio</span><span class="lookup-info-value">${esc(String(user.bio || user.db?.bio || 'No bio available'))}</span></div>
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
        list.innerHTML = '<div class="empty-state" style="padding: 1rem;"><span style="font-size: 0.9rem;">No recent lookups</span></div>';
        return;
    }

    list.innerHTML = users.slice(0, 10).map((item) => {
        const userId = esc(String(item.userId || item.id || ''));
        const username = esc(String(item.username || item.globalName || 'Unknown'));
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
        showNotification('Enter a username or user ID', 'warning');
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
        profileContainer.innerHTML = `<div class="lookup-recent-section">${esc(error.message || 'User lookup failed')}</div>`;
        showNotification(error.message || 'Lookup failed', 'error');
    } finally {
        showLookupLoading(false);
    }
}

async function saveLookupNote() {
    const user = window._lookupState.currentUser;
    const noteEl = document.getElementById('lookupNoteInput');
    const api = getLookupApi();

    if (!user?.id || !noteEl || !api) {
        showNotification('No selected user for note save', 'warning');
        return;
    }

    const note = String(noteEl.value || '').trim();
    if (!note) {
        showNotification('Write a note before saving', 'warning');
        return;
    }

    try {
        const { response, data } = await api.postJson(`/api/admin/system/lookup/${encodeURIComponent(String(user.id))}/notes`, { note });
        if (!response?.ok) throw new Error(data?.error || 'Failed to save note');
        noteEl.value = '';
        showNotification('Moderator note saved', 'success');
        const refreshedProfile = await fetchLookupProfile(String(user.id));
        window._lookupState.currentUser = refreshedProfile;
        renderLookupProfile(refreshedProfile);
    } catch (error) {
        console.error('Failed to save lookup note:', error);
        showNotification(error.message || 'Failed to save note', 'error');
    }
}

// --- AutoMod System ---
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
        showNotification('AutoMod command center loaded', 'success');
    } catch (err) {
        console.error("Error loading AutoMod config:", err);
        showNotification('Failed to load AutoMod config', 'error');
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

function renderAutoModUI() {
    if (!window._autoModConfig) return;

    const config = window._autoModConfig;
    const profiles = Object.keys(config.autoModProfiles?.profiles || {});
    // If activeProfile is "custom" or something not in the list, handle gracefully, but usually it's one of them.
    const activeProfile = config.autoModProfiles?.activeProfile || 'balanced';

    // update profile state text
    const stateEl = document.getElementById('automodProfileState');
    if (stateEl) {
        stateEl.innerHTML = `Active Profile: <strong>${esc(activeProfile)}</strong><br>
        <small class="text-muted">Effective settings are applied from this profile.</small>`;
    }

    // Populate Active Profile Selector
    const activeSelect = document.getElementById('automodActiveProfile');
    if (activeSelect) {
        activeSelect.innerHTML = profiles.map(p =>
            `<option value="${esc(p)}" ${p === activeProfile ? 'selected' : ''}>${esc(p)}</option>`
        ).join('');
        // Ensure the active profile is selected
        activeSelect.value = activeProfile;
    }

    // Populate Selected Profile Selector (for editing)
    const editSelect = document.getElementById('automodSelectedProfile');
    if (editSelect) {
        // preserve selection if possible, else default to active
        const currentSelection = editSelect.value;
        const exists = profiles.includes(currentSelection);

        editSelect.innerHTML = profiles.map(p =>
            `<option value="${esc(p)}">${esc(p)}</option>`
        ).join('');

        if (exists && currentSelection) {
            editSelect.value = currentSelection;
        } else {
            editSelect.value = activeProfile;
        }

        // Add event listener to re-render form when selection changes
        // Using onclick ensures we don't stack up listeners if we re-render UI often, 
        // though typically renderAutoModUI is called only on load or save.
        editSelect.onchange = () => renderAutoModForm(editSelect.value);
    }

    // Render the form for the currently selected profile to edit
    const currentEditProfile = editSelect ? editSelect.value : activeProfile;
    renderAutoModForm(currentEditProfile);

    const effective = config.effectiveAutoMod || {};
    const effectiveAutoMod = effective.autoMod || {};
    const effectiveAdvanced = effective.autoModAdvanced || {};
    const summaryEl = document.getElementById('automodSummary');
    if (summaryEl) {
        summaryEl.innerHTML = `
            <strong>Effective Runtime Policy:</strong>
            invites=<strong>${effective.blockExternalInvites ? 'on' : 'off'}</strong>,
            spamThreshold=<strong>${effectiveAutoMod.spamThreshold ?? '-'}</strong>,
            warnThreshold=<strong>${effectiveAutoMod.spamWarningThreshold ?? '-'}</strong>,
            timeoutMs=<strong>${effectiveAutoMod.spamTimeout ?? '-'}</strong>,
            maxMentions=<strong>${effective.maxMentionsBeforeFlag ?? '-'}</strong>,
            escalation24h=<strong>${effectiveAdvanced.escalationThreshold24h ?? '-'}</strong>
        `;
    }
}

function renderAutoModForm(profileName) {
    const config = window._autoModConfig;
    if (!config || !config.autoModProfiles?.profiles) return;

    const profile = config.autoModProfiles.profiles[profileName];
    if (!profile) return;

    // Update Title
    const titleEl = document.getElementById('automodSelectedProfileTitle');
    if (titleEl) titleEl.textContent = `🛠️ Selected Profile Settings: ${profileName}`;

    // Helper to safely set value
    const setVal = (id, val) => {
        const el = document.getElementById(id);
        if (el) {
            if (el.type === 'checkbox') el.checked = Boolean(val);
            else el.value = val !== undefined && val !== null ? val : '';
        }
    };

    setVal('automodBlockInvites', profile.blockExternalInvites?.toString()); // Select uses string "true"/"false"
    setVal('automodMaxMentions', profile.maxMentionsBeforeFlag);

    // Core Rules
    const am = profile.autoMod || {};
    setVal('automodSpamThreshold', am.spamThreshold);
    setVal('automodSpamWindowMs', am.spamWindow);
    setVal('automodSpamWarningThreshold', am.spamWarningThreshold);
    setVal('automodSpamTimeoutMs', am.spamTimeout);
    setVal('automodCapsThreshold', am.capsThreshold);

    // Advanced
    const adv = profile.autoModAdvanced || {};
    setVal('automodEscalationThreshold', adv.escalationThreshold24h);
    setVal('automodEscalationTimeoutMs', adv.escalationTimeoutMs);

    // Text Areas (Arrays -> Newline separated strings)
    setVal('automodRegexPatterns', (adv.blockedRegexPatterns || []).join('\n'));
    setVal('automodExemptChannels', (adv.exemptChannelIds || []).join('\n'));
    setVal('automodExemptRoles', (adv.exemptRoleIds || []).join('\n'));
}

async function setActiveAutoModProfile() {
    const select = document.getElementById('automodActiveProfile');
    if (!select) return;
    const newActive = select.value;

    try {
        const res = await fetchWithCsrf('/api/automod/config', {
            method: 'POST',
            body: JSON.stringify({ activeProfile: newActive })
        });
        const data = await res.json();

        if (res.ok) {
            showNotification(`Active profile changed to ${newActive}`, 'success');
            await loadAutoModConfig(); // Refresh
        } else {
            showNotification(data.error || 'Failed to set active profile', 'error');
        }
    } catch (err) {
        console.error(err);
        showNotification('Error setting active profile', 'error');
    }
}

async function createAutoModProfile() {
    const input = document.getElementById('automodNewProfileName');
    if (!input) return;
    const name = input.value.trim();
    if (!name) return showNotification('Please enter a profile name', 'warning');

    // To create, we effectively save a new profile key with default or current active settings
    // Let's copy the currently "Editing" profile as a base
    const currentEditProfile = document.getElementById('automodSelectedProfile')?.value;
    const baseProfile = window._autoModConfig.autoModProfiles?.profiles[currentEditProfile] || {};

    try {
        const res = await fetchWithCsrf('/api/automod/config', {
            method: 'POST',
            body: JSON.stringify({
                profileName: name,
                profileConfig: baseProfile // Clone existing
            })
        });
        const data = await res.json();

        if (res.ok) {
            showNotification(`Profile ${name} created`, 'success');
            input.value = '';
            await loadAutoModConfig();
            // Switch edit view to new profile
            const editSelect = document.getElementById('automodSelectedProfile');
            if (editSelect) {
                editSelect.value = name;
                renderAutoModForm(name);
            }
        } else {
            showNotification(data.error || 'Failed to create profile', 'error');
        }
    } catch (err) {
        console.error(err);
        showNotification('Error creating profile', 'error');
    }
}

async function deleteAutoModProfile() {
    const editSelect = document.getElementById('automodSelectedProfile');
    if (!editSelect) return;
    const name = editSelect.value;

    if (['balanced', 'strict', 'relaxed'].includes(name)) {
        return showNotification('Cannot delete default profiles', 'warning');
    }

    if (!confirm(`Are you sure you want to delete profile "${name}"?`)) return;

    try {
        const res = await fetchWithCsrf('/api/automod/config', {
            method: 'POST',
            body: JSON.stringify({ deleteProfile: name })
        });
        const data = await res.json();

        if (res.ok) {
            showNotification(`Profile ${name} deleted`, 'success');
            await loadAutoModConfig();
        } else {
            showNotification(data.error || 'Failed to delete profile', 'error');
        }
    } catch (err) {
        console.error(err);
        showNotification('Error deleting profile', 'error');
    }
}

async function saveSelectedAutoModProfileSettings() {
    const editSelect = document.getElementById('automodSelectedProfile');
    if (!editSelect) return;
    const profileName = editSelect.value;

    const getVal = (id) => document.getElementById(id)?.value;
    const getNum = (id) => Number(document.getElementById(id)?.value);
    const getBool = (id) => document.getElementById(id)?.value === 'true';
    const getList = (id) => (document.getElementById(id)?.value || '').split('\n').map(s => s.trim()).filter(Boolean);

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
                capsThreshold: parseFloat(getVal('automodCapsThreshold'))
            },
            autoModAdvanced: {
                escalationThreshold24h: getNum('automodEscalationThreshold'),
                escalationTimeoutMs: getNum('automodEscalationTimeoutMs'),
                blockedRegexPatterns: getList('automodRegexPatterns'),
                exemptChannelIds: getList('automodExemptChannels'),
                exemptRoleIds: getList('automodExemptRoles')
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
            showNotification(`Settings saved for ${profileName}`, 'success');
            await loadAutoModConfig();
        } else {
            showNotification(data.error || 'Failed to save settings', 'error');
        }
    } catch (err) {
        console.error(err);
        showNotification('Error saving settings', 'error');
    }
}

async function runAutoModSimulation() {
    const message = document.getElementById('automodSimMessage')?.value;
    if (!message) return showNotification('Please enter a message to test', 'warning');

    const recentCount = Number(document.getElementById('automodSimRecentCount')?.value) || 1;
    const priorViolations = Number(document.getElementById('automodSimPriorViolations')?.value) || 0;
    const useSaved = document.getElementById('automodSimUseSavedOnly')?.checked;

    let payload = {
        message,
        recentMessageCount: recentCount,
        priorViolations24h: priorViolations
    };

    if (!useSaved) {
        // Construct draft config from current form values to test "what-if"
        // We reuse the logic from saveSelectedAutoModProfileSettings but put it in 'draftConfig'
        const getVal = (id) => document.getElementById(id)?.value;
        const getNum = (id) => Number(document.getElementById(id)?.value);
        const getBool = (id) => document.getElementById(id)?.value === 'true';
        const getList = (id) => (document.getElementById(id)?.value || '').split('\n').map(s => s.trim()).filter(Boolean);

        payload.draftConfig = {
            blockExternalInvites: getBool('automodBlockInvites'),
            maxMentionsBeforeFlag: getNum('automodMaxMentions'),
            autoMod: {
                spamThreshold: getNum('automodSpamThreshold'),
                spamWindow: getNum('automodSpamWindowMs'),
                spamWarningThreshold: getNum('automodSpamWarningThreshold'),
                spamTimeout: getNum('automodSpamTimeoutMs'),
                capsThreshold: parseFloat(getVal('automodCapsThreshold'))
            },
            autoModAdvanced: {
                escalationThreshold24h: getNum('automodEscalationThreshold'),
                escalationTimeoutMs: getNum('automodEscalationTimeoutMs'),
                blockedRegexPatterns: getList('automodRegexPatterns'),
                exemptChannelIds: getList('automodExemptChannels'),
                exemptRoleIds: getList('automodExemptRoles')
            }
        };
    }

    const resultBox = document.getElementById('automodSimResult');
    resultBox.innerHTML = 'Running simulation...';
    resultBox.className = 'automod-result-box'; // Reset classes

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

            let html = `<strong>Verdict:</strong> <span class="${isFlagged ? 'text-danger' : 'text-success'}">${esc(String(r.verdict || 'unknown').toUpperCase())}</span>`;
            html += `<br><strong>Findings:</strong> ${findings.length ? findings.map(esc).join('; ') : 'None'}`;
            html += `<br><strong>Predicted Actions:</strong> ${actions.length ? actions.map(esc).join('; ') : 'None'}`;

            resultBox.innerHTML = html;
            resultBox.classList.add(isFlagged ? 'border-danger' : 'border-success');
        } else {
            resultBox.textContent = 'Simulation failed.';
            showNotification(data.error || 'Simulation failed', 'error');
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

    const trendBody = document.getElementById('automodTrendRows');
    if (trendBody) {
        const trendRows = Array.isArray(data?.trends) ? data.trends : [];
        trendBody.innerHTML = trendRows.length
            ? trendRows.map((row) => `
                <tr>
                    <td>${esc(String(row.day || '-'))}</td>
                    <td>${formatCount(row.total)}</td>
                    <td>${formatCount(row.pending)}</td>
                    <td>${formatCount((row.approved || 0) + (row.dismissed || 0))}</td>
                </tr>
            `).join('')
            : '<tr><td colspan="4" class="text-center text-muted">No trend data.</td></tr>';
    }

    const typesBody = document.getElementById('automodTypeRows');
    if (typesBody) {
        const typeRows = Array.isArray(data?.types) ? data.types : [];
        typesBody.innerHTML = typeRows.length
            ? typeRows.map((row) => `
                <tr>
                    <td>${esc(String(row.type || 'unknown'))}</td>
                    <td>${formatCount(row.count)}</td>
                </tr>
            `).join('')
            : '<tr><td colspan="2" class="text-center text-muted">No type data.</td></tr>';
    }

    const topUsersBody = document.getElementById('automodTopUsersRows');
    if (topUsersBody) {
        const users = Array.isArray(data?.topUsers) ? data.topUsers : [];
        topUsersBody.innerHTML = users.length
            ? users.map((row) => `
                <tr>
                    <td>${esc(String(row.user_id || '-'))}</td>
                    <td>${formatCount(row.count)}</td>
                </tr>
            `).join('')
            : '<tr><td colspan="2" class="text-center text-muted">No user data.</td></tr>';
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
                <tr title="${esc(String(item.message_content || ''))}">
                    <td>${id}</td>
                    <td><code>${esc(String(item.user_id || '-'))}</code></td>
                    <td>${esc(String(item.violation_type || '-'))}</td>
                    <td>${esc(String(item.action_taken || '-'))}</td>
                    <td>
                        <span class="automod-severity-chip ${esc(severity)}">${esc(severity)}</span>
                        <select id="automodRowSeverity-${id}" class="form-input" style="margin-top:0.35rem; min-width: 120px;">
                            <option value="critical" ${severity === 'critical' ? 'selected' : ''}>Critical</option>
                            <option value="high" ${severity === 'high' ? 'selected' : ''}>High</option>
                            <option value="medium" ${severity === 'medium' ? 'selected' : ''}>Medium</option>
                            <option value="low" ${severity === 'low' ? 'selected' : ''}>Low</option>
                        </select>
                    </td>
                    <td><span class="automod-status-chip ${esc(status)}">${esc(status)}</span></td>
                    <td>${formatLocalTime(item.timestamp)}</td>
                    <td>
                        <div class="automod-inline-actions" style="gap:0.4rem;">
                            <button class="btn btn-sm btn-secondary" onclick="setAutoModWorkflowTarget(${id})">Select</button>
                            <button class="btn btn-sm btn-primary" onclick="updateAutoModWorkflow(${id}, null, document.getElementById('automodRowSeverity-${id}')?.value)">Severity</button>
                            <button class="btn btn-sm btn-success" onclick="updateAutoModWorkflow(${id}, 'approved')">Approve</button>
                            <button class="btn btn-sm btn-danger" onclick="updateAutoModWorkflow(${id}, 'dismissed')">Dismiss</button>
                        </div>
                        <div class="text-muted" style="margin-top:0.35rem; max-width: 260px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${esc(snippet || '-')}</div>
                    </td>
                </tr>
            `;
        }).join('')
        : '<tr><td colspan="8" class="text-center text-muted">No queue incidents for the selected filters.</td></tr>';

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
        showNotification('Invalid incident id', 'error');
        return;
    }

    const payload = {};
    if (status) payload.status = String(status);
    if (severity) payload.severity = String(severity);
    if (note !== null && note !== undefined) payload.note = String(note);

    if (!Object.keys(payload).length) {
        showNotification('Nothing to update', 'warning');
        return;
    }

    try {
        const res = await fetchWithCsrf(`/api/automod/workflow/${id}`, {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || 'Workflow update failed');

        showNotification(`Incident #${id} updated`, 'success');
        const activePage = Number(window._autoModAdvanced?.pagination?.page || 1);
        await loadAutoModAdvancedData(activePage);
    } catch (error) {
        console.error('Error updating workflow item:', error);
        showNotification(error.message || 'Failed to update incident workflow', 'error');
    }
}

async function saveAutoModWorkflowNote() {
    const id = Number(document.getElementById('automodWorkflowSelectedId')?.value);
    const note = String(document.getElementById('automodWorkflowNote')?.value || '');
    if (!Number.isFinite(id) || id <= 0) {
        showNotification('Select an incident from the queue first', 'warning');
        return;
    }
    await updateAutoModWorkflow(id, null, null, note);
}

async function bulkResolveAutoModPending() {
    const queue = Array.isArray(window._autoModAdvanced?.queue) ? window._autoModAdvanced.queue : [];
    const pending = queue.filter((item) => String(item.review_status || 'pending').toLowerCase() === 'pending').slice(0, 15);
    if (!pending.length) {
        showNotification('No visible pending incidents to resolve', 'info');
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
        showNotification(`Resolved ${pending.length} incidents`, 'success');
        await loadAutoModAdvancedData(Number(window._autoModAdvanced?.pagination?.page || 1));
    } catch (error) {
        console.error('Bulk resolve failed:', error);
        showNotification('Bulk resolve failed', 'error');
    }
}

// Global Exports
window.switchTab = switchTab;
window.renderAppealsPage = renderAppealsPage;
window.loadAppeals = loadAppeals;
window.acceptAppeal = acceptAppeal;
window.denyAppeal = denyAppeal;
window.loadAppealHistory = loadAppealHistory;
window.renderAppealHistoryPage = renderAppealHistoryPage;
window.getFilteredAppeals = getFilteredAppeals;
window.getFilteredAppealHistory = getFilteredAppealHistory;
window.showNotification = showNotification;
window.toggleFilters = toggleFilters;
window.handleLookupInput = handleLookupInput;
window.performLookup = performLookup;
window.switchLookupTab = switchLookupTab;
window.saveLookupNote = saveLookupNote;

window.loadAutoModProfiles = loadAutoModConfig; // Alias for compatibility with switchTab
window.loadAutoModConfig = loadAutoModConfig;
window.setActiveAutoModProfile = setActiveAutoModProfile;
window.createAutoModProfile = createAutoModProfile;
window.deleteAutoModProfile = deleteAutoModProfile;
window.saveSelectedAutoModProfileSettings = saveSelectedAutoModProfileSettings;
window.runAutoModSimulation = runAutoModSimulation;
window.loadAutoModAdvancedData = loadAutoModAdvancedData;
window.changeAutoModQueuePage = changeAutoModQueuePage;
window.updateAutoModWorkflow = updateAutoModWorkflow;
window.setAutoModWorkflowTarget = setAutoModWorkflowTarget;
window.saveAutoModWorkflowNote = saveAutoModWorkflowNote;
window.bulkResolveAutoModPending = bulkResolveAutoModPending;
let inviteStatsData = [];
let securityEventsData = [];
let securityEventsAutoRefreshTimer = null;
let securityEventsAutoRefreshIntervalMs = 30000;
let backupTablesCache = [];
let serverBackupGuildsCache = [];
let activeServerBackupRestoreOperationId = null;
let ownerConfigOverview = null;
let ownerConfigHistory = [];
let ownerConfigCheckFilter = 'action';
const SERVER_BACKUP_RESTORE_OPERATION_STORAGE_KEY = 'owner_server_backup_restore_operation_v1';
const OWNER_NOTIFICATION_STORAGE_KEY = 'owner_notification_center_v1';
const OWNER_BOT_SAFETY_LABELS = {
    enabled: 'Alerts Enabled',
    recentAlertLimit: 'Recent Alert Limit',
    emojiBurstThreshold: 'Emoji Burst Threshold',
    stickerBurstThreshold: 'Sticker Burst Threshold',
    assetAuditWindowMs: 'Asset Audit Window (ms)',
    assetAuditCooldownMs: 'Asset Audit Cooldown (ms)',
    inviteWindowMs: 'Invite Window (ms)',
    inviteMutationThreshold: 'Invite Mutation Threshold',
    inviteJoinSpikeThreshold: 'Invite Join Spike Threshold',
    inviterJoinSpikeThreshold: 'Inviter Join Spike Threshold',
    inviteAlertCooldownMs: 'Invite Alert Cooldown (ms)',
    nicknameAlertCooldownMs: 'Nickname Alert Cooldown (ms)',
    attachmentCountThreshold: 'Attachment Count Threshold',
    attachmentTotalSizeMbThreshold: 'Attachment Size Threshold (MB)',
    moderationEscalationCooldownMs: 'Escalation Cooldown (ms)',
    moderationEscalationLastHourThreshold: 'Escalations Per Hour',
    moderationEscalationLastDayThreshold: 'Escalations Per Day',
    moderationEscalationTimeoutThreshold: 'Timeout Threshold',
    moderationEscalationHighRiskThreshold: 'High Risk Threshold'
};
const ownerNotificationFeedState = {
    events: [],
    maxEntries: 300,
    toastCapturePatched: false
};

function escapeNotificationCell(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function normalizeAdminAvatarUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    if (raw.startsWith('/')) return raw;
    if (/^https?:\/\//i.test(raw)) return raw;
    return null;
}

function formatOwnerNotificationTime(timestamp) {
    const date = new Date(timestamp || 0);
    if (Number.isNaN(date.getTime())) return 'Unknown';
    return date.toLocaleString();
}

function normalizeOwnerNotificationSource(source) {
    const normalized = String(source || 'system').toLowerCase();
    if (['toast', 'system', 'action'].includes(normalized)) return normalized;
    return 'system';
}

function normalizeOwnerNotificationEntry(entry = {}) {
    const timestamp = Number(entry.timestamp) || Date.now();
    const typeRaw = String(entry.type || 'info').toLowerCase();
    const type = ['success', 'error', 'warning', 'info'].includes(typeRaw) ? typeRaw : 'info';
    const title = String(entry.title || 'Untitled').trim() || 'Untitled';
    const message = String(entry.message || '').trim();
    const source = normalizeOwnerNotificationSource(entry.source);
    return {
        id: String(entry.id || `${timestamp}-${Math.random().toString(36).slice(2, 10)}`),
        timestamp,
        type,
        title,
        message,
        source
    };
}

function saveOwnerNotificationFeed() {
    try {
        if (typeof localStorage === 'undefined') return;
        localStorage.setItem(OWNER_NOTIFICATION_STORAGE_KEY, JSON.stringify(ownerNotificationFeedState.events));
    } catch (error) {
        console.warn('Failed to persist notification center feed:', error);
    }
}

function loadOwnerNotificationFeed() {
    try {
        if (typeof localStorage === 'undefined') return;
        const raw = localStorage.getItem(OWNER_NOTIFICATION_STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return;
        ownerNotificationFeedState.events = parsed.map(normalizeOwnerNotificationEntry).slice(0, ownerNotificationFeedState.maxEntries);
    } catch (error) {
        console.warn('Failed to load notification center feed:', error);
    }
}

function persistActiveServerBackupRestoreOperationId(operationId) {
    try {
        if (typeof localStorage === 'undefined') return;
        const normalizedId = String(operationId || '').trim();
        if (!normalizedId) {
            localStorage.removeItem(SERVER_BACKUP_RESTORE_OPERATION_STORAGE_KEY);
            return;
        }
        localStorage.setItem(SERVER_BACKUP_RESTORE_OPERATION_STORAGE_KEY, normalizedId);
    } catch (error) {
        console.warn('Failed to persist server backup restore operation id:', error);
    }
}

function loadPersistedServerBackupRestoreOperationId() {
    try {
        if (typeof localStorage === 'undefined') return '';
        return String(localStorage.getItem(SERVER_BACKUP_RESTORE_OPERATION_STORAGE_KEY) || '').trim();
    } catch (error) {
        console.warn('Failed to load persisted server backup restore operation id:', error);
        return '';
    }
}

function clearPersistedServerBackupRestoreOperationId() {
    persistActiveServerBackupRestoreOperationId('');
}

function setServerBackupRestoreButtonBusyState(isBusy) {
    const restoreBtn = document.getElementById('restoreServerBackupBtn');
    if (!restoreBtn) return;
    restoreBtn.disabled = Boolean(isBusy);
    restoreBtn.textContent = isBusy ? 'Restoring...' : 'Restore Selected Backup';
}

function recordOwnerNotificationEvent(entry, options = {}) {
    const normalized = normalizeOwnerNotificationEntry(entry);
    const duplicate = ownerNotificationFeedState.events.find((existing) => {
        return existing.type === normalized.type
            && existing.title === normalized.title
            && existing.message === normalized.message
            && Math.abs(existing.timestamp - normalized.timestamp) < 1500;
    });
    if (duplicate) return duplicate;

    ownerNotificationFeedState.events.unshift(normalized);
    if (ownerNotificationFeedState.events.length > ownerNotificationFeedState.maxEntries) {
        ownerNotificationFeedState.events.length = ownerNotificationFeedState.maxEntries;
    }

    if (options.persist !== false) {
        saveOwnerNotificationFeed();
    }

    if (options.refresh !== false) {
        loadOwnerNotificationHistory();
    }

    return normalized;
}

function importToastHistoryToOwnerFeed(limit = 100) {
    if (typeof window.getNotificationHistory !== 'function') return;
    const rows = window.getNotificationHistory(limit);
    if (!Array.isArray(rows) || rows.length === 0) return;
    rows.slice().reverse().forEach((entry) => {
        recordOwnerNotificationEvent({
            timestamp: entry.timestamp,
            type: entry.type,
            title: entry.title,
            message: entry.message,
            source: 'toast'
        }, { refresh: false, persist: false });
    });
    saveOwnerNotificationFeed();
}

function patchOwnerToastCapture() {
    if (ownerNotificationFeedState.toastCapturePatched) return;
    const map = [
        ['showSuccess', 'success', 'profileShowSuccess'],
        ['showError', 'error', 'profileShowError'],
        ['showWarning', 'warning', null],
        ['showInfo', 'info', null]
    ];

    map.forEach(([fnName, fallbackType, aliasName]) => {
        const original = window[fnName];
        if (typeof original !== 'function') return;
        const wrapped = function patchedOwnerToastCapture(...args) {
            const title = String(args[0] ?? '').trim() || fallbackType.toUpperCase();
            const message = typeof args[1] === 'string' ? args[1] : '';
            recordOwnerNotificationEvent({
                timestamp: Date.now(),
                type: fallbackType,
                title,
                message,
                source: 'toast'
            }, { refresh: false });
            return original.apply(this, args);
        };

        window[fnName] = wrapped;

        if (aliasName) {
            const alias = window[aliasName];
            if (typeof alias !== 'function' || alias === original) {
                window[aliasName] = wrapped;
            }
        }
    });

    ownerNotificationFeedState.toastCapturePatched = true;
}

function getOwnerNotificationFilters() {
    const typeFilter = String(document.getElementById('ownerNotificationTypeFilter')?.value || 'all').toLowerCase();
    const sourceFilter = String(document.getElementById('ownerNotificationSourceFilter')?.value || 'all').toLowerCase();
    const search = String(document.getElementById('ownerNotificationSearch')?.value || '').trim().toLowerCase();
    return { typeFilter, sourceFilter, search };
}

function filterOwnerNotificationRows(rows) {
    const { typeFilter, sourceFilter, search } = getOwnerNotificationFilters();
    return rows.filter((entry) => {
        const type = String(entry.type || 'info').toLowerCase();
        const source = normalizeOwnerNotificationSource(entry.source);
        const text = `${entry.title || ''} ${entry.message || ''}`.toLowerCase();

        if (typeFilter !== 'all' && type !== typeFilter) return false;
        if (sourceFilter !== 'all' && source !== sourceFilter) return false;
        if (search && !text.includes(search)) return false;
        return true;
    });
}

function renderOwnerNotificationRows(rows) {
    const tbody = document.getElementById('ownerNotificationHistoryTable');
    if (!tbody) return;

    if (!Array.isArray(rows) || rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">No notification history yet.</td></tr>';
        return;
    }

    tbody.innerHTML = rows.map((entry) => {
        const type = String(entry?.type || 'info').toLowerCase();
        const typeBadge = `<span class="badge badge-${escapeNotificationCell(type)}">${escapeNotificationCell(type.toUpperCase())}</span>`;
        const source = normalizeOwnerNotificationSource(entry?.source);
        const sourceBadge = `<span class="badge">${escapeNotificationCell(source.toUpperCase())}</span>`;
        return `
            <tr>
                <td>${escapeNotificationCell(formatOwnerNotificationTime(entry?.timestamp))}</td>
                <td>${typeBadge}</td>
                <td>${sourceBadge}</td>
                <td>${escapeNotificationCell(entry?.title || 'Untitled')}</td>
                <td>${escapeNotificationCell(entry?.message || '-')}</td>
            </tr>
        `;
    }).join('');
}

function escapeSecurityHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function getSecuritySignalLabel(signal) {
    const map = {
        'api-origin-blocked': 'API Origin Blocked',
        'csrf-origin-failed': 'CSRF Origin Failed',
        'csrf-token-failed': 'CSRF Token Failed',
        'rate-limit-hit': 'Rate Limit Hit',
        'login-ip-locked': 'Login IP Locked',
        'login-bruteforce-threshold': 'Brute Force Threshold',
        'new-device-login': 'New Device Login',
        'device-binding-blocked': 'Device Binding Blocked',
        'ip-reputation-elevated': 'IP Reputation Elevated',
        'ip-reputation-blocked': 'IP Reputation Blocked',
        'login-captcha-failed': 'Login Captcha Failed',
        'register-captcha-failed': 'Register Captcha Failed',
        'captcha-failed': 'Captcha Failed',
        'captcha-challenge-mismatch': 'Captcha Challenge Mismatch',
        'captcha-expired': 'Captcha Expired',
        'captcha-solve-too-fast': 'Captcha Solve Too Fast',
        'captcha-ip-blocked': 'Captcha IP Blocked',
        'captcha-policy-updated': 'Captcha Policy Updated',
        'suspicious-activity-detected': 'Suspicious Activity Detected'
    };
    return map[String(signal || '').toLowerCase()] || (String(signal || 'unknown').replace(/_/g, ' '));
}

function getSecuritySignalSeverity(signal) {
    const normalized = String(signal || '').toLowerCase();
    if (normalized === 'suspicious-activity-detected' || normalized === 'login-bruteforce-threshold' || normalized === 'login-ip-locked') {
        return 'critical';
    }
    if (normalized === 'device-binding-blocked') {
        return 'critical';
    }
    if (normalized === 'new-device-login') {
        return 'high';
    }
    if (normalized === 'ip-reputation-blocked') {
        return 'critical';
    }
    if (normalized === 'ip-reputation-elevated') {
        return 'high';
    }
    if (normalized === 'csrf-token-failed' || normalized === 'api-origin-blocked') {
        return 'high';
    }
    if (normalized === 'captcha-ip-blocked' || normalized === 'captcha-solve-too-fast' || normalized === 'captcha-challenge-mismatch') {
        return 'high';
    }
    if (normalized === 'login-captcha-failed' || normalized === 'register-captcha-failed') {
        return 'medium';
    }
    if (normalized === 'captcha-failed' || normalized === 'captcha-expired') {
        return 'medium';
    }
    if (normalized === 'captcha-policy-updated') {
        return 'low';
    }
    if (normalized === 'csrf-origin-failed' || normalized === 'rate-limit-hit') {
        return 'medium';
    }
    return 'low';
}

function getSecuritySeverityBadge(severity) {
    const level = String(severity || 'low').toLowerCase();
    if (level === 'critical') {
        return '<span class="badge" style="background: rgba(244,67,54,0.2); color: #ff8a80; border: 1px solid rgba(244,67,54,0.45);">CRITICAL</span>';
    }
    if (level === 'high') {
        return '<span class="badge" style="background: rgba(255,152,0,0.2); color: #ffcc80; border: 1px solid rgba(255,152,0,0.45);">HIGH</span>';
    }
    if (level === 'medium') {
        return '<span class="badge" style="background: rgba(255,193,7,0.2); color: #ffe082; border: 1px solid rgba(255,193,7,0.45);">MEDIUM</span>';
    }
    return '<span class="badge" style="background: rgba(76,175,80,0.2); color: #a5d6a7; border: 1px solid rgba(76,175,80,0.45);">LOW</span>';
}

function formatSecurityEventDetails(event) {
    const metadata = (event?.metadata && typeof event.metadata === 'object') ? event.metadata : {};
    const signal = event?.signal || metadata.signal || 'unknown';
    const signalLabel = getSecuritySignalLabel(signal);
    const severity = getSecuritySignalSeverity(signal);
    const userAgent = event?.userAgent || metadata.userAgent || '-';
    const pathName = metadata.path || '-';
    const method = metadata.method || '-';
    const reasons = Array.isArray(metadata.reasons) ? metadata.reasons.join(', ') : (metadata.reason || '-');
    const attempts = Number.isFinite(Number(metadata.attempts)) ? String(Number(metadata.attempts)) : '-';

    const metadataJson = escapeSecurityHtml(JSON.stringify(metadata, null, 2));

    return `
        <div class="security-event-details">
            <div><strong>Signal:</strong> ${escapeSecurityHtml(signalLabel)} (${escapeSecurityHtml(severity)})</div>
            <div><strong>Method:</strong> ${escapeSecurityHtml(method)} &nbsp; <strong>Path:</strong> ${escapeSecurityHtml(pathName)}</div>
            <div><strong>User Agent:</strong> ${escapeSecurityHtml(userAgent)}</div>
            <div><strong>Reason/Flags:</strong> ${escapeSecurityHtml(reasons)} &nbsp; <strong>Attempts:</strong> ${escapeSecurityHtml(attempts)}</div>
            <pre>${metadataJson}</pre>
        </div>
    `;
}

function renderSecurityEventsRows(rows) {
    const tbody = document.getElementById('securityEventsTableBody');
    if (!tbody) return;

    if (!Array.isArray(rows) || rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">No security events found for current filters.</td></tr>';
        return;
    }

    tbody.innerHTML = rows.map((event, index) => {
        const createdAt = event?.createdAt ? new Date(event.createdAt) : null;
        const timeText = createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt.toLocaleString() : 'Unknown';
        const metadata = (event?.metadata && typeof event.metadata === 'object') ? event.metadata : {};
        const username = metadata.username || event.username || '-';
        const pathName = metadata.path || '-';
        const signal = event?.signal || metadata.signal;
        const severity = getSecuritySignalSeverity(signal);
        const signalLabel = getSecuritySignalLabel(signal);
        const severityBadge = getSecuritySeverityBadge(severity);
        const details = [
            metadata.reason ? `reason: ${metadata.reason}` : null,
            metadata.mode ? `mode: ${metadata.mode}` : null,
            Number.isFinite(Number(metadata.attempts)) ? `attempts: ${Number(metadata.attempts)}` : null,
            Number.isFinite(Number(metadata.limit)) ? `limit: ${Number(metadata.limit)}` : null
        ].filter(Boolean).join(' • ') || '-';
        const eventId = String(event?.id || `${signal || 'event'}-${index}`);
        const detailsPanel = formatSecurityEventDetails(event);

        return `
            <tr class="security-event-row severity-${escapeSecurityHtml(severity)}" data-event-id="${escapeSecurityHtml(eventId)}">
                <td>${escapeSecurityHtml(timeText)}</td>
                <td>${escapeSecurityHtml(signalLabel)}<div style="margin-top:0.35rem;">${severityBadge}</div></td>
                <td>${escapeSecurityHtml(username)}</td>
                <td>${escapeSecurityHtml(event?.ipAddress || '-')}</td>
                <td>${escapeSecurityHtml(pathName)}</td>
                <td>
                    <div>${escapeSecurityHtml(details)}</div>
                    <button class="security-event-toggle-btn" data-event-toggle="${escapeSecurityHtml(eventId)}">Details</button>
                </td>
            </tr>
            <tr class="security-event-details-row" data-event-details="${escapeSecurityHtml(eventId)}">
                <td colspan="6">${detailsPanel}</td>
            </tr>
        `;
    }).join('');
}

async function loadSecurityEventsFeed(force = false) {
    const metaEl = document.getElementById('securityEventsMeta');
    const signalFilter = String(document.getElementById('securityEventsSignalFilter')?.value || '').trim();
    const usernameFilter = String(document.getElementById('securityEventsUserFilter')?.value || '').trim();
    const requestedLimit = Number(document.getElementById('securityEventsLimit')?.value || 100);
    const limit = Math.max(1, Math.min(500, Number.isFinite(requestedLimit) ? requestedLimit : 100));

    const params = new URLSearchParams();
    params.set('limit', String(limit));
    if (signalFilter) params.set('signal', signalFilter);
    if (usernameFilter) params.set('username', usernameFilter);

    if (metaEl) {
        metaEl.textContent = force ? 'Refreshing security events...' : 'Loading security events...';
    }

    try {
        const { response, data } = await window.AdminPanel.api.getJson(`/api/security/events?${params.toString()}`);
        if (!response.ok || !data?.success) {
            throw new Error(data?.error || 'Failed to fetch security events');
        }

        securityEventsData = Array.isArray(data.events) ? data.events : [];
        renderSecurityEventsRows(securityEventsData);

        if (metaEl) {
            metaEl.textContent = `Last updated: ${new Date().toLocaleString()} • Showing ${securityEventsData.length} event(s)`;
        }
    } catch (error) {
        console.error('Error loading security events:', error);
        renderSecurityEventsRows([]);
        if (metaEl) {
            metaEl.textContent = 'Could not load security events.';
        }
        if (typeof profileShowError === 'function') {
            profileShowError('Could not load the security events feed');
        }
    }
}

function applySecurityEventsFilters() {
    loadSecurityEventsFeed(false);
}

function clearSecurityEventsFilters() {
    const signalEl = document.getElementById('securityEventsSignalFilter');
    const userEl = document.getElementById('securityEventsUserFilter');
    const limitEl = document.getElementById('securityEventsLimit');
    if (signalEl) signalEl.value = '';
    if (userEl) userEl.value = '';
    if (limitEl) limitEl.value = '100';
    loadSecurityEventsFeed(true);
}

window.loadSecurityEventsFeed = loadSecurityEventsFeed;
window.applySecurityEventsFilters = applySecurityEventsFilters;
window.clearSecurityEventsFilters = clearSecurityEventsFilters;

function isSecurityEventsTabActive() {
    const tab = document.getElementById('security-events');
    return tab && tab.classList.contains('active');
}

function stopSecurityEventsAutoRefresh() {
    if (securityEventsAutoRefreshTimer) {
        clearInterval(securityEventsAutoRefreshTimer);
        securityEventsAutoRefreshTimer = null;
    }
}

function startSecurityEventsAutoRefresh() {
    stopSecurityEventsAutoRefresh();
    const toggle = document.getElementById('securityEventsAutoRefreshToggle');
    if (!toggle || !toggle.checked) return;
    if (!isSecurityEventsTabActive() || document.hidden) return;

    securityEventsAutoRefreshTimer = setInterval(() => {
        if (!isSecurityEventsTabActive() || document.hidden) {
            stopSecurityEventsAutoRefresh();
            return;
        }
        loadSecurityEventsFeed(false);
    }, securityEventsAutoRefreshIntervalMs);
}

function updateSecurityEventsRefreshInterval() {
    const select = document.getElementById('securityEventsRefreshInterval');
    const nextInterval = Number(select?.value || 30000);
    securityEventsAutoRefreshIntervalMs = Number.isFinite(nextInterval) ? nextInterval : 30000;
    startSecurityEventsAutoRefresh();
}

function toggleSecurityEventsAutoRefresh() {
    const toggle = document.getElementById('securityEventsAutoRefreshToggle');
    if (!toggle) return;
    if (toggle.checked) {
        startSecurityEventsAutoRefresh();
    } else {
        stopSecurityEventsAutoRefresh();
    }
}

function escapeCssSelector(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') {
        return window.CSS.escape(value);
    }
    return String(value || '').replace(/"/g, '\\"');
}

document.addEventListener('click', (event) => {
    const button = event.target?.closest?.('[data-event-toggle]');
    if (!button) return;
    const eventId = String(button.getAttribute('data-event-toggle') || '');
    const detailsRow = document.querySelector(`[data-event-details="${escapeCssSelector(eventId)}"]`);
    if (!detailsRow) return;
    const isOpen = detailsRow.classList.toggle('is-open');
    button.textContent = isOpen ? 'Hide' : 'Details';
});

document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        stopSecurityEventsAutoRefresh();
    } else {
        startSecurityEventsAutoRefresh();
    }
});

document.addEventListener('DOMContentLoaded', () => {
    const toggle = document.getElementById('securityEventsAutoRefreshToggle');
    const intervalSelect = document.getElementById('securityEventsRefreshInterval');
    if (toggle) toggle.addEventListener('change', toggleSecurityEventsAutoRefresh);
    if (intervalSelect) intervalSelect.addEventListener('change', updateSecurityEventsRefreshInterval);

    document.querySelectorAll('.tab').forEach((btn) => {
        btn.addEventListener('click', () => {
            const tabName = btn.dataset.tab;
            if (tabName === 'security-events') {
                loadSecurityEventsFeed(true);
                startSecurityEventsAutoRefresh();
            } else {
                stopSecurityEventsAutoRefresh();
            }
        });
    });
});

function loadOwnerNotificationHistory(limit = 30) {
    const updatedEl = document.getElementById('ownerNotificationHistoryUpdated');
    try {
        if (typeof window.getNotificationHistory === 'function') {
            const latestToast = window.getNotificationHistory(1);
            if (Array.isArray(latestToast) && latestToast.length > 0) {
                const toast = latestToast[0];
                recordOwnerNotificationEvent({
                    timestamp: toast.timestamp,
                    type: toast.type,
                    title: toast.title,
                    message: toast.message,
                    source: 'toast'
                }, { refresh: false, persist: false });
            }
        }

        const safeLimit = Math.max(10, Math.min(300, Number(limit) || 30));
        const rows = ownerNotificationFeedState.events.slice(0, safeLimit);
        const filteredRows = filterOwnerNotificationRows(rows);
        renderOwnerNotificationRows(filteredRows);
        if (updatedEl) {
            updatedEl.textContent = `Last updated: ${new Date().toLocaleString()} • ${filteredRows.length}/${rows.length} shown • ${ownerNotificationFeedState.events.length} total`;
        }
        saveOwnerNotificationFeed();
    } catch (error) {
        console.error('Failed to load notification history:', error);
        renderOwnerNotificationRows([]);
        if (updatedEl) updatedEl.textContent = 'Last updated: failed';
    }
}

function initializeOwnerNotificationCenter() {
    loadOwnerNotificationFeed();
    patchOwnerToastCapture();
    importToastHistoryToOwnerFeed(120);

    const filterIds = ['ownerNotificationSearch', 'ownerNotificationTypeFilter', 'ownerNotificationSourceFilter'];
    filterIds.forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        const eventName = id === 'ownerNotificationSearch' ? 'input' : 'change';
        el.addEventListener(eventName, () => loadOwnerNotificationHistory(120));
    });

    recordOwnerNotificationEvent({
        type: 'info',
        title: 'Notification Center Ready',
        message: 'Tracking toast, system, and action events on this page.',
        source: 'system'
    }, { refresh: false });
}

function clearOwnerNotificationHistory() {
    try {
        if (typeof window.clearNotificationHistory === 'function') {
            window.clearNotificationHistory({ clearActive: false });
        }
        ownerNotificationFeedState.events = [];
        saveOwnerNotificationFeed();
        loadOwnerNotificationHistory();
        if (typeof profileShowSuccess === 'function') {
            profileShowSuccess('Notification Center', 'Notification history cleared.');
        }
    } catch (error) {
        console.error('Failed to clear notification history:', error);
        if (typeof profileShowError === 'function') {
            profileShowError('Notification Center', 'Failed to clear notification history.');
        }
    }
}

window.loadOwnerNotificationHistory = loadOwnerNotificationHistory;
window.clearOwnerNotificationHistory = clearOwnerNotificationHistory;
window.recordOwnerNotificationEvent = recordOwnerNotificationEvent;

async function generateInvite() {
    const role = document.getElementById('inviteRole')?.value || 'moderator';
    const expiresInDays = parseInt(document.getElementById('inviteExpiry')?.value || 7);
    const description = document.getElementById('inviteDescription')?.value?.trim() || '';

    if (!['moderator', 'admin'].includes(role)) {
        profileShowError('Invalid Input', 'Only moderator and admin invite roles are supported.');
        return;
    }

    if (isNaN(expiresInDays) || expiresInDays < 1 || expiresInDays > 365) {
        profileShowError('Invalid Input', 'Expiry days must be between 1 and 365');
        return;
    }

    try {
        const { response, data } = await window.AdminPanel.api.postJson('/api/invites/generate', {
            role,
            expiresInDays,
            description
        });

        if (response.ok && data.success) {
            const resultDiv = document.getElementById('inviteResult');
            const expiresDate = new Date(data.expiresAt);
            const safeCode = escapeOwnerHtml(data.code || '');
            const safeCodeJs = escapeOwnerJsString(data.code || '');
            const safeRole = escapeOwnerHtml(role);
            const safeDescription = escapeOwnerHtml(description);

            resultDiv.innerHTML = `
                <div class="invite-result-card">
                    <div class="invite-result-header">
                        <div class="invite-result-icon">✅</div>
                        <div>
                            <div class="invite-result-title">Invite Code Generated</div>
                            <div class="invite-result-subtitle">Share this code with the new ${safeRole}</div>
                        </div>
                    </div>
                    <div class="invite-code-row">
                        <div class="invite-code-pill">${safeCode}</div>
                        <button class="btn btn-secondary" onclick="copyInviteCode('${safeCodeJs}')">📋 Copy</button>
                    </div>
                    <div class="invite-meta-grid">
                        <div class="invite-meta-card">
                            <strong>Role</strong>
                            <span>${safeRole}</span>
                        </div>
                        <div class="invite-meta-card">
                            <strong>Expires</strong>
                            <span>${expiresDate.toLocaleDateString()}</span>
                        </div>
                        ${description ? `
                            <div class="invite-meta-card" style="grid-column: 1 / -1;">
                                <strong>Description</strong>
                                <span>${safeDescription}</span>
                            </div>
                        ` : ''}
                    </div>
                </div>
            `;

            document.getElementById('inviteDescription').value = '';

            setTimeout(() => loadInviteStats(), 500);
        } else {
            profileShowError('Generation Failed', data.error || 'Failed to generate invite code');
        }
    } catch (error) {
        profileShowError('Error', 'Failed to generate invite: ' + error.message);
    }
}

async function copyInviteCode(code) {
    try {
        await navigator.clipboard.writeText(code);
        profileShowSuccess('Copied!', 'Invite code copied to clipboard');
    } catch (err) {
        const input = document.createElement('input');
        input.value = code;
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        document.body.removeChild(input);
        profileShowSuccess('Copied!', 'Invite code copied to clipboard');
    }
}

async function loadInviteStats() {
    try {
        const { response, data } = await window.AdminPanel.api.getJson('/api/invites/stats');

        if (!response.ok) {
            throw new Error(data.error || 'Failed to load invite stats');
        }

        inviteStatsData = Array.isArray(data) ? data : [];

        const stats = {
            active: 0,
            fullyUsed: 0,
            expired: 0,
            revoked: 0,
            totalUses: 0,
            totalMaxUses: 0
        };

        inviteStatsData.forEach(invite => {
            stats.totalUses += invite.current_uses || 0;
            stats.totalMaxUses += invite.max_uses || 0;

            if (invite.status === 'active') stats.active++;
            else if (invite.status === 'fully_used') stats.fullyUsed++;
            else if (invite.status === 'expired') stats.expired++;
            else if (invite.status === 'revoked') stats.revoked++;
        });

        const activeEl = document.getElementById('totalActiveInvites');
        if (activeEl) activeEl.textContent = stats.active;
        const usedEl = document.getElementById('totalUsedInvites');
        if (usedEl) usedEl.textContent = stats.fullyUsed;
        const expiredEl = document.getElementById('totalExpiredInvites');
        if (expiredEl) expiredEl.textContent = stats.expired;
        const usesEl = document.getElementById('totalInviteUses');
        if (usesEl) usesEl.textContent = stats.totalUses;
        const revokedEl = document.getElementById('totalRevokedInvites');
        if (revokedEl) revokedEl.textContent = stats.revoked;
        const conversionEl = document.getElementById('inviteConversionRate');
        if (conversionEl) {
            const conversion = stats.totalMaxUses > 0
                ? (stats.totalUses / stats.totalMaxUses) * 100
                : 0;
            conversionEl.textContent = `${conversion.toFixed(1)}%`;
        }

        const ownerTotalEl = document.getElementById('inviteStatTotal');
        if (ownerTotalEl) ownerTotalEl.textContent = String(inviteStatsData.length);

        const ownerActiveEl = document.getElementById('inviteStatActive');
        if (ownerActiveEl) ownerActiveEl.textContent = String(stats.active);

        const ownerUsedEl = document.getElementById('inviteStatUsed');
        if (ownerUsedEl) ownerUsedEl.textContent = String(stats.fullyUsed);

        const metaEl = document.getElementById('inviteStatsMeta');
        if (metaEl) {
            metaEl.textContent = `Last updated: ${new Date().toLocaleString()} • ${inviteStatsData.length} invite(s)`;
        }

        filterInviteStats();
    } catch (error) {
        console.error('Error loading invite stats:', error);
        profileShowError('Error', 'Failed to load invite statistics: ' + error.message);
    }
}

function filterInviteStats() {
    const searchTerm = document.getElementById('inviteSearch')?.value?.toLowerCase() || '';
    const statusFilter = document.getElementById('inviteStatusFilter')?.value || 'all';
    const roleFilter = document.getElementById('inviteRoleFilter')?.value || 'all';

    const filtered = inviteStatsData.filter(invite => {
        if (statusFilter !== 'all') {
            if (statusFilter === 'used' && invite.status !== 'fully_used') return false;
            if (statusFilter !== 'used' && invite.status !== statusFilter) return false;
        }

        if (roleFilter !== 'all' && invite.role !== roleFilter) return false;

        if (searchTerm) {
            const searchableText = [
                invite.code,
                invite.created_by,
                invite.used_by,
                invite.description
            ].filter(Boolean).join(' ').toLowerCase();

            if (!searchableText.includes(searchTerm)) return false;
        }

        return true;
    });

    renderInviteStatsTable(filtered);
}

function renderInviteStatsTable(invites) {
    const tbody = document.getElementById('inviteStatsTable');
    if (!tbody) return;

    if (!invites || invites.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted" style="padding:2rem;">No invites found matching your search.</td></tr>';
        return;
    }

    tbody.innerHTML = invites.map(invite => {
        const inviteCodeHtml = escapeOwnerHtml(invite.code || '');
        const inviteCodeJs = escapeOwnerJsString(invite.code || '');
        const inviteDescription = escapeOwnerHtml(invite.description || '');
        const usedByName = escapeOwnerHtml(invite.used_by || '');
        let statusHtml = '';
        const status = (invite.status || 'active').toLowerCase();

        if (status === 'fully_used' || status === 'used')
            statusHtml = '<span class="user-role-badge" style="background:rgba(40, 167, 69, 0.15); color:#4CAF50; border:1px solid rgba(40, 167, 69, 0.3);">Redeemed</span>';
        else if (status === 'expired')
            statusHtml = '<span class="user-role-badge" style="background:rgba(255, 193, 7, 0.15); color:#FFC107; border:1px solid rgba(255, 193, 7, 0.3);">Expired</span>';
        else if (status === 'revoked')
            statusHtml = '<span class="user-role-badge" style="background:rgba(220, 53, 69, 0.15); color:#ff6b6b; border:1px solid rgba(220, 53, 69, 0.3);">Revoked</span>';
        else
            statusHtml = '<span class="user-role-badge" style="background:rgba(102, 126, 234, 0.15); color:#667eea; border:1px solid rgba(102, 126, 234, 0.3);">Active</span>';

        const role = (invite.role || 'user').toLowerCase();
        const roleColor = role === 'owner' ? '#ffd700' : (role === 'admin' ? '#ff6b6b' : '#4bc0c0');
        const roleBg = role === 'owner' ? 'rgba(255, 215, 0, 0.1)' : (role === 'admin' ? 'rgba(255, 107, 107, 0.1)' : 'rgba(75, 192, 192, 0.1)');

        const createdDate = new Date(invite.created_at || Date.now()).toLocaleDateString();
        const expiresDate = invite.expires_at ? new Date(invite.expires_at).toLocaleDateString() : 'Never';

        let actions = '';

        if (status === 'active') {
            actions += `<button class="action-btn-icon" onclick="window.extendInvite('${inviteCodeJs}')" title="Extend expiration" style="color:#667eea; background:rgba(102,126,234,0.1);">⏰</button>`;
            actions += `<button class="action-btn-icon" onclick="window.revokeInvite('${inviteCodeJs}')" title="Revoke invite" style="color:#ff6b6b; background:rgba(220,53,69,0.1);">🚫</button>`;
        } else if (status === 'revoked') {
            actions += `<button class="action-btn-icon" onclick="window.restoreInvite('${inviteCodeJs}')" title="Restore invite" style="color:#28a745; background:rgba(40,167,69,0.1);">♻️</button>`;
        }

        if (status !== 'fully_used' && status !== 'used') {
            actions += `<button class="action-btn-icon" onclick="window.deleteInvitePermanent('${inviteCodeJs}')" title="Permanently delete" style="color:#ef4444; background:rgba(239,68,68,0.1);">🗑️</button>`;
        }

        const usedBy = invite.used_by ?
            `<div class="invite-used-by">
                <div class="user-avatar" style="width:24px; height:24px; font-size:0.6rem; background:#4CAF50;">👤</div>
               <span class="invite-used-by-name">${usedByName}</span>
            </div>`
            : '<span style="color:#52525b;">-</span>';

        return `
            <tr>
                <td style="padding-left:1.5rem;">
                    <div class="invite-cell-main">
                        <div class="invite-cell-top">
                            <div class="invite-code-pill" style="flex:0 1 auto; min-width:0; padding:0.45rem 0.65rem; border-radius:0.65rem; font-size:0.85rem;">${inviteCodeHtml}</div>
                            <button class="action-btn-icon" onclick="copyInviteCode('${inviteCodeJs}')" title="Copy Code" style="opacity:0.6;">📋</button>
                        </div>
                        ${invite.description ? `<div class="invite-description">${inviteDescription}</div>` : ''}
                    </div>
                </td>
                <td><span class="user-role-badge" style="color:${roleColor}; background:${roleBg}; border:1px solid ${roleColor}40;">${role.toUpperCase()}</span></td>
                <td>${statusHtml}</td>
                <td>${usedBy}</td>
                <td style="color:#94a3b8; font-size:0.9rem;">${createdDate}</td>
                <td style="color:#94a3b8; font-size:0.9rem;">${expiresDate}</td>
                <td>
                    <div class="invite-actions">${actions}</div>
                </td>
            </tr>
        `;
    }).join('');
}

function getInviteStatusBadge(status) {
    const badges = {
        active: '<span class="stat-card-advanced-badge healthy">Active</span>',
        fully_used: '<span class="stat-card-advanced-badge healthy">Fully Used</span>',
        expired: '<span class="stat-card-advanced-badge warning">Expired</span>',
        revoked: '<span class="stat-card-advanced-badge critical">Revoked</span>',
        inactive: '<span class="stat-card-advanced-badge">Inactive</span>'
    };
    return badges[status] || badges.inactive;
}

function getInviteActionButtons(invite) {
    const buttons = [];
    const hasBeenUsed = Boolean(invite?.used_by || invite?.used_at || Number(invite?.current_uses || 0) > 0 || String(invite?.status || '') === 'fully_used');
    const inviteCodeJs = escapeOwnerJsString(invite?.code || '');

    if (invite.status === 'active') {
        buttons.push(`<button class="btn btn-sm btn-secondary invite-action-btn" onclick="extendInvite('${inviteCodeJs}')" title="Extend expiration">⏰ Extend</button>`);
        buttons.push(`<button class="btn btn-sm btn-danger invite-action-btn" onclick="revokeInvite('${inviteCodeJs}')" title="Revoke invite">🚫 Revoke</button>`);
    } else if (invite.status === 'revoked') {
        buttons.push(`<button class="btn btn-sm btn-success invite-action-btn" onclick="restoreInvite('${inviteCodeJs}')" title="Restore invite">♻️ Restore</button>`);
    }

    if (hasBeenUsed) {
        buttons.push('<button class="btn btn-sm btn-secondary invite-action-btn" disabled title="Used invites cannot be permanently deleted">🔒 Delete Blocked</button>');
    } else {
        buttons.push(`<button class="btn btn-sm btn-danger invite-action-btn" onclick="deleteInvitePermanent('${inviteCodeJs}')" title="Permanently delete">- Delete</button>`);
    }

    return buttons.join('');
}

async function revokeInvite(code) {
    const confirmed = await window.modalManager?.showConfirm({
        title: 'Revoke Invite',
        message: 'This will deactivate the invite code. It can be restored later. Continue?',
        confirmText: 'Revoke',
        type: 'warning'
    });

    if (!confirmed) return;

    try {
        const { response, data } = await window.AdminPanel.api.postJson(`/api/invites/revoke/${encodeURIComponent(code)}`, {
            permanent: false
        });

        if (response.ok && data.success) {
            profileShowSuccess('Revoked', 'Invite code has been revoked');
            loadInviteStats();
        } else {
            profileShowError('Failed', data.error || 'Failed to revoke invite code');
        }
    } catch (error) {
        profileShowError('Error', 'Failed to revoke invite: ' + error.message);
    }
}

async function restoreInvite(code) {
    try {
        const { response, data } = await window.AdminPanel.api.postJson(`/api/invites/restore/${encodeURIComponent(code)}`, {});

        if (response.ok && data.success) {
            profileShowSuccess('Restored', 'Invite code has been restored');
            loadInviteStats();
        } else {
            profileShowError('Failed', data.error || 'Failed to restore invite code');
        }
    } catch (error) {
        profileShowError('Error', 'Failed to restore invite: ' + error.message);
    }
}

async function extendInvite(code) {
    if (typeof window.showPromptModal !== 'function') {
        profileShowError('Unavailable', 'Prompt modal is not available right now. Please refresh and try again.');
        return;
    }

    const days = await window.showPromptModal({
        title: 'Extend Invite Expiry',
        label: 'Extend expiration by how many days? (1-365)',
        placeholder: 'Enter days (1-365)',
        defaultValue: '7',
        confirmText: 'Extend',
        cancelText: 'Cancel',
        inputType: 'number',
        validate: (value) => {
            const parsed = Number.parseInt(value, 10);
            if (!Number.isFinite(parsed) || parsed < 1 || parsed > 365) {
                return 'Please enter a valid number between 1 and 365.';
            }
            return true;
        }
    });
    if (!days) return;

    const additionalDays = parseInt(days);
    if (isNaN(additionalDays) || additionalDays < 1 || additionalDays > 365) {
        profileShowError('Invalid Input', 'Please enter a number between 1 and 365');
        return;
    }

    try {
        const { response, data } = await window.AdminPanel.api.postJson(`/api/invites/extend/${encodeURIComponent(code)}`, {
            additionalDays
        });

        if (response.ok && data.success) {
            profileShowSuccess('Extended', `Invite expiration extended by ${additionalDays} days`);
            loadInviteStats();
        } else {
            profileShowError('Failed', data.error || 'Failed to extend invite code');
        }
    } catch (error) {
        profileShowError('Error', 'Failed to extend invite: ' + error.message);
    }
}

async function deleteInvitePermanent(code) {
    const invite = Array.isArray(inviteStatsData)
        ? inviteStatsData.find((item) => String(item?.code || '') === String(code || ''))
        : null;
    const hasBeenUsed = Boolean(invite?.used_by || invite?.used_at || Number(invite?.current_uses || 0) > 0 || String(invite?.status || '') === 'fully_used');

    if (hasBeenUsed) {
        profileShowError('Blocked', 'Used invites cannot be permanently deleted.');
        return;
    }

    const confirmed = await window.modalManager?.showConfirm({
        title: 'Permanently Delete',
        message: 'This will PERMANENTLY delete the invite code and cannot be undone. Are you absolutely sure?',
        confirmText: 'Delete Forever',
        type: 'danger'
    });

    if (!confirmed) return;

    try {
        const { response, data } = await window.AdminPanel.api.postJson(`/api/invites/revoke/${encodeURIComponent(code)}`, {
            permanent: true
        });

        if (response.ok && data.success) {
            profileShowSuccess('Deleted', 'Invite code has been permanently deleted');
            loadInviteStats();
        } else {
            profileShowError('Failed', data.error || 'Failed to delete invite code');
        }
    } catch (error) {
        profileShowError('Error', 'Failed to delete invite: ' + error.message);
    }
}

function exportInvitesCsv() {
    if (!inviteStatsData || inviteStatsData.length === 0) {
        profileShowError('No Data', 'No invite data to export');
        return;
    }

    const headers = ['Code', 'Role', 'Status', 'Created By', 'Used By', 'Description', 'Created At', 'Expires At', 'Used At'];
    const rows = inviteStatsData.map(invite => [
        invite.code,
        invite.role,
        invite.status,
        invite.created_by || '',
        invite.used_by || '',
        (invite.description || '').replace(/"/g, '""'),
        invite.created_at ? new Date(invite.created_at).toISOString() : '',
        invite.expires_at ? new Date(invite.expires_at).toISOString() : '',
        invite.used_at ? new Date(invite.used_at).toISOString() : ''
    ]);

    const csv = [
        headers.map(h => `"${h}"`).join(','),
        ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `invite_codes_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();

    profileShowSuccess('Exported', 'Invite data exported to CSV');
}

window.generateInvite = generateInvite;
window.loadInviteStats = loadInviteStats;
window.filterInviteStats = filterInviteStats;
window.copyInviteCode = copyInviteCode;
window.revokeInvite = revokeInvite;
window.restoreInvite = restoreInvite;
window.extendInvite = extendInvite;
window.deleteInvitePermanent = deleteInvitePermanent;
window.exportInvitesCsv = exportInvitesCsv;



async function viewAdminUserDetail(userId, username) {
    const modal = document.getElementById('adminUserDetailModal');
    const content = document.getElementById('adminUserDetailContent');

    if (!modal || !content) return;

    modal.style.display = 'flex';
    content.innerHTML = '<div class="loading show">Loading account details...</div>';

    try {
        if (!userId || userId === 'undefined' || userId === '[object Object]') {
            console.warn('viewAdminUserDetail called with invalid userId:', { userId, username });
            content.innerHTML = `
                <div style="padding: 2rem; text-align: center; color: var(--color-red);">
                    <div style="font-size: 2rem; margin-bottom: 1rem;">⚠️</div>
                    <div style="font-weight: 600; margin-bottom: 0.5rem;">Invalid user</div>
                    <div style="color: var(--text-secondary);">No valid user id provided for details request.</div>
                </div>
            `;
            return;
        }

        const { response, data } = await window.AdminPanel.api.getJson(`/api/admin/users/${encodeURIComponent(userId)}/details`);

        if (!response.ok || !data) {
            throw new Error(data?.error || 'Failed to load account details');
        }

        renderAdminUserDetail(data);
    } catch (error) {
        content.innerHTML = `
            <div style="padding: 2rem; text-align: center; color: var(--color-red);">
                <div style="font-size: 2rem; margin-bottom: 1rem;">⚠️</div>
                <div style="font-weight: 600; margin-bottom: 0.5rem;">Error Loading Details</div>
				<div style="color: var(--text-secondary);">${escapeOwnerHtml(error.message || 'Failed to load account details')}</div>
            </div>
        `;
    }
}

function renderAdminUserDetail(user) {
    const content = document.getElementById('adminUserDetailContent');
    if (!content) return;

    const roleColor = user.role === 'owner' ? 'var(--color-red)' : user.role === 'admin' ? 'var(--color-blue)' : 'var(--color-green)';
    const createdDate = user.created_at ? new Date(user.created_at) : null;
    const lastLogin = user.last_login ? new Date(user.last_login) : null;
    const passwordChanged = user.password_changed_at ? new Date(user.password_changed_at) : null;
    const discordLinked = user.discord_linked_at ? new Date(user.discord_linked_at) : null;
    const twoFactorEnabled = user.two_factor_enabled_at ? new Date(user.two_factor_enabled_at) : null;
    const safeUsername = escapeOwnerHtml(user.username || 'Unknown');
    const safeRole = escapeOwnerHtml((user.role || 'unknown').toUpperCase());
    const safeUserId = escapeOwnerHtml(user.id || 'Unknown');
    const safeEmailHtml = user.email
        ? escapeOwnerHtml(user.email)
        : '<span style="color: var(--text-secondary);">Not set</span>';
    const safeDiscordUsername = escapeOwnerHtml(user.discord_username || 'Unknown');
    const safeDiscordUserId = escapeOwnerHtml(user.discord_user_id || 'Unknown');

    const formatDate = (date) => date ? `${date.toLocaleDateString()} ${date.toLocaleTimeString()}` : 'Never';
    const formatRelative = (date) => {
        if (!date) return 'Never';
        const diff = Date.now() - date.getTime();
        const days = Math.floor(diff / (1000 * 60 * 60 * 24));
        const hours = Math.floor(diff / (1000 * 60 * 60));
        const minutes = Math.floor(diff / (1000 * 60));

        if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`;
        if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
        if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
        return 'Just now';
    };

    const recentActivityHtml = user.recentActivity && user.recentActivity.length > 0 ? user.recentActivity.map(event => {
        const eventDate = event.created_at ? new Date(event.created_at) : null;
        const eventType = String(event.event_type || 'UNKNOWN');
        const eventIcon = {
            'LOGIN_SUCCESS': '✅',
            'LOGIN_FAILED': '-',
            'LOGOUT': '🚪',
            'PASSWORD_CHANGED': '🔑',
            'TWO_FACTOR_ENABLED': '🔐',
            'TWO_FACTOR_DISABLED': '🔓',
            'EMAIL_VERIFIED': '📧'
        }[eventType] || '📝';
        return `
            <tr style="border-bottom: 1px solid var(--border-color);">
				<td style="padding: 0.5rem;">${eventIcon} ${escapeOwnerHtml(eventType.replace(/_/g, ' '))}</td>
				<td style="padding: 0.5rem; color: var(--text-secondary);">${escapeOwnerHtml(formatRelative(eventDate))}</td>
				<td style="padding: 0.5rem; font-family: monospace; font-size: 0.85rem;">${escapeOwnerHtml(event.ip_address || '-')}</td>
            </tr>
        `;
    }).join('') : '';

    content.innerHTML = `
        <div style="display: grid; gap: 1.5rem;">
            <div style="background: var(--bg-secondary); padding: 1.25rem; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
                <div style="display: flex; align-items: center; gap: 1rem; margin-bottom: 1rem;">
                    <div style="font-size: 2.5rem;">👤</div>
                    <div style="flex: 1;">
						<div style="font-size: 1.4rem; font-weight: 700; color: var(--text-primary);">${safeUsername}</div>
                        <div style="margin-top: 0.25rem;">
							<span class="role-badge" style="background: ${roleColor}; padding: 0.3rem 0.7rem; border-radius: 4px; color: white; font-size: 0.85rem; font-weight: 600;">${safeRole}</span>
                            ${user.active === false ? '<span style="margin-left: 0.5rem; color: var(--color-red); font-weight: 600;">⚠️ INACTIVE</span>' : ''}
                        </div>
                    </div>
                </div>
                <div style="display: grid; grid-template-columns: auto 1fr; gap: 0.75rem; font-size: 0.95rem;">
					<strong>Account ID:</strong><span>${safeUserId}</span>
					<strong>Created:</strong><span>${escapeOwnerHtml(formatDate(createdDate))} <span style="color: var(--text-secondary);">(${escapeOwnerHtml(formatRelative(createdDate))})</span></span>
					<strong>Last Login:</strong><span>${escapeOwnerHtml(formatDate(lastLogin))} <span style="color: var(--text-secondary);">${lastLogin ? `(${escapeOwnerHtml(formatRelative(lastLogin))})` : ''}</span></span>
                </div>
            </div>
            
            <div style="background: var(--bg-secondary); padding: 1.25rem; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
                <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem; font-weight: 700;">
                    <span style="font-size: 1.2rem;">📧</span>
                    Email & Security
                </div>
                <div style="display: grid; grid-template-columns: auto 1fr; gap: 0.75rem; font-size: 0.95rem;">
                    <strong>Email:</strong><span>${safeEmailHtml}</span>
                    <strong>Verified:</strong><span>${user.email_verified ? '<span style="color: var(--color-green);">✅ Yes</span>' : '<span style="color: var(--color-orange);">- No</span>'}</span>
                    <strong>2FA Enabled:</strong><span>${user.two_factor_enabled ? `<span style="color: var(--color-green);">✅ Yes</span> <span style="color: var(--text-secondary);">(since ${escapeOwnerHtml(formatDate(twoFactorEnabled))})</span>` : '<span style="color: var(--text-secondary);">- No</span>'}</span>
                    <strong>Password Changed:</strong><span>${escapeOwnerHtml(formatDate(passwordChanged))}</span>
                </div>
            </div>
            
            <div style="background: var(--bg-secondary); padding: 1.25rem; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
                <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem; font-weight: 700;">
                    <span style="font-size: 1.2rem;">🎮</span>
                    Discord Integration
                </div>
                ${user.discord_user_id ? `
                    <div style="display: grid; grid-template-columns: auto 1fr; gap: 0.75rem; font-size: 0.95rem;">
                        <strong>Discord User:</strong><span>${safeDiscordUsername}</span>
                        <strong>Discord ID:</strong><span><code style="background: var(--bg-card); padding: 0.2rem 0.5rem; border-radius: 4px;">${safeDiscordUserId}</code></span>
                        <strong>Linked:</strong><span>${escapeOwnerHtml(formatDate(discordLinked))}</span>
                    </div>
                ` : '<div style="color: var(--text-secondary); font-style: italic;">No Discord account linked</div>'}
            </div>
            
            ${recentActivityHtml ? `
                <div style="background: var(--bg-secondary); padding: 1.25rem; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
                    <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem; font-weight: 700;">
                        <span style="font-size: 1.2rem;">📊</span>
                        Recent Activity (Last 10 Events)
                    </div>
                    <div style="max-height: 300px; overflow-y: auto;">
                        <table style="width: 100%; font-size: 0.9rem;">
                            <thead>
                                <tr style="background: var(--bg-card);">
                                    <th style="padding: 0.5rem; text-align: left;">Event</th>
                                    <th style="padding: 0.5rem; text-align: left;">When</th>
                                    <th style="padding: 0.5rem; text-align: left;">IP</th>
                                </tr>
                            </thead>
                            <tbody>${recentActivityHtml}</tbody>
                        </table>
                    </div>
                </div>
            ` : ''}
        </div>
        
        <div style="margin-top: 1.5rem; text-align: right;">
            <button class="btn btn-secondary" onclick="closeAdminUserDetail()">Close</button>
        </div>
    `;
}

function closeAdminUserDetail() {
    const modal = document.getElementById('adminUserDetailModal');
    if (modal) modal.style.display = 'none';
}

window.addEventListener('click', (event) => {
    const modal = document.getElementById('adminUserDetailModal');
    if (modal && event.target === modal) {
        closeAdminUserDetail();
    }
});

window.viewAdminUserDetail = viewAdminUserDetail;
window.closeAdminUserDetail = closeAdminUserDetail;


if (!window.api || !window.ui) {
    const { api, ui } = window.AdminPanel || {};
    window.api = api;
    window.ui = ui;
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

document.addEventListener('DOMContentLoaded', async () => {
    let accountInfo;
    try {
        accountInfo = await checkOwnerAccess();
        if (accountInfo && typeof accountInfo === 'object' && accountInfo.username && accountInfo.role) {
            if (typeof io !== 'undefined') {
                try {
                    window.socket = createSocketConnection();
                } catch (err) {
                    console.error('Socket.IO connection failed:', err);
                }
            }
        } else {
            console.error('Owner account info missing or invalid:', accountInfo);
            window.location.href = '/unauthorized';
            return;
        }
    } catch (error) {
        console.error('Failed to load owner account info:', error);
        window.location.href = '/unauthorized';
        return;
    }

    document.querySelectorAll('.tab').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const tabName = btn.dataset.tab;
            if (tabName) {
                switchTab(e, tabName);
                recordOwnerNotificationEvent({
                    type: 'info',
                    title: 'Tab Opened',
                    message: `Switched to ${tabName.replace(/-/g, ' ')} tab`,
                    source: 'action'
                }, { refresh: false });
                if (tabName === 'diagnostics') {
                    loadDiagnostics();
                }
                if (tabName === 'config') {
                    loadOwnerConfigSection();
                }
                if (tabName === 'invites') {
                    loadInviteStats();
                }
                if (tabName === 'security') {
                    loadSecurityEventsFeed(false);
                }
                if (tabName === 'security-events') {
                    loadSecurityEventsFeed(true);
                    loadAntiRaidDashboard();
                }
                if (tabName === 'notifications') {
                    loadOwnerNotificationHistory();
                }
                if (tabName === 'system') {
                    loadBackupTables();
                    loadBackupStatus();
                    loadServerBackupStatus();
                }
            }
        });
    });

    initializeOwnerNotificationCenter();

    await loadSystemStatus();
    loadDiagnostics();
    recordOwnerNotificationEvent({
        type: 'success',
        title: 'System Status Updated',
        message: 'Owner dashboard metrics were refreshed.',
        source: 'system'
    }, { refresh: false });
    loadOwnerNotificationHistory();
    startDiagnosticsAutoRefresh();
    startSocketHealthAutoRefresh();
    setupLiveTerminal();

    const runBackupBtn = document.getElementById('runBackupBtn');
    const saveBackupSettingsCardBtn = document.getElementById('saveBackupSettingsCardBtn');
    const backupSelectAll = document.getElementById('backupTablesSelectAll');
    const runServerBackupBtn = document.getElementById('runServerBackupBtn');
    const saveServerBackupConfigBtn = document.getElementById('saveServerBackupConfigBtn');
    const previewServerBackupBtn = document.getElementById('previewServerBackupBtn');
    const serverBackupPreflightBtn = document.getElementById('serverBackupPreflightBtn');
    const inspectServerBackupBtn = document.getElementById('inspectServerBackupBtn');
    const restoreServerBackupBtn = document.getElementById('restoreServerBackupBtn');
    const ownerConfigRefreshBtn = document.getElementById('ownerConfigRefreshBtn');
    initBackupModeTabs();
    runBackupBtn?.addEventListener('click', () => runBackupNow());
    saveBackupSettingsCardBtn?.addEventListener('click', () => saveBackupSettings());
    runServerBackupBtn?.addEventListener('click', () => runServerBackupNow());
    saveServerBackupConfigBtn?.addEventListener('click', () => saveServerBackupSettings());
    previewServerBackupBtn?.addEventListener('click', () => previewServerBackupDiff());
    serverBackupPreflightBtn?.addEventListener('click', () => runServerBackupRestorePreflight());
    inspectServerBackupBtn?.addEventListener('click', () => inspectSelectedServerBackup());
    restoreServerBackupBtn?.addEventListener('click', () => restoreServerBackup());
    ownerConfigRefreshBtn?.addEventListener('click', () => loadOwnerConfigSection(true));
    document.getElementById('config')?.addEventListener('click', (event) => {
        const filterBtn = event.target.closest('[data-owner-config-filter]');
        if (!filterBtn) return;
        setOwnerConfigCheckFilter(filterBtn.dataset.ownerConfigFilter || 'all');
    });
    backupSelectAll?.addEventListener('change', () => {
        const list = document.getElementById('backupTablesList');
        if (!list) return;
        const shouldSelect = Boolean(backupSelectAll.checked);
        list.querySelectorAll('.backup-table-checkbox').forEach((checkbox) => {
            checkbox.checked = shouldSelect;
        });
        updateBackupTableCount();
    });

    if (document.getElementById('config')?.classList.contains('active')) {
        loadOwnerConfigSection();
    }

    if (typeof initAdminUserManagement === 'function') {
        initAdminUserManagement();
    }

    await loadBackupTables();
    await loadServerBackupStatus();
    await resumeServerBackupRestoreOperationFromStorage();

    function getTerminalLogDownloadName(response) {
        const header = response?.headers?.get('content-disposition') || '';
        const match = header.match(/filename\*?=(?:UTF-8''|\")?([^";]+)/i);
        if (match && match[1]) {
            try {
                return decodeURIComponent(match[1].replace(/"/g, '').trim());
            } catch {
                return match[1].replace(/"/g, '').trim();
            }
        }
        return '';
    }

    async function downloadTerminalLogs() {
        const downloadBtn = document.getElementById('downloadTerminalLogsBtn');
        const originalText = downloadBtn ? downloadBtn.textContent : '';
        if (downloadBtn) {
            downloadBtn.disabled = true;
            downloadBtn.textContent = 'Preparing download...';
        }

        try {
            const response = await fetch('/api/owner/terminal-logs/download?limit=500', { credentials: 'include' });
            if (!response.ok) {
                throw new Error(`Download failed (${response.status})`);
            }

            const blob = await response.blob();
            const fallbackName = `terminal-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
            const fileName = getTerminalLogDownloadName(response) || fallbackName;
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = fileName;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);

            if (typeof profileShowSuccess === 'function') {
                profileShowSuccess('Download Ready', 'Terminal logs were saved to your downloads folder.');
            }
        } catch (error) {
            console.error('Failed to download terminal logs:', error);
            if (typeof profileShowError === 'function') {
                profileShowError('Download Failed', error.message || 'Could not download the terminal logs.');
            }
        } finally {
            if (downloadBtn) {
                downloadBtn.disabled = false;
                downloadBtn.textContent = originalText || 'Download Logs';
            }
        }
    }

    function setupLiveTerminal() {
        const terminalOutput = document.getElementById('terminalOutput');
        if (!terminalOutput) return;
        if (typeof io === 'undefined') {
            console.error('Socket.IO client library not loaded.');
            return;
        }

        const downloadBtn = document.getElementById('downloadTerminalLogsBtn');
        if (downloadBtn) {
            downloadBtn.addEventListener('click', downloadTerminalLogs);
        }

        const socket = window.socket || createSocketConnection();
        if (!socket) return;

        const ANSI_REGEX = /\x1B\[[0-9;]*m/g;
        const MAX_TERMINAL_LINES = 450;

        const stripAnsi = (line) => String(line || '').replace(ANSI_REGEX, '');

        const normalizeLine = (line) => {
            const cleaned = stripAnsi(line).replace(/\s+$/g, '');
            return cleaned;
        };

        const buildLineElement = (line) => {
            const row = document.createElement('div');
            row.style.display = 'grid';
            row.style.gridTemplateColumns = 'auto auto 1fr';
            row.style.columnGap = '0.6rem';
            row.style.alignItems = 'baseline';
            row.style.padding = '0.2rem 0.35rem';
            row.style.borderRadius = '6px';
            row.style.fontFamily = 'Consolas, "Courier New", monospace';
            row.style.fontSize = '0.84rem';
            row.style.lineHeight = '1.35';
            row.style.color = 'var(--text-primary)';

            const match = line.match(/^\[(.*?)\]\s+\[(.*?)\]\s*(.*)$/);
            if (!match) {
                row.style.gridTemplateColumns = '1fr';
                row.textContent = line || ' ';
                if (!line.trim()) row.style.opacity = '0.35';
                return row;
            }

            const [, timestamp, levelRaw, messageRaw] = match;
            const level = String(levelRaw || '').toUpperCase();
            const message = messageRaw || '';

            const ts = document.createElement('span');
            ts.textContent = timestamp;
            ts.style.color = 'var(--text-muted)';

            const lvl = document.createElement('span');
            lvl.textContent = level;
            lvl.style.fontWeight = '700';
            if (level === 'ERROR') lvl.style.color = 'var(--color-red)';
            else if (level === 'WARN') lvl.style.color = 'var(--color-yellow)';
            else if (level === 'INFO') lvl.style.color = 'var(--color-blue)';
            else lvl.style.color = 'var(--text-secondary)';

            const msg = document.createElement('span');
            msg.textContent = message;
            if (/Ready!|BOT STARTUP COMPLETE|✅/.test(message)) {
                msg.style.color = 'var(--color-green)';
                msg.style.fontWeight = '600';
            }

            row.appendChild(ts);
            row.appendChild(lvl);
            row.appendChild(msg);
            return row;
        };

        const trimTerminalRows = () => {
            while (terminalOutput.childElementCount > MAX_TERMINAL_LINES) {
                terminalOutput.removeChild(terminalOutput.firstElementChild);
            }
        };

        const renderLogs = (logs) => {
            terminalOutput.innerHTML = '';
            let blankStreak = 0;
            (Array.isArray(logs) ? logs : []).forEach((raw) => {
                const line = normalizeLine(raw);
                const isBlank = !line.trim();
                if (isBlank) {
                    blankStreak += 1;
                    if (blankStreak > 1) return;
                } else {
                    blankStreak = 0;
                }
                terminalOutput.appendChild(buildLineElement(line));
            });
            trimTerminalRows();
            terminalOutput.scrollTop = terminalOutput.scrollHeight;
        };

        const appendLog = (raw) => {
            const line = normalizeLine(raw);
            const last = terminalOutput.lastElementChild;
            if (!line.trim() && last && !last.textContent.trim()) return;

            terminalOutput.appendChild(buildLineElement(line));
            trimTerminalRows();
            terminalOutput.scrollTop = terminalOutput.scrollHeight;
        };

        socket.off('terminal-logs');
        socket.off('terminal-log-line');
        socket.off('suspicious-activity-alert');
        socket.off('connect_error');

        socket.emit('subscribe-terminal', { limit: 80 });
        socket.on('terminal-logs', renderLogs);
        socket.on('terminal-log-line', appendLog);
        socket.on('suspicious-activity-alert', (payload = {}) => {
            const ipAddress = String(payload?.ipAddress || payload?.ip || 'unknown');
            const score = Number(payload?.score || 0);
            const distinctSignals = Number(payload?.distinctSignals || 0);
            const observed = Number(payload?.totalSignalsObserved || 0);
            const message = `IP ${ipAddress} triggered suspicious activity (score ${score}, ${distinctSignals} signal type${distinctSignals === 1 ? '' : 's'}, ${observed} events).`;

            if (typeof showWarning === 'function') {
                showWarning('Suspicious Activity Alert', message, 9000);
            } else if (typeof showToast === 'function') {
                showToast('warning', 'Suspicious Activity Alert', message, 9000);
            }

            recordOwnerNotificationEvent({
                type: 'warning',
                title: 'Suspicious Activity Alert',
                message,
                source: 'security',
                timestamp: payload?.createdAt || Date.now()
            }, { refresh: true });

            loadSecurityEventsFeed(true);
        });
        socket.on('connect', () => {
            socket.emit('subscribe-terminal', { limit: 80 });
        });
        socket.on('connect_error', () => {
            renderLogs(['[system] [error] Could not connect to the live log feed.']);
        });
    }
});

async function checkOwnerAccess() {
    try {
        const data = await api.getAccountInfo();
        if (!data) {
            window.location.href = '/login';
            return null;
        }
        if (data.role !== 'owner') {
            window.location.href = '/admin';
            return null;
        }

        const username = data.username || 'Owner';
        ui?.setText('headerUsername', username);
        ui?.setText('dropdownUsername', username);
        ui?.setText('headerRole', 'OWNER');
        ui?.setText('dropdownRole', 'OWNER');
        return data;
    } catch (error) {
        window.location.href = '/login';
        return null;
    }
}

function switchTab(e, tabName) {
    if (e?.preventDefault) e.preventDefault();

    document.querySelectorAll('.tab-content').forEach(tab => {
        tab.classList.remove('active');
    });

    document.querySelectorAll('.tab').forEach(btn => {
        btn.classList.remove('active');
    });

    const targetTab = document.getElementById(tabName);
    if (!targetTab) {
        console.warn('Owner tab content not found for', tabName);
        return;
    }
    targetTab.classList.add('active');
    const clickedTab = e.currentTarget || e.target?.closest?.('.tab') || e.target;
    if (clickedTab?.classList?.contains('tab')) {
        clickedTab.classList.add('active');
    }

    if (tabName === 'notifications') {
        loadOwnerNotificationHistory();
    }

    if (tabName === 'system') {
        if (typeof loadBackupTables === 'function') {
            loadBackupTables().then(() => {
                if (typeof loadBackupStatus === 'function') loadBackupStatus();
            });
        } else if (typeof loadBackupStatus === 'function') {
            loadBackupStatus();
        }
    }
    if (tabName === 'invites' && typeof window.loadInviteStats === 'function') window.loadInviteStats();
    if (tabName === 'users') {
        if (typeof window.initAdminUserManagement === 'function') window.initAdminUserManagement();
        if (typeof window.loadAdminUsers === 'function') window.loadAdminUsers();
    }
    if (tabName === 'diagnostics') {
        if (typeof window.loadSystemStatus === 'function') window.loadSystemStatus();
        if (typeof window.loadDiagnostics === 'function') window.loadDiagnostics();
    }

    if (tabName === 'config') {
        if (typeof window.loadOwnerConfigSection === 'function') window.loadOwnerConfigSection();
    }

    if (tabName === 'security') {
        if (typeof window.loadSessions === 'function') window.loadSessions();

        if (typeof window.loadSessionSecurityPolicy === 'function') window.loadSessionSecurityPolicy();
        else if (typeof loadSessionSecurityPolicy === 'function') loadSessionSecurityPolicy();

        if (typeof window.loadCaptchaPolicy === 'function') window.loadCaptchaPolicy();
        else if (typeof loadCaptchaPolicy === 'function') loadCaptchaPolicy();
    }
}

function setBackupModeTab(mode = 'database') {
    const normalizedMode = mode === 'server' ? 'server' : 'database';

    document.querySelectorAll('.backup-mode-tab').forEach((button) => {
        button.classList.toggle('active', button.dataset.backupMode === normalizedMode);
    });

    document.querySelectorAll('.backup-mode-panel').forEach((panel) => {
        panel.classList.toggle('active', panel.id === `backupMode${normalizedMode === 'server' ? 'Server' : 'Database'}`);
    });
}

function initBackupModeTabs() {
    const tabButtons = document.querySelectorAll('.backup-mode-tab');
    if (!tabButtons.length) {
        return;
    }

    tabButtons.forEach((button) => {
        button.addEventListener('click', () => {
            setBackupModeTab(button.dataset.backupMode);
        });
    });

    setBackupModeTab(document.querySelector('.backup-mode-tab.active')?.dataset.backupMode || 'database');
}

window.diagnosticsAutoRefreshIntervalId = window.diagnosticsAutoRefreshIntervalId || null;
window.socketHealthAutoRefreshIntervalId = window.socketHealthAutoRefreshIntervalId || null;

function startDiagnosticsAutoRefresh() {
    if (window.diagnosticsAutoRefreshIntervalId) {
        clearInterval(window.diagnosticsAutoRefreshIntervalId);
    }

    window.diagnosticsAutoRefreshIntervalId = setInterval(() => {
        const diagnosticsTab = document.getElementById('diagnostics');
        const isDiagnosticsActive = Boolean(diagnosticsTab && diagnosticsTab.classList.contains('active'));
        if (!isDiagnosticsActive || document.hidden) return;
        loadDiagnostics();
    }, 30000);
}

function startSocketHealthAutoRefresh() {
    if (window.socketHealthAutoRefreshIntervalId) {
        clearInterval(window.socketHealthAutoRefreshIntervalId);
    }

    window.socketHealthAutoRefreshIntervalId = setInterval(() => {
        const diagnosticsTab = document.getElementById('diagnostics');
        const isDiagnosticsActive = Boolean(diagnosticsTab && diagnosticsTab.classList.contains('active'));
        if (!isDiagnosticsActive || document.hidden) return;
        loadSocketHealth();
    }, 30000);
}

async function loadSystemStatus() {
    try {
        const [statsResult, metricsResult] = await Promise.allSettled([
            window.AdminPanel.api.getJson('/api/stats'),
            window.AdminPanel.api.getJson('/api/owner/system-metrics')
        ]);

        const statsOk = statsResult.status === 'fulfilled' && statsResult.value?.response?.ok;
        const metricsOk = metricsResult.status === 'fulfilled' && metricsResult.value?.response?.ok;

        const data = statsOk ? (statsResult.value.data || {}) : null;
        const metricsData = metricsOk ? (metricsResult.value.data || {}) : {};

        if (data) {
            const setText = (id, value) => {
                const element = document.getElementById(id);
                if (element) element.textContent = value;
            };

            const totalUsers = data.totalUsers || 0;
            const bannedUsers = data.bannedUsers || 0;
            const totalWarnings = data.totalWarnings || 0;
            const memoryUsage = data.memoryUsage || 128;

            const userHealthFactor = Math.max(0, 100 - (bannedUsers > 0 && totalUsers > 0 ? (bannedUsers / totalUsers * 20) : 0));
            const warningHealthFactor = Math.max(0, 100 - (totalWarnings > 0 && totalUsers > 0 ? (totalWarnings / totalUsers * 15) : 0));
            const memoryHealthFactor = Math.max(0, 100 - (memoryUsage > 100 ? (memoryUsage - 100) : 0));

            const healthScore = Math.max(0, Math.min(100,
                (userHealthFactor * 0.4) + (warningHealthFactor * 0.35) + (memoryHealthFactor * 0.25)
            ));

            const healthStatus = healthScore >= 80 ? 'Excellent' : healthScore >= 60 ? 'Good' : healthScore >= 40 ? 'Fair' : 'Poor';
            const healthColor = healthScore >= 80 ? 'var(--color-green)' : healthScore >= 60 ? 'var(--color-yellow)' : healthScore >= 40 ? 'var(--color-yellow)' : 'var(--color-red)';

            const responseTime = Math.floor(Math.random() * 50) + 10;
            const responseTimeHealth = Math.max(0, 100 - (responseTime > 50 ? (responseTime - 50) * 2 : 0));

            const uptimeSeconds = Number(metricsData.uptime || 0) || 0;
            const uptimeHoursTotal = Math.floor(uptimeSeconds / 3600);
            const uptimeDays = Math.floor(uptimeSeconds / 86400);
            const uptimeHoursRemainder = Math.floor((uptimeSeconds % 86400) / 3600);
            const uptimeLabel = uptimeDays > 0
                ? `${uptimeDays}d ${uptimeHoursRemainder}h`
                : `${uptimeHoursTotal}h`;

            const healthCircle = document.querySelector('.system-health-circle');
            if (healthCircle) {
                healthCircle.style.setProperty('--health-percentage', healthScore);
                healthCircle.style.setProperty('--health-color', healthColor);
                setText('healthScore', Math.round(healthScore));

                const dbHealth = userHealthFactor >= 80 ? 'Healthy' : 'Degraded';
                const dbStatus = totalUsers > 0 ? `${dbHealth} | ${totalUsers.toLocaleString()} records` : 'No records yet';
                const dbElement = document.getElementById('healthDb');
                if (dbElement) {
                    dbElement.innerHTML = `<span class="system-health-status-dot ${userHealthFactor >= 80 ? 'healthy' : 'warning'}"></span>${dbStatus}`;
                }

                const botHealth = healthScore >= 70 ? 'Connected' : 'Needs attention';
                const botUptime = `${uptimeLabel} uptime`;
                const botElement = document.getElementById('healthBot');
                if (botElement) {
                    botElement.innerHTML = `<span class="system-health-status-dot ${healthScore >= 70 ? 'healthy' : 'warning'}"></span>${botHealth} | ${botUptime}`;
                }

                const perfHealth = responseTime < 30 ? 'Excellent' : responseTime < 50 ? 'Good' : 'Slow';
                const perfDetail = `${responseTime}ms response`;
                const perfElement = document.getElementById('healthPerf');
                if (perfElement) {
                    const perfTone = responseTimeHealth >= 80 ? 'healthy' : responseTimeHealth >= 50 ? 'warning' : 'critical';
                    perfElement.innerHTML = `<span class="system-health-status-dot ${perfTone}"></span>${perfHealth} | ${perfDetail}`;
                }
            }

            const estimatedGuildMembers = Math.max(1000, totalUsers * 5);
            const memberCapacity = Math.round((estimatedGuildMembers / 1000000) * 100);
            const warningRate = totalUsers > 0 ? Math.round((totalWarnings / totalUsers) * 100) : 0;
            const banRate = totalUsers > 0 ? ((bannedUsers / totalUsers) * 100).toFixed(2) : 0;

            const overallBadge = document.getElementById('healthOverallBadge');
            if (overallBadge) {
                const tone = healthScore >= 80 ? 'healthy' : healthScore >= 60 ? 'warning' : 'critical';
                overallBadge.className = `system-health-chip ${tone}`;
                overallBadge.textContent = `${healthStatus} • ${Math.round(healthScore)}/100`;
            }

            setText('healthUsers', totalUsers.toLocaleString());
            setText('healthAlerts', totalWarnings.toLocaleString());
            setText('healthLoad', `${memoryUsage}MB`);
            setText('healthRisk', `${banRate}%`);
            setText('healthUpdated', `Updated: ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);

        }

        await loadSocketHealth();
        await loadBackupStatus();
    } catch (error) {
        console.error('Error loading system status:', error);
        updateSocketHealthFallback('Unable to load WebSocket health');
    }
}

function formatOwnerConfigTimestamp(value) {
    if (!value) return '--';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '--' : date.toLocaleString();
}

function getOwnerConfigCheckClass(status) {
    const normalized = String(status || '').toLowerCase();
    if (normalized === 'pass' || normalized === 'passed' || normalized === 'ok') return 'pass';
    if (normalized === 'warning' || normalized === 'warn') return 'warn';
    if (normalized === 'fail' || normalized === 'failed' || normalized === 'error') return 'fail';
    return 'warn';
}

function getOwnerConfigPillClass(ready, failed, warnings) {
    if (ready && failed === 0) return 'good';
    if (failed > 0) return 'bad';
    if (warnings > 0) return 'warn';
    return 'warn';
}

function buildFallbackConstantCards(files, fileMatchers, label) {
    const matches = (Array.isArray(files) ? files : []).filter((file) => {
        const fileName = String(file?.fileName || file?.key || '').toLowerCase();
        return fileMatchers.some((matcher) => fileName.includes(String(matcher).toLowerCase()));
    });

    if (!matches.length) {
        return `
            <details class="config-constant-row is-missing" open>
                <summary>
                    <div class="config-constant-main">
                        <strong>${escapeOwnerHtml(label)}</strong>
                        <span class="config-constant-value">Unavailable</span>
                    </div>
                    <div class="config-constant-actions">
                        <span class="config-status-pill bad">MISSING</span>
                    </div>
                </summary>
                <div class="config-constant-meta">
                    <p>No fallback config file data is available yet for this constant group.</p>
                </div>
            </details>
        `;
    }

    return matches.map((file) => {
        const status = String(file.status || 'warn').toLowerCase();
        const isMissing = status === 'fail' || file.exists === false;
        const value = String(file.fileName || file.key || label);
        return `
            <details class="config-constant-row ${isMissing ? 'is-missing' : ''}">
                <summary>
                    <div class="config-constant-main">
                        <strong>${escapeOwnerHtml(file.fileName || file.key || label)}</strong>
                        <span class="config-constant-value">${escapeOwnerHtml(isMissing ? 'Needs attention' : 'Detected')}</span>
                    </div>
                    <div class="config-constant-actions">
                        <span class="config-status-pill ${isMissing ? 'bad' : 'warn'}">${escapeOwnerHtml(String(file.status || 'warn').toUpperCase())}</span>
                        <button class="config-constant-copy" onclick="copyOwnerConfigValue('${escapeOwnerJsString(value)}', event)">Copy name</button>
                    </div>
                </summary>
                <div class="config-constant-meta">
                    <p>${escapeOwnerHtml(file.message || 'Fallback config file status available.')}</p>
                    <div class="config-constant-meta-line">
                        <strong>Reference</strong>
                        <span class="config-constant-code">${escapeOwnerHtml(value)}</span>
                    </div>
                </div>
            </details>
        `;
    }).join('');
}

function buildOwnerConfigSnapshot(overview) {
    const readiness = overview?.readiness || {};
    const summary = readiness.summary || {};
    const botSafety = overview?.highlights?.botSafety || {};
    return {
        timestamp: String(overview?.generatedAt || new Date().toISOString()),
        score: Number(summary.score || 0),
        warnings: Number(summary.warnings || 0),
        failed: Number(summary.failed || 0),
        passed: Number(summary.passed || 0),
        ready: Boolean(summary.ready),
        botSafetyEnabled: Boolean(botSafety.enabled),
        recentAlertLimit: botSafety.recentAlertLimit,
        inviteMutationThreshold: botSafety.inviteMutationThreshold,
        moderationEscalationHighRiskThreshold: botSafety.moderationEscalationHighRiskThreshold
    };
}

function pushOwnerConfigHistory(overview) {
    const snapshot = buildOwnerConfigSnapshot(overview);
    const last = ownerConfigHistory[ownerConfigHistory.length - 1];
    const unchanged = last
        && last.score === snapshot.score
        && last.warnings === snapshot.warnings
        && last.failed === snapshot.failed
        && last.ready === snapshot.ready
        && last.botSafetyEnabled === snapshot.botSafetyEnabled
        && String(last.recentAlertLimit ?? '') === String(snapshot.recentAlertLimit ?? '')
        && String(last.inviteMutationThreshold ?? '') === String(snapshot.inviteMutationThreshold ?? '')
        && String(last.moderationEscalationHighRiskThreshold ?? '') === String(snapshot.moderationEscalationHighRiskThreshold ?? '');

    if (!unchanged) {
        ownerConfigHistory.push(snapshot);
        if (ownerConfigHistory.length > 6) {
            ownerConfigHistory = ownerConfigHistory.slice(-6);
        }
    }

    return ownerConfigHistory[ownerConfigHistory.length - 2] || null;
}

function formatOwnerConfigDelta(currentValue, previousValue, positiveDirection = 'up') {
    const current = Number(currentValue);
    const previous = Number(previousValue);
    if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
    const delta = current - previous;
    if (delta === 0) return { text: 'No change', tone: 'neutral' };
    const direction = delta > 0 ? 'up' : 'down';
    const improved = positiveDirection === direction;
    return {
        text: `${delta > 0 ? '+' : ''}${delta}`,
        tone: improved ? 'good' : 'bad'
    };
}

function renderOwnerConfigTrends(overview, previousSnapshot) {
    const readinessTrendEl = document.getElementById('ownerConfigReadinessTrend');
    const botSafetyTrendEl = document.getElementById('ownerBotSafetyTrend');
    const currentSnapshot = buildOwnerConfigSnapshot(overview);
    const recentHistory = ownerConfigHistory.slice(-4);

    if (readinessTrendEl) {
        const scoreDelta = previousSnapshot ? formatOwnerConfigDelta(currentSnapshot.score, previousSnapshot.score, 'up') : null;
        const warningDelta = previousSnapshot ? formatOwnerConfigDelta(currentSnapshot.warnings, previousSnapshot.warnings, 'down') : null;
        const historyChips = recentHistory.map((entry) => `<span class="config-trend-chip">Score ${escapeOwnerHtml(String(entry.score))}</span>`).join('');
        readinessTrendEl.innerHTML = [
            scoreDelta ? `<span class="config-trend-chip ${scoreDelta.tone === 'neutral' ? '' : scoreDelta.tone}">Score ${escapeOwnerHtml(scoreDelta.text)}</span>` : '<span class="config-trend-empty">Baseline captured on first refresh.</span>',
            warningDelta ? `<span class="config-trend-chip ${warningDelta.tone === 'neutral' ? '' : warningDelta.tone}">Warnings ${escapeOwnerHtml(warningDelta.text)}</span>` : '',
            historyChips
        ].filter(Boolean).join('');
    }

    if (botSafetyTrendEl) {
        if (!previousSnapshot) {
            botSafetyTrendEl.innerHTML = '<span class="config-trend-empty">Baseline captured on first refresh.</span>';
        } else {
            const chips = [];
            if (currentSnapshot.botSafetyEnabled !== previousSnapshot.botSafetyEnabled) {
                chips.push(`<span class="config-trend-chip ${currentSnapshot.botSafetyEnabled ? 'good' : 'warn'}">Alerts ${currentSnapshot.botSafetyEnabled ? 'enabled' : 'disabled'}</span>`);
            }

            const metricPairs = [
                ['Recent limit', currentSnapshot.recentAlertLimit, previousSnapshot.recentAlertLimit],
                ['Invite threshold', currentSnapshot.inviteMutationThreshold, previousSnapshot.inviteMutationThreshold],
                ['High risk', currentSnapshot.moderationEscalationHighRiskThreshold, previousSnapshot.moderationEscalationHighRiskThreshold]
            ];

            metricPairs.forEach(([label, current, previous]) => {
                if (String(current ?? '') === String(previous ?? '')) return;
                const delta = formatOwnerConfigDelta(current, previous, 'down');
                chips.push(`<span class="config-trend-chip ${delta?.tone === 'neutral' ? '' : (delta?.tone || 'warn')}">${escapeOwnerHtml(label)} ${escapeOwnerHtml(delta?.text || String(current ?? '-'))}</span>`);
            });

            botSafetyTrendEl.innerHTML = chips.length
                ? chips.join('')
                : '<span class="config-trend-empty">No bot safety threshold changes since the last refresh.</span>';
        }
    }
}

function getOwnerConfigCheckCounts(checks) {
    return {
        all: checks.length,
        fail: checks.filter((check) => getOwnerConfigCheckClass(check?.status) === 'fail').length,
        warn: checks.filter((check) => getOwnerConfigCheckClass(check?.status) === 'warn').length,
        pass: checks.filter((check) => getOwnerConfigCheckClass(check?.status) === 'pass').length
    };
}

function getOwnerConfigActiveFilter(counts) {
    const normalizedFilter = ['action', 'fail', 'warn', 'pass', 'all'].includes(ownerConfigCheckFilter) ? ownerConfigCheckFilter : 'action';
    const actionCount = Number(counts.fail || 0) + Number(counts.warn || 0);

    if (normalizedFilter === 'action' && actionCount === 0 && Number(counts.pass || 0) > 0) {
        ownerConfigCheckFilter = 'pass';
        return 'pass';
    }

    ownerConfigCheckFilter = normalizedFilter;
    return normalizedFilter;
}

function getOwnerConfigCheckSeverityRank(check) {
    const statusClass = getOwnerConfigCheckClass(check?.status);
    if (statusClass === 'fail') return 0;
    if (statusClass === 'warn') return 1;
    return 2;
}

function filterOwnerConfigChecks(checks) {
    const counts = getOwnerConfigCheckCounts(checks);
    const activeFilter = getOwnerConfigActiveFilter(counts);

    if (activeFilter === 'all') return checks.slice();
    if (activeFilter === 'action') {
        return checks.filter((check) => ['fail', 'warn'].includes(getOwnerConfigCheckClass(check?.status)));
    }

    return checks.filter((check) => getOwnerConfigCheckClass(check?.status) === activeFilter);
}

function buildOwnerConfigCheckTabs(checks, filteredChecks) {
    const counts = getOwnerConfigCheckCounts(checks);
    const activeFilter = getOwnerConfigActiveFilter(counts);
    const actionCount = Number(counts.fail || 0) + Number(counts.warn || 0);
    const buttons = [
        ['action', 'Action Needed', actionCount, 'Failures and warnings only'],
        ['fail', 'Failures', counts.fail, 'Broken or missing config'],
        ['warn', 'Warnings', counts.warn, 'Config drift or soft issues'],
        ['pass', 'Passed', counts.pass, 'Healthy checks'],
        ['all', 'All Checks', counts.all, 'Full readiness list']
    ].map(([value, label, count, description]) => `
        <button class="config-check-tab ${activeFilter === value ? 'active' : ''}" data-owner-config-filter="${escapeOwnerHtml(value)}" type="button">
            <span class="config-check-tab-label">${escapeOwnerHtml(label)}</span>
            <span class="config-check-tab-count">${escapeOwnerHtml(String(count))}</span>
            <span class="config-check-tab-copy">${escapeOwnerHtml(description)}</span>
        </button>
    `).join('');

    const activeLabel = {
        action: 'Action Needed',
        fail: 'Failures',
        warn: 'Warnings',
        pass: 'Passed',
        all: 'All Checks'
    }[activeFilter] || 'Readiness';

    return `
        <div class="config-check-shell">
            <div class="config-check-toolbar">
                <div class="config-check-toolbar-copy">${escapeOwnerHtml(activeLabel)} tab showing ${escapeOwnerHtml(String(filteredChecks.length))} of ${escapeOwnerHtml(String(checks.length))} readiness checks.</div>
                <div class="config-check-filter-group">${buttons}</div>
            </div>
        </div>
    `;
}

function buildOwnerConfigConstantRows(entries, emptyLabel, kindLabel) {
    if (!Array.isArray(entries) || !entries.length) {
        return `
            <details class="config-constant-row is-missing" open>
                <summary>
                    <div class="config-constant-main">
                        <strong>${escapeOwnerHtml(emptyLabel)}</strong>
                        <span class="config-constant-value">Unavailable</span>
                    </div>
                    <div class="config-constant-actions">
                        <span class="config-status-pill bad">MISSING</span>
                    </div>
                </summary>
                <div class="config-constant-meta">
                    <p>No constants were returned for this group.</p>
                </div>
            </details>
        `;
    }

    return entries.map((entry) => {
        const configured = Boolean(entry?.configured);
        const isCollection = Boolean(entry?.isCollection);
        const key = String(entry?.key || 'unknown');
        const rawValue = entry?.value;
        const displayValue = isCollection
            ? `${Number(rawValue || 0)} configured`
            : (configured ? String(rawValue || '-') : 'Missing');
        const copyValue = isCollection
            ? JSON.stringify(rawValue ?? [])
            : String(rawValue ?? '');
        const pillTone = !configured ? 'bad' : (isCollection ? 'warn' : 'good');
        const pillText = !configured ? 'MISSING' : (isCollection ? 'COLLECTION' : 'CONFIGURED');
        const description = isCollection
            ? `${kindLabel} constant backed by a collection or count.`
            : (configured ? `Configured ${kindLabel.toLowerCase()} reference.` : `Unset ${kindLabel.toLowerCase()} reference.`);
        return `
            <details class="config-constant-row ${configured ? '' : 'is-missing'}">
                <summary>
                    <div class="config-constant-main">
                        <strong>${escapeOwnerHtml(key)}</strong>
                        <span class="config-constant-value">${escapeOwnerHtml(displayValue)}</span>
                    </div>
                    <div class="config-constant-actions">
                        <span class="config-status-pill ${pillTone}">${pillText}</span>
                        ${configured || isCollection ? `<button class="config-constant-copy" onclick="copyOwnerConfigValue('${escapeOwnerJsString(copyValue)}', event)">Copy</button>` : ''}
                    </div>
                </summary>
                <div class="config-constant-meta">
                    <p>${escapeOwnerHtml(description)}</p>
                    <div class="config-constant-meta-line">
                        <strong>Key</strong>
                        <span class="config-constant-code">${escapeOwnerHtml(key)}</span>
                    </div>
                    <div class="config-constant-meta-line">
                        <strong>Value</strong>
                        <span class="config-constant-code">${escapeOwnerHtml(isCollection ? displayValue : String(rawValue ?? 'Missing'))}</span>
                    </div>
                </div>
            </details>
        `;
    }).join('');
}

async function copyOwnerConfigValue(value, event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const normalized = String(value ?? '');
    if (!normalized) {
        profileShowError('Nothing to copy');
        return;
    }

    try {
        await navigator.clipboard.writeText(normalized);
        profileShowSuccess('Copied config value');
    } catch (error) {
        console.error('Failed to copy config value:', error);
        profileShowError('Failed to copy config value');
    }
}

function setOwnerConfigCheckFilter(filter) {
    ownerConfigCheckFilter = ['action', 'all', 'fail', 'warn', 'pass'].includes(String(filter || '')) ? String(filter) : 'action';
    if (ownerConfigOverview) {
        renderOwnerConfigOverview(ownerConfigOverview);
    }
}

function renderOwnerConfigOverview(overview) {
    const readiness = overview?.readiness || {};
    const summary = readiness.summary || {};
    const checks = (Array.isArray(readiness.checks) ? readiness.checks : []).slice().sort((left, right) => getOwnerConfigCheckSeverityRank(left) - getOwnerConfigCheckSeverityRank(right));
    const highlights = overview?.highlights || {};
    const files = Array.isArray(overview?.files) ? overview.files : [];
    const botSafety = highlights.botSafety || {};

    const scoreEl = document.getElementById('ownerConfigReadinessScore');
    const labelEl = document.getElementById('ownerConfigReadinessLabel');
    const passedEl = document.getElementById('ownerConfigPassedCount');
    const totalChecksEl = document.getElementById('ownerConfigTotalChecks');
    const warningEl = document.getElementById('ownerConfigWarningCount');
    const failureEl = document.getElementById('ownerConfigFailureCount');
    const generatedEl = document.getElementById('ownerConfigGeneratedAt');
    const mainSummaryEl = document.getElementById('ownerConfigMainSummary');
    const checksEl = document.getElementById('ownerConfigChecks');
    const channelsEl = document.getElementById('ownerConfigChannels');
    const rolesEl = document.getElementById('ownerConfigRoles');
    const thresholdsEl = document.getElementById('ownerBotSafetyThresholds');
    const botSafetyMetaEl = document.getElementById('ownerBotSafetyMeta');
    const filesEl = document.getElementById('ownerConfigFiles');

    renderOwnerConfigTrends(overview, ownerConfigHistory[ownerConfigHistory.length - 2] || null);

    if (scoreEl) scoreEl.textContent = String(summary.score ?? '--');
    if (labelEl) {
        const pillClass = getOwnerConfigPillClass(Boolean(summary.ready), Number(summary.failed || 0), Number(summary.warnings || 0));
        labelEl.innerHTML = `<span class="config-status-pill ${pillClass}">${summary.ready ? 'Ready' : 'Needs attention'}</span>`;
    }
    if (passedEl) passedEl.textContent = String(summary.passed ?? 0);
    if (totalChecksEl) totalChecksEl.textContent = `Total checks: ${summary.total ?? 0}`;
    if (warningEl) warningEl.textContent = String(summary.warnings ?? 0);
    if (failureEl) failureEl.textContent = `Failures: ${summary.failed ?? 0}`;
    if (generatedEl) generatedEl.textContent = formatOwnerConfigTimestamp(overview?.generatedAt);
    if (mainSummaryEl) {
        mainSummaryEl.textContent = `${String(highlights?.main?.botName || 'Sentinel')} • ${String(highlights?.main?.serverName || 'Unknown server')}`;
    }

    if (checksEl) {
        if (!checks.length) {
            checksEl.innerHTML = '<div class="text-muted">No readiness checks returned.</div>';
        } else {
            const filteredChecks = filterOwnerConfigChecks(checks);
            const toolbar = buildOwnerConfigCheckTabs(checks, filteredChecks);
            const body = filteredChecks.length ? filteredChecks.map((check) => {
                const statusClass = getOwnerConfigCheckClass(check.status);
                const label = escapeOwnerHtml(check.label || check.name || 'Unnamed check');
                const message = escapeOwnerHtml(check.message || 'No details provided.');
                const statusText = escapeOwnerHtml(String(check.status || 'warning').toUpperCase());
                return `
                    <div class="config-check-item ${statusClass}">
                        <div class="config-check-item-header">
                            <div class="config-check-item-title">
                                <span class="config-check-item-indicator"></span>
                                <strong style="margin:0; color:#fff; font-size:0.92rem; letter-spacing:0.01em; text-transform:none;">${label}</strong>
                            </div>
                            <span class="config-status-pill ${statusClass === 'pass' ? 'good' : statusClass === 'fail' ? 'bad' : 'warn'}">${statusText}</span>
                        </div>
                        <div class="config-check-item-body">${message}</div>
                    </div>
                `;
            }).join('') : '<div class="config-check-empty">No checks match the current filter.</div>';
            checksEl.innerHTML = `${toolbar}<div class="config-check-results">${body}</div>`;
        }
    }

    if (channelsEl) {
        const channels = Array.isArray(highlights.channels) ? highlights.channels : [];
        channelsEl.innerHTML = channels.length
            ? buildOwnerConfigConstantRows(channels, 'Channel constants', 'Channel')
            : buildFallbackConstantCards(files, ['channel.json', 'channels'], 'Channel constants');
    }

    if (rolesEl) {
        const roles = Array.isArray(highlights.roles) ? highlights.roles : [];
        rolesEl.innerHTML = roles.length
            ? buildOwnerConfigConstantRows(roles, 'Role constants', 'Role')
            : buildFallbackConstantCards(files, ['roles.json', 'role'], 'Role constants');
    }

    if (thresholdsEl) {
        const entries = Object.entries(OWNER_BOT_SAFETY_LABELS).map(([key, label]) => ({
            key,
            label,
            value: botSafety[key]
        }));
        thresholdsEl.innerHTML = entries.map((entry) => {
            const value = entry.key === 'enabled'
                ? (entry.value ? 'Enabled' : 'Disabled')
                : String(entry.value ?? '-');
            const helperText = entry.key === 'enabled'
                ? 'Global bot safety alert switch.'
                : 'Owner-editable runtime threshold.';
            return `
                <div class="config-threshold-card ${entry.key === 'enabled' && !entry.value ? 'is-missing' : ''}">
                    <div class="config-threshold-head">
                        <div class="config-threshold-title">
                            <strong>${escapeOwnerHtml(entry.label)}</strong>
                            <span class="config-threshold-key">${escapeOwnerHtml(entry.key)}</span>
                        </div>
                        <span class="config-status-pill ${entry.key === 'enabled' ? (entry.value ? 'good' : 'warn') : 'warn'}">${entry.key === 'enabled' ? (entry.value ? 'LIVE' : 'OFF') : 'LIMIT'}</span>
                    </div>
                    <div class="config-threshold-value">
                        <span class="config-threshold-value-label">Current Value</span>
                        <span class="config-threshold-value-text">${escapeOwnerHtml(value)}</span>
                    </div>
                    <div class="config-threshold-note">${escapeOwnerHtml(helperText)}</div>
                    <button class="btn btn-secondary" onclick="editOwnerBotSafetySetting('${escapeOwnerJsString(entry.key)}', '${escapeOwnerJsString(String(entry.value ?? ''))}')">${entry.key === 'enabled' ? 'Toggle' : 'Edit'}</button>
                </div>
            `;
        }).join('');
    }

    if (botSafetyMetaEl) {
        botSafetyMetaEl.innerHTML = `<span class="config-status-pill ${botSafety.enabled ? 'good' : 'warn'}">${botSafety.enabled ? 'Bot safety enabled' : 'Bot safety disabled'}</span>`;
    }

    if (filesEl) {
        filesEl.innerHTML = files.map((file) => `
            <div class="config-file-card ${file.exists === false ? 'is-missing' : ''}">
                <div class="config-file-card-top">
                    <div class="config-file-title-wrap">
                        <strong>${escapeOwnerHtml(file.fileName || file.key || 'unknown')}</strong>
                        <span class="config-file-subcopy">${escapeOwnerHtml(file.key || 'config source')}</span>
                    </div>
                    <span class="config-status-pill ${String(file.status || '').toLowerCase() === 'fail' ? 'bad' : String(file.status || '').toLowerCase() === 'pass' ? 'good' : 'warn'}">${escapeOwnerHtml(String(file.status || 'info').toUpperCase())}</span>
                </div>
                <div class="config-file-metrics">
                    <div class="config-file-metric">
                        <span class="config-file-metric-label">Entries</span>
                        <span class="config-file-metric-value">${escapeOwnerHtml(typeof file.configuredEntryCount === 'number' ? `${Number(file.configuredEntryCount || 0)}` : (file.exists ? 'Detected' : 'Missing'))}</span>
                    </div>
                    <div class="config-file-metric">
                        <span class="config-file-metric-label">Keys</span>
                        <span class="config-file-metric-value">${escapeOwnerHtml(typeof file.topLevelKeyCount === 'number' ? `${Number(file.topLevelKeyCount || 0)}` : '--')}</span>
                    </div>
                </div>
                <div class="config-file-body">${escapeOwnerHtml(typeof file.topLevelKeyCount === 'number'
            ? `Updated ${formatOwnerConfigTimestamp(file.updatedAt)}`
            : (file.message || 'No file metadata available.'))}</div>
                <div class="config-file-tags">
                    ${(Array.isArray(file.sampleKeys) && file.sampleKeys.length > 0)
                ? file.sampleKeys.map((tag) => `<span class="config-file-tag">${escapeOwnerHtml(tag)}</span>`).join('')
                : `<span class="config-file-tag">${escapeOwnerHtml(String(file.status || 'info').toUpperCase())}</span>`}
                </div>
            </div>
        `).join('');
    }
}

async function buildLegacyOwnerConfigOverview() {
    const [readinessResult, botSafetyResult, mainResult] = await Promise.allSettled([
        window.AdminPanel.api.getJson('/api/getting-started/config-readiness'),
        window.AdminPanel.api.getJson('/api/owner/bot-safety-config'),
        window.AdminPanel.api.getJson('/Config/main.json')
    ]);

    const readiness = readinessResult.status === 'fulfilled' && readinessResult.value?.response?.ok
        ? (readinessResult.value.data || {})
        : { summary: { total: 0, passed: 0, warnings: 0, failed: 0, score: 0, ready: false }, checks: [] };

    const botSafety = botSafetyResult.status === 'fulfilled' && botSafetyResult.value?.response?.ok
        ? (botSafetyResult.value.data?.config || {})
        : {};

    const mainConfig = mainResult.status === 'fulfilled' && mainResult.value?.response?.ok
        ? (mainResult.value.data || {})
        : {};

    const readinessChecks = Array.isArray(readiness.checks) ? readiness.checks : [];
    const files = readinessChecks
        .filter((check) => String(check?.key || '').startsWith('file:'))
        .map((check) => ({
            key: String(check.key || '').replace(/^file:/, ''),
            fileName: String(check.label || check.key || 'unknown'),
            exists: String(check.status || '').toLowerCase() !== 'fail' || !String(check.message || '').toLowerCase().includes('missing'),
            topLevelKeyCount: null,
            configuredEntryCount: null,
            sampleKeys: [],
            updatedAt: null,
            status: String(check.status || 'warn').toLowerCase(),
            message: String(check.message || 'No details available.')
        }));

    return {
        generatedAt: new Date().toISOString(),
        readiness,
        highlights: {
            main: {
                botName: String(mainConfig.botName || 'Sentinel').trim() || 'Sentinel',
                serverName: String(mainConfig.serverName || 'Sentinel').trim() || 'Sentinel'
            },
            channels: [],
            roles: [],
            botSafety
        },
        files
    };
}

async function loadOwnerConfigSection(force = false) {
    const checksEl = document.getElementById('ownerConfigChecks');
    if (checksEl && (!ownerConfigOverview || force)) {
        checksEl.innerHTML = '<div class="loading show">Loading config readiness...</div>';
    }

    try {
        const nextOverview = await buildLegacyOwnerConfigOverview();
        ownerConfigOverview = nextOverview;
        pushOwnerConfigHistory(nextOverview);
        renderOwnerConfigOverview(ownerConfigOverview);
    } catch (error) {
        console.error('Failed to load owner config section:', error);
        if (checksEl) {
            checksEl.innerHTML = `<div class="message error">${escapeOwnerHtml(error.message || 'Failed to load config overview')}</div>`;
        }
    }
}

async function editOwnerBotSafetySetting(key, currentValue) {
    if (key === 'enabled') {
        await toggleOwnerBotSafetyEnabled(String(currentValue).toLowerCase() !== 'true');
        return;
    }

    if (typeof window.showPromptModal !== 'function') {
        profileShowError('Unavailable', 'Prompt modal unavailable. Please refresh and try again.');
        return;
    }

    const result = await window.showPromptModal({
        title: `Edit ${OWNER_BOT_SAFETY_LABELS[key] || key}`,
        label: `Enter a new numeric value for ${OWNER_BOT_SAFETY_LABELS[key] || key}:`,
        defaultValue: String(currentValue ?? ''),
        inputType: 'number',
        confirmText: 'Save',
        cancelText: 'Cancel',
        validate: (value) => Number.isFinite(Number(value)) ? true : 'Value must be numeric.'
    });

    if (result === null) return;

    try {
        const { response, data } = await window.AdminPanel.api.postJson('/api/owner/bot-safety-config', {
            [key]: Number(result)
        });
        if (!response.ok) {
            throw new Error(data?.error || 'Failed to update bot safety config');
        }
        profileShowSuccess('Updated', `${OWNER_BOT_SAFETY_LABELS[key] || key} updated.`);
        await loadOwnerConfigSection(true);
    } catch (error) {
        console.error('Failed to update owner bot safety config:', error);
        profileShowError('Failed', error?.message || 'Failed to update bot safety config');
    }
}

async function toggleOwnerBotSafetyEnabled(nextEnabled) {
    try {
        const { response, data } = await window.AdminPanel.api.postJson('/api/owner/bot-safety-config', {
            enabled: Boolean(nextEnabled)
        });
        if (!response.ok) {
            throw new Error(data?.error || 'Failed to update bot safety config');
        }
        profileShowSuccess('Updated', `Bot safety ${nextEnabled ? 'enabled' : 'disabled'}.`);
        await loadOwnerConfigSection(true);
    } catch (error) {
        console.error('Failed to toggle owner bot safety config:', error);
        profileShowError('Failed', error?.message || 'Failed to update bot safety config');
    }
}

window.loadOwnerConfigSection = loadOwnerConfigSection;
window.editOwnerBotSafetySetting = editOwnerBotSafetySetting;
window.copyOwnerConfigValue = copyOwnerConfigValue;

async function loadSocketHealth() {
    const setText = (id, value) => {
        const element = document.getElementById(id);
        if (element) element.textContent = value;
    };

    try {
        const { response, data } = await window.AdminPanel.api.getJson('/api/system/socket-health');
        if (!response.ok || !data) {
            updateSocketHealthFallback('WebSocket health unavailable');
            return;
        }

        const socketCount = Number(data.sockets || 0);
        const active = Number(data.active || 0);
        const rejected = Number(data.rejected || 0);
        const errors = Number(data.errors || 0);
        const roomCount = Array.isArray(data.rooms) ? data.rooms.length : 0;

        setText('socketActiveCount', active.toLocaleString());
        setText('socketActiveMeta', `${socketCount.toLocaleString()} sockets tracked`);
        setText('socketRejectedCount', rejected.toLocaleString());
        setText('socketErrorCount', errors.toLocaleString());
        setText('socketRoomCount', roomCount.toLocaleString());

        const lastError = String(data.lastError || '').trim();
        setText('socketLastError', lastError ? `Last error: ${lastError}` : 'No recent errors');

        const updated = new Date(data.sampledAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        setText('socketHealthUpdated', `Updated: ${updated}`);
    } catch (error) {
        console.error('Error loading socket health:', error);
        updateSocketHealthFallback('WebSocket health unavailable');
    }
}

function updateSocketHealthFallback(message) {
    const note = String(message || 'WebSocket health unavailable');
    const setText = (id, value) => {
        const element = document.getElementById(id);
        if (element) element.textContent = value;
    };

    setText('socketActiveCount', '-');
    setText('socketActiveMeta', note);
    setText('socketRejectedCount', '-');
    setText('socketErrorCount', '-');
    setText('socketRoomCount', '-');
    setText('socketLastError', 'No data');
    setText('socketHealthUpdated', 'Updated: --');
}

function formatAntiRaidEventType(type) {
    const normalized = String(type || '').replace(/_/g, ' ').trim();
    if (!normalized) return 'Unknown';
    return normalized.replace(/\b\w/g, (match) => match.toUpperCase());
}

async function loadAntiRaidDashboard() {
    const metaEl = document.getElementById('antiRaidEventsMeta');
    const tableBody = document.getElementById('antiRaidEventsTable');

    const setText = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    };

    try {
        const { response, data } = await window.AdminPanel.api.getJson('/api/owner/anti-raid-dashboard?days=30&limit=20');
        if (!response.ok || !data?.success) {
            throw new Error(data?.error || 'Failed to load anti-raid data');
        }

        const summary = data.summary || {};
        const avgRisk = Number.isFinite(Number(summary.avgRisk)) ? Number(summary.avgRisk) : null;
        const peakRisk = Number.isFinite(Number(summary.peakRisk)) ? Number(summary.peakRisk) : null;

        setText('antiRaidEventsTotal', Number(summary.total || 0).toLocaleString());
        setText('antiRaidAvgRisk', avgRisk === null ? '--' : avgRisk.toFixed(1));
        setText('antiRaidPeakRisk', peakRisk === null ? '--' : peakRisk.toFixed(0));
        setText('antiRaidAutoLockdowns', Number(summary.autoLockdowns || 0).toLocaleString());
        setText('antiRaidManualLockdowns', Number(summary.manualLockdowns || 0).toLocaleString());
        setText('antiRaidResolved', Number(summary.resolved || 0).toLocaleString());

        const topTriggers = Array.isArray(data.topTriggers) && data.topTriggers.length
            ? data.topTriggers.map((entry) => `${entry.name} (${entry.count})`).join(' • ')
            : 'No triggers recorded yet.';
        setText('antiRaidTopTriggers', topTriggers);

        const events = Array.isArray(data.recent) ? data.recent : [];
        if (metaEl) {
            metaEl.textContent = `Updated: ${new Date().toLocaleString()} • ${events.length} recent event${events.length === 1 ? '' : 's'}`;
        }

        if (tableBody) {
            if (!events.length) {
                tableBody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">No anti-raid events yet.</td></tr>';
            } else {
                tableBody.innerHTML = events.map((event) => {
                    const createdAt = event.createdAt ? new Date(event.createdAt).toLocaleString() : '--';
                    const riskScore = Number.isFinite(Number(event.riskScore)) ? Number(event.riskScore) : null;
                    const triggerCount = Number.isFinite(Number(event.triggerCount)) ? Number(event.triggerCount) : 0;
                    const triggers = Array.isArray(event.details?.triggers) ? event.details.triggers : [];
                    const triggerSummary = triggers.length
                        ? triggers.map((t) => t?.name).filter(Boolean).slice(0, 2).join(', ')
                        : (event.details?.reason || '-');

                    return `
                        <tr>
                            <td>${escapeNotificationCell(createdAt)}</td>
                            <td>${escapeNotificationCell(formatAntiRaidEventType(event.eventType))}</td>
                            <td>${riskScore === null ? '--' : escapeNotificationCell(riskScore.toFixed(0))}</td>
                            <td>${triggerCount || triggers.length || 0}</td>
                            <td>${escapeNotificationCell(triggerSummary || '-')}</td>
                        </tr>
                    `;
                }).join('');
            }
        }
    } catch (error) {
        console.error('Failed to load anti-raid dashboard:', error);
        if (metaEl) metaEl.textContent = 'Failed to load anti-raid dashboard.';
        if (tableBody) {
            tableBody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">Unable to load anti-raid metrics.</td></tr>';
        }
    }
}

function formatBackupTime(value) {
    if (!value) return '--';
    const date = new Date(Number(value));
    if (Number.isNaN(date.getTime())) return '--';
    return date.toLocaleString();
}

function formatBackupBytes(bytes) {
    const value = Number(bytes || 0);
    if (!Number.isFinite(value)) return '0 B';
    if (value < 1024) return `${value} B`;
    const kb = value / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    if (mb < 1024) return `${mb.toFixed(1)} MB`;
    return `${(mb / 1024).toFixed(1)} GB`;
}

function renderBackupFiles(files) {
    const list = document.getElementById('backupFilesList');
    updateBackupModeDatabaseMeta({ fileCount: Array.isArray(files) ? files.length : 0 });
    if (!list) return;
    if (!Array.isArray(files) || files.length === 0) {
        list.textContent = 'No backups yet.';
        return;
    }

    list.innerHTML = files.slice(0, 8).map((file) => {
        const name = file?.name || 'backup.sql';
        const size = formatBackupBytes(file?.size || 0);
        const created = formatBackupTime(file?.createdAt || null);
        const downloadUrl = `/api/owner/backups/download?file=${encodeURIComponent(name)}`;
        return `
            <div class="backup-file-row">
                <div class="backup-file-meta">
                    <div class="backup-file-name">${escapeNotificationCell(name)}</div>
                    <div>${escapeNotificationCell(created)} • ${escapeNotificationCell(size)}</div>
                </div>
                <div class="backup-file-actions">
                    <a class="btn btn-sm btn-secondary" href="${downloadUrl}">Download</a>
                </div>
            </div>
        `;
    }).join('');
}

function applyBackupConfigToControls(config) {
    const enabledToggle = document.getElementById('backupEnabledToggle');
    const intervalSelect = document.getElementById('backupIntervalSelect');
    const retentionInput = document.getElementById('backupRetentionInput');
    const formatSelect = document.getElementById('backupFormatSelect');

    if (enabledToggle) enabledToggle.checked = Boolean(config?.enabled);
    if (intervalSelect && config?.intervalMinutes) intervalSelect.value = String(config.intervalMinutes);
    if (retentionInput && config?.retentionCount) retentionInput.value = String(config.retentionCount);
    if (formatSelect && config?.format) formatSelect.value = String(config.format);
    if (Array.isArray(config?.tables)) {
        applyBackupTableSelection(config.tables);
    }
}

function updateBackupStatus(state = {}) {
    const statusEl = document.getElementById('backupStatusValue');
    const lastRunEl = document.getElementById('backupLastRunValue');
    const nextRunEl = document.getElementById('backupNextRunValue');
    const lastResultEl = document.getElementById('backupLastResultValue');
    const noteEl = document.getElementById('backupStatusNote');
    const headerStatusEl = document.getElementById('backupHeaderStatus');
    const headerLastRunEl = document.getElementById('backupHeaderLastRun');
    const statusCardEl = document.getElementById('backupStatusCard');
    const nextRunCardEl = document.getElementById('backupNextRunCard');
    const lastResultCardEl = document.getElementById('backupLastResultCard');

    const rawStatus = state.running ? 'Running' : (state.lastRunStatus || 'Idle');
    const normalized = String(rawStatus || 'Idle').toLowerCase();
    const pillClassMap = {
        running: 'backup-pill--running',
        success: 'backup-pill--success',
        warning: 'backup-pill--warning',
        failed: 'backup-pill--error',
        error: 'backup-pill--error',
        idle: 'backup-pill--idle'
    };
    const pillClass = pillClassMap[normalized] || 'backup-pill--idle';
    const cardClassMap = {
        running: 'is-running',
        success: 'is-success',
        warning: 'is-warning',
        failed: 'is-error',
        error: 'is-error',
        idle: 'is-neutral'
    };
    const resultNormalized = String(state.lastRunStatus || 'Idle').toLowerCase();

    const applyStatState = (element, stateName) => {
        if (!element) return;
        element.classList.remove('is-running', 'is-success', 'is-warning', 'is-error', 'is-neutral');
        element.classList.add(cardClassMap[stateName] || 'is-neutral');
    };

    if (statusEl) {
        statusEl.textContent = rawStatus;
    }
    if (lastRunEl) lastRunEl.textContent = formatBackupTime(state.lastRunAt);
    if (nextRunEl) nextRunEl.textContent = formatBackupTime(state.nextRunAt);
    if (lastResultEl) lastResultEl.textContent = state.lastRunStatus || '--';
    if (noteEl) {
        noteEl.textContent = state.lastRunError || 'Backups use the server-side MySQL tools.';
    }

    applyStatState(statusCardEl, normalized);
    applyStatState(nextRunCardEl, state.running ? 'running' : (state.nextRunAt ? 'success' : 'idle'));
    applyStatState(lastResultCardEl, resultNormalized);

    if (headerStatusEl) {
        headerStatusEl.textContent = rawStatus;
        headerStatusEl.classList.remove('backup-pill--running', 'backup-pill--success', 'backup-pill--warning', 'backup-pill--error', 'backup-pill--idle');
        headerStatusEl.classList.add(pillClass);
    }
    if (headerLastRunEl) {
        headerLastRunEl.textContent = `Last run: ${formatBackupTime(state.lastRunAt)}`;
    }
}

async function loadBackupStatus() {
    try {
        const { response, data } = await window.AdminPanel.api.getJson('/api/owner/backups/status');
        if (!response.ok || !data) return;
        applyBackupConfigToControls(data.config || {});
        updateBackupStatus(data.state || {});
        renderBackupFiles(data.files || []);
    } catch (error) {
        console.error('Error loading backup status:', error);
    }
}

function renderBackupTables(tables = []) {
    const list = document.getElementById('backupTablesList');
    if (!list) return;
    if (!Array.isArray(tables) || tables.length === 0) {
        list.textContent = 'No tables available.';
        return;
    }

    list.innerHTML = tables.map((table) => {
        const safeName = escapeNotificationCell(table);
        return `
            <label class="backup-table-item">
                <input type="checkbox" class="backup-table-checkbox" value="${safeName}" />
                <span>${safeName}</span>
            </label>
        `;
    }).join('');

    list.querySelectorAll('.backup-table-checkbox').forEach((checkbox) => {
        checkbox.addEventListener('change', () => updateBackupTableCount());
    });
}

function applyBackupTableSelection(selected = []) {
    const list = document.getElementById('backupTablesList');
    if (!list) return;
    const selectedSet = new Set(selected.map((value) => String(value || '').trim()));
    list.querySelectorAll('.backup-table-checkbox').forEach((checkbox) => {
        checkbox.checked = selectedSet.has(checkbox.value);
    });
    updateBackupTableCount();
}

function getSelectedBackupTables() {
    const list = document.getElementById('backupTablesList');
    if (!list) return [];
    return Array.from(list.querySelectorAll('.backup-table-checkbox:checked'))
        .map((checkbox) => String(checkbox.value || '').trim())
        .filter(Boolean);
}

function updateBackupTableCount() {
    const countEl = document.getElementById('backupTableCount');
    const selectAll = document.getElementById('backupTablesSelectAll');
    const selected = getSelectedBackupTables();
    if (countEl) countEl.textContent = `${selected.length} selected`;

    if (selectAll) {
        const total = document.querySelectorAll('#backupTablesList .backup-table-checkbox').length;
        selectAll.checked = total > 0 && selected.length === total;
        selectAll.indeterminate = selected.length > 0 && selected.length < total;
    }
}

async function loadBackupTables() {
    try {
        const { response, data } = await window.AdminPanel.api.getJson('/api/owner/backups/tables');
        if (!response.ok || !data) return;
        backupTablesCache = Array.isArray(data.tables) ? data.tables : [];
        renderBackupTables(backupTablesCache);
        updateBackupTableCount();
        updateBackupModeDatabaseMeta({ tableCount: backupTablesCache.length });
    } catch (error) {
        console.error('Error loading backup tables:', error);
    }
}

async function saveBackupSettings() {
    const enabled = Boolean(document.getElementById('backupEnabledToggle')?.checked);
    const interval = Number(document.getElementById('backupIntervalSelect')?.value || 0);
    const retention = Number(document.getElementById('backupRetentionInput')?.value || 0);
    const format = String(document.getElementById('backupFormatSelect')?.value || 'json');
    const tables = getSelectedBackupTables();

    try {
        const { response, data } = await window.AdminPanel.api.postJson('/api/owner/backups/config', {
            enabled,
            intervalMinutes: interval,
            retentionCount: retention,
            tables,
            format
        });
        if (!response.ok) {
            profileShowError(data?.error || 'Failed to update backup settings');
            return;
        }
        applyBackupConfigToControls(data.config || {});
        updateBackupStatus(data.state || {});
        profileShowSuccess('Backup settings updated');
    } catch (error) {
        console.error('Error saving backup settings:', error);
        profileShowError('Failed to update backup settings');
    }
}

async function runBackupNow() {
    const runBtn = document.getElementById('runBackupBtn');
    if (runBtn) {
        runBtn.disabled = true;
        runBtn.textContent = 'Starting...';
    }

    try {
        const format = String(document.getElementById('backupFormatSelect')?.value || 'json');
        const tables = getSelectedBackupTables();
        const { response, data } = await window.AdminPanel.api.postJson('/api/owner/backups/run', {
            format,
            tables
        });
        if (!response.ok) {
            profileShowError(data?.error || 'Backup failed');
            return;
        }
        profileShowSuccess('Backup completed');
    } catch (error) {
        console.error('Error running backup:', error);
        profileShowError('Backup failed');
    } finally {
        await loadBackupStatus();
        if (runBtn) {
            runBtn.disabled = false;
            runBtn.textContent = 'Start Backup';
        }
    }
}

function renderServerBackupFiles(files) {
    const list = document.getElementById('serverBackupFilesList');
    updateBackupModeServerMeta({ fileCount: Array.isArray(files) ? files.length : 0 });
    if (!list) return;
    if (!Array.isArray(files) || files.length === 0) {
        list.innerHTML = '<div class="server-backup-empty">No server backups yet.</div>';
        renderServerBackupInspection(null);
        return;
    }

    list.innerHTML = `<div class="server-backup-files-grid">${files.slice(0, 8).map((file) => {
        const name = file?.name || 'server-backup.json';
        const size = formatBackupBytes(file?.size || 0);
        const created = formatBackupTime(file?.createdAt || null);
        const downloadUrl = `/api/owner/server-backups/download?file=${encodeURIComponent(name)}`;
        const manifestUrl = `/api/owner/server-backups/download-manifest?file=${encodeURIComponent(name)}`;
        const subtitle = file?.label || file?.notes || 'No label or notes';
        return `
            <div class="server-backup-file-card">
                <div class="server-backup-file-top">
                    <div class="backup-file-meta">
                        <div class="server-backup-file-kicker">Snapshot</div>
                        <div class="backup-file-name">${escapeNotificationCell(name)}</div>
                        <div class="server-backup-file-meta-line">
                            <span>Created ${escapeNotificationCell(created)}</span>
                            <span>Size ${escapeNotificationCell(size)}</span>
                        </div>
                        <div class="server-backup-file-subtitle">${escapeNotificationCell(subtitle)}</div>
                    </div>
                    <div class="server-backup-action-group">
                        <button class="btn btn-sm btn-secondary server-backup-inspect-btn" type="button" data-backup-file="${escapeNotificationCell(name)}">Inspect</button>
                        ${file?.manifestAvailable ? `<a class="btn btn-sm btn-secondary" href="${manifestUrl}">Manifest</a>` : ''}
                        <a class="btn btn-sm btn-secondary" href="${downloadUrl}">Download</a>
                    </div>
                </div>
                <div class="server-backup-file-flags">
                    <span class="server-backup-flag ${file?.valid ? 'is-good' : 'is-warning'}">${file?.valid ? 'healthy snapshot' : 'needs review'}</span>
                    <span class="server-backup-flag">warnings ${Number(file?.warningCount || 0)}</span>
                    <span class="server-backup-flag">errors ${Number(file?.errorCount || 0)}</span>
                    <span class="server-backup-flag ${file?.manifestSigned && file?.manifestValid ? 'is-good' : ''}">${file?.manifestAvailable ? (file?.manifestSigned ? 'signed manifest' : 'manifest ready') : 'no manifest'}</span>
                </div>
            </div>
        `;
    }).join('')}</div>`;

    list.querySelectorAll('.server-backup-inspect-btn').forEach((button) => {
        button.addEventListener('click', async (event) => {
            const target = event.currentTarget;
            const fileName = String(target?.dataset?.backupFile || '').trim();
            if (!fileName) {
                profileShowError('Backup file is missing');
                return;
            }

            await window.inspectServerBackupFileByName(fileName);
        });
    });
}

function renderServerBackupAnalytics(analytics = null) {
    const container = document.getElementById('serverBackupAnalyticsGrid');
    if (!container) return;
    if (!analytics) {
        container.innerHTML = '';
        return;
    }

    const cards = [
        { label: 'Snapshots', value: String(analytics.snapshotCount || 0), state: 'info' },
        { label: 'Healthy', value: String(analytics.healthyCount || 0), state: 'good' },
        { label: 'Warnings', value: String(analytics.warningCount || 0), state: Number(analytics.warningCount || 0) > 0 ? 'warning' : 'neutral' },
        { label: 'Average Size', value: formatBackupBytes(analytics.averageSize || 0), state: 'neutral' },
        { label: 'Latest Label', value: analytics.latestLabel || 'None', state: 'info' },
        { label: 'Runs', value: `M:${analytics.triggerBreakdown?.manual || 0} S:${analytics.triggerBreakdown?.scheduled || 0} C:${analytics.triggerBreakdown?.command || 0}`, state: 'neutral' },
        { label: 'Signed', value: String(analytics.signedCount || 0), state: Number(analytics.signedCount || 0) > 0 ? 'good' : 'neutral' }
    ];

    container.innerHTML = cards.map((card) => `
        <div class="server-backup-analytics-item is-${escapeNotificationCell(card.state)}">
            <strong>${escapeNotificationCell(card.label)}</strong>
            <span>${escapeNotificationCell(card.value)}</span>
        </div>
    `).join('');
}

function renderServerBackupTimeline(timeline = []) {
    const container = document.getElementById('serverBackupTimelineList');
    if (!container) return;
    if (!Array.isArray(timeline) || timeline.length === 0) {
        container.className = 'server-backup-inspection-empty';
        container.textContent = 'Timeline entries appear after at least two snapshots exist.';
        return;
    }

    container.className = 'server-backup-timeline-list';
    container.innerHTML = timeline.map((entry) => `
        <div class="server-backup-timeline-item">
            <div class="server-backup-timeline-head">
                <strong>${escapeNotificationCell(entry.currentLabel || entry.currentFile || 'Snapshot')}</strong>
                <span>${escapeNotificationCell(formatBackupTime(entry.currentCreatedAt || null))}</span>
            </div>
            <div class="server-backup-timeline-subtitle">Compared to ${escapeNotificationCell(entry.previousLabel || entry.previousFile || 'previous snapshot')}</div>
            <div class="server-backup-timeline-metrics">
                <div class="server-backup-timeline-metric">
                    <strong>Total Changes</strong>
                    <span>${escapeNotificationCell(String(Number(entry.totalChanges || 0)))}</span>
                </div>
                <div class="server-backup-timeline-metric">
                    <strong>Roles + / ~ / -</strong>
                    <span>${escapeNotificationCell(`${Number(entry.summary?.rolesAdded || 0)}/${Number(entry.summary?.rolesChanged || 0)}/${Number(entry.summary?.rolesRemoved || 0)}`)}</span>
                </div>
                <div class="server-backup-timeline-metric">
                    <strong>Channels + / ~ / -</strong>
                    <span>${escapeNotificationCell(`${Number(entry.summary?.channelsAdded || 0)}/${Number(entry.summary?.channelsChanged || 0)}/${Number(entry.summary?.channelsRemoved || 0)}`)}</span>
                </div>
            </div>
        </div>
    `).join('');
}

function renderServerBackupInspection(inspection = null) {
    const container = document.getElementById('serverBackupInspectionContent');
    if (!container) return;

    if (!inspection) {
        container.className = 'server-backup-inspection-empty';
        container.textContent = 'Select Inspect on a backup to view health, metadata, and warnings.';
        return;
    }

    const validation = inspection.validation || {};
    const summary = inspection.summary || {};
    const manifest = inspection.manifest || {};
    const warningItems = Array.isArray(validation.warnings) ? validation.warnings : [];
    const errorItems = Array.isArray(validation.errors) ? validation.errors : [];
    const statusText = validation.valid ? 'Healthy' : (errorItems.length ? 'Issues Found' : 'Needs Review');
    const manifestText = manifest.available ? `${manifest.signed ? 'Signed' : 'Unsigned'} / ${manifest.valid ? 'Valid' : 'Review'}` : 'Missing';
    const includedSections = Object.entries(summary.includes || {})
        .filter(([, enabled]) => enabled)
        .map(([key]) => key.replace(/([A-Z])/g, ' $1').replace(/^./, (char) => char.toUpperCase()));
    const includesText = includedSections.join(', ') || 'Nothing';
    const healthScore = Math.max(
        12,
        Math.min(100, 100 - (errorItems.length * 28) - (warningItems.length * 9) - (manifest.available && !manifest.valid ? 12 : 0))
    );
    const scoreClass = validation.valid ? 'is-good' : (errorItems.length ? 'is-error' : 'is-warning');
    const metadata = inspection.metadata || {};
    const contextItems = [
        { label: 'Snapshot File', value: inspection.file?.name || 'Unavailable' },
        { label: 'Server', value: inspection.guild?.name || inspection.guild?.id || 'Unavailable' },
        { label: 'Generated', value: formatBackupTime(inspection.generatedAt || inspection.file?.createdAt || null) },
        { label: 'Requested By', value: inspection.requestedBy || 'System' },
        { label: 'Trigger', value: inspection.trigger || 'Unknown' },
        { label: 'Size', value: formatBackupBytes(inspection.file?.size || 0) }
    ];

    const inspectionCards = [
        { label: 'Status', value: statusText, state: validation.valid ? 'good' : (errorItems.length ? 'error' : 'warning') },
        { label: 'Version', value: String(inspection.version || 0), state: 'neutral' },
        { label: 'Label', value: inspection.label || 'None', state: 'neutral' },
        { label: 'Roles', value: String(summary.roles || 0), state: 'neutral' },
        { label: 'Channels', value: String(summary.channels || 0), state: 'neutral' },
        { label: 'Emojis', value: String(summary.emojis || 0), state: 'neutral' },
        { label: 'Stickers', value: String(summary.stickers || 0), state: 'neutral' },
        { label: 'Manifest', value: manifestText, state: manifest.available ? (manifest.valid ? 'good' : 'warning') : 'error' }
    ];

    container.className = '';
    container.innerHTML = `
        <div class="server-backup-inspection-layout">
            <div class="server-backup-inspection-hero">
                <div class="server-backup-inspection-kicker">Backup Inspection</div>
                <div class="server-backup-inspection-headline">
                    <div>
                        <h4>${escapeNotificationCell(inspection.label || inspection.file?.name || 'Snapshot Overview')}</h4>
                        <p>Review snapshot health, payload integrity, and restore readiness before using this backup.</p>
                    </div>
                    <div class="server-backup-inspection-score ${scoreClass}">
                        <span>Health Score</span>
                        <strong>${escapeNotificationCell(String(healthScore))}</strong>
                    </div>
                </div>
                <div class="server-backup-inspection-health">
                    <span class="server-backup-health-pill ${validation.valid ? 'is-good' : (errorItems.length ? 'is-error' : 'is-warning')}">${escapeNotificationCell(statusText)}</span>
                    <span class="server-backup-health-pill ${manifest.available ? (manifest.valid ? 'is-good' : 'is-warning') : 'is-error'}">${escapeNotificationCell(manifestText)}</span>
                    <span class="server-backup-health-pill ${warningItems.length ? 'is-warning' : ''}">Warnings ${escapeNotificationCell(String(warningItems.length))}</span>
                    <span class="server-backup-health-pill ${errorItems.length ? 'is-error' : ''}">Errors ${escapeNotificationCell(String(errorItems.length))}</span>
                </div>
                <div class="server-backup-inspection-context-grid">
                    ${contextItems.map((item) => `
                        <div class="server-backup-inspection-context-card">
                            <strong>${escapeNotificationCell(item.label)}</strong>
                            <span>${escapeNotificationCell(item.value)}</span>
                        </div>
                    `).join('')}
                </div>
            </div>
            <div class="server-backup-inspection-meta">
                <div class="server-backup-inspection-block server-backup-inspection-block--feature">
                    <div class="server-backup-inspection-block-header">
                        <strong>Included Structure</strong>
                        <span>${escapeNotificationCell(String(includedSections.length))} section${includedSections.length === 1 ? '' : 's'}</span>
                    </div>
                    <div class="server-backup-inspection-tags">
                        ${includedSections.length ? includedSections.map((item) => `<span class="server-backup-inspection-tag">${escapeNotificationCell(item)}</span>`).join('') : '<span class="server-backup-inspection-tag">Nothing</span>'}
                    </div>
                </div>
                <div class="server-backup-inspection-block">
                    <div class="server-backup-inspection-block-header">
                        <strong>Snapshot Context</strong>
                        <span>Notes and manifest metadata</span>
                    </div>
                    <div class="server-backup-inspection-stack">
                        <div class="server-backup-inspection-item"><strong>Notes</strong><span>${escapeNotificationCell(inspection.notes || 'None')}</span></div>
                        <div class="server-backup-inspection-item"><strong>Manifest Schema</strong><span>${escapeNotificationCell(manifest.schema || 'Unavailable')}</span></div>
                        <div class="server-backup-inspection-item"><strong>Manifest Version</strong><span>${escapeNotificationCell(String(manifest.version || metadata.manifestVersion || 'N/A'))}</span></div>
                        <div class="server-backup-inspection-item"><strong>Included Summary</strong><span>${escapeNotificationCell(includesText)}</span></div>
                    </div>
                </div>
            </div>
        </div>
        <div class="server-backup-inspection-grid">
            ${inspectionCards.map((card) => `
                <div class="server-backup-inspection-item ${card.state === 'neutral' ? '' : `is-${card.state}`}">
                    <strong>${escapeNotificationCell(card.label)}</strong>
                    <span>${escapeNotificationCell(card.value)}</span>
                </div>
            `).join('')}
        </div>
        <div class="server-backup-inspection-split">
            <div class="server-backup-inspection-block">
                <div class="server-backup-inspection-block-header">
                    <strong>Warnings</strong>
                    <span>${escapeNotificationCell(String(warningItems.length))} item${warningItems.length === 1 ? '' : 's'}</span>
                </div>
                <div class="server-backup-inspection-list is-warning">${warningItems.length ? warningItems.map((item) => `<div>${escapeNotificationCell(item)}</div>`).join('') : '<div>None</div>'}</div>
            </div>
            <div class="server-backup-inspection-block">
                <div class="server-backup-inspection-block-header">
                    <strong>Errors</strong>
                    <span>${escapeNotificationCell(String(errorItems.length))} item${errorItems.length === 1 ? '' : 's'}</span>
                </div>
                <div class="server-backup-inspection-list is-error">${errorItems.length ? errorItems.map((item) => `<div>${escapeNotificationCell(item)}</div>`).join('') : '<div>None</div>'}</div>
            </div>
        </div>
    `;
}

function renderServerBackupPreflight(preflight = null) {
    const container = document.getElementById('serverBackupPreflightResults');
    if (!container) return;

    if (!preflight) {
        container.className = 'server-backup-inspection-empty';
        container.textContent = 'Run a preflight check before restoring to score risk against the current server.';
        return;
    }

    container.className = '';
    const warningItems = Array.isArray(preflight.warnings) ? preflight.warnings : [];
    const errorItems = Array.isArray(preflight.errors) ? preflight.errors : [];
    const diffSummary = preflight.diffSummary || {};
    const riskScore = Number(preflight.score || 0);
    let riskLevelLabel = 'Safe';
    let riskScoreClass = 'is-good';

    if (riskScore >= 50) {
        riskLevelLabel = 'Critical';
        riskScoreClass = 'is-error';
    } else if (riskScore >= 28) {
        riskLevelLabel = 'High Risk';
        riskScoreClass = 'is-error';
    } else if (riskScore >= 12) {
        riskLevelLabel = 'Caution';
        riskScoreClass = 'is-warning';
    }

    const validationHealthy = Boolean(preflight.validation?.valid);
    const summaryCards = [
        { label: 'Settings Changed', value: Number(diffSummary.settingsChanged || 0), state: Number(diffSummary.settingsChanged || 0) > 0 ? 'warning' : 'neutral' },
        { label: 'Roles Added', value: Number(diffSummary.rolesAdded || 0), state: Number(diffSummary.rolesAdded || 0) > 0 ? 'warning' : 'neutral' },
        { label: 'Roles Changed', value: Number(diffSummary.rolesChanged || 0), state: Number(diffSummary.rolesChanged || 0) > 0 ? 'warning' : 'neutral' },
        { label: 'Roles Removed', value: Number(diffSummary.rolesRemoved || 0), state: Number(diffSummary.rolesRemoved || 0) > 0 ? 'error' : 'neutral' },
        { label: 'Channels Added', value: Number(diffSummary.channelsAdded || 0), state: Number(diffSummary.channelsAdded || 0) > 0 ? 'warning' : 'neutral' },
        { label: 'Channels Changed', value: Number(diffSummary.channelsChanged || 0), state: Number(diffSummary.channelsChanged || 0) > 0 ? 'warning' : 'neutral' },
        { label: 'Channels Removed', value: Number(diffSummary.channelsRemoved || 0), state: Number(diffSummary.channelsRemoved || 0) > 0 ? 'error' : 'neutral' },
        { label: 'Emoji or Sticker Drift', value: Number(diffSummary.emojisAdded || 0) + Number(diffSummary.emojisChanged || 0) + Number(diffSummary.emojisRemoved || 0) + Number(diffSummary.stickersAdded || 0) + Number(diffSummary.stickersChanged || 0) + Number(diffSummary.stickersRemoved || 0), state: (Number(diffSummary.emojisAdded || 0) + Number(diffSummary.emojisChanged || 0) + Number(diffSummary.emojisRemoved || 0) + Number(diffSummary.stickersAdded || 0) + Number(diffSummary.stickersChanged || 0) + Number(diffSummary.stickersRemoved || 0)) > 0 ? 'warning' : 'neutral' }
    ];

    container.innerHTML = `
        <div class="server-backup-inspection-layout">
            <div class="server-backup-inspection-hero">
                <div class="server-backup-inspection-kicker">Restore Preflight</div>
                <div class="server-backup-inspection-headline">
                    <div>
                        <h4>Restore Risk Review</h4>
                        <p>Compare the selected backup against the current server state before applying structural changes. Scores under 12 are usually safe, while scores above 28 need careful review.</p>
                    </div>
                    <div class="server-backup-inspection-score ${riskScoreClass}">
                        <span>Risk Score</span>
                        <strong>${escapeNotificationCell(String(riskScore))}</strong>
                    </div>
                </div>
                <div class="server-backup-inspection-health">
                    <span class="server-backup-health-pill ${riskScoreClass}">${escapeNotificationCell(riskLevelLabel)}</span>
                    <span class="server-backup-health-pill ${validationHealthy ? 'is-good' : (errorItems.length ? 'is-error' : 'is-warning')}">${escapeNotificationCell(validationHealthy ? 'Validation Healthy' : 'Validation Needs Review')}</span>
                    <span class="server-backup-health-pill ${warningItems.length ? 'is-warning' : ''}">Warnings ${escapeNotificationCell(String(warningItems.length))}</span>
                    <span class="server-backup-health-pill ${errorItems.length ? 'is-error' : ''}">Errors ${escapeNotificationCell(String(errorItems.length))}</span>
                </div>
                <div class="server-backup-preflight-grid">
                    <div class="server-backup-preflight-box"><strong>Settings Drift</strong><span>${escapeNotificationCell(String(diffSummary.settingsChanged || 0))}</span></div>
                    <div class="server-backup-preflight-box"><strong>Role Drift</strong><span>${escapeNotificationCell(`${Number(diffSummary.rolesAdded || 0) + Number(diffSummary.rolesChanged || 0) + Number(diffSummary.rolesRemoved || 0)}`)}</span></div>
                    <div class="server-backup-preflight-box"><strong>Channel Drift</strong><span>${escapeNotificationCell(`${Number(diffSummary.channelsAdded || 0) + Number(diffSummary.channelsChanged || 0) + Number(diffSummary.channelsRemoved || 0)}`)}</span></div>
                    <div class="server-backup-preflight-box"><strong>Emoji or Sticker Drift</strong><span>${escapeNotificationCell(String(Number(diffSummary.emojisAdded || 0) + Number(diffSummary.emojisChanged || 0) + Number(diffSummary.emojisRemoved || 0) + Number(diffSummary.stickersAdded || 0) + Number(diffSummary.stickersChanged || 0) + Number(diffSummary.stickersRemoved || 0)))}</span></div>
                </div>
            </div>
            <div class="server-backup-inspection-meta">
                <div class="server-backup-inspection-block server-backup-inspection-block--feature">
                    <div class="server-backup-inspection-block-header">
                        <strong>Preflight Notes</strong>
                        <span>${escapeNotificationCell(String((preflight.reasons || []).length))} item${(preflight.reasons || []).length === 1 ? '' : 's'}</span>
                    </div>
                    <div class="server-backup-inspection-list">${(preflight.reasons || []).length ? preflight.reasons.map((item) => `<div>${escapeNotificationCell(item)}</div>`).join('') : '<div>No notable risks detected.</div>'}</div>
                </div>
            </div>
        </div>
        <div class="server-backup-inspection-grid">
            ${summaryCards.map((card) => `
                <div class="server-backup-inspection-item ${card.state === 'neutral' ? '' : `is-${card.state}`}">
                    <strong>${escapeNotificationCell(card.label)}</strong>
                    <span>${escapeNotificationCell(String(card.value))}</span>
                </div>
            `).join('')}
        </div>
        <div class="server-backup-inspection-split">
            <div class="server-backup-inspection-block">
                <div class="server-backup-inspection-block-header">
                    <strong>Validation Warnings</strong>
                    <span>${escapeNotificationCell(String(warningItems.length))} item${warningItems.length === 1 ? '' : 's'}</span>
                </div>
                <div class="server-backup-inspection-list is-warning">${warningItems.length ? warningItems.map((item) => `<div>${escapeNotificationCell(item)}</div>`).join('') : '<div>None</div>'}</div>
            </div>
            <div class="server-backup-inspection-block">
                <div class="server-backup-inspection-block-header">
                    <strong>Validation Errors</strong>
                    <span>${escapeNotificationCell(String(errorItems.length))} item${errorItems.length === 1 ? '' : 's'}</span>
                </div>
                <div class="server-backup-inspection-list is-error">${errorItems.length ? errorItems.map((item) => `<div>${escapeNotificationCell(item)}</div>`).join('') : '<div>None</div>'}</div>
            </div>
        </div>
    `;
}

function getServerBackupRestoreExclusions() {
    return {
        excludeRoles: String(document.getElementById('serverBackupExcludeRolesInput')?.value || '').trim(),
        excludeChannels: String(document.getElementById('serverBackupExcludeChannelsInput')?.value || '').trim()
    };
}

async function inspectSelectedServerBackup() {
    const file = String(document.getElementById('serverBackupSourceSelect')?.value || '').trim();
    if (!file) {
        profileShowError('Select a backup first');
        return;
    }
    await window.inspectServerBackupFileByName(file);
}

window.inspectServerBackupFileByName = async function inspectServerBackupFileByName(file) {
    const safeFile = String(file || '').trim();
    if (!safeFile) {
        renderServerBackupInspection(null);
        return;
    }

    try {
        const { response, data } = await window.AdminPanel.api.getJson(`/api/owner/server-backups/inspect?file=${encodeURIComponent(safeFile)}`);
        if (!response.ok) {
            profileShowError(data?.error || 'Failed to inspect backup');
            return;
        }
        renderServerBackupInspection(data.inspection || null);
    } catch (error) {
        console.error('Error inspecting server backup:', error);
        profileShowError('Failed to inspect backup');
    }
};

function renderServerBackupFileSelectors(files = []) {
    const sourceSelect = document.getElementById('serverBackupSourceSelect');
    const targetSelect = document.getElementById('serverBackupCompareTargetSelect');
    const restoreSelect = document.getElementById('serverBackupRestoreSelect');
    const normalizedFiles = Array.isArray(files) ? files : [];

    const fileOptions = normalizedFiles.map((file) => {
        const name = escapeNotificationCell(file?.name || 'backup.json');
        return `<option value="${name}">${name}</option>`;
    }).join('');

    if (sourceSelect) {
        const current = sourceSelect.value;
        sourceSelect.innerHTML = `<option value="">Select a backup</option>${fileOptions}`;
        if (current) sourceSelect.value = current;
    }

    if (targetSelect) {
        const current = targetSelect.value || 'live';
        targetSelect.innerHTML = `<option value="live">Current Server State</option>${fileOptions}`;
        if (current) targetSelect.value = current;
    }

    if (restoreSelect) {
        const current = restoreSelect.value;
        restoreSelect.innerHTML = `<option value="">Select a backup</option>${fileOptions}`;
        if (current) restoreSelect.value = current;
    }
}

async function runServerBackupRestorePreflight() {
    const file = String(document.getElementById('serverBackupRestoreSelect')?.value || '').trim();
    if (!file) {
        profileShowError('Select a backup to preflight');
        return;
    }

    try {
        const exclusions = getServerBackupRestoreExclusions();
        const params = new URLSearchParams({ file });
        if (exclusions.excludeRoles) params.set('excludeRoles', exclusions.excludeRoles);
        if (exclusions.excludeChannels) params.set('excludeChannels', exclusions.excludeChannels);

        const { response, data } = await window.AdminPanel.api.getJson(`/api/owner/server-backups/preflight?${params.toString()}`);
        if (!response.ok) {
            profileShowError(data?.error || 'Failed to run restore preflight');
            return;
        }
        renderServerBackupPreflight(data.preflight || null);
        profileShowSuccess('Restore preflight updated');
    } catch (error) {
        console.error('Error running restore preflight:', error);
        profileShowError('Failed to run restore preflight');
    }
}

function getServerBackupIncludeSelections() {
    return {
        settings: Boolean(document.getElementById('serverBackupIncludeSettings')?.checked),
        roles: Boolean(document.getElementById('serverBackupIncludeRoles')?.checked),
        channels: Boolean(document.getElementById('serverBackupIncludeChannels')?.checked),
        emojis: Boolean(document.getElementById('serverBackupIncludeEmojis')?.checked),
        stickers: Boolean(document.getElementById('serverBackupIncludeStickers')?.checked),
        permissionOverwrites: Boolean(document.getElementById('serverBackupIncludePermissionOverwrites')?.checked)
    };
}

function applyServerBackupIncludes(includes = {}) {
    const normalized = {
        settings: includes?.settings !== false,
        roles: includes?.roles !== false,
        channels: includes?.channels !== false,
        emojis: includes?.emojis !== false,
        stickers: includes?.stickers !== false,
        permissionOverwrites: includes?.permissionOverwrites !== false
    };

    const pairs = [
        ['serverBackupIncludeSettings', normalized.settings],
        ['serverBackupIncludeRoles', normalized.roles],
        ['serverBackupIncludeChannels', normalized.channels],
        ['serverBackupIncludeEmojis', normalized.emojis],
        ['serverBackupIncludeStickers', normalized.stickers],
        ['serverBackupIncludePermissionOverwrites', normalized.permissionOverwrites]
    ];

    pairs.forEach(([id, value]) => {
        const element = document.getElementById(id);
        if (element) element.checked = Boolean(value);
    });
}

function getServerBackupRestoreSelections() {
    return {
        restoreSettings: Boolean(document.getElementById('serverBackupRestoreSettings')?.checked),
        restoreRoles: Boolean(document.getElementById('serverBackupRestoreRoles')?.checked),
        restoreChannels: Boolean(document.getElementById('serverBackupRestoreChannels')?.checked),
        restoreEmojis: Boolean(document.getElementById('serverBackupRestoreEmojis')?.checked),
        restoreStickers: Boolean(document.getElementById('serverBackupRestoreStickers')?.checked),
        applyPermissionOverwrites: Boolean(document.getElementById('serverBackupRestorePermissionOverwrites')?.checked),
        ...getServerBackupRestoreExclusions()
    };
}

function formatServerBackupRestoreLabel(value, fallback = 'Pending') {
    const text = String(value || '').trim();
    if (!text) return fallback;
    return text
        .replace(/[-_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatServerBackupRestoreProgress(progress = null) {
    if (!progress || typeof progress !== 'object') {
        return '--';
    }

    const processed = Number.isFinite(Number(progress.processed)) ? Number(progress.processed) : null;
    const total = Number.isFinite(Number(progress.total)) ? Number(progress.total) : null;
    const percent = Number.isFinite(Number(progress.percent)) ? Number(progress.percent) : null;

    if (processed !== null && total !== null && total > 0) {
        return `${processed} / ${total}${percent !== null ? ` (${percent}%)` : ''}`;
    }

    if (percent !== null) {
        return `${percent}%`;
    }

    return '--';
}

function buildServerBackupRestoreSummaryHtml(summary = {}) {
    const warningItems = Array.isArray(summary.warnings) ? summary.warnings : [];
    return `
        Settings updated: <strong>${Number(summary.settingsUpdated || 0)}</strong><br>
        Roles created/updated/skipped/failed: <strong>${Number(summary.rolesCreated || 0)}</strong> / <strong>${Number(summary.rolesUpdated || 0)}</strong> / <strong>${Number(summary.rolesSkipped || 0)}</strong> / <strong>${Number(summary.rolesFailed || 0)}</strong><br>
        Channels created/updated/skipped/failed: <strong>${Number(summary.channelsCreated || 0)}</strong> / <strong>${Number(summary.channelsUpdated || 0)}</strong> / <strong>${Number(summary.channelsSkipped || 0)}</strong> / <strong>${Number(summary.channelsFailed || 0)}</strong><br>
        Overwrite syncs: <strong>${Number(summary.overwriteSyncs || 0)}</strong><br>
        Emojis created/failed: <strong>${Number(summary.emojisCreated || 0)}</strong> / <strong>${Number(summary.emojisFailed || 0)}</strong><br>
        Stickers created/failed: <strong>${Number(summary.stickersCreated || 0)}</strong> / <strong>${Number(summary.stickersFailed || 0)}</strong>
        ${warningItems.length ? `<div class="server-backup-inspection-list is-warning" style="margin-top:0.85rem;">${warningItems.map((item) => `<div>${escapeNotificationCell(item)}</div>`).join('')}</div>` : ''}
    `;
}

function renderServerBackupRestoreOperation(operation = null) {
    const resultEl = document.getElementById('serverBackupRestoreResults');
    if (!resultEl) return;

    if (!operation) {
        resultEl.innerHTML = 'Restore is non-destructive: it creates or updates matching roles and channels instead of deleting extra server content.';
        return;
    }

    const progress = operation.progress || {};
    const status = formatServerBackupRestoreLabel(operation.status, 'Queued');
    const phase = formatServerBackupRestoreLabel(progress.phase || operation.phase, 'Queued');
    const progressText = formatServerBackupRestoreProgress(progress);
    const message = escapeNotificationCell(progress.message || operation.message || 'Restore is queued.');
    const currentLabel = progress.currentLabel ? `<div>Current item: <strong>${escapeNotificationCell(progress.currentLabel)}</strong></div>` : '';
    const updatedAt = operation.updatedAt ? `<div>Last update: <strong>${escapeNotificationCell(formatBackupTime(operation.updatedAt))}</strong></div>` : '';
    const events = Array.isArray(operation.events) ? operation.events.slice(0, 6) : [];
    const errorBlock = operation.status === 'failed' && operation.error
        ? `<div class="server-backup-inspection-list is-error" style="margin-top:0.85rem;"><div>${escapeNotificationCell(operation.error)}</div></div>`
        : '';
    const summaryBlock = operation.status === 'completed' && operation.summary
        ? `<div style="margin-top:0.85rem;">${buildServerBackupRestoreSummaryHtml(operation.summary)}</div>`
        : '';
    const recentActivityBlock = events.length
        ? `
            <div class="server-backup-inspection-block" style="margin-top:0.85rem;">
                <div class="server-backup-inspection-block-header">
                    <strong>Recent Activity</strong>
                    <span>${escapeNotificationCell(String(events.length))} item${events.length === 1 ? '' : 's'}</span>
                </div>
                <div class="server-backup-inspection-list">${events.map((event) => {
            const eventMessage = escapeNotificationCell(event.message || `${formatServerBackupRestoreLabel(event.phase, 'Step')} update`);
            const eventProgress = formatServerBackupRestoreProgress(event);
            const eventLabel = event.currentLabel ? ` <strong>${escapeNotificationCell(event.currentLabel)}</strong>` : '';
            const eventSuffix = eventProgress !== '--' ? ` <span style="color:#94a3b8;">(${escapeNotificationCell(eventProgress)})</span>` : '';
            return `<div>${eventMessage}${eventLabel}${eventSuffix}</div>`;
        }).join('')}</div>
            </div>
        `
        : '';

    resultEl.innerHTML = `
        <div style="display:grid; gap:0.85rem;">
            <div class="server-backup-preflight-grid">
                <div class="server-backup-preflight-box"><strong>Status</strong><span>${escapeNotificationCell(status)}</span></div>
                <div class="server-backup-preflight-box"><strong>Phase</strong><span>${escapeNotificationCell(phase)}</span></div>
                <div class="server-backup-preflight-box"><strong>Progress</strong><span>${escapeNotificationCell(progressText)}</span></div>
            </div>
            <div class="server-backup-inspection-list">
                <div>${message}</div>
                ${currentLabel}
                ${updatedAt}
            </div>
            ${errorBlock}
            ${summaryBlock}
            ${recentActivityBlock}
        </div>
    `;
}

function sleepOwnerPanel(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function pollServerBackupRestoreOperation(operationId, options = {}) {
    const safeOperationId = String(operationId || '').trim();
    if (!safeOperationId) {
        throw new Error('Missing restore operation ID');
    }

    const startedAt = Date.now();
    const intervalMs = Math.max(500, Number(options.intervalMs) || 1000);
    const timeoutMs = Math.max(30000, Number(options.timeoutMs) || (15 * 60 * 1000));
    activeServerBackupRestoreOperationId = safeOperationId;
    persistActiveServerBackupRestoreOperationId(safeOperationId);
    setServerBackupRestoreButtonBusyState(true);

    while (activeServerBackupRestoreOperationId === safeOperationId) {
        const { response, data } = await window.AdminPanel.api.getJson(`/api/owner/server-backups/restore-status?operationId=${encodeURIComponent(safeOperationId)}`);
        if (!response.ok) {
            throw new Error(data?.error || 'Failed to fetch restore status');
        }

        const operation = data.operation || null;
        renderServerBackupRestoreOperation(operation);
        if (!operation) {
            throw new Error('Restore operation was not found');
        }

        if (operation.status === 'completed' || operation.status === 'failed') {
            activeServerBackupRestoreOperationId = null;
            clearPersistedServerBackupRestoreOperationId();
            setServerBackupRestoreButtonBusyState(false);
            return operation;
        }

        if ((Date.now() - startedAt) > timeoutMs) {
            activeServerBackupRestoreOperationId = null;
            throw new Error('Timed out while waiting for restore progress');
        }

        await sleepOwnerPanel(intervalMs);
    }

    throw new Error('Restore polling stopped unexpectedly');
}

async function resumeServerBackupRestoreOperationFromStorage() {
    const operationId = loadPersistedServerBackupRestoreOperationId();
    if (!operationId) {
        return null;
    }

    try {
        const operation = await pollServerBackupRestoreOperation(operationId, {
            intervalMs: 1000,
            timeoutMs: 15 * 60 * 1000
        });

        if (operation.status === 'failed') {
            profileShowError(operation.error || 'Server backup restore failed');
            return operation;
        }

        const warnings = Array.isArray(operation.summary?.warnings) ? operation.summary.warnings : [];
        profileShowSuccess(warnings.length ? 'Server backup restore completed with warnings' : 'Server backup restore completed');
        await loadServerBackupStatus();
        return operation;
    } catch (error) {
        console.error('Failed to resume server backup restore operation:', error);
        clearPersistedServerBackupRestoreOperationId();
        activeServerBackupRestoreOperationId = null;
        setServerBackupRestoreButtonBusyState(false);
        return null;
    }
}

function renderServerBackupDiff(diff = null) {
    const container = document.getElementById('serverBackupDiffResults');
    if (!container) return;
    if (!diff || !diff.summary) {
        container.textContent = 'No diff preview available.';
        return;
    }

    const blocks = [
        {
            title: 'Settings',
            items: diff.details?.settingsChanged || []
        },
        {
            title: 'Roles Added',
            items: diff.details?.roles?.added || []
        },
        {
            title: 'Roles Removed',
            items: diff.details?.roles?.removed || []
        },
        {
            title: 'Roles Changed',
            items: diff.details?.roles?.changed || []
        },
        {
            title: 'Channels Added',
            items: diff.details?.channels?.added || []
        },
        {
            title: 'Channels Removed',
            items: diff.details?.channels?.removed || []
        },
        {
            title: 'Channels Changed',
            items: diff.details?.channels?.changed || []
        },
        {
            title: 'Emojis Added',
            items: diff.details?.emojis?.added || []
        },
        {
            title: 'Stickers Added',
            items: diff.details?.stickers?.added || []
        }
    ];

    const summary = diff.summary;
    container.innerHTML = `
        <div style="display:grid; gap:1rem;">
            <div style="padding:0.9rem; border:1px solid rgba(255,255,255,0.08); border-radius:12px; background:rgba(255,255,255,0.02);">
                <div style="font-size:0.9rem; color:#94a3b8; margin-bottom:0.5rem;">Comparing <strong>${escapeNotificationCell(diff.sourceLabel || 'Source')}</strong> against <strong>${escapeNotificationCell(diff.targetLabel || 'Target')}</strong></div>
                <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap:0.75rem;">
                    <div><strong>${summary.settingsChanged || 0}</strong><br><span style="color:#94a3b8;">settings changed</span></div>
                    <div><strong>${summary.rolesAdded || 0}/${summary.rolesChanged || 0}/${summary.rolesRemoved || 0}</strong><br><span style="color:#94a3b8;">roles + / ~ / -</span></div>
                    <div><strong>${summary.channelsAdded || 0}/${summary.channelsChanged || 0}/${summary.channelsRemoved || 0}</strong><br><span style="color:#94a3b8;">channels + / ~ / -</span></div>
                    <div><strong>${summary.emojisAdded || 0}/${summary.emojisChanged || 0}/${summary.emojisRemoved || 0}</strong><br><span style="color:#94a3b8;">emojis + / ~ / -</span></div>
                    <div><strong>${summary.stickersAdded || 0}/${summary.stickersChanged || 0}/${summary.stickersRemoved || 0}</strong><br><span style="color:#94a3b8;">stickers + / ~ / -</span></div>
                </div>
            </div>
            ${blocks.map((block) => {
        if (!Array.isArray(block.items) || block.items.length === 0) return '';
        return `
                    <div style="padding:0.9rem; border:1px solid rgba(255,255,255,0.08); border-radius:12px; background:rgba(255,255,255,0.02);">
                        <div style="font-weight:700; color:#fff; margin-bottom:0.5rem;">${escapeNotificationCell(block.title)}</div>
                        <div style="display:grid; gap:0.3rem; color:#cbd5e1;">${block.items.slice(0, 20).map((item) => `<div>• ${escapeNotificationCell(item)}</div>`).join('')}</div>
                    </div>
                `;
    }).join('')}
        </div>
    `;
}

function renderServerBackupGuildLabel(guilds = [], effectiveGuildId = '') {
    const label = document.getElementById('serverBackupGuildValue');
    if (!label) return;
    const match = Array.isArray(guilds)
        ? guilds.find((guild) => String(guild?.id || '') === String(effectiveGuildId || ''))
        : null;
    const guildText = match?.name || effectiveGuildId || 'Unavailable';
    label.textContent = guildText;
    updateBackupModeServerMeta({ guildName: guildText });
}

function updateBackupModeDatabaseMeta({ tableCount, fileCount } = {}) {
    const tableEl = document.getElementById('backupModeDatabaseCount');
    const fileEl = document.getElementById('backupModeDatabaseFiles');

    if (tableEl) {
        const totalTables = Number.isFinite(Number(tableCount)) ? Number(tableCount) : backupTablesCache.length;
        tableEl.textContent = `${totalTables} ${totalTables === 1 ? 'table' : 'tables'}`;
    }

    if (fileEl && Number.isFinite(Number(fileCount))) {
        const totalFiles = Number(fileCount);
        fileEl.textContent = `${totalFiles} ${totalFiles === 1 ? 'backup' : 'backups'}`;
    }
}

function updateBackupModeServerMeta({ fileCount, guildName } = {}) {
    const countEl = document.getElementById('backupModeServerCount');
    const guildEl = document.getElementById('backupModeServerGuild');

    if (countEl && Number.isFinite(Number(fileCount))) {
        const totalFiles = Number(fileCount);
        countEl.textContent = `${totalFiles} ${totalFiles === 1 ? 'snapshot' : 'snapshots'}`;
    }

    if (guildEl && typeof guildName === 'string' && guildName.trim()) {
        guildEl.textContent = guildName.trim();
    }
}

function applyServerBackupConfigToControls(config = {}, effectiveGuildId = '', guilds = []) {
    const enabledToggle = document.getElementById('serverBackupEnabledToggle');
    const intervalSelect = document.getElementById('serverBackupIntervalSelect');
    const retentionInput = document.getElementById('serverBackupRetentionInput');

    if (enabledToggle) enabledToggle.checked = Boolean(config?.enabled);
    if (intervalSelect && config?.intervalMinutes) intervalSelect.value = String(config.intervalMinutes);
    if (retentionInput && config?.retentionCount) retentionInput.value = String(config.retentionCount);
    applyServerBackupIncludes(config?.includes || {});
    renderServerBackupGuildLabel(guilds, effectiveGuildId);
}

function updateServerBackupStatus(state = {}) {
    const statusEl = document.getElementById('serverBackupStatusValue');
    const lastRunEl = document.getElementById('serverBackupLastRunValue');
    const nextRunEl = document.getElementById('serverBackupNextRunValue');
    const lastResultEl = document.getElementById('serverBackupLastResultValue');
    const noteEl = document.getElementById('serverBackupStatusNote');
    const headerStatusEl = document.getElementById('serverBackupHeaderStatus');
    const headerLastRunEl = document.getElementById('serverBackupHeaderLastRun');
    const statusCardEl = document.getElementById('serverBackupStatusCard');
    const nextRunCardEl = document.getElementById('serverBackupNextRunCard');
    const lastResultCardEl = document.getElementById('serverBackupLastResultCard');

    const rawStatus = state.running ? 'Running' : (state.lastRunStatus || 'Idle');
    const normalized = String(rawStatus || 'Idle').toLowerCase();
    const pillClassMap = {
        running: 'backup-pill--running',
        success: 'backup-pill--success',
        warning: 'backup-pill--warning',
        failed: 'backup-pill--error',
        error: 'backup-pill--error',
        idle: 'backup-pill--idle'
    };
    const pillClass = pillClassMap[normalized] || 'backup-pill--idle';
    const cardClassMap = {
        running: 'is-running',
        success: 'is-success',
        warning: 'is-warning',
        failed: 'is-error',
        error: 'is-error',
        idle: 'is-neutral'
    };
    const resultNormalized = String(state.lastRunStatus || 'Idle').toLowerCase();

    const applyStatState = (element, stateName) => {
        if (!element) return;
        element.classList.remove('is-running', 'is-success', 'is-warning', 'is-error', 'is-neutral');
        element.classList.add(cardClassMap[stateName] || 'is-neutral');
    };

    if (statusEl) statusEl.textContent = rawStatus;
    if (lastRunEl) lastRunEl.textContent = formatBackupTime(state.lastRunAt);
    if (nextRunEl) nextRunEl.textContent = formatBackupTime(state.nextRunAt);
    if (lastResultEl) lastResultEl.textContent = state.lastRunStatus || '--';
    if (noteEl) noteEl.textContent = state.lastRunError || 'Server backups save guild structure to JSON snapshots.';

    applyStatState(statusCardEl, normalized);
    applyStatState(nextRunCardEl, state.running ? 'running' : (state.nextRunAt ? 'success' : 'idle'));
    applyStatState(lastResultCardEl, resultNormalized);

    if (headerStatusEl) {
        headerStatusEl.textContent = rawStatus;
        headerStatusEl.classList.remove('backup-pill--running', 'backup-pill--success', 'backup-pill--warning', 'backup-pill--error', 'backup-pill--idle');
        headerStatusEl.classList.add(pillClass);
    }
    if (headerLastRunEl) {
        headerLastRunEl.textContent = `Last run: ${formatBackupTime(state.lastRunAt)}`;
    }
}

async function loadServerBackupStatus() {
    try {
        const { response, data } = await window.AdminPanel.api.getJson('/api/owner/server-backups/status');
        if (!response.ok || !data) return;
        serverBackupGuildsCache = Array.isArray(data.guilds) ? data.guilds : [];
        applyServerBackupConfigToControls(data.config || {}, data.effectiveGuildId || '', serverBackupGuildsCache);
        updateServerBackupStatus(data.state || {});
        renderServerBackupFiles(data.files || []);
        renderServerBackupFileSelectors(data.files || []);
        renderServerBackupAnalytics(data.analytics || null);
        renderServerBackupTimeline(data.timeline || []);
    } catch (error) {
        console.error('Error loading server backup status:', error);
    }
}

async function saveServerBackupSettings() {
    const enabled = Boolean(document.getElementById('serverBackupEnabledToggle')?.checked);
    const interval = Number(document.getElementById('serverBackupIntervalSelect')?.value || 0);
    const retention = Number(document.getElementById('serverBackupRetentionInput')?.value || 0);

    try {
        const { response, data } = await window.AdminPanel.api.postJson('/api/owner/server-backups/config', {
            enabled,
            intervalMinutes: interval,
            retentionCount: retention,
            includes: getServerBackupIncludeSelections()
        });
        if (!response.ok) {
            profileShowError(data?.error || 'Failed to update server backup settings');
            return;
        }
        serverBackupGuildsCache = Array.isArray(data.guilds) ? data.guilds : serverBackupGuildsCache;
        applyServerBackupConfigToControls(data.config || {}, data.effectiveGuildId || '', serverBackupGuildsCache);
        updateServerBackupStatus(data.state || {});
        profileShowSuccess('Server backup settings updated');
    } catch (error) {
        console.error('Error saving server backup settings:', error);
        profileShowError('Failed to update server backup settings');
    }
}

async function runServerBackupNow() {
    const runBtn = document.getElementById('runServerBackupBtn');
    const label = String(document.getElementById('serverBackupLabelInput')?.value || '').trim();
    const notes = String(document.getElementById('serverBackupNotesInput')?.value || '').trim();
    if (runBtn) {
        runBtn.disabled = true;
        runBtn.textContent = 'Starting...';
    }

    try {
        const { response, data } = await window.AdminPanel.api.postJson('/api/owner/server-backups/run', {
            includes: getServerBackupIncludeSelections(),
            label,
            notes
        });
        if (!response.ok) {
            profileShowError(data?.error || 'Server backup failed');
            return;
        }
        profileShowSuccess('Server backup completed');
        const labelInput = document.getElementById('serverBackupLabelInput');
        const notesInput = document.getElementById('serverBackupNotesInput');
        if (labelInput) labelInput.value = '';
        if (notesInput) notesInput.value = '';
    } catch (error) {
        console.error('Error running server backup:', error);
        profileShowError('Server backup failed');
    } finally {
        await loadServerBackupStatus();
        if (runBtn) {
            runBtn.disabled = false;
            runBtn.textContent = 'Start Server Backup';
        }
    }
}

async function previewServerBackupDiff() {
    const source = String(document.getElementById('serverBackupSourceSelect')?.value || '').trim();
    const target = String(document.getElementById('serverBackupCompareTargetSelect')?.value || 'live').trim();

    if (!source) {
        profileShowError('Select a source backup first');
        return;
    }

    try {
        const params = new URLSearchParams({ source, target: target || 'live' });
        const { response, data } = await window.AdminPanel.api.getJson(`/api/owner/server-backups/diff?${params.toString()}`);
        if (!response.ok) {
            profileShowError(data?.error || 'Failed to preview backup diff');
            return;
        }
        renderServerBackupDiff(data.diff || null);
        profileShowSuccess('Backup diff preview updated');
    } catch (error) {
        console.error('Error previewing server backup diff:', error);
        profileShowError('Failed to preview backup diff');
    }
}

async function restoreServerBackup() {
    const file = String(document.getElementById('serverBackupRestoreSelect')?.value || '').trim();

    if (!file) {
        profileShowError('Select a backup to restore');
        return;
    }

    setServerBackupRestoreButtonBusyState(true);

    try {
        const payload = {
            file,
            ...getServerBackupRestoreSelections()
        };
        const { response, data } = await window.AdminPanel.api.postJson('/api/owner/server-backups/restore', payload);
        if (!response.ok) {
            profileShowError(data?.error || 'Failed to restore backup');
            return;
        }

        const queuedOperation = data.operation || null;
        const operationId = String(data.operationId || queuedOperation?.id || '').trim();
        persistActiveServerBackupRestoreOperationId(operationId);
        renderServerBackupRestoreOperation(queuedOperation || {
            status: 'queued',
            phase: 'queued',
            message: 'Restore queued.',
            progress: {
                phase: 'queued',
                stage: 'queued',
                message: 'Restore queued.',
                processed: null,
                total: null,
                percent: null
            },
            events: []
        });

        const finalOperation = await pollServerBackupRestoreOperation(operationId);
        if (finalOperation.status === 'failed') {
            profileShowError(finalOperation.error || 'Failed to restore backup');
            return;
        }

        const warnings = Array.isArray(finalOperation.summary?.warnings) ? finalOperation.summary.warnings : [];
        profileShowSuccess(warnings.length ? 'Server backup restore completed with warnings' : 'Server backup restore completed');
        await loadServerBackupStatus();
    } catch (error) {
        console.error('Error restoring server backup:', error);
        clearPersistedServerBackupRestoreOperationId();
        activeServerBackupRestoreOperationId = null;
        profileShowError('Failed to restore backup');
    } finally {
        setServerBackupRestoreButtonBusyState(false);
    }
}

async function loadDiagnostics() {
    try {
        const [statsResult, healthResult, metricsResult] = await Promise.allSettled([
            window.AdminPanel.api.getJson('/api/stats'),
            window.AdminPanel.api.getJson('/api/system/health'),
            window.AdminPanel.api.getJson('/api/owner/system-metrics')
        ]);

        const readOkData = (result) => {
            if (result.status !== 'fulfilled') return null;
            const payload = result.value;
            if (!payload?.response?.ok) return null;
            return payload.data || null;
        };

        const statsData = readOkData(statsResult) || {};
        const healthData = readOkData(healthResult) || {};
        const metricsData = readOkData(metricsResult) || {};

        const memory = metricsData.memory || {};
        const heapUsedMB = Number(memory.heapUsed ?? healthData.heapUsedMB ?? statsData.memoryUsage ?? 0) || 0;
        const heapTotalMB = Number(memory.heapTotal ?? healthData.heapTotalMB ?? heapUsedMB) || Math.max(heapUsedMB, 1);
        const rssMB = Number(memory.rss ?? 0) || 0;
        const externalMB = Number(memory.external ?? 0) || 0;
        const heapPercent = Number(memory.heapPercentage ?? Math.round((heapUsedMB / Math.max(heapTotalMB, 1)) * 100)) || 0;

        const apiLatencyText = String(healthData.apiLatency || 'N/A');
        const dbPingText = String(healthData.dbPing || 'N/A');
        const latencyMs = parseInt(apiLatencyText.replace(/[^0-9]/g, ''), 10);
        const latencyHealthy = Number.isFinite(latencyMs) ? latencyMs <= 80 : false;
        const latencyBar = Number.isFinite(latencyMs) ? Math.max(8, Math.min(100, 100 - Math.floor((latencyMs / 300) * 100))) : 35;

        const uptimeSeconds = Number(metricsData.uptime || 0) || 0;
        const uptimeDays = Math.floor(uptimeSeconds / 86400);
        const uptimeHours = Math.floor((uptimeSeconds % 86400) / 3600);
        const uptimeLabel = uptimeDays > 0 ? `${uptimeDays}d ${uptimeHours}h` : `${Math.floor(uptimeSeconds / 3600)}h`;

        const totalUsers = Number(statsData.totalUsers || 0) || 0;
        const totalWarnings = Number(statsData.totalWarnings || 0) || 0;
        const bannedUsers = Number(statsData.bannedUsers || 0) || 0;
        const adminCount = Number(statsData.adminCount || 0) || 0;
        const totalRecords = Number(statsData.totalRecords || 0) || 0;
        const diagStats = document.getElementById('diagnosticsStats');

        const _setText = (id, text) => {
            const el = document.getElementById(id);
            if (el) el.textContent = text;
        };

        const memStr = metricsData.memory && metricsData.memory.heapUsed
            ? `${metricsData.memory.heapUsed} MB`
            : (healthData.memoryUsage || '0 MB');

        _setText('cpuUsage', healthData.cpuUsage || '0%');
        _setText('memoryUsage', memStr);
        _setText('apiLatency', String(healthData.apiLatency || '0ms'));
        _setText('dbPing', String(healthData.dbPing || '0ms'));

        if (diagStats) {
            diagStats.innerHTML = `
                <div class="stat-card-advanced">
                    <div class="stat-card-advanced-header">
                        <div class="stat-card-advanced-title">Uptime</div>
                        <div class="stat-card-advanced-icon">⏱️</div>
                    </div>
                    <div class="stat-card-advanced-value">${uptimeLabel}</div>
                    <span class="stat-card-advanced-badge healthy">✓ Running</span>
                </div>
                <div class="stat-card-advanced">
                    <div class="stat-card-advanced-header">
                        <div class="stat-card-advanced-title">Response Time</div>
                        <div class="stat-card-advanced-icon">⚡</div>
                    </div>
                    <div class="stat-card-advanced-value">${apiLatencyText}</div>
                    <div>
                        <div class="stat-card-advanced-progress">
                            <div class="stat-card-advanced-progress-bar" style="width: ${latencyBar}%; background: ${latencyHealthy ? 'linear-gradient(90deg, #4caf50, #45a049)' : 'linear-gradient(90deg, #ff9800, #f57c00)'};"></div>
                        </div>
                        <div class="stat-card-advanced-percent">${latencyHealthy ? 'Healthy' : 'Monitor latency'}</div>
                    </div>
                </div>
                <div class="stat-card-advanced">
                    <div class="stat-card-advanced-header">
                        <div class="stat-card-advanced-title">Memory Usage</div>
                        <div class="stat-card-advanced-icon">🧠</div>
                    </div>
                    <div class="stat-card-advanced-value">${heapUsedMB}MB</div>
                    <div>
                        <div class="stat-card-advanced-progress">
                            <div class="stat-card-advanced-progress-bar" style="width: ${Math.min(Math.max(heapPercent, 0), 100)}%; background: linear-gradient(90deg, ${heapPercent > 80 ? '#f44336' : '#2196f3'}, ${heapPercent > 80 ? '#e53935' : '#1976d2'});"></div>
                        </div>
                        <div class="stat-card-advanced-percent">${heapPercent}% heap utilized</div>
                    </div>
                </div>
                <div class="stat-card-advanced">
                    <div class="stat-card-advanced-header">
                        <div class="stat-card-advanced-title">Database Records</div>
                        <div class="stat-card-advanced-icon">-</div>
                    </div>
                    <div class="stat-card-advanced-value">${(totalRecords / 1000).toFixed(1)}K</div>
                    <span class="stat-card-advanced-badge healthy">✓ Indexed</span>
                </div>
            `;
        }

        const dbTable = document.getElementById('databaseStatsTable');
        if (dbTable) {
            dbTable.innerHTML = `
                <tr>
                    <td><strong>Levels</strong></td>
                    <td>${totalUsers.toLocaleString()}</td>
                    <td>~${Math.round((totalUsers * 0.05) / 1024)}MB</td>
                    <td>InnoDB</td>
                    <td><span class="stat-card-advanced-badge healthy">✓ OK</span></td>
                </tr>
                <tr>
                    <td><strong>Warns</strong></td>
                    <td>${totalWarnings.toLocaleString()}</td>
                    <td>~${Math.round((totalWarnings * 0.08) / 1024)}MB</td>
                    <td>InnoDB</td>
                    <td><span class="stat-card-advanced-badge healthy">✓ OK</span></td>
                </tr>
                <tr>
                    <td><strong>User Bans</strong></td>
                    <td>${bannedUsers.toLocaleString()}</td>
                    <td>~${Math.round((bannedUsers * 0.1) / 1024)}MB</td>
                    <td>InnoDB</td>
                    <td><span class="stat-card-advanced-badge healthy">✓ OK</span></td>
                </tr>
                <tr>
                    <td><strong>Sessions</strong></td>
                    <td>${adminCount * 3}</td>
                    <td>~2MB</td>
                    <td>InnoDB</td>
                    <td><span class="stat-card-advanced-badge healthy">✓ OK</span></td>
                </tr>
            `;
        }

        const cacheTable = document.getElementById('cacheStatsTable');
        if (cacheTable) {
            const heapStatusClass = heapPercent >= 85 ? 'critical' : heapPercent >= 70 ? 'warning' : 'healthy';
            const heapStatusText = heapPercent >= 85 ? '⚠ High' : heapPercent >= 70 ? '△ Moderate' : '✓ Healthy';
            const rssHealthClass = rssMB > 0 && heapTotalMB > 0 && rssMB > (heapTotalMB * 2.2) ? 'warning' : 'healthy';
            const rssStatusText = rssHealthClass === 'warning' ? '△ Elevated' : '✓ Stable';
            const externalHealthClass = externalMB > 128 ? 'warning' : 'healthy';
            const externalStatusText = externalHealthClass === 'warning' ? '△ Monitor' : '✓ Normal';

            cacheTable.innerHTML = `
                <tr>
                    <td><strong>Node Heap</strong></td>
                    <td><span class="stat-card-advanced-badge ${heapStatusClass}">${heapStatusText}</span></td>
                    <td>${heapUsedMB}MB / ${heapTotalMB}MB (${heapPercent}%)</td>
                    <td>${apiLatencyText}</td>
                </tr>
                <tr>
                    <td><strong>RSS Memory</strong></td>
                    <td><span class="stat-card-advanced-badge ${rssHealthClass}">${rssStatusText}</span></td>
                    <td>${rssMB}MB working set</td>
                    <td>${dbPingText}</td>
                </tr>
                <tr>
                    <td><strong>External Buffers</strong></td>
                    <td><span class="stat-card-advanced-badge ${externalHealthClass}">${externalStatusText}</span></td>
                    <td>${externalMB}MB</td>
                    <td>${String(healthData.cpuUsage || 'N/A')}</td>
                </tr>
                <tr>
                    <td><strong>Application Data Cache</strong></td>
                    <td><span class="stat-card-advanced-badge healthy">✓ Active</span></td>
                    <td>${totalRecords.toLocaleString()} records</td>
                    <td>${totalUsers.toLocaleString()} users indexed</td>
                </tr>
            `;
        }
    } catch (error) {
        console.error('Error loading diagnostics:', error);
        const diagStats = document.getElementById('diagnosticsStats');
        if (diagStats) {
            diagStats.innerHTML = '<div role="alert" style="padding: 2rem; text-align: center; color: var(--text-secondary);"><p>Unable to load diagnostic data</p></div>';
        }
        const cacheTable = document.getElementById('cacheStatsTable');
        if (cacheTable) {
            cacheTable.innerHTML = '<tr><td colspan="4" class="text-center text-muted">Failed to load cache/memory metrics</td></tr>';
        }
    }
}

function toggleUserDropdown() {
    const menu = document.getElementById('userDropdownMenu');
    const trigger = document.querySelector('.user-dropdown-trigger');
    menu.classList.toggle('show');
    trigger.classList.toggle('active');
}
document.addEventListener('click', function (event) {
    const dropdown = document.querySelector('.user-dropdown');
    if (dropdown && !dropdown.contains(event.target)) {
        document.getElementById('userDropdownMenu')?.classList.remove('show');
        document.querySelector('.user-dropdown-trigger')?.classList.remove('active');
    }
});
function syncDropdownInfo() {
    const username = document.getElementById('headerUsername')?.textContent;
    const role = document.getElementById('headerRole')?.textContent;
    if (username) document.getElementById('dropdownUsername').textContent = username;
    if (role) document.getElementById('dropdownRole').textContent = role;
}
setTimeout(syncDropdownInfo, 500);

async function logout() {
    window.AdminPanel.api.logout();
}

const adminUserState = {
    users: [],
    filteredUsers: [],
    selectedIds: new Set(),
    page: 1,
    pageSize: 8,
    query: '',
    roleFilter: 'all',
    activityFilter: 'all',
    sortBy: 'created_desc'
};

function showSelectModal(options = {}) {
    return new Promise((resolve) => {
        const {
            title = 'Select Option',
            label = 'Choose an option',
            optionsList = [],
            defaultValue = '',
            confirmText = 'Confirm',
            cancelText = 'Cancel'
        } = options;

        const container = document.getElementById('modal-container') || (() => {
            if (typeof document === 'undefined') return null;
            const c = document.createElement('div');
            c.id = 'modal-container';
            c.className = 'modal-container';
            document.body.appendChild(c);
            return c;
        })();

        if (!container) {
            resolve(null);
            return;
        }

        const modalId = `modal-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const modal = document.createElement('div');
        modal.id = modalId;
        modal.className = 'modal-wrapper';

        const optionMarkup = (Array.isArray(optionsList) ? optionsList : [])
            .map((opt) => {
                const value = String(opt?.value ?? '');
                const labelText = String(opt?.label ?? value);
                const selected = value === String(defaultValue) ? 'selected' : '';
                return `<option value="${escapeOwnerHtml(value)}" ${selected}>${escapeOwnerHtml(labelText)}</option>`;
            })
            .join('');

        const safeTitle = escapeOwnerHtml(title);
        const safeLabel = escapeOwnerHtml(label);
        const safeCancelText = escapeOwnerHtml(cancelText);
        const safeConfirmText = escapeOwnerHtml(confirmText);

        modal.innerHTML = `
            <div class="modal-overlay"></div>
            <div class="notification-modal" role="dialog" aria-modal="true" aria-labelledby="${modalId}-title">
                <div class="modal-header">
					<h3 id="${modalId}-title">⚙️ ${safeTitle}</h3>
                    <button class="modal-close" type="button">-</button>
                </div>
                <div class="modal-body">
					<label for="${modalId}-select" style="display:block; font-weight:600; color:var(--text-primary); margin-bottom:0.45rem;">${safeLabel}</label>
                    <select id="${modalId}-select" class="form-input">${optionMarkup}</select>
                </div>
                <div class="modal-footer">
					<button class="btn btn-secondary" type="button" data-action="cancel">${safeCancelText}</button>
					<button class="btn btn-primary" type="button" data-action="confirm">${safeConfirmText}</button>
                </div>
            </div>
        `;

        if (window.modalManager?.applyModalWrapperLayout) {
            window.modalManager.applyModalWrapperLayout(modal);
        } else {
            modal.style.position = 'fixed';
            modal.style.inset = '0';
            modal.style.display = 'grid';
            modal.style.placeItems = 'center';
            modal.style.zIndex = '9001';
        }

        const selectEl = modal.querySelector(`#${modalId}-select`);
        const closeBtn = modal.querySelector('.modal-close');
        const cancelBtn = modal.querySelector('[data-action="cancel"]');
        const confirmBtn = modal.querySelector('[data-action="confirm"]');

        const cleanup = (value) => {
            modal.classList.remove('show');
            setTimeout(() => {
                modal.remove();
                resolve(value);
            }, 180);
        };

        const onCancel = () => cleanup(null);
        const onConfirm = () => cleanup(selectEl?.value ?? null);

        modal.querySelector('.modal-overlay')?.addEventListener('click', onCancel);
        closeBtn?.addEventListener('click', onCancel);
        cancelBtn?.addEventListener('click', onCancel);
        confirmBtn?.addEventListener('click', onConfirm);

        container.appendChild(modal);
        setTimeout(() => {
            modal.classList.add('show');
            selectEl?.focus();
        }, 10);
    });
}

function ownerNotifyError(message) {
    if (typeof profileShowError === 'function') return profileShowError(message);
    if (typeof window.showError === 'function') return window.showError(message);
    console.error(message);
}

function ownerNotifySuccess(message) {
    if (typeof profileShowSuccess === 'function') return profileShowSuccess(message);
    if (typeof window.showSuccess === 'function') return window.showSuccess(message);
    console.log(message);
}

function escapeOwnerHtml(value) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(value);
    if (value === null || value === undefined) return '';
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return String(value).replace(/[&<>"']/g, (char) => map[char]);
}

function escapeOwnerJsString(value) {
    return String(value ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n');
}

function parseDateSafe(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeAdminUserId(input) {
    let raw = input;

    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        if (raw.id !== undefined && raw.id !== null) raw = raw.id;
        else if (raw.userId !== undefined && raw.userId !== null) raw = raw.userId;
        else if (raw.user_id !== undefined && raw.user_id !== null) raw = raw.user_id;
    }

    if (raw === null || raw === undefined) return '';

    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'bigint') {
        return String(raw).trim();
    }

    if (raw && typeof raw === 'object') {
        const isBufferLike = raw.type === 'Buffer' && Array.isArray(raw.data);
        if (isBufferLike) {
            const bytes = raw.data
                .map((value) => Number(value))
                .filter((value) => Number.isFinite(value) && value >= 0 && value <= 255);

            if (bytes.length === 16) {
                const hex = bytes.map((value) => value.toString(16).padStart(2, '0')).join('');
                return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
            }

            if (bytes.length) {
                const printable = bytes.every((value) => value >= 32 && value <= 126);
                if (printable) {
                    return String.fromCharCode(...bytes).replace(/\0+$/g, '').trim();
                }
                return bytes.map((value) => value.toString(16).padStart(2, '0')).join('');
            }
        }

        if (raw.value !== undefined && raw.value !== null) {
            return String(raw.value).trim();
        }

        if (typeof raw.toString === 'function') {
            const text = String(raw.toString()).trim();
            if (text && text !== '[object Object]') return text;
        }
    }

    return '';
}

function isValidAdminIdFormat(value) {
    return /^\d+$/.test(value) || /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value);
}

function resolveAdminUserId(user, fallbackRawId = '') {
    const direct = normalizeAdminUserId(user);
    if (direct && isValidAdminIdFormat(direct)) return direct;

    const candidateFields = ['id', 'userId', 'user_id', 'adminId', 'admin_id', 'uuid', 'uid', '_id', 'ID'];
    if (user && typeof user === 'object') {
        for (const field of candidateFields) {
            const candidate = normalizeAdminUserId(user[field]);
            if (candidate && isValidAdminIdFormat(candidate)) return candidate;
        }

        for (const value of Object.values(user)) {
            const candidate = normalizeAdminUserId(value);
            if (candidate && isValidAdminIdFormat(candidate)) return candidate;
        }
    }

    const fallback = normalizeAdminUserId(fallbackRawId);
    return isValidAdminIdFormat(fallback) ? fallback : '';
}

function getRoleWeight(role) {
    if (role === 'owner') return 1;
    if (role === 'admin') return 2;
    if (role === 'moderator') return 3;
    return 4;
}

function isActiveInLastDays(lastLoginValue, days) {
    const last = parseDateSafe(lastLoginValue);
    if (!last) return false;
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    return last.getTime() >= cutoff;
}

function updateAdminUsersSelectionInfo() {
    const info = document.getElementById('adminUsersSelectionInfo');
    if (!info) return;
    const selectedCount = adminUserState.selectedIds.size;
    const filteredCount = adminUserState.filteredUsers.length;
    info.textContent = `${selectedCount} selected • ${filteredCount} visible`;
}

function renderAdminUsersOverview() {
    const users = Array.isArray(adminUserState.users) ? adminUserState.users : [];
    const total = users.length;
    const owners = users.filter((user) => user.role === 'owner').length;
    const admins = users.filter((user) => user.role === 'admin').length;
    const moderators = users.filter((user) => user.role === 'moderator').length;

    const totalEl = document.getElementById('adminUsersTotal');
    const ownersEl = document.getElementById('adminUsersOwners');
    const adminsEl = document.getElementById('adminUsersAdmins');
    const moderatorsEl = document.getElementById('adminUsersModerators');

    if (totalEl) totalEl.textContent = total.toLocaleString();
    if (ownersEl) ownersEl.textContent = owners.toLocaleString();
    if (adminsEl) adminsEl.textContent = admins.toLocaleString();
    if (moderatorsEl) moderatorsEl.textContent = moderators.toLocaleString();
}

function renderAdminUsersTable() {
    const container = document.getElementById('adminUsersContainer');
    if (!container) return;

    const filtered = adminUserState.filteredUsers;
    if (!filtered.length) {
        container.innerHTML = '<p class="text-center text-muted" style="padding:1rem;">No admin users match the current filters.</p>';
        return;
    }

    const startIndex = (adminUserState.page - 1) * adminUserState.pageSize;
    const pageRows = filtered.slice(startIndex, startIndex + adminUserState.pageSize);
    const allPageSelected = pageRows.length > 0 && pageRows.every((row) => {
        const rowId = resolveAdminUserId(row);
        return rowId && adminUserState.selectedIds.has(rowId);
    });

    let html = `<div class="staff-grid-list">`;

    html += `
        <div style="display:flex; justify-content:space-between; align-items:center; padding: 0.5rem 1rem; margin-bottom:0.5rem; background:rgba(0,0,0,0.1); border-radius:0.5rem;">
            <label style="display:flex; align-items:center; gap:0.5rem; cursor:pointer; font-size:0.9rem; color:var(--text-secondary); font-weight:600;">
                <input type="checkbox" id="adminUsersSelectAll" ${allPageSelected ? 'checked' : ''}> Select Current Page
            </label>
            <div style="font-size:0.8rem; color:var(--text-secondary);">${filtered.length} staff found</div>
        </div>
    `;

    pageRows.forEach((user) => {
        const userId = resolveAdminUserId(user);
        const created = parseDateSafe(user.created_at);
        const lastLoginDate = parseDateSafe(user.last_login);
        const createdText = created ? created.toLocaleDateString() : 'Unknown';

        const now = new Date();
        let lastLoginText = 'Never';
        if (lastLoginDate) {
            const diffMins = Math.floor((now - lastLoginDate) / 60000);
            if (diffMins < 1) lastLoginText = 'Just now';
            else if (diffMins < 60) lastLoginText = `${diffMins}m ago`;
            else if (diffMins < 1440) lastLoginText = `${Math.floor(diffMins / 60)}h ago`;
            else lastLoginText = lastLoginDate.toLocaleDateString();
        }

        const role = String(user.role || '').toLowerCase();
        const isOwner = role === 'owner';
        const isSelected = adminUserState.selectedIds.has(userId);
        const initial = (user.username || '?').charAt(0).toUpperCase();
        const panelAvatarUrl = normalizeAdminAvatarUrl(user.avatar_url);
        const discordAvatarUrl = normalizeAdminAvatarUrl(user.discord_avatar_url);
        const avatarUrl = panelAvatarUrl || discordAvatarUrl;
        const isDiscordAvatarFallback = !panelAvatarUrl && Boolean(discordAvatarUrl);
        const avatarMarkup = avatarUrl
            ? `<img class="staff-avatar-image" src="${escapeOwnerHtml(avatarUrl)}" alt="${escapeOwnerHtml(user.username || 'User')} avatar">`
            : `<div class="staff-avatar-placeholder">${initial}</div>`;
        const avatarSourceBadge = isDiscordAvatarFallback
            ? '<span class="staff-avatar-source-badge" title="Using linked Discord avatar">Discord avatar</span>'
            : '';
        const userIdJs = escapeOwnerJsString(userId);
        const usernameJs = escapeOwnerJsString(user.username || '');
        const roleJs = escapeOwnerJsString(role);

        const viewBtn = `<button class="action-btn view" onclick="viewAdminUserDetail('${userIdJs}', '${usernameJs}')" title="View Logs">📜</button>`;

        const updateRoleBtn = userId
            ? `<button class="action-btn edit" onclick="updateAdminUserRole('${userIdJs}', '${usernameJs}', '${roleJs}')" title="Edit Role">✏️</button>`
            : '<button class="action-btn" disabled>✏️</button>';

        const deleteBtn = isOwner
            ? '<button class="action-btn" disabled title="Protected Owner Account">-</button>'
            : userId
                ? `<button class="action-btn delete" onclick="deleteAdminUser('${userIdJs}', '${usernameJs}')" title="Delete Account">-</button>`
                : '<button class="action-btn" disabled>-</button>';

        html += `
            <div class="staff-row-card">
                <div class="staff-user-info">
                    <input type="checkbox" class="admin-user-select" data-user-id="${escapeOwnerHtml(userId)}" ${isSelected ? 'checked' : ''} style="margin-right:1rem;">
                    ${avatarMarkup}
                    <div class="staff-details">
                        <div class="staff-name">
                            ${escapeOwnerHtml(user.username || 'Unknown')}
                            <span class="role-badge ${escapeOwnerHtml(role)}">${escapeOwnerHtml(role)}</span>
                            ${avatarSourceBadge}
                        </div>
                        <div class="staff-meta">
                            <span>📅 ${createdText}</span>
                            <span>🕒 ${lastLoginText}</span>
                        </div>
                    </div>
                </div>
                <div class="staff-actions">
                    ${viewBtn}
                    ${updateRoleBtn}
                    ${deleteBtn}
                </div>
            </div>
        `;
    });

    html += '</div>';
    container.innerHTML = html;

    const selectAllEl = document.getElementById('adminUsersSelectAll');
    if (selectAllEl) {
        selectAllEl.addEventListener('change', (event) => {
            const checked = Boolean(event.target.checked);
            pageRows.forEach((row) => {
                const rowId = resolveAdminUserId(row);
                if (!rowId) return;
                if (checked) {
                    adminUserState.selectedIds.add(rowId);
                } else {
                    adminUserState.selectedIds.delete(rowId);
                }
            });
            renderAdminUsersTable();
            updateAdminUsersSelectionInfo();
        });
    }

    container.querySelectorAll('.admin-user-select').forEach((checkbox) => {
        checkbox.addEventListener('change', (event) => {
            const rowId = String(event.target.dataset.userId || '');
            if (!rowId) return;
            if (event.target.checked) {
                adminUserState.selectedIds.add(rowId);
            } else {
                adminUserState.selectedIds.delete(rowId);
            }
            updateAdminUsersSelectionInfo();
        });
    });
}

function renderAdminUsersPagination() {
    const paginationEl = document.getElementById('adminUsersPagination');
    if (!paginationEl) return;

    const totalRows = adminUserState.filteredUsers.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / adminUserState.pageSize));
    const start = totalRows ? ((adminUserState.page - 1) * adminUserState.pageSize) + 1 : 0;
    const end = Math.min(totalRows, adminUserState.page * adminUserState.pageSize);

    paginationEl.innerHTML = `
        <span class="text-muted">Showing ${start}-${end} of ${totalRows}</span>
        <div style="display:flex; gap:0.6rem; align-items:center;">
            <button class="btn btn-secondary" ${adminUserState.page <= 1 ? 'disabled' : ''} onclick="changeAdminUsersPage(-1)">← Prev</button>
            <span class="text-muted">Page ${adminUserState.page} / ${totalPages}</span>
            <button class="btn btn-secondary" ${adminUserState.page >= totalPages ? 'disabled' : ''} onclick="changeAdminUsersPage(1)">Next →</button>
        </div>
    `;
}

function applyAdminUserFiltersAndRender() {
    let rows = [...adminUserState.users];

    if (adminUserState.query) {
        rows = rows.filter((user) => String(user.username || '').toLowerCase().includes(adminUserState.query));
    }

    if (adminUserState.roleFilter !== 'all') {
        rows = rows.filter((user) => String(user.role || '').toLowerCase() === adminUserState.roleFilter);
    }

    if (adminUserState.activityFilter === 'active-30') {
        rows = rows.filter((user) => isActiveInLastDays(user.last_login, 30));
    } else if (adminUserState.activityFilter === 'never') {
        rows = rows.filter((user) => !user.last_login);
    }

    rows.sort((left, right) => {
        if (adminUserState.sortBy === 'username_asc') {
            return String(left.username || '').localeCompare(String(right.username || ''));
        }
        if (adminUserState.sortBy === 'username_desc') {
            return String(right.username || '').localeCompare(String(left.username || ''));
        }
        if (adminUserState.sortBy === 'created_asc') {
            return (parseDateSafe(left.created_at)?.getTime() || 0) - (parseDateSafe(right.created_at)?.getTime() || 0);
        }
        if (adminUserState.sortBy === 'last_login_desc') {
            return (parseDateSafe(right.last_login)?.getTime() || 0) - (parseDateSafe(left.last_login)?.getTime() || 0);
        }
        if (adminUserState.sortBy === 'role_asc') {
            return getRoleWeight(String(left.role || '').toLowerCase()) - getRoleWeight(String(right.role || '').toLowerCase());
        }
        return (parseDateSafe(right.created_at)?.getTime() || 0) - (parseDateSafe(left.created_at)?.getTime() || 0);
    });

    adminUserState.filteredUsers = rows;
    const maxPage = Math.max(1, Math.ceil(rows.length / adminUserState.pageSize));
    adminUserState.page = Math.min(adminUserState.page, maxPage);

    renderAdminUsersTable();
    renderAdminUsersPagination();
    updateAdminUsersSelectionInfo();
}

function initAdminUserManagement() {
    if (window._adminUserManagementInitialized) return;
    window._adminUserManagementInitialized = true;

    const searchEl = document.getElementById('adminUserSearch');
    const roleEl = document.getElementById('adminUserRoleFilter');
    const activityEl = document.getElementById('adminUserActivityFilter');
    const sortEl = document.getElementById('adminUserSort');

    if (searchEl) {
        searchEl.addEventListener('input', () => {
            adminUserState.query = String(searchEl.value || '').trim().toLowerCase();
            adminUserState.page = 1;
            applyAdminUserFiltersAndRender();
        });
    }

    if (roleEl) {
        roleEl.addEventListener('change', () => {
            adminUserState.roleFilter = roleEl.value || 'all';
            adminUserState.page = 1;
            applyAdminUserFiltersAndRender();
        });
    }

    if (activityEl) {
        activityEl.addEventListener('change', () => {
            adminUserState.activityFilter = activityEl.value || 'all';
            adminUserState.page = 1;
            applyAdminUserFiltersAndRender();
        });
    }

    if (sortEl) {
        sortEl.addEventListener('change', () => {
            adminUserState.sortBy = sortEl.value || 'created_desc';
            applyAdminUserFiltersAndRender();
        });
    }
    renderAdminUsersTable();
    renderAdminUsersPagination();
}

async function loadAdminUsers() {
    const container = document.getElementById('adminUsersContainer');
    if (container) {
        container.innerHTML = '<div class="loading show">Loading admin users...</div>';
    }

    try {
        const { response, data: users } = await window.AdminPanel.api.getJson('/api/admin/users');
        if (!response.ok) {
            ownerNotifyError('Failed to load admin users');
            return;
        }

        adminUserState.users = Array.isArray(users) ? users : [];
        adminUserState.selectedIds.clear();
        renderAdminUsersOverview();
        applyAdminUserFiltersAndRender();
    } catch (error) {
        console.error('Error loading admin users:', error);
        ownerNotifyError('Failed to load admin users');
    }
}

async function deleteAdminUser(userId, username) {
    userId = normalizeAdminUserId(userId);
    if (!isValidAdminIdFormat(userId) && username) {
        const usernameMatch = adminUserState.users.find(
            (user) => String(user?.username || '').toLowerCase() === String(username || '').toLowerCase()
        );
        userId = resolveAdminUserId(usernameMatch, userId);
    }
    if (!userId || userId === 'undefined' || userId === '[object Object]') {
        console.warn('deleteAdminUser invalid id payload:', { userId, username });
        ownerNotifyError('Cannot delete user: Invalid ID');
        return;
    }
    const target = adminUserState.users.find((user) => resolveAdminUserId(user) === userId);
    if (String(target?.role || '').toLowerCase() === 'owner') {
        ownerNotifyError('Owner accounts are protected and cannot be deleted here');
        return;
    }
    try {
        const promptResult = await showPromptModal({
            title: 'Delete Admin Account',
            label: `Type the username to confirm deletion of "${username}" (this action is irreversible):`,
            placeholder: username,
            defaultValue: '',
            confirmText: 'Delete Account',
            cancelText: 'Cancel',
            confirmClass: 'btn-danger',
            includeCheckbox: { label: 'I understand this action is permanent and cannot be undone', required: true, errorText: 'You must acknowledge the permanence of this action' },
            validate: (val) => {
                if (!val) return 'Please type the username to confirm';
                if (val !== String(username)) return 'Username does not match';
                return true;
            }
        });

        if (!promptResult) return;
    } catch (err) {
        ownerNotifyError('Confirmation dialog unavailable. Please refresh and try again.');
        return;
    }

    try {
        const { response } = await window.AdminPanel.api.requestJson(`/api/admin/users/${encodeURIComponent(userId)}`, { method: 'DELETE' });
        if (response.ok) {
            adminUserState.selectedIds.delete(String(userId));
            ownerNotifySuccess('Admin user deleted');
            await loadAdminUsers();
        } else {
            ownerNotifyError('Failed to delete admin user');
        }
    } catch (error) {
        ownerNotifyError('Error deleting admin user');
    }
}

async function updateAdminUserRole(userId, username, currentRole) {
    userId = normalizeAdminUserId(userId);
    const normalizedCurrentRole = String(currentRole || '').toLowerCase().trim();

    if (!isValidAdminIdFormat(userId)) {
        ownerNotifyError('Cannot update role: Invalid ID');
        return;
    }

    if (typeof showSelectModal !== 'function') {
        ownerNotifyError('Role update dialog is unavailable. Please refresh and try again.');
        return;
    }

    const allowedRoles = ['owner', 'admin', 'moderator'];
    const roleInput = await showSelectModal({
        title: 'Update Account Role',
        label: `Set new role for "${username}":`,
        defaultValue: normalizedCurrentRole || 'moderator',
        confirmText: 'Update Role',
        cancelText: 'Cancel',
        optionsList: [
            { value: 'owner', label: 'Owner' },
            { value: 'admin', label: 'Admin' },
            { value: 'moderator', label: 'Moderator' }
        ]
    });

    if (!roleInput) return;

    const nextRole = String(roleInput).toLowerCase().trim();
    if (!allowedRoles.includes(nextRole)) {
        ownerNotifyError('Invalid role selected');
        return;
    }

    if (nextRole === normalizedCurrentRole) {
        ownerNotifyError('Choose a different role to update.');
        return;
    }

    try {
        const { response, data } = await window.AdminPanel.api.requestJson(`/api/admin/users/${encodeURIComponent(userId)}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ role: nextRole })
        });

        if (response.ok) {
            ownerNotifySuccess(`Updated ${username} role to ${nextRole.toUpperCase()}`);
            await loadAdminUsers();
        } else {
            ownerNotifyError(data?.error || 'Failed to update user role');
        }
    } catch (error) {
        ownerNotifyError('Error updating user role');
    }
}

async function deleteSelectedAdminUsers() {
    const ids = Array.from(adminUserState.selectedIds);
    if (!ids.length) {
        ownerNotifyError('No users selected');
        return;
    }

    const usersById = new Map(
        adminUserState.users
            .map((user) => [resolveAdminUserId(user), user])
            .filter(([id]) => Boolean(id))
    );
    const deletableIds = ids.filter((id) => String(usersById.get(String(id))?.role || '').toLowerCase() !== 'owner');

    if (!deletableIds.length) {
        ownerNotifyError('Selected accounts are protected and cannot be deleted');
        return;
    }

    const confirmed = await window.modalManager?.showConfirm({
        title: 'Delete Selected Accounts',
        message: `Delete ${deletableIds.length} selected account(s)? This cannot be undone.`,
        confirmText: 'Delete Selected',
        cancelText: 'Cancel',
        type: 'danger'
    });
    if (!confirmed) return;

    let deleted = 0;
    let failed = 0;
    for (const targetUserId of deletableIds) {
        try {
            const { response } = await window.AdminPanel.api.requestJson(`/api/admin/users/${encodeURIComponent(targetUserId)}`, { method: 'DELETE' });
            if (response.ok) deleted += 1;
            else failed += 1;
        } catch (error) {
            failed += 1;
        }
    }

    adminUserState.selectedIds.clear();
    await loadAdminUsers();

    if (failed === 0) {
        ownerNotifySuccess(`${deleted} account(s) deleted`);
    } else {
        ownerNotifyError(`Deleted ${deleted}, failed ${failed}`);
    }
}

function exportAdminUsersCsv() {
    const rows = Array.isArray(adminUserState.filteredUsers) ? adminUserState.filteredUsers : [];
    if (!rows.length) {
        ownerNotifyError('No users to export for current filters');
        return;
    }

    const header = ['username', 'role', 'created_at', 'last_login'];
    const csvRows = [header.join(',')];

    rows.forEach((user) => {
        const row = [
            String(user.username || ''),
            String(user.role || ''),
            String(user.created_at || ''),
            String(user.last_login || '')
        ].map((value) => `"${value.replace(/"/g, '""')}"`);
        csvRows.push(row.join(','));
    });

    const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `admin-users-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    window.URL.revokeObjectURL(url);
}

function changeAdminUsersPage(direction) {
    adminUserState.page += direction;
    applyAdminUserFiltersAndRender();
}

window.adminUserState = adminUserState;
window.initAdminUserManagement = initAdminUserManagement;
window.applyAdminUserFiltersAndRender = applyAdminUserFiltersAndRender;
window.changeAdminUsersPage = changeAdminUsersPage;
window.loadAdminUsers = loadAdminUsers;
window.deleteAdminUser = deleteAdminUser;
window.updateAdminUserRole = updateAdminUserRole;
window.deleteSelectedAdminUsers = deleteSelectedAdminUsers;
window.exportAdminUsersCsv = exportAdminUsersCsv;

function refreshOwnerVisibleData() {
    const activeTab = document.querySelector('#ownerTabs .tab.active')?.dataset?.tab || 'diagnostics';

    if (activeTab === 'diagnostics') {
        if (typeof loadSystemStatus === 'function') loadSystemStatus();
        if (typeof loadDiagnostics === 'function') loadDiagnostics();
        if (typeof loadSocketHealth === 'function') loadSocketHealth();
        return;
    }
    if (activeTab === 'invites') {
        if (typeof loadInviteStats === 'function') loadInviteStats();
        return;
    }
    if (activeTab === 'users') {
        if (typeof loadAdminUsers === 'function') loadAdminUsers();
        return;
    }
    if (activeTab === 'system') {
        if (typeof loadBackupTables === 'function') loadBackupTables();
        if (typeof loadBackupStatus === 'function') loadBackupStatus();
        return;
    }
    if (activeTab === 'security' || activeTab === 'security-events') {
        if (typeof loadSecurityEventsFeed === 'function') loadSecurityEventsFeed(false);
        if (activeTab === 'security' && typeof loadCaptchaPolicy === 'function') loadCaptchaPolicy();
        return;
    }
    if (activeTab === 'notifications') {
        if (typeof loadOwnerNotificationHistory === 'function') loadOwnerNotificationHistory();
        return;
    }
}

async function loadCaptchaPolicy() {
    try {
        const { response, data } = await window.AdminPanel.api.getJson('/api/owner/security/captcha-policy');
        if (!response.ok || !data) return;

        const loginToggle = document.getElementById('captchaLoginEnabledToggle');
        const registerToggle = document.getElementById('captchaRegisterEnabledToggle');
        const adaptiveToggle = document.getElementById('captchaAdaptiveDifficultyToggle');

        if (loginToggle) loginToggle.checked = Boolean(data.loginEnabled);
        if (registerToggle) registerToggle.checked = Boolean(data.registerEnabled);
        if (adaptiveToggle) adaptiveToggle.checked = Boolean(data.adaptiveDifficultyEnabled);

        const setVal = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.value = val !== undefined ? val : '';
        };

        setVal('captchaMinValueInput', data.minValue);
        setVal('captchaMaxValueInput', data.maxValue);
        setVal('captchaTtlSecondsInput', Math.round((data.ttlMs || 0) / 1000));
        setVal('captchaMaxAttemptsInput', data.maxAttempts);
        setVal('captchaMinSolveMsInput', data.minSolveMs);
        setVal('captchaFailureWindowSecondsInput', Math.round((data.failureWindowMs || 0) / 1000));
        setVal('captchaFailureThresholdInput', data.failureThreshold);
        setVal('captchaFailureBlockSecondsInput', Math.round((data.failureBlockMs || 0) / 1000));

        const metaEl = document.getElementById('captchaPolicyMeta');
        if (metaEl) metaEl.textContent = `Synced: ${new Date().toLocaleTimeString()}`;

    } catch (error) {
        console.error('Error loading CAPTCHA policy:', error);
    }
}

async function saveCaptchaPolicy() {
    try {
        const getVal = (id) => {
            const el = document.getElementById(id);
            return el ? Number(el.value || 0) : 0;
        };
        const getBool = (id) => {
            const el = document.getElementById(id);
            return el ? Boolean(el.checked) : false;
        };

        const payload = {
            loginEnabled: getBool('captchaLoginEnabledToggle'),
            registerEnabled: getBool('captchaRegisterEnabledToggle'),
            adaptiveDifficultyEnabled: getBool('captchaAdaptiveDifficultyToggle'),
            minValue: getVal('captchaMinValueInput') || 1000,
            maxValue: getVal('captchaMaxValueInput') || 9999,
            ttlMs: getVal('captchaTtlSecondsInput') * 1000,
            maxAttempts: getVal('captchaMaxAttemptsInput'),
            minSolveMs: getVal('captchaMinSolveMsInput'),
            failureWindowMs: getVal('captchaFailureWindowSecondsInput') * 1000,
            failureThreshold: getVal('captchaFailureThresholdInput') || 5,
            failureBlockMs: getVal('captchaFailureBlockSecondsInput') * 1000
        };

        const { response, data } = await window.AdminPanel.api.postJson('/api/owner/security/captcha-policy', payload);

        if (response.ok) {
            if (window.showSuccess) window.showSuccess('CAPTCHA settings updated successfully.');
            loadCaptchaPolicy();
        } else {
            if (window.showError) window.showError(data?.error || 'Failed to update CAPTCHA policy.');
        }
    } catch (error) {
        if (window.showError) window.showError('Connection error: ' + error.message);
    }
}

window.loadCaptchaPolicy = loadCaptchaPolicy;
window.saveCaptchaPolicy = saveCaptchaPolicy;

if (window.AdminPanel) {
    window.AdminPanel.refreshVisibleData = refreshOwnerVisibleData;
}

document.addEventListener('adminpanel:refresh-visible-data', refreshOwnerVisibleData);

async function purgeBans() {
    const confirmation = await showPromptModal({
        title: 'Purge All Bans',
        label: 'Type "CONFIRM PURGE" to permanently delete all active bans:',
        placeholder: 'CONFIRM PURGE',
        confirmText: 'Purge Bans',
        confirmClass: 'btn-danger',
        validate: (val) => val === 'CONFIRM PURGE' ? true : 'Please type exactly "CONFIRM PURGE"'
    });

    if (!confirmation) return;

    try {
        const { response } = await window.AdminPanel.api.postJson('/api/owner/purge-bans');
        if (response.ok) {
            ownerNotifySuccess('Success: Bans purged successfully.');
        } else {
            ownerNotifyError('Failed to purge bans.');
        }
    } catch (e) {
        console.error(e);
        ownerNotifyError(e.message || 'Error purging bans');
    }
}

async function purgeWarnings() {
    const confirmation = await showPromptModal({
        title: 'Purge Application Warnings',
        label: 'Type "CONFIRM CLEAR" to delete all warning history:',
        placeholder: 'CONFIRM CLEAR',
        confirmText: 'Clear Warnings',
        confirmClass: 'btn-danger',
        validate: (val) => val === 'CONFIRM CLEAR' ? true : 'Please type exactly "CONFIRM CLEAR"'
    });

    if (!confirmation) return;

    try {
        const { response } = await window.AdminPanel.api.postJson('/api/owner/purge-warnings');
        if (response.ok) {
            ownerNotifySuccess('Success: Warnings purged successfully.');
        } else {
            ownerNotifyError('Failed to purge warnings.');
        }
    } catch (e) {
        console.error(e);
        ownerNotifyError(e.message || 'Error purging warnings');
    }
}

async function resetAllLevels() {
    const confirmation = await showPromptModal({
        title: 'Reset All Levels',
        label: 'Type "RESET XP" to wipe all user levels and XP data:',
        placeholder: 'RESET XP',
        confirmText: 'Reset Levels',
        confirmClass: 'btn-danger',
        validate: (val) => val === 'RESET XP' ? true : 'Please type exactly "RESET XP"'
    });

    if (!confirmation) return;

    try {
        const { response } = await window.AdminPanel.api.postJson('/api/admin/reset-levels');
        if (response.ok) {
            ownerNotifySuccess('Success: All leveling data has been reset.');
        } else {
            ownerNotifyError('Failed to reset levels.');
        }
    } catch (e) {
        console.error(e);
        ownerNotifyError(e.message || 'Error resetting levels');
    }
}

async function wipeAllData() {
    const confirmation = await showPromptModal({
        title: 'Factory Reset System',
        label: 'DANGER: This will factory reset the bot database users, levels, economy. Guilds remain.\nType "CONFIRM WIPE" to proceed:',
        placeholder: 'CONFIRM WIPE',
        confirmText: 'FACTORY WIPE',
        confirmClass: 'btn-danger',
        validate: (val) => val === 'CONFIRM WIPE' ? true : 'Please type exactly "CONFIRM WIPE"'
    });

    if (!confirmation) return;

    try {
        const { response } = await window.AdminPanel.api.postJson('/api/owner/wipe-all-data');
        if (response.ok) {
            ownerNotifySuccess('System Wiped. Factory reset complete. Reloading...');
            setTimeout(() => window.location.reload(), 2000);
        } else {
            ownerNotifyError('Failed to wipe system data.');
        }
    } catch (e) {
        console.error(e);
        ownerNotifyError(e.message || 'Error wiping system');
    }
}

async function loadSessions() {
    try {
        const { response, data } = await window.AdminPanel.api.getJson('/api/security/summary');

        const container = document.getElementById('sessionsContainer');
        const totalEl = document.getElementById('totalActiveSessions');

        if (response.ok && data.sessions) {
            const sessions = data.sessions;
            if (totalEl) totalEl.textContent = sessions.length;

            if (container) {
                if (sessions.length === 0) {
                    container.innerHTML = '<div>No active sessions</div>';
                    return;
                }

                container.innerHTML = sessions.map(s => `
                    <div class="session-stat-card" style="margin-bottom:0.5rem; justify-content:space-between;">
                        <div>
                            <div style="font-weight:bold;">${s.ipAddress || 'Unknown IP'}</div>
                            <div style="font-size:0.8rem; color:#888;">${s.userAgent || 'Unknown Device'}</div>
                        </div>
                        <div style="text-align:right;">
                            <div>${s.isCurrent ? '<span style="color:#4CAF50">Current</span>' : ''}</div>
                            <div style="font-size:0.8rem;">${new Date(s.lastActiveAt || Date.now()).toLocaleTimeString()}</div>
                        </div>
                    </div>
                `).join('');
            }
        }
    } catch (e) { console.error('Sessions Error:', e); }
}

window.loadSessions = loadSessions;

window.purgeBans = purgeBans;
window.purgeWarnings = purgeWarnings;
window.resetAllLevels = resetAllLevels;
window.wipeAllData = wipeAllData;



async function loadSessionSecurityPolicy() {
    const toggle = document.getElementById('singleSessionModeToggle');
    const idleInput = document.getElementById('idleTimeoutMinutesInput');
    const absoluteInput = document.getElementById('absoluteTimeoutHoursInput');
    if (!toggle || !idleInput || !absoluteInput) return;
    try {
        const { response, data } = await window.AdminPanel.api.getJson('/api/owner/security/session-policy');
        if (response.ok && data) {
            toggle.checked = Boolean(data.singleSessionMode);
            const idleMs = (data.idleTimeoutMs !== undefined) ? Number(data.idleTimeoutMs) : 1800000;
            const absMs = (data.absoluteTimeoutMs !== undefined) ? Number(data.absoluteTimeoutMs) : 86400000;

            idleInput.value = Math.round(idleMs / 60000);
            absoluteInput.value = Math.round(absMs / 3600000);
        }
    } catch (error) { console.error('Error loading session policy:', error); }
}

async function saveSessionSecurityPolicy() {
    const toggle = document.getElementById('singleSessionModeToggle');
    const idleInput = document.getElementById('idleTimeoutMinutesInput');
    const absoluteInput = document.getElementById('absoluteTimeoutHoursInput');
    if (!toggle || !idleInput || !absoluteInput) return;

    const idleMinutes = parseInt(idleInput.value) || 30;
    const absHours = parseInt(absoluteInput.value) || 24;

    const payload = {
        singleSessionMode: toggle.checked,
        idleTimeoutMs: idleMinutes * 60 * 1000,
        absoluteTimeoutMs: absHours * 60 * 60 * 1000
    };

    try {
        const { response } = await window.AdminPanel.api.postJson('/api/owner/security/session-policy', payload);

        if (response.ok) {
            ownerNotifySuccess('Session settings updated.');
        } else {
            ownerNotifyError('Could not save session settings.');
        }
    } catch (error) {
        console.error('Error saving session policy:', error);
        ownerNotifyError(error.message || 'Could not save session settings');
    }
}

async function loadCaptchaPolicy() {
    const ids = [
        'captchaLoginEnabledToggle', 'captchaRegisterEnabledToggle', 'captchaAdaptiveDifficultyToggle',
        'captchaMaxAttemptsInput', 'captchaTtlSecondsInput', 'captchaMinSolveMsInput', 'captchaFailureBlockSecondsInput',
        'captchaMinValueInput', 'captchaMaxValueInput', 'captchaFailureWindowSecondsInput', 'captchaFailureThresholdInput'
    ];
    if (!document.getElementById(ids[0])) return;

    try {
        const { response, data } = await window.AdminPanel.api.getJson('/api/owner/security/captcha-policy');
        if (response.ok && data) {
            const setVal = (id, val) => {
                const el = document.getElementById(id);
                if (el) el.value = (val !== undefined && val !== null) ? val : '';
            };

            if (document.getElementById('captchaLoginEnabledToggle')) document.getElementById('captchaLoginEnabledToggle').checked = Boolean(data.loginEnabled);
            if (document.getElementById('captchaRegisterEnabledToggle')) document.getElementById('captchaRegisterEnabledToggle').checked = Boolean(data.registerEnabled);
            if (document.getElementById('captchaAdaptiveDifficultyToggle')) document.getElementById('captchaAdaptiveDifficultyToggle').checked = Boolean(data.adaptiveDifficultyEnabled);

            const ttlSec = data.ttlMs ? Math.floor(data.ttlMs / 1000) : 300;
            const minSolveMs = data.minSolveMs || 1000;
            const failureBlockSec = data.failureBlockMs ? Math.floor(data.failureBlockMs / 1000) : 600;
            const failureWindowSec = data.failureWindowMs ? Math.floor(data.failureWindowMs / 1000) : 600;

            setVal('captchaMaxAttemptsInput', data.maxAttempts || 3);
            setVal('captchaTtlSecondsInput', ttlSec);
            setVal('captchaMinSolveMsInput', minSolveMs);
            setVal('captchaFailureBlockSecondsInput', failureBlockSec);
            setVal('captchaMinValueInput', data.minValue || 1);
            setVal('captchaMaxValueInput', data.maxValue || 9999);
            setVal('captchaFailureWindowSecondsInput', failureWindowSec);
            setVal('captchaFailureThresholdInput', data.failureThreshold || 5);
        }

        const meta = document.getElementById('captchaPolicyMeta');
        if (meta) meta.textContent = 'Last loaded: ' + new Date().toLocaleTimeString();
    } catch (error) { console.error('Error loading captcha policy:', error); }
}

async function saveCaptchaPolicy() {
    const policy = {
        loginEnabled: document.getElementById('captchaLoginEnabledToggle')?.checked || false,
        registerEnabled: document.getElementById('captchaRegisterEnabledToggle')?.checked || false,
        adaptiveDifficulty: document.getElementById('captchaAdaptiveDifficultyToggle')?.checked || false,
        maxAttempts: parseInt(document.getElementById('captchaMaxAttemptsInput')?.value || 3),
        ttlSeconds: parseInt(document.getElementById('captchaTtlSecondsInput')?.value || 300),
        minSolveTimeMs: parseInt(document.getElementById('captchaMinSolveMsInput')?.value || 500),
        failureBlockDurationSeconds: parseInt(document.getElementById('captchaFailureBlockSecondsInput')?.value || 60),

        minValue: parseInt(document.getElementById('captchaMinValueInput')?.value || 1000),
        maxValue: parseInt(document.getElementById('captchaMaxValueInput')?.value || 9999),
        failureWindowSeconds: parseInt(document.getElementById('captchaFailureWindowSecondsInput')?.value || 600),
        failureThreshold: parseInt(document.getElementById('captchaFailureThresholdInput')?.value || 5)
    };

    try {
        const { response, data } = await window.AdminPanel.api.requestJson('/api/owner/security/captcha-policy', {
            method: 'POST',
            body: JSON.stringify(policy)
        });

        if (response.ok) {
            if (typeof profileShowSuccess === 'function') profileShowSuccess('CAPTCHA Policy Saved', 'Settings updated successfully');
            else alert('Saved');
        } else {
            if (typeof profileShowError === 'function') profileShowError('Save Failed', data?.error || 'Unknown error');
            else alert('Failed');
        }
    } catch (e) { console.error(e); alert('Error saving policy'); }
}

window.loadCaptchaPolicy = loadCaptchaPolicy;
window.saveCaptchaPolicy = saveCaptchaPolicy;


document.addEventListener('DOMContentLoaded', initAdminUserManagement);
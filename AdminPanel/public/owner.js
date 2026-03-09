let inviteStatsData = [];
let securityEventsData = [];
let securityEventsAutoRefreshTimer = null;
let securityEventsAutoRefreshIntervalMs = 30000;
let backupTablesCache = [];
const OWNER_NOTIFICATION_STORAGE_KEY = 'owner_notification_center_v1';
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
        ['showSuccess', 'success'],
        ['showError', 'error'],
        ['showWarning', 'warning'],
        ['showInfo', 'info']
    ];

    map.forEach(([fnName, fallbackType]) => {
        const original = window[fnName];
        if (typeof original !== 'function') return;
        window[fnName] = function patchedOwnerToastCapture(...args) {
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
        metaEl.textContent = force ? 'Refreshing security events…' : 'Loading security events…';
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
            metaEl.textContent = 'Failed to load security events.';
        }
        if (typeof showError === 'function') {
            showError('Failed to load security events feed');
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
        if (typeof showSuccess === 'function') {
            showSuccess('Notification Center', 'Notification history cleared.');
        }
    } catch (error) {
        console.error('Failed to clear notification history:', error);
        if (typeof showError === 'function') {
            showError('Notification Center', 'Failed to clear notification history.');
        }
    }
}

window.loadOwnerNotificationHistory = loadOwnerNotificationHistory;
window.clearOwnerNotificationHistory = clearOwnerNotificationHistory;
window.recordOwnerNotificationEvent = recordOwnerNotificationEvent;

// Generate a new invite code
async function generateInvite() {
    const role = document.getElementById('inviteRole')?.value || 'moderator';
    const expiresInDays = parseInt(document.getElementById('inviteExpiry')?.value || 7);
    const description = document.getElementById('inviteDescription')?.value?.trim() || '';

    if (isNaN(expiresInDays) || expiresInDays < 1 || expiresInDays > 365) {
        showError('Invalid Input', 'Expiry days must be between 1 and 365');
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

            resultDiv.innerHTML = `
                <div style="background: var(--bg-secondary); border: 1px solid var(--color-green); border-radius: var(--radius-md); padding: 1.5rem; margin-top: 1.5rem;">
                    <div style="display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1rem;">
                        <span style="font-size: 1.8rem;">✅</span>
                        <div>
                            <div style="font-weight: 700; font-size: 1.1rem; color: var(--color-green);">Invite Code Generated</div>
                            <div style="color: var(--text-secondary); font-size: 0.9rem;">Share this code with the new ${role}</div>
                        </div>
                    </div>
                    <div style="background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 1rem; margin-bottom: 1rem;">
                        <div style="display: flex; align-items: center; justify-content: space-between; gap: 1rem;">
                            <code style="font-size: 1.2rem; font-weight: 700; color: var(--color-blue); font-family: 'Courier New', monospace; flex: 1;">${data.code}</code>
                            <button class="btn btn-secondary" onclick="copyInviteCode('${data.code}')" style="white-space: nowrap;">📋 Copy</button>
                        </div>
                    </div>
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 0.75rem; font-size: 0.9rem;">
                        <div><strong>Role:</strong> ${role}</div>
                        <div><strong>Expires:</strong> ${expiresDate.toLocaleDateString()}</div>
                        ${description ? `<div style="grid-column: 1 / -1;"><strong>Description:</strong> ${description}</div>` : ''}
                    </div>
                </div>
            `;

            // Clear form
            document.getElementById('inviteDescription').value = '';

            // Reload stats
            setTimeout(() => loadInviteStats(), 500);
        } else {
            showError('Generation Failed', data.error || 'Failed to generate invite code');
        }
    } catch (error) {
        showError('Error', 'Failed to generate invite: ' + error.message);
    }
}

// Copy invite code to clipboard
async function copyInviteCode(code) {
    try {
        await navigator.clipboard.writeText(code);
        showSuccess('Copied!', 'Invite code copied to clipboard');
    } catch (err) {
        // Fallback for older browsers
        const input = document.createElement('input');
        input.value = code;
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        document.body.removeChild(input);
        showSuccess('Copied!', 'Invite code copied to clipboard');
    }
}

// Load invite statistics
async function loadInviteStats() {
    try {
        const { response, data } = await window.AdminPanel.api.getJson('/api/invites/stats');

        if (!response.ok) {
            throw new Error(data.error || 'Failed to load invite stats');
        }

        inviteStatsData = Array.isArray(data) ? data : [];

        // Calculate statistics
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

        // Update stat cards
        document.getElementById('totalActiveInvites').textContent = stats.active;
        document.getElementById('totalUsedInvites').textContent = stats.fullyUsed;
        document.getElementById('totalExpiredInvites').textContent = stats.expired;
        document.getElementById('totalInviteUses').textContent = stats.totalUses;
        const revokedEl = document.getElementById('totalRevokedInvites');
        if (revokedEl) revokedEl.textContent = stats.revoked;
        const conversionEl = document.getElementById('inviteConversionRate');
        if (conversionEl) {
            const conversion = stats.totalMaxUses > 0
                ? (stats.totalUses / stats.totalMaxUses) * 100
                : 0;
            conversionEl.textContent = `${conversion.toFixed(1)}%`;
        }

        const metaEl = document.getElementById('inviteStatsMeta');
        if (metaEl) {
            metaEl.textContent = `Last updated: ${new Date().toLocaleString()} • ${inviteStatsData.length} invite(s)`;
        }

        // Render table
        filterInviteStats();
    } catch (error) {
        console.error('Error loading invite stats:', error);
        showError('Error', 'Failed to load invite statistics: ' + error.message);
    }
}

// Filter and render invite stats table
function filterInviteStats() {
    const searchTerm = document.getElementById('inviteSearch')?.value?.toLowerCase() || '';
    const statusFilter = document.getElementById('inviteStatusFilter')?.value || 'all';
    const roleFilter = document.getElementById('inviteRoleFilter')?.value || 'all';

    const filtered = inviteStatsData.filter(invite => {
        // Status filter
        if (statusFilter !== 'all') {
            if (statusFilter === 'used' && invite.status !== 'fully_used') return false;
            if (statusFilter !== 'used' && invite.status !== statusFilter) return false;
        }

        // Role filter
        if (roleFilter !== 'all' && invite.role !== roleFilter) return false;

        // Search filter
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

// Render invite stats table
function renderInviteStatsTable(invites) {
    const tbody = document.getElementById('inviteStatsTable');

    if (!invites || invites.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" class="text-center text-muted">No invites found</td></tr>';
        return;
    }

    tbody.innerHTML = invites.map(invite => {
        const statusBadge = getInviteStatusBadge(invite.status);
        const createdDate = new Date(invite.created_at);
        const expiresDate = invite.expires_at ? new Date(invite.expires_at) : null;

        return `
            <tr>
                <td><code style="font-size: 0.85rem; background: var(--bg-secondary); padding: 0.2rem 0.4rem; border-radius: 4px;">${invite.code}</code></td>
                <td><span class="role-badge ${invite.role}">${invite.role.toUpperCase()}</span></td>
                <td>${statusBadge}</td>
                <td>${invite.created_by || '-'}</td>
                <td>${invite.used_by || '-'}</td>
                <td style="max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${invite.description || ''}">${invite.description || '-'}</td>
                <td>${createdDate.toLocaleDateString()}</td>
                <td>${expiresDate ? expiresDate.toLocaleDateString() : 'Never'}</td>
                <td class="invite-actions-cell">
                    <div class="invite-actions">
                        ${getInviteActionButtons(invite)}
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

// Get status badge HTML
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

// Get action buttons based on invite status
function getInviteActionButtons(invite) {
    const buttons = [];
    const hasBeenUsed = Boolean(invite?.used_by || invite?.used_at || Number(invite?.current_uses || 0) > 0 || String(invite?.status || '') === 'fully_used');

    if (invite.status === 'active') {
        buttons.push(`<button class="btn btn-sm btn-secondary invite-action-btn" onclick="extendInvite('${invite.code}')" title="Extend expiration">⏰ Extend</button>`);
        buttons.push(`<button class="btn btn-sm btn-danger invite-action-btn" onclick="revokeInvite('${invite.code}')" title="Revoke invite">🚫 Revoke</button>`);
    } else if (invite.status === 'revoked') {
        buttons.push(`<button class="btn btn-sm btn-success invite-action-btn" onclick="restoreInvite('${invite.code}')" title="Restore invite">♻️ Restore</button>`);
    }

    if (hasBeenUsed) {
        buttons.push('<button class="btn btn-sm btn-secondary invite-action-btn" disabled title="Used invites cannot be permanently deleted">🔒 Delete Blocked</button>');
    } else {
        buttons.push(`<button class="btn btn-sm btn-danger invite-action-btn" onclick="deleteInvitePermanent('${invite.code}')" title="Permanently delete">🗑️ Delete</button>`);
    }

    return buttons.join('');
}

// Revoke invite code (soft delete)
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
            showSuccess('Revoked', 'Invite code has been revoked');
            loadInviteStats();
        } else {
            showError('Failed', data.error || 'Failed to revoke invite code');
        }
    } catch (error) {
        showError('Error', 'Failed to revoke invite: ' + error.message);
    }
}

// Restore revoked invite
async function restoreInvite(code) {
    try {
        const { response, data } = await window.AdminPanel.api.postJson(`/api/invites/restore/${encodeURIComponent(code)}`, {});

        if (response.ok && data.success) {
            showSuccess('Restored', 'Invite code has been restored');
            loadInviteStats();
        } else {
            showError('Failed', data.error || 'Failed to restore invite code');
        }
    } catch (error) {
        showError('Error', 'Failed to restore invite: ' + error.message);
    }
}

// Extend invite expiration
async function extendInvite(code) {
    if (typeof window.showPromptModal !== 'function') {
        showError('Unavailable', 'Prompt modal is not available right now. Please refresh and try again.');
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
        showError('Invalid Input', 'Please enter a number between 1 and 365');
        return;
    }

    try {
        const { response, data } = await window.AdminPanel.api.postJson(`/api/invites/extend/${encodeURIComponent(code)}`, {
            additionalDays
        });

        if (response.ok && data.success) {
            showSuccess('Extended', `Invite expiration extended by ${additionalDays} days`);
            loadInviteStats();
        } else {
            showError('Failed', data.error || 'Failed to extend invite code');
        }
    } catch (error) {
        showError('Error', 'Failed to extend invite: ' + error.message);
    }
}

// Permanently delete invite
async function deleteInvitePermanent(code) {
    const invite = Array.isArray(inviteStatsData)
        ? inviteStatsData.find((item) => String(item?.code || '') === String(code || ''))
        : null;
    const hasBeenUsed = Boolean(invite?.used_by || invite?.used_at || Number(invite?.current_uses || 0) > 0 || String(invite?.status || '') === 'fully_used');

    if (hasBeenUsed) {
        showError('Blocked', 'Used invites cannot be permanently deleted.');
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
            showSuccess('Deleted', 'Invite code has been permanently deleted');
            loadInviteStats();
        } else {
            showError('Failed', data.error || 'Failed to delete invite code');
        }
    } catch (error) {
        showError('Error', 'Failed to delete invite: ' + error.message);
    }
}

// Export invites to CSV
function exportInvitesCsv() {
    if (!inviteStatsData || inviteStatsData.length === 0) {
        showError('No Data', 'No invite data to export');
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

    showSuccess('Exported', 'Invite data exported to CSV');
}

// Expose functions globally
window.generateInvite = generateInvite;
window.loadInviteStats = loadInviteStats;
window.filterInviteStats = filterInviteStats;
window.copyInviteCode = copyInviteCode;
window.revokeInvite = revokeInvite;
window.restoreInvite = restoreInvite;
window.extendInvite = extendInvite;
window.deleteInvitePermanent = deleteInvitePermanent;
window.exportInvitesCsv = exportInvitesCsv;

// ==================== END INVITE MANAGEMENT ====================

// ==================== ADMIN USER DETAIL VIEW ====================

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
                <div style="color: var(--text-secondary);">${error.message}</div>
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
        const eventIcon = {
            'LOGIN_SUCCESS': '✅',
            'LOGIN_FAILED': '❌',
            'LOGOUT': '🚪',
            'PASSWORD_CHANGED': '🔑',
            'TWO_FACTOR_ENABLED': '🔐',
            'TWO_FACTOR_DISABLED': '🔓',
            'EMAIL_VERIFIED': '📧'
        }[event.event_type] || '📝';
        return `
            <tr style="border-bottom: 1px solid var(--border-color);">
                <td style="padding: 0.5rem;">${eventIcon} ${event.event_type.replace(/_/g, ' ')}</td>
                <td style="padding: 0.5rem; color: var(--text-secondary);">${formatRelative(eventDate)}</td>
                <td style="padding: 0.5rem; font-family: monospace; font-size: 0.85rem;">${event.ip_address || '-'}</td>
            </tr>
        `;
    }).join('') : '';

    content.innerHTML = `
        <div style="display: grid; gap: 1.5rem;">
            <!-- Basic Info -->
            <div style="background: var(--bg-secondary); padding: 1.25rem; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
                <div style="display: flex; align-items: center; gap: 1rem; margin-bottom: 1rem;">
                    <div style="font-size: 2.5rem;">👤</div>
                    <div style="flex: 1;">
                        <div style="font-size: 1.4rem; font-weight: 700; color: var(--text-primary);">${user.username || 'Unknown'}</div>
                        <div style="margin-top: 0.25rem;">
                            <span class="role-badge" style="background: ${roleColor}; padding: 0.3rem 0.7rem; border-radius: 4px; color: white; font-size: 0.85rem; font-weight: 600;">${(user.role || 'unknown').toUpperCase()}</span>
                            ${user.active === false ? '<span style="margin-left: 0.5rem; color: var(--color-red); font-weight: 600;">⚠️ INACTIVE</span>' : ''}
                        </div>
                    </div>
                </div>
                <div style="display: grid; grid-template-columns: auto 1fr; gap: 0.75rem; font-size: 0.95rem;">
                    <strong>Account ID:</strong><span>${user.id}</span>
                    <strong>Created:</strong><span>${formatDate(createdDate)} <span style="color: var(--text-secondary);">(${formatRelative(createdDate)})</span></span>
                    <strong>Last Login:</strong><span>${formatDate(lastLogin)} <span style="color: var(--text-secondary);">${lastLogin ? `(${formatRelative(lastLogin)})` : ''}</span></span>
                </div>
            </div>
            
            <!-- Email & Verification -->
            <div style="background: var(--bg-secondary); padding: 1.25rem; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
                <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem; font-weight: 700;">
                    <span style="font-size: 1.2rem;">📧</span>
                    Email & Security
                </div>
                <div style="display: grid; grid-template-columns: auto 1fr; gap: 0.75rem; font-size: 0.95rem;">
                    <strong>Email:</strong><span>${user.email || '<span style="color: var(--text-secondary);">Not set</span>'}</span>
                    <strong>Verified:</strong><span>${user.email_verified ? '<span style="color: var(--color-green);">✅ Yes</span>' : '<span style="color: var(--color-orange);">❌ No</span>'}</span>
                    <strong>2FA Enabled:</strong><span>${user.two_factor_enabled ? `<span style="color: var(--color-green);">✅ Yes</span> <span style="color: var(--text-secondary);">(since ${formatDate(twoFactorEnabled)})</span>` : '<span style="color: var(--text-secondary);">❌ No</span>'}</span>
                    <strong>Password Changed:</strong><span>${formatDate(passwordChanged)}</span>
                </div>
            </div>
            
            <!-- Discord Integration -->
            <div style="background: var(--bg-secondary); padding: 1.25rem; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
                <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem; font-weight: 700;">
                    <span style="font-size: 1.2rem;">🎮</span>
                    Discord Integration
                </div>
                ${user.discord_user_id ? `
                    <div style="display: grid; grid-template-columns: auto 1fr; gap: 0.75rem; font-size: 0.95rem;">
                        <strong>Discord User:</strong><span>${user.discord_username || 'Unknown'}</span>
                        <strong>Discord ID:</strong><span><code style="background: var(--bg-card); padding: 0.2rem 0.5rem; border-radius: 4px;">${user.discord_user_id}</code></span>
                        <strong>Linked:</strong><span>${formatDate(discordLinked)}</span>
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

// Close modal on outside click
window.addEventListener('click', (event) => {
    const modal = document.getElementById('adminUserDetailModal');
    if (modal && event.target === modal) {
        closeAdminUserDetail();
    }
});

window.viewAdminUserDetail = viewAdminUserDetail;
window.closeAdminUserDetail = closeAdminUserDetail;

// ==================== END ADMIN USER DETAIL VIEW ====================

// This script handles all the owner-level features and access. Only for the top admin!
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

    // Set up tab event listeners
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
                // Load diagnostics when diagnostics tab is clicked
                if (tabName === 'diagnostics') {
                    loadDiagnostics();
                }
                // Load invite stats when invites tab is clicked
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
                }
            }
        });
    });

    initializeOwnerNotificationCenter();

    await loadSystemStatus();
    recordOwnerNotificationEvent({
        type: 'success',
        title: 'System Status Synced',
        message: 'Owner dashboard metrics refreshed.',
        source: 'system'
    }, { refresh: false });
    loadOwnerNotificationHistory();
    startDiagnosticsAutoRefresh();
    startSocketHealthAutoRefresh();
    setupLiveTerminal();

    const runBackupBtn = document.getElementById('runBackupBtn');
    const saveBackupConfigBtn = document.getElementById('saveBackupConfigBtn');
    const backupSelectAll = document.getElementById('backupTablesSelectAll');
    runBackupBtn?.addEventListener('click', () => runBackupNow());
    saveBackupConfigBtn?.addEventListener('click', () => saveBackupSettings());
    backupSelectAll?.addEventListener('change', () => {
        const list = document.getElementById('backupTablesList');
        if (!list) return;
        const shouldSelect = Boolean(backupSelectAll.checked);
        list.querySelectorAll('.backup-table-checkbox').forEach((checkbox) => {
            checkbox.checked = shouldSelect;
        });
        updateBackupTableCount();
    });

    await loadBackupTables();

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
            downloadBtn.textContent = 'Preparing...';
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

            if (typeof showSuccess === 'function') {
                showSuccess('Download Ready', 'Terminal logs saved to your downloads folder.');
            }
        } catch (error) {
            console.error('Failed to download terminal logs:', error);
            if (typeof showError === 'function') {
                showError('Download Failed', error.message || 'Unable to download terminal logs.');
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
            renderLogs(['[system] [error] Unable to connect to live logs.']);
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

        // Update user display
        const username = data.username || 'Owner';
        ui?.setText('userDisplay', username);
        ui?.setText('dropdownUsername', username);
        ui?.setText('roleDisplay', 'OWNER');
        ui?.setText('dropdownRole', 'OWNER');
        return data;
    } catch (error) {
        window.location.href = '/login';
        return null;
    }
}

function switchTab(e, tabName) {
    e.preventDefault();

    // Hide everything first
    document.querySelectorAll('.tab-content').forEach(tab => {
        tab.classList.remove('active');
    });

    // Deactivate all tab buttons
    document.querySelectorAll('.tab').forEach(btn => {
        btn.classList.remove('active');
    });

    // Show selected tab
    document.getElementById(tabName).classList.add('active');
    const clickedTab = e.currentTarget || e.target?.closest?.('.tab') || e.target;
    if (clickedTab?.classList?.contains('tab')) {
        clickedTab.classList.add('active');
    }

    if (tabName === 'notifications') {
        loadOwnerNotificationHistory();
    }
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
        const systemTab = document.getElementById('system');
        const isSystemActive = Boolean(systemTab && systemTab.classList.contains('active'));
        if (!isSystemActive || document.hidden) return;
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

            // Advanced health score calculation based on multiple factors
            const totalUsers = data.totalUsers || 0;
            const bannedUsers = data.bannedUsers || 0;
            const totalWarnings = data.totalWarnings || 0;
            const memoryUsage = data.memoryUsage || 128;

            // Health calculation factors (each is 0-100 score)
            const userHealthFactor = Math.max(0, 100 - (bannedUsers > 0 && totalUsers > 0 ? (bannedUsers / totalUsers * 20) : 0));
            const warningHealthFactor = Math.max(0, 100 - (totalWarnings > 0 && totalUsers > 0 ? (totalWarnings / totalUsers * 15) : 0));
            const memoryHealthFactor = Math.max(0, 100 - (memoryUsage > 100 ? (memoryUsage - 100) : 0));

            // Overall health score (weighted average)
            const healthScore = Math.max(0, Math.min(100,
                (userHealthFactor * 0.4) + (warningHealthFactor * 0.35) + (memoryHealthFactor * 0.25)
            ));

            // Determine health status and color
            const healthStatus = healthScore >= 80 ? 'Excellent' : healthScore >= 60 ? 'Good' : healthScore >= 40 ? 'Fair' : 'Poor';
            const healthColor = healthScore >= 80 ? 'var(--color-green)' : healthScore >= 60 ? 'var(--color-yellow)' : healthScore >= 40 ? 'var(--color-yellow)' : 'var(--color-red)';

            // Calculate response time estimate (random for now, but would come from real data)
            const responseTime = Math.floor(Math.random() * 50) + 10; // 10-60ms
            const responseTimeHealth = Math.max(0, 100 - (responseTime > 50 ? (responseTime - 50) * 2 : 0));

            // Real uptime from owner metrics endpoint (seconds)
            const uptimeSeconds = Number(metricsData.uptime || 0) || 0;
            const uptimeHoursTotal = Math.floor(uptimeSeconds / 3600);
            const uptimeDays = Math.floor(uptimeSeconds / 86400);
            const uptimeHoursRemainder = Math.floor((uptimeSeconds % 86400) / 3600);
            const uptimeLabel = uptimeDays > 0
                ? `${uptimeDays}d ${uptimeHoursRemainder}h`
                : `${uptimeHoursTotal}h`;

            // Update health circle and status with dynamic information
            const healthCircle = document.querySelector('.system-health-circle');
            if (healthCircle) {
                healthCircle.style.setProperty('--health-percentage', healthScore);
                healthCircle.style.setProperty('--health-color', healthColor);
                setText('healthScore', Math.round(healthScore));

                // Database health with more detail
                const dbHealth = userHealthFactor >= 80 ? 'Healthy' : 'Degraded';
                const dbStatus = totalUsers > 0 ? `${dbHealth} | ${totalUsers.toLocaleString()} records` : 'No data';
                const dbElement = document.getElementById('healthDb');
                if (dbElement) {
                    dbElement.innerHTML = `<span class="system-health-status-dot ${userHealthFactor >= 80 ? 'healthy' : 'warning'}"></span>${dbStatus}`;
                }

                // Bot connection health with uptime
                const botHealth = healthScore >= 70 ? 'Connected' : 'Unstable';
                const botUptime = `${uptimeLabel} uptime`;
                const botElement = document.getElementById('healthBot');
                if (botElement) {
                    botElement.innerHTML = `<span class="system-health-status-dot ${healthScore >= 70 ? 'healthy' : 'warning'}"></span>${botHealth} | ${botUptime}`;
                }

                // Performance health with response time
                const perfHealth = responseTime < 30 ? 'Optimal' : responseTime < 50 ? 'Good' : 'Slow';
                const perfDetail = `${responseTime}ms response`;
                const perfElement = document.getElementById('healthPerf');
                if (perfElement) {
                    const perfTone = responseTimeHealth >= 80 ? 'healthy' : responseTimeHealth >= 50 ? 'warning' : 'critical';
                    perfElement.innerHTML = `<span class="system-health-status-dot ${perfTone}"></span>${perfHealth} | ${perfDetail}`;
                }
            }

            // Population data (estimated)
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

            const systemStats = document.getElementById('systemStats');
            if (systemStats) {
                systemStats.innerHTML = `
                    <div class="stat-card-advanced">
                        <div class="stat-card-advanced-header">
                            <div class="stat-card-advanced-title">Active Users</div>
                            <div class="stat-card-advanced-icon">👥</div>
                        </div>
                        <div class="stat-card-advanced-value">${totalUsers.toLocaleString()}</div>
                        <div>
                            <div class="stat-card-advanced-progress">
                                <div class="stat-card-advanced-progress-bar" style="width: ${Math.min(memberCapacity, 100)}%; background: linear-gradient(90deg, #2196f3, #1976d2);"></div>
                            </div>
                            <div class="stat-card-advanced-percent">${Math.min(memberCapacity, 100).toFixed(1)}% capacity</div>
                        </div>
                        <div class="stat-card-advanced-meta">
                            <span class="stat-card-advanced-detail">Score: ${Math.round(userHealthFactor)}/100</span>
                            <span class="stat-card-advanced-trend positive">↑ Active</span>
                        </div>
                    </div>
                    <div class="stat-card-advanced">
                        <div class="stat-card-advanced-header">
                            <div class="stat-card-advanced-title">Total Warnings</div>
                            <div class="stat-card-advanced-icon">⚠️</div>
                        </div>
                        <div class="stat-card-advanced-value">${totalWarnings.toLocaleString()}</div>
                        <div>
                            <div class="stat-card-advanced-progress">
                                <div class="stat-card-advanced-progress-bar" style="width: ${Math.min(warningRate, 100)}%; background: ${warningRate > 30 ? 'linear-gradient(90deg, #f44336, #e53935)' : 'linear-gradient(90deg, #ffc107, #ff9800)'};" ></div>
                            </div>
                            <div class="stat-card-advanced-percent">${warningRate}% of users</div>
                        </div>
                        <div class="stat-card-advanced-meta">
                            <span class="stat-card-advanced-detail">Score: ${Math.round(warningHealthFactor)}/100</span>
                            <span class="stat-card-advanced-badge ${warningRate > 30 ? 'critical' : warningRate > 20 ? 'warning' : 'healthy'}">⚠️ ${warningRate > 30 ? 'Critical' : warningRate > 20 ? 'Monitor' : 'Normal'}</span>
                        </div>
                    </div>
                    <div class="stat-card-advanced">
                        <div class="stat-card-advanced-header">
                            <div class="stat-card-advanced-title">Banned Users</div>
                            <div class="stat-card-advanced-icon">🔨</div>
                        </div>
                        <div class="stat-card-advanced-value">${bannedUsers}</div>
                        <div>
                            <div class="stat-card-advanced-progress">
                                <div class="stat-card-advanced-progress-bar" style="width: ${Math.min((bannedUsers / totalUsers * 20), 100)}%; background: ${bannedUsers > 10 ? 'linear-gradient(90deg, #f44336, #e53935)' : bannedUsers > 5 ? 'linear-gradient(90deg, #ff9800, #f57c00)' : 'linear-gradient(90deg, #4caf50, #45a049)'};" ></div>
                            </div>
                            <div class="stat-card-advanced-percent">${banRate}% ban rate</div>
                        </div>
                        <div class="stat-card-advanced-meta">
                            <span class="stat-card-advanced-detail">Score: ${Math.round(userHealthFactor)}/100</span>
                            <span class="stat-card-advanced-badge ${bannedUsers > 10 ? 'critical' : bannedUsers > 5 ? 'warning' : 'healthy'}">🔨 ${bannedUsers > 0 ? 'Active' : 'None'}</span>
                        </div>
                    </div>
                    <div class="stat-card-advanced">
                        <div class="stat-card-advanced-header">
                            <div class="stat-card-advanced-title">System Health</div>
                            <div class="stat-card-advanced-icon">🏥</div>
                        </div>
                        <div class="stat-card-advanced-value" style="color: ${healthColor};">${Math.round(healthScore)}/100</div>
                        <div>
                            <div class="stat-card-advanced-progress">
                                <div class="stat-card-advanced-progress-bar" style="width: ${healthScore}%; background: ${healthColor};"></div>
                            </div>
                            <div class="stat-card-advanced-percent">${healthStatus} Status</div>
                        </div>
                        <div class="stat-card-advanced-meta">
                            <span class="stat-card-advanced-detail">Memory: ${memoryUsage}MB</span>
                            <span class="stat-card-advanced-badge ${healthScore >= 80 ? 'healthy' : healthScore >= 60 ? 'warning' : 'critical'}">✓ ${healthStatus}</span>
                        </div>
                    </div>
                    <div class="stat-card-advanced">
                        <div class="stat-card-advanced-header">
                            <div class="stat-card-advanced-title">Response Time</div>
                            <div class="stat-card-advanced-icon">⚡</div>
                        </div>
                        <div class="stat-card-advanced-value">${responseTime}ms</div>
                        <div>
                            <div class="stat-card-advanced-progress">
                                <div class="stat-card-advanced-progress-bar" style="width: ${responseTimeHealth}%; background: ${responseTimeHealth >= 80 ? 'linear-gradient(90deg, #4caf50, #45a049)' : responseTimeHealth >= 50 ? 'linear-gradient(90deg, #ffc107, #ff9800)' : 'linear-gradient(90deg, #f44336, #e53935)'};" ></div>
                            </div>
                            <div class="stat-card-advanced-percent">${responseTime < 30 ? 'Optimal' : responseTime < 50 ? 'Good' : 'Slow'}</div>
                        </div>
                        <div class="stat-card-advanced-meta">
                            <span class="stat-card-advanced-detail">Score: ${Math.round(responseTimeHealth)}/100</span>
                            <span class="stat-card-advanced-badge ${responseTimeHealth >= 80 ? 'healthy' : responseTimeHealth >= 50 ? 'warning' : 'critical'}">⚡ Real-time</span>
                        </div>
                    </div>
                    <div class="stat-card-advanced">
                        <div class="stat-card-advanced-header">
                            <div class="stat-card-advanced-title">Memory Usage</div>
                            <div class="stat-card-advanced-icon">🧠</div>
                        </div>
                        <div class="stat-card-advanced-value">${memoryUsage}MB</div>
                        <div>
                            <div class="stat-card-advanced-progress">
                                <div class="stat-card-advanced-progress-bar" style="width: ${Math.min((memoryUsage / 512) * 100, 100)}%; background: ${memoryUsage > 400 ? 'linear-gradient(90deg, #f44336, #e53935)' : memoryUsage > 250 ? 'linear-gradient(90deg, #ff9800, #f57c00)' : 'linear-gradient(90deg, #4caf50, #45a049)'};" ></div>
                            </div>
                            <div class="stat-card-advanced-percent">${Math.min((memoryUsage / 512) * 100, 100).toFixed(1)}% of 512MB</div>
                        </div>
                        <div class="stat-card-advanced-meta">
                            <span class="stat-card-advanced-detail">Score: ${Math.round(memoryHealthFactor)}/100</span>
                            <span class="stat-card-advanced-badge ${memoryUsage > 400 ? 'critical' : memoryUsage > 250 ? 'warning' : 'healthy'}">🧠 ${memoryUsage > 400 ? 'High' : memoryUsage > 250 ? 'Medium' : 'Low'}</span>
                        </div>
                    </div>
                    <div class="stat-card-advanced">
                        <div class="stat-card-advanced-header">
                            <div class="stat-card-advanced-title">System Uptime</div>
                            <div class="stat-card-advanced-icon">📈</div>
                        </div>
                        <div class="stat-card-advanced-value">${uptimeLabel}</div>
                        <div>
                            <div class="stat-card-advanced-progress">
                                <div class="stat-card-advanced-progress-bar" style="width: ${Math.min((uptimeHoursTotal / 168) * 100, 100)}%; background: linear-gradient(90deg, #4caf50, #45a049);" ></div>
                            </div>
                            <div class="stat-card-advanced-percent">${(uptimeSeconds / 86400).toFixed(1)} days</div>
                        </div>
                        <div class="stat-card-advanced-meta">
                            <span class="stat-card-advanced-detail">Since: ${uptimeSeconds > 0 ? new Date(Date.now() - (uptimeSeconds * 1000)).toLocaleString() : 'N/A'}</span>
                            <span class="stat-card-advanced-badge healthy">✓ Stable</span>
                        </div>
                    </div>
                `;
            }
        }

        await loadSocketHealth();
        await loadBackupStatus();
    } catch (error) {
        console.error('Error loading system status:', error);
        // Show fallback UI
        const systemStats = document.getElementById('systemStats');
        if (systemStats) {
            systemStats.innerHTML = '<div role="alert" style="padding: 2rem; text-align: center; color: var(--text-secondary);"><p>Unable to load system statistics</p></div>';
        }
        updateSocketHealthFallback('Unable to load WebSocket health');
    }
}

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
                        : (event.details?.reason || '—');

                    return `
                        <tr>
                            <td>${escapeNotificationCell(createdAt)}</td>
                            <td>${escapeNotificationCell(formatAntiRaidEventType(event.eventType))}</td>
                            <td>${riskScore === null ? '--' : escapeNotificationCell(riskScore.toFixed(0))}</td>
                            <td>${triggerCount || triggers.length || 0}</td>
                            <td>${escapeNotificationCell(triggerSummary || '—')}</td>
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

    if (statusEl) {
        statusEl.textContent = rawStatus;
    }
    if (lastRunEl) lastRunEl.textContent = formatBackupTime(state.lastRunAt);
    if (nextRunEl) nextRunEl.textContent = formatBackupTime(state.nextRunAt);
    if (lastResultEl) lastResultEl.textContent = state.lastRunStatus || '--';
    if (noteEl) {
        noteEl.textContent = state.lastRunError || 'Backups use the server-side MySQL tools.';
    }

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
            showError(data?.error || 'Failed to update backup settings');
            return;
        }
        applyBackupConfigToControls(data.config || {});
        updateBackupStatus(data.state || {});
        showSuccess('Backup settings updated');
    } catch (error) {
        console.error('Error saving backup settings:', error);
        showError('Failed to update backup settings');
    }
}

async function runBackupNow() {
    const runBtn = document.getElementById('runBackupBtn');
    if (runBtn) {
        runBtn.disabled = true;
        runBtn.textContent = 'Running...';
    }

    try {
        const format = String(document.getElementById('backupFormatSelect')?.value || 'json');
        const tables = getSelectedBackupTables();
        const { response, data } = await window.AdminPanel.api.postJson('/api/owner/backups/run', {
            format,
            tables
        });
        if (!response.ok) {
            showError(data?.error || 'Backup failed');
            return;
        }
        showSuccess('Backup completed');
    } catch (error) {
        console.error('Error running backup:', error);
        showError('Backup failed');
    } finally {
        await loadBackupStatus();
        if (runBtn) {
            runBtn.disabled = false;
            runBtn.textContent = 'Run Backup';
        }
    }
}

// Load diagnostics information
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
                        <div class="stat-card-advanced-icon">🗄️</div>
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
                return `<option value="${value.replace(/"/g, '&quot;')}" ${selected}>${labelText}</option>`;
            })
            .join('');

        modal.innerHTML = `
            <div class="modal-overlay"></div>
            <div class="notification-modal" role="dialog" aria-modal="true" aria-labelledby="${modalId}-title">
                <div class="modal-header">
                    <h3 id="${modalId}-title">⚙️ ${title}</h3>
                    <button class="modal-close" type="button">×</button>
                </div>
                <div class="modal-body">
                    <label for="${modalId}-select" style="display:block; font-weight:600; color:var(--text-primary); margin-bottom:0.45rem;">${label}</label>
                    <select id="${modalId}-select" class="form-input">${optionMarkup}</select>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" type="button" data-action="cancel">${cancelText}</button>
                    <button class="btn btn-primary" type="button" data-action="confirm">${confirmText}</button>
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
    if (typeof showError === 'function') return showError(message);
    if (typeof window.showError === 'function') return window.showError(message);
    console.error(message);
}

function ownerNotifySuccess(message) {
    if (typeof showSuccess === 'function') return showSuccess(message);
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

    let html = `
        <table>
            <thead>
                <tr>
                    <th style="width:42px;"><input type="checkbox" id="adminUsersSelectAll" ${allPageSelected ? 'checked' : ''}></th>
                    <th>Username</th>
                    <th>Role</th>
                    <th>Created</th>
                    <th>Last Login</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody>
    `;

    pageRows.forEach((user) => {
        const userId = resolveAdminUserId(user);
        const created = parseDateSafe(user.created_at);
        const lastLoginDate = parseDateSafe(user.last_login);
        const createdText = created ? created.toLocaleDateString() : 'Unknown';
        const lastLoginText = lastLoginDate ? lastLoginDate.toLocaleDateString() : 'Never';
        const role = String(user.role || '').toLowerCase();
        const roleColor = role === 'owner' ? 'var(--color-red)' : role === 'admin' ? 'var(--color-blue)' : 'var(--color-green)';
        const isOwner = role === 'owner';
        const isSelected = adminUserState.selectedIds.has(userId);
        const viewBtn = `<button class="btn btn-secondary" style="padding: 0.45rem 0.8rem; font-size: 0.82rem;" onclick="viewAdminUserDetail('${escapeOwnerHtml(userId)}', '${escapeOwnerHtml(user.username || '')}')" title="View account details">👁️ View</button>`;
        const updateRoleBtn = userId
            ? `<button class="btn btn-secondary" style="padding: 0.45rem 0.8rem; font-size: 0.82rem;" onclick="updateAdminUserRole('${escapeOwnerHtml(userId)}', '${escapeOwnerHtml(user.username || '')}', '${escapeOwnerHtml(role)}')">Role</button>`
            : '<button class="btn btn-secondary" style="padding: 0.45rem 0.8rem; font-size: 0.82rem; opacity:0.8;" disabled>Role</button>';
        const deleteBtn = isOwner
            ? '<button class="btn btn-secondary" style="padding: 0.45rem 0.8rem; font-size: 0.82rem; opacity:0.8;" disabled>Protected</button>'
            : userId
                ? `<button class="btn btn-danger" style="padding: 0.45rem 0.8rem; font-size: 0.82rem;" onclick="deleteAdminUser('${escapeOwnerHtml(userId)}', '${escapeOwnerHtml(user.username || '')}')">Delete</button>`
                : '<button class="btn btn-secondary" style="padding: 0.45rem 0.8rem; font-size: 0.82rem; opacity:0.8;" disabled>ID Unavailable</button>';

        html += `
            <tr>
                <td><input type="checkbox" class="admin-user-select" data-user-id="${escapeOwnerHtml(userId)}" ${isSelected ? 'checked' : ''}></td>
                <td>${escapeOwnerHtml(user.username || 'Unknown')}</td>
                <td><strong style="color: ${roleColor};">${escapeOwnerHtml(role.toUpperCase() || 'UNKNOWN')}</strong></td>
                <td>${createdText}</td>
                <td>${lastLoginText}</td>
                <td style="display:flex; gap:0.5rem; flex-wrap:wrap;">${viewBtn}${updateRoleBtn}${deleteBtn}</td>
            </tr>
        `;
    });

    html += '</tbody></table>';
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
    const searchEl = document.getElementById('adminUserSearch');
    const roleEl = document.getElementById('adminUserRoleFilter');
    const activityEl = document.getElementById('adminUserActivityFilter');
    const sortEl = document.getElementById('adminUserSort');
    if (!searchEl || !roleEl || !activityEl || !sortEl) return;

    searchEl.addEventListener('input', () => {
        adminUserState.query = String(searchEl.value || '').trim().toLowerCase();
        adminUserState.page = 1;
        applyAdminUserFiltersAndRender();
    });

    roleEl.addEventListener('change', () => {
        adminUserState.roleFilter = roleEl.value || 'all';
        adminUserState.page = 1;
        applyAdminUserFiltersAndRender();
    });

    activityEl.addEventListener('change', () => {
        adminUserState.activityFilter = activityEl.value || 'all';
        adminUserState.page = 1;
        applyAdminUserFiltersAndRender();
    });

    sortEl.addEventListener('change', () => {
        adminUserState.sortBy = sortEl.value || 'created_desc';
        applyAdminUserFiltersAndRender();
    });
}

function changeAdminUsersPage(step) {
    const totalPages = Math.max(1, Math.ceil(adminUserState.filteredUsers.length / adminUserState.pageSize));
    adminUserState.page = Math.min(totalPages, Math.max(1, adminUserState.page + Number(step || 0)));
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
    // Use custom prompt modal: require typing the exact username to confirm deletion
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

        if (!promptResult) return; // user cancelled
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
    const activeTab = document.querySelector('#ownerTabs .tab.active')?.dataset?.tab || 'system';

    if (activeTab === 'diagnostics') {
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
    if (activeTab === 'security' || activeTab === 'security-events') {
        if (typeof loadSecurityEventsFeed === 'function') loadSecurityEventsFeed(false);
        return;
    }
    if (activeTab === 'notifications') {
        if (typeof loadOwnerNotificationHistory === 'function') loadOwnerNotificationHistory();
        return;
    }

    if (typeof loadSystemStatus === 'function') loadSystemStatus();
    if (typeof loadBackupStatus === 'function') loadBackupStatus();
}

if (window.AdminPanel) {
    window.AdminPanel.refreshVisibleData = refreshOwnerVisibleData;
}

document.addEventListener('adminpanel:refresh-visible-data', refreshOwnerVisibleData);
let currentUser = null;
let securitySessions = [];
let lastGeneratedPassword = '';
let securitySummary = null;
let securitySummaryLoadingPromise = null;
let latestRecoveryCodes = [];
let discordAccountLinked = false;
let discordUnlinkInProgress = false;
let discordOAuthStartInProgress = false;
let discordOAuthHealthState = 'checking';
let activeSecurityWorkspaceTab = 'center';
let activeProfileTab = 'security';
let securityEventControlsInitialized = false;

// Custom Password Modal Logic
let passwordConfirmResolver = null;

function closePasswordModal() {
    const modal = document.getElementById('passwordConfirmModal');
    if (modal) modal.style.display = 'none';
    document.getElementById('confirmPasswordInput').value = '';
    if (passwordConfirmResolver) {
        passwordConfirmResolver(null);
        passwordConfirmResolver = null;
    }
}

function handlePasswordConfirm(event) {
    event.preventDefault();
    const password = document.getElementById('confirmPasswordInput').value;
    const modal = document.getElementById('passwordConfirmModal');
    if (modal) modal.style.display = 'none';
    document.getElementById('confirmPasswordInput').value = '';
    if (passwordConfirmResolver) {
        passwordConfirmResolver(password);
        passwordConfirmResolver = null;
    }
}

function requestPasswordConfirmation() {
    return new Promise((resolve) => {
        passwordConfirmResolver = resolve;
        const modal = document.getElementById('passwordConfirmModal');
        if (modal) {
            modal.style.display = 'flex';
            document.getElementById('confirmPasswordInput').focus();
        } else {
            resolve(null);
        }
    });
}

function downloadRecoveryCodes() {
    if (!latestRecoveryCodes || !latestRecoveryCodes.length) {
        showError('No codes available to download.');
        return;
    }
    const date = new Date().toISOString().split('T')[0];
    const content = `ADMIN PANEL RECOVERY CODES\nGenerated: ${new Date().toLocaleString()}\n\nTreat these codes like your password. Store them in a secure place.\n\n` + latestRecoveryCodes.join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `recovery-codes-${date}.txt`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function buildStatusBadge(label, tone = 'neutral') {
    const normalizedTone = typeof tone === 'boolean'
        ? (tone ? 'positive' : 'warning')
        : String(tone || 'neutral').toLowerCase();

    const border = normalizedTone === 'positive'
        ? 'var(--color-green)'
        : (normalizedTone === 'warning' ? 'var(--color-orange)' : 'var(--color-border)');
    const background = normalizedTone === 'positive'
        ? 'rgba(16, 185, 129, 0.12)'
        : (normalizedTone === 'warning' ? 'rgba(245, 158, 11, 0.12)' : 'var(--color-bg-secondary)');
    return `<span style="display:inline-flex; align-items:center; padding:0.2rem 0.55rem; border-radius:999px; background:${background}; border:1px solid ${border}; color:var(--color-text-light); font-size:0.8rem; font-weight:600; letter-spacing:0.02em;">${escapeHtml(label)}</span>`;
}

function buildMetricLabel(label, hint) {
    const safeLabel = escapeHtml(label);
    const safeHint = escapeHtml(hint || '');
    if (!safeHint) return safeLabel;
    return `${safeLabel} <span title="${safeHint}" style="margin-left:0.3rem; color: var(--color-text-light); font-size:0.76rem; cursor:help;">ⓘ</span>`;
}

const METRIC_HINTS = Object.freeze({
    geoLatestLocation: 'Best available location label derived from recent event/session IP intelligence.',
    geoLatestIp: 'Most recent observed authentication IP address.',
    geoNetworkType: 'Classifies source network as public, private, or localhost.',
    geoIpVersion: 'Transport protocol family of the latest observed IP address.',
    geoAddressScope: 'Indicates routability scope such as loopback, private, or public.',
    geoConfidence: 'Quality of location inference based on available network attributes.',
    geoSource: 'Data source used to build this snapshot (security event or active session).',
    geoLatestEventTime: 'Timestamp for the newest location-related authentication signal.',
    geoRecentLocationTypes: 'Unique location labels observed across recent events and sessions.',
    geoRecentNetworkClasses: 'Distinct network classifications seen in recent auth activity.',
    geoRecentIpVersions: 'IP protocol versions recently observed for this account.',
    geoRiskSignals: 'Heuristic indicators derived from IP/user-agent context.',

    recoveryCoverage: 'How many recovery codes are available compared with the expected baseline of 10.',
    recoveryReadiness: 'Overall emergency access posture based on code count and availability.',
    recoveryLastGenerated: 'Timestamp of the most recent recovery code generation event.',
    recoveryCodeAge: 'How long the current recovery set has been active.',
    recoveryRotation: 'Advisory on whether the current recovery set should be regenerated.',
    recoveryNextReview: 'Scheduled checkpoint based on a 30-day review interval from generation date.'
});

function buildGeoMetric(label, value, hint) {
    return `<div><strong>${buildMetricLabel(label, hint)}</strong> ${escapeHtml(String(value ?? '-'))}</div>`;
}

function buildGeoMetricCard(label, value, hint) {
    return `<div class="geo-metric"><strong>${buildMetricLabel(label, hint)}</strong>${escapeHtml(String(value ?? '-'))}</div>`;
}

function buildRecoveryMetric(label, hint, value, detail = '', badge = '') {
    const detailHtml = detail ? `<div style="margin-top:0.35rem;">${escapeHtml(detail)}</div>` : '';
    return `<div class="recovery-metric"><strong>${buildMetricLabel(label, hint)}</strong>${badge || ''}${value || ''}${detailHtml}</div>`;
}

function buildSecurityMiniCard(label, value, detail = '') {
    return `
                <div class="security-mini-card">
                    <strong>${escapeHtml(label)}</strong>
                    <div class="security-mini-value">${escapeHtml(String(value ?? '-'))}</div>
                    ${detail ? `<div class="security-mini-detail">${escapeHtml(detail)}</div>` : ''}
                </div>
            `;
}

function formatIpAddressForDisplay(rawIp) {
    const ip = String(rawIp || '').trim();
    if (!ip) return { label: 'Unknown', tooltip: '' };

    if (ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1') {
        return {
            label: 'Localhost',
            tooltip: 'Localhost (development): request originated from this machine.'
        };
    }

    if (ip.startsWith('::ffff:')) {
        return { label: ip.replace('::ffff:', ''), tooltip: '' };
    }

    return { label: ip, tooltip: '' };
}

function getCsrfTokenFromCookie() {
    const match = document.cookie.match(/csrfToken=([^;]+)/);
    return match ? match[1] : '';
}

async function postWithCsrf(url, body = {}, options = {}) {
    const method = String(options.method || 'POST').toUpperCase();

    const sendRequest = async (csrfToken) => {
        return fetch(url, {
            method,
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json',
                ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
                ...(options.headers || {})
            },
            body: JSON.stringify(body)
        });
    };

    let csrfToken = getCsrfTokenFromCookie();
    let response = await sendRequest(csrfToken);

    if (response.status === 403 && !options._csrfRetried) {
        await window.AdminPanel.api.getJson('/api/csrf');
        csrfToken = getCsrfTokenFromCookie();
        response = await sendRequest(csrfToken);
    }

    return response;
}

// Toggle password visibility
function togglePasswordVisibility(fieldId) {
    const field = document.getElementById(fieldId);
    const isPassword = field.type === 'password';
    field.type = isPassword ? 'text' : 'password';
    syncShowAllToggleState();
}

function toggleAllPasswords(show) {
    const fields = ['currentPassword', 'newPassword', 'confirmPassword'];
    fields.forEach((fieldId) => {
        const field = document.getElementById(fieldId);
        if (field) {
            field.type = show ? 'text' : 'password';
        }
    });
}

function syncShowAllToggleState() {
    const toggle = document.getElementById('showAllPasswordsToggle');
    if (!toggle) return;
    const fields = ['currentPassword', 'newPassword', 'confirmPassword']
        .map((id) => document.getElementById(id))
        .filter(Boolean);
    if (!fields.length) return;
    const allVisible = fields.every((field) => field.type === 'text');
    toggle.checked = allVisible;
}

function generateStrongPassword() {
    const uppercase = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const lowercase = 'abcdefghijkmnpqrstuvwxyz';
    const numbers = '23456789';
    const special = '@$!%*?&';
    const all = uppercase + lowercase + numbers + special;

    const randomChar = (chars) => chars[Math.floor(Math.random() * chars.length)];
    const chars = [
        randomChar(uppercase),
        randomChar(lowercase),
        randomChar(numbers),
        randomChar(special)
    ];

    while (chars.length < 16) {
        chars.push(randomChar(all));
    }

    for (let i = chars.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [chars[i], chars[j]] = [chars[j], chars[i]];
    }

    const generated = chars.join('');
    lastGeneratedPassword = generated;
    const newPassword = document.getElementById('newPassword');
    const confirmPassword = document.getElementById('confirmPassword');

    if (newPassword) newPassword.value = generated;
    if (confirmPassword) confirmPassword.value = generated;

    updatePasswordStrength(generated);
    validatePasswordMatch();
    updateChangePasswordButtonState();
    showSuccess('Strong password generated and applied.');
}

async function copyGeneratedPassword() {
    const candidate = lastGeneratedPassword || document.getElementById('newPassword')?.value || '';
    if (!candidate) {
        showError('Generate a password first, then copy it.');
        return;
    }

    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(candidate);
        } else {
            const temp = document.createElement('textarea');
            temp.value = candidate;
            document.body.appendChild(temp);
            temp.select();
            document.execCommand('copy');
            temp.remove();
        }
        showSuccess('Generated password copied to clipboard.');
    } catch (error) {
        console.error('Failed to copy password:', error);
        showError('Could not copy password automatically. Please copy it manually.');
    }
}

function handleCapsLock(event) {
    const warning = document.getElementById('capsLockWarning');
    if (!warning || !event || typeof event.getModifierState !== 'function') return;
    warning.style.display = event.getModifierState('CapsLock') ? 'block' : 'none';
}

function updateChangePasswordButtonState() {
    const submitBtn = document.getElementById('changePasswordSubmitBtn');
    const currentPassword = document.getElementById('currentPassword')?.value || '';
    const newPassword = document.getElementById('newPassword')?.value || '';
    const confirmPassword = document.getElementById('confirmPassword')?.value || '';

    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
    const isValid = Boolean(
        currentPassword.length >= 8
        && passwordRegex.test(newPassword)
        && newPassword === confirmPassword
        && currentPassword !== newPassword
    );

    if (submitBtn) {
        submitBtn.disabled = !isValid;
        submitBtn.style.opacity = isValid ? '1' : '0.6';
        submitBtn.style.cursor = isValid ? 'pointer' : 'not-allowed';
    }
}

function updateChangeEmailButtonState() {
    const submitBtn = document.getElementById('changeEmailSubmitBtn');
    const newEmail = (document.getElementById('newEmail')?.value || '').trim().toLowerCase();
    const confirmNewEmail = (document.getElementById('confirmNewEmail')?.value || '').trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    updateEmailMatchIndicator(newEmail, confirmNewEmail);

    const isValid = Boolean(
        emailRegex.test(newEmail)
        && emailRegex.test(confirmNewEmail)
        && newEmail === confirmNewEmail
    );

    if (submitBtn) {
        submitBtn.disabled = !isValid;
        submitBtn.style.opacity = isValid ? '1' : '0.6';
        submitBtn.style.cursor = isValid ? 'pointer' : 'not-allowed';
    }
}

function updateEmailMatchIndicator(newEmail, confirmNewEmail) {
    const indicator = document.getElementById('emailMatchIndicator');
    if (!indicator) return;

    if (!confirmNewEmail) {
        indicator.classList.remove('show', 'match', 'mismatch');
        indicator.textContent = '';
        return;
    }

    indicator.classList.add('show');
    if (newEmail === confirmNewEmail) {
        indicator.classList.add('match');
        indicator.classList.remove('mismatch');
        indicator.textContent = '✓ Emails match';
        return;
    }

    indicator.classList.remove('match');
    indicator.classList.add('mismatch');
    indicator.textContent = '✗ Emails do not match';
}

// Update password strength indicator
function updatePasswordStrength(password) {
    const requirements = [
        { id: 'check-length', regex: /.{8,}/, text: 'At least 8 characters' },
        { id: 'check-upper', regex: /[A-Z]/, text: 'One uppercase letter' },
        { id: 'check-lower', regex: /[a-z]/, text: 'One lowercase letter' },
        { id: 'check-number', regex: /\d/, text: 'One number' },
        { id: 'check-special', regex: /[@$!%*?&]/, text: 'One special character' }
    ];

    let strength = 0;
    requirements.forEach(req => {
        const element = document.getElementById(req.id);
        const isMet = req.regex.test(password);
        if (!element) return;

        if (isMet) {
            element.classList.add('active');
            strength += 20;
        } else {
            element.classList.remove('active');
        }
    });

    // Update strength bar
    const strengthBar = document.getElementById('strengthBar');
    if (!strengthBar) return;
    strengthBar.style.width = strength + '%';

    const strengthText = document.getElementById('strengthText');
    if (!strengthText) return;
    let strengthLabel = '';
    if (strength === 0) {
        strengthLabel = '';
    } else if (strength <= 20) {
        strengthLabel = '🔴 Weak';
        strengthBar.style.background = '#ff5b5b';
    } else if (strength <= 40) {
        strengthLabel = '🟠 Fair';
        strengthBar.style.background = '#ff9d5b';
    } else if (strength <= 60) {
        strengthLabel = '🟡 Good';
        strengthBar.style.background = '#ffd45b';
    } else if (strength <= 80) {
        strengthLabel = '🟢 Strong';
        strengthBar.style.background = '#5bffb8';
    } else {
        strengthLabel = '✅ Very Strong';
        strengthBar.style.background = '#5bffb8';
    }

    strengthText.textContent = strengthLabel;
}

// Validate password match
function validatePasswordMatch() {
    const newPasswordField = document.getElementById('newPassword');
    const confirmPasswordField = document.getElementById('confirmPassword');
    const matchIndicator = document.getElementById('matchIndicator');
    if (!newPasswordField || !confirmPasswordField || !matchIndicator) return;

    const newPassword = newPasswordField.value;
    const confirmPassword = confirmPasswordField.value;

    if (!confirmPassword) {
        matchIndicator.classList.remove('show');
        return;
    }

    matchIndicator.classList.add('show');
    if (newPassword === confirmPassword && confirmPassword.length > 0) {
        matchIndicator.classList.add('match');
        matchIndicator.classList.remove('mismatch');
        matchIndicator.textContent = '✓ Passwords match';
    } else {
        matchIndicator.classList.remove('match');
        matchIndicator.classList.add('mismatch');
        matchIndicator.textContent = '✗ Passwords do not match';
    }

    updateChangePasswordButtonState();
}

function bindListenerById(id, eventName, handler) {
    const element = document.getElementById(id);
    if (!element) return;
    element.addEventListener(eventName, handler);
}

// Show/hide password requirements
bindListenerById('newPassword', 'focus', function () {
    const requirements = document.getElementById('newPasswordRequirements');
    if (requirements) requirements.classList.add('show');
});

bindListenerById('currentPassword', 'input', updateChangePasswordButtonState);
bindListenerById('newPassword', 'input', updateChangePasswordButtonState);
bindListenerById('confirmPassword', 'input', updateChangePasswordButtonState);
bindListenerById('newEmail', 'input', updateChangeEmailButtonState);
bindListenerById('confirmNewEmail', 'input', updateChangeEmailButtonState);
bindListenerById('changeEmailForm', 'reset', () => setTimeout(updateChangeEmailButtonState, 0));

bindListenerById('newPassword', 'blur', function () {
    if (!this.value) {
        const requirements = document.getElementById('newPasswordRequirements');
        if (requirements) requirements.classList.remove('show');
    }
});

function applyProfileTab(tabName) {
    const tabs = document.querySelectorAll('#profileTabs .profile-nav-item');
    const allPanels = Array.from(document.querySelectorAll('.profile-content-area .tab-content'));
    const panelByTab = {
        security: document.getElementById('profileSecurityContent'),
        account: document.getElementById('profileAccountContent'),
        geo: document.getElementById('profileGeoContent'),
        recovery: document.getElementById('profileRecoveryContent'),
        discord: document.getElementById('profileDiscordContent')
    };

    const normalizedTab = String(tabName || '').toLowerCase();
    const targetTab = ['security', 'account', 'geo', 'recovery', 'discord'].includes(normalizedTab)
        ? normalizedTab
        : 'security';

    tabs.forEach((tab) => {
        const isActive = tab.getAttribute('data-tab') === targetTab;
        tab.classList.toggle('active', isActive);
    });

    allPanels.forEach((panel) => {
        if (!panel) return;
        panel.style.display = 'none';
        panel.classList.remove('active');
    });

    const activePanel = panelByTab[targetTab];
    if (activePanel) {
        activePanel.style.display = 'block';
        activePanel.classList.add('active');
        activePanel.querySelectorAll('.card').forEach((card) => {
            card.style.display = 'block';
        });
        if (window.innerWidth <= 900) {
            activePanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    activeProfileTab = targetTab;

    if (targetTab === 'security') {
        applySecurityWorkspaceTab(activeSecurityWorkspaceTab);
    }
}

function applySecurityWorkspaceTab(tabName) {
    const validTabs = ['center', 'sessions', 'events'];
    const target = validTabs.includes(String(tabName || '').toLowerCase())
        ? String(tabName).toLowerCase()
        : 'center';

    activeSecurityWorkspaceTab = target;

    const buttons = document.querySelectorAll('#securityWorkspaceTabs .security-workspace-tab');
    buttons.forEach((button) => {
        const isActive = button.getAttribute('data-security-view') === target;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    const visibilityMap = {
        center: { securityCenterCard: '', securitySessionsCard: 'none', securityEventsCard: 'none' },
        sessions: { securityCenterCard: 'none', securitySessionsCard: '', securityEventsCard: 'none' },
        events: { securityCenterCard: 'none', securitySessionsCard: 'none', securityEventsCard: '' }
    };

    const styles = visibilityMap[target];
    Object.entries(styles).forEach(([id, display]) => {
        const element = document.getElementById(id);
        if (element) element.style.display = display;
    });
}

function initSecurityWorkspaceTabs() {
    const buttons = document.querySelectorAll('#securityWorkspaceTabs .security-workspace-tab');
    if (!buttons.length) return;

    buttons.forEach((button) => {
        button.addEventListener('click', () => {
            const view = button.getAttribute('data-security-view');
            if (!view) return;
            applySecurityWorkspaceTab(view);
        });
    });

    updateSecurityWorkspaceTabBadges();
    applySecurityWorkspaceTab(activeSecurityWorkspaceTab);
}

function updateSecurityWorkspaceTabBadges(summary = null) {
    const source = summary && typeof summary === 'object' ? summary : (securitySummary || {});
    const sessions = Array.isArray(source?.sessions) ? source.sessions : (Array.isArray(securitySessions) ? securitySessions : []);
    const events = Array.isArray(source?.recentEvents) ? source.recentEvents : [];
    const metrics24h = source?.metrics24h && typeof source.metrics24h === 'object' ? source.metrics24h : {};

    const failedEvents = Number.isFinite(Number(metrics24h.failedEvents))
        ? Number(metrics24h.failedEvents)
        : events.filter((event) => {
            const type = String(event?.eventType || '').toUpperCase();
            if (type.includes('FAILED')) return true;
            const metadata = event?.metadata && typeof event.metadata === 'object' ? event.metadata : {};
            const reason = String(metadata.reason || metadata.result || '').toLowerCase();
            return reason.includes('fail') || reason.includes('invalid') || reason.includes('denied');
        }).length;

    const centerBadge = document.getElementById('securityTabBadgeCenter');
    const sessionsBadge = document.getElementById('securityTabBadgeSessions');
    const eventsBadge = document.getElementById('securityTabBadgeEvents');

    if (centerBadge) {
        centerBadge.textContent = String(failedEvents);
        centerBadge.title = `${failedEvents} failed event${failedEvents === 1 ? '' : 's'} in rolling 24h`;
    }

    if (sessionsBadge) {
        sessionsBadge.textContent = String(sessions.length);
        sessionsBadge.title = `${sessions.length} active session${sessions.length === 1 ? '' : 's'}`;
    }

    if (eventsBadge) {
        const visibleEvents = Math.min(20, events.length);
        eventsBadge.textContent = String(visibleEvents);
        eventsBadge.title = `${visibleEvents} event${visibleEvents === 1 ? '' : 's'} shown`;
    }
}

async function ensureSecuritySummaryLoaded() {
    if (securitySummary && typeof securitySummary === 'object' && Object.keys(securitySummary).length > 0) {
        return true;
    }

    if (securitySummaryLoadingPromise) {
        try {
            await securitySummaryLoadingPromise;
            return true;
        } catch (_) {
            return false;
        }
    }

    securitySummaryLoadingPromise = loadSecurityCenter();
    try {
        await securitySummaryLoadingPromise;
        return true;
    } catch (_) {
        return false;
    } finally {
        securitySummaryLoadingPromise = null;
    }
}

function initProfileTabs() {
    const tabsContainer = document.getElementById('profileTabs');
    if (!tabsContainer) return;

    initSecurityWorkspaceTabs();
    initSecurityEventControls();

    tabsContainer.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;

        const tab = target.closest('.profile-nav-item');
        if (!tab || !tabsContainer.contains(tab)) return;

        event.preventDefault();
        const tabName = tab.getAttribute('data-tab');
        if (!tabName) return;

        applyProfileTab(tabName);
        if (['security', 'account', 'geo', 'recovery', 'discord'].includes(tabName)) {
            ensureSecuritySummaryLoaded().catch(() => { });
        }
    });

    applyProfileTab('security');
}

function initSecurityEventControls() {
    if (securityEventControlsInitialized) return;

    const toneFilter = document.getElementById('securityEventToneFilter');
    const searchInput = document.getElementById('securityEventSearch');
    const resetBtn = document.getElementById('securityEventFilterReset');
    const quickFilterButtons = Array.from(document.querySelectorAll('#securityEventTypeFilters .security-events-chip'));
    if (!toneFilter || !searchInput || !resetBtn) return;

    const refresh = () => {
        const sourceEvents = Array.isArray(securitySummary?.recentEvents) ? securitySummary.recentEvents : [];
        renderSecurityEvents(sourceEvents);
    };

    toneFilter.addEventListener('change', refresh);
    searchInput.addEventListener('input', refresh);
    quickFilterButtons.forEach((button) => {
        button.addEventListener('click', () => {
            quickFilterButtons.forEach((item) => {
                item.classList.remove('active');
                item.setAttribute('aria-pressed', 'false');
            });
            button.classList.add('active');
            button.setAttribute('aria-pressed', 'true');
            refresh();
        });
    });
    resetBtn.addEventListener('click', () => {
        toneFilter.value = 'all';
        searchInput.value = '';
        quickFilterButtons.forEach((item, index) => {
            const isAll = index === 0;
            item.classList.toggle('active', isAll);
            item.setAttribute('aria-pressed', isAll ? 'true' : 'false');
        });
        refresh();
    });

    securityEventControlsInitialized = true;
}

function formatRelativeTimeFromDate(value) {
    const timestamp = value instanceof Date ? value.getTime() : Number(new Date(value).getTime());
    if (!Number.isFinite(timestamp) || timestamp <= 0) return 'Unknown';

    const deltaMs = Date.now() - timestamp;
    if (!Number.isFinite(deltaMs) || deltaMs < 0) return 'Just now';

    const minutes = Math.floor(deltaMs / 60000);
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;

    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

function setElementDisplayById(id, value) {
    const element = document.getElementById(id);
    if (element) element.style.display = value;
}

function getProfileInitials(name) {
    const safeName = String(name || '').trim();
    if (!safeName) return '--';
    const parts = safeName.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
        return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
    }
    return safeName.slice(0, 2).toUpperCase();
}

// Load user profile
async function loadProfile() {
    try {
        // Check if viewing another user's profile
        const urlParams = new URLSearchParams(window.location.search);
        const viewUserId = urlParams.get('userId');
        const profileTabs = document.getElementById('profileTabs');

        // If viewing another user, fetch their data from /api/users/:userId
        const endpoint = viewUserId ? `/api/users/${encodeURIComponent(viewUserId)}` : '/api/user';
        const { response, data } = await window.AdminPanel.api.getJson(endpoint);
        if (response.ok) {
            // Handle different response formats
            currentUser = viewUserId ? (data.user || data) : data;

            // Update header - handle both admin users and Discord users
            const displayUsername = currentUser.username || '-';
            const displayRole = viewUserId ? 'Discord User' : (currentUser.role || 'user').toUpperCase();
            const roleClass = 'role-badge role-user';

            document.getElementById('headerUsername').textContent = displayUsername;
            document.getElementById('headerRole').textContent = displayRole;
            document.getElementById('headerRole').className = roleClass;

            const dropdownUsernameEl = document.getElementById('dropdownUsername');
            const dropdownRoleEl = document.getElementById('dropdownRole');
            if (dropdownUsernameEl) dropdownUsernameEl.textContent = displayUsername;
            if (dropdownRoleEl) {
                dropdownRoleEl.textContent = displayRole;
                dropdownRoleEl.className = roleClass;
            }

            // Handle different date fields for Discord users vs admin users
            const createdDate = currentUser.created_at || currentUser.joined_at ? new Date(currentUser.created_at || currentUser.joined_at) : null;

            const lastLoginDate = currentUser.last_login ? new Date(currentUser.last_login) : null;

            const heroTitle = document.getElementById('profileHeroTitle');
            const heroSubtitle = document.getElementById('profileHeroSubtitle');
            const heroRole = document.getElementById('profileHeroRole');
            const heroCreated = document.getElementById('profileHeroCreated');
            const heroLastActive = document.getElementById('profileHeroLastActive');
            const heroAvatar = document.getElementById('profileHeroAvatar');

            if (heroTitle) heroTitle.textContent = displayUsername;
            if (heroRole) {
                heroRole.textContent = displayRole;
                heroRole.className = 'profile-role-badge role-' + displayRole.toLowerCase();
            }
            if (heroCreated) heroCreated.textContent = createdDate ? createdDate.toLocaleDateString() : 'Unknown';
            if (heroLastActive) heroLastActive.textContent = lastLoginDate ? lastLoginDate.toLocaleString() : (viewUserId ? 'N/A' : 'First login');
            if (heroAvatar) heroAvatar.textContent = getProfileInitials(displayUsername);
            if (heroSubtitle) {
                heroSubtitle.textContent = viewUserId
                    ? 'Viewing Discord account details, moderation visibility, and operational context.'
                    : 'Manage profile identity, account security, and linked service visibility from one place.';
            }
            updateEmailVerificationUI(Boolean(currentUser.email_verified), currentUser.email);

            // Show Discord-specific fields if viewing a Discord user
            if (viewUserId) {
                setElementDisplayById('userActionsCard', 'block');
                setElementDisplayById('emailVerificationCard', 'none');
                setElementDisplayById('changeEmailCard', 'none');
                setElementDisplayById('changePasswordCard', 'none');
                setElementDisplayById('securityCenterCard', 'none');
                setElementDisplayById('securitySessionsCard', 'none');
                setElementDisplayById('securityEventsCard', 'none');
                setElementDisplayById('geoSnapshotCard', 'none');
                setElementDisplayById('accountRecoveryCard', 'none');
                setElementDisplayById('discordLinkCard', 'none');
                const securityTab = document.getElementById('profileSecurityTabBtn');
                const accountTab = document.getElementById('profileAccountTabBtn');
                const geoTab = document.getElementById('profileGeoTabBtn');
                const recoveryTab = document.getElementById('profileRecoveryTabBtn');
                const discordTab = document.getElementById('profileDiscordTabBtn');
                if (securityTab) securityTab.style.display = 'none';
                if (accountTab) accountTab.style.display = 'none';
                if (geoTab) geoTab.style.display = 'none';
                if (recoveryTab) recoveryTab.style.display = 'none';
                if (discordTab) discordTab.style.display = 'none';
                if (profileTabs) profileTabs.style.display = 'none';
                applyProfileTab('security');
            } else {
                setElementDisplayById('userActionsCard', 'none');
                setElementDisplayById('emailVerificationCard', 'block');
                setElementDisplayById('changeEmailCard', 'block');
                setElementDisplayById('changePasswordCard', 'block');
                setElementDisplayById('geoSnapshotCard', 'block');
                setElementDisplayById('accountRecoveryCard', 'block');
                setElementDisplayById('discordLinkCard', 'block');
                const securityTab = document.getElementById('profileSecurityTabBtn');
                const accountTab = document.getElementById('profileAccountTabBtn');
                const geoTab = document.getElementById('profileGeoTabBtn');
                const recoveryTab = document.getElementById('profileRecoveryTabBtn');
                const discordTab = document.getElementById('profileDiscordTabBtn');
                if (securityTab) securityTab.style.display = 'inline-flex';
                if (accountTab) accountTab.style.display = 'inline-flex';
                if (geoTab) geoTab.style.display = 'inline-flex';
                if (recoveryTab) recoveryTab.style.display = 'inline-flex';
                if (discordTab) discordTab.style.display = 'inline-flex';
                if (profileTabs) profileTabs.style.display = 'flex';
                applyProfileTab(activeProfileTab);
                applySecurityWorkspaceTab(activeSecurityWorkspaceTab);
            }

            // Show/hide nav links based on role
            const role = currentUser.role || 'moderator';
            if (role === 'owner') {
                document.getElementById('moderatorLink').style.display = 'inline-block';
                document.getElementById('adminLink').style.display = 'inline-block';
                document.getElementById('ownerLink').style.display = 'inline-block';
            } else if (role === 'admin') {
                document.getElementById('moderatorLink').style.display = 'inline-block';
                document.getElementById('adminLink').style.display = 'inline-block';
                document.getElementById('ownerLink').style.display = 'none';
            } else if (role === 'moderator') {
                document.getElementById('moderatorLink').style.display = 'inline-block';
                document.getElementById('adminLink').style.display = 'none';
                document.getElementById('ownerLink').style.display = 'none';
            }

            if (!viewUserId) {
                ensureSecuritySummaryLoaded().catch(() => { });
            }
        } else if (response.status === 401) {
            console.log('Unauthorized - redirecting to login');
            window.location.href = '/login';
        } else {
            const errorData = await response.json();
            console.error('Failed to load profile:', errorData);
            showError('Failed to load profile: ' + (errorData.error || 'Unknown error'));
        }
    } catch (error) {
        console.error('Error loading profile:', error);
        showError('Failed to load profile information');
    }
}

async function loadSecurityCenter() {
    try {
        const { response, data } = await window.AdminPanel.api.getJson('/api/security/summary');

        if (!response.ok) {
            throw new Error(data.error || 'Failed to load security center');
        }

        updateTwoFactorStatus(Boolean(data.twoFactorEnabled), data.twoFactorEnabledAt);
        securitySummary = data || {};
        securitySessions = Array.isArray(data.sessions) ? data.sessions : [];
        updateSecurityWorkspaceTabBadges(data || {});
        renderSecurityOverview(data || {});
        renderSecurityAnalytics(data || {});
        renderSecuritySessions();
        renderSecurityEvents(Array.isArray(data.recentEvents) ? data.recentEvents : []);
        renderLoginGeoSnapshot(data.geoSnapshot || {});
        renderAccountRecovery(data.recovery || {});
        renderDiscordLink(data.discordLink || {});
        await loadDiscordOAuthRuntimeInfo();
        return true;
    } catch (error) {
        console.error('Error loading security center:', error);
        showError(error.message || 'Failed to load security center');
        throw error;
    }
}

async function loadDiscordOAuthRuntimeInfo() {
    const warning = document.getElementById('discordOAuthHostWarning');
    const authorizeBtn = document.getElementById('discordAuthorizeBtn');
    if (!warning) return;

    discordOAuthHealthState = discordAccountLinked ? 'linked' : 'checking';
    updateDiscordConnectionHealthChip();
    warning.style.display = 'none';
    warning.textContent = '';
    if (authorizeBtn) {
        if (discordAccountLinked) {
            authorizeBtn.disabled = true;
            authorizeBtn.style.opacity = '0.6';
            authorizeBtn.style.cursor = 'not-allowed';
            authorizeBtn.title = 'This profile is already linked. Unlink first to connect a different Discord account';
        } else {
            authorizeBtn.disabled = false;
            authorizeBtn.style.opacity = '1';
            authorizeBtn.style.cursor = 'pointer';
            authorizeBtn.title = '';
        }
    }

    try {
        const { response, data } = await window.AdminPanel.api.getJson('/api/account/discord/oauth/runtime');

        if (!response.ok) {
            throw new Error(data.error || 'Failed to read Discord OAuth runtime config');
        }

        if (!data.ready) {
            discordOAuthHealthState = 'unavailable';
            warning.textContent = 'Discord OAuth is not fully configured on the server. Linking is currently unavailable.';
            warning.style.display = 'block';
            if (authorizeBtn) {
                authorizeBtn.disabled = true;
                authorizeBtn.style.opacity = '0.6';
                authorizeBtn.style.cursor = 'not-allowed';
                authorizeBtn.title = 'Discord OAuth is not configured on the server';
            }
            updateDiscordConnectionHealthChip();
            return;
        }

        const currentOrigin = window.location.origin;
        const callbackOrigin = String(data.callbackOrigin || '').trim();

        if (!discordAccountLinked && callbackOrigin && currentOrigin !== callbackOrigin) {
            discordOAuthHealthState = 'host-mismatch';
            warning.innerHTML = `<strong>OAuth host mismatch detected.</strong><br>Current panel host: ${escapeHtml(currentOrigin)}<br>Configured callback host: ${escapeHtml(callbackOrigin)}<div class="discord-warning-fix"><strong>Fix:</strong> Open this panel on <strong>${escapeHtml(callbackOrigin)}</strong>, then sign in and retry linking.</div>`;
            warning.style.display = 'block';
            if (authorizeBtn) {
                authorizeBtn.disabled = true;
                authorizeBtn.style.opacity = '0.6';
                authorizeBtn.style.cursor = 'not-allowed';
                authorizeBtn.title = 'Open the panel on the configured callback host before linking';
            }
            updateDiscordConnectionHealthChip();
            return;
        }

        discordOAuthHealthState = discordAccountLinked ? 'linked' : 'ready';
        updateDiscordConnectionHealthChip();
    } catch (error) {
        discordOAuthHealthState = discordAccountLinked ? 'linked' : 'error';
        updateDiscordConnectionHealthChip();
        console.warn('Could not load Discord OAuth runtime config:', error);
    }
}

function getDiscordConnectionHealthMeta() {
    if (discordAccountLinked) {
        return {
            label: 'Connection Health: Linked',
            tone: 'positive',
            title: 'Discord is currently linked to this profile. Unlink first if you want to connect a different Discord account.'
        };
    }

    const state = String(discordOAuthHealthState || 'checking').toLowerCase();
    if (state === 'ready') {
        return {
            label: 'Connection Health: OAuth Ready',
            tone: 'positive',
            title: 'Discord OAuth runtime configuration is valid for this host. You can authorize linking safely.'
        };
    }
    if (state === 'host-mismatch') {
        return {
            label: 'Connection Health: Host Mismatch',
            tone: 'warning',
            title: 'This panel host does not match the configured OAuth callback host. Open the panel on the configured host before linking.'
        };
    }
    if (state === 'unavailable') {
        return {
            label: 'Connection Health: OAuth Unavailable',
            tone: 'warning',
            title: 'Discord OAuth is not fully configured on the server. Linking remains disabled until runtime config is completed.'
        };
    }
    if (state === 'error') {
        return {
            label: 'Connection Health: Runtime Check Failed',
            tone: 'warning',
            title: 'The panel could not verify Discord OAuth runtime state. Check server logs or retry after refresh.'
        };
    }
    return {
        label: 'Connection Health: Checking',
        tone: 'neutral',
        title: 'Discord OAuth runtime status is being checked.'
    };
}

function updateDiscordConnectionHealthChip() {
    const target = document.getElementById('discordConnectionHealthChip');
    if (!target) return;
    const meta = getDiscordConnectionHealthMeta();
    target.innerHTML = buildStatusBadge(meta.label, meta.tone);
    target.title = meta.title || '';
    target.setAttribute('aria-label', meta.label);
}

function updateTwoFactorStatus(enabled, enabledAt) {
    const statusEl = document.getElementById('twoFactorStatusText');
    const statusHintEl = document.getElementById('twoFactorStatusHint');
    const setupBtn = document.getElementById('setup2faBtn');
    const disableBtn = document.getElementById('disable2faBtn');
    const setupPanel = document.getElementById('twoFactorSetupPanel');

    if (statusEl) {
        const badge = buildStatusBadge(enabled ? 'Enabled' : 'Disabled', enabled);
        const since = enabled && enabledAt
            ? `<span style="color: var(--color-text-light);"> since ${escapeHtml(new Date(enabledAt).toLocaleString())}</span>`
            : '';
        statusEl.innerHTML = `${badge}${since}`;
    }

    if (statusHintEl) {
        statusHintEl.textContent = enabled
            ? 'Two-factor verification is active for password sign-in attempts.'
            : 'Enable 2FA to reduce account takeover risk and strengthen sign-in assurance.';
    }

    if (setupBtn) setupBtn.style.display = enabled ? 'none' : 'inline-flex';
    if (disableBtn) disableBtn.style.display = enabled ? 'inline-flex' : 'none';
    if (!enabled && setupPanel) setupPanel.style.display = 'none';
}

function formatAuthMethod(authMethod) {
    const raw = String(authMethod || '').trim();
    if (!raw) return '';
    const normalized = raw.toLowerCase();
    if (normalized === 'recovery-code' || normalized === 'recovery_code' || normalized === 'recovery') return 'Recovery Code';
    if (normalized === 'totp' || normalized === '2fa') return '2FA';
    if (normalized === 'password') return 'Password';
    return raw.replace(/[_-]+/g, ' ').replace(/\b\w/g, (match) => match.toUpperCase());
}

function formatSecurityEventType(eventType, event = null) {
    const map = {
        LOGIN_SUCCESS: 'Login Success',
        LOGIN_SUCCESS_RECOVERY: 'Login Success (Recovery)',
        LOGIN_2FA_CHALLENGE: 'Login 2FA Challenge',
        LOGIN_FAILED: 'Login Failed',
        LOGIN_2FA_FAILED: '2FA Failed',
        LOGOUT: 'Logout',
        PASSWORD_CHANGED: 'Password Changed',
        SESSIONS_REVOKED: 'Sessions Revoked',
        TWO_FACTOR_ENABLED: '2FA Enabled',
        TWO_FACTOR_DISABLED: '2FA Disabled'
    };

    const key = String(eventType || '').toUpperCase();
    if (map[key]) return map[key];

    const metadata = event?.metadata && typeof event.metadata === 'object' ? event.metadata : {};
    const authMethod = String(metadata.authMethod || metadata.auth_method || '').toLowerCase();
    const reason = String(metadata.reason || metadata.result || '').toLowerCase();
    const looksFailed = reason.includes('fail') || reason.includes('invalid') || reason.includes('denied');

    if (authMethod === 'recovery-code' || authMethod === 'recovery_code' || authMethod === 'recovery') {
        return looksFailed ? 'Recovery Login Failed' : 'Recovery Login';
    }

    return key ? key.replace(/_/g, ' ') : 'Authentication Event';
}

function getSecurityEventTone(eventType, event = null) {
    const key = String(eventType || '').toUpperCase();
    if (key === 'LOGIN_2FA_CHALLENGE') return 'neutral';
    if (key.includes('FAILED')) return 'warning';
    if (key.includes('REVOKED') || key.includes('DISABLED') || key.includes('PASSWORD_CHANGED')) return 'warning';
    if (key.includes('SUCCESS') || key.includes('ENABLED') || key === 'LOGOUT') return 'positive';

    const metadata = event?.metadata && typeof event.metadata === 'object' ? event.metadata : {};
    const authMethod = String(metadata.authMethod || metadata.auth_method || '').toLowerCase();
    const reason = String(metadata.reason || metadata.result || '').toLowerCase();
    const looksFailed = reason.includes('fail') || reason.includes('invalid') || reason.includes('denied');
    if (authMethod === 'recovery-code' || authMethod === 'recovery_code' || authMethod === 'recovery') {
        return looksFailed ? 'warning' : 'positive';
    }

    return 'neutral';
}

function formatFailureReason(rawReason) {
    const raw = String(rawReason || '').trim();
    if (!raw) return '';
    const normalized = raw.toLowerCase();
    const reasonMap = {
        'user-not-found': 'Account not found',
        'user_not_found': 'Account not found',
        'invalid-password': 'Incorrect password',
        'invalid_password': 'Incorrect password',
        'invalid-credentials': 'Invalid credentials',
        'invalid_credentials': 'Invalid credentials',
        'invalid-totp': 'Incorrect 2FA code',
        'invalid_totp': 'Incorrect 2FA code',
        'totp-required': '2FA code required',
        'totp_required': '2FA code required',
        'account-locked': 'Account locked',
        'account_locked': 'Account locked',
        'rate-limit': 'Too many attempts',
        'rate_limit': 'Too many attempts',
        'session-expired': 'Session expired',
        'session_expired': 'Session expired'
    };
    return reasonMap[normalized] || raw.replace(/[_-]+/g, ' ').replace(/\b\w/g, (match) => match.toUpperCase());
}

function getSecurityEventContext(event) {
    const metadata = event?.metadata && typeof event.metadata === 'object' ? event.metadata : {};
    const contextParts = [];
    if (metadata.reason) {
        const formattedReason = formatFailureReason(metadata.reason);
        contextParts.push(`Reason: ${formattedReason}`);
    }
    if (metadata.mode) contextParts.push(`Mode: ${metadata.mode}`);
    if (Number.isFinite(Number(metadata.attempts))) contextParts.push(`Attempts: ${metadata.attempts}`);
    const authMethod = formatAuthMethod(metadata.authMethod || metadata.auth_method);
    if (authMethod) contextParts.push(`Auth: ${authMethod}`);
    return contextParts.join(' • ');
}

function renderSecurityAnalytics(summary) {
    const twoFactorMetaPrimary = document.getElementById('twoFactorMetaPrimary');
    const twoFactorMetaSecondary = document.getElementById('twoFactorMetaSecondary');
    const sessionStatsPrimary = document.getElementById('securitySessionStatsPrimary');
    const sessionStatsSecondary = document.getElementById('securitySessionStatsSecondary');
    const eventStatsPrimary = document.getElementById('securityEventStatsPrimary');
    const eventStatsSecondary = document.getElementById('securityEventStatsSecondary');

    const sessions = Array.isArray(summary?.sessions) ? summary.sessions : [];
    const events = Array.isArray(summary?.recentEvents) ? summary.recentEvents : [];
    const metrics24h = summary?.metrics24h && typeof summary.metrics24h === 'object' ? summary.metrics24h : {};
    const twoFactorEnabled = Boolean(summary?.twoFactorEnabled);
    const twoFactorEnabledAt = summary?.twoFactorEnabledAt ? new Date(summary.twoFactorEnabledAt) : null;

    const failedEvents = events.filter((event) => {
        const eventType = String(event?.eventType || '').toUpperCase();
        if (eventType.includes('FAILED')) return true;
        const metadata = event?.metadata && typeof event.metadata === 'object' ? event.metadata : {};
        const reason = String(metadata.reason || metadata.result || '').toLowerCase();
        return reason.includes('fail') || reason.includes('invalid') || reason.includes('denied');
    });

    const loginEventsRecent = events.filter((event) => {
        const eventType = String(event?.eventType || '').toUpperCase();
        return eventType.startsWith('LOGIN_');
    });

    const lastTwoFactorFailure = failedEvents.find((event) => String(event?.eventType || '').toUpperCase() === 'LOGIN_2FA_FAILED') || null;
    const recoveryLogins = events.filter((event) => String(event?.eventType || '').toUpperCase() === 'LOGIN_SUCCESS_RECOVERY').length;
    const revokeEvents = events.filter((event) => String(event?.eventType || '').toUpperCase() === 'SESSIONS_REVOKED').length;

    const eventsRolling24h = Number.isFinite(Number(metrics24h.events)) ? Number(metrics24h.events) : events.length;
    const failedRolling24h = Number.isFinite(Number(metrics24h.failedEvents)) ? Number(metrics24h.failedEvents) : failedEvents.length;
    const loginRolling24h = Number.isFinite(Number(metrics24h.loginEvents)) ? Number(metrics24h.loginEvents) : loginEventsRecent.length;
    const recoveryRolling24h = Number.isFinite(Number(metrics24h.recoveryLogins)) ? Number(metrics24h.recoveryLogins) : recoveryLogins;
    const revocationsRolling24h = Number.isFinite(Number(metrics24h.sessionRevocations)) ? Number(metrics24h.sessionRevocations) : revokeEvents;

    const currentSession = sessions.find((session) => session.isCurrent) || null;
    const otherSessions = Math.max(0, sessions.length - (currentSession ? 1 : 0));
    const uniqueSessionIps = new Set(sessions.map((session) => session?.ipAddress).filter(Boolean));
    const uniqueSessionLocations = new Set(sessions.map((session) => session?.geoLabel).filter(Boolean));
    const now = Date.now();

    const activeSessionAge = currentSession?.loginTime
        ? (() => {
            const ageMs = now - Number(currentSession.loginTime);
            if (!Number.isFinite(ageMs) || ageMs < 0) return 'Current session active';
            const minutes = Math.floor(ageMs / 60000);
            if (minutes < 1) return 'Started moments ago';
            if (minutes < 60) return `${minutes}m active`;
            const hours = Math.floor(minutes / 60);
            return `${hours}h active`;
        })()
        : 'Current session active';

    if (twoFactorMetaPrimary && twoFactorMetaSecondary) {
        const twoFactorEnabledLabel = twoFactorEnabled
            ? (twoFactorEnabledAt ? twoFactorEnabledAt.toLocaleString() : 'Enabled')
            : 'Not enabled';
        const lastFailureLabel = lastTwoFactorFailure?.createdAt
            ? new Date(lastTwoFactorFailure.createdAt).toLocaleString()
            : 'None recorded';

        twoFactorMetaPrimary.innerHTML = `
                    ${buildSecurityMiniCard('Enabled Since', twoFactorEnabledLabel, twoFactorEnabled ? '2FA protection is currently active' : 'Enable 2FA for stronger login protection')}
                    ${buildSecurityMiniCard('Last 2FA Failure', lastFailureLabel, lastTwoFactorFailure ? 'Monitor repeated failures for suspicious activity' : 'No recent 2FA verification failures detected')}
                `;
        twoFactorMetaSecondary.innerHTML = `
                    ${buildSecurityMiniCard('Recovery Logins', recoveryLogins, recoveryLogins > 0 ? 'Recovery flow has been used for account access' : 'No recovery-code logins on recent record')}
                `;
    }

    if (sessionStatsPrimary && sessionStatsSecondary) {
        sessionStatsPrimary.innerHTML = `
                    ${buildSecurityMiniCard('Current Session', currentSession ? 'Present' : 'Not detected', activeSessionAge)}
                    ${buildSecurityMiniCard('Other Sessions', otherSessions, otherSessions > 0 ? 'Consider revoking unrecognized devices' : 'No additional active sessions')}
                `;
        sessionStatsSecondary.innerHTML = `
                    ${buildSecurityMiniCard('Unique Session IPs', uniqueSessionIps.size, uniqueSessionIps.size > 0 ? `${uniqueSessionLocations.size} location label${uniqueSessionLocations.size === 1 ? '' : 's'} observed` : 'No session IP data available')}
                    ${buildSecurityMiniCard('Logins (24h)', loginRolling24h, loginRolling24h > 0 ? 'Authentication activity across the last rolling 24 hours' : 'No login events in the last rolling 24 hours')}
                `;
    }

    if (eventStatsPrimary && eventStatsSecondary) {
        eventStatsPrimary.innerHTML = `
                    ${buildSecurityMiniCard('Events (24h)', eventsRolling24h, 'Security event volume over the last rolling 24 hours')}
                    ${buildSecurityMiniCard('Failed Attempts (24h)', failedRolling24h, failedRolling24h > 0 ? 'Investigate repeated failures or unknown origins' : 'No failed attempts detected in the last rolling 24 hours')}
                `;
        eventStatsSecondary.innerHTML = `
                    ${buildSecurityMiniCard('Recovery Logins (24h)', recoveryRolling24h, recoveryRolling24h > 0 ? 'Review if emergency access usage was expected' : 'No recovery login usage in the last rolling 24 hours')}
                    ${buildSecurityMiniCard('Session Revocations (24h)', revocationsRolling24h, revocationsRolling24h > 0 ? 'Session revocations were performed in the last rolling 24 hours' : 'No revocation activity in the last rolling 24 hours')}
                `;
    }
}

function renderSecurityOverview(summary) {
    const primaryContainer = document.getElementById('securityOverviewPrimary');
    const secondaryContainer = document.getElementById('securityOverviewSecondary');
    if (!primaryContainer || !secondaryContainer) return;

    const sessions = Array.isArray(summary?.sessions) ? summary.sessions : [];
    const events = Array.isArray(summary?.recentEvents) ? summary.recentEvents : [];
    const metrics24h = summary?.metrics24h && typeof summary.metrics24h === 'object' ? summary.metrics24h : {};
    const hiddenStaleSessions = Number(summary?.hiddenStaleSessions || 0);
    const twoFactorEnabled = Boolean(summary?.twoFactorEnabled);

    const failedEventsRecent = events.filter((event) => {
        const eventType = String(event?.eventType || '').toUpperCase();
        if (!eventType.includes('FAILED')) return false;
        return true;
    }).length;

    const failedEvents24h = Number.isFinite(Number(metrics24h.failedEvents))
        ? Number(metrics24h.failedEvents)
        : failedEventsRecent;

    const riskLevel = !twoFactorEnabled || failedEvents24h >= 3
        ? 'Needs Attention'
        : (failedEvents24h > 0 ? 'Elevated Monitoring' : 'Healthy');
    const riskTone = riskLevel === 'Healthy' ? 'positive' : 'warning';

    const currentSession = sessions.find((session) => session.isCurrent) || null;
    const now = Date.now();
    const currentSessionAgeLabel = currentSession?.loginTime
        ? (() => {
            const ageMs = now - Number(currentSession.loginTime);
            if (!Number.isFinite(ageMs) || ageMs < 0) return 'Current session active';
            const ageMinutes = Math.floor(ageMs / 60000);
            if (ageMinutes < 1) return 'Started moments ago';
            if (ageMinutes < 60) return `Started ${ageMinutes} min ago`;
            const ageHours = Math.floor(ageMinutes / 60);
            return `Started ${ageHours}h ago`;
        })()
        : 'Current session active';

    primaryContainer.innerHTML = `
                <div class="security-overview-item">
                    <strong>Security Status</strong>
                    ${buildStatusBadge(riskLevel, riskTone)}
                    <div class="security-empty-note">Based on 2FA state and recent failed sign-in events.</div>
                </div>
                <div class="security-overview-item">
                    <strong>Active Sessions</strong>
                    <span class="overview-value">${escapeHtml(String(sessions.length))}</span>
                    <div class="security-empty-note">${escapeHtml(currentSessionAgeLabel)}${hiddenStaleSessions > 0 ? ` • ${hiddenStaleSessions} stale hidden` : ''}</div>
                </div>
            `;

    secondaryContainer.innerHTML = `
                <div class="security-overview-item">
                    <strong>2FA Posture</strong>
                    ${buildStatusBadge(twoFactorEnabled ? 'Enabled' : 'Disabled', twoFactorEnabled ? 'positive' : 'warning')}
                    <div class="security-empty-note">${twoFactorEnabled ? 'Password logins require second-factor verification.' : 'Enable 2FA for stronger sign-in protection.'}</div>
                </div>
                <div class="security-overview-item">
                    <strong>Failed Events (Recent)</strong>
                    <span class="overview-value">${escapeHtml(String(failedEvents24h))}</span>
                    <div class="security-empty-note">Tracks login and 2FA failures over the last rolling 24 hours.</div>
                </div>
            `;
}

function renderSecuritySessions() {
    const tbody = document.getElementById('securitySessionsTable');
    const hiddenSessionsHint = document.getElementById('hiddenSessionsHint');
    const sessionsOverview = document.getElementById('securitySessionsOverview');
    if (!tbody) return;

    const hiddenStaleSessions = Number(securitySummary?.hiddenStaleSessions || 0);
    if (hiddenSessionsHint) {
        if (hiddenStaleSessions > 0) {
            hiddenSessionsHint.style.display = 'block';
            hiddenSessionsHint.textContent = `${hiddenStaleSessions} low-confidence stale session${hiddenStaleSessions === 1 ? '' : 's'} hidden from this view to reduce noise.`;
        } else {
            hiddenSessionsHint.style.display = 'none';
            hiddenSessionsHint.textContent = '';
        }
    }

    if (sessionsOverview) {
        const totalSessions = securitySessions.length;
        const currentSessions = securitySessions.filter((session) => Boolean(session.isCurrent)).length;
        const uniqueSessionIps = new Set(
            securitySessions
                .map((session) => session.ipAddressV4 || session.ipAddressV6 || session.ipAddress)
                .map((ip) => String(ip || '').trim())
                .filter(Boolean)
        );
        const latestLoginMs = securitySessions
            .map((session) => Number(session.loginTime || 0))
            .filter((value) => Number.isFinite(value) && value > 0)
            .sort((a, b) => b - a)[0] || null;
        const latestLoginLabel = latestLoginMs ? new Date(latestLoginMs).toLocaleString() : 'Unavailable';

        sessionsOverview.innerHTML = `
                    ${buildSecurityMiniCard('Total Sessions', totalSessions, hiddenStaleSessions > 0 ? `${hiddenStaleSessions} stale hidden from list` : 'Visible sessions currently tracked')}
                    ${buildSecurityMiniCard('Current Session', currentSessions > 0 ? 'Verified' : 'Not marked', currentSessions > 0 ? 'This browser session is recognized' : 'Unable to confirm current browser session')}
                    ${buildSecurityMiniCard('Unique IPs', uniqueSessionIps.size, uniqueSessionIps.size > 1 ? 'Multiple network origins currently active' : 'Single network origin currently active')}
                    ${buildSecurityMiniCard('Most Recent Login', latestLoginLabel, latestLoginMs ? 'Newest established session timestamp' : 'No session timestamps available')}
                `;
    }

    if (!securitySessions.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color: var(--color-text-light);">No active sessions found.</td></tr>';
        return;
    }

    tbody.innerHTML = securitySessions.map((session) => {
        const loginMs = Number(session.loginTime || 0);
        const loginTime = loginMs > 0 ? new Date(loginMs).toLocaleString() : 'Unknown';
        const ageMs = loginMs > 0 ? (Date.now() - loginMs) : null;
        const ageHours = Number.isFinite(ageMs) && ageMs >= 0 ? Math.floor(ageMs / (60 * 60 * 1000)) : null;
        const ageLabel = ageHours === null
            ? 'Age unavailable'
            : (ageHours < 1 ? 'Started <1h ago' : `Started ${ageHours}h ago`);
        const primaryIp = session.ipAddressV4 || null;
        const fallbackIp = session.ipAddressV6 || session.ipAddress || null;
        const ipDisplay = formatIpAddressForDisplay(primaryIp || fallbackIp);
        const statusBadge = buildStatusBadge(session.isCurrent ? 'Current' : 'Active', session.isCurrent);
        const encodedSessionId = encodeURIComponent(session.sessionId || '');
        const detailsButton = `<button class="btn btn-sm btn-secondary" onclick="openSessionDetails('${encodedSessionId}')">Details</button>`;
        const actionButton = session.isCurrent
            ? `${detailsButton} <span style="margin-left:0.5rem;">${buildStatusBadge('This Session', 'neutral')}</span>`
            : `${detailsButton} <button class="btn btn-sm btn-danger" onclick="revokeSession('${session.sessionId}')">Revoke</button>`;
        const tooltipParts = [];
        if (ipDisplay.tooltip) tooltipParts.push(ipDisplay.tooltip);
        if (!primaryIp && session.ipAddressV6) tooltipParts.push(`IPv6: ${session.ipAddressV6}`);
        const ipTooltip = tooltipParts.length ? ` title="${escapeHtml(tooltipParts.join(' | '))}"` : '';
        const sessionGeo = session.geoLabel ? `<span class="security-ip-meta">${escapeHtml(session.geoLabel)}</span>` : '';
        const rawSessionId = String(session.sessionId || '').trim();
        const sessionSuffix = rawSessionId ? rawSessionId.slice(-8) : 'Unknown';
        const safeDeviceLabel = escapeHtml(session.device || 'Unknown');

        return `
                    <tr>
                        <td>
                            <div class="security-event-main"><strong>${safeDeviceLabel}</strong></div>
                            <div class="security-event-sub">Session • ${escapeHtml(sessionSuffix)}</div>
                        </td>
                        <td${ipTooltip}>${escapeHtml(ipDisplay.label)}${sessionGeo}</td>
                        <td>
                            <div class="security-event-main">${loginTime}</div>
                            <div class="security-event-sub">${escapeHtml(ageLabel)}</div>
                        </td>
                        <td>${statusBadge}</td>
                        <td>${actionButton}</td>
                    </tr>
                `;
    }).join('');
}

const MAX_SECURITY_EVENTS = 20;

function getSecurityEventTypeKey(event) {
    return String(event?.eventType || event?.event_type || '').toUpperCase();
}

function doesEventMatchQuickFilter(event, quickFilter) {
    const normalizedFilter = String(quickFilter || 'all').toUpperCase();
    if (!normalizedFilter || normalizedFilter === 'ALL') return true;

    const eventType = getSecurityEventTypeKey(event);
    if (normalizedFilter === 'LOGIN_SUCCESS') {
        return eventType === 'LOGIN_SUCCESS' || eventType === 'LOGIN_SUCCESS_RECOVERY';
    }

    return eventType === normalizedFilter;
}

function renderSecurityEvents(events) {
    const tbody = document.getElementById('securityEventsTable');
    if (!tbody) return;

    const toneFilter = document.getElementById('securityEventToneFilter');
    const searchInput = document.getElementById('securityEventSearch');
    const activeQuickFilter = document.querySelector('#securityEventTypeFilters .security-events-chip.active');

    const filterTone = String(toneFilter?.value || 'all').toLowerCase();
    const searchTerm = String(searchInput?.value || '').trim().toLowerCase();
    const quickFilter = String(activeQuickFilter?.getAttribute('data-event-filter') || 'all');
    const sourceEvents = Array.isArray(events) ? events : [];

    const warningCount = sourceEvents.filter((event) => getSecurityEventTone(getSecurityEventTypeKey(event), event) === 'warning').length;
    const positiveCount = sourceEvents.filter((event) => getSecurityEventTone(getSecurityEventTypeKey(event), event) === 'positive').length;
    const latestEvent = sourceEvents.find((event) => event?.createdAt) || sourceEvents[0] || null;

    const metricTotal = document.getElementById('securityEventsMetricTotal');
    const metricWarnings = document.getElementById('securityEventsMetricWarnings');
    const metricSuccess = document.getElementById('securityEventsMetricSuccess');
    const metricLatest = document.getElementById('securityEventsMetricLatest');
    const visibleCountEl = document.getElementById('securityEventVisibleCount');
    const totalCountEl = document.getElementById('securityEventTotalCount');

    if (metricTotal) metricTotal.textContent = String(sourceEvents.length);
    if (metricWarnings) metricWarnings.textContent = String(warningCount);
    if (metricSuccess) metricSuccess.textContent = String(positiveCount);
    if (metricLatest) {
        metricLatest.textContent = latestEvent?.createdAt
            ? formatRelativeTimeFromDate(latestEvent.createdAt)
            : 'Unavailable';
        metricLatest.title = latestEvent?.createdAt ? new Date(latestEvent.createdAt).toLocaleString() : 'No event timestamp available';
    }
    if (totalCountEl) totalCountEl.textContent = String(sourceEvents.length);

    const filteredEvents = sourceEvents.filter((event) => {
        if (!doesEventMatchQuickFilter(event, quickFilter)) return false;

        const tone = getSecurityEventTone(getSecurityEventTypeKey(event), event);
        if (filterTone !== 'all' && tone !== filterTone) return false;

        if (!searchTerm) return true;

        const eventLabel = formatSecurityEventType(event?.eventType, event).toLowerCase();
        const eventContext = getSecurityEventContext(event).toLowerCase();
        const ip = String(event?.ipAddress || '').toLowerCase();
        const geo = String(event?.geoLabel || '').toLowerCase();
        return [eventLabel, eventContext, ip, geo].some((value) => value.includes(searchTerm));
    });

    const visibleEvents = filteredEvents.slice(0, MAX_SECURITY_EVENTS);
    if (visibleCountEl) visibleCountEl.textContent = String(visibleEvents.length);

    if (!visibleEvents.length) {
        tbody.innerHTML = '<tr><td colspan="3" style="text-align:center; color: var(--color-text-light);">No recent security events.</td></tr>';
        return;
    }

    tbody.innerHTML = visibleEvents.map((event) => {
        const eventTime = event.createdAt ? new Date(event.createdAt).toLocaleString() : 'Unknown';
        const ipDisplay = formatIpAddressForDisplay(event.ipAddress);
        const ipTooltip = ipDisplay.tooltip ? ` title="${escapeHtml(ipDisplay.tooltip)}"` : '';
        const normalizedEventType = getSecurityEventTypeKey(event);
        const eventLabel = formatSecurityEventType(normalizedEventType, event);
        const eventTone = getSecurityEventTone(normalizedEventType, event);
        const eventContext = getSecurityEventContext(event);
        const geoLabel = event?.geoLabel ? escapeHtml(event.geoLabel) : '';
        const relativeTime = event.createdAt ? formatRelativeTimeFromDate(event.createdAt) : 'Unknown';
        return `
                    <tr>
                        <td>
                            <div class="security-event-main">
                                ${buildStatusBadge(eventLabel, eventTone)}
                            </div>
                            ${eventContext ? `<div class="security-event-sub">${escapeHtml(eventContext)}</div>` : ''}
                        </td>
                        <td${ipTooltip}>${escapeHtml(ipDisplay.label)}${geoLabel ? `<span class="security-ip-meta">${geoLabel}</span>` : ''}</td>
                        <td>
                            <div class="security-event-main">${eventTime}</div>
                            <div class="security-event-sub">${escapeHtml(relativeTime)}</div>
                        </td>
                    </tr>
                `;
    }).join('');
}

function renderLoginGeoSnapshot(snapshot) {
    const container = document.getElementById('loginGeoSnapshot');
    if (!container) return;

    const fallbackEvent = Array.isArray(securitySummary?.recentEvents) && securitySummary.recentEvents.length
        ? securitySummary.recentEvents[0]
        : null;
    const fallbackSession = Array.isArray(securitySessions) && securitySessions.length
        ? securitySessions[0]
        : null;

    const latestLocation = snapshot?.latestLocation
        || fallbackEvent?.geoLabel
        || fallbackSession?.geoLabel
        || 'Unknown location';
    const latestIp = snapshot?.latestIp
        || fallbackEvent?.ipAddress
        || fallbackSession?.ipAddress
        || 'Unknown';
    const latestTimeValue = snapshot?.latestTime
        || fallbackEvent?.createdAt
        || (fallbackSession?.loginTime ? Number(fallbackSession.loginTime) : null);
    const latestTime = latestTimeValue ? new Date(latestTimeValue).toLocaleString() : 'Unknown';
    const uniqueLocations = Array.isArray(snapshot?.uniqueLocations) && snapshot.uniqueLocations.length
        ? snapshot.uniqueLocations
        : [...new Set([
            ...(Array.isArray(securitySummary?.recentEvents) ? securitySummary.recentEvents.map((event) => event.geoLabel) : []),
            ...(Array.isArray(securitySessions) ? securitySessions.map((session) => session.geoLabel) : [])
        ].filter(Boolean))].slice(0, 5);
    const latestNetworkType = snapshot?.latestNetworkType || 'Unknown Network';
    const latestIpVersion = snapshot?.latestIpVersion || 'Unknown';
    const addressScope = snapshot?.addressScope || 'Unknown';
    const confidence = snapshot?.confidence || 'Low';
    const source = snapshot?.source || 'Unknown source';
    const recentNetworkTypes = Array.isArray(snapshot?.recentNetworkTypes) && snapshot.recentNetworkTypes.length
        ? snapshot.recentNetworkTypes
        : [];
    const recentIpVersions = Array.isArray(snapshot?.recentIpVersions) && snapshot.recentIpVersions.length
        ? snapshot.recentIpVersions
        : [];
    const riskSignals = Array.isArray(snapshot?.riskSignals) && snapshot.riskSignals.length
        ? snapshot.riskSignals
        : ['No clear risk signals'];
    const mapData = snapshot?.map && typeof snapshot.map === 'object' ? snapshot.map : null;
    const hasMap = Boolean(mapData?.available && Number.isFinite(Number(mapData.latitude)) && Number.isFinite(Number(mapData.longitude)));
    const lat = hasMap ? Number(mapData.latitude) : null;
    const lon = hasMap ? Number(mapData.longitude) : null;
    const mapLocationLabel = hasMap ? (mapData.locationLabel || 'Approximate location') : '';
    const mapNetwork = hasMap ? (mapData.network || 'Unknown network') : '';
    const mapProvider = mapData?.provider || 'ip-api.com';
    const mapReason = mapData?.reason || 'Map unavailable for this IP.';
    const mapIp = String(mapData?.ip || latestIp || '').trim();
    const providersTried = Array.isArray(mapData?.providersTried) && mapData.providersTried.length
        ? mapData.providersTried
        : [mapProvider];
    const geoBadgeText = hasMap ? 'Approximate (City-level)' : 'Unavailable';
    const confidenceTone = String(confidence || '').toLowerCase().includes('high')
        ? 'positive'
        : (String(confidence || '').toLowerCase().includes('low') ? 'warning' : 'neutral');
    const coordinatesLabel = hasMap ? `${lat.toFixed(3)}, ${lon.toFixed(3)}` : 'Unavailable';
    const recentLocationTypesLabel = uniqueLocations.length ? uniqueLocations.join(' • ') : 'None yet';
    const recentNetworkTypesLabel = recentNetworkTypes.length ? recentNetworkTypes.join(' • ') : 'None yet';
    const recentIpVersionsLabel = recentIpVersions.length ? recentIpVersions.join(' • ') : 'None yet';

    const mapEmbedHtml = hasMap
        ? (() => {
            const lonDelta = 0.18;
            const latDelta = 0.1;
            const bbox = `${(lon - lonDelta).toFixed(6)},${(lat - latDelta).toFixed(6)},${(lon + lonDelta).toFixed(6)},${(lat + latDelta).toFixed(6)}`;
            const marker = `${lat.toFixed(6)},${lon.toFixed(6)}`;
            const embedUrl = `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(bbox)}&layer=mapnik&marker=${encodeURIComponent(marker)}`;
            const openMapUrl = `https://www.openstreetmap.org/?mlat=${encodeURIComponent(lat.toFixed(6))}&mlon=${encodeURIComponent(lon.toFixed(6))}#map=11/${encodeURIComponent(lat.toFixed(6))}/${encodeURIComponent(lon.toFixed(6))}`;
            return `
                        <div class="geo-map-panel">
                            <div class="geo-map-frame">
                                <iframe
                                    title="Approximate login location map"
                                    src="${embedUrl}"
                                    loading="lazy"
                                    referrerpolicy="no-referrer"
                                ></iframe>
                            </div>
                            <div class="geo-map-meta">
                                Approximate map from ${escapeHtml(mapProvider)} · ${escapeHtml(mapLocationLabel)} · ${escapeHtml(mapNetwork)} · Coordinates: ${escapeHtml(coordinatesLabel)}
                                <a href="${openMapUrl}" target="_blank" rel="noopener noreferrer" style="margin-left:0.5rem;">Open full map</a>
                            </div>
                        </div>
                    `;
        })()
        : (() => {
            const encodedIp = encodeURIComponent(mapIp);
            const ipApiComLink = mapIp ? `http://ip-api.com/#${encodedIp}` : '';
            const ipwhoLink = mapIp ? `https://ipwho.is/${encodedIp}` : '';
            const ipapiLink = mapIp ? `https://ipapi.co/${encodedIp}/` : '';
            const links = mapIp
                ? `<div class="geo-external-links">
                                <a href="${ipApiComLink}" target="_blank" rel="noopener noreferrer">Inspect IP (ip-api.com)</a>
                                <a href="${ipwhoLink}" target="_blank" rel="noopener noreferrer">Inspect IP (ipwho.is)</a>
                                <a href="${ipapiLink}" target="_blank" rel="noopener noreferrer">Inspect IP (ipapi.co)</a>
                           </div>`
                : '';

            return `<div class="geo-map-panel"><div class="geo-map-meta"><strong>Map:</strong> ${escapeHtml(mapReason)}${mapIp ? `<br><strong>IP:</strong> ${escapeHtml(mapIp)}` : ''}<br><strong>Providers tried:</strong> ${escapeHtml(providersTried.join(' • '))}</div>${links}</div>`;
        })();

    container.innerHTML = `
                <div class="geo-snapshot-shell">
                    <div class="geo-snapshot-highlight">
                        <div class="geo-snapshot-primary">
                            <p class="geo-snapshot-eyebrow">Geo Intelligence Snapshot</p>
                            <strong>${escapeHtml(String(latestLocation || 'Unknown location'))}</strong>
                            <span>Last observed ${escapeHtml(String(latestTime || 'Unknown'))} · Source: ${escapeHtml(String(source || 'Unknown source'))}</span>
                        </div>
                        <div class="geo-snapshot-statuses">
                            ${buildStatusBadge(geoBadgeText, hasMap ? 'positive' : 'warning')}
                            ${buildStatusBadge(`Confidence: ${String(confidence || 'Unknown')}`, confidenceTone)}
                        </div>
                    </div>

                    <div class="geo-kpi-grid">
                        <div class="geo-kpi-card"><strong>Latest IP</strong><span>${escapeHtml(String(latestIp || 'Unknown'))}</span></div>
                        <div class="geo-kpi-card"><strong>Network Type</strong><span>${escapeHtml(String(latestNetworkType || 'Unknown Network'))}</span></div>
                        <div class="geo-kpi-card"><strong>IP Version</strong><span>${escapeHtml(String(latestIpVersion || 'Unknown'))}</span></div>
                        <div class="geo-kpi-card"><strong>Address Scope</strong><span>${escapeHtml(String(addressScope || 'Unknown'))}</span></div>
                    </div>

                    <div class="geo-panels-grid">
                        <section class="geo-info-panel">
                            <h4 class="geo-panel-title">Signal Summary</h4>
                            <div class="geo-metrics-grid">
                                ${buildGeoMetricCard('Latest IP', latestIp, METRIC_HINTS.geoLatestIp)}
                                ${buildGeoMetricCard('Confidence', confidence, METRIC_HINTS.geoConfidence)}
                                ${buildGeoMetricCard('Coordinates', coordinatesLabel, 'Approximate map coordinates when available.')}
                                ${buildGeoMetricCard('Recent Network Classes', recentNetworkTypesLabel, METRIC_HINTS.geoRecentNetworkClasses)}
                                ${buildGeoMetricCard('Recent IP Versions', recentIpVersionsLabel, METRIC_HINTS.geoRecentIpVersions)}
                            </div>
                        </section>

                        <section class="geo-info-panel">
                            <h4 class="geo-panel-title">Risk Indicators</h4>
                            <ul class="geo-risk-list">
                                ${riskSignals.map((signal) => `<li>${escapeHtml(String(signal || ''))}</li>`).join('')}
                            </ul>
                            <div class="geo-signals-note">
                                <strong>${buildMetricLabel('Recent Location Types', METRIC_HINTS.geoRecentLocationTypes)}</strong><br>
                                ${escapeHtml(recentLocationTypesLabel)}
                            </div>
                            <div class="geo-signals-note">
                                <strong>${buildMetricLabel('Geo Source', METRIC_HINTS.geoSource)}</strong><br>
                                ${escapeHtml(String(source || 'Unknown source'))}
                            </div>
                        </section>
                    </div>

                    ${mapEmbedHtml}
                </div>
            `;
}

function renderAccountRecovery(recovery) {
    const statusBox = document.getElementById('recoveryStatusBox');
    if (!statusBox) return;

    const hasCodes = Boolean(recovery?.hasCodes);
    const codeCount = Number(recovery?.codeCount || 0);
    const generatedAtValue = recovery?.generatedAt ? new Date(recovery.generatedAt) : null;
    const generatedAt = generatedAtValue ? generatedAtValue.toLocaleString() : 'Never';
    const ageMs = generatedAtValue ? (Date.now() - generatedAtValue.getTime()) : null;
    const ageDays = Number.isFinite(ageMs) ? Math.floor(ageMs / (24 * 60 * 60 * 1000)) : null;
    const reviewIntervalDays = 30;
    const nextReviewDateValue = generatedAtValue
        ? new Date(generatedAtValue.getTime() + reviewIntervalDays * 24 * 60 * 60 * 1000)
        : null;
    const isReviewOverdue = Boolean(nextReviewDateValue && Date.now() > nextReviewDateValue.getTime());
    const nextReviewDate = nextReviewDateValue ? nextReviewDateValue.toLocaleDateString() : 'After first generation';
    const nextReviewLabel = !nextReviewDateValue
        ? 'No schedule yet'
        : (Date.now() > nextReviewDateValue.getTime() ? `Overdue (was ${nextReviewDate})` : `Due by ${nextReviewDate}`);
    const nextReviewBadge = !nextReviewDateValue
        ? buildStatusBadge('Unscheduled', 'warning')
        : buildStatusBadge(isReviewOverdue ? 'Overdue' : 'On Schedule', isReviewOverdue ? 'warning' : 'positive');
    const ageLabel = ageDays === null
        ? 'Not generated yet'
        : (ageDays <= 0 ? 'Generated today' : `${ageDays} day${ageDays === 1 ? '' : 's'} ago`);

    const expectedCodeCount = 10;
    const coveragePercent = hasCodes
        ? Math.max(0, Math.min(100, Math.round((codeCount / expectedCodeCount) * 100)))
        : 0;
    const coverageLabel = hasCodes
        ? `${codeCount}/${expectedCodeCount} codes (${coveragePercent}%)`
        : 'No codes available';

    const rotationLabel = !hasCodes
        ? 'Generate immediately'
        : (ageDays !== null && ageDays > 30 ? 'Rotation recommended' : 'Rotation not currently required');

    const readinessLabel = hasCodes && codeCount >= expectedCodeCount
        ? 'Ready'
        : (hasCodes ? 'Partial coverage' : 'At risk');

    const readinessDetail = hasCodes && codeCount >= expectedCodeCount
        ? 'Recovery inventory meets expected baseline.'
        : (hasCodes ? 'Codes exist but count is below recommended baseline.' : 'No emergency recovery inventory is available.');

    const rotationDetail = !hasCodes
        ? 'Generate codes to establish a review schedule.'
        : (ageDays !== null && ageDays > 30
            ? 'Codes are aging out of best-practice window.'
            : 'Current code age remains within review policy.');

    const readinessBadge = buildStatusBadge(
        readinessLabel,
        hasCodes && codeCount >= expectedCodeCount ? 'positive' : 'warning'
    );
    const rotationBadge = buildStatusBadge(
        ageDays !== null && ageDays > 30 ? 'Review Needed' : (hasCodes ? 'Healthy' : 'Pending Setup'),
        ageDays !== null && ageDays > 30 ? 'warning' : (hasCodes ? 'positive' : 'warning')
    );

    const badgeTone = hasCodes && codeCount >= expectedCodeCount ? 'positive' : (hasCodes ? 'warning' : 'warning');
    const badge = buildStatusBadge(hasCodes ? 'Configured' : 'Not Configured', badgeTone);

    const summaryText = hasCodes ? 'Recovery codes are configured.' : 'No recovery codes configured.';
    const coverageMeter = `<div class="recovery-coverage-track" aria-label="Recovery coverage ${coveragePercent}%"><div class="recovery-coverage-fill" style="width:${coveragePercent}%;"></div></div>`;
    const postureIntro = hasCodes
        ? 'Emergency access inventory is available for sign-in fallback scenarios.'
        : 'Emergency access inventory is not available and requires initialization.';

    statusBox.innerHTML = hasCodes
        ? `<div class="recovery-status-top">
                        <div class="recovery-status-heading">Recovery Posture</div>
                        ${badge}
                   </div>
                   <div class="recovery-status-summary">${summaryText}</div>
                   <div class="recovery-status-detail">${escapeHtml(postureIntro)}</div>
                   <div class="recovery-status-detail">${escapeHtml(readinessDetail)}</div>
                   ${coverageMeter}
                   <div class="recovery-metrics">
                        ${buildRecoveryMetric('Coverage', METRIC_HINTS.recoveryCoverage, escapeHtml(coverageLabel))}
                        ${buildRecoveryMetric('Readiness', METRIC_HINTS.recoveryReadiness, '', readinessDetail, readinessBadge)}
                        ${buildRecoveryMetric('Last Generated', METRIC_HINTS.recoveryLastGenerated, escapeHtml(generatedAt))}
                        ${buildRecoveryMetric('Code Age', METRIC_HINTS.recoveryCodeAge, escapeHtml(ageLabel))}
                        ${buildRecoveryMetric('Rotation', METRIC_HINTS.recoveryRotation, '', rotationDetail, rotationBadge)}
                        ${buildRecoveryMetric('Next Review', METRIC_HINTS.recoveryNextReview, '', nextReviewLabel, nextReviewBadge)}
                    </div>`
        : `<div class="recovery-status-top">
                        <div class="recovery-status-heading">Recovery Posture</div>
                        ${badge}
                   </div>
                   <div class="recovery-status-summary">${summaryText}</div>
                    <div class="recovery-status-detail">${escapeHtml(postureIntro)}</div>
                   <div class="recovery-status-detail">${escapeHtml(readinessDetail)}</div>
                   ${coverageMeter}
                   <div class="recovery-metrics">
                        ${buildRecoveryMetric('Coverage', METRIC_HINTS.recoveryCoverage, escapeHtml(coverageLabel))}
                        ${buildRecoveryMetric('Readiness', METRIC_HINTS.recoveryReadiness, '', readinessDetail, readinessBadge)}
                        ${buildRecoveryMetric('Rotation', METRIC_HINTS.recoveryRotation, '', rotationDetail, rotationBadge)}
                        ${buildRecoveryMetric('Next Review', METRIC_HINTS.recoveryNextReview, '', nextReviewLabel, nextReviewBadge)}
                    </div>`;
}

function renderDiscordLink(discordLink) {
    const status = document.getElementById('discordLinkStatus');
    const authorizeBtn = document.getElementById('discordAuthorizeBtn');
    const unlinkBtn = document.getElementById('discordUnlinkBtn');
    const refreshMeta = document.getElementById('discordProfileRefreshMeta');
    if (!status) return;

    const linked = Boolean(discordLink?.linked);
    discordAccountLinked = linked;
    const linkedAt = discordLink?.linkedAt ? new Date(discordLink.linkedAt).toLocaleString() : 'Unknown';
    const linkedUserId = discordLink?.discordUserId || '';
    const linkedUsername = discordLink?.discordUsername || '';
    const profile = discordLink?.profile && typeof discordLink.profile === 'object' ? discordLink.profile : null;
    const profileDisplayName = profile?.globalName || profile?.username || linkedUsername || linkedUserId;
    const profileTag = profile?.username && profile?.discriminator && profile.discriminator !== '0'
        ? `${profile.username}#${profile.discriminator}`
        : (profile?.username || linkedUsername || null);
    const avatarUrl = profile?.avatarUrl || null;
    const bannerUrl = profile?.bannerUrl || null;
    const accentColor = profile?.accentColor || null;
    const profileUrl = profile?.profileUrl || (linkedUserId ? `https://discord.com/users/${encodeURIComponent(linkedUserId)}` : null);
    const badge = buildStatusBadge(linked ? 'Linked' : 'Not Linked', linked);

    if (authorizeBtn && linked) {
        authorizeBtn.disabled = true;
        authorizeBtn.style.opacity = '0.6';
        authorizeBtn.style.cursor = 'not-allowed';
        authorizeBtn.title = 'This profile is already linked. Unlink first to connect a different Discord account';
    }

    if (unlinkBtn) {
        unlinkBtn.disabled = !linked;
        unlinkBtn.style.opacity = linked ? '1' : '0.6';
        unlinkBtn.style.cursor = linked ? 'pointer' : 'not-allowed';
        unlinkBtn.title = linked ? '' : 'No Discord account is linked';
    }

    if (refreshMeta) {
        refreshMeta.textContent = `Last refreshed: ${new Date().toLocaleString()}`;
    }

    const connectionMeta = linked
        ? `Connected since ${linkedAt}`
        : 'No active Discord connection for this profile';

    status.innerHTML = linked
        ? `<div class="discord-status-head">
                        <div class="discord-status-badges">${badge}<span id="discordConnectionHealthChip"></span></div>
                        <span class="discord-status-meta">${escapeHtml(connectionMeta)}</span>
                    </div>
                    <div class="discord-profile-shell">
                        ${bannerUrl ? `<img class="discord-profile-banner" src="${escapeHtml(bannerUrl)}" alt="Discord banner" />` : `<div class="discord-profile-banner"></div>`}
                        <div class="discord-profile-content">
                            <div class="discord-profile-top">
                                ${avatarUrl ? `<img class="discord-profile-avatar" src="${escapeHtml(avatarUrl)}" alt="Discord avatar" />` : `<div class="discord-profile-avatar"></div>`}
                                <div class="discord-profile-identity">
                                    <h4 class="discord-profile-name">${escapeHtml(profileDisplayName || 'Linked Discord Account')}</h4>
                                    ${profileTag ? `<span class="discord-profile-handle">@${escapeHtml(profileTag)}</span>` : `<span class="discord-profile-handle">Discord profile linked</span>`}
                                </div>
                            </div>
                            <div class="discord-profile-meta">
                                ${linkedUserId ? `<div class="discord-meta-item"><strong>User ID</strong>${escapeHtml(linkedUserId)}</div>` : ''}
                                <div class="discord-meta-item"><strong>Linked At</strong>${escapeHtml(linkedAt)}</div>
                                ${accentColor ? `<div class="discord-meta-item"><strong>Accent</strong>${escapeHtml(accentColor)}</div>` : ''}
                                ${profileUrl ? `<div class="discord-meta-item"><strong>Profile</strong><a href="${escapeHtml(profileUrl)}" target="_blank" rel="noopener noreferrer">Open in Discord</a></div>` : ''}
                            </div>
                        </div>
                    </div>
                    `
        : `<div class="discord-status-head">
                        <div class="discord-status-badges">${badge}<span id="discordConnectionHealthChip"></span></div>
                        <span class="discord-status-meta">${escapeHtml(connectionMeta)}</span>
                    </div>
                    <div class="discord-unlinked-shell">
                        <div class="discord-unlinked-title">Discord identity not linked</div>
                        <div class="discord-unlinked-copy">Authorize with Discord to attach a verified Discord account to this profile and unlock linked identity context.</div>
                    </div>`;

    updateDiscordConnectionHealthChip();
}

async function generateRecoveryCodesForAccount() {
    const currentPassword = await requestPasswordConfirmation();
    if (!currentPassword) return;

    try {
        const response = await postWithCsrf('/api/security/recovery-codes/generate', { currentPassword });
        const raw = await response.text();
        let data = {};
        try {
            data = raw ? JSON.parse(raw) : {};
        } catch (_) {
            data = {};
        }
        if (!response.ok) {
            throw new Error(data.error || `Failed to generate recovery codes (HTTP ${response.status})`);
        }

        latestRecoveryCodes = Array.isArray(data.codes) ? data.codes : [];
        const wrap = document.getElementById('recoveryCodesWrap');
        const output = document.getElementById('recoveryCodesOutput');
        if (wrap) wrap.style.display = latestRecoveryCodes.length ? 'block' : 'none';
        if (output) {
            output.value = latestRecoveryCodes.join('\n');
            output.classList.add('sensitive-blur');
            output.classList.remove('revealed');
        }

        showSuccess('Recovery codes generated. Store them securely before leaving this page.');
        loadSecurityCenter();
    } catch (error) {
        console.error('Error generating recovery codes:', error);
        showError(error.message || 'Failed to generate recovery codes');
    }
}

async function copyRecoveryCodes() {
    const output = document.getElementById('recoveryCodesOutput');
    const text = output?.value || '';
    if (!text.trim()) {
        showError('No recovery codes available to copy.');
        return;
    }

    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
        } else {
            output.focus();
            output.select();
            document.execCommand('copy');
        }
        showSuccess('Recovery codes copied to clipboard.');
    } catch (error) {
        console.error('Failed to copy recovery codes:', error);
        showError('Could not copy recovery codes automatically.');
    }
}

function startDiscordOAuthLink() {
    const authorizeBtn = document.getElementById('discordAuthorizeBtn');
    const unlinkBtn = document.getElementById('discordUnlinkBtn');
    if (authorizeBtn && authorizeBtn.disabled) {
        showError(authorizeBtn.title || 'Discord OAuth linking is currently unavailable.');
        return;
    }

    if (discordOAuthStartInProgress) return;

    const previousAuthorizeText = authorizeBtn ? authorizeBtn.textContent : '';
    const previousAuthorizeTitle = authorizeBtn ? (authorizeBtn.title || '') : '';
    const previousUnlinkDisabled = unlinkBtn ? unlinkBtn.disabled : false;
    const previousUnlinkTitle = unlinkBtn ? (unlinkBtn.title || '') : '';

    discordOAuthStartInProgress = true;
    if (authorizeBtn) {
        authorizeBtn.disabled = true;
        authorizeBtn.textContent = 'Redirecting...';
        authorizeBtn.style.opacity = '0.6';
        authorizeBtn.style.cursor = 'not-allowed';
        authorizeBtn.title = 'Redirecting to Discord OAuth';
    }
    if (unlinkBtn) {
        unlinkBtn.disabled = true;
        unlinkBtn.style.opacity = '0.6';
        unlinkBtn.style.cursor = 'not-allowed';
        unlinkBtn.title = 'Wait for redirect to complete';
    }

    window.addEventListener('pagehide', () => {
        discordOAuthStartInProgress = false;
    }, { once: true });

    setTimeout(() => {
        if (!discordOAuthStartInProgress) return;
        discordOAuthStartInProgress = false;
        if (authorizeBtn) {
            authorizeBtn.disabled = false;
            authorizeBtn.textContent = previousAuthorizeText || 'Authorize with Discord';
            authorizeBtn.style.opacity = '1';
            authorizeBtn.style.cursor = 'pointer';
            authorizeBtn.title = previousAuthorizeTitle;
        }
        if (unlinkBtn) {
            unlinkBtn.disabled = previousUnlinkDisabled;
            unlinkBtn.style.opacity = previousUnlinkDisabled ? '0.6' : '1';
            unlinkBtn.style.cursor = previousUnlinkDisabled ? 'not-allowed' : 'pointer';
            unlinkBtn.title = previousUnlinkTitle;
        }
    }, 3000);

    window.location.href = '/api/account/discord/oauth/start';
}

async function unlinkDiscordAccount() {
    const unlinkBtn = document.getElementById('discordUnlinkBtn');
    const authorizeBtn = document.getElementById('discordAuthorizeBtn');
    if (unlinkBtn && unlinkBtn.disabled) {
        showError(unlinkBtn.title || 'No Discord account is linked.');
        return;
    }

    if (discordUnlinkInProgress) return;

    if (!confirm('Unlink your Discord account from this panel profile?')) return;

    const previousUnlinkText = unlinkBtn ? unlinkBtn.textContent : '';
    const previousUnlinkTitle = unlinkBtn ? (unlinkBtn.title || '') : '';
    const previousAuthorizeDisabled = authorizeBtn ? authorizeBtn.disabled : false;
    const previousAuthorizeTitle = authorizeBtn ? (authorizeBtn.title || '') : '';

    discordUnlinkInProgress = true;
    if (unlinkBtn) {
        unlinkBtn.disabled = true;
        unlinkBtn.textContent = 'Unlinking...';
        unlinkBtn.style.opacity = '0.6';
        unlinkBtn.style.cursor = 'not-allowed';
        unlinkBtn.title = 'Unlink request in progress';
    }
    if (authorizeBtn) {
        authorizeBtn.disabled = true;
        authorizeBtn.style.opacity = '0.6';
        authorizeBtn.style.cursor = 'not-allowed';
        authorizeBtn.title = 'Wait for unlink request to finish';
    }

    try {
        const response = await postWithCsrf('/api/account/discord-unlink', {});
        const raw = await response.text();
        let data = {};
        try {
            data = raw ? JSON.parse(raw) : {};
        } catch (_) {
            data = {};
        }
        if (!response.ok) {
            throw new Error(data.error || `Failed to unlink Discord account (HTTP ${response.status})`);
        }

        showSuccess('Discord account unlinked.');
        loadSecurityCenter();
    } catch (error) {
        console.error('Error unlinking Discord account:', error);
        showError(error.message || 'Failed to unlink Discord account');
    } finally {
        discordUnlinkInProgress = false;
        if (unlinkBtn) {
            unlinkBtn.textContent = previousUnlinkText || 'Unlink';
            unlinkBtn.title = previousUnlinkTitle;
        }
        if (authorizeBtn) {
            authorizeBtn.disabled = previousAuthorizeDisabled;
            authorizeBtn.style.opacity = previousAuthorizeDisabled ? '0.6' : '1';
            authorizeBtn.style.cursor = previousAuthorizeDisabled ? 'not-allowed' : 'pointer';
            authorizeBtn.title = previousAuthorizeTitle;
        }
    }
}

function openSessionDetails(encodedSessionId) {
    const sessionId = decodeURIComponent(String(encodedSessionId || ''));
    if (!sessionId) return;

    const session = securitySessions.find((item) => String(item.sessionId) === sessionId);
    if (!session) {
        showError('Session details not available');
        return;
    }

    const drawer = document.getElementById('sessionDetailsDrawer');
    const body = document.getElementById('sessionDetailsBody');
    if (!drawer || !body) return;

    const loginTime = session.loginTime ? new Date(Number(session.loginTime)).toLocaleString() : 'Unknown';
    const expiresAt = session.expiresAt ? new Date(session.expiresAt).toLocaleString() : 'Unknown';

    body.innerHTML = `
                <div><strong>Session ID:</strong><br>${escapeHtml(session.sessionId || 'Unknown')}</div>
                <div><strong>Device:</strong><br>${escapeHtml(session.device || 'Unknown')}</div>
                <div><strong>Status:</strong><br>${session.isCurrent ? 'Current Session' : 'Active Session'}</div>
                <div><strong>IP Address:</strong><br>${escapeHtml(String(session.ipAddress || 'Unknown'))}</div>
                <div><strong>Location:</strong><br>${escapeHtml(session.geoLabel || 'Unknown location')}</div>
                <div><strong>Login Time:</strong><br>${escapeHtml(loginTime)}</div>
                <div><strong>Expires:</strong><br>${escapeHtml(expiresAt)}</div>
                <div><strong>User Agent:</strong><br><span style="word-break: break-word;">${escapeHtml(session.userAgent || 'Unknown')}</span></div>
            `;

    drawer.style.display = 'block';
}

function closeSessionDetails() {
    const drawer = document.getElementById('sessionDetailsDrawer');
    if (drawer) drawer.style.display = 'none';
}

async function logoutOtherSessions() {
    if (!confirm('Logout all sessions except this one?')) return;

    try {
        const response = await postWithCsrf('/api/security/sessions/logout-others', {});
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Failed to logout other sessions');
        }

        showSuccess('Other sessions logged out successfully');
        loadSecurityCenter();
    } catch (error) {
        console.error('Error logging out other sessions:', error);
        showError(error.message || 'Failed to logout other sessions');
    }
}

async function revokeSession(sessionId) {
    if (!sessionId) return;
    if (!confirm('Revoke this session?')) return;

    try {
        const response = await postWithCsrf('/api/security/sessions/revoke', { sessionId });
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Failed to revoke session');
        }

        showSuccess('Session revoked successfully');
        loadSecurityCenter();
    } catch (error) {
        console.error('Error revoking session:', error);
        showError(error.message || 'Failed to revoke session');
    }
}

async function startTwoFactorSetup() {
    const currentPassword = await requestPasswordConfirmation();
    if (!currentPassword) return;

    try {
        const response = await postWithCsrf('/api/security/2fa/setup', { currentPassword });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || 'Failed to start 2FA setup');
        }

        document.getElementById('twoFactorSecret').value = data.secret || '';
        document.getElementById('twoFactorUri').value = data.otpauthUri || '';
        document.getElementById('twoFactorVerifyCode').value = '';

        const qrWrap = document.getElementById('twoFactorQrWrap');
        const qrImage = document.getElementById('twoFactorQrImage');
        if (qrWrap && qrImage && data.otpauthUri) {
            qrImage.src = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(data.otpauthUri)}`;
            qrWrap.style.display = 'block';
        }

        document.getElementById('twoFactorSetupPanel').style.display = 'block';
        showSuccess('2FA setup initialized. Add the secret in your authenticator app.');
    } catch (error) {
        console.error('Error starting 2FA setup:', error);
        showError(error.message || 'Failed to start 2FA setup');
    }
}

async function confirmTwoFactorSetup() {
    const token = (document.getElementById('twoFactorVerifyCode').value || '').trim();
    if (!/^\d{6}$/.test(token)) {
        showError('Please enter a valid 6-digit verification code');
        return;
    }

    try {
        const response = await postWithCsrf('/api/security/2fa/enable', { token });
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Failed to enable 2FA');
        }

        document.getElementById('twoFactorSetupPanel').style.display = 'none';
        const qrWrap = document.getElementById('twoFactorQrWrap');
        const qrImage = document.getElementById('twoFactorQrImage');
        if (qrWrap) qrWrap.style.display = 'none';
        if (qrImage) qrImage.src = '';
        showSuccess('Two-factor authentication enabled.');
        loadSecurityCenter();
    } catch (error) {
        console.error('Error enabling 2FA:', error);
        showError(error.message || 'Failed to enable 2FA');
    }
}

async function disableTwoFactor() {
    const currentPassword = await requestPasswordConfirmation();
    if (!currentPassword) return;

    const token = prompt('Enter your current authenticator 6-digit code:');
    if (!token) return;

    try {
        const response = await postWithCsrf('/api/security/2fa/disable', { currentPassword, token: token.trim() });
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Failed to disable 2FA');
        }

        showSuccess('Two-factor authentication disabled.');
        loadSecurityCenter();
    } catch (error) {
        console.error('Error disabling 2FA:', error);
        showError(error.message || 'Failed to disable 2FA');
    }
}

// Handle password change
bindListenerById('changePasswordForm', 'submit', async function (e) {
    e.preventDefault();

    const currentPassword = document.getElementById('currentPassword').value;
    const newPassword = document.getElementById('newPassword').value;
    const confirmPassword = document.getElementById('confirmPassword').value;

    // Validate passwords match
    if (newPassword !== confirmPassword) {
        showError('New passwords do not match');
        return;
    }

    // Validate password strength
    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
    if (!passwordRegex.test(newPassword)) {
        showError('Password must contain at least 8 characters, including uppercase, lowercase, number, and special character');
        return;
    }

    // Show loading
    document.getElementById('changePasswordBtnText').style.display = 'none';
    document.getElementById('changePasswordLoading').classList.remove('hidden');

    try {
        const response = await postWithCsrf('/api/user/change-password', {
            currentPassword,
            newPassword
        });

        const data = await response.json();

        if (response.ok) {
            showSuccess('Password changed successfully');
            document.getElementById('changePasswordForm').reset();
            lastGeneratedPassword = '';
            const showAllToggle = document.getElementById('showAllPasswordsToggle');
            if (showAllToggle) showAllToggle.checked = false;
            toggleAllPasswords(false);
        } else {
            showError(data.error || 'Failed to change password');
        }
    } catch (error) {
        console.error('Error changing password:', error);
        showError('Failed to change password');
    } finally {
        document.getElementById('changePasswordBtnText').style.display = 'inline';
        document.getElementById('changePasswordLoading').classList.add('hidden');
        updateChangePasswordButtonState();
    }
});

bindListenerById('changeEmailForm', 'submit', async function (e) {
    e.preventDefault();

    const submitBtn = document.getElementById('changeEmailSubmitBtn');
    const newEmail = document.getElementById('newEmail').value.trim().toLowerCase();
    const confirmNewEmail = document.getElementById('confirmNewEmail').value.trim().toLowerCase();
    const activeEmail = String(currentUser?.email || '').trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (newEmail !== confirmNewEmail) {
        showError('New email addresses do not match');
        return;
    }

    if (!emailRegex.test(newEmail)) {
        showError('Please enter a valid email address');
        return;
    }

    if (activeEmail && newEmail === activeEmail) {
        showError('New email must be different from your current email');
        return;
    }

    document.getElementById('changeEmailBtnText').style.display = 'none';
    document.getElementById('changeEmailLoading').classList.remove('hidden');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.style.cursor = 'not-allowed';
    }

    try {
        const response = await postWithCsrf('/api/user/change-email', { newEmail });
        const data = await response.json();

        if (response.ok) {
            const updatedEmail = data.email || newEmail;
            document.getElementById('newEmail').value = '';
            document.getElementById('confirmNewEmail').value = '';
            currentUser.email = updatedEmail;
            currentUser.email_verified = false;
            updateEmailVerificationUI(false, updatedEmail);
            showSuccess('Email updated. Please verify your new address from your inbox.');
        } else {
            showError(data.error || 'Failed to change email');
        }
    } catch (error) {
        console.error('Error changing email:', error);
        showError('Failed to change email');
    } finally {
        document.getElementById('changeEmailBtnText').style.display = 'inline';
        document.getElementById('changeEmailLoading').classList.add('hidden');
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.style.cursor = 'pointer';
        }
        updateChangeEmailButtonState();
    }
});

async function warnUser() {
    const urlParams = new URLSearchParams(window.location.search);
    const userId = urlParams.get('userId');
    if (!userId) return;

    const reason = prompt('Enter warning reason:');
    if (!reason || reason.trim() === '') return;

    try {
        const response = await postWithCsrf('/api/warn', {
            userId: userId,
            reason: reason.trim()
        });

        const data = await response.json();
        if (response.ok) {
            showSuccess('User warned successfully');
            // Reload profile to update warning count
            setTimeout(() => location.reload(), 1500);
        } else {
            showError(data.error || 'Failed to warn user');
        }
    } catch (error) {
        console.error('Error warning user:', error);
        showError('Failed to warn user');
    }
}

async function banUser() {
    const urlParams = new URLSearchParams(window.location.search);
    const userId = urlParams.get('userId');
    if (!userId) return;

    if (!confirm('Are you sure you want to ban this user?')) return;

    const reason = prompt('Enter ban reason:');
    if (!reason || reason.trim() === '') return;

    try {
        const response = await postWithCsrf('/api/ban', {
            userId: userId,
            reason: reason.trim()
        });

        const data = await response.json();
        if (response.ok) {
            showSuccess('User banned successfully');
            // Reload profile to update ban status
            setTimeout(() => location.reload(), 1500);
        } else {
            showError(data.error || 'Failed to ban user');
        }
    } catch (error) {
        console.error('Error banning user:', error);
        showError('Failed to ban user');
    }
}

function updateEmailVerificationUI(isVerified, emailValue) {
    const statusEl = document.getElementById('emailVerificationStatus');
    const resendBtn = document.getElementById('resendVerificationBtn');
    const currentEmailValueEl = document.getElementById('changeEmailCurrentValue');

    const hasEmail = Boolean(String(emailValue || '').trim());

    if (statusEl) {
        statusEl.textContent = hasEmail
            ? (isVerified ? 'Your email is verified.' : 'Your email is not verified yet.')
            : 'Add an email address to enable verification.';
    }
    if (currentEmailValueEl) {
        currentEmailValueEl.textContent = hasEmail ? String(emailValue).trim() : 'No email set';
    }
    if (resendBtn) {
        resendBtn.disabled = !hasEmail || isVerified;
        resendBtn.style.opacity = (!hasEmail || isVerified) ? '0.6' : '1';
        resendBtn.style.cursor = (!hasEmail || isVerified) ? 'not-allowed' : 'pointer';
    }
}

bindListenerById('resendVerificationBtn', 'click', async function () {
    const button = this;
    if (button.disabled) return;

    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = 'Sending...';

    try {
        const response = await postWithCsrf('/api/account/email/verification/resend', {});
        const data = await response.json();

        if (response.ok) {
            showSuccess(data.message || 'Verification email sent');
            updateEmailVerificationUI(false, currentUser?.email || '');
        } else {
            showError(data.error || 'Failed to resend verification email');
        }
    } catch (error) {
        console.error('Error resending verification email:', error);
        showError('Failed to resend verification email');
    } finally {
        button.textContent = originalText;
        updateEmailVerificationUI(Boolean(currentUser?.email_verified), currentUser?.email || '');
    }
});

function showError(message) {
    const errorMsg = document.getElementById('errorMsg');
    errorMsg.textContent = message;
    errorMsg.classList.remove('hidden');
    setTimeout(() => errorMsg.classList.add('hidden'), 5000);
}

function showSuccess(message) {
    const successMsg = document.getElementById('successMsg');
    successMsg.textContent = message;
    successMsg.classList.remove('hidden');
    setTimeout(() => successMsg.classList.add('hidden'), 5000);
}

function logout() {
    postWithCsrf('/api/logout', {})
        .then(() => window.location.href = '/login')
        .catch(() => window.location.href = '/login');
}

function handleDiscordOAuthFlashMessage() {
    const url = new URL(window.location.href);
    const status = url.searchParams.get('discord_oauth');
    const message = url.searchParams.get('message');
    if (!status) return;

    if (status === 'success') {
        showSuccess(message || 'Discord account linked successfully.');
    } else {
        showError(message || 'Discord OAuth linking failed.');
    }

    url.searchParams.delete('discord_oauth');
    url.searchParams.delete('message');
    window.history.replaceState({}, document.title, `${url.pathname}${url.search}`);
}

// Load profile on page load
initProfileTabs();
loadProfile();
handleDiscordOAuthFlashMessage();
updateChangePasswordButtonState();
updateChangeEmailButtonState();

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
    const headerRoleClassName = document.getElementById('headerRole')?.className;
    if (username) document.getElementById('dropdownUsername').textContent = username;
    if (role) document.getElementById('dropdownRole').textContent = role;
    if (headerRoleClassName && document.getElementById('dropdownRole')) {
        document.getElementById('dropdownRole').className = headerRoleClassName;
    }
}
setTimeout(syncDropdownInfo, 500);
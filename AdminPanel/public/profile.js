let currentUser = null;
let securitySessions = [];
let lastGeneratedPassword = '';
let securitySummary = null;
let securitySummaryLoadingPromise = null;
let latestRecoveryCodes = [];
let discordAccountLinked = false;
let discordSecurityEligible = false;
let discordSecurityReason = '';
let discordProtectedFeatures = [];
let discordUnlinkInProgress = false;
let discordOAuthStartInProgress = false;
let discordOAuthHealthState = 'checking';
let activeSecurityWorkspaceTab = 'center';
let activeProfileTab = 'security';
let securityEventControlsInitialized = false;
const DISCORD_LINK_BANNER_STORAGE_KEY = 'discord_link_banner_dismissed_v1';
const HIGH_RISK_ACTION_APPROVAL_STORAGE_KEY = 'sentinel_high_risk_action_approvals_v1';
let confirmModalResolver = null;
let pendingAvatarPreviewUrl = '';

function getCurrentAvatarUrl() {
    return String(currentUser?.avatar_url || currentUser?.avatarUrl || '').trim();
}

function revokePendingAvatarPreviewUrl() {
    if (!pendingAvatarPreviewUrl) return;
    URL.revokeObjectURL(pendingAvatarPreviewUrl);
    pendingAvatarPreviewUrl = '';
}

function getSelectedAvatarFile() {
    const input = document.getElementById('avatarFileInput');
    return input?.files?.[0] || null;
}

function validateAvatarFile(file) {
    if (!file) return { ok: false, message: 'Select an image to upload.' };

    const allowedTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
    if (!allowedTypes.has(file.type)) {
        return { ok: false, message: 'Only PNG, JPG, GIF, and WEBP images are supported.' };
    }

    if (file.size > 4 * 1024 * 1024) {
        return { ok: false, message: 'Avatar image must be 4MB or smaller.' };
    }

    return { ok: true, message: `Selected ${file.name}` };
}

async function postFormDataWithCsrf(url, formData, options = {}) {
    const method = String(options.method || 'POST').toUpperCase();

    const sendRequest = async (csrfToken) => {
        return fetch(url, {
            method,
            credentials: 'include',
            headers: {
                ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
                ...(options.headers || {})
            },
            body: formData
        });
    };

    let csrfToken = getCsrfTokenFromCookie();
    if (!csrfToken) {
        try {
            if (window.AdminPanel?.api?.getJson) {
                await window.AdminPanel.api.getJson('/api/csrf');
            } else {
                await fetch('/api/csrf', { credentials: 'include' });
            }
        } catch (error) {
            console.warn('Failed to prefetch CSRF token', error);
        }
        csrfToken = getCsrfTokenFromCookie();
    }

    let response = await sendRequest(csrfToken);
    if (response.status === 403 && !options._csrfRetried) {
        if (window.AdminPanel?.api?.getJson) {
            await window.AdminPanel.api.getJson('/api/csrf');
        } else {
            await fetch('/api/csrf', { credentials: 'include' });
        }
        csrfToken = getCsrfTokenFromCookie();
        response = await sendRequest(csrfToken);
    }

    return response;
}

function renderAvatarSurface(element, username, avatarUrl) {
    if (!element) return;
    const safeName = String(username || '').trim();
    const trimmedAvatarUrl = String(avatarUrl || '').trim();

    if (trimmedAvatarUrl) {
        element.innerHTML = '';
        const image = document.createElement('img');
        image.src = trimmedAvatarUrl;
        image.alt = safeName || 'Avatar';
        image.loading = 'lazy';
        image.referrerPolicy = 'no-referrer';
        image.addEventListener('error', () => {
            element.innerHTML = '';
            element.textContent = getProfileInitials(safeName);
        }, { once: true });
        element.appendChild(image);
        return;
    }

    element.innerHTML = '';
    element.textContent = getProfileInitials(safeName);
}

function syncAvatarEditorState() {
    const input = document.getElementById('avatarFileInput');
    const status = document.getElementById('avatarUploadStatus');
    const preview = document.getElementById('accountAvatarPreview');
    const resetBtn = document.getElementById('resetAvatarBtn');
    const submitBtn = document.getElementById('changeAvatarSubmitBtn');
    const uploadSurface = document.getElementById('avatarUploadSurface');
    const uploadTitle = document.getElementById('avatarUploadTitle');
    const uploadBadge = document.getElementById('avatarUploadFileBadge');
    const username = currentUser?.username || 'User';
    const selectedFile = getSelectedAvatarFile();
    const discordLocked = !discordSecurityEligible;
    const discordLockedReason = discordSecurityReason || 'Link Discord from the Discord tab to continue.';

    if (selectedFile) {
        revokePendingAvatarPreviewUrl();
        pendingAvatarPreviewUrl = URL.createObjectURL(selectedFile);
    } else {
        revokePendingAvatarPreviewUrl();
    }

    const effectiveAvatar = pendingAvatarPreviewUrl || getCurrentAvatarUrl();

    renderAvatarSurface(preview, username, effectiveAvatar);

    if (status) {
        if (discordLocked) {
            status.textContent = discordLockedReason;
            status.style.color = '#fca5a5';
        } else if (!selectedFile && !getCurrentAvatarUrl()) {
            status.textContent = 'No custom avatar set.';
            status.style.color = 'var(--text-muted)';
        } else if (!selectedFile && getCurrentAvatarUrl()) {
            status.textContent = 'Current custom avatar is active.';
            status.style.color = 'var(--text-muted)';
        } else {
            const validation = validateAvatarFile(selectedFile);
            status.textContent = validation.ok ? 'Preview ready. Save to upload your new avatar.' : validation.message;
            status.style.color = validation.ok ? '#86efac' : '#fca5a5';
        }
    }

    if (uploadSurface) {
        uploadSurface.classList.remove('is-selected', 'is-error');
        if (selectedFile) {
            const validation = validateAvatarFile(selectedFile);
            uploadSurface.classList.add(validation.ok ? 'is-selected' : 'is-error');
        }
    }

    if (uploadTitle) {
        if (selectedFile) {
            uploadTitle.textContent = selectedFile.name;
        } else if (getCurrentAvatarUrl()) {
            uploadTitle.textContent = 'Replace your current avatar';
        } else {
            uploadTitle.textContent = 'Choose an avatar image';
        }
    }

    if (uploadBadge) {
        if (selectedFile) {
            const validation = validateAvatarFile(selectedFile);
            const fileSizeMb = (selectedFile.size / (1024 * 1024)).toFixed(2);
            uploadBadge.innerHTML = validation.ok
                ? `<strong>Selected</strong> ${selectedFile.type.split('/')[1].toUpperCase()} • ${fileSizeMb} MB`
                : `<strong>Error</strong> ${validation.message}`;
        } else if (getCurrentAvatarUrl()) {
            uploadBadge.innerHTML = '<strong>Status</strong> Current avatar saved';
        } else {
            uploadBadge.innerHTML = '<strong>Status</strong> No file selected';
        }
    }

    if (resetBtn) {
        const canReset = Boolean(getCurrentAvatarUrl()) || Boolean(selectedFile);
        resetBtn.disabled = discordLocked || !canReset;
        resetBtn.style.opacity = (!discordLocked && canReset) ? '1' : '0.6';
        resetBtn.style.cursor = (!discordLocked && canReset) ? 'pointer' : 'not-allowed';
        resetBtn.title = discordLocked ? discordLockedReason : '';
        resetBtn.textContent = selectedFile ? 'Clear Selection' : 'Reset Avatar';
    }

    if (submitBtn) {
        const validation = validateAvatarFile(selectedFile);
        submitBtn.disabled = discordLocked || !validation.ok;
        submitBtn.style.cursor = (!discordLocked && validation.ok) ? 'pointer' : 'not-allowed';
        submitBtn.style.opacity = (!discordLocked && validation.ok) ? '1' : '0.7';
        submitBtn.title = discordLocked ? discordLockedReason : '';
    }
}

function setDiscordLinkBannerVisible(visible) {
    const banner = document.getElementById('discordLinkBanner');
    if (!banner) return;
    banner.style.display = visible ? 'flex' : 'none';
}

function getDiscordLinkBannerDismissed() {
    try {
        return localStorage.getItem(DISCORD_LINK_BANNER_STORAGE_KEY) === '1';
    } catch (_) {
        return false;
    }
}

function setDiscordLinkBannerDismissed(value) {
    try {
        if (value) {
            localStorage.setItem(DISCORD_LINK_BANNER_STORAGE_KEY, '1');
        } else {
            localStorage.removeItem(DISCORD_LINK_BANNER_STORAGE_KEY);
        }
    } catch (_) {
    }
}

function updateDiscordLinkBanner(linked) {
    const staticBanner = document.getElementById('discordStaticBanner');
    if (staticBanner) staticBanner.style.display = linked ? 'none' : 'flex';

    if (linked) {
        setDiscordLinkBannerDismissed(false);
        setDiscordLinkBannerVisible(false);
        return;
    }

    if (getDiscordLinkBannerDismissed()) {
        setDiscordLinkBannerVisible(false);
        return;
    }

    setDiscordLinkBannerVisible(true);
}

function initDiscordLinkBanner() {
    const closeBtn = document.getElementById('discordLinkBannerClose');
    const actionBtn = document.getElementById('discordLinkBannerAction');

    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            setDiscordLinkBannerDismissed(true);
            setDiscordLinkBannerVisible(false);
        });
    }

    if (actionBtn) {
        actionBtn.addEventListener('click', () => {
            const discordTab = document.getElementById('profileDiscordTabBtn');
            if (discordTab) {
                discordTab.click();
            } else {
                applyProfileTab('discord');
            }
            const target = document.getElementById('discordLinkCard');
            if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    }
}

function showConfirmModal(configOrTitle, message, isDestructive, callback) {
    const modal = document.getElementById('confirmationModal');
    const options = typeof configOrTitle === 'object' && configOrTitle !== null
        ? configOrTitle
        : {
            title: configOrTitle,
            message,
            isDestructive,
            onConfirm: callback
        };

    const titleText = String(options.title || 'Confirm Action');
    const messageText = String(options.message || 'Are you sure you want to proceed?');
    const detailsText = String(options.details || '').trim();
    const confirmText = String(options.confirmText || 'Confirm');
    const cancelText = String(options.cancelText || 'Cancel');
    const destructive = Boolean(options.isDestructive);
    const onConfirm = typeof options.onConfirm === 'function' ? options.onConfirm : null;

    if (!modal) {
        if (onConfirm) {
            const confirmed = confirm(messageText);
            if (confirmed) onConfirm();
            return;
        }
        return Promise.resolve(confirm(messageText));
    }

    const titleEl = document.getElementById('confirmModalTitle');
    const messageEl = document.getElementById('confirmModalMessage');
    const detailsEl = document.getElementById('confirmModalDetails');
    const cancelBtn = document.getElementById('confirmModalCancelBtn');
    const confirmBtn = document.getElementById('confirmModalActionBtn');

    if (titleEl) titleEl.textContent = titleText;
    if (messageEl) messageEl.textContent = messageText;
    if (detailsEl) {
        detailsEl.textContent = detailsText;
        detailsEl.style.display = detailsText ? 'block' : 'none';
    }
    if (cancelBtn) cancelBtn.textContent = cancelText;

    if (confirmBtn) {
        confirmBtn.className = destructive ? 'btn btn-danger' : 'btn btn-primary';
        confirmBtn.innerHTML = destructive
            ? `<i class="fas fa-unlink"></i> ${confirmText}`
            : `<i class="fas fa-check"></i> ${confirmText}`;

        const newBtn = confirmBtn.cloneNode(true);
        confirmBtn.parentNode.replaceChild(newBtn, confirmBtn);

        newBtn.onclick = async () => {
            try {
                if (onConfirm) {
                    await onConfirm();
                }
                closeConfirmModal(true);
            } catch (error) {
                closeConfirmModal(false);
                throw error;
            }
        };
    }

    const promise = onConfirm ? null : new Promise((resolve) => {
        confirmModalResolver = resolve;
    });

    modal.style.display = 'flex';
    setTimeout(() => modal.classList.add('show'), 10);
    return promise;
}

function closeConfirmModal(confirmed = false) {
    const modal = document.getElementById('confirmationModal');
    if (!modal) return;

    modal.classList.remove('show');
    setTimeout(() => {
        modal.style.display = 'none';
    }, 300);

    if (confirmModalResolver) {
        confirmModalResolver(Boolean(confirmed));
        confirmModalResolver = null;
    }
}

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
        profileShowError('No codes available to download.');
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

function normalizeOriginValue(originValue) {
    const raw = String(originValue || '').trim();
    if (!raw) return '';

    try {
        return new URL(raw).origin.toLowerCase();
    } catch (_) {
        return raw.replace(/\/+$/, '').toLowerCase();
    }
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
    let iconHtml = '<i class="fas fa-info-circle"></i>';
    const l = String(label).toLowerCase();

    if (l.includes('status') || l.includes('health')) iconHtml = '<i class="fas fa-heartbeat"></i>';
    else if (l.includes('session')) iconHtml = '<i class="fas fa-desktop"></i>';
    else if (l.includes('2fa') || l.includes('factor')) iconHtml = '<i class="fas fa-lock"></i>';
    else if (l.includes('fail') || l.includes('event')) iconHtml = '<i class="fas fa-exclamation-triangle"></i>';
    else if (l.includes('recovery')) iconHtml = '<i class="fas fa-life-ring"></i>';
    else if (l.includes('enabled')) iconHtml = '<i class="fas fa-calendar-check"></i>';

    const detailHtml = detail ? `<div class="metric-detail" style="font-size:0.85rem; opacity:0.75; margin-top:0.5rem; line-height:1.4;">${escapeHtml(detail)}</div>` : '';

    return `
                <div class="metric-card">
                    <div class="metric-icon" style="font-size:1.5rem; color:#818cf8; margin-bottom:0.75rem;">${iconHtml}</div>
                    <div class="metric-label" style="font-size:0.75rem; text-transform:uppercase; color:var(--color-text-light); letter-spacing:0.05em; margin-bottom:0.25rem;">${escapeHtml(label)}</div>
                    <div class="metric-value font-mono" style="font-size:1.75rem; font-weight:700; color:#fff;">${escapeHtml(String(value ?? '-'))}</div>
                    ${detailHtml}
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
    if (!match || !match[1]) return '';
    try {
        return decodeURIComponent(match[1]);
    } catch (_) {
        return match[1];
    }
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
    if (!csrfToken) {
        try {
            if (window.AdminPanel?.api?.getJson) {
                await window.AdminPanel.api.getJson('/api/csrf');
            } else {
                await fetch('/api/csrf', { credentials: 'include' });
            }
        } catch (error) {
            console.warn('Failed to prefetch CSRF token', error);
        }
        csrfToken = getCsrfTokenFromCookie();
    }
    let response = await sendRequest(csrfToken);

    if (response.status === 403 && !options._csrfRetried) {
        if (window.AdminPanel?.api?.getJson) {
            await window.AdminPanel.api.getJson('/api/csrf');
        } else {
            await fetch('/api/csrf', { credentials: 'include' });
        }
        csrfToken = getCsrfTokenFromCookie();
        response = await sendRequest(csrfToken);
    }

    return response;
}

function togglePasswordVisibility(fieldId, btnElement) {
    const field = document.getElementById(fieldId);
    if (!field) return;

    const isPassword = field.type === 'password';
    field.type = isPassword ? 'text' : 'password';

    if (btnElement) {
        const icon = btnElement.querySelector('i');
        if (icon) {
            icon.className = isPassword ? 'fas fa-eye-slash' : 'fas fa-eye';
        }
    } else {
        const btn = field.parentElement.querySelector('.password-toggle');
        if (btn) {
            const icon = btn.querySelector('i');
            if (icon) {
                icon.className = isPassword ? 'fas fa-eye-slash' : 'fas fa-eye';
            }
        }
    }

    syncShowAllToggleState();
}

function toggleAllPasswords(show) {
    const fields = ['currentPassword', 'newPassword', 'confirmPassword'];
    fields.forEach((fieldId) => {
        const field = document.getElementById(fieldId);
        if (field) {
            field.type = show ? 'text' : 'password';

            const btn = field.parentElement.querySelector('.password-toggle');
            if (btn) {
                const icon = btn.querySelector('i');
                if (icon) {
                    icon.className = show ? 'fas fa-eye-slash' : 'fas fa-eye';
                }
            }
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
    profileShowSuccess('Strong password generated and applied.');
}

async function copyGeneratedPassword() {
    const candidate = lastGeneratedPassword || document.getElementById('newPassword')?.value || '';
    if (!candidate) {
        profileShowError('Generate a password first, then copy it.');
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
        profileShowSuccess('Generated password copied to clipboard.');
    } catch (error) {
        console.error('Failed to copy password:', error);
        profileShowError('Could not copy password automatically. Please copy it manually.');
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

    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]).{8,100}$/;
    const isValid = Boolean(
        passwordRegex.test(newPassword)
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

function updatePasswordStrength(password) {
    let strength = 0;

    if (password.length >= 8) strength += 20;
    if (/[A-Z]/.test(password)) strength += 20;
    if (/[a-z]/.test(password)) strength += 20;
    if (/\d/.test(password)) strength += 20;
    if (/[@$!%*?&]/.test(password)) strength += 20;

    const strengthBar = document.getElementById('strengthBar');
    const strengthText = document.getElementById('strengthText');

    if (strengthBar) {
        strengthBar.style.width = strength + '%';

        let strengthLabel = '';
        let color = '';

        if (password.length === 0) {
            strengthLabel = '';
            color = 'transparent';
        } else if (strength <= 20) {
            strengthLabel = 'Too Weak';
            color = '#ef4444';
        } else if (strength <= 40) {
            strengthLabel = 'Weak';
            color = '#f59e0b';
        } else if (strength <= 60) {
            strengthLabel = 'Medium';
            color = '#eab308';
        } else if (strength <= 80) {
            strengthLabel = 'Strong';
            color = '#22c55e';
        } else {
            strengthLabel = 'Very Strong';
            color = '#10b981';
        }

        strengthBar.style.backgroundColor = color;
        if (strengthText) {
            strengthText.textContent = strengthLabel ? `Password Strength: ${strengthLabel}` : '';
            strengthText.style.color = color;
        }
    }
}

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
    const allPanels = Array.from(document.querySelectorAll('.content-area .tab-content'));
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

    const headerTitle = document.getElementById('profileWelcomeMsg');
    const headerSub = document.getElementById('profileWelcomeSub');
    const headers = {
        security: { title: "Security Center", sub: "Monitor your account health, 2FA status, and recent activity." },
        account: { title: "Account Settings", sub: "Update your personal details, email, and password." },
        geo: { title: "Geo Snapshot", sub: "Visualize your login locations and active session map." },
        recovery: { title: "Recovery Codes", sub: "View and regenerate your emergency backup codes." },
        discord: { title: "Linked Discord", sub: "Manage your Discord connection and sync settings." }
    };

    if (headers[targetTab]) {
        if (headerTitle) headerTitle.textContent = headers[targetTab].title;
        if (headerSub) headerSub.textContent = headers[targetTab].sub;
        document.title = `${headers[targetTab].title} | Sentinel Panel`;
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
        if (failedEvents > 0) {
            centerBadge.textContent = String(failedEvents);
            centerBadge.style.display = 'inline-block';
            centerBadge.title = `${failedEvents} failed event${failedEvents === 1 ? '' : 's'} in rolling 24h`;
        } else {
            centerBadge.style.display = 'none';
        }
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

    const urlParams = new URLSearchParams(window.location.search);
    const initialTab = urlParams.get('tab') || 'security';
    applyProfileTab(initialTab);
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

function renderProfileHero() {
    const displayUsername = currentUser?.username || '-';
    const heroAvatar = document.getElementById('profileHeroAvatar');
    renderAvatarSurface(heroAvatar, displayUsername, getCurrentAvatarUrl());
}

async function loadProfile() {
    try {
        const urlParams = new URLSearchParams(window.location.search);
        const viewUserId = urlParams.get('userId');
        const profileTabs = document.getElementById('profileTabs');

        const endpoint = viewUserId ? `/api/users/${encodeURIComponent(viewUserId)}` : '/api/user';
        const { response, data } = await window.AdminPanel.api.getJson(endpoint);
        if (response.ok) {
            currentUser = viewUserId ? (data.user || data) : data;

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
            renderProfileHero();
            if (heroSubtitle) {
                heroSubtitle.textContent = viewUserId
                    ? 'Viewing Discord account details, moderation visibility, and operational context.'
                    : 'Manage profile identity, account security, and linked service visibility from one place.';
            }
            updateEmailVerificationUI(Boolean(currentUser.email_verified), currentUser.email);
            syncAvatarEditorState();

            if (viewUserId) {
                setElementDisplayById('userActionsCard', 'block');
                setElementDisplayById('changeAvatarCard', 'none');
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
                setElementDisplayById('changeAvatarCard', 'block');
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
                updateDiscordLinkBanner(discordAccountLinked);
            } else {
                setDiscordLinkBannerVisible(false);
            }
        } else if (response.status === 401) {
            console.log('Unauthorized - redirecting to login');
            window.location.href = '/login';
        } else {
            const errorData = (data && typeof data === 'object') ? data : {};
            console.error('Failed to load profile:', errorData);
            profileShowError('Failed to load profile: ' + (errorData.error || 'Unknown error'));
        }
    } catch (error) {
        console.error('Error loading profile:', error);
        profileShowError('Failed to load profile information');
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
        profileShowError(error.message || 'Failed to load security center');
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

        if (Array.isArray(data?.protectedFeatures) && data.protectedFeatures.length > 0) {
            discordProtectedFeatures = data.protectedFeatures;
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

        const currentOrigin = String(window.location.origin || '').trim();
        const callbackOrigin = String(data.callbackOrigin || '').trim();
        const requestOrigin = String(data.requestOrigin || '').trim();
        const currentOriginNormalized = normalizeOriginValue(currentOrigin);
        const callbackOriginNormalized = normalizeOriginValue(callbackOrigin);
        const requestOriginNormalized = normalizeOriginValue(requestOrigin);
        const browserOriginMismatch = Boolean(callbackOriginNormalized && currentOriginNormalized && currentOriginNormalized !== callbackOriginNormalized);
        const serverOriginMismatch = Boolean(callbackOriginNormalized && requestOriginNormalized && requestOriginNormalized !== callbackOriginNormalized);

        if (!discordAccountLinked && browserOriginMismatch) {
            discordOAuthHealthState = 'host-mismatch';
            warning.innerHTML = `<strong>OAuth host mismatch detected.</strong><br>Current panel host: ${escapeHtml(currentOrigin)}<br>Configured callback host: ${escapeHtml(callbackOrigin)}${serverOriginMismatch && requestOrigin ? `<br>Server-detected request origin: ${escapeHtml(requestOrigin)}` : ''}<div class="discord-warning-fix"><strong>Fix:</strong> Open this panel on <strong>${escapeHtml(callbackOrigin)}</strong>, then sign in and retry linking.</div>`;
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

        if (!discordAccountLinked && serverOriginMismatch) {
            discordOAuthHealthState = 'degraded';
            warning.innerHTML = `<strong>Discord OAuth proxy warning.</strong><br>The panel host is correct, but the server detected a different proxy origin: ${escapeHtml(requestOrigin || 'Unknown')}. Linking should still work from this host, but check proxy headers if callbacks fail.`;
            warning.style.display = 'block';
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

function getDiscordProtectedFeatureMessage(source, fallback = 'Link Discord from the Discord tab to continue.') {
    const message = String(
        source?.securityReason
        || source?.error
        || source?.discordLinkState?.securityReason
        || ''
    ).trim();
    return message || fallback;
}

function handleDiscordProtectedError(data, fallback) {
    if (!data?.discordLinkRequired) return false;
    const message = getDiscordProtectedFeatureMessage(data?.discordLinkState || data, fallback);
    applyProfileTab('discord');
    profileShowError(message);
    try {
        document.getElementById('discordAuthorizeBtn')?.focus();
    } catch (_) {
    }
    return true;
}

function readStoredHighRiskApprovals() {
    try {
        const raw = sessionStorage.getItem(HIGH_RISK_ACTION_APPROVAL_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
        return {};
    }
}

function writeStoredHighRiskApprovals(value) {
    try {
        sessionStorage.setItem(HIGH_RISK_ACTION_APPROVAL_STORAGE_KEY, JSON.stringify(value || {}));
    } catch (_) {
    }
}

function getStoredHighRiskApproval(actionKey) {
    const approvals = readStoredHighRiskApprovals();
    const entry = approvals[String(actionKey || '')] || null;
    if (!entry) return null;

    const expiresAt = Number(new Date(entry.readyAt).getTime()) + (30 * 60 * 1000);
    if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
        clearStoredHighRiskApproval(actionKey);
        return null;
    }

    return entry;
}

function setStoredHighRiskApproval(actionKey, payload) {
    const approvals = readStoredHighRiskApprovals();
    approvals[String(actionKey || '')] = payload;
    writeStoredHighRiskApprovals(approvals);
}

function clearStoredHighRiskApproval(actionKey) {
    const approvals = readStoredHighRiskApprovals();
    delete approvals[String(actionKey || '')];
    writeStoredHighRiskApprovals(approvals);
}

function buildHighRiskApprovalPayload(actionKey, payload = {}) {
    const approval = getStoredHighRiskApproval(actionKey);
    if (!approval) return { ...payload };

    const readyAtMs = Number(new Date(approval.readyAt).getTime());
    if (Number.isFinite(readyAtMs) && Date.now() < readyAtMs) {
        const seconds = Math.max(1, Math.ceil((readyAtMs - Date.now()) / 1000));
        throw new Error(`Security delay in progress. Try again in about ${seconds}s.`);
    }

    return {
        ...payload,
        approvalToken: approval.approvalToken
    };
}

function handleHighRiskApprovalResponse(actionKey, data) {
    if (!data?.pendingApproval) return false;
    setStoredHighRiskApproval(actionKey, {
        approvalToken: String(data.approvalToken || '').trim(),
        readyAt: String(data.readyAt || '')
    });

    const readyAtMs = Number(new Date(data.readyAt).getTime());
    const seconds = Number.isFinite(readyAtMs)
        ? Math.max(1, Math.ceil((readyAtMs - Date.now()) / 1000))
        : null;
    const countdownLabel = seconds ? ` Wait about ${seconds}s, then repeat the action to confirm.` : '';
    profileShowSuccess(`${String(data.message || 'Security delay started.')}${countdownLabel}`);
    return true;
}

function setDiscordProtectedControlState(element, locked, title) {
    if (!element) return;
    element.disabled = Boolean(locked);
    element.style.opacity = locked ? '0.6' : '1';
    element.style.cursor = locked ? 'not-allowed' : 'pointer';
    element.title = locked ? title : '';
}

function applyDiscordProtectedFeatureState(discordLink) {
    discordSecurityEligible = Boolean(discordLink?.securityEligible);
    discordSecurityReason = getDiscordProtectedFeatureMessage(discordLink);
    discordProtectedFeatures = Array.isArray(discordLink?.protectedFeatures)
        ? discordLink.protectedFeatures.filter((feature) => typeof feature === 'string' && feature.trim())
        : [];

    const locked = !discordSecurityEligible;
    const lockedReason = discordSecurityReason || 'Link Discord from the Discord tab to continue.';
    const protectedControls = [
        document.querySelector('button[onclick="generateRecoveryCodesForAccount()"]'),
        document.querySelector('button[onclick="logoutOtherSessions()"]'),
        document.getElementById('setup2faBtn'),
        document.getElementById('disable2faBtn'),
        document.getElementById('changeEmailSubmitBtn'),
        document.getElementById('changeAvatarSubmitBtn'),
        document.getElementById('resetAvatarBtn')
    ];

    protectedControls.forEach((element) => {
        setDiscordProtectedControlState(element, locked, lockedReason);
    });
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

    if (securitySummary?.discordLink) {
        applyDiscordProtectedFeatureState(securitySummary.discordLink);
    }
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
    const discordLink = summary?.discordLink && typeof summary.discordLink === 'object' ? summary.discordLink : {};

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
    const discordLinkedLabel = discordLink.linked ? 'Linked' : 'Unlinked';
    const discordLinkedTone = discordLink.linked ? 'positive' : 'neutral';
    const discordTrustLabel = !discordLink.linked
        ? 'Unavailable'
        : (discordLink.trustedPanelRole ? `Trusted as ${String(discordLink.trustedPanelRole).toUpperCase()}` : 'Linked only');
    const discordTrustTone = discordLink.securityEligible ? 'positive' : (discordLink.linked ? 'warning' : 'neutral');
    const verificationLabel = !discordLink.linked
        ? 'No Discord verification'
        : (discordLink.recentlyVerified
            ? (discordLink.verificationSource === 'live' ? 'Verified just now' : 'Verified recently')
            : 'Verification stale');

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
    const verificationMetaLabel = discordLink.lastVerifiedAt
        ? new Date(discordLink.lastVerifiedAt).toLocaleString()
        : 'No verification timestamp recorded';

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
                <div class="security-overview-item">
                    <strong>Discord Link</strong>
                    ${buildStatusBadge(discordLinkedLabel, discordLinkedTone)}
                    <div class="security-empty-note">${escapeHtml(discordLink.linked ? 'A Discord account is connected to this panel account.' : 'Connect Discord before protected panel actions can use it.')}</div>
                </div>
                <div class="security-overview-item">
                    <strong>Discord Trust</strong>
                    ${buildStatusBadge(discordTrustLabel, discordTrustTone)}
                    <div class="security-empty-note">${escapeHtml(getDiscordProtectedFeatureMessage(discordLink, 'Link Discord to unlock protected actions.'))}</div>
                </div>
                <div class="security-overview-item">
                    <strong>Discord Verification</strong>
                    ${buildStatusBadge(verificationLabel, discordLink.recentlyVerified ? 'positive' : (discordLink.linked ? 'warning' : 'neutral'))}
                    <div class="security-empty-note">${escapeHtml(discordLink.lastVerifiedAt ? `Last verified: ${verificationMetaLabel}` : 'No recent Discord verification recorded.')}</div>
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
        const tooltipParts = [];
        if (ipDisplay.tooltip) tooltipParts.push(ipDisplay.tooltip);
        if (!primaryIp && session.ipAddressV6) tooltipParts.push(`IPv6: ${session.ipAddressV6}`);
        const ipTooltip = tooltipParts.length ? ` title="${escapeHtml(tooltipParts.join(' | '))}"` : '';
        const sessionGeo = session.geoLabel ? `<span class="security-ip-meta">${escapeHtml(session.geoLabel)}</span>` : '';
        const rawSessionId = String(session.sessionId || '').trim();
        const sessionSuffix = rawSessionId ? rawSessionId.slice(-8) : 'Unknown';
        const safeDeviceLabel = escapeHtml(session.device || 'Unknown');
        const encodedRevokeSessionId = encodeURIComponent(rawSessionId);

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
                        <td>${session.isCurrent
                ? `${detailsButton} <span style="margin-left:0.5rem;">${buildStatusBadge('This Session', 'neutral')}</span>`
                : `${detailsButton} <button class="btn btn-sm btn-danger" onclick="revokeSession('${encodedRevokeSessionId}')">Revoke</button>`}</td>
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
    const latestNetworkType = snapshot?.latestNetworkType || 'Unknown Network';
    const confidence = snapshot?.confidence || 'Low';
    const mapData = snapshot?.map && typeof snapshot.map === 'object' ? snapshot.map : null;
    const hasMap = Boolean(mapData?.available && Number.isFinite(Number(mapData.latitude)) && Number.isFinite(Number(mapData.longitude)));
    const lat = hasMap ? Number(mapData.latitude) : null;
    const lon = hasMap ? Number(mapData.longitude) : null;

    const riskSignals = Array.isArray(snapshot?.riskSignals) && snapshot.riskSignals.length
        ? snapshot.riskSignals
        : [];
    const hasRisks = riskSignals.length > 0;

    const encodedIp = encodeURIComponent(latestIp);
    const ipLinks = latestIp && latestIp !== 'Unknown'
        ? [
            { label: 'ip-api', url: `http://ip-api.com/#${encodedIp}` },
            { label: 'ipwhois', url: `https://ipwho.is/${encodedIp}` },
            { label: 'ipapi', url: `https://ipapi.co/${encodedIp}/` }
        ]
        : [];

    const mapEmbedHtml = hasMap
        ? (() => {
            const lonDelta = 0.18;
            const latDelta = 0.1;
            const bbox = `${(lon - lonDelta).toFixed(6)},${(lat - latDelta).toFixed(6)},${(lon + lonDelta).toFixed(6)},${(lat + latDelta).toFixed(6)}`;
            const marker = `${lat.toFixed(6)},${lon.toFixed(6)}`;
            const embedUrl = `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(bbox)}&layer=mapnik&marker=${encodeURIComponent(marker)}`;
            return `<iframe title="Login Location Map" src="${embedUrl}" loading="lazy" referrerpolicy="no-referrer"></iframe>
                    <div style="position:absolute; bottom:0; left:0; right:0; padding:0.75rem; background:rgba(0,0,0,0.7); backdrop-filter:blur(4px); font-size:0.75rem; color:#ccc;">
                        Displaying approximate location based on IP address. 
                        <a href="https://www.openstreetmap.org/?mlat=${encodeURIComponent(lat.toFixed(6))}&mlon=${encodeURIComponent(lon.toFixed(6))}" target="_blank" style="color:#fff; margin-left:0.5rem;" rel="noopener noreferrer">Expand Map</a>
                    </div>`;
        })()
        : `<div style="display:flex; align-items:center; justify-content:center; height:100%; color:var(--text-muted); flex-direction:column; gap:1rem;">
                <i class="fas fa-map-location-dot" style="font-size:3rem; opacity:0.3;"></i>
                <span>Map visualization unavailable for this IP</span>
           </div>`;

    container.innerHTML = `
        <div style="margin-bottom:1.5rem; display:flex; justify-content:space-between; align-items:flex-end;">
            <div>
                <h3 style="margin:0 0 0.25rem 0;">${escapeHtml(latestLocation)}</h3>
                <div style="font-size:0.9rem; color:var(--text-muted);">
                    Last Active: ${escapeHtml(latestTime)}
                </div>
            </div>
            ${buildStatusBadge(hasRisks ? `${riskSignals.length} Flagged Signals` : 'No Risks Detected', hasRisks ? 'warning' : 'positive')}
        </div>

        <div class="geo-snapshot-grid">
            <div class="geo-map-visual">
                <div class="geo-map-frame" style="width:100%; height:100%; min-height:300px;">
                    ${mapEmbedHtml}
                </div>
            </div>

            <div class="geo-info-card">
                <div class="geo-big-metric">
                    <div class="label">Primary IP Address</div>
                    <div class="value">${escapeHtml(latestIp)}</div>
                    <div style="font-size:0.8rem; margin-top:0.25rem;">
                        ${ipLinks.map(link => `<a href="${link.url}" target="_blank" style="color:var(--text-muted); text-decoration:underline; margin-right:0.75rem;" rel="noopener noreferrer">${link.label}</a>`).join('')}
                    </div>
                </div>
                
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:1rem; padding-top:1rem; border-top:1px solid rgba(255,255,255,0.1);">
                    <div>
                        <div style="font-size:0.75rem; color:var(--text-muted); text-transform:uppercase;">Network</div>
                        <div style="font-weight:600; margin-top:0.25rem;">${escapeHtml(latestNetworkType)}</div>
                    </div>
                    <div>
                        <div style="font-size:0.75rem; color:var(--text-muted); text-transform:uppercase;">Confidence</div>
                        <div style="margin-top:0.25rem;">${buildStatusBadge(confidence, 'neutral')}</div>
                    </div>
                </div>

                <div style="margin-top:auto; padding-top:1.5rem;">
                    <div style="font-size:0.75rem; color:var(--text-muted); text-transform:uppercase; margin-bottom:0.75rem;">Risk Analysis</div>
                    <div style="display:flex; flex-direction:column; gap:0.5rem;">
                        ${riskSignals.length > 0
            ? riskSignals.map(signal => `
                                <div class="geo-risk-check warn">
                                    <i class="fas fa-exclamation-triangle" style="color:#fbbf24;"></i>
                                    <span>${escapeHtml(signal)}</span>
                                </div>
                              `).join('')
            : `
                                <div class="geo-risk-check safe">
                                    <i class="fas fa-check-circle" style="color:#4ade80;"></i>
                                    <span>No anomalous route patterns detected</span>
                                </div>
                                <div class="geo-risk-check safe">
                                    <i class="fas fa-check-circle" style="color:#4ade80;"></i>
                                    <span>Network type matches residential baseline</span>
                                </div>
                              `
        }
                    </div>
                </div>
            </div>
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
    const nextReviewDate = nextReviewDateValue ? nextReviewDateValue.toLocaleDateString() : 'N/A';

    const expectedCodeCount = 10;
    const coveragePercent = hasCodes
        ? Math.max(0, Math.min(100, Math.round((codeCount / expectedCodeCount) * 100)))
        : 0;

    let healthState = 'healthy';
    let healthTitle = 'Secure';
    let healthIcon = '🛡️';
    let healthColor = 'var(--color-green)';

    if (!hasCodes) {
        healthState = 'critical';
        healthTitle = 'Not Configured';
        healthIcon = '🔒';
        healthColor = 'var(--color-red)';
    } else if (codeCount < 3) {
        healthState = 'critical';
        healthTitle = 'Depleted';
        healthIcon = '⚠️';
        healthColor = 'var(--color-red)';
    } else if (codeCount < expectedCodeCount) {
        healthState = 'warning';
        healthTitle = 'Partial Coverage';
        healthIcon = '📊';
        healthColor = 'var(--color-orange)';
    } else if (ageDays > 90) {
        healthState = 'warning';
        healthTitle = 'Rotation Needed';
        healthIcon = '♻️';
        healthColor = 'var(--color-orange)';
    }

    const metricsGrid = `
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 1rem; margin-top: 1.5rem;">
            <div style="background: rgba(255,255,255,0.03); padding: 1rem; border-radius: 8px; border: 1px solid rgba(255,255,255,0.05);">
                <div style="font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.5rem;">
                    Available Codes
                </div>
                <div style="font-size: 1.5rem; font-weight: 700; color: ${codeCount === 0 ? 'var(--color-text-muted)' : '#fff'};">
                    ${codeCount} <span style="font-size: 0.9rem; font-weight: 400; opacity: 0.6;">/ ${expectedCodeCount}</span>
                </div>
                <div style="margin-top: 0.5rem; height: 4px; background: rgba(255,255,255,0.1); border-radius: 2px; overflow: hidden;">
                    <div style="height: 100%; width: ${coveragePercent}%; background: ${healthColor}; border-radius: 2px;"></div>
                </div>
            </div>

            <div style="background: rgba(255,255,255,0.03); padding: 1rem; border-radius: 8px; border: 1px solid rgba(255,255,255,0.05);">
                <div style="font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.5rem;">
                    Inventory Age
                </div>
                <div style="font-size: 1.5rem; font-weight: 700; color: #fff;">
                    ${ageDays !== null ? ageDays : '-'} <span style="font-size: 0.9rem; font-weight: 400; opacity: 0.6;">days</span>
                </div>
                <div style="font-size: 0.8rem; margin-top: 0.35rem; color: var(--text-muted);">
                    Created: ${ageDays !== null ? generatedAt.split(',')[0] : 'Never'}
                </div>
            </div>

            <div style="background: rgba(255,255,255,0.03); padding: 1rem; border-radius: 8px; border: 1px solid rgba(255,255,255,0.05);">
                <div style="font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.5rem;">
                    Next Review
                </div>
                <div style="font-size: 1.25rem; font-weight: 700; color: ${isReviewOverdue ? 'var(--color-orange)' : '#fff'};">
                    ${nextReviewDate}
                </div>
                <div style="font-size: 0.8rem; margin-top: 0.35rem; color: var(--text-muted);">
                    ${isReviewOverdue ? 'Review limit overdue' : 'Scheduled check'}
                </div>
            </div>
        </div>
    `;

    let adviceHtml = '';
    if (healthState === 'critical' && !hasCodes) {
        adviceHtml = `
            <div style="margin-top: 1.5rem; padding: 0.85rem; border-left: 3px solid var(--color-red); background: rgba(239, 68, 68, 0.1);">
                <div style="font-weight: 600; font-size: 0.9rem; color: var(--color-red); margin-bottom: 0.25rem;">Action Required</div>
                <div style="font-size: 0.85rem; opacity: 0.9;">Generate a new set of recovery codes immediately to ensure you don't lose access to your account if 2FA fails.</div>
            </div>`;
    } else if (healthState === 'warning' && ageDays > 90) {
        adviceHtml = `
            <div style="margin-top: 1.5rem; padding: 0.85rem; border-left: 3px solid var(--color-orange); background: rgba(245, 158, 11, 0.1);">
                <div style="font-weight: 600; font-size: 0.9rem; color: var(--color-orange); margin-bottom: 0.25rem;">Rotation Recommended</div>
                <div style="font-size: 0.85rem; opacity: 0.9;">These codes are older than 90 days. For optimal security hygiene, regenerate them soon.</div>
            </div>`;
    }

    statusBox.innerHTML = `
        <div style="display: flex; align-items: center; gap: 1rem; padding-bottom: 1rem; border-bottom: 1px solid rgba(255,255,255,0.1);">
            <div style="width: 48px; height: 48px; border-radius: 12px; background: rgba(255,255,255,0.05); display: flex; align-items: center; justify-content: center; font-size: 1.5rem;">
                ${healthIcon}
            </div>
            <div>
                <h3 style="margin: 0; font-size: 1.1rem;">${healthTitle}</h3>
                <div style="font-size: 0.9rem; color: var(--text-muted); margin-top: 0.25rem;">
                    ${hasCodes ? 'Backup access methods configured' : 'No emergency access methods configured'}
                </div>
            </div>
            <div style="margin-left: auto;">
                 ${buildStatusBadge(healthState === 'healthy' ? 'Active' : 'Attention', healthState === 'healthy' ? 'positive' : 'warning')}
            </div>
        </div>

        ${metricsGrid}
        ${adviceHtml}
    `;
}

function renderDiscordLink(discordLink) {
    const status = document.getElementById('discordLinkStatus');
    const authorizeBtn = document.getElementById('discordAuthorizeBtn');
    const unlinkBtn = document.getElementById('discordUnlinkBtn');
    const refreshMeta = document.getElementById('discordProfileRefreshMeta');

    if (!status) return;

    const linked = Boolean(discordLink?.linked);
    discordAccountLinked = linked;
    updateDiscordLinkBanner(linked);

    const linkedAt = discordLink?.linkedAt ? new Date(discordLink.linkedAt).toLocaleString() : 'Unknown';
    const linkedUserId = discordLink?.discordUserId || 'Unknown ID';
    const linkedUsername = discordLink?.discordUsername || 'Unknown User';
    const securityEligible = Boolean(discordLink?.securityEligible);
    const securityReason = getDiscordProtectedFeatureMessage(discordLink);
    const trustedPanelRole = String(discordLink?.trustedPanelRole || '').trim();
    const lastVerifiedLabel = discordLink?.lastVerifiedAt
        ? new Date(discordLink.lastVerifiedAt).toLocaleString()
        : 'Not recently verified';
    const protectedFeatures = Array.isArray(discordLink?.protectedFeatures) && discordLink.protectedFeatures.length
        ? discordLink.protectedFeatures
        : (discordProtectedFeatures.length ? discordProtectedFeatures : [
            'Manage active sessions',
            'Generate recovery codes',
            'Configure two-factor authentication',
            'Change account email',
            'Change panel avatar'
        ]);
    const protectedFeatureList = protectedFeatures
        .map((feature) => `<span style="display:inline-flex; align-items:center; gap:0.4rem; padding:0.4rem 0.65rem; border-radius:999px; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.08); font-size:0.78rem; color:var(--text-secondary);">${escapeHtml(feature)}</span>`)
        .join('');
    const guildStatusLabel = discordLink?.guildVerificationRequired
        ? (discordLink?.guildMemberVerified ? 'Server Member Verified' : (discordLink?.guildVerificationAvailable ? 'Server Membership Required' : 'Server Check Pending'))
        : 'Discord Link Active';
    const guildStatusTone = discordLink?.guildVerificationRequired
        ? (discordLink?.guildMemberVerified ? 'positive' : 'warning')
        : 'positive';
    const securityBadge = buildStatusBadge(securityEligible ? 'Protected Features Unlocked' : 'Protected Features Locked', securityEligible ? 'positive' : 'warning');
    const trustStatusLabel = securityEligible
        ? (trustedPanelRole ? `Trusted for ${trustedPanelRole.toUpperCase()}` : 'Trusted for protected actions')
        : (linked ? 'Linked only' : 'Unlinked');
    const trustStatusTone = securityEligible ? 'positive' : (linked ? 'warning' : 'neutral');

    const profile = discordLink?.profile || {};
    const globalName = profile.globalName || '';
    const username = profile.username || linkedUsername;
    const discriminator = profile.discriminator && profile.discriminator !== '0' ? `#${profile.discriminator}` : '';
    const avatarUrl = profile.avatarUrl || 'https://cdn.discordapp.com/embed/avatars/0.png';
    const bannerUrl = profile.bannerUrl || '';
    const profileColor = profile.accentColor ? `#${profile.accentColor.toString(16)}` : '#5865F2';

    if (authorizeBtn) {
        authorizeBtn.style.display = linked ? 'none' : 'inline-flex';
        authorizeBtn.disabled = linked;
    }

    if (unlinkBtn) {
        unlinkBtn.style.display = linked ? 'inline-flex' : 'none';
        unlinkBtn.disabled = !linked;
    }

    if (refreshMeta) {
        refreshMeta.textContent = `Last synced: ${new Date().toLocaleString()}`;
    }

    applyDiscordProtectedFeatureState(discordLink || {});

    if (!linked) {
        status.innerHTML = `
            <div style="display: flex; align-items: center; gap: 1rem; padding-bottom: 1rem; border-bottom: 1px solid rgba(255,255,255,0.1); margin-bottom: 1.5rem;">
                <div style="width: 48px; height: 48px; border-radius: 12px; background: rgba(255,255,255,0.05); display: flex; align-items: center; justify-content: center; font-size: 1.5rem;">
                    🔌
                </div>
                <div>
                   <h3 style="margin: 0; font-size: 1.1rem;">Not Connected</h3>
                   <div style="font-size: 0.9rem; color: var(--text-muted); margin-top: 0.25rem;">
                       Link your Discord account to access community features
                   </div>
                </div>
                 <div style="margin-left: auto;">
                    ${buildStatusBadge('Unlinked', 'neutral')}
                </div>
            </div>

            <div style="background: rgba(88, 101, 242, 0.1); border: 1px dashed rgba(88, 101, 242, 0.4); border-radius: 12px; padding: 2rem; text-align: center;">
                <div style="font-size: 2.5rem; margin-bottom: 1rem;">👾</div>
                <h4 style="margin: 0 0 0.5rem 0; color: #fff;">Connect to Discord</h4>
                <p style="margin: 0 auto; max-width: 400px; font-size: 0.9rem; color: var(--text-secondary); line-height: 1.5;">
                    Verify your identity and unlock role-based access management by linking a Discord account.
                </p>
                <div style="display:flex; flex-wrap:wrap; gap:0.5rem; justify-content:center; margin-top:1.25rem;">
                    ${protectedFeatureList}
                </div>
                <div style="margin-top: 1.5rem;">
                    <span id="discordConnectionHealthChip"></span>
                </div>
                <div style="margin-top:0.9rem; color:var(--text-muted); font-size:0.82rem;">
                    ${escapeHtml(securityReason)}
                </div>
            </div>
        `;
    } else {
        const bannerStyle = bannerUrl
            ? `background-image: url('${escapeHtml(bannerUrl)}'); background-size: cover; background-position: center;`
            : `background-color: ${profileColor};`;

        status.innerHTML = `
            <div style="background: rgba(20, 21, 25, 0.6); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 16px; overflow: hidden; position: relative;">
                
                <div style="height: 180px; width: 100%; position: relative; ${bannerStyle}">
                    <div style="position: absolute; inset: 0; background: linear-gradient(to bottom, transparent 0%, rgba(20, 21, 25, 0.8) 100%);"></div>
                    
                    <div style="position: absolute; top: 1.5rem; right: 1.5rem; display: flex; gap: 0.75rem; align-items: center; z-index: 2;">
                        ${buildStatusBadge('Discord Linked', 'positive')}
                        ${buildStatusBadge(trustStatusLabel, trustStatusTone)}
                        ${buildStatusBadge(guildStatusLabel, guildStatusTone)}
                        <span id="discordConnectionHealthChip"></span>
                    </div>
                </div>

                <div style="padding: 0 2rem 2rem; position: relative; z-index: 10;">
                    
                    <div style="display: flex; align-items: flex-end; justify-content: space-between; margin-top: -50px; flex-wrap: wrap; gap: 1rem;">
                        <div style="display: flex; align-items: flex-end; gap: 1.5rem;">
                            <div style="position: relative; width: 100px; height: 100px; border-radius: 50%; padding: 6px; background: #141519;">
                                <div style="position: absolute; inset: 0; border-radius: 50%; border: 2px solid ${profileColor}; opacity: 0.3; pointer-events: none;"></div>
                                <img src="${escapeHtml(avatarUrl)}" style="width: 100%; height: 100%; border-radius: 50%; object-fit: cover; background: #2c2f33;" alt="Avatar">
                                <div style="position: absolute; bottom: 4px; right: 4px; width: 24px; height: 24px; background: #23a559; border: 4px solid #141519; border-radius: 50%;" title="Online"></div>
                            </div>
                            
                            <div style="padding-bottom: 0.5rem; margin-bottom: 1rem;">
                                <h2 style="margin: 0; font-size: 1.75rem; font-weight: 700; color: #fff; line-height: 1.2;">
                                    ${escapeHtml(globalName || username)}
                                </h2>
                                <div style="color: var(--text-muted); font-size: 1rem; font-weight: 500;">
                                    @${escapeHtml(username)}${escapeHtml(discriminator)}
                                </div>
                            </div>
                        </div>

                       <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.05); border-radius: 8px; padding: 0.6rem 1rem; margin-bottom: 1.5rem;">
                           <div style="font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin-bottom: 0.25rem;">Discord User ID</div>
                           <div style="display: flex; align-items: center; gap: 0.5rem;">
                               <code style="font-family: 'JetBrains Mono', monospace; color: #e2e8f0; font-size: 0.9rem;">${escapeHtml(linkedUserId)}</code>
                               <button onclick="navigator.clipboard.writeText('${escapeHtml(linkedUserId)}'); showSuccess('Copied ID')" style="background: none; border: none; color: var(--text-muted); cursor: pointer; padding: 0; opacity: 0.6; transition: opacity 0.2s;">
                                   <i class="fas fa-copy" style="font-size: 0.8rem;"></i>
                               </button>
                           </div>
                       </div>
                    </div>

                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1.5rem; margin-top: 1rem; padding: 1.5rem; background: rgba(0,0,0,0.2); border-radius: 12px; border: 1px solid rgba(255,255,255,0.03);">
                        
                         <div style="display: flex; flex-direction: column; gap: 0.4rem;">
                             <div style="display: flex; align-items: center; gap: 0.5rem; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted);">
                                 <i class="fas fa-link" style="opacity: 0.5;"></i> Connected Since
                             </div>
                             <div style="font-size: 0.95rem; font-weight: 500; color: #fff;">
                                 ${linkedAt}
                             </div>
                         </div>

                         <div style="display: flex; flex-direction: column; gap: 0.4rem;">
                              <div style="display: flex; align-items: center; gap: 0.5rem; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted);">
                                 <i class="fas fa-shield-alt" style="opacity: 0.5;"></i> Panel Trust
                             </div>
                             <div style="font-size: 0.95rem; font-weight: 500; color: #fff;">
                                 ${escapeHtml(trustedPanelRole ? trustedPanelRole.toUpperCase() : 'Linked only')}
                             </div>
                         </div>

                         <div style="display: flex; flex-direction: column; gap: 0.4rem;">
                              <div style="display: flex; align-items: center; gap: 0.5rem; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted);">
                                 <i class="fas fa-palette" style="opacity: 0.5;"></i> Accent Color
                             </div>
                             <div style="display: flex; align-items: center; gap: 0.75rem;">
                                 <div style="width: 24px; height: 24px; border-radius: 6px; background: ${profileColor}; border: 1px solid rgba(255,255,255,0.1);"></div>
                                 <code style="font-family: monospace; color: #fff; background: rgba(255,255,255,0.1); padding: 0.1rem 0.4rem; border-radius: 4px; font-size: 0.85rem;">${profileColor}</code>
                             </div>
                         </div>
                    </div>

                    <div style="margin-top:1.25rem; padding:1rem 1.1rem; background:rgba(88, 101, 242, 0.08); border:1px solid rgba(88, 101, 242, 0.22); border-radius:12px;">
                        <div style="display:flex; align-items:center; justify-content:space-between; gap:1rem; flex-wrap:wrap; margin-bottom:0.75rem;">
                            <div style="font-size:0.9rem; font-weight:600; color:#fff;">Discord security trust</div>
                            ${securityBadge}
                        </div>
                        <div style="display:flex; flex-wrap:wrap; gap:0.5rem;">
                            ${protectedFeatureList}
                        </div>
                        <div style="margin-top:0.8rem; color:var(--text-secondary); font-size:0.84rem; line-height:1.5;">
                            ${escapeHtml(securityEligible
            ? 'This Discord account is linked and currently trusted for protected account actions.'
            : (linked
                ? `This Discord account is linked, but it is not currently trusted for protected account actions. ${securityReason}`
                : securityReason))}
                        </div>
                        <div style="margin-top:0.5rem; color:var(--text-muted); font-size:0.78rem; line-height:1.4;">
                            Last Discord verification: ${escapeHtml(lastVerifiedLabel)}
                        </div>
                    </div>

                </div>
            </div>
        `;
    }

    updateDiscordConnectionHealthChip();
}

async function generateRecoveryCodesForAccount() {
    const currentPassword = await requestPasswordConfirmation();
    if (!currentPassword) return;

    let token = '';
    if (Boolean(securitySummary?.twoFactorEnabled)) {
        const promptedToken = prompt('Enter your current authenticator 6-digit code to generate new recovery codes:');
        if (!promptedToken) return;

        token = String(promptedToken || '').trim();
        if (!/^\d{6}$/.test(token)) {
            profileShowError('Please enter a valid 6-digit 2FA code');
            return;
        }
    }

    try {
        const response = await postWithCsrf('/api/security/recovery-codes/generate', { currentPassword, token });
        const raw = await response.text();
        let data = {};
        try {
            data = raw ? JSON.parse(raw) : {};
        } catch (_) {
            data = {};
        }
        if (!response.ok) {
            if (handleDiscordProtectedError(data, 'Link Discord to manage recovery codes.')) {
                return;
            }
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

        profileShowSuccess('Recovery codes generated. Store them securely before leaving this page.');
        loadSecurityCenter();
    } catch (error) {
        console.error('Error generating recovery codes:', error);
        profileShowError(error.message || 'Failed to generate recovery codes');
    }
}

async function copyRecoveryCodes() {
    const output = document.getElementById('recoveryCodesOutput');
    const text = output?.value || '';
    if (!text.trim()) {
        profileShowError('No recovery codes available to copy.');
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
        profileShowSuccess('Recovery codes copied to clipboard.');
    } catch (error) {
        console.error('Failed to copy recovery codes:', error);
        profileShowError('Could not copy recovery codes automatically.');
    }
}

function startDiscordOAuthLink() {
    const authorizeBtn = document.getElementById('discordAuthorizeBtn');
    const unlinkBtn = document.getElementById('discordUnlinkBtn');
    if (authorizeBtn && authorizeBtn.disabled) {
        profileShowError(authorizeBtn.title || 'Discord OAuth linking is currently unavailable.');
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
        profileShowError(unlinkBtn.title || 'No Discord account is linked.');
        return;
    }

    if (discordUnlinkInProgress) return;

    const confirmed = await showConfirmModal({
        title: 'Disconnect Discord Account?',
        message: 'Remove the linked Discord account from this panel profile?',
        details: 'This only disconnects Discord from your panel profile. You can link it again later from the Discord section.',
        confirmText: 'Unlink account',
        cancelText: 'Keep linked',
        isDestructive: true
    });

    if (!confirmed) return;

    const currentPassword = await requestPasswordConfirmation();
    if (!currentPassword) return;

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
        const response = await postWithCsrf('/api/account/discord-unlink', buildHighRiskApprovalPayload('discord-unlink', { currentPassword }));
        const raw = await response.text();
        let data = {};
        try {
            data = raw ? JSON.parse(raw) : {};
        } catch (_) {
            data = {};
        }
        if (response.status === 202 && handleHighRiskApprovalResponse('discord-unlink', data)) {
            return;
        }
        if (!response.ok) {
            if (handleDiscordProtectedError(data, 'Link Discord to manage Discord connection settings.')) {
                return;
            }
            throw new Error(data.error || `Failed to unlink Discord account (HTTP ${response.status})`);
        }

        clearStoredHighRiskApproval('discord-unlink');

        profileShowSuccess('Discord account unlinked.');
        loadSecurityCenter();
    } catch (error) {
        console.error('Error unlinking Discord account:', error);
        profileShowError(error.message || 'Failed to unlink Discord account');
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
        profileShowError('Session details not available');
        return;
    }

    const drawer = document.getElementById('sessionDetailsDrawer');
    const body = document.getElementById('sessionDetailsBody');
    if (!drawer || !body) return;

    const loginTime = session.loginTime ? new Date(Number(session.loginTime)).toLocaleString() : 'Unknown';
    const expiresAt = session.expiresAt ? new Date(session.expiresAt).toLocaleString() : 'Unknown';
    const statusLabel = session.isCurrent ? 'Current Session' : 'Active Session';
    const statusClass = session.isCurrent ? 'current' : 'active';
    const expiresAtMs = session.expiresAt ? new Date(session.expiresAt).getTime() : 0;
    const sessionAgeLabel = session.loginTime
        ? formatRelativeTimeFromDate(Number(session.loginTime))
        : 'Unknown';
    const expiresInLabel = Number.isFinite(expiresAtMs) && expiresAtMs > 0
        ? (expiresAtMs <= Date.now()
            ? 'Expired'
            : `In ${Math.max(1, Math.ceil((expiresAtMs - Date.now()) / 60000))}m`)
        : 'Unknown';
    const sessionHeadline = session.isCurrent
        ? 'This browser currently holds the active authenticated panel session.'
        : 'This device still has an active authenticated session for the panel.';

    body.innerHTML = `
                <section class="session-summary">
                    <span class="session-summary-badge">Session Inspection</span>
                    <div class="session-summary-head">
                        <div>
                            <div class="session-summary-device">${escapeHtml(session.device || 'Unknown Device')}</div>
                            <div class="session-summary-copy">${escapeHtml(sessionHeadline)}</div>
                        </div>
                        <span class="session-summary-status ${statusClass}">${escapeHtml(statusLabel)}</span>
                    </div>
                    <div class="session-summary-tags">
                        <span class="session-summary-tag">Created ${escapeHtml(sessionAgeLabel)}</span>
                        <span class="session-summary-tag">${escapeHtml(session.geoLabel || 'Unknown location')}</span>
                        <span class="session-summary-tag">Expires ${escapeHtml(expiresInLabel)}</span>
                    </div>
                </section>

                <section class="session-section-grid">
                    <article class="session-surface">
                        <div class="session-surface-head">
                            <span class="session-surface-title">Session Details</span>
                            <span class="session-surface-note">Current browser record</span>
                        </div>
                        <div class="session-detail-list">
                            <div class="session-detail-row">
                                <span class="session-detail-row-label">Session ID</span>
                                <div class="session-detail-row-value subtle">${escapeHtml(session.sessionId || 'Unknown')}</div>
                            </div>
                            <div class="session-detail-row">
                                <span class="session-detail-row-label">Device</span>
                                <div class="session-detail-row-value">${escapeHtml(session.device || 'Unknown Device')}</div>
                            </div>
                            <div class="session-detail-row">
                                <span class="session-detail-row-label">Status</span>
                                <div class="session-detail-row-value">${escapeHtml(statusLabel)}</div>
                            </div>
                            <div class="session-detail-row">
                                <span class="session-detail-row-label">IP Address</span>
                                <div class="session-detail-row-value">${escapeHtml(String(session.ipAddress || 'Unknown'))}</div>
                            </div>
                            <div class="session-detail-row">
                                <span class="session-detail-row-label">Login Time</span>
                                <div class="session-detail-row-value">${escapeHtml(loginTime)}</div>
                            </div>
                            <div class="session-detail-row">
                                <span class="session-detail-row-label">Expires At</span>
                                <div class="session-detail-row-value">${escapeHtml(expiresAt)}</div>
                            </div>
                        </div>
                    </article>

                    <article class="session-surface">
                        <div class="session-surface-head">
                            <span class="session-surface-title">User Agent</span>
                            <span class="session-surface-note">Browser signature</span>
                        </div>
                        <div class="session-code-block">${escapeHtml(session.userAgent || 'Unknown')}</div>
                    </article>
                </section>
            `;

    drawer.style.display = 'flex';
}

function closeSessionDetails() {
    const drawer = document.getElementById('sessionDetailsDrawer');
    if (drawer) drawer.style.display = 'none';
}

function logoutOtherSessions() {
    showConfirmModal(
        'Logout Other Sessions',
        'Are you sure you want to log out all active sessions except this one? This will disconnect you from all other devices.',
        true,
        async () => {
            try {
                const response = await postWithCsrf('/api/security/sessions/logout-others', {});
                const data = await response.json();

                if (!response.ok) {
                    if (handleDiscordProtectedError(data, 'Link Discord to manage active sessions.')) {
                        return;
                    }
                    throw new Error(data.error || 'Failed to logout other sessions');
                }

                profileShowSuccess('Other sessions logged out successfully');
                loadSecurityCenter();
            } catch (error) {
                console.error('Error logging out other sessions:', error);
                profileShowError(error.message || 'Failed to logout other sessions');
            }
        }
    );
}

function revokeSession(encodedSessionId) {
    const sessionId = decodeURIComponent(String(encodedSessionId || ''));
    if (!sessionId) return;

    showConfirmModal(
        'Revoke Session',
        'Are you sure you want to revoke this session? The device will be logged out immediately.',
        true,
        async () => {
            try {
                const response = await postWithCsrf('/api/security/sessions/revoke', { sessionId });
                const data = await response.json();

                if (!response.ok) {
                    if (handleDiscordProtectedError(data, 'Link Discord to manage active sessions.')) {
                        return;
                    }
                    throw new Error(data.error || 'Failed to revoke session');
                }

                profileShowSuccess('Session revoked successfully');
                loadSecurityCenter();
                closeSessionDetails();
            } catch (error) {
                console.error('Error revoking session:', error);
                profileShowError(error.message || 'Failed to revoke session');
            }
        }
    );
}

async function startTwoFactorSetup() {
    const currentPassword = await requestPasswordConfirmation();
    if (!currentPassword) return;

    try {
        const response = await postWithCsrf('/api/security/2fa/setup', { currentPassword });
        const data = await response.json();
        if (!response.ok) {
            if (handleDiscordProtectedError(data, 'Link Discord to configure two-factor authentication.')) {
                return;
            }
            throw new Error(data.error || 'Failed to start 2FA setup');
        }

        if (document.getElementById('twoFactorVerifyCode')) document.getElementById('twoFactorVerifyCode').value = '';

        const qrWrap = document.getElementById('twoFactorQrWrap');
        const qrImage = document.getElementById('twoFactorQrImage');
        if (qrWrap && qrImage && data.qrDataUrl) {
            qrImage.src = data.qrDataUrl;
            qrWrap.style.display = 'block';
        }

        const manualKey = document.getElementById('twoFactorManualKey');
        if (manualKey) {
            manualKey.textContent = data.manualEntryKey || 'Unavailable';
        }

        document.getElementById('twoFactorSetupPanel').style.display = 'block';
        profileShowSuccess('2FA setup initialized. Add the secret in your authenticator app.');
    } catch (error) {
        console.error('Error starting 2FA setup:', error);
        profileShowError(error.message || 'Failed to start 2FA setup');
    }
}

async function confirmTwoFactorSetup() {
    const token = (document.getElementById('twoFactorVerifyCode').value || '').trim();
    if (!/^\d{6}$/.test(token)) {
        profileShowError('Please enter a valid 6-digit verification code');
        return;
    }

    try {
        const response = await postWithCsrf('/api/security/2fa/enable', { token });
        const data = await response.json();

        if (!response.ok) {
            if (handleDiscordProtectedError(data, 'Link Discord to enable two-factor authentication.')) {
                return;
            }
            throw new Error(data.error || 'Failed to enable 2FA');
        }

        latestRecoveryCodes = Array.isArray(data.codes) ? data.codes : [];
        const recoveryWrap = document.getElementById('recoveryCodesWrap');
        const recoveryOutput = document.getElementById('recoveryCodesOutput');
        if (recoveryWrap) recoveryWrap.style.display = latestRecoveryCodes.length ? 'block' : 'none';
        if (recoveryOutput) {
            recoveryOutput.value = latestRecoveryCodes.join('\n');
            recoveryOutput.classList.add('sensitive-blur');
            recoveryOutput.classList.remove('revealed');
        }

        document.getElementById('twoFactorSetupPanel').style.display = 'none';
        const qrWrap = document.getElementById('twoFactorQrWrap');
        const qrImage = document.getElementById('twoFactorQrImage');
        const manualKey = document.getElementById('twoFactorManualKey');
        if (qrWrap) qrWrap.style.display = 'none';
        if (qrImage) qrImage.src = '';
        if (manualKey) manualKey.textContent = 'Not generated yet';
        applyProfileTab('recovery');
        profileShowSuccess('Two-factor authentication enabled. Save your recovery codes before leaving this page.');
        loadSecurityCenter();
    } catch (error) {
        console.error('Error enabling 2FA:', error);
        profileShowError(error.message || 'Failed to enable 2FA');
    }
}

async function disableTwoFactor() {
    const currentPassword = await requestPasswordConfirmation();
    if (!currentPassword) return;

    const token = prompt('Enter your current authenticator 6-digit code:');
    if (!token) return;

    try {
        const response = await postWithCsrf('/api/security/2fa/disable', buildHighRiskApprovalPayload('two-factor-disable', { currentPassword, token: token.trim() }));
        const data = await response.json();

        if (response.status === 202 && handleHighRiskApprovalResponse('two-factor-disable', data)) {
            return;
        }

        if (!response.ok) {
            if (handleDiscordProtectedError(data, 'Link Discord to disable two-factor authentication.')) {
                return;
            }
            throw new Error(data.error || 'Failed to disable 2FA');
        }

        clearStoredHighRiskApproval('two-factor-disable');

        profileShowSuccess('Two-factor authentication disabled.');
        loadSecurityCenter();
    } catch (error) {
        console.error('Error disabling 2FA:', error);
        profileShowError(error.message || 'Failed to disable 2FA');
    }
}

bindListenerById('changePasswordForm', 'submit', async function (e) {
    e.preventDefault();

    const currentPassword = document.getElementById('currentPassword').value;
    const newPassword = document.getElementById('newPassword').value;
    const confirmPassword = document.getElementById('confirmPassword').value;

    if (!currentPassword) {
        profileShowError('Please enter your current password');
        return;
    }

    if (newPassword !== confirmPassword) {
        profileShowError('New passwords do not match');
        return;
    }

    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]).{8,100}$/;
    if (!passwordRegex.test(newPassword)) {
        profileShowError('Password must contain at least 8 characters, including uppercase, lowercase, number, and special character');
        return;
    }

    document.getElementById('changePasswordBtnText').style.display = 'none';
    document.getElementById('changePasswordLoading').classList.remove('hidden');

    try {
        const response = await postWithCsrf('/api/user/change-password', {
            currentPassword,
            newPassword
        });

        const data = await response.json();

        if (response.ok) {
            profileShowSuccess('Password changed successfully');
            document.getElementById('changePasswordForm').reset();
            lastGeneratedPassword = '';
            const showAllToggle = document.getElementById('showAllPasswordsToggle');
            if (showAllToggle) showAllToggle.checked = false;
            toggleAllPasswords(false);
        } else {
            profileShowError(data.error || 'Failed to change password');
        }
    } catch (error) {
        console.error('Error changing password:', error);
        profileShowError('Failed to change password');
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
        profileShowError('New email addresses do not match');
        return;
    }

    if (!emailRegex.test(newEmail)) {
        profileShowError('Please enter a valid email address');
        return;
    }

    if (activeEmail && newEmail === activeEmail) {
        profileShowError('New email must be different from your current email');
        return;
    }

    document.getElementById('changeEmailBtnText').style.display = 'none';
    document.getElementById('changeEmailLoading').classList.remove('hidden');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.style.cursor = 'not-allowed';
    }

    try {
        const response = await postWithCsrf('/api/user/change-email', buildHighRiskApprovalPayload('change-email', { newEmail }));
        const data = await response.json();

        if (response.status === 202 && handleHighRiskApprovalResponse('change-email', data)) {
            return;
        }

        if (response.ok) {
            const updatedEmail = data.email || newEmail;
            document.getElementById('newEmail').value = '';
            document.getElementById('confirmNewEmail').value = '';
            currentUser.email = updatedEmail;
            currentUser.email_verified = false;
            updateEmailVerificationUI(false, updatedEmail);
            clearStoredHighRiskApproval('change-email');
            profileShowSuccess('Email updated. Please verify your new address from your inbox.');
        } else {
            if (handleDiscordProtectedError(data, 'Link Discord to change your email address.')) {
                return;
            }
            profileShowError(data.error || 'Failed to change email');
        }
    } catch (error) {
        console.error('Error changing email:', error);
        profileShowError('Failed to change email');
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

bindListenerById('avatarFileInput', 'change', syncAvatarEditorState);
bindListenerById('changeAvatarForm', 'submit', async function (e) {
    e.preventDefault();

    const input = document.getElementById('avatarFileInput');
    const submitBtn = document.getElementById('changeAvatarSubmitBtn');
    const selectedFile = getSelectedAvatarFile();
    const validation = validateAvatarFile(selectedFile);

    if (!validation.ok) {
        profileShowError(validation.message);
        return;
    }

    document.getElementById('changeAvatarBtnText').style.display = 'none';
    document.getElementById('changeAvatarLoading').classList.remove('hidden');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.style.cursor = 'not-allowed';
    }

    try {
        const formData = new FormData();
        formData.append('avatar', selectedFile);

        const response = await postFormDataWithCsrf('/api/user/change-avatar', formData);
        const data = await response.json();

        if (response.ok) {
            currentUser.avatar_url = data.avatar_url || null;
            currentUser.avatar_updated_at = data.avatar_updated_at || null;
            if (input) input.value = '';
            renderProfileHero();
            syncAvatarEditorState();
            profileShowSuccess(data.message || 'Avatar uploaded successfully');
        } else {
            if (handleDiscordProtectedError(data, 'Link Discord to change your panel avatar.')) {
                return;
            }
            profileShowError(data.error || 'Failed to change avatar');
        }
    } catch (error) {
        console.error('Error changing avatar:', error);
        profileShowError('Failed to change avatar');
    } finally {
        document.getElementById('changeAvatarBtnText').style.display = 'inline';
        document.getElementById('changeAvatarLoading').classList.add('hidden');
        syncAvatarEditorState();
    }
});

bindListenerById('resetAvatarBtn', 'click', async function () {
    const input = document.getElementById('avatarFileInput');
    const selectedFile = getSelectedAvatarFile();

    if (selectedFile) {
        if (input) input.value = '';
        syncAvatarEditorState();
        return;
    }

    if (!getCurrentAvatarUrl()) return;

    const confirmed = await showConfirmModal({
        title: 'Reset Avatar',
        message: 'Remove your custom avatar and return to initials?',
        confirmText: 'Reset Avatar',
        isDestructive: true
    });

    if (!confirmed) return;

    if (input) input.value = '';

    const formData = new FormData();
    formData.append('resetAvatar', '1');

    const response = await postFormDataWithCsrf('/api/user/change-avatar', formData);
    const data = await response.json().catch(() => ({}));

    if (response.ok) {
        currentUser.avatar_url = null;
        currentUser.avatar_updated_at = null;
        renderProfileHero();
        syncAvatarEditorState();
        profileShowSuccess(data.message || 'Avatar reset successfully');
        return;
    }

    syncAvatarEditorState();
    if (handleDiscordProtectedError(data, 'Link Discord to change your panel avatar.')) {
        return;
    }
    profileShowError(data.error || 'Failed to reset avatar');
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
            profileShowSuccess('User warned successfully');
            setTimeout(() => location.reload(), 1500);
        } else {
            profileShowError(data.error || 'Failed to warn user');
        }
    } catch (error) {
        console.error('Error warning user:', error);
        profileShowError('Failed to warn user');
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
            profileShowSuccess('User banned successfully');
            setTimeout(() => location.reload(), 1500);
        } else {
            profileShowError(data.error || 'Failed to ban user');
        }
    } catch (error) {
        console.error('Error banning user:', error);
        profileShowError('Failed to ban user');
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
            profileShowSuccess(data.message || 'Verification email sent');
            updateEmailVerificationUI(false, currentUser?.email || '');
        } else {
            profileShowError(data.error || 'Failed to resend verification email');
        }
    } catch (error) {
        console.error('Error resending verification email:', error);
        profileShowError('Failed to resend verification email');
    } finally {
        button.textContent = originalText;
        updateEmailVerificationUI(Boolean(currentUser?.email_verified), currentUser?.email || '');
    }
});

function profileShowError(message) {
    if (typeof window.showError === 'function' && window.showError !== profileShowError) {
        window.showError(message);
    }

    const errorMsg = document.getElementById('errorMsg');
    if (!errorMsg) return;
    errorMsg.textContent = message;
    errorMsg.classList.remove('hidden');
    setTimeout(() => errorMsg.classList.add('hidden'), 5000);
}

function profileShowSuccess(message) {
    if (typeof window.showSuccess === 'function' && window.showSuccess !== profileShowSuccess) {
        window.showSuccess(message);
    }

    const successMsg = document.getElementById('successMsg');
    if (!successMsg) return;
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
        profileShowSuccess(message || 'Discord account linked successfully.');
    } else {
        profileShowError(message || 'Discord OAuth linking failed.');
    }

    url.searchParams.delete('discord_oauth');
    url.searchParams.delete('message');
    window.history.replaceState({}, document.title, `${url.pathname}${url.search}`);
}

initProfileTabs();
initDiscordLinkBanner();
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
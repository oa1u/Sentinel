async function timeoutUserFromSearch(userId, username, fetchWithCsrf, searchUsers) {
    // Prompt the admin for a duration and reason, then hit the API to apply the timeout.
    // Keeps the UX smooth by confirming the action and refreshing search results afterwards.
    showInputModal(`Enter timeout duration for ${username} (e.g., "10m", "1h", "7d")`, (durationStr) => {
        if (!durationStr) return;
        showInputModal(`Enter timeout reason for ${username}:`, async (reason) => {
            if (!reason) return;
            try {
                let confirmed = true;
                if (typeof modalManager !== 'undefined' && modalManager && modalManager.showConfirm) {
                    confirmed = await modalManager.showConfirm(`Are you sure you want to timeout ${username}?`);
                } else {
                    confirmed = confirm(`Are you sure you want to timeout ${username}?`);
                }
                if (!confirmed) return;
                try {
                    const response = await fetchWithCsrf('/api/admin/timeout-user', {
                        method: 'POST',
                        body: JSON.stringify({ userId, duration: durationStr, reason })
                    });
                    const data = await response.json();
                    if (response.ok) {
                        showSuccess(`User timed out successfully. Case ID: ${data.caseId}`);
                        if (typeof searchUsers === 'function') await searchUsers(); // Refresh the search results
                    } else {
                        showError(data.error || 'Failed to timeout user');
                    }
                } catch (error) {
                    showError('Error timing out user');
                    console.error(error);
                }
            } catch (err) {
                console.error('Timeout confirmation failed', err);
            }
        });
    });
}
window.timeoutUserFromSearch = timeoutUserFromSearch;
// Toast notification system: shows brief, contextual messages to users
// across the admin panel. It's resilient if parts of the DOM are missing.

// Make sure `document` exists before running any DOM-related notification code.
if (typeof document === 'undefined') {
    console.warn('notifications.js: Document not available');
}

// Ensure there is a toast container in the document; create one if needed so toasts
// have a consistent place to appear.
function ensureToastContainer() {
    if (typeof document === 'undefined') return null;

    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.className = 'toast-container';
        container.setAttribute('role', 'status');
        container.setAttribute('aria-live', 'polite');
        document.body.appendChild(container);
    }
    let badge = container.querySelector('.toast-queue-indicator');
    if (!badge) {
        badge = document.createElement('div');
        badge.className = 'toast-queue-indicator';
        badge.setAttribute('aria-hidden', 'true');
        badge.setAttribute('role', 'button');
        badge.tabIndex = 0;
        badge.addEventListener('click', () => expandQueuedToasts());
        badge.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                expandQueuedToasts();
            }
        });
        container.appendChild(badge);
    }
    applyToastContainerPosition(container);
    return container;
}

const toastSystemState = {
    config: {
        maxVisible: 5,
        dedupeWindowMs: 2500,
        historyLimit: 100,
        position: 'top-right',
        closeOnClick: true,
        swipeToDismiss: true,
        swipeThreshold: 60,
        compactMode: true,
        compactThreshold: 4,
        severityDurations: {
            success: 4000,
            info: 4000,
            warning: 6000,
            error: 9000
        },
        stickyTypes: ['error']
    },
    active: [],
    queue: [],
    dedupeIndex: new Map(),
    history: []
};

function applyToastContainerPosition(container) {
    if (!container) return;
    const allowed = new Set([
        'top-right',
        'top-left',
        'bottom-right',
        'bottom-left',
        'top-center',
        'bottom-center'
    ]);
    const next = allowed.has(toastSystemState.config.position)
        ? toastSystemState.config.position
        : 'top-right';
    container.className = `toast-container position-${next}`;
    updateToastContainerState(container);
}

function updateToastContainerState(container) {
    if (!container) return;
    const compactEnabled = Boolean(toastSystemState.config.compactMode);
    const threshold = Math.max(2, Number(toastSystemState.config.compactThreshold) || 4);
    const total = toastSystemState.active.length + toastSystemState.queue.length;
    const isCompact = compactEnabled && total >= threshold;

    if (isCompact) {
        container.classList.add('compact');
    } else {
        container.classList.remove('compact');
    }

    updateToastQueueIndicator(container);
}

function updateToastQueueIndicator(container) {
    if (!container) return;
    const badge = container.querySelector('.toast-queue-indicator');
    if (!badge) return;
    const queuedCount = toastSystemState.queue.length;

    if (queuedCount > 0) {
        badge.textContent = `+${queuedCount} more`;
        badge.classList.add('show');
    } else {
        badge.textContent = '';
        badge.classList.remove('show');
    }
}

function expandQueuedToasts() {
    while (toastSystemState.queue.length > 0 && toastSystemState.active.length < toastSystemState.config.maxVisible) {
        const next = toastSystemState.queue.shift();
        if (next) createAndMountToast(next);
    }
    updateToastContainerState(document.getElementById('toast-container'));
}

function normalizeToastPayload(type, title, message, durationOrOptions) {
    let durationExplicit = false;
    const payload = {
        type: ['success', 'error', 'warning', 'info'].includes(type) ? type : 'info',
        title: '',
        message: '',
        duration: 5000,
        persist: false,
        allowDuplicate: false,
        actions: []
    };

    if (title && typeof title === 'object') {
        const opts = title;
        payload.title = String(opts.title || '');
        payload.message = String(opts.message || '');
        if (Number.isFinite(Number(opts.duration))) {
            payload.duration = Number(opts.duration);
            durationExplicit = true;
        }
        payload.persist = Boolean(opts.persist);
        payload.allowDuplicate = Boolean(opts.allowDuplicate);
        if (Array.isArray(opts.actions)) {
            payload.actions = opts.actions;
        }
        if (!durationExplicit) {
            const routed = toastSystemState.config.severityDurations?.[payload.type];
            if (Number.isFinite(Number(routed))) payload.duration = Number(routed);
        }
        if (!payload.persist && Array.isArray(toastSystemState.config.stickyTypes)) {
            if (toastSystemState.config.stickyTypes.includes(payload.type)) {
                payload.persist = true;
                payload.duration = 0;
            }
        }
        return payload;
    }

    payload.title = String(title || '');
    payload.message = typeof message === 'string' ? message : '';

    if (typeof durationOrOptions === 'object' && durationOrOptions !== null) {
        if (Number.isFinite(Number(durationOrOptions.duration))) {
            payload.duration = Number(durationOrOptions.duration);
            durationExplicit = true;
        }
        payload.persist = Boolean(durationOrOptions.persist);
        payload.allowDuplicate = Boolean(durationOrOptions.allowDuplicate);
        if (Array.isArray(durationOrOptions.actions)) {
            payload.actions = durationOrOptions.actions;
        }
    } else {
        if (Number.isFinite(Number(durationOrOptions))) {
            payload.duration = Number(durationOrOptions);
            durationExplicit = true;
        }
    }

    if (!durationExplicit) {
        const routed = toastSystemState.config.severityDurations?.[payload.type];
        if (Number.isFinite(Number(routed))) payload.duration = Number(routed);
    }

    if (!payload.persist && Array.isArray(toastSystemState.config.stickyTypes)) {
        if (toastSystemState.config.stickyTypes.includes(payload.type)) {
            payload.persist = true;
            payload.duration = 0;
        }
    }

    return payload;
}

function flushToastQueue() {
    while (toastSystemState.queue.length > 0 && toastSystemState.active.length < toastSystemState.config.maxVisible) {
        const next = toastSystemState.queue.shift();
        if (next) createAndMountToast(next);
    }
    updateToastContainerState(document.getElementById('toast-container'));
}

function closeToast(toast, immediate = false) {
    if (!toast || toast.dataset.closed === '1') return;
    toast.dataset.closed = '1';

    const key = toast.dataset.toastKey;
    if (key) toastSystemState.dedupeIndex.delete(key);

    const remove = () => {
        toast.remove();
        toastSystemState.active = toastSystemState.active.filter(node => node !== toast);
        flushToastQueue();
        updateToastContainerState(document.getElementById('toast-container'));
    };

    if (immediate) {
        remove();
        return;
    }

    toast.classList.add('removing');
    setTimeout(remove, 260);
}

function attachToastTimer(toast, duration) {
    if (!Number.isFinite(duration) || duration <= 0) return;

    const progressBar = toast.querySelector('.toast-progress-inner');
    let remaining = duration;
    let startedAt = Date.now();
    let timeoutId = null;

    const updateProgress = () => {
        if (!progressBar) return;
        const pct = Math.max(0, Math.min(100, (remaining / duration) * 100));
        progressBar.style.width = `${pct}%`;
    };

    const startTimer = () => {
        startedAt = Date.now();
        timeoutId = setTimeout(() => closeToast(toast), remaining);
    };

    const pauseTimer = () => {
        if (!timeoutId) return;
        clearTimeout(timeoutId);
        timeoutId = null;
        const elapsed = Date.now() - startedAt;
        remaining = Math.max(0, remaining - elapsed);
        updateProgress();
    };

    toast.addEventListener('mouseenter', pauseTimer);
    toast.addEventListener('mouseleave', () => {
        if (remaining <= 0) {
            closeToast(toast);
            return;
        }
        startTimer();
    });
    toast.addEventListener('focusin', pauseTimer);
    toast.addEventListener('focusout', () => {
        if (remaining <= 0) {
            closeToast(toast);
            return;
        }
        startTimer();
    });
    toast.addEventListener('touchstart', pauseTimer, { passive: true });
    toast.addEventListener('touchend', () => {
        if (remaining <= 0) {
            closeToast(toast);
            return;
        }
        startTimer();
    }, { passive: true });

    const tickInterval = setInterval(() => {
        if (!document.body.contains(toast)) {
            clearInterval(tickInterval);
            return;
        }
        if (!timeoutId) return;
        const elapsed = Date.now() - startedAt;
        const liveRemaining = Math.max(0, remaining - elapsed);
        if (progressBar) {
            const pct = Math.max(0, Math.min(100, (liveRemaining / duration) * 100));
            progressBar.style.width = `${pct}%`;
        }
    }, 80);

    updateProgress();
    startTimer();
}

function attachToastInteractions(toast) {
    if (!toast || typeof window === 'undefined') return;

    if (toastSystemState.config.closeOnClick) {
        toast.addEventListener('click', (event) => {
            if (event.target?.closest?.('.toast-close')) return;
            if (event.target?.closest?.('a, button')) return;
            const selection = window.getSelection?.();
            if (selection && String(selection).trim()) return;
            closeToast(toast);
        });
    }

    if (!toastSystemState.config.swipeToDismiss || !('PointerEvent' in window)) return;

    let startX = 0;
    let startY = 0;
    let isPointerDown = false;
    let isSwiping = false;

    const onPointerDown = (event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        if (event.target?.closest?.('.toast-close')) return;

        startX = event.clientX;
        startY = event.clientY;
        isPointerDown = true;
        isSwiping = false;

        toast.setPointerCapture?.(event.pointerId);
    };

    const onPointerMove = (event) => {
        if (!isPointerDown) return;
        const dx = event.clientX - startX;
        const dy = event.clientY - startY;

        if (!isSwiping) {
            if (Math.abs(dx) < 6 || Math.abs(dx) <= Math.abs(dy)) return;
            isSwiping = true;
        }

        event.preventDefault();
        toast.style.transition = 'none';
        toast.style.transform = `translateX(${dx}px)`;
        toast.style.opacity = `${Math.max(0.3, 1 - Math.abs(dx) / 220)}`;
    };

    const onPointerUp = (event) => {
        if (!isPointerDown) return;
        const dx = event.clientX - startX;
        const threshold = Math.max(30, Number(toastSystemState.config.swipeThreshold) || 60);

        toast.releasePointerCapture?.(event.pointerId);
        isPointerDown = false;

        if (isSwiping && Math.abs(dx) >= threshold) {
            toast.style.transition = '';
            toast.style.transform = '';
            toast.style.opacity = '';
            closeToast(toast);
            return;
        }

        toast.style.transition = '';
        toast.style.transform = '';
        toast.style.opacity = '';
        isSwiping = false;
    };

    toast.addEventListener('pointerdown', onPointerDown);
    toast.addEventListener('pointermove', onPointerMove);
    toast.addEventListener('pointerup', onPointerUp);
    toast.addEventListener('pointercancel', onPointerUp);
    toast.addEventListener('lostpointercapture', onPointerUp);
}

function createAndMountToast(payload) {
    const container = ensureToastContainer();
    if (!container) return null;

    const toast = document.createElement('div');
    toast.className = `toast ${payload.type}`;

    const icons = {
        success: '✅',
        error: '❌',
        warning: '⚠️',
        info: 'ℹ️'
    };

    const actions = Array.isArray(payload.actions) ? payload.actions : [];
    const actionsHtml = actions.length
        ? `<div class="toast-actions">${actions.map((action, index) => {
            const label = typeof action === 'string' ? action : String(action?.label || 'Action');
            const primary = Boolean(action?.primary);
            return `<button type="button" class="toast-action ${primary ? 'primary' : ''}" data-action-index="${index}">${label}</button>`;
        }).join('')}</div>`
        : '';

    toast.innerHTML = `
        <div class="toast-icon">${icons[payload.type] || icons.info}</div>
        <div class="toast-content">
            <div class="toast-title">${payload.title}</div>
            ${payload.message ? `<div class="toast-message">${payload.message}</div>` : ''}
            ${actionsHtml}
            <div class="toast-progress" aria-hidden="true"><div class="toast-progress-inner"></div></div>
        </div>
        <button class="toast-close" type="button" aria-label="Close notification">×</button>
    `;

    toast.querySelector('.toast-close')?.addEventListener('click', () => closeToast(toast));
    toast.querySelectorAll('.toast-action').forEach((button) => {
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            const index = Number(button.dataset.actionIndex);
            const action = actions[index];
            if (!action) return;
            const dismiss = action.dismiss !== false;

            if (typeof action === 'function') {
                action({ toast, payload, close: () => closeToast(toast) });
            } else if (typeof action?.action === 'function') {
                action.action({ toast, payload, close: () => closeToast(toast) });
            } else if (typeof action?.action === 'string') {
                window.dispatchEvent(new CustomEvent(action.action, { detail: { toast, payload } }));
            }

            if (dismiss) closeToast(toast);
        });
    });
    container.appendChild(toast);
    toastSystemState.active.push(toast);
    attachToastInteractions(toast);
    updateToastContainerState(container);

    if (!payload.persist) {
        attachToastTimer(toast, payload.duration);
    }

    return toast;
}

// Create and display a toast message. Provide a `type` (success/error/info/warning),
// a short `title`, and an optional `message`. Returns the toast DOM node.
function showToast(type, title, message, duration = 5000) {
    const payload = normalizeToastPayload(type, title, message, duration);
    const dedupeKey = `${payload.type}|${payload.title}|${payload.message}`;
    const now = Date.now();

    toastSystemState.history.unshift({
        ...payload,
        timestamp: now
    });
    if (toastSystemState.history.length > toastSystemState.config.historyLimit) {
        toastSystemState.history.length = toastSystemState.config.historyLimit;
    }

    if (!payload.allowDuplicate) {
        const existing = toastSystemState.dedupeIndex.get(dedupeKey);
        if (existing && (now - existing.createdAt) <= toastSystemState.config.dedupeWindowMs) {
            const badge = existing.toast.querySelector('.toast-duplicate-count');
            if (badge) {
                const nextCount = Number(badge.dataset.count || 1) + 1;
                badge.dataset.count = String(nextCount);
                badge.textContent = `×${nextCount}`;
            } else {
                const titleEl = existing.toast.querySelector('.toast-title');
                if (titleEl) {
                    const counter = document.createElement('span');
                    counter.className = 'toast-duplicate-count';
                    counter.dataset.count = '2';
                    counter.textContent = '×2';
                    counter.style.marginLeft = '0.5rem';
                    counter.style.opacity = '0.8';
                    titleEl.appendChild(counter);
                }
            }
            return existing.toast;
        }
    }

    if (toastSystemState.active.length >= toastSystemState.config.maxVisible) {
        toastSystemState.queue.push(payload);
        return null;
    }

    const toast = createAndMountToast(payload);
    if (!toast) return null;

    toast.dataset.toastKey = dedupeKey;
    toastSystemState.dedupeIndex.set(dedupeKey, { toast, createdAt: now });

    return toast;
}

// Convenience wrappers for common toast types.
function showSuccess(title, message, duration) {
    return showToast('success', title, message, duration);
}
function showError(title, message, duration) {
    return showToast('error', title, message, duration);
}
function showWarning(title, message, duration) {
    return showToast('warning', title, message, duration);
}
function showInfo(title, message, duration) {
    return showToast('info', title, message, duration);
}

// Expose convenience functions globally so other scripts can show toasts easily.
if (typeof window !== 'undefined') {
    window.showSuccess = showSuccess;
    window.showError = showError;
    window.showWarning = showWarning;
    window.showInfo = showInfo;
    window.configureNotifications = function configureNotifications(options = {}) {
        if (typeof options !== 'object' || !options) return toastSystemState.config;

        const next = { ...toastSystemState.config };
        if (Number.isFinite(Number(options.maxVisible))) {
            next.maxVisible = Math.max(1, Math.min(8, Number(options.maxVisible)));
        }
        if (Number.isFinite(Number(options.dedupeWindowMs))) {
            next.dedupeWindowMs = Math.max(250, Math.min(10000, Number(options.dedupeWindowMs)));
        }
        if (Number.isFinite(Number(options.historyLimit))) {
            next.historyLimit = Math.max(20, Math.min(300, Number(options.historyLimit)));
        }
        if (typeof options.position === 'string') {
            next.position = options.position;
        }
        if (typeof options.closeOnClick === 'boolean') {
            next.closeOnClick = options.closeOnClick;
        }
        if (typeof options.swipeToDismiss === 'boolean') {
            next.swipeToDismiss = options.swipeToDismiss;
        }
        if (Number.isFinite(Number(options.swipeThreshold))) {
            next.swipeThreshold = Math.max(30, Math.min(200, Number(options.swipeThreshold)));
        }
        if (options.severityDurations && typeof options.severityDurations === 'object') {
            next.severityDurations = {
                ...next.severityDurations,
                ...options.severityDurations
            };
        }
        if (Array.isArray(options.stickyTypes)) {
            next.stickyTypes = options.stickyTypes.slice();
        }
        if (typeof options.compactMode === 'boolean') {
            next.compactMode = options.compactMode;
        }
        if (Number.isFinite(Number(options.compactThreshold))) {
            next.compactThreshold = Math.max(2, Math.min(10, Number(options.compactThreshold)));
        }

        toastSystemState.config = next;
        const container = document.getElementById('toast-container');
        applyToastContainerPosition(container);
        flushToastQueue();
        return toastSystemState.config;
    };
    window.getNotificationHistory = function getNotificationHistory(limit = 25) {
        const safeLimit = Math.max(1, Math.min(100, Number(limit) || 25));
        return toastSystemState.history.slice(0, safeLimit);
    };
    window.clearNotificationHistory = function clearNotificationHistory(options = {}) {
        const clearActive = Boolean(options?.clearActive);
        toastSystemState.history = [];
        toastSystemState.queue = [];
        toastSystemState.dedupeIndex.clear();

        if (clearActive) {
            const activeCopy = [...toastSystemState.active];
            activeCopy.forEach((toast) => closeToast(toast, true));
        }

        return true;
    };
}

// Session timeout warning system: warns users when their admin session is
// nearing expiration and can help them extend it.
let sessionWarningTimer = null;
let sessionExpiryTimer = null;
const SESSION_DURATION = 24 * 60 * 60 * 1000; // 24 hours
const WARNING_TIME = 5 * 60 * 1000; // 5 minutes before expiry

function initSessionWarning() {
    // Clear existing timers
    if (sessionWarningTimer) clearTimeout(sessionWarningTimer);
    if (sessionExpiryTimer) clearTimeout(sessionExpiryTimer);

    // Create warning banner
    const warningBanner = document.createElement('div');
    warningBanner.id = 'session-warning';
    warningBanner.className = 'session-warning';
    warningBanner.innerHTML = `
        <div class="session-warning-icon">⏰</div>
        <div class="session-warning-text">
            <strong>Session Expiring Soon</strong>
            <div>Your session will expire in <span class="session-warning-timer" id="sessionTimer">5:00</span></div>
        </div>
        <button class="btn btn-primary" onclick="refreshSession()">Extend Session</button>
    `;
    document.body.appendChild(warningBanner);

    // Show warning 5 minutes before expiry
    sessionWarningTimer = setTimeout(() => {
        showSessionWarning();
    }, SESSION_DURATION - WARNING_TIME);

    // Force logout on expiry
    sessionExpiryTimer = setTimeout(() => {
        showError('Session Expired', 'Your session has expired. Please log in again.');
        setTimeout(() => {
            window.location.href = '/login';
        }, 2000);
    }, SESSION_DURATION);
}

function showSessionWarning() {
    const banner = document.getElementById('session-warning');
    if (banner) {
        banner.classList.add('show');

        // Start countdown timer
        let timeLeft = WARNING_TIME / 1000; // seconds
        const timerEl = document.getElementById('sessionTimer');

        const countdown = setInterval(() => {
            timeLeft--;
            const minutes = Math.floor(timeLeft / 60);
            const seconds = timeLeft % 60;
            if (timerEl) {
                timerEl.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
            }

            if (timeLeft <= 0) {
                clearInterval(countdown);
            }
        }, 1000);
    }
}

async function refreshSession() {
    try {
        if (!window.AdminPanel?.api?.getJson) {
            showError('Failed to Extend', 'Session API helper is unavailable. Please refresh the page.');
            return;
        }

        const response = (await window.AdminPanel.api.getJson('/api/account/info')).response;
        if (response.ok) {
            const banner = document.getElementById('session-warning');
            if (banner) {
                banner.classList.remove('show');
            }

            // Restart timers
            initSessionWarning();
            showSuccess('Session Extended', 'Your session has been extended.');
        }
    } catch (error) {
        showError('Failed to Extend', 'Could not extend your session.');
    }
}

// Initialize on page load
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSessionWarning);
} else {
    initSessionWarning();
}
class ModalManager {
    applyModalWrapperLayout(modal) {
        if (!modal) return;
        modal.style.setProperty('position', 'fixed', 'important');
        modal.style.setProperty('inset', '0', 'important');
        modal.style.setProperty('display', 'grid', 'important');
        modal.style.setProperty('place-items', 'center', 'important');
        modal.style.setProperty('z-index', '9001', 'important');
        modal.style.setProperty('pointer-events', 'auto', 'important');
    }

    showDetails(title = 'Details', htmlContent = '', onClose = null) {
        const modalId = `modal-${Date.now()}`;
        const container = document.getElementById('modal-container');
        if (!container) return null;

        const modalHTML = `
                <div class="modal-overlay" onclick="modalManager.closeModal('${modalId}')"></div>
                <div class="notification-modal">
                    <div class="modal-header">
                        <h3>${title}</h3>
                        <button class="modal-close" onclick="modalManager.closeModal('${modalId}')">×</button>
                    </div>
                    <div class="modal-body">
                        ${htmlContent}
                    </div>
                    <div class="modal-footer">
                        <button class="btn btn-secondary" onclick="modalManager.closeModal('${modalId}')">Close</button>
                    </div>
                </div>
            `;

        const modal = document.createElement('div');
        modal.id = modalId;
        modal.className = 'modal-wrapper';
        modal.innerHTML = modalHTML;
        this.applyModalWrapperLayout(modal);

        container.appendChild(modal);
        setTimeout(() => {
            modal.classList.add('show');
        }, 10);

        this.modals.set(modalId, { modal, onClose });
        return modal;
    }
    constructor() {
        this.modals = new Map();
        this.initContainer();
        this.bindGlobalHandlers();
    }

    getTopModalId() {
        const ids = Array.from(this.modals.keys());
        if (!ids.length) return null;
        return ids[ids.length - 1];
    }

    bindGlobalHandlers() {
        if (typeof document === 'undefined') return;
        if (this._boundEscapeHandler) return;

        this._boundEscapeHandler = (event) => {
            if (event.key !== 'Escape') return;
            const topId = this.getTopModalId();
            if (!topId) return;
            this.closeModal(topId);
        };

        document.addEventListener('keydown', this._boundEscapeHandler);
    }

    initContainer() {
        if (typeof document === 'undefined') return;

        if (!document.getElementById('modal-container')) {
            const container = document.createElement('div');
            container.id = 'modal-container';
            container.className = 'modal-container';
            document.body.appendChild(container);
        }
    }

    toast(message = '', type = 'info', duration = 5000) {
        const normalizedType = ['success', 'error', 'warning', 'info'].includes(type) ? type : 'info';
        const titleMap = {
            success: 'Success',
            error: 'Error',
            warning: 'Warning',
            info: 'Info'
        };

        return showToast(normalizedType, titleMap[normalizedType], message, duration);
    }


    ls(options = {}) {
        if (typeof document === 'undefined') return null;

        const {
            title = 'Details',
            icon = '📋',
            items = [],
            note = null,
            onClose = null
        } = options;

        const modalId = `modal-${Date.now()}`;
        const container = document.getElementById('modal-container');
        if (!container) return null;

        // Build items HTML
        let itemsHTML = '';
        items.forEach((item, index) => {
            const copyBtn = item.copyable ?
                `<button class="copy-btn" onclick="navigator.clipboard.writeText('${item.value.replace(/'/g, "\\'")}'); showSuccess('Copied', '${item.label} copied to clipboard!', 2000)" title="Copy">📋</button>`
                : '';

            itemsHTML += `
                <div class="detail-item">
                    <div class="detail-label">${item.label}</div>
                    <div class="detail-value">
                        <span class="detail-text">${item.value}</span>
                        ${copyBtn}
                    </div>
                </div>
            `;
        });

        // Build note HTML
        const noteHTML = note ? `
            <div class="detail-note">
                <span class="detail-note-icon">ℹ️</span>
                <div class="detail-note-content">${note}</div>
            </div>
        ` : '';

        const modalHTML = `
            <div class="modal-overlay" onclick="modalManager.closeModal('${modalId}')"></div>
            <div class="notification-modal">
                <div class="modal-header">
                    <h3><span class="modal-icon">${icon}</span> ${title}</h3>
                    <button class="modal-close" onclick="modalManager.closeModal('${modalId}')">×</button>
                </div>
                <div class="modal-body">
                    <div class="details-list">
                        ${itemsHTML}
                    </div>
                    ${noteHTML}
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" onclick="modalManager.closeModal('${modalId}')">Close</button>
                </div>
            </div>
        `;

        const modal = document.createElement('div');
        modal.id = modalId;
        modal.className = 'modal-wrapper';
        modal.innerHTML = modalHTML;
        this.applyModalWrapperLayout(modal);

        container.appendChild(modal);

        // Trigger animation
        setTimeout(() => {
            modal.classList.add('show');
        }, 10);

        this.modals.set(modalId, { modal, onClose });

        return modal;
    }

    showConfirm(options = {}, legacyMessage, legacyConfirmText, legacyCancelText, legacyType) {
        let resolvedOptions = options;

        if (typeof options === 'string') {
            resolvedOptions = {
                title: options,
                message: legacyMessage || 'Are you sure?',
                confirmText: legacyConfirmText || 'Confirm',
                cancelText: legacyCancelText || 'Cancel',
                type: legacyType || 'warning'
            };
        }

        const {
            title = 'Confirm Action',
            message: optionMessage = 'Are you sure?',
            confirmText: optionConfirmText = 'Confirm',
            cancelText: optionCancelText = 'Cancel',
            type = 'warning',
            onConfirm = null,
            onCancel = null
        } = resolvedOptions || {};

        return new Promise((resolve) => {
            const modalId = `modal-${Date.now()}`;
            const container = document.getElementById('modal-container');

            const icons = {
                warning: '⚠️',
                danger: '🚨',
                info: 'ℹ️'
            };

            const confirmBtnClass = type === 'danger' ? 'btn-danger' : 'btn-primary';

            const modalHTML = `
                <div class="modal-overlay" onclick="modalManager.closeModal('${modalId}')"></div>
                <div class="notification-modal">
                    <div class="modal-header">
                        <h3><span class="modal-icon">${icons[type]}</span> ${title}</h3>
                        <button class="modal-close" onclick="modalManager.closeModal('${modalId}')">×</button>
                    </div>
                    <div class="modal-body">
                        <p style="font-size: 1rem; color: var(--text-secondary); margin-bottom: 1.5rem;">${optionMessage}</p>
                    </div>
                    <div class="modal-footer">
                        <button class="btn btn-secondary" onclick="modalManager.closeModal('${modalId}')">
                            ${optionCancelText}
                        </button>
                        <button class="btn ${confirmBtnClass}" onclick="modalManager.confirmAction('${modalId}')">
                            ${optionConfirmText}
                        </button>
                    </div>
                </div>
            `;

            const modal = document.createElement('div');
            modal.id = modalId;
            modal.className = 'modal-wrapper';
            modal.innerHTML = modalHTML;
            this.applyModalWrapperLayout(modal);

            container.appendChild(modal);

            setTimeout(() => {
                modal.classList.add('show');
            }, 10);

            this.modals.set(modalId, {
                modal,
                isConfirm: true,
                confirmed: false,
                onConfirm: () => {
                    if (typeof onConfirm === 'function') onConfirm();
                    resolve(true);
                },
                onCancel: () => {
                    if (typeof onCancel === 'function') onCancel();
                    resolve(false);
                }
            });
        });
    }


    confirmAction(modalId) {
        const data = this.modals.get(modalId);
        if (data) {
            data.confirmed = true;
        }
        if (data && data.onConfirm) {
            data.onConfirm();
        }
        this.closeModal(modalId);
    }

    showLoading(message = 'Loading...') {
        const modalId = `modal-${Date.now()}`;
        const container = document.getElementById('modal-container');

        const modalHTML = `
            <div class="modal-overlay"></div>
            <div class="notification-modal" style="pointer-events: none;">
                <div style="text-align: center; padding: 3rem 2rem;">
                    <div class="spinner"></div>
                    <p style="margin-top: 1.5rem; color: var(--text-secondary); font-size: 0.95rem;">${message}</p>
                </div>
            </div>
        `;

        const modal = document.createElement('div');
        modal.id = modalId;
        modal.className = 'modal-wrapper';
        modal.innerHTML = modalHTML;
        this.applyModalWrapperLayout(modal);

        container.appendChild(modal);

        setTimeout(() => {
            modal.classList.add('show');
        }, 10);

        this.modals.set(modalId, { modal });

        return { modalId, close: () => this.closeModal(modalId) };
    }

    closeModal(modalId) {
        const data = this.modals.get(modalId);
        if (!data) return;

        const modal = data.modal;
        modal.style.pointerEvents = 'none';
        modal.classList.remove('show');

        setTimeout(() => {
            modal.remove();
            this.modals.delete(modalId);

            // Call onCancel if it's a confirmation dialog
            if (data.isConfirm && !data.confirmed && data.onCancel) {
                data.onCancel();
            }

            // Call onClose if provided
            if (data.onClose) {
                data.onClose();
            }
        }, 300);
    }

    closeAll() {
        const modalIds = Array.from(this.modals.keys());
        modalIds.forEach(id => this.closeModal(id));
    }
}

// Initialize modal manager (safely - check if document exists)
var modalManager = null;
if (typeof document !== 'undefined') {
    try {
        modalManager = new ModalManager();
        window.modalManager = modalManager;
    } catch (e) {
        console.warn('notifications.js: Could not initialize ModalManager', e);
        // Create a dummy object to prevent errors
        modalManager = {
            showDetails: () => null,
            showConfirm: () => null,
            toast: () => null,
            showLoading: () => ({ modalId: null, close: () => { } }),
            closeModal: () => { },
            closeAll: () => { }
        };
        window.modalManager = modalManager;
    }
}

function showInputModal(label, callback) {
    showPromptModal({
        title: 'Input Required',
        label,
        defaultValue: '',
        placeholder: 'Enter value...'
    }).then((value) => callback(value));
}
window.showInputModal = showInputModal;

function showPromptModal(options = {}) {
    return new Promise((resolve) => {
        const {
            title = 'Input Required',
            label = 'Enter a value',
            placeholder = '',
            defaultValue = '',
            confirmText = 'OK',
            cancelText = 'Cancel',
            inputType = 'text',
            validate = null
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

        // allow extra options: confirmClass and optional checkbox
        const confirmClass = options.confirmClass || 'btn-primary';
        const includeCheckbox = options.includeCheckbox || null; // { label, required, errorText }

        const modalId = `modal-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const modal = document.createElement('div');
        modal.id = modalId;
        modal.className = 'modal-wrapper';
        const inputModeAttr = inputType === 'number' ? 'inputmode="decimal"' : '';

        // optional checkbox HTML
        const checkboxId = `${modalId}-confirm-checkbox`;
        const checkboxHTML = includeCheckbox ? `\
                <div class="modal-confirm-checkbox">\
                    <input id="${checkboxId}" type="checkbox" class="modal-confirm-input" />\
                    <label for="${checkboxId}" class="modal-confirm-label">\
                        <span class="modal-confirm-icon">⚠️</span>\
                        <span class="modal-confirm-text">${String(includeCheckbox.label || '')}</span>\
                    </label>\
                </div>` : '';

        modal.innerHTML = `
            <div class="modal-overlay"></div>
            <div class="notification-modal" role="dialog" aria-modal="true" aria-labelledby="${modalId}-title">
                <div class="modal-header">
                    <h3 id="${modalId}-title">✏️ ${title}</h3>
                    <button class="modal-close" type="button">×</button>
                </div>
                <div class="modal-body">
                    <label for="${modalId}-input" style="display:block; font-weight:600; color:var(--text-primary); margin-bottom:0.45rem;">${label}</label>
                    <input id="${modalId}-input" type="${inputType}" ${inputModeAttr} class="form-input" placeholder="${placeholder}" value="${String(defaultValue).replace(/"/g, '&quot;')}" autocomplete="off" />
                    <div id="${modalId}-error" style="display:none; margin-top:0.5rem; color:var(--color-red); font-size:0.85rem;"></div>
                    ${checkboxHTML}
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" type="button" data-action="cancel">${cancelText}</button>
                    <button class="btn ${confirmClass}" type="button" data-action="confirm">${confirmText}</button>
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

        const input = modal.querySelector(`#${modalId}-input`);
        const errorEl = modal.querySelector(`#${modalId}-error`);
        const closeBtn = modal.querySelector('.modal-close');
        const cancelBtn = modal.querySelector('[data-action="cancel"]');
        const confirmBtn = modal.querySelector('[data-action="confirm"]');
        const checkbox = includeCheckbox ? modal.querySelector(`#${checkboxId}`) : null;

        const cleanup = (value) => {
            modal.classList.remove('show');
            setTimeout(() => {
                modal.remove();
                resolve(value);
            }, 180);
        };

        const onCancel = () => cleanup(null);
        const onConfirm = () => {
            const value = (input?.value ?? '').trim();
            if (includeCheckbox && includeCheckbox.required) {
                if (!checkbox || !checkbox.checked) {
                    errorEl.textContent = includeCheckbox.errorText || 'Please confirm this action.';
                    errorEl.style.display = 'block';
                    return;
                }
            }

            if (typeof validate === 'function') {
                const validation = validate(value);
                if (validation !== true) {
                    errorEl.textContent = typeof validation === 'string' ? validation : 'Invalid input.';
                    errorEl.style.display = 'block';
                    input?.focus();
                    return;
                }
            }
            cleanup(value);
        };

        modal.querySelector('.modal-overlay')?.addEventListener('click', onCancel);
        closeBtn?.addEventListener('click', onCancel);
        cancelBtn?.addEventListener('click', onCancel);
        confirmBtn?.addEventListener('click', onConfirm);
        // manage confirm enable state when checkbox is required
        const updateConfirmState = () => {
            if (!confirmBtn) return;
            if (includeCheckbox && includeCheckbox.required) {
                confirmBtn.disabled = !(checkbox && checkbox.checked);
            } else {
                confirmBtn.disabled = false;
            }
        };
        checkbox?.addEventListener('change', () => {
            errorEl.style.display = 'none';
            updateConfirmState();
        });
        input?.addEventListener('input', () => {
            errorEl.style.display = 'none';
            updateConfirmState();
        });

        updateConfirmState();
        input?.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') onConfirm();
            if (event.key === 'Escape') onCancel();
        });

        container.appendChild(modal);
        setTimeout(() => {
            modal.classList.add('show');
            input?.focus();
            input?.select?.();
        }, 10);
    });
}

if (typeof window !== 'undefined') {
    window.showPromptModal = showPromptModal;
}
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
        document.body.appendChild(container);
    }
    return container;
}

// Create and display a toast message. Provide a `type` (success/error/info/warning),
// a short `title`, and an optional `message`. Returns the toast DOM node.
function showToast(type, title, message, duration = 5000) {
    const container = ensureToastContainer();

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icons = {
        success: '✅',
        error: '❌',
        warning: '⚠️',
        info: 'ℹ️'
    };

    toast.innerHTML = `
        <div class="toast-icon">${icons[type] || icons.info}</div>
        <div class="toast-content">
            <div class="toast-title">${title}</div>
            ${message ? `<div class="toast-message">${message}</div>` : ''}
        </div>
        <button class="toast-close" onclick="this.parentElement.remove()">×</button>
    `;

    container.appendChild(toast);

    // Auto-remove after duration
    if (duration > 0) {
        setTimeout(() => {
            toast.classList.add('removing');
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }

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

/**
 * Show an input modal for info gathering
 * @param {string} label - The label to display above the input
 * @param {function} callback - Callback to receive the input value or null if cancelled
 */
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
                    <input id="${modalId}-input" type="${inputType}" class="form-input" placeholder="${placeholder}" value="${String(defaultValue).replace(/"/g, '&quot;')}" />
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
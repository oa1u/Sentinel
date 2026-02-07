// This is the toast notification system. It gives users real-time feedback and works everywhere.
// Works on every page and won't break if the DOM isn't there. Super robust!

// Double check that the document is ready before running any notification code.
if (typeof document === 'undefined') {
    console.warn('notifications.js: Document not available');
}

// If the toast container isn't there yet, create it so we can show notifications.
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

// Show a toast notification message to the user. Pick the type, title, and message you want.
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

// Helper functions for different toast types
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

//Session Timeout Warning System & warns users about session expiry
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
        const response = await fetch('/api/account/info');
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

        container.appendChild(modal);
        
        // Trigger animation
        setTimeout(() => {
            modal.classList.add('show');
        }, 10);

        this.modals.set(modalId, { modal, onClose });

        return modal;
    }

    showConfirm(options = {}) {
        const {
            title = 'Confirm Action',
            message = 'Are you sure?',
            confirmText = 'Confirm',
            cancelText = 'Cancel',
            type = 'warning', // warning, danger, info
            onConfirm = null,
            onCancel = null
        } = options;

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
                    <p style="font-size: 1rem; color: var(--text-secondary); margin-bottom: 1.5rem;">${message}</p>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" onclick="modalManager.closeModal('${modalId}')">
                        ${cancelText}
                    </button>
                    <button class="btn ${confirmBtnClass}" onclick="modalManager.confirmAction('${modalId}')">
                        ${confirmText}
                    </button>
                </div>
            </div>
        `;

        const modal = document.createElement('div');
        modal.id = modalId;
        modal.className = 'modal-wrapper';
        modal.innerHTML = modalHTML;

        container.appendChild(modal);
        
        setTimeout(() => {
            modal.classList.add('show');
        }, 10);

        this.modals.set(modalId, { modal, onConfirm, onCancel, isConfirm: true });

        return modal;
    }


    confirmAction(modalId) {
        const data = this.modals.get(modalId);
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
        modal.classList.remove('show');

        setTimeout(() => {
            modal.remove();
            this.modals.delete(modalId);
            
            // Call onCancel if it's a confirmation dialog
            if (data.isConfirm && data.onCancel) {
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
let modalManager = null;
if (typeof document !== 'undefined') {
    try {
        modalManager = new ModalManager();
    } catch (e) {
        console.warn('notifications.js: Could not initialize ModalManager', e);
        // Create a dummy object to prevent errors
        modalManager = {
            showDetails: () => null,
            showConfirm: () => null,
            showLoading: () => ({ modalId: null, close: () => {} }),
            closeModal: () => {},
            closeAll: () => {}
        };
    }
}
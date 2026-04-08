(function () {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
        return;
    }

    const DEFAULT_DURATION = 5000;
    const MIN_DURATION = 800;
    const REMOVE_ANIMATION_MS = 300;
    const ICONS = {
        success: '&#9989;',
        error: '&#10060;',
        warning: '&#9888;&#65039;',
        info: '&#8505;&#65039;'
    };
    const TITLES = {
        success: 'Success',
        error: 'Error',
        warning: 'Warning',
        info: 'Info'
    };

    function normalizeType(type) {
        return Object.prototype.hasOwnProperty.call(TITLES, type) ? type : 'info';
    }

    function normalizeDuration(duration) {
        const parsed = Number(duration);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            return DEFAULT_DURATION;
        }
        return Math.max(MIN_DURATION, parsed);
    }

    function ensureContainer() {
        let container = document.getElementById('toast-container');
        if (container) {
            return container;
        }

        container = document.createElement('div');
        container.id = 'toast-container';
        container.className = 'toast-container';
        document.body.appendChild(container);
        return container;
    }

    function removeToast(toast) {
        if (!toast || toast.dataset.removing === 'true') {
            return;
        }

        toast.dataset.removing = 'true';
        if (toast._dismissTimer) {
            window.clearTimeout(toast._dismissTimer);
            toast._dismissTimer = null;
        }

        toast.classList.add('removing');
        window.setTimeout(() => {
            toast.remove();
        }, REMOVE_ANIMATION_MS);
    }

    function createProgressBar(duration) {
        const progress = document.createElement('div');
        progress.className = 'toast-progress';

        const inner = document.createElement('div');
        inner.className = 'toast-progress-inner';
        inner.style.width = '100%';
        progress.appendChild(inner);

        return progress;
    }

    function startProgressBar(toast, duration) {
        const inner = toast && toast.querySelector ? toast.querySelector('.toast-progress-inner') : null;
        if (!inner) {
            return;
        }

        inner.style.transition = 'none';
        inner.style.width = '100%';
        void inner.offsetWidth;

        window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => {
                inner.style.transition = `width ${duration}ms linear`;
                inner.style.width = '0%';
            });
        });
    }

    function buildToast(type, title, message, duration) {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;

        const icon = document.createElement('div');
        icon.className = 'toast-icon';
        icon.innerHTML = ICONS[type] || ICONS.info;

        const content = document.createElement('div');
        content.className = 'toast-content';

        const titleEl = document.createElement('div');
        titleEl.className = 'toast-title';
        titleEl.textContent = title;
        content.appendChild(titleEl);

        if (message) {
            const messageEl = document.createElement('div');
            messageEl.className = 'toast-message';
            messageEl.textContent = message;
            content.appendChild(messageEl);
        }

        content.appendChild(createProgressBar(duration));

        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.className = 'toast-close';
        closeButton.setAttribute('aria-label', 'Close notification');
        closeButton.innerHTML = '&times;';
        closeButton.addEventListener('click', () => removeToast(toast));

        toast.appendChild(icon);
        toast.appendChild(content);
        toast.appendChild(closeButton);

        return toast;
    }

    function normalizeHelperArgs(type, firstArg, secondArg, thirdArg) {
        if (typeof secondArg === 'string') {
            return {
                type,
                title: firstArg || TITLES[type],
                message: secondArg,
                duration: normalizeDuration(thirdArg)
            };
        }

        return {
            type,
            title: TITLES[type],
            message: firstArg || '',
            duration: normalizeDuration(typeof secondArg === 'number' ? secondArg : thirdArg)
        };
    }

    function showToast(type, title, message, duration) {
        const normalizedType = normalizeType(type);

        let resolvedTitle = title;
        let resolvedMessage = message;
        let resolvedDuration = duration;

        if (resolvedMessage === undefined) {
            if (typeof resolvedTitle === 'number') {
                resolvedDuration = resolvedTitle;
                resolvedTitle = TITLES[normalizedType];
                resolvedMessage = '';
            } else {
                resolvedMessage = resolvedTitle || '';
                resolvedTitle = TITLES[normalizedType];
            }
        }

        const safeTitle = String(resolvedTitle || TITLES[normalizedType]);
        const safeMessage = resolvedMessage == null ? '' : String(resolvedMessage);
        const safeDuration = normalizeDuration(resolvedDuration);
        const container = ensureContainer();
        const toast = buildToast(normalizedType, safeTitle, safeMessage, safeDuration);

        container.appendChild(toast);
        startProgressBar(toast, safeDuration);
        toast._dismissTimer = window.setTimeout(() => removeToast(toast), safeDuration);

        return toast;
    }

    window.showToast = showToast;
    window.showNotification = function showNotification(message, type = 'info', duration) {
        const normalizedType = normalizeType(type);
        return showToast(normalizedType, TITLES[normalizedType], message, duration);
    };
    window.showSuccess = function showSuccess(titleOrMessage, messageOrDuration, duration) {
        const args = normalizeHelperArgs('success', titleOrMessage, messageOrDuration, duration);
        return showToast(args.type, args.title, args.message, args.duration);
    };
    window.showError = function showError(titleOrMessage, messageOrDuration, duration) {
        const args = normalizeHelperArgs('error', titleOrMessage, messageOrDuration, duration);
        return showToast(args.type, args.title, args.message, args.duration);
    };
    window.showWarning = function showWarning(titleOrMessage, messageOrDuration, duration) {
        const args = normalizeHelperArgs('warning', titleOrMessage, messageOrDuration, duration);
        return showToast(args.type, args.title, args.message, args.duration);
    };
    window.showInfo = function showInfo(titleOrMessage, messageOrDuration, duration) {
        const args = normalizeHelperArgs('info', titleOrMessage, messageOrDuration, duration);
        return showToast(args.type, args.title, args.message, args.duration);
    };

    window.analyticsShowNotificationation = window.showNotification;
    window.profileShowSuccess = window.showSuccess;
    window.profileShowError = window.showError;
})();
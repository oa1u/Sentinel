(function () {
    if (window.SecurityUtils) {
        return;
    }

    const CONFIG = {
        CSRF_HEADER: 'x-csrf-token',
        CSRF_ENDPOINT: '/api/csrf',
        MAX_RETRIES: 1
    };


    let _csrfTokenCache = null;
    let _tokenPromise = null;
    let _isFetching = false;

    async function fetchNewToken() {
        if (_tokenPromise) return _tokenPromise;

        _isFetching = true;
        _tokenPromise = fetch(CONFIG.CSRF_ENDPOINT, { credentials: 'include' })
            .then(async res => {
                if (!res.ok) {
                    const txt = await res.text().catch(() => 'No response body');
                    console.error('[Security] /api/csrf failed:', res.status, txt);
                    throw new Error(`CSRF endpoint returned ${res.status}`);
                }
                return res.json();
            })
            .then(data => {
                if (data && data.csrfToken) {
                    _csrfTokenCache = data.csrfToken;
                    const meta = document.querySelector('meta[name="csrf-token"]');
                    if (meta) meta.setAttribute('content', data.csrfToken);

                    return data.csrfToken;
                }
                throw new Error('Failed to retrieve CSRF token from valid JSON response');
            })
            .catch(err => {
                console.error('[Security] CSRF fetch error:', err);
                return null;
            })
            .finally(() => {
                _tokenPromise = null;
                _isFetching = false;
            });

        return _tokenPromise;
    }

    async function getCsrfToken(forceRefresh = false) {
        if (window.AdminPanel?.api?.getCsrfToken) {
            return window.AdminPanel.api.getCsrfToken(forceRefresh);
        }
        if (!forceRefresh && _csrfTokenCache && typeof _csrfTokenCache === 'string' && _csrfTokenCache.length > 10) {
            return _csrfTokenCache;
        }

        if (!forceRefresh) {
            const match = document.cookie.match(/(?:^|;\s*)csrfToken=([^;]+)/);
            if (match && match[1]) {
                const cookieToken = decodeURIComponent(match[1]);
                if (cookieToken && cookieToken.length > 10) {
                    _csrfTokenCache = cookieToken;
                    return _csrfTokenCache;
                }
            }
        }

        return fetchNewToken();
    }

    function formatBytes(bytes, decimals = 2) {
        if (bytes === 0 || isNaN(bytes)) return '0 Bytes';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    }
    function formatNumber(num) {
        if (typeof num !== 'number') num = Number(num);
        if (isNaN(num)) return '0';
        return num.toLocaleString();
    }
    function fetchWithCsrf(url, options = {}) {
        return secureApiCall(url, options);
    }
    if (typeof window !== 'undefined') {
        window.fetchWithCsrf = fetchWithCsrf;
    }

    function escapeHtml(text) {
        if (text === null || text === undefined) return '';

        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return String(text).replace(/[&<>"']/g, m => map[m]);
    }

    function sanitizeInput(input) {
        if (typeof input !== 'string') return '';

        let sanitized = input
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
            .replace(/on\w+\s*=\s*["'][^"']*["']/gi, '')
            .replace(/on\w+\s*=\s*[^\s>]*/gi, '');

        return sanitized.trim();
    }


    function isValidUserId(userId) {
        if (typeof userId !== 'string') return false;
        userId = userId.trim();
        return /^\d{17,19}$/.test(userId);
    }

    function isValidText(text, minLength = 1, maxLength = 500) {
        if (typeof text !== 'string') return false;
        const trimmed = text.trim();
        return trimmed.length >= minLength && trimmed.length <= maxLength;
    }

    function isValidNumber(value, min = 0, max = Infinity) {
        const num = Number(value);
        return Number.isInteger(num) && num >= min && num <= max;
    }

    function isValidEmail(email) {
        if (typeof email !== 'string') return false;
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(email);
    }


    async function secureApiCall(url, options = {}) {
        const isMutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(
            (options.method || 'GET').toUpperCase()
        );

        let token = await getCsrfToken();
        if (!token && isMutating) {
            console.warn('[Security] Token missing from cache/cookie, fetching fresh one...');
            token = await fetchNewToken();
        }

        const headers = new Headers(options.headers || {});
        if (!headers.has('Content-Type')) {
            headers.set('Content-Type', 'application/json');
        }

        if (token) {
            headers.set(CONFIG.CSRF_HEADER, token);
        } else if (isMutating) {
            console.error('[Security] CRITICAL: Mutating request blocked. CSRF token could not be obtained.');
            throw new Error('CSRF Token missing - Request blocked by security policy');
        }

        const fetchConfig = {
            ...options,
            headers,
            credentials: 'include'
        };

        try {
            let response = await fetch(url, fetchConfig);

            if (response.status === 403 && isMutating && !options._retry) {
                console.warn('[Security] CSRF invalid/expired. Attempting refresh...');

                const freshToken = await fetchNewToken();
                if (freshToken) {
                    headers.set(CONFIG.CSRF_HEADER, freshToken);

                    const retryConfig = {
                        ...options,
                        headers,
                        credentials: 'include',
                        _retry: true
                    };

                    response = await fetch(url, retryConfig);
                }
            }

            if (response.status === 401) {
                console.warn('[Security] 401 Unauthorized. Redirecting to login...');
                window.location.href = '/login?redirect=' + encodeURIComponent(window.location.pathname);
                return new Promise(() => { });
            }

            if (!response.ok) {
            }

            return response;
        } catch (error) {
            console.error('[Security] Network Request Failed:', error);
            throw error;
        }
    }


    async function securePost(url, data) {
        return secureApiCall(url, {
            method: 'POST',
            body: JSON.stringify(data)
        });
    }


    async function secureDelete(url) {
        return secureApiCall(url, {
            method: 'DELETE'
        });
    }

    class RateLimiter {
        constructor(maxRequests = 10, windowMs = 60000) {
            this.maxRequests = maxRequests;
            this.windowMs = windowMs;
            this.requests = [];
        }

        isAllowed() {
            const now = Date.now();
            this.requests = this.requests.filter(time => now - time < this.windowMs);
            if (this.requests.length < this.maxRequests) {
                this.requests.push(now);
                return true;
            }
            return false;
        }

        getRetryAfter() {
            if (this.requests.length === 0) return 0;
            const oldestRequest = this.requests[0];
            return Math.max(0, this.windowMs - (Date.now() - oldestRequest));
        }
    }

    if (typeof window !== 'undefined') {
        window.RateLimiter = RateLimiter;
    }

    const apiRateLimiters = {
        warn: new RateLimiter(10, 60000),
        ban: new RateLimiter(5, 60000),
        timeout: new RateLimiter(10, 60000),
        delete: new RateLimiter(15, 60000)
    };


    function checkRateLimit(operation) {
        const limiter = apiRateLimiters[operation];
        if (!limiter) return { allowed: true, retryAfter: 0 };

        if (limiter.isAllowed()) {
            return { allowed: true, retryAfter: 0 };
        }

        return { allowed: false, retryAfter: limiter.getRetryAfter() };
    }



    function validateModerationForm(userId, reason) {
        if (!userId || !reason) {
            return { valid: false, error: 'All fields are required' };
        }

        if (!isValidUserId(userId)) {
            return { valid: false, error: 'Invalid User ID format (must be 17-19 digits)' };
        }

        if (!isValidText(reason, 1, 500)) {
            return { valid: false, error: 'Reason must be 1-500 characters' };
        }

        return { valid: true };
    }


    function validateWarnForm(userId, reason) {
        return validateModerationForm(userId, reason);
    }


    function validateBanForm(userId, reason) {
        return validateModerationForm(userId, reason);
    }


    function validateTimeoutForm(userId, duration, reason) {
        if (!userId || !duration || !reason) {
            return { valid: false, error: 'All fields are required' };
        }

        if (!isValidUserId(userId)) {
            return { valid: false, error: 'Invalid User ID format' };
        }

        if (!isValidNumber(duration, 1, 2419200)) {
            return { valid: false, error: 'Duration must be between 1 second and 28 days' };
        }

        if (!isValidText(reason, 1, 500)) {
            return { valid: false, error: 'Reason must be 1-500 characters' };
        }

        return { valid: true };
    }



    function showError(message, duration = 5000) {
        const sanitized = escapeHtml(message);

        if (typeof window.showError === 'function' && window.showError !== showError) {
            window.showError(sanitized, duration);
        }

        const alertElement = document.getElementById('errorAlert');
        if (alertElement) {
            alertElement.textContent = sanitized;
            alertElement.style.display = 'block';

            if (duration > 0) {
                setTimeout(() => {
                    alertElement.style.display = 'none';
                }, duration);
            }
            return;
        }

        console.error(sanitized);
    }



    function formatDuration(seconds) {
        if (!seconds || seconds < 0) return '0s';

        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;

        const parts = [];
        if (days > 0) parts.push(`${days}d`);
        if (hours > 0) parts.push(`${hours}h`);
        if (minutes > 0) parts.push(`${minutes}m`);
        if (secs > 0) parts.push(`${secs}s`);

        return parts.length > 0 ? parts.join(' ') : '0s';
    }


    function formatDate(date) {
        try {
            return new Date(date).toLocaleString();
        } catch {
            return 'Invalid date';
        }
    }


    if (typeof window !== 'undefined') {
        window.secureApiCall = secureApiCall;
        window.securePost = securePost;
        window.secureDelete = secureDelete;
        window.SecurityUtils = {
            escapeHtml,
            sanitizeInput,
            isValidUserId,
            isValidText,
            isValidNumber,
            isValidEmail,
            secureApiCall,
            securePost,
            secureDelete,
            validateModerationForm,
            validateWarnForm,
            validateBanForm,
            validateTimeoutForm,
            formatNumber,
            formatBytes,
            formatDuration,
            formatDate,
            RateLimiter,
            checkRateLimit
        };
    }



    function switchTab(e, tabName) {
        e.preventDefault();

        document.querySelectorAll('.tab-content').forEach(tab => {
            tab.classList.remove('active');
        });

        document.querySelectorAll('.tab').forEach(btn => {
            btn.classList.remove('active');
        });

        const selectedTab = document.getElementById(tabName);
        if (selectedTab) {
            selectedTab.classList.add('active');
        }
        if (e.target && e.target.classList) {
            e.target.classList.add('active');
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        document.querySelectorAll('.tab').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const tabName = e.target.dataset.tab;
                if (tabName) {
                    switchTab(e, tabName);
                }
            });
        });
    });

})();
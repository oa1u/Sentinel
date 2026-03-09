(function () {
    // Advanced Security Utilities with Singleton Pattern
    if (window.SecurityUtils) {
        // If already initialized, we can just return.
        // The warning is unnecessary if we simply treat this as a no-op or module pattern.
        return;
    }

    const CONFIG = {
        CSRF_HEADER: 'x-csrf-token',
        CSRF_ENDPOINT: '/api/csrf',
        MAX_RETRIES: 1
    };


    let _csrfTokenCache = null;
    let _tokenPromise = null;
    let _isFetching = false; // Add explicit flag

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
                    // Also update any meta tags if present
                    const meta = document.querySelector('meta[name="csrf-token"]');
                    if (meta) meta.setAttribute('content', data.csrfToken);

                    return data.csrfToken;
                }
                throw new Error('Failed to retrieve CSRF token from valid JSON response');
            })
            .catch(err => {
                console.error('[Security] CSRF fetch error:', err);
                return null; // Return null on failure
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
        // If we have a cached token and invalidation is not forced, use it.
        // We also check if the token looks vaguely valid (non-empty string)
        if (!forceRefresh && _csrfTokenCache && typeof _csrfTokenCache === 'string' && _csrfTokenCache.length > 10) {
            return _csrfTokenCache;
        }

        // Try reading from cookie first if not forcing refresh
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

        // Otherwise fetch from API
        return fetchNewToken();
    }

    // Format bytes as human-readable string (e.g., 1.2 MB)
    function formatBytes(bytes, decimals = 2) {
        if (bytes === 0 || isNaN(bytes)) return '0 Bytes';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    }
    // Format a number with commas (e.g., 1,234,567)
    function formatNumber(num) {
        if (typeof num !== 'number') num = Number(num);
        if (isNaN(num)) return '0';
        return num.toLocaleString();
    }
    // Helper for legacy code: fetchWithCsrf (alias for secureApiCall)
    function fetchWithCsrf(url, options = {}) {
        return secureApiCall(url, options);
    }
    if (typeof window !== 'undefined') {
        window.fetchWithCsrf = fetchWithCsrf;
    }
    // Security utilities for the admin panel: XSS protection, input validation, and secure API calls

    // Escape HTML entities to prevent XSS attacks
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

    // Remove dangerous tags and attributes from user input
    function sanitizeInput(input) {
        if (typeof input !== 'string') return '';

        // Remove any script tags and dangerous attributes
        let sanitized = input
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
            .replace(/on\w+\s*=\s*["'][^"']*["']/gi, '')
            .replace(/on\w+\s*=\s*[^\s>]*/gi, '');

        return sanitized.trim();
    }

    // Input validation helpers

    // Check if a string is a valid Discord User ID
    function isValidUserId(userId) {
        if (typeof userId !== 'string') return false;
        userId = userId.trim();
        return /^\d{17,19}$/.test(userId);
    }

    // Check if a string is a valid reason or message
    function isValidText(text, minLength = 1, maxLength = 500) {
        if (typeof text !== 'string') return false;
        const trimmed = text.trim();
        return trimmed.length >= minLength && trimmed.length <= maxLength;
    }

    // Check if a value is a valid integer within a range
    function isValidNumber(value, min = 0, max = Infinity) {
        const num = Number(value);
        return Number.isInteger(num) && num >= min && num <= max;
    }

    // Check if a string is a valid email address
    function isValidEmail(email) {
        if (typeof email !== 'string') return false;
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(email);
    }

    // The best secure api calls

    // Make secure API request with token refresh support
    async function secureApiCall(url, options = {}) {
        const isMutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(
            (options.method || 'GET').toUpperCase()
        );

        // Initial token fetch attempt
        let token = await getCsrfToken();
        if (!token && isMutating) {
            // If we have no token but need one, fetch it explicitly
            console.warn('[Security] Token missing from cache/cookie, fetching fresh one...');
            token = await fetchNewToken();
        }

        // Default headers
        const headers = new Headers(options.headers || {});
        if (!headers.has('Content-Type')) {
            headers.set('Content-Type', 'application/json');
        }

        if (token) {
            headers.set(CONFIG.CSRF_HEADER, token);
        } else if (isMutating) {
            console.error('[Security] CRITICAL: Mutating request blocked. CSRF token could not be obtained.');
            // Prevent the request from being sent to avoid confusing "Token not found" errors on backend
            throw new Error('CSRF Token missing - Request blocked by security policy');
        }

        const fetchConfig = {
            ...options,
            headers,
            credentials: 'include'
        };

        try {
            let response = await fetch(url, fetchConfig);

            // Advanced Self-Healing: If 403 Forbidden due to CSRF failure
            if (response.status === 403 && isMutating && !options._retry) {
                console.warn('[Security] CSRF invalid/expired. Attempting refresh...');

                // Wait for a fresh token
                const freshToken = await fetchNewToken();
                if (freshToken) {
                    headers.set(CONFIG.CSRF_HEADER, freshToken);

                    // Retry request with fresh token
                    const retryConfig = {
                        ...options,
                        headers,
                        credentials: 'include',
                        _retry: true // Prevent infinite loops
                    };

                    response = await fetch(url, retryConfig);
                }
            }

            // Global Unauthorized Handler
            if (response.status === 401) {
                console.warn('[Security] 401 Unauthorized. Redirecting to login...');
                window.location.href = '/login?redirect=' + encodeURIComponent(window.location.pathname);
                // Return a promise that never resolves (or specific error) to stop execution flow
                return new Promise(() => { });
            }

            if (!response.ok) {
                // Optional: You could throw here if you prefer promise rejection for errors
                // but standard fetch behavior is to resolve unless network error.
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
            // Remove old requests outside the window
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

    // Make globally available immediately for internal use
    if (typeof window !== 'undefined') {
        window.RateLimiter = RateLimiter;
    }

    // Create rate limiters for different operations
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

    // form validation


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

    // Ui helper


    function showError(message, duration = 5000) {
        const sanitized = escapeHtml(message);

        // Try to use existing alert if available
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

        // Fallback to console
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


    // Make functions globally available if needed
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
            // showError, showSuccess, showInfo are provided globally by notifications.js
            formatNumber,
            formatBytes,
            formatDuration,
            formatDate,
            RateLimiter,
            checkRateLimit
        };
    }

    // Tab switching logic for the admin panel


    function switchTab(e, tabName) {
        e.preventDefault();

        // Hide all tabs
        document.querySelectorAll('.tab-content').forEach(tab => {
            tab.classList.remove('active');
        });

        // Remove active class from buttons
        document.querySelectorAll('.tab').forEach(btn => {
            btn.classList.remove('active');
        });

        // Show selected tab
        const selectedTab = document.getElementById(tabName);
        if (selectedTab) {
            selectedTab.classList.add('active');
        }
        if (e.target && e.target.classList) {
            e.target.classList.add('active');
        }
    }

    // Attach event listeners to tabs when DOM is ready
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
(function () {
    const ui = {
        setPanelEmoji: function (emoji) {
            document.querySelectorAll('#PanelEmoji').forEach(el => {
                el.textContent = emoji;
            });
        },
        showMessage(element, message, type) {
            if (!element) return;
            element.textContent = message;
            element.classList.remove('hidden');
            if (type === 'error') {
                element.classList.add('error');
                element.classList.remove('success');
            } else if (type === 'success') {
                element.classList.add('success');
                element.classList.remove('error');
            }
        },
        hideMessage(element) {
            if (!element) return;
            element.classList.add('hidden');
        },
        setLoading(element, show) {
            if (!element) return;
            if (show) {
                element.classList.add('show');
            } else {
                element.classList.remove('show');
            }
        },
        setText(id, value) {
            const el = document.getElementById(id);
            if (el) el.textContent = value;
        }
    };

    // Load PanelEmoji from config and set it
    fetch('/Config/main.json')
        .then(response => response.json())
        .then(config => {
            if (config.PanelEmoji) {
                ui.setPanelEmoji(config.PanelEmoji);
            }
            // Populate `.websiteName` placeholders on pages that include this shared script
            try {
                const websiteName = config.websiteName;
                if (websiteName) {
                    const applyName = () => {
                        const nodes = document.querySelectorAll('.websiteName');
                        if (nodes && nodes.length) nodes.forEach(n => { n.textContent = websiteName; });

                        // Also support pages that use an ID-based placeholder for the website name
                        try {
                            const footer = document.getElementById('websiteNameFooter');
                            if (footer) footer.textContent = websiteName;
                        } catch (e) {
                            // ignore
                        }
                    };
                    if (document.readyState === 'loading') {
                        document.addEventListener('DOMContentLoaded', applyName);
                    } else {
                        applyName();
                    }
                }
            } catch (e) {
                // ignore DOM issues in non-browser contexts
            }

            // Set the document title using the same rules previously in AdminPanelHelper.browser.js
            try {
                const websiteName = config.websiteName;
                const titleElem = document.getElementById('websiteNameTitle');
                if (titleElem && websiteName) {
                    let baseTitle = titleElem.textContent.trim();
                    if (!baseTitle) baseTitle = document.title;
                    const leftFirst = ["Login", "Register", "Recovery"];
                    const rightFirst = ["Admin Panel", "Moderator", "Owner", "Dashboard", "Changelog", "Features", "FAQ", "License", "Profile", "Unauthorized Access", "Privacy Policy", "Getting Started", "Moderation Playbook"];
                    if (leftFirst.includes(baseTitle)) {
                        document.title = `${websiteName} - ${baseTitle}`;
                    } else if (rightFirst.includes(baseTitle)) {
                        document.title = `${baseTitle} - ${websiteName}`;
                    } else {
                        document.title = `${websiteName} - ${baseTitle}`;
                    }
                }
            } catch (e) {
                // ignore title-setting failures
            }
        });

    function isMutatingMethod(method) {
        const normalized = String(method || 'GET').toUpperCase();
        return normalized === 'POST' || normalized === 'PUT' || normalized === 'PATCH' || normalized === 'DELETE';
    }

    function isCsrfFailure(response, data) {
        if (!response || response.status !== 403) return false;
        const message = String(data?.error || data?.message || '').toLowerCase();
        return message.includes('csrf');
    }

    function isPublicAuthPage() {
        const pathName = String(window.location?.pathname || '').toLowerCase();
        return pathName === '/login'
            || pathName === '/register'
            || pathName === '/recovery'
            || pathName === '/appeal'
            || pathName === '/unauthorized';
    }

    function isPublicApiPath(url) {
        const normalized = normalizeApiPath(url);
        const publicPaths = new Set([
            '/api/login',
            '/api/login/recovery',
            '/api/logout',
            '/api/register',
            '/api/account/password-reset/request',
            '/api/account/password-reset/confirm',
            '/api/account/password-reset/recovery',
            '/api/email/verify',
            '/api/csrf',
            '/api/appeals/submit',
            '/api/appeals/validate-case-id',
            '/api/appeals/check-status',
            '/api/appeals/my-history',
            '/api/rules'
        ]);
        return publicPaths.has(normalized);
    }

    function normalizeApiPath(url) {
        const raw = String(url || '').trim();
        if (!raw) return '';

        let pathOnly = raw;
        try {
            if (/^https?:\/\//i.test(raw)) {
                const parsed = new URL(raw);
                pathOnly = parsed.pathname;
            }
        } catch {
            pathOnly = raw;
        }

        pathOnly = pathOnly.split('?')[0].trim();
        if (!pathOnly) return '';

        if (pathOnly.startsWith('api/')) {
            return `/${pathOnly}`;
        }

        return pathOnly;
    }

    function normalizeRequestUrl(url) {
        const raw = String(url || '').trim();
        if (!raw) return raw;
        if (/^https?:\/\//i.test(raw)) return raw;
        if (raw.startsWith('api/')) return `/${raw}`;
        return raw;
    }

    function isSessionExpiredResponse(response, data) {
        if (!response || response.status !== 401) return false;
        const message = String(data?.error || data?.message || '').toLowerCase();
        return message.includes('session expired')
            || message.includes('session invalidated')
            || message.includes('unauthorized')
            || message.includes('please sign in again');
    }

    function showSessionExpiryNotice() {
        const title = 'Session Expired';
        const message = 'Your session expired. Redirecting...';

        if (typeof window.showWarning === 'function') {
            window.showWarning(title, message, 1200);
            return;
        }

        if (typeof window.showToast === 'function') {
            window.showToast('warning', title, message, 1200);
        }
    }

    function handleSessionExpired(url, response, data) {
        if (!isSessionExpiredResponse(response, data)) return;
        if (isPublicAuthPage()) return;
        if (isPublicApiPath(url)) return;
        if (window.__adminPanelSessionRedirecting) return;

        window.__adminPanelSessionRedirecting = true;
        showSessionExpiryNotice();
        window.setTimeout(() => {
            window.location.href = '/unauthorized';
        }, 900);
    }

    function decodeCookieValue(value) {
        if (typeof value !== 'string') return '';
        const trimmed = value.trim().replace(/^"|"$/g, '');
        try {
            return decodeURIComponent(trimmed);
        } catch {
            return trimmed;
        }
    }

    function cacheCsrfToken(token) {
        if (!token || typeof token !== 'string') return '';
        window._cachedCsrfToken = token;
        try {
            document.cookie = `csrfToken=${encodeURIComponent(token)}; path=/; SameSite=Strict`;
        } catch {
        }
        const meta = document.querySelector('meta[name="csrf-token"]');
        if (meta) meta.setAttribute('content', token);
        return token;
    }

    function isTokenFormatValid(token) {
        if (!token || typeof token !== 'string') return false;
        return token.split(':').length === 4;
    }

    function isTokenLikelyExpired(token) {
        if (!isTokenFormatValid(token)) return true;
        const parts = token.split(':');
        const timestampStr = parts[1];
        const timestamp = Number.parseInt(timestampStr, 36);
        if (!Number.isFinite(timestamp)) return true;

        const ageMs = Date.now() - timestamp;
        if (ageMs < 0) return false;

        // Server max age is 60 minutes; refresh early to avoid 403 + retry noise.
        const refreshBeforeMs = 55 * 60 * 1000;
        return ageMs >= refreshBeforeMs;
    }

    async function requestJson(url, options = {}) {
        const requestUrl = normalizeRequestUrl(url);
        const fetchOptions = { ...options, credentials: 'include' };
        const method = String(fetchOptions.method || 'GET').toUpperCase();

        if (isMutatingMethod(method)) {
            const existingHeaders = fetchOptions.headers || {};
            const headerLookup = Object.keys(existingHeaders).reduce((acc, key) => {
                acc[key.toLowerCase()] = existingHeaders[key];
                return acc;
            }, {});

            if (!headerLookup['x-csrf-token']) {
                const csrfToken = await getCsrfToken();
                if (csrfToken) {
                    fetchOptions.headers = {
                        ...existingHeaders,
                        'x-csrf-token': csrfToken
                    };
                }
            }
        }

        const response = await fetch(requestUrl, fetchOptions);
        const data = await response.json().catch(() => null);
        handleSessionExpired(requestUrl, response, data);

        if (isMutatingMethod(method) && !fetchOptions._csrfRetried && isCsrfFailure(response, data)) {
            const refreshedToken = await getCsrfToken(true);
            if (refreshedToken) {
                const retryHeaders = {
                    ...(fetchOptions.headers || {}),
                    'x-csrf-token': refreshedToken
                };
                return requestJson(requestUrl, {
                    ...fetchOptions,
                    headers: retryHeaders,
                    _csrfRetried: true
                });
            }
        }

        return { response, data };
    }

    async function getCsrfToken(forceRefresh = false) {
        if (!forceRefresh && typeof window._cachedCsrfToken === 'string' && window._cachedCsrfToken) {
            if (isTokenFormatValid(window._cachedCsrfToken) && !isTokenLikelyExpired(window._cachedCsrfToken)) {
                return window._cachedCsrfToken;
            }
        }

        if (!forceRefresh) {
            const match = document.cookie.match(/(?:^|; )csrfToken=([^;]+)/);
            if (match && match[1]) {
                const tokenFromCookie = decodeCookieValue(match[1]);
                if (isTokenFormatValid(tokenFromCookie) && !isTokenLikelyExpired(tokenFromCookie)) {
                    return cacheCsrfToken(tokenFromCookie);
                }
            }
        }

        const res = await fetch('/api/csrf', { credentials: 'include' });
        const data = await res.json().catch(() => null);
        if (data?.csrfToken) {
            return cacheCsrfToken(data.csrfToken);
        }
        return '';
    }

    async function postJson(url, body, options = {}) {
        const csrfToken = await getCsrfToken();
        return requestJson(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                ...(options.headers || {})
            },
            body: JSON.stringify(body),
            ...options
        });
    }

    async function getJson(url, options = {}) {
        return requestJson(url, { method: 'GET', ...options });
    }

    async function getAccountInfo() {
        const { response, data } = await requestJson('/api/account/info');
        if (!response || !response.ok) return {};
        if (typeof data === 'object' && data !== null) {
            // If backend returns {success: true, ...}, remove only-success objects
            if (data.username && data.role) return data;
            return {};
        }
        return {};
    }

    function applyRoleVisibility(data, options = {}) {
        const role = (data?.role || 'user').toLowerCase();
        const {
            moderatorLinkId = 'moderatorLink',
            adminLinkId = 'adminLink',
            ownerLinkId = 'ownerLink',
            ownerNavLinkId = 'ownerNavLink',
            analyticsLinkId = 'analyticsLink'
        } = options;

        const moderatorLink = moderatorLinkId ? document.getElementById(moderatorLinkId) : null;
        const adminLink = adminLinkId ? document.getElementById(adminLinkId) : null;
        const ownerLink = ownerLinkId ? document.getElementById(ownerLinkId) : null;
        const ownerNavLink = ownerNavLinkId ? document.getElementById(ownerNavLinkId) : null;
        const analyticsLink = analyticsLinkId ? document.getElementById(analyticsLinkId) : null;
        const allAnalyticsLinks = Array.from(document.querySelectorAll('a[href="/analytics"], a[href="/analytics/"]'));
        const dropdownAnalyticsLinks = Array.from(document.querySelectorAll('.user-dropdown-menu a[href="/analytics"], .user-dropdown-menu a[href="/analytics/"]'));

        if (moderatorLink) {
            moderatorLink.style.display = (role === 'moderator' || role === 'admin' || role === 'owner') ? 'block' : 'none';
        }
        if (adminLink) {
            adminLink.style.display = (role === 'admin' || role === 'owner') ? 'block' : 'none';
        }
        if (ownerLink) {
            ownerLink.style.display = (role === 'owner') ? 'block' : 'none';
        }
        if (ownerNavLink) {
            ownerNavLink.style.display = (role === 'owner') ? 'block' : 'none';
        }
        if (analyticsLink) {
            analyticsLink.style.display = (role === 'owner') ? 'block' : 'none';
        }
        allAnalyticsLinks.forEach((linkEl) => {
            linkEl.style.display = (role === 'owner') ? '' : 'none';
        });
        dropdownAnalyticsLinks.forEach((linkEl) => {
            linkEl.style.display = (role === 'owner') ? 'block' : 'none';
        });
    }

    async function logout() {
        try {
            await requestJson('/api/logout', { method: 'POST' });
        } finally {
            window.location.href = '/login';
        }
    }

    window.AdminPanel = {
        ui,
        api: {
            requestJson,
            postJson,
            getJson,
            getCsrfToken,
            getAccountInfo,
            applyRoleVisibility,
            logout
        }
    };

    const syncRoleVisibility = () => {
        const hasDropdownMenu = Boolean(document.querySelector('.user-dropdown-menu'));
        if (!hasDropdownMenu) return;

        getAccountInfo()
            .then((accountInfo) => {
                applyRoleVisibility(accountInfo || {});
            })
            .catch(() => {
                applyRoleVisibility({ role: 'user' });
            });
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', syncRoleVisibility);
    } else {
        syncRoleVisibility();
    }

    const AUTO_REFRESH_MS = 30 * 1000;
    function shouldAutoRefresh() {
        if (isPublicAuthPage()) return false;
        if (window.__disableAutoRefresh) return false;
        return true;
    }

    function triggerVisibleDataRefresh() {
        if (!shouldAutoRefresh()) return;
        if (document.hidden) return;

        if (typeof window.AdminPanel?.refreshVisibleData === 'function') {
            try {
                window.AdminPanel.refreshVisibleData();
            } catch (error) {
                console.warn('Auto refresh handler failed:', error);
            }
        }

        try {
            document.dispatchEvent(new CustomEvent('adminpanel:refresh-visible-data'));
        } catch (error) {
            console.warn('Auto refresh event failed:', error);
        }
    }

    function scheduleAutoRefresh() {
        if (!shouldAutoRefresh()) return;
        window.setInterval(triggerVisibleDataRefresh, AUTO_REFRESH_MS);
    }

    scheduleAutoRefresh();

    window.logout = logout;
})();
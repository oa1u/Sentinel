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

    function decodeCookieValue(value) {
        if (typeof value !== 'string') return '';
        const trimmed = value.trim().replace(/^"|"$/g, '');
        try {
            return decodeURIComponent(trimmed);
        } catch {
            return trimmed;
        }
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

        const response = await fetch(url, fetchOptions);
        const data = await response.json().catch(() => null);

        if (isMutatingMethod(method) && !fetchOptions._csrfRetried && isCsrfFailure(response, data)) {
            const refreshedToken = await getCsrfToken(true);
            if (refreshedToken) {
                const retryHeaders = {
                    ...(fetchOptions.headers || {}),
                    'x-csrf-token': refreshedToken
                };
                return requestJson(url, {
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
                    window._cachedCsrfToken = tokenFromCookie;
                    return tokenFromCookie;
                }
            }
        }

        const res = await fetch('/api/csrf', { credentials: 'include' });
        const data = await res.json().catch(() => null);
        if (data?.csrfToken) {
            window._cachedCsrfToken = data.csrfToken;
            return data.csrfToken;
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
            ownerNavLinkId = 'ownerNavLink'
        } = options;

        const moderatorLink = moderatorLinkId ? document.getElementById(moderatorLinkId) : null;
        const adminLink = adminLinkId ? document.getElementById(adminLinkId) : null;
        const ownerLink = ownerLinkId ? document.getElementById(ownerLinkId) : null;
        const ownerNavLink = ownerNavLinkId ? document.getElementById(ownerNavLinkId) : null;

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
            getAccountInfo,
            applyRoleVisibility,
            logout
        }
    };

    window.logout = logout;
})();
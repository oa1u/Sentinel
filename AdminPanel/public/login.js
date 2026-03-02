/* Login page script — handles CSRF, form submission and small UI helpers for signing in. */
// Simple username and password authentication. Nothing fancy, just what you need.

// Wait until everything on the page is loaded before running the login logic.
document.addEventListener('DOMContentLoaded', () => {
    // Refresh CSRF token on load
    try {
        document.cookie = 'csrfToken=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Strict';
        window.AdminPanel?.api?.getJson('/api/csrf')
            .then(({ data }) => {
                if (data?.csrfToken) {
                    document.cookie = `csrfToken=${data.csrfToken}; path=/; SameSite=Strict`;
                    window._cachedCsrfToken = data.csrfToken;
                }
            })
            .catch(() => { });
    } catch (e) { }

    const loginBtn = document.getElementById('loginBtn');
    const registerLink = document.getElementById('registerLink');
    const errorMsg = document.getElementById('errorMsg');
    const successMsg = document.getElementById('successMsg');
    const loginForm = document.getElementById('loginForm');
    const usernameInput = document.getElementById('username');
    const passwordInput = document.getElementById('password');

    const { ui, api } = window.AdminPanel || {};
    // Recovery code logic removed

    function showMessage(el, msg, type) {
        if (!el) return;
        if (ui?.showMessage) {
            ui.showMessage(el, msg, type);
            return;
        }
        el.textContent = msg;
        el.classList.remove('hidden');
        el.classList.remove('error', 'success');
        el.classList.add(type);
    }

    function hideMessage(el) {
        if (!el) return;
        if (ui?.hideMessage) return ui.hideMessage(el);
        el.classList.add('hidden');
    }

    function setLoading(show) {
        // The redesigned page doesn't include a global loading overlay by default.
        // Prefer the AdminPanel UI helper when available; otherwise disable the login button.
        if (ui?.setLoading) return ui.setLoading(null, show);
        if (loginBtn) loginBtn.disabled = show;
    }

    if (!loginBtn || !usernameInput) {
        console.error('Required login elements missing');
        return;
    }

    // Wire interactions
    loginForm?.addEventListener('submit', (e) => { e.preventDefault(); handleLogin(); });
    loginBtn.addEventListener('click', (e) => { e.preventDefault(); handleLogin(); });
    registerLink?.addEventListener('click', (e) => { e?.preventDefault(); window.location.href = '/register'; });

    // Recovery code logic removed

    async function handleLogin() {
        hideMessage(errorMsg);
        hideMessage(successMsg);

        const username = (usernameInput?.value || '').trim();
        const password = (passwordInput?.value || '');

        if (!username || !password) {
            showMessage(errorMsg, 'Please fill in all required fields', 'error');
            return;
        }

        if (!api || !api.postJson) {
            showMessage(errorMsg, 'System error: API not available. Refresh the page.', 'error');
            return;
        }

        setLoading(true);

        try {
            const path = '/api/login';
            const payload = { username, password };

            const { response, data } = await api.postJson(path, payload);

            if (response?.ok && data?.success) {
                try {
                    const { data: csrfData } = await api.getJson('/api/csrf');
                    if (csrfData?.csrfToken) {
                        document.cookie = 'csrfToken=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Strict';
                        document.cookie = `csrfToken=${csrfData.csrfToken}; path=/; SameSite=Strict`;
                        window._cachedCsrfToken = csrfData.csrfToken;
                    }
                } catch (e) { }

                showMessage(successMsg, 'Login successful\nYou\'re now being redirected', 'success');
                setTimeout(() => window.location.replace('/dashboard'), 600);
                return;
            }

            // Server may require 2FA for this account — display a friendly message
            if (response?.status === 202 && data?.requiresTwoFactor) {
                showMessage(successMsg, 'Password verified. Please complete two-factor authentication via your device.', 'success');
                return;
            }

            showMessage(errorMsg, data?.error || 'Login failed. Check your credentials.', 'error');
        } catch (err) {
            console.error('Login error', err);
            showMessage(errorMsg, 'Connection error — try again.', 'error');
        } finally {
            setLoading(false);
        }
    }
});
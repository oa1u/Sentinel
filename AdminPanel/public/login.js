// This handles everything for the login page—getting you signed in and ready to go.
// Simple username and password authentication. Nothing fancy, just what you need.

// Wait until everything on the page is loaded before running the login logic.
document.addEventListener('DOMContentLoaded', () => {
        // Always clear any old CSRF token and fetch a new one on page load
        document.cookie = 'csrfToken=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Strict';
        fetch('/api/csrf', { credentials: 'include' })
            .then(res => res.json())
            .then(data => {
                if (data?.csrfToken) {
                    document.cookie = `csrfToken=${data.csrfToken}; path=/; SameSite=Strict`;
                    window._cachedCsrfToken = data.csrfToken;
                }
            })
            .catch(() => {});
    const loginBtn = document.getElementById('loginBtn');
    const registerLink = document.getElementById('registerLink');
    const loading = document.getElementById('loading');
    const errorMsg = document.getElementById('errorMsg');
    const successMsg = document.getElementById('successMsg');
    const { ui, api } = window.AdminPanel || {};

    // Make sure all the buttons and fields we need are actually on the page.
    if (!loginBtn) {
        console.error('Login button not found');
        return;
    }

    // Set up all the event listeners for login and registration.
    const loginForm = document.getElementById('loginForm');
    if (loginForm) {
        loginForm.addEventListener('submit', handleLogin);
    }
    loginBtn.addEventListener('click', (e) => {
        e.preventDefault();
        handleLogin(e);
    });
    if (registerLink) {
        registerLink.addEventListener('click', goToRegister);
    }

    async function handleLogin(e) {
        if (e) e.preventDefault();

        const username = document.getElementById('username').value.trim();
        const password = document.getElementById('password').value;

        // Double check that the user filled in both fields before trying to log in.
        if (!username || !password) {
            if (ui) {
                ui.showMessage(errorMsg, 'Please fill in all fields', 'error');
            } else {
                errorMsg.textContent = 'Please fill in all fields';
                errorMsg.classList.remove('hidden');
            }
            return;
        }

        // Make sure the API is available before we try to log in.
        if (!api || !api.postJson) {
            console.error('AdminPanel API not loaded');
            if (ui) {
                ui.showMessage(errorMsg, 'System error: API not loaded. Please refresh the page.', 'error');
            } else {
                errorMsg.textContent = 'System error: API not loaded. Please refresh the page.';
                errorMsg.classList.remove('hidden');
            }
            return;
        }

        loginBtn.disabled = true;
        ui?.setLoading(loading, true);
        ui?.hideMessage(errorMsg);
        ui?.hideMessage(successMsg);

        try {
            const { response, data } = await api.postJson('/api/login', { username, password });

            if (response.ok && data?.success) {
                // Always reload CSRF token from backend after login
                try {
                    const csrfRes = await fetch('/api/csrf', { credentials: 'include' });
                    const csrfData = await csrfRes.json().catch(() => null);
                    if (csrfData?.csrfToken) {
                        document.cookie = 'csrfToken=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Strict';
                        document.cookie = `csrfToken=${csrfData.csrfToken}; path=/; SameSite=Strict`;
                        window._cachedCsrfToken = csrfData.csrfToken;
                        // console.log removed for production
                    }
                } catch (csrfErr) {
                    console.error('[login] Failed to refresh CSRF token:', csrfErr);
                }
                ui?.showMessage(successMsg, 'Login successful! Redirecting...', 'success');
                setTimeout(() => {
                    window.location.replace('/dashboard');
                }, 500);
            } else {
                ui?.showMessage(errorMsg, data?.error || 'Login failed', 'error');
            }
        } catch (error) {
            console.error('Login error:', error);
            ui?.showMessage(errorMsg, 'Connection error. Please try again.', 'error');
        } finally {
            loginBtn.disabled = false;
            ui?.setLoading(loading, false);
        }
    }

    function goToRegister(e) {
        if (e) e.preventDefault();
        window.location.href = '/register';
    }
});
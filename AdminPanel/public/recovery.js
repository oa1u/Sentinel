document.addEventListener('DOMContentLoaded', () => {
    const recoveryLoginBtn = document.getElementById('recoveryLoginBtn');
    const requestResetBtn = document.getElementById('requestResetBtn');
    const confirmResetBtn = document.getElementById('confirmResetBtn');
    const recoveryResetBtn = document.getElementById('recoveryResetBtn');

    const showRecoveryLoginPanelBtn = document.getElementById('showRecoveryLoginPanel');
    const showEmailResetRequestPanelBtn = document.getElementById('showEmailResetRequestPanel');
    const showTokenResetPanelBtn = document.getElementById('showTokenResetPanel');
    const showRecoveryResetPanelBtn = document.getElementById('showRecoveryResetPanel');

    const recoveryForm = document.getElementById('recoveryForm');
    const passwordResetRequestForm = document.getElementById('passwordResetRequestForm');
    const passwordResetTokenForm = document.getElementById('passwordResetTokenForm');
    const passwordResetRecoveryForm = document.getElementById('passwordResetRecoveryForm');

    const loginLink = document.getElementById('loginLink');
    const loading = document.getElementById('loading');
    const errorMsg = document.getElementById('errorMsg');
    const successMsg = document.getElementById('successMsg');
    const usernameInput = document.getElementById('username');
    const recoveryCodeInput = document.getElementById('recoveryCode');
    const resetIdentifierInput = document.getElementById('resetIdentifier');
    const resetTokenInput = document.getElementById('resetToken');
    const resetNewPasswordInput = document.getElementById('resetNewPassword');
    const resetConfirmPasswordInput = document.getElementById('resetConfirmPassword');
    const resetRecoveryUsernameInput = document.getElementById('resetRecoveryUsername');
    const resetRecoveryCodeInput = document.getElementById('resetRecoveryCode');
    const recoveryResetNewPasswordInput = document.getElementById('recoveryResetNewPassword');
    const recoveryResetConfirmPasswordInput = document.getElementById('recoveryResetConfirmPassword');
    const { ui, api } = window.AdminPanel || {};

    if (!recoveryLoginBtn || !usernameInput || !recoveryCodeInput) {
        return;
    }

    if (recoveryForm) {
        recoveryForm.addEventListener('submit', handleRecoveryLogin);
    }

    recoveryLoginBtn.addEventListener('click', (e) => {
        e.preventDefault();
        handleRecoveryLogin(e);
    });

    requestResetBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        handlePasswordResetRequest();
    });

    confirmResetBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        handlePasswordResetConfirm();
    });

    recoveryResetBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        handleRecoveryCodePasswordReset();
    });

    showRecoveryLoginPanelBtn?.addEventListener('click', () => showPanel('recovery-login'));
    showEmailResetRequestPanelBtn?.addEventListener('click', () => showPanel('email-request'));
    showTokenResetPanelBtn?.addEventListener('click', () => showPanel('token-reset'));
    showRecoveryResetPanelBtn?.addEventListener('click', () => showPanel('recovery-reset'));

    if (loginLink) {
        loginLink.addEventListener('click', (e) => {
            e.preventDefault();
            window.location.href = '/login';
        });
    }

    recoveryCodeInput.addEventListener('input', () => {
        const cleaned = String(recoveryCodeInput.value || '')
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, '')
            .slice(0, 12);
        
        if (cleaned.length > 8) {
            recoveryCodeInput.value = `${cleaned.slice(0, 4)}-${cleaned.slice(4, 8)}-${cleaned.slice(8)}`;
        } else if (cleaned.length > 4) {
             recoveryCodeInput.value = `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`;
        } else {
             recoveryCodeInput.value = cleaned;
        }
    });

    resetRecoveryCodeInput?.addEventListener('input', () => {
        const cleaned = String(resetRecoveryCodeInput.value || '')
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, '')
            .slice(0, 12);
        
        if (cleaned.length > 8) {
            resetRecoveryCodeInput.value = `${cleaned.slice(0, 4)}-${cleaned.slice(4, 8)}-${cleaned.slice(8)}`;
        } else if (cleaned.length > 4) {
             resetRecoveryCodeInput.value = `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`;
        } else {
             resetRecoveryCodeInput.value = cleaned;
        }
    });

    const tokenFromQuery = new URLSearchParams(window.location.search).get('resetToken');
    if (tokenFromQuery && resetTokenInput) {
        resetTokenInput.value = tokenFromQuery;
        showPanel('token-reset');
    }

    function showPanel(panel) {
        if (recoveryForm) recoveryForm.style.display = panel === 'recovery-login' ? 'block' : 'none';
        if (passwordResetRequestForm) passwordResetRequestForm.style.display = panel === 'email-request' ? 'block' : 'none';
        if (passwordResetTokenForm) passwordResetTokenForm.style.display = panel === 'token-reset' ? 'block' : 'none';
        if (passwordResetRecoveryForm) passwordResetRecoveryForm.style.display = panel === 'recovery-reset' ? 'block' : 'none';
    }

    async function runWithLoading(button, action) {
        button.disabled = true;
        ui?.setLoading(loading, true);
        ui?.hideMessage(errorMsg);
        ui?.hideMessage(successMsg);
        try {
            await action();
        } finally {
            button.disabled = false;
            ui?.setLoading(loading, false);
        }
    }

    function isStrongPassword(password) {
        return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]).{8,100}$/.test(String(password || ''));
    }

    async function handleRecoveryLogin(e) {
        if (e) e.preventDefault();

        const username = usernameInput.value.trim();
        const recoveryCode = recoveryCodeInput.value.trim();

        if (!username || !recoveryCode) {
            ui?.showMessage(errorMsg, 'Please fill in all fields', 'error');
            return;
        }

        if (!api || !api.postJson) {
            ui?.showMessage(errorMsg, 'System error: API not loaded. Please refresh the page.', 'error');
            return;
        }

        recoveryLoginBtn.disabled = true;
        await runWithLoading(recoveryLoginBtn, async () => {
            const { response, data } = await api.postJson('/api/login/recovery', { username, recoveryCode });

            if (response.ok && data?.success) {
                try {
                    const { data: csrfData } = await api.getJson('/api/csrf');
                    if (csrfData?.csrfToken) {
                        document.cookie = 'csrfToken=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Strict';
                        document.cookie = `csrfToken=${csrfData.csrfToken}; path=/; SameSite=Strict`;
                        window._cachedCsrfToken = csrfData.csrfToken;
                    }
                } catch (csrfErr) {
                    console.error('[recovery-login] Failed to refresh CSRF token:', csrfErr);
                }

                ui?.showMessage(successMsg, 'Recovery login successful! Redirecting...', 'success');
                setTimeout(() => {
                    window.location.replace('/dashboard');
                }, 500);
                return;
            }

            ui?.showMessage(errorMsg, data?.error || 'Recovery login failed', 'error');
        }).catch((error) => {
            console.error('Recovery login error:', error);
            ui?.showMessage(errorMsg, 'Connection error. Please try again.', 'error');
        });
    }

    async function handlePasswordResetRequest() {
        const identifier = String(resetIdentifierInput?.value || '').trim();
        if (!identifier) {
            ui?.showMessage(errorMsg, 'Please provide your username or email', 'error');
            return;
        }

        if (!api || !api.postJson) {
            ui?.showMessage(errorMsg, 'System error: API not loaded. Please refresh the page.', 'error');
            return;
        }

        await runWithLoading(requestResetBtn, async () => {
            const { response, data } = await api.postJson('/api/account/password-reset/request', { identifier });
            if (response.ok && data?.success) {
                ui?.showMessage(successMsg, data?.message || 'If the account exists, a reset email has been sent.', 'success');
                return;
            }
            ui?.showMessage(errorMsg, data?.error || 'Failed to request password reset', 'error');
        }).catch((error) => {
            console.error('Password reset request error:', error);
            ui?.showMessage(errorMsg, 'Connection error. Please try again.', 'error');
        });
    }

    async function handlePasswordResetConfirm() {
        const token = String(resetTokenInput?.value || '').trim();
        const newPassword = String(resetNewPasswordInput?.value || '');
        const confirmPassword = String(resetConfirmPasswordInput?.value || '');

        if (!token || !newPassword || !confirmPassword) {
            ui?.showMessage(errorMsg, 'Please fill in all token reset fields', 'error');
            return;
        }

        if (newPassword !== confirmPassword) {
            ui?.showMessage(errorMsg, 'Passwords do not match', 'error');
            return;
        }

        if (!isStrongPassword(newPassword)) {
            ui?.showMessage(errorMsg, 'Password must be 8-100 chars with upper/lower/number/special.', 'error');
            return;
        }

        await runWithLoading(confirmResetBtn, async () => {
            const { response, data } = await api.postJson('/api/account/password-reset/confirm', {
                token,
                newPassword,
                confirmPassword
            });
            if (response.ok && data?.success) {
                ui?.showMessage(successMsg, 'Password reset successful. Redirecting to login...', 'success');
                setTimeout(() => {
                    window.location.href = '/login';
                }, 900);
                return;
            }
            ui?.showMessage(errorMsg, data?.error || 'Failed to reset password', 'error');
        }).catch((error) => {
            console.error('Token reset error:', error);
            ui?.showMessage(errorMsg, 'Connection error. Please try again.', 'error');
        });
    }

    async function handleRecoveryCodePasswordReset() {
        const username = String(resetRecoveryUsernameInput?.value || '').trim();
        const recoveryCode = String(resetRecoveryCodeInput?.value || '').trim();
        const newPassword = String(recoveryResetNewPasswordInput?.value || '');
        const confirmPassword = String(recoveryResetConfirmPasswordInput?.value || '');

        if (!username || !recoveryCode || !newPassword || !confirmPassword) {
            ui?.showMessage(errorMsg, 'Please fill in all recovery reset fields', 'error');
            return;
        }

        if (newPassword !== confirmPassword) {
            ui?.showMessage(errorMsg, 'Passwords do not match', 'error');
            return;
        }

        if (!isStrongPassword(newPassword)) {
            ui?.showMessage(errorMsg, 'Password must be 8-100 chars with upper/lower/number/special.', 'error');
            return;
        }

        await runWithLoading(recoveryResetBtn, async () => {
            const { response, data } = await api.postJson('/api/account/password-reset/recovery', {
                username,
                recoveryCode,
                newPassword,
                confirmPassword
            });
            if (response.ok && data?.success) {
                ui?.showMessage(successMsg, 'Password reset successful. Redirecting to login...', 'success');
                setTimeout(() => {
                    window.location.href = '/login';
                }, 900);
                return;
            }
            ui?.showMessage(errorMsg, data?.error || 'Failed to reset password with recovery code', 'error');
        }).catch((error) => {
            console.error('Recovery code reset error:', error);
            ui?.showMessage(errorMsg, 'Connection error. Please try again.', 'error');
        });
    }
});

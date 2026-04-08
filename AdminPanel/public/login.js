
document.addEventListener('DOMContentLoaded', () => {
    const loginBtn = document.getElementById('loginBtn');
    const registerLink = document.getElementById('registerLink');
    const errorMsg = document.getElementById('errorMsg');
    const successMsg = document.getElementById('successMsg');
    const loginForm = document.getElementById('loginForm');
    const usernameInput = document.getElementById('username');
    const passwordInput = document.getElementById('password');
    const capsWarning = document.getElementById('capsWarning');
    const captchaQuestionEl = document.getElementById('captchaQuestion');
    const captchaAnswerInput = document.getElementById('captchaAnswer');
    const refreshCaptchaBtn = document.getElementById('refreshCaptchaBtn');
    const captchaGroup = document.getElementById('loginCaptchaGroup');
    const captchaTypeText = document.getElementById('captchaTypeText');
    const captchaStatusText = document.getElementById('captchaStatusText');
    const captchaExpiryText = document.getElementById('captchaExpiryText');
    const captchaTipText = document.getElementById('captchaTipText');
    const twoFactorGroup = document.getElementById('loginTwoFactorGroup');
    const twoFactorInput = document.getElementById('loginTwoFactorCode');

    const { ui, api } = window.AdminPanel || {};
    const captchaState = {
        challengeId: '',
        loaded: false,
        enabled: true,
        expiresAt: 0,
        countdownTimer: null
    };
    const twoFactorState = {
        challengeId: '',
        required: false
    };

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
        if (ui?.setLoading) return ui.setLoading(null, show);
        if (loginBtn) loginBtn.disabled = show;
    }

    function setTwoFactorRequired(required) {
        twoFactorState.required = Boolean(required);
        if (twoFactorGroup) twoFactorGroup.style.display = twoFactorState.required ? '' : 'none';
        if (twoFactorInput && !twoFactorState.required) twoFactorInput.value = '';
    }

    function clearCaptchaCountdown() {
        if (captchaState.countdownTimer) {
            window.clearInterval(captchaState.countdownTimer);
            captchaState.countdownTimer = null;
        }
    }

    function formatCaptchaCountdown(msRemaining) {
        const totalSeconds = Math.max(0, Math.ceil(msRemaining / 1000));
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }

    function updateCaptchaExpiryText() {
        if (!captchaExpiryText) return;
        if (!captchaState.enabled || !captchaState.loaded || !captchaState.expiresAt) {
            captchaExpiryText.textContent = 'Expires in --:--';
            return;
        }

        const remainingMs = Number(captchaState.expiresAt) - Date.now();
        if (remainingMs <= 0) {
            captchaExpiryText.textContent = 'Expired';
            clearCaptchaCountdown();
            return;
        }

        captchaExpiryText.textContent = `Expires in ${formatCaptchaCountdown(remainingMs)}`;
    }

    function startCaptchaCountdown(expiresInMs) {
        clearCaptchaCountdown();
        const ttlMs = Math.max(0, Number(expiresInMs) || 0);
        captchaState.expiresAt = ttlMs > 0 ? Date.now() + ttlMs : 0;
        updateCaptchaExpiryText();
        if (!captchaState.expiresAt) return;
        captchaState.countdownTimer = window.setInterval(updateCaptchaExpiryText, 1000);
    }

    function resetCaptchaPresentation() {
        clearCaptchaCountdown();
        captchaState.expiresAt = 0;
        if (captchaTypeText) captchaTypeText.textContent = 'Adaptive challenge';
        if (captchaStatusText) captchaStatusText.textContent = 'Challenge ready';
        if (captchaTipText) captchaTipText.textContent = 'Refresh it if the challenge changes or no longer matches what you see.';
        if (captchaAnswerInput) {
            captchaAnswerInput.placeholder = 'Enter captcha answer';
            captchaAnswerInput.removeAttribute('maxlength');
            captchaAnswerInput.setAttribute('inputmode', 'text');
        }
        updateCaptchaExpiryText();
    }

    if (!loginBtn || !usernameInput) {
        console.error('Required login elements missing');
        return;
    }

    loginForm?.addEventListener('submit', (e) => { e.preventDefault(); handleLogin(); });
    loginBtn.addEventListener('click', (e) => { e.preventDefault(); handleLogin(); });
    registerLink?.addEventListener('click', (e) => { e?.preventDefault(); window.location.href = '/register'; });
    refreshCaptchaBtn?.addEventListener('click', () => { loadCaptchaChallenge(true); });

    function setCapsWarningVisible(visible) {
        if (!capsWarning) return;
        capsWarning.classList.toggle('hidden', !visible);
    }

    function handleCapsLockEvent(event) {
        if (!event || typeof event.getModifierState !== 'function') return;
        setCapsWarningVisible(event.getModifierState('CapsLock'));
    }

    passwordInput?.addEventListener('keydown', handleCapsLockEvent);
    passwordInput?.addEventListener('keyup', handleCapsLockEvent);
    passwordInput?.addEventListener('focus', handleCapsLockEvent);
    passwordInput?.addEventListener('blur', () => setCapsWarningVisible(false));

    async function loadCaptchaChallenge(force = false) {
        if (!api?.getJson) return false;
        resetCaptchaPresentation();
        if (captchaQuestionEl) captchaQuestionEl.textContent = 'Loading captcha challenge...';
        if (captchaStatusText) captchaStatusText.textContent = 'Loading challenge...';

        try {
            const suffix = force ? `&_=${Date.now()}` : '';
            const { response, data } = await api.getJson(`/api/captcha/challenge?scope=login${suffix}`);
            if (!response?.ok) {
                throw new Error(data?.error || 'Failed to load captcha');
            }

            if (data?.enabled === false) {
                captchaState.enabled = false;
                captchaState.challengeId = '';
                captchaState.loaded = true;
                captchaState.expiresAt = 0;
                if (captchaGroup) captchaGroup.style.display = 'none';
                return true;
            }

            if (!data?.challengeId || !data?.question) {
                throw new Error(data?.error || 'Failed to load captcha');
            }

            captchaState.challengeId = String(data.challengeId);
            captchaState.loaded = true;
            captchaState.enabled = true;
            if (captchaGroup) captchaGroup.style.display = '';
            if (captchaQuestionEl) captchaQuestionEl.textContent = String(data.question);
            if (captchaAnswerInput) captchaAnswerInput.value = '';
            if (captchaTypeText) captchaTypeText.textContent = String(data.label || 'Adaptive challenge');
            if (captchaStatusText) captchaStatusText.textContent = 'Challenge ready';
            if (captchaTipText) captchaTipText.textContent = String(data.tip || 'Refresh it if the challenge changes or no longer matches what you see.');
            if (captchaAnswerInput) {
                captchaAnswerInput.placeholder = String(data.placeholder || 'Enter captcha answer');
                captchaAnswerInput.setAttribute('inputmode', String(data.inputMode || 'text'));
                if (Number(data.answerLength) > 0) {
                    captchaAnswerInput.maxLength = Number(data.answerLength);
                } else {
                    captchaAnswerInput.removeAttribute('maxlength');
                }
            }
            startCaptchaCountdown(data.expiresInMs);
            return true;
        } catch {
            clearCaptchaCountdown();
            captchaState.challengeId = '';
            captchaState.loaded = false;
            captchaState.enabled = true;
            captchaState.expiresAt = 0;
            if (captchaQuestionEl) captchaQuestionEl.textContent = 'Captcha unavailable. Refresh to retry.';
            if (captchaStatusText) captchaStatusText.textContent = 'Challenge unavailable';
            updateCaptchaExpiryText();
            return false;
        }
    }

    loadCaptchaChallenge(false);


    async function handleLogin() {
        hideMessage(errorMsg);
        hideMessage(successMsg);

        const username = (usernameInput?.value || '').trim();
        const password = (passwordInput?.value || '');
        const captchaAnswer = (captchaAnswerInput?.value || '').trim();
        const twoFactorToken = (twoFactorInput?.value || '').trim();

        if (!username || !password) {
            showMessage(errorMsg, 'Please fill in all required fields', 'error');
            return;
        }

        if (captchaState.enabled && (!captchaState.challengeId || !captchaAnswer)) {
            showMessage(errorMsg, 'Please complete captcha verification', 'error');
            await loadCaptchaChallenge(true);
            return;
        }

        if (twoFactorState.required && !/^[0-9]{6}$/.test(twoFactorToken)) {
            showMessage(errorMsg, 'Enter the 6-digit 2FA code from your authenticator app', 'error');
            return;
        }

        if (!api || !api.postJson) {
            showMessage(errorMsg, 'System error: API not available. Refresh the page.', 'error');
            return;
        }

        setLoading(true);

        try {
            const path = '/api/login';
            const payload = {
                username,
                password,
                captchaChallengeId: captchaState.enabled ? captchaState.challengeId : null,
                captchaAnswer: captchaState.enabled ? captchaAnswer : null,
                twoFactorToken: twoFactorState.required ? twoFactorToken : null,
                twoFactorChallenge: twoFactorState.required ? twoFactorState.challengeId : null
            };

            const { response, data } = await api.postJson(path, payload);

            if (response?.ok && data?.success) {
                try {
                    if (api?.getCsrfToken) {
                        await api.getCsrfToken(true);
                    }
                } catch (e) { }

                showMessage(successMsg, 'Login successful\nYou\'re now being redirected', 'success');
                setTimeout(() => window.location.replace('/dashboard'), 600);
                return;
            }

            if (response?.status === 202 && data?.requiresTwoFactor) {
                twoFactorState.challengeId = String(data?.challengeId || '');
                setTwoFactorRequired(true);
                showMessage(successMsg, 'Password verified. Please complete two-factor authentication via your device.', 'success');
                if (twoFactorInput) twoFactorInput.focus();
                return;
            }

            if (response?.status === 401 && data?.error && String(data.error).toLowerCase().includes('2fa')) {
                setTwoFactorRequired(true);
            }

            await loadCaptchaChallenge(true);
            if (captchaAnswerInput) captchaAnswerInput.value = '';

            showMessage(errorMsg, data?.error || 'Login failed. Check your credentials.', 'error');
        } catch (err) {
            console.error('Login error', err);
            await loadCaptchaChallenge(true);
            showMessage(errorMsg, 'Connection error - try again.', 'error');
        } finally {
            setLoading(false);
        }
    }
});
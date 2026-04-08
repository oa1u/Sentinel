
const registerBtn = document.getElementById('registerBtn');
const passwordInput = document.getElementById('password');
const confirmPasswordInput = document.getElementById('confirmPassword');
const passwordRequirements = document.querySelector('.password-requirements');
const loading = document.getElementById('loading');
const errorMsg = document.getElementById('errorMsg');
const successMsg = document.getElementById('successMsg');
const loginLink = document.getElementById('loginLink');
const passwordStrengthFill = document.getElementById('passwordStrengthFill');
const passwordStrengthLabel = document.getElementById('passwordStrengthLabel');
const passwordMatchStatus = document.getElementById('passwordMatchStatus');
const captchaQuestionEl = document.getElementById('captchaQuestion');
const captchaAnswerInput = document.getElementById('captchaAnswer');
const refreshCaptchaBtn = document.getElementById('refreshCaptchaBtn');
const captchaGroup = document.getElementById('registerCaptchaGroup');
const captchaTypeText = document.getElementById('captchaTypeText');
const captchaStatusText = document.getElementById('captchaStatusText');
const captchaExpiryText = document.getElementById('captchaExpiryText');
const captchaTipText = document.getElementById('captchaTipText');
const { ui, api } = window.AdminPanel || {};
const captchaState = {
    challengeId: '',
    loaded: false,
    enabled: true,
    expiresAt: 0,
    countdownTimer: null
};

registerBtn.addEventListener('click', handleRegister);
const registerForm = document.getElementById('registerForm');
if (registerForm) registerForm.addEventListener('submit', handleRegister);
if (loginLink) {
    loginLink.addEventListener('click', goToLogin);
}
if (refreshCaptchaBtn) {
    refreshCaptchaBtn.addEventListener('click', () => {
        loadCaptchaChallenge(true);
    });
}
passwordInput.addEventListener('input', validatePassword);
passwordInput.addEventListener('focus', showPasswordRequirements);
passwordInput.addEventListener('blur', hidePasswordRequirementsIfEmpty);
confirmPasswordInput.addEventListener('input', validateForm);
document.getElementById('username').addEventListener('input', validateForm);
document.getElementById('email').addEventListener('input', validateForm);
document.getElementById('inviteCode').addEventListener('input', validateForm);
if (captchaAnswerInput) captchaAnswerInput.addEventListener('input', validateForm);
document.querySelectorAll('.password-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
        const targetId = btn.getAttribute('data-target');
        const input = targetId ? document.getElementById(targetId) : null;
        if (!input) return;

        const isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';

        btn.textContent = input.type === 'password' ? '👁️' : '👁️';
    });
});

function showPasswordRequirements() {
    if (passwordRequirements) {
        passwordRequirements.classList.add('show');
    }
}

function hidePasswordRequirementsIfEmpty() {
    if (passwordRequirements && !passwordInput.value.trim()) {
        passwordRequirements.classList.remove('show');
    }
}

function validatePassword() {
    if (passwordRequirements) {
        passwordRequirements.classList.add('show');
    }
    const password = passwordInput.value;

    const requirements = {
        'req-length': password.length >= 8,
        'req-upper': /[A-Z]/.test(password),
        'req-lower': /[a-z]/.test(password),
        'req-number': /\d/.test(password),
        'req-special': /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)
    };

    for (const [id, met] of Object.entries(requirements)) {
        const elem = document.getElementById(id);
        if (met) {
            elem.classList.add('met');
        } else {
            elem.classList.remove('met');
        }
    }

    updatePasswordStrength(password, requirements);

    validateForm();
}

function updatePasswordStrength(password, requirements) {
    if (!passwordStrengthFill || !passwordStrengthLabel) return;

    const checks = Object.values(requirements).filter(Boolean).length;
    const lengthBonus = password.length >= 12 ? 1 : 0;
    const score = Math.min(checks + lengthBonus, 6);
    const percent = Math.max((score / 6) * 100, 0);

    let label = 'Strength: Not set';
    let color = '#6b7280';

    if (password.length > 0 && score <= 2) {
        label = 'Strength: Weak';
        color = '#ff8fa3';
    } else if (score === 3 || score === 4) {
        label = 'Strength: Medium';
        color = '#facc15';
    } else if (score >= 5) {
        label = 'Strength: Strong';
        color = '#75ec9c';
    }

    passwordStrengthFill.style.width = `${percent}%`;
    passwordStrengthFill.style.backgroundColor = color;
    passwordStrengthLabel.textContent = label;
}

function updateConfirmPasswordStatus(password, confirmPassword) {
    if (!passwordMatchStatus) return;

    passwordMatchStatus.classList.remove('good', 'bad');

    if (!confirmPassword) {
        passwordMatchStatus.textContent = '';
        return;
    }

    if (password === confirmPassword) {
        passwordMatchStatus.textContent = 'Passwords match';
        passwordMatchStatus.classList.add('good');
    } else {
        passwordMatchStatus.textContent = 'Passwords do not match';
        passwordMatchStatus.classList.add('bad');
    }
}

function validateForm() {
    const username = document.getElementById('username').value.trim();
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const confirmPassword = document.getElementById('confirmPassword').value;
    const inviteCode = document.getElementById('inviteCode').value.trim();
    const captchaAnswer = (captchaAnswerInput?.value || '').trim();

    const passwordValid = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]).{8,}$/.test(password);
    const usernameValid = /^[a-zA-Z0-9_]{3,30}$/.test(username);
    const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    const passwordMatch = password === confirmPassword && password.length > 0;
    const inviteCodeValid = inviteCode.length > 0;

    updateConfirmPasswordStatus(password, confirmPassword);

    const captchaValid = !captchaState.enabled || (captchaState.loaded && captchaState.challengeId.length > 0 && captchaAnswer.length > 0);

    registerBtn.disabled = !(passwordValid && usernameValid && emailValid && passwordMatch && inviteCodeValid && captchaValid);
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
    if (captchaTipText) captchaTipText.textContent = 'The answer may be a number or a short text response depending on the challenge.';
    if (captchaAnswerInput) {
        captchaAnswerInput.placeholder = 'Enter captcha answer';
        captchaAnswerInput.removeAttribute('maxlength');
        captchaAnswerInput.setAttribute('inputmode', 'text');
    }
    updateCaptchaExpiryText();
}

async function loadCaptchaChallenge(force = false) {
    if (!api?.getJson) return false;
    resetCaptchaPresentation();
    if (captchaQuestionEl) captchaQuestionEl.textContent = 'Loading captcha challenge...';
    if (captchaStatusText) captchaStatusText.textContent = 'Loading challenge...';

    try {
        const suffix = force ? `&_=${Date.now()}` : '';
        const { response, data } = await api.getJson(`/api/captcha/challenge?scope=register${suffix}`);
        if (!response?.ok) {
            throw new Error(data?.error || 'Failed to load captcha');
        }

        if (data?.enabled === false) {
            captchaState.enabled = false;
            captchaState.challengeId = '';
            captchaState.loaded = true;
            captchaState.expiresAt = 0;
            if (captchaGroup) captchaGroup.style.display = 'none';
            validateForm();
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
        if (captchaTipText) captchaTipText.textContent = String(data.tip || 'The answer may be a number or a short text response depending on the challenge.');
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
        validateForm();
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
        validateForm();
        return false;
    }
}

async function handleRegister(e) {
    e.preventDefault();

    const username = document.getElementById('username').value.trim();
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const confirmPassword = document.getElementById('confirmPassword').value;
    const inviteCode = document.getElementById('inviteCode').value.trim();
    const captchaAnswer = (captchaAnswerInput?.value || '').trim();

    if (!username || !email || !password || !confirmPassword || !inviteCode) {
        ui?.showMessage(errorMsg, 'Please fill in all fields', 'error');
        return;
    }

    if (captchaState.enabled && (!captchaState.challengeId || !captchaAnswer)) {
        ui?.showMessage(errorMsg, 'Please complete captcha verification', 'error');
        await loadCaptchaChallenge(true);
        return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        ui?.showMessage(errorMsg, 'Please enter a valid email address', 'error');
        return;
    }

    if (password !== confirmPassword) {
        ui?.showMessage(errorMsg, 'Passwords do not match', 'error');
        return;
    }

    if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
        ui?.showMessage(errorMsg, 'Username must be 3-30 characters (letters, numbers, and underscores only)', 'error');
        return;
    }

    if (password.length < 8) {
        ui?.showMessage(errorMsg, 'Password must be at least 8 characters long', 'error');
        return;
    }

    if (!/[A-Z]/.test(password)) {
        ui?.showMessage(errorMsg, 'Password must contain at least one uppercase letter', 'error');
        return;
    }

    if (!/[a-z]/.test(password)) {
        ui?.showMessage(errorMsg, 'Password must contain at least one lowercase letter', 'error');
        return;
    }

    if (!/\d/.test(password)) {
        ui?.showMessage(errorMsg, 'Password must contain at least one number', 'error');
        return;
    }

    if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
        ui?.showMessage(errorMsg, 'Password must contain at least one special character (!@#$%^&* etc.)', 'error');
        return;
    }

    try {
        const confirmation = await showPromptModal({
            title: 'Confirm Account Creation',
            label: `Type the username \"${username}\" to confirm creating this account:`,
            placeholder: username,
            defaultValue: '',
            confirmText: 'Confirm and Create',
            cancelText: 'Cancel',
            confirmClass: 'btn-primary',
            includeCheckbox: { label: 'I understand this action is permanent and cannot be undone', required: true, errorText: 'You must acknowledge the permanence of this action' },
            validate: (val) => {
                if (!val) return 'Please type the username to confirm';
                if (val !== String(username)) return 'Username does not match';
                return true;
            }
        });

        if (!confirmation) {
            return;
        }
    } catch (err) {
        if (!confirm(`Create account for ${username}?`)) return;
    }

    registerBtn.disabled = true;
    ui?.setLoading(loading, true);
    ui?.hideMessage(errorMsg);
    ui?.hideMessage(successMsg);

    try {
        const { response, data } = await api.postJson('/api/register', {
            username,
            email,
            password,
            inviteCode,
            captchaChallengeId: captchaState.enabled ? captchaState.challengeId : null,
            captchaAnswer: captchaState.enabled ? captchaAnswer : null
        });

        if (response.ok && data?.success) {
            ui?.showMessage(successMsg, 'Account created! Redirecting to login...', 'success');
            setTimeout(() => {
                window.location.href = '/login';
            }, 2000);
        } else {
            await loadCaptchaChallenge(true);
            ui?.showMessage(errorMsg, data?.error || 'Registration failed', 'error');
        }
    } catch (error) {
        console.error('🔴 Registration error:', error);
        await loadCaptchaChallenge(true);
        ui?.showMessage(errorMsg, 'Connection error. Please try again.', 'error');
    } finally {
        registerBtn.disabled = false;
        ui?.setLoading(loading, false);
        validateForm();
    }
}

function goToLogin(e) {
    if (e) e.preventDefault();
    window.location.href = '/login';
}

validateForm();
loadCaptchaChallenge(false);
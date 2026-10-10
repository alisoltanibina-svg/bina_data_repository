// File: auth-page.js
// Purpose: Phone gate, password login, OTP for register/reset, then session cookie.

const REGISTER_FIELDS = ['first_name', 'last_name', 'role_title', 'organization', 'password', 'password_confirm'];
const PANELS = ['auth-gate', 'auth-login', 'auth-reset-captcha', 'auth-otp', 'auth-reset', 'auth-register', 'auth-status', 'auth-done'];

let currentPhone = '';
let otpPurpose = '';
// Keep the proof only in this page's memory, never in a URL or browser storage.
let otpVerification = null;
let otpFlowVersion = 0;

const captchaSlots = {
    login: { purpose: 'login', id: '', box: 'login-captcha', image: 'login-captcha-image', answer: 'login-captcha-answer' },
    register: { purpose: 'register', id: '', box: 'register-captcha', image: 'register-captcha-image', answer: 'register-captcha-answer' },
    reset: { purpose: 'reset', id: '', box: 'reset-captcha', image: 'reset-captcha-image', answer: 'reset-captcha-answer' }
};

function captchaSlot(name) { return captchaSlots[name]; }
function clearCaptcha(name) {
    const slot = captchaSlot(name);
    slot.id = '';
    const image = document.getElementById(slot.image);
    if (image) image.removeAttribute('src');
}
async function refreshCaptcha(name, phone) {
    const slot = captchaSlot(name);
    const box = document.getElementById(slot.box);
    const image = document.getElementById(slot.image);
    const answer = document.getElementById(slot.answer);
    if (!slot || !box || !image || !answer) return;
    clearCaptcha(name);
    answer.value = '';
    setError(slot.answer, '');
    const challenge = await apiJson('/api/auth/captcha', { phone: phone, purpose: slot.purpose });
    if (!challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge.captcha_id || '')) throw new Error('دریافت کد امنیتی ممکن نشد.');
    slot.id = challenge.captcha_id;
    image.src = `${API_BASE_URL}/api/auth/captcha/${encodeURIComponent(slot.id)}/image?challenge=${encodeURIComponent(slot.id)}`;
    box.hidden = false;
}
function readCaptcha(name) {
    const slot = captchaSlot(name);
    const answer = String((document.getElementById(slot.answer) || {}).value || '').trim().toUpperCase();
    return { id: slot.id, answer: answer, valid: !!slot.id && /^[A-Z2-9]{5}$/.test(answer) };
}
function clearOtpVerification() {
    otpVerification = null;
    otpFlowVersion += 1;
}

function verificationToken(purpose) {
    if (!otpVerification || otpVerification.phone !== currentPhone || otpVerification.purpose !== purpose) {
        throw new Error('ابتدا کد پیامک را تأیید کنید.');
    }
    return otpVerification.token;
}
let pendingRegister = null;
let resendTimer = 0;
let resendLeft = 0;
const PENDING_REGISTER_KEY = 'bina-pending-register';

function setPendingRegister(values) {
    pendingRegister = values || null;
    try {
        if (values) sessionStorage.setItem(PENDING_REGISTER_KEY, JSON.stringify(values));
        else sessionStorage.removeItem(PENDING_REGISTER_KEY);
    } catch (e) {}
}

function getPendingRegister() {
    if (pendingRegister && pendingRegister.first_name && pendingRegister.password) return pendingRegister;
    try {
        const raw = sessionStorage.getItem(PENDING_REGISTER_KEY);
        if (!raw) return pendingRegister;
        const parsed = JSON.parse(raw);
        if (parsed && parsed.first_name && parsed.password) {
            pendingRegister = parsed;
            return parsed;
        }
    } catch (e) {}
    const form = document.getElementById('register-form');
    if (form) {
        const fromForm = readRegisterForm(form);
        if (fromForm.first_name && fromForm.password) {
            pendingRegister = fromForm;
            return fromForm;
        }
    }
    return pendingRegister;
}

function setError(name, message) {
    const input = document.getElementById(name);
    const err = document.getElementById('err-' + name);
    if (!err) return;
    if (message) {
        err.hidden = false;
        err.textContent = message;
        if (input) input.setAttribute('aria-invalid', 'true');
    } else {
        err.hidden = true;
        err.textContent = '';
        if (input) input.removeAttribute('aria-invalid');
    }
}

function showPanel(id) {
    const apply = () => {
        PANELS.forEach(name => {
            const el = document.getElementById(name);
            if (el) el.hidden = name !== id;
        });
        document.documentElement.classList.toggle('curtain-auth-wide', id === 'auth-register');
    };
    const stage = document.getElementById('entry-auth-stage');
    if (!stage || stage.hidden || !document.documentElement.classList.contains('curtain-auth')) {
        apply();
        return;
    }
    stage.classList.add('is-swap');
    window.setTimeout(() => {
        apply();
        stage.classList.remove('is-swap');
    }, 180);
}

function openCurtainAuth() {
    const stage = document.getElementById('entry-auth-stage');
    const shell = document.getElementById('entry-auth-shell');
    if (!stage || !shell) return;
    showPanel('auth-gate');
    stage.hidden = false;
    document.documentElement.classList.add('curtain-auth');
    preferPortraitOnMobile();
    if (!window.matchMedia('(max-width: 767px)').matches) {
        const phone = document.getElementById('gate-phone');
        window.setTimeout(() => { if (phone) phone.focus(); }, 420);
    }
    if (window.location.hash !== '#auth') {
        try { history.replaceState(null, '', '#auth'); } catch (e) {}
    }
}

function closeCurtainAuth() {
    clearOtpVerification();
    const stage = document.getElementById('entry-auth-stage');
    const home = document.getElementById('entry-launch-home');
    document.documentElement.classList.remove('curtain-auth', 'curtain-auth-wide');
    currentPhone = '';
    otpPurpose = '';
    setPendingRegister(null);
    stopResendTimer();
    setOtpSending(false);
    if (stage) {
        stage.hidden = true;
        stage.classList.remove('is-swap');
    }
    if (home) home.hidden = false;
    PANELS.forEach(name => {
        const el = document.getElementById(name);
        if (el) el.hidden = name !== 'auth-gate';
    });
    if ((window.location.hash || '') === '#auth') {
        try { history.replaceState(null, '', window.location.pathname + window.location.search); } catch (e) {}
    }
    try { sessionStorage.removeItem(AUTH_NEXT_KEY); } catch (e) {}
}

window.openCurtainAuth = openCurtainAuth;
window.closeCurtainAuth = closeCurtainAuth;

function failDetail(data, fallback) {
    if (!data || data.detail == null) return fallback;
    if (typeof data.detail === 'string') return data.detail;
    if (data.detail.message) return data.detail.message;
    return fallback;
}

function displayName(row) {
    return [row && row.first_name, row && row.last_name].filter(Boolean).join(' ');
}

function finishSignedIn(profile) {
    clearOtpVerification();
    writeBannerProfile(profile);
    const next = takeAuthNext();
    if (next && (next.page === 'explorer' || next.page === 'bubble')) {
        window.location.href = hrefForAuthNext(next);
        return;
    }
    if (profile && profile.is_admin) {
        window.location.href = SITE.page('admin.html');
        return;
    }
    if (document.getElementById('entry-auth-shell')) {
        closeCurtainAuth();
        window.dispatchEvent(new Event('bina-session-changed'));
        return;
    }
    window.location.href = SITE.page('index.html');
}

function readRegisterForm(form) {
    const data = Object.fromEntries(new FormData(form).entries());
    return {
        first_name: String(data.first_name || '').trim(),
        last_name: String(data.last_name || '').trim(),
        phone: currentPhone,
        role_title: String(data.role_title || '').trim(),
        organization: String(data.organization || '').trim(),
        password: String(data.password || ''),
        password_confirm: String(data.password_confirm || '')
    };
}

function validateRegister(values) {
    const errors = {};
    if (values.first_name.length < 2) errors.first_name = 'نام را وارد کنید';
    else if (plainTextError(values.first_name)) errors.first_name = plainTextError(values.first_name);
    if (values.last_name.length < 2) errors.last_name = 'نام خانوادگی را وارد کنید';
    else if (plainTextError(values.last_name)) errors.last_name = plainTextError(values.last_name);
    if (!values.role_title) errors.role_title = 'سمت را وارد کنید';
    else if (plainTextError(values.role_title)) errors.role_title = plainTextError(values.role_title);
    if (plainTextError(values.organization)) errors.organization = plainTextError(values.organization);
    if (values.password.length < 8) errors.password = 'رمز عبور حداقل ۸ نویسه باشد';
    if (values.password_confirm !== values.password) errors.password_confirm = 'تکرار رمز با رمز عبور یکی نیست';
    return errors;
}

function errorFromRegister(data) {
    const detail = data && data.detail;
    const code = detail && detail.code;
    const message = detail && detail.message;
    if (code === 'closed') return { field: '', text: message || 'ثبت‌نام موقتاً بسته است' };
    if (code === 'pending') return { field: '', text: message || 'برای این شماره یک درخواست در انتظار بررسی است' };
    if (code === 'exists') return { field: '', text: message || 'برای این شماره قبلاً حساب پذیرفته شده است' };
    if (code === 'otp') return { field: '', text: message || 'ابتدا کد پیامک را تأیید کنید' };
    if (code === 'phone') return { field: '', text: message || 'شماره موبایل نامعتبر است' };
    if (code === 'first_name' || code === 'last_name') return { field: code, text: message || 'این فیلد را کامل کنید' };
    if (code === 'role') return { field: 'role_title', text: message || 'سمت را وارد کنید' };
    if (code === 'password') return { field: 'password', text: message || 'رمز عبور نامعتبر است' };
    if (typeof detail === 'string') return { field: '', text: detail };
    return { field: '', text: 'ارسال درخواست ممکن نشد.' };
}

function applyPhone(phone) {
    clearOtpVerification();
    currentPhone = phone;
    const nodes = {
        'login-phone': phone,
        'login-phone-label': phone,
        'register-phone': phone,
        'otp-phone-label': phone,
        'reset-phone-label': phone
    };
    Object.keys(nodes).forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        if (el.tagName === 'INPUT') el.value = nodes[id];
        else el.textContent = nodes[id];
    });
}

function stopResendTimer() {
    window.clearInterval(resendTimer);
    resendTimer = 0;
    resendLeft = 0;
    const btn = document.getElementById('otp-resend');
    if (btn) {
        btn.disabled = false;
        btn.textContent = 'ارسال دوباره';
    }
}

function startResendTimer(seconds) {
    const btn = document.getElementById('otp-resend');
    if (!btn) return;
    stopResendTimer();
    resendLeft = Math.max(0, Number(seconds) || 0);
    const tick = () => {
        if (resendLeft <= 0) {
            stopResendTimer();
            return;
        }
        btn.disabled = true;
        btn.textContent = 'ارسال دوباره (' + resendLeft + ')';
        resendLeft -= 1;
    };
    tick();
    if (resendLeft > 0) resendTimer = window.setInterval(tick, 1000);
}

function setOtpSending(on) {
    const box = document.getElementById('otp-sending');
    const form = document.getElementById('otp-form');
    const hint = document.getElementById('otp-resend-wrap');
    if (box) box.hidden = !on;
    if (form) form.hidden = on;
    if (hint) hint.hidden = on;
}

function backToGate() {
    clearOtpVerification();
    currentPhone = '';
    otpPurpose = '';
    setPendingRegister(null);
    stopResendTimer();
    setOtpSending(false);
    showPanel('auth-gate');
    const input = document.getElementById('gate-phone');
    if (input) input.focus();
}

function showStatus(title, text) {
    document.getElementById('auth-status-title').textContent = title;
    document.getElementById('auth-status-text').textContent = text;
    showPanel('auth-status');
}

async function apiJson(path, body) {
    const response = await fetch(`${API_BASE_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body)
    });
    let data = null;
    try { data = await response.json(); } catch (e) { data = null; }
    if (!response.ok) {
        const err = new Error(failDetail(data, 'انجام این اقدام ممکن نشد.'));
        err.code = data && data.detail && data.detail.code;
        throw err;
    }
    return data;
}

async function lookupPhone(phone) {
    const data = await apiJson('/api/auth/gate', { phone: phone });
    return data && data.status;
}

async function sendOtp(purpose, captcha) {
    clearOtpVerification();
    const body = { phone: currentPhone, purpose: purpose };
    if (captcha) { body.captcha_id = captcha.id; body.captcha_answer = captcha.answer; }
    return apiJson('/api/auth/otp/send', body);
}
async function completeRegistration(pending) {
    await apiJson('/api/auth/register', {
        first_name: pending.first_name,
        last_name: pending.last_name,
        phone: currentPhone,
        role_title: pending.role_title,
        organization: pending.organization,
        password: pending.password,
        verification_token: verificationToken('register')
    });
    clearOtpVerification();
    setPendingRegister(null);
    showStatus('در انتظار تایید', 'درخواست عضویت شما درانتظار تایید است');
}

async function startOtp(purpose, captcha) {
    otpPurpose = purpose;
    setOtpValue(document.getElementById('otp-code'), '');
    setError('otp-code', '');
    showPanel('auth-otp');
    setOtpSending(true);
    try {
        const data = await sendOtp(purpose, captcha);
        setOtpSending(false);
        startResendTimer((data && data.resend_seconds) || 60);
        focusOtpInput(document.getElementById('otp-code'));
    } catch (err) {
        setOtpSending(false);
        throw err;
    }
}
function initPasswordToggles() {
    document.querySelectorAll('[data-password-toggle]').forEach(button => {
        const input = document.getElementById(button.getAttribute('data-password-toggle'));
        if (!input) return;
        button.addEventListener('click', () => {
            const visible = input.type === 'password';
            input.type = visible ? 'text' : 'password';
            button.setAttribute('aria-pressed', String(visible));
            button.setAttribute('aria-label', visible ? 'پنهان کردن رمز عبور' : 'نمایش رمز عبور');
            input.focus({ preventScroll: true });
        });
    });
}

function revealFocusedAuthField(input) {
    if (!window.matchMedia('(max-width: 767px)').matches) return;
    const stage = document.getElementById('entry-auth-stage');
    if (!stage || !stage.contains(input) || !document.documentElement.classList.contains('curtain-auth')) return;
    document.documentElement.classList.add('auth-keyboard-open');
    [0, 180, 380].forEach(delay => window.setTimeout(() => {
        if (document.activeElement === input) input.scrollIntoView({ block: 'center', inline: 'nearest', behavior: delay ? 'smooth' : 'auto' });
    }, delay));
}

function initAuthMobileFieldVisibility() {
    const stage = document.getElementById('entry-auth-stage');
    if (!stage) return;
    stage.querySelectorAll('input, textarea, select').forEach(input => {
        input.addEventListener('focus', () => revealFocusedAuthField(input));
        input.addEventListener('blur', () => window.setTimeout(() => {
            if (!stage.contains(document.activeElement)) document.documentElement.classList.remove('auth-keyboard-open');
        }, 120));
    });
}

function preferPortraitOnMobile() {
    if (!window.matchMedia('(max-width: 767px)').matches) return;
    const orientation = window.screen && window.screen.orientation;
    if (orientation && typeof orientation.lock === 'function') orientation.lock('portrait').catch(() => {});
}
onReady(() => {
    const gateForm = document.getElementById('gate-form');
    const gateSubmit = document.getElementById('gate-submit');
    const gatePhone = document.getElementById('gate-phone');
    if (!gateForm || !gatePhone) return;
    initPasswordToggles();
    initAuthMobileFieldVisibility();
    document.querySelectorAll('[data-captcha-refresh]').forEach(button => {
        button.addEventListener('click', async () => {
            const name = button.getAttribute('data-captcha-refresh');
            try { await refreshCaptcha(name, currentPhone || digitsOnlyPhone(gatePhone.value)); }
            catch (err) { showNotice(err.message || 'دریافت کد امنیتی ممکن نشد.'); }
        });
    });
    const loginRefresh = document.getElementById('login-captcha-refresh');
    if (loginRefresh) loginRefresh.addEventListener('click', async () => {
        try { await refreshCaptcha('login', currentPhone); }
        catch (err) { showNotice(err.message || 'دریافت کد امنیتی ممکن نشد.'); }
    });    bindPhoneInput(gatePhone);
    bindOtpInput(document.getElementById('otp-code'));
    ['login-password', 'first_name', 'last_name', 'role_title', 'organization', 'password', 'password_confirm', 'reset-password', 'reset-password-confirm'].forEach(id => {
        quietMobileField(document.getElementById(id));
    });

    const openBtn = document.getElementById('btn-open-login');
    if (openBtn) openBtn.addEventListener('click', openCurtainAuth);
    const bannerBtn = document.getElementById('banner-auth-btn');
    if (bannerBtn && document.getElementById('entry-auth-shell')) {
        bannerBtn.addEventListener('click', event => {
            event.preventDefault();
            openCurtainAuth();
        });
    }
    if (window.location.hash === '#auth' && !readBannerProfile()) openCurtainAuth();
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        if (!document.documentElement.classList.contains('curtain-auth')) return;
        const gate = document.getElementById('auth-gate');
        if (gate && !gate.hidden) closeCurtainAuth();
    });

    document.querySelectorAll('[data-auth-back]').forEach(btn => {
        btn.addEventListener('click', backToGate);
    });
    const gateClose = document.getElementById('auth-gate-close');
    if (gateClose) gateClose.addEventListener('click', closeCurtainAuth);

    gateForm.addEventListener('submit', async event => {
        event.preventDefault();
        setError('gate-phone', '');
        const phone = digitsOnlyPhone(gatePhone.value);
        if (!/^09\d{9}$/.test(phone)) { setError('gate-phone', 'شماره موبایل باید ۱۱ رقم و با ۰۹ شروع شود.'); gatePhone.focus(); return; }
        gateSubmit.disabled = true;
        try {
            const status = await lookupPhone(phone);
            applyPhone(phone);
            if (status === 'login') { showPanel('auth-login'); void refreshCaptcha('login', phone).catch(err => showNotice(err.message || 'دریافت کد امنیتی ممکن نشد.')); document.getElementById('login-password').focus(); return; }
            if (status === 'register') { setPendingRegister(null); showPanel('auth-register'); void refreshCaptcha('register', phone).catch(err => showNotice(err.message || 'دریافت کد امنیتی ممکن نشد.')); document.getElementById('first_name').focus(); return; }
            if (status === 'pending') { showStatus('در انتظار تایید', 'درخواست عضویت شما درانتظار تایید است'); return; }
            if (status === 'rejected') { showStatus('درخواست پذیرفته نشد', 'متاسفیم، درخواست عضویت شما پذیرفته نشد.'); return; }
            if (status === 'closed') { showStatus('ثبت‌نام بسته است', 'ثبت‌نام عمومی فعلاً متوقف شده است.'); return; }
            setError('gate-phone', 'بررسی شماره ممکن نشد.');
        } catch (err) {
            setError('gate-phone', err.message || 'بررسی شماره ممکن نشد.');
        } finally { gateSubmit.disabled = false; }
    });
    document.getElementById('login-form').addEventListener('submit', async event => {
        event.preventDefault(); setError('login-password', '');
        const password = document.getElementById('login-password').value;
        if (password.length < 8) { setError('login-password', 'رمز عبور حداقل ۸ نویسه باشد.'); document.getElementById('login-password').focus(); return; }
        const captcha = readCaptcha('login');
        if (!captcha.valid) { setError('login-captcha-answer', 'کد امنیتی پنج‌نویسه را وارد کنید.'); document.getElementById('login-captcha-answer').focus(); return; }
        const submit = document.getElementById('login-submit'); submit.disabled = true;
        try { const profile = await apiJson('/api/auth/login', { phone: currentPhone, password: password, captcha_id: captcha.id, captcha_answer: captcha.answer }); finishSignedIn(profile); }
        catch (err) { showNotice(err.message || 'ورود ناموفق بود.'); try { await refreshCaptcha('login', currentPhone); } catch (refreshError) {} }
        finally { submit.disabled = false; }
    });
    document.getElementById('forgot-password').addEventListener('click', async () => {
        showPanel('auth-reset-captcha');
        try { await refreshCaptcha('reset', currentPhone); }
        catch (err) { showNotice(err.message || 'دریافت کد امنیتی ممکن نشد.'); }
    });

    document.getElementById('reset-captcha-form').addEventListener('submit', async event => {
        event.preventDefault();
        const captcha = readCaptcha('reset');
        if (!captcha.valid) { setError('reset-captcha-answer', 'کد امنیتی پنج‌نویسه را وارد کنید.'); return; }
        const submit = document.getElementById('reset-captcha-submit'); submit.disabled = true;
        try { await startOtp('reset', captcha); clearCaptcha('reset'); }
        catch (err) { showNotice(err.message || 'کد امنیتی نامعتبر یا منقضی است.'); showPanel('auth-reset-captcha'); try { await refreshCaptcha('reset', currentPhone); } catch (refreshError) {} }
        finally { submit.disabled = false; }
    });
    document.getElementById('otp-form').addEventListener('submit', async event => {
        event.preventDefault();
        setError('otp-code', '');
        const code = normalizeOtpCode(document.getElementById('otp-code').value);
        if (code.length !== 6) {
            setError('otp-code', 'کد باید ۶ رقم باشد.');
            focusOtpInput(document.getElementById('otp-code'));
            return;
        }
        const submit = document.getElementById('otp-submit');
        submit.disabled = true;
        const flowVersion = otpFlowVersion;
        const phone = currentPhone;
        const purpose = otpPurpose;
        try {
            if (!otpVerification) {
                const verified = await apiJson('/api/auth/otp/verify', {
                    phone: phone,
                    purpose: purpose,
                    code: code
                });
                if (flowVersion !== otpFlowVersion) return;
                if (!verified || !/^[A-Za-z0-9_-]{43}$/.test(verified.verification_token || '')) {
                    throw new Error('تأیید شماره ممکن نشد. دوباره کد بگیرید.');
                }
                otpVerification = { phone: phone, purpose: purpose, token: verified.verification_token };
            }
            if (otpPurpose === 'register') {
                const pending = getPendingRegister();
                if (!pending || !pending.first_name || !pending.password) {
                    showPanel('auth-register');
                    document.getElementById('first_name').focus();
                    return;
                }
                await completeRegistration(pending);
                return;
            }
            showPanel('auth-reset');
            document.getElementById('reset-password').focus();
        } catch (err) {
            if (flowVersion !== otpFlowVersion) return;
            if (err.code === 'otp') clearOtpVerification();
            if (err.code === 'captcha') { showPanel('auth-register'); try { await refreshCaptcha('register', currentPhone); } catch (refreshError) {} }
            setError('otp-code', err.message || 'کد نامعتبر است.');
        } finally {
            submit.disabled = false;
        }
    });

    document.getElementById('otp-resend').addEventListener('click', async () => {
        const btn = document.getElementById('otp-resend');
        if (btn.disabled) return;
        if (otpPurpose === 'reset' || otpPurpose === 'register') {
            const captchaName = otpPurpose;
            showPanel(captchaName === 'reset' ? 'auth-reset-captcha' : 'auth-register');
            try { await refreshCaptcha(captchaName, currentPhone); }
            catch (err) { showNotice(err.message || 'دریافت کد امنیتی ممکن نشد.'); }
            return;
        }
        setError('otp-code', '');
        setOtpSending(true);
        try {
            const data = await sendOtp(otpPurpose);
            setOtpSending(false);
            startResendTimer((data && data.resend_seconds) || 60);
            showNotice('کد دوباره ارسال شد.', 'ok');
        } catch (err) {
            setOtpSending(false);
            setError('otp-code', err.message || 'ارسال دوباره ممکن نشد.');
        }
    });

    document.getElementById('reset-form').addEventListener('submit', async event => {
        event.preventDefault();
        setError('reset-password', '');
        setError('reset-password-confirm', '');
        const password = document.getElementById('reset-password').value;
        const confirm = document.getElementById('reset-password-confirm').value;
        if (password.length < 8) {
            setError('reset-password', 'رمز عبور حداقل ۸ نویسه باشد.');
            document.getElementById('reset-password').focus();
            return;
        }
        if (confirm !== password) {
            setError('reset-password-confirm', 'تکرار رمز با رمز عبور یکی نیست.');
            document.getElementById('reset-password-confirm').focus();
            return;
        }
        const submit = document.getElementById('reset-submit');
        submit.disabled = true;
        try {
            const profile = await apiJson('/api/auth/password/reset', {
                phone: currentPhone,
                password: password,
                verification_token: verificationToken('reset')
            });
            finishSignedIn(profile);
        } catch (err) {
            if (err.code === 'otp') {
                clearOtpVerification();
                showPanel('auth-otp');
            }
            showNotice(err.message || 'تغییر رمز ممکن نشد.');
        } finally {
            submit.disabled = false;
        }
    });

    document.getElementById('register-form').addEventListener('submit', async event => {
        event.preventDefault();
        REGISTER_FIELDS.forEach(name => setError(name, ''));
        setError('register-captcha-answer', '');
        const form = event.currentTarget;
        const values = readRegisterForm(form);
        const errors = validateRegister(values);
        const names = Object.keys(errors);
        if (names.length) {
            names.forEach(name => setError(name, errors[name]));
            document.getElementById(names[0]).focus();
            return;
        }
        const captcha = readCaptcha('register');
        if (!captcha.valid) { setError('register-captcha-answer', 'کد امنیتی پنج‌نویسه را وارد کنید.'); document.getElementById('register-captcha-answer').focus(); return; }
        const submit = document.getElementById('register-submit');
        submit.disabled = true;
        try {
            setPendingRegister(values);
            if (otpVerification && otpVerification.phone === currentPhone && otpVerification.purpose === 'register') {
                await completeRegistration(values);
            } else {
                await startOtp('register', captcha);
                clearCaptcha('register');
            }
        } catch (err) {
            setPendingRegister(null);
            if (err.code === 'otp') clearOtpVerification();
            if (err.code === 'captcha') { showPanel('auth-register'); try { await refreshCaptcha('register', currentPhone); } catch (refreshError) {} }
            const mapped = errorFromRegister({ detail: { code: err.code, message: err.message } });
            if (mapped.field) setError(mapped.field, mapped.text);
            else showNotice(mapped.text);
        } finally {
            submit.disabled = false;
        }
    });
});

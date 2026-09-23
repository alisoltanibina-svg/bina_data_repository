// File: auth-page.js
// Purpose: Phone gate, password login, OTP for register/reset, then session cookie.

const REGISTER_FIELDS = ['first_name', 'last_name', 'role_title', 'organization', 'password', 'password_confirm'];
const PANELS = ['auth-gate', 'auth-login', 'auth-otp', 'auth-reset', 'auth-register', 'auth-status', 'auth-done'];

let currentPhone = '';
let otpPurpose = '';

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
    PANELS.forEach(name => {
        const el = document.getElementById(name);
        if (el) el.hidden = name !== id;
    });
}

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
    writeBannerProfile(profile);
    window.location.href = profile && profile.is_admin ? SITE.page('admin.html') : SITE.page('index.html');
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
    if (values.first_name.length < 2) errors.first_name = 'نام را وارد کنید.';
    else if (plainTextError(values.first_name)) errors.first_name = plainTextError(values.first_name);
    if (values.last_name.length < 2) errors.last_name = 'نام خانوادگی را وارد کنید.';
    else if (plainTextError(values.last_name)) errors.last_name = plainTextError(values.last_name);
    if (!values.role_title) errors.role_title = 'سمت را وارد کنید.';
    else if (plainTextError(values.role_title)) errors.role_title = plainTextError(values.role_title);
    if (plainTextError(values.organization)) errors.organization = plainTextError(values.organization);
    if (values.password.length < 8) errors.password = 'رمز عبور حداقل ۸ نویسه باشد.';
    if (values.password_confirm !== values.password) errors.password_confirm = 'تکرار رمز با رمز عبور یکی نیست.';
    return errors;
}

function errorFromRegister(data) {
    const detail = data && data.detail;
    const code = detail && detail.code;
    const message = detail && detail.message;
    if (code === 'pending') return { field: '', text: message || 'برای این شماره یک درخواست در انتظار بررسی است.' };
    if (code === 'exists') return { field: '', text: message || 'برای این شماره قبلاً حساب پذیرفته شده است.' };
    if (code === 'otp') return { field: '', text: message || 'ابتدا کد پیامک را تأیید کنید.' };
    if (code === 'phone') return { field: '', text: message || 'شماره موبایل نامعتبر است.' };
    if (code === 'first_name' || code === 'last_name') return { field: code, text: message || 'این فیلد را کامل کنید.' };
    if (code === 'role') return { field: 'role_title', text: message || 'سمت را وارد کنید.' };
    if (code === 'password') return { field: 'password', text: message || 'رمز عبور نامعتبر است.' };
    if (typeof detail === 'string') return { field: '', text: detail };
    return { field: '', text: 'ارسال درخواست ممکن نشد.' };
}

function applyPhone(phone) {
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

function backToGate() {
    currentPhone = '';
    otpPurpose = '';
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

async function sendOtp(purpose) {
    return apiJson('/api/auth/otp/send', { phone: currentPhone, purpose: purpose });
}

async function startOtp(purpose) {
    otpPurpose = purpose;
    await sendOtp(purpose);
    document.getElementById('otp-code').value = '';
    setError('otp-code', '');
    showPanel('auth-otp');
    document.getElementById('otp-code').focus();
}

onReady(() => {
    const gateForm = document.getElementById('gate-form');
    const gateSubmit = document.getElementById('gate-submit');
    const gatePhone = document.getElementById('gate-phone');
    bindPhoneInput(gatePhone);

    document.querySelectorAll('[data-auth-back]').forEach(btn => {
        btn.addEventListener('click', backToGate);
    });

    gateForm.addEventListener('submit', async event => {
        event.preventDefault();
        setError('gate-phone', '');
        const phone = digitsOnlyPhone(gatePhone.value);
        if (!/^09\d{9}$/.test(phone)) {
            setError('gate-phone', 'شماره موبایل باید ۱۱ رقم و با ۰۹ شروع شود.');
            gatePhone.focus();
            return;
        }
        gateSubmit.disabled = true;
        try {
            const status = await lookupPhone(phone);
            applyPhone(phone);
            if (status === 'login') {
                showPanel('auth-login');
                document.getElementById('login-password').focus();
                return;
            }
            if (status === 'register') {
                await startOtp('register');
                return;
            }
            if (status === 'pending') {
                showStatus('در انتظار تایید', 'درخواست عضویت شما درانتظار تایید است');
                return;
            }
            if (status === 'rejected') {
                showStatus(
                    'درخواست پذیرفته نشد',
                    'متاسفیم، درخواست عضویت شما مطابق با سیاست‌های مجموعه ما نبوده است. می‌توانید از طریق لینک زیر درخواست بازنگری کنید.'
                );
                return;
            }
            setError('gate-phone', 'بررسی شماره ممکن نشد.');
        } catch (err) {
            setError('gate-phone', err.message || 'ارتباط با سرور برقرار نشد.');
        } finally {
            gateSubmit.disabled = false;
        }
    });

    document.getElementById('login-form').addEventListener('submit', async event => {
        event.preventDefault();
        setError('login-password', '');
        const password = document.getElementById('login-password').value;
        if (password.length < 8) {
            setError('login-password', 'رمز عبور حداقل ۸ نویسه باشد.');
            document.getElementById('login-password').focus();
            return;
        }
        const submit = document.getElementById('login-submit');
        submit.disabled = true;
        try {
            const profile = await apiJson('/api/auth/login', { phone: currentPhone, password: password });
            finishSignedIn(profile);
        } catch (err) {
            showNotice(err.message || 'ورود ناموفق بود.');
        } finally {
            submit.disabled = false;
        }
    });

    document.getElementById('forgot-password').addEventListener('click', async () => {
        const btn = document.getElementById('forgot-password');
        btn.disabled = true;
        try {
            await startOtp('reset');
        } catch (err) {
            showNotice(err.message || 'ارسال کد ممکن نشد.');
        } finally {
            btn.disabled = false;
        }
    });

    document.getElementById('otp-form').addEventListener('submit', async event => {
        event.preventDefault();
        setError('otp-code', '');
        const code = (document.getElementById('otp-code').value || '').replace(/\D/g, '');
        if (code.length !== 6) {
            setError('otp-code', 'کد باید ۶ رقم باشد.');
            document.getElementById('otp-code').focus();
            return;
        }
        const submit = document.getElementById('otp-submit');
        submit.disabled = true;
        try {
            await apiJson('/api/auth/otp/verify', {
                phone: currentPhone,
                purpose: otpPurpose,
                code: code
            });
            if (otpPurpose === 'register') {
                showPanel('auth-register');
                document.getElementById('first_name').focus();
                return;
            }
            showPanel('auth-reset');
            document.getElementById('reset-password').focus();
        } catch (err) {
            setError('otp-code', err.message || 'کد نامعتبر است.');
        } finally {
            submit.disabled = false;
        }
    });

    document.getElementById('otp-resend').addEventListener('click', async () => {
        const btn = document.getElementById('otp-resend');
        btn.disabled = true;
        setError('otp-code', '');
        try {
            await sendOtp(otpPurpose);
            showNotice('کد دوباره ارسال شد.', 'ok');
        } catch (err) {
            setError('otp-code', err.message || 'ارسال دوباره ممکن نشد.');
        } finally {
            btn.disabled = false;
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
                password: password
            });
            finishSignedIn(profile);
        } catch (err) {
            showNotice(err.message || 'تغییر رمز ممکن نشد.');
        } finally {
            submit.disabled = false;
        }
    });

    document.getElementById('register-form').addEventListener('submit', async event => {
        event.preventDefault();
        REGISTER_FIELDS.forEach(name => setError(name, ''));
        const form = event.currentTarget;
        const values = readRegisterForm(form);
        const errors = validateRegister(values);
        const names = Object.keys(errors);
        if (names.length) {
            names.forEach(name => setError(name, errors[name]));
            document.getElementById(names[0]).focus();
            return;
        }
        const submit = document.getElementById('register-submit');
        submit.disabled = true;
        try {
            const profile = await apiJson('/api/auth/register', {
                first_name: values.first_name,
                last_name: values.last_name,
                phone: currentPhone,
                role_title: values.role_title,
                organization: values.organization,
                password: values.password
            });
            finishSignedIn(profile);
        } catch (err) {
            const mapped = errorFromRegister({ detail: { code: err.code, message: err.message } });
            if (mapped.field) setError(mapped.field, mapped.text);
            else showNotice(mapped.text);
        } finally {
            submit.disabled = false;
        }
    });
});

// File: auth-page.js
// Purpose: One authentication page — phone lookup, then login, register, or status.

const REGISTER_FIELDS = ['first_name', 'last_name', 'role_title', 'organization', 'password', 'password_confirm'];
const PANELS = ['auth-gate', 'auth-login', 'auth-register', 'auth-status', 'auth-done'];

let currentPhone = '';

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
    if (code === 'phone') return { field: '', text: message || 'شماره موبایل نامعتبر است.' };
    if (code === 'first_name' || code === 'last_name') return { field: code, text: message || 'این فیلد را کامل کنید.' };
    if (code === 'role') return { field: 'role_title', text: message || 'سمت را وارد کنید.' };
    if (code === 'password') return { field: 'password', text: message || 'رمز عبور نامعتبر است.' };
    if (typeof detail === 'string') return { field: '', text: detail };
    return { field: '', text: 'ارسال درخواست ممکن نشد.' };
}

function applyPhone(phone) {
    currentPhone = phone;
    const loginPhone = document.getElementById('login-phone');
    const loginLabel = document.getElementById('login-phone-label');
    const registerPhone = document.getElementById('register-phone');
    if (loginPhone) loginPhone.value = phone;
    if (loginLabel) loginLabel.textContent = phone;
    if (registerPhone) registerPhone.value = phone;
}

function backToGate() {
    currentPhone = '';
    showPanel('auth-gate');
    const input = document.getElementById('gate-phone');
    if (input) input.focus();
}

function showStatus(title, text) {
    document.getElementById('auth-status-title').textContent = title;
    document.getElementById('auth-status-text').textContent = text;
    showPanel('auth-status');
}

async function lookupPhone(phone) {
    const response = await fetch(`${API_BASE_URL}/api/auth/gate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phone })
    });
    let data = null;
    try { data = await response.json(); } catch (e) { data = null; }
    if (!response.ok) {
        throw new Error(failDetail(data, 'بررسی شماره ممکن نشد.'));
    }
    return data && data.status;
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
                showPanel('auth-register');
                document.getElementById('first_name').focus();
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
            const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ phone: currentPhone, password: password })
            });
            let data = null;
            try { data = await response.json(); } catch (e) { data = null; }
            if (!response.ok) {
                showNotice(failDetail(data, 'ورود ناموفق بود.'));
                return;
            }
            writeBannerProfile(data);
            window.location.href = data && data.is_admin ? SITE.page('admin.html') : SITE.page('index.html');
        } catch (err) {
            showNotice('ارتباط با سرور برقرار نشد.');
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
            const response = await fetch(`${API_BASE_URL}/api/auth/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    first_name: values.first_name,
                    last_name: values.last_name,
                    phone: currentPhone,
                    role_title: values.role_title,
                    organization: values.organization,
                    password: values.password
                })
            });
            let data = null;
            try { data = await response.json(); } catch (e) { data = null; }
            if (!response.ok) {
                const err = errorFromRegister(data);
                if (err.field) setError(err.field, err.text);
                else showNotice(err.text);
                return;
            }
            form.reset();
            document.getElementById('auth-done-text').textContent =
                'درخواست «' + displayName(data) + '» ثبت شد. پس از پذیرش مدیر می‌توانید وارد بخش‌های نیازمند عضویت شوید.';
            showPanel('auth-done');
        } catch (err) {
            showNotice('ارتباط با سرور برقرار نشد.');
        } finally {
            submit.disabled = false;
        }
    });
});

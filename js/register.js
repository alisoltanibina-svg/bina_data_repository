// File: register.js
// Purpose: Validate and submit a membership request through POST /api/auth/register.

const FIELDS = ['first_name', 'last_name', 'phone', 'role_title', 'organization', 'password', 'password_confirm'];

function setError(name, message) {
    const input = document.getElementById(name);
    const err = document.getElementById('err-' + name);
    if (!input || !err) return;
    if (message) {
        err.hidden = false;
        err.textContent = message;
        input.setAttribute('aria-invalid', 'true');
    } else {
        err.hidden = true;
        err.textContent = '';
        input.removeAttribute('aria-invalid');
    }
}

function clearErrors() {
    FIELDS.forEach(name => setError(name, ''));
}

function normalizePhone(raw) {
    return digitsOnlyPhone(raw);
}

function isMobilePhone(phone) {
    return /^09\d{9}$/.test(phone);
}

function displayName(row) {
    return [row && row.first_name, row && row.last_name].filter(Boolean).join(' ');
}

function readForm(form) {
    const data = Object.fromEntries(new FormData(form).entries());
    return {
        first_name: String(data.first_name || '').trim(),
        last_name: String(data.last_name || '').trim(),
        phone: String(data.phone || '').trim(),
        role_title: String(data.role_title || '').trim(),
        organization: String(data.organization || '').trim(),
        password: String(data.password || ''),
        password_confirm: String(data.password_confirm || '')
    };
}

function validate(values) {
    const errors = {};
    if (values.first_name.length < 2) errors.first_name = 'نام را وارد کنید.';
    else if (plainTextError(values.first_name)) errors.first_name = plainTextError(values.first_name);
    if (values.last_name.length < 2) errors.last_name = 'نام خانوادگی را وارد کنید.';
    else if (plainTextError(values.last_name)) errors.last_name = plainTextError(values.last_name);
    if (!isMobilePhone(normalizePhone(values.phone))) errors.phone = 'شماره موبایل باید ۱۱ رقم و با ۰۹ شروع شود.';
    if (!values.role_title) errors.role_title = 'سمت را وارد کنید.';
    else if (plainTextError(values.role_title)) errors.role_title = plainTextError(values.role_title);
    if (plainTextError(values.organization)) errors.organization = plainTextError(values.organization);
    if (values.password.length < 8) errors.password = 'رمز عبور حداقل ۸ نویسه باشد.';
    if (values.password_confirm !== values.password) errors.password_confirm = 'تکرار رمز با رمز عبور یکی نیست.';
    return errors;
}

function showDone(name) {
    document.getElementById('register-card').hidden = true;
    const done = document.getElementById('register-done');
    done.hidden = false;
    document.getElementById('register-done-text').textContent =
        'درخواست «' + name + '» ثبت شد. پس از پذیرش مدیر می‌توانید وارد بخش‌های نیازمند عضویت شوید.';
}

function errorFromResponse(data) {
    const detail = data && data.detail;
    const code = detail && detail.code;
    const message = detail && detail.message;
    if (code === 'pending') return { field: 'phone', text: message || 'برای این شماره یک درخواست در انتظار بررسی است.' };
    if (code === 'exists') return { field: 'phone', text: message || 'برای این شماره قبلاً حساب پذیرفته شده است.' };
    if (code === 'phone') return { field: 'phone', text: message || 'شماره موبایل نامعتبر است.' };
    if (code === 'first_name' || code === 'last_name') return { field: code, text: message || 'این فیلد را کامل کنید.' };
    if (code === 'role') return { field: 'role_title', text: message || 'سمت را وارد کنید.' };
    if (code === 'password') return { field: 'password', text: message || 'رمز عبور نامعتبر است.' };
    if (typeof detail === 'string') return { field: '', text: detail };
    return { field: '', text: 'ارسال درخواست ممکن نشد.' };
}

onReady(() => {
    const form = document.getElementById('register-form');
    const submit = document.getElementById('register-submit');
    bindPhoneInput(document.getElementById('phone'));

    form.addEventListener('submit', async event => {
        event.preventDefault();
        clearErrors();
        const values = readForm(form);
        const errors = validate(values);
        const names = Object.keys(errors);
        if (names.length) {
            names.forEach(name => setError(name, errors[name]));
            document.getElementById(names[0]).focus();
            return;
        }

        submit.disabled = true;
        try {
            const response = await fetch(`${API_BASE_URL}/api/auth/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    first_name: values.first_name,
                    last_name: values.last_name,
                    phone: normalizePhone(values.phone),
                    role_title: values.role_title,
                    organization: values.organization,
                    password: values.password
                })
            });
            let data = null;
            try { data = await response.json(); } catch (e) { data = null; }
            if (!response.ok) {
                const err = errorFromResponse(data);
                if (err.field) setError(err.field, err.text);
                else showNotice(err.text);
                return;
            }
            form.reset();
            showDone(displayName(data));
        } catch (err) {
            showNotice('ارتباط با سرور برقرار نشد.');
        } finally {
            submit.disabled = false;
        }
    });
});

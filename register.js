// File: register.js
// Purpose: Validate and submit a membership request. Uses MembershipStore until APIs exist.

function later(fn) {
    return new Promise((resolve, reject) => {
        setTimeout(() => {
            try { resolve(fn()); } catch (err) { reject(err); }
        }, 220);
    });
}

const RegisterApi = {
    submit(payload) {
        return later(() => MembershipStore.submit(payload));
    }
};

const FIELDS = ['first_name', 'last_name', 'phone', 'role_title', 'password', 'password_confirm'];

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
    if (values.last_name.length < 2) errors.last_name = 'نام خانوادگی را وارد کنید.';
    const phone = MembershipStore.normalizePhone(values.phone);
    if (!MembershipStore.isMobilePhone(phone)) errors.phone = 'شماره موبایل را به‌صورت ۰۹۱۲۱۲۳۴۵۶۷ وارد کنید.';
    if (!values.role_title) errors.role_title = 'سمت را وارد کنید.';
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

function errorMessage(err) {
    const code = err && err.code;
    if (code === 'pending') return 'برای این شماره یک درخواست در انتظار بررسی است.';
    if (code === 'exists') return 'برای این شماره قبلاً حساب پذیرفته شده است.';
    if (code === 'phone') return 'شماره موبایل نامعتبر است.';
    if (code === 'first_name') return 'نام را وارد کنید.';
    if (code === 'last_name') return 'نام خانوادگی را وارد کنید.';
    if (code === 'role') return 'سمت را وارد کنید.';
    return 'ارسال درخواست ممکن نشد.';
}

onReady(() => {
    const form = document.getElementById('register-form');
    const submit = document.getElementById('register-submit');

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
            const row = await RegisterApi.submit(values);
            form.reset();
            showDone(MembershipStore.displayName(row));
        } catch (err) {
            if (err && (err.code === 'first_name' || err.code === 'last_name')) setError(err.code, errorMessage(err));
            else if (err && err.code === 'phone') setError('phone', errorMessage(err));
            else if (err && (err.code === 'pending' || err.code === 'exists')) setError('phone', errorMessage(err));
            else showNotice(errorMessage(err));
        } finally {
            submit.disabled = false;
        }
    });
});

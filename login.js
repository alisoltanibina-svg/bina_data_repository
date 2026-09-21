// File: login.js
// Purpose: Validate the login form. Server auth is wired in a later step.

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

function normalizePhone(raw) {
    let s = String(raw || '');
    s = s.replace(/[۰-۹]/g, d => '0123456789'['۰۱۲۳۴۵۶۷۸۹'.indexOf(d)]);
    s = s.replace(/[٠-٩]/g, d => '0123456789'['٠١٢٣٤٥٦٧٨٩'.indexOf(d)]);
    s = s.replace(/[\s-]/g, '');
    if (s.startsWith('+98')) s = '0' + s.slice(3);
    if (s.startsWith('0098')) s = '0' + s.slice(4);
    if (s.startsWith('98') && s.length === 12) s = '0' + s.slice(2);
    return s;
}

onReady(() => {
    const form = document.getElementById('login-form');
    form.addEventListener('submit', event => {
        event.preventDefault();
        setError('phone', '');
        setError('password', '');
        const phone = normalizePhone(document.getElementById('phone').value);
        const password = document.getElementById('password').value;
        let first = '';
        if (!/^09\d{9}$/.test(phone)) {
            setError('phone', 'شماره موبایل را به‌صورت ۰۹۱۲۱۲۳۴۵۶۷ وارد کنید.');
            first = 'phone';
        }
        if (password.length < 8) {
            setError('password', 'رمز عبور حداقل ۸ نویسه باشد.');
            if (!first) first = 'password';
        }
        if (first) {
            document.getElementById(first).focus();
            return;
        }
        showNotice('ورود هنوز به سرور وصل نشده است.');
    });
});

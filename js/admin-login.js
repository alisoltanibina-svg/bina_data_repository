// Same-origin administrator recovery entry, available during maintenance.
(() => {
    const form = document.getElementById('admin-login');
    const refresh = document.getElementById('captcha-refresh');
    const submit = document.getElementById('login-submit');
    const error = document.getElementById('login-error');
    const image = document.getElementById('captcha-image');
    let captchaId = '';
    const phone = () => form.elements.phone.value.trim().replace(/[۰-۹٠-٩]/g, digit => {
        const code = digit.charCodeAt(0);
        return String(code >= 1776 ? code - 1776 : code - 1632);
    });
    async function post(path, body) {
        const response = await fetch(path, {
            method: 'POST', credentials: 'include', cache: 'no-store',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Protection': '1' },
            body: JSON.stringify(body)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail?.message || data.detail || 'ورود ممکن نشد.');
        return data;
    }
    function clearCaptcha() {
        captchaId = '';
        submit.disabled = true;
        image.hidden = true;
        form.elements.captcha_answer.value = '';
    }
    form.elements.phone.addEventListener('input', clearCaptcha);
    refresh.addEventListener('click', async () => {
        clearCaptcha();
        error.textContent = '';
        refresh.disabled = true;
        try {
            const data = await post('/api/auth/captcha', { phone: phone(), purpose: 'login' });
            captchaId = data.captcha_id;
            image.src = '/api/auth/captcha/' + encodeURIComponent(captchaId) + '/image';
            image.hidden = false;
            submit.disabled = false;
        } catch (err) { error.textContent = err.message; }
        finally { refresh.disabled = false; }
    });
    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (!captchaId || submit.disabled) return;
        submit.disabled = true;
        refresh.disabled = true;
        error.textContent = '';
        try {
            const profile = await post('/api/auth/login', {
                phone: phone(), password: form.elements.password.value,
                captcha_id: captchaId, captcha_answer: form.elements.captcha_answer.value.trim()
            });
            if (!profile.is_admin) throw new Error('این بخش فقط برای مدیر است.');
            location.replace('/html/admin.html');
        } catch (err) {
            error.textContent = err.message;
            clearCaptcha();
        } finally { refresh.disabled = false; }
    });
})();

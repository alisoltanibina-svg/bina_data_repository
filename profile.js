// File: profile.js
// Purpose: Load the signed-in profile and preview a local avatar. No database write.

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];

let previewUrl = '';

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

function fillForm(profile) {
    document.getElementById('first_name').value = profile.first_name || '';
    document.getElementById('last_name').value = profile.last_name || '';
    document.getElementById('phone').value = profile.phone || '';
    document.getElementById('role_title').value = profile.role_title || '';
    document.getElementById('organization').value = profile.organization || '';
}

function clearPreview() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = '';
    const preview = document.getElementById('avatar-preview');
    preview.style.backgroundImage = '';
    preview.classList.remove('is-image');
    document.getElementById('avatar-file').value = '';
    document.getElementById('avatar-clear').hidden = true;
}

function showPreview(file) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(file);
    const preview = document.getElementById('avatar-preview');
    preview.style.backgroundImage = 'url("' + previewUrl + '")';
    preview.classList.add('is-image');
    document.getElementById('avatar-clear').hidden = false;
}

onReady(async () => {
    try {
        const response = await fetch(`${API_BASE_URL}/api/auth/me`, { credentials: 'include' });
        if (response.status === 401 || response.status === 403) {
            window.location.href = 'login.html';
            return;
        }
        if (!response.ok) {
            showNotice('بارگذاری حساب ممکن نشد.');
            return;
        }
        fillForm(await response.json());
    } catch (err) {
        showNotice('ارتباط با سرور برقرار نشد.');
        return;
    }

    const fileInput = document.getElementById('avatar-file');
    document.getElementById('avatar-pick').addEventListener('click', () => fileInput.click());
    document.getElementById('avatar-clear').addEventListener('click', clearPreview);

    fileInput.addEventListener('change', () => {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;
        if (ALLOWED.indexOf(file.type) === -1) {
            showNotice('فقط فایل JPG، PNG یا WebP پذیرفته می‌شود.');
            fileInput.value = '';
            return;
        }
        if (file.size > MAX_BYTES) {
            showNotice('حجم عکس باید حداکثر ۵ مگابایت باشد.');
            fileInput.value = '';
            return;
        }
        showPreview(file);
    });

    document.getElementById('profile-form').addEventListener('submit', event => {
        event.preventDefault();
        setError('first_name', '');
        setError('last_name', '');
        const first = document.getElementById('first_name').value.trim();
        const last = document.getElementById('last_name').value.trim();
        if (first.length < 2) {
            setError('first_name', 'نام را وارد کنید.');
            document.getElementById('first_name').focus();
            return;
        }
        if (last.length < 2) {
            setError('last_name', 'نام خانوادگی را وارد کنید.');
            document.getElementById('last_name').focus();
            return;
        }
        showNotice('ذخیره عکس و مشخصات در مرحله بعد به سرور وصل می‌شود.');
    });
});

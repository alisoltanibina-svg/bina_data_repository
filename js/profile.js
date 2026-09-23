// File: profile.js
// Purpose: Edit the signed-in profile, crop a circular avatar, and save to the API.

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];
const CROP_STAGE = 320;
const CROP_HOLE = 240;
const CROP_OUT = 512;

let previewUrl = '';
let savedAvatarUrl = '';
let pendingBlob = null;
let pendingClear = false;
let crop = null;

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

function showImage(url) {
    const preview = document.getElementById('avatar-preview');
    if (!url) {
        preview.style.backgroundImage = '';
        preview.classList.remove('is-image');
        document.getElementById('avatar-clear').hidden = true;
        return;
    }
    preview.style.backgroundImage = cssUrl(url);
    preview.classList.add('is-image');
    document.getElementById('avatar-clear').hidden = false;
}

function revokePreview() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = '';
}

function setPendingBlob(blob) {
    revokePreview();
    pendingBlob = blob;
    pendingClear = false;
    previewUrl = URL.createObjectURL(blob);
    showImage(previewUrl);
}

function clearPreview() {
    revokePreview();
    pendingBlob = null;
    pendingClear = !!savedAvatarUrl;
    document.getElementById('avatar-file').value = '';
    showImage('');
}

function stageSize() {
    const el = document.getElementById('avatar-crop-stage');
    return (el && el.clientWidth) || CROP_STAGE;
}

function holeRect() {
    const stage = stageSize();
    const size = stage * (CROP_HOLE / CROP_STAGE);
    const inset = (stage - size) / 2;
    return { left: inset, top: inset, size: size };
}

function clampCrop() {
    if (!crop) return;
    const hole = holeRect();
    const w = crop.naturalWidth * crop.scale;
    const h = crop.naturalHeight * crop.scale;
    const minX = hole.left + hole.size - w;
    const minY = hole.top + hole.size - h;
    crop.x = Math.min(hole.left, Math.max(minX, crop.x));
    crop.y = Math.min(hole.top, Math.max(minY, crop.y));
}

function paintCrop() {
    if (!crop) return;
    const img = document.getElementById('avatar-crop-image');
    const mini = document.getElementById('avatar-crop-mini');
    img.style.width = (crop.naturalWidth * crop.scale) + 'px';
    img.style.height = (crop.naturalHeight * crop.scale) + 'px';
    img.style.transform = 'translate(' + crop.x + 'px,' + crop.y + 'px)';
    const hole = holeRect();
    const k = 44 / hole.size;
    mini.style.width = (crop.naturalWidth * crop.scale * k) + 'px';
    mini.style.height = (crop.naturalHeight * crop.scale * k) + 'px';
    mini.style.transform = 'translate(' + ((crop.x - hole.left) * k) + 'px,' + ((crop.y - hole.top) * k) + 'px)';
}

function closeCrop() {
    const root = document.getElementById('avatar-crop-root');
    root.hidden = true;
    if (crop && crop.objectUrl) URL.revokeObjectURL(crop.objectUrl);
    crop = null;
    document.getElementById('avatar-file').value = '';
}

function openCrop(file) {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
        document.getElementById('avatar-crop-root').hidden = false;
        const img = document.getElementById('avatar-crop-image');
        const mini = document.getElementById('avatar-crop-mini');
        img.src = objectUrl;
        mini.src = objectUrl;
        requestAnimationFrame(() => {
            const stage = stageSize();
            const hole = stage * (CROP_HOLE / CROP_STAGE);
            const minScale = hole / Math.min(image.naturalWidth, image.naturalHeight);
            crop = {
                naturalWidth: image.naturalWidth,
                naturalHeight: image.naturalHeight,
                scale: minScale,
                minScale: minScale,
                x: (stage - image.naturalWidth * minScale) / 2,
                y: (stage - image.naturalHeight * minScale) / 2,
                objectUrl: objectUrl,
                dragging: false,
                lastX: 0,
                lastY: 0
            };
            const zoom = document.getElementById('avatar-crop-zoom');
            zoom.min = '1';
            zoom.max = '4';
            zoom.value = '1';
            clampCrop();
            paintCrop();
            document.getElementById('avatar-crop-ok').focus();
        });
    };
    image.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        showNotice('خواندن عکس ممکن نشد.');
    };
    image.src = objectUrl;
}

function currentScale() {
    if (!crop) return 1;
    const zoom = Number(document.getElementById('avatar-crop-zoom').value) || 1;
    return crop.minScale * zoom;
}

function setScale(next) {
    if (!crop) return;
    const hole = holeRect();
    const cx = hole.left + hole.size / 2;
    const cy = hole.top + hole.size / 2;
    const imgX = (cx - crop.x) / crop.scale;
    const imgY = (cy - crop.y) / crop.scale;
    crop.scale = Math.max(crop.minScale, next);
    crop.x = cx - imgX * crop.scale;
    crop.y = cy - imgY * crop.scale;
    clampCrop();
    paintCrop();
}

function exportCrop(done) {
    if (!crop) return;
    const hole = holeRect();
    const sx = (hole.left - crop.x) / crop.scale;
    const sy = (hole.top - crop.y) / crop.scale;
    const sw = hole.size / crop.scale;
    const canvas = document.createElement('canvas');
    canvas.width = CROP_OUT;
    canvas.height = CROP_OUT;
    const ctx = canvas.getContext('2d');
    const img = document.getElementById('avatar-crop-image');
    ctx.drawImage(img, sx, sy, sw, sw, 0, 0, CROP_OUT, CROP_OUT);
    canvas.toBlob(blob => {
        if (!blob) {
            canvas.toBlob(done, 'image/jpeg', 0.9);
            return;
        }
        done(blob);
    }, 'image/webp', 0.9);
}

async function apiJson(path, options) {
    const response = await fetch(`${API_BASE_URL}${path}`, Object.assign({ credentials: 'include' }, options || {}));
    if (response.status === 401 || response.status === 403) {
        window.location.href = SITE.page('login.html');
        throw new Error('auth');
    }
    let data = null;
    try { data = await response.json(); } catch (e) { data = null; }
    if (!response.ok) {
        const detail = data && data.detail;
        const message = (detail && detail.message) || (typeof detail === 'string' ? detail : 'انجام این اقدام ممکن نشد.');
        const err = new Error(message);
        err.code = detail && detail.code;
        throw err;
    }
    return data;
}

function applySavedProfile(profile) {
    fillForm(profile);
    savedAvatarUrl = profile.avatar_url || '';
    pendingBlob = null;
    pendingClear = false;
    revokePreview();
    showImage(avatarSrc(savedAvatarUrl));
    applyBannerAvatar(savedAvatarUrl);
    const nameEl = document.querySelector('.user-name');
    const roleEl = document.querySelector('.user-role');
    if (nameEl) nameEl.textContent = [profile.first_name, profile.last_name].filter(Boolean).join(' ');
    if (roleEl) {
        const role = (profile.role_title || (profile.is_admin ? 'مدیر' : '')).trim();
        const org = (profile.organization || '').trim();
        roleEl.textContent = role && org ? role + ' ' + org : (role || org);
    }
}

function bindCrop() {
    const stage = document.getElementById('avatar-crop-stage');
    const zoom = document.getElementById('avatar-crop-zoom');
    stage.addEventListener('pointerdown', event => {
        if (!crop) return;
        crop.dragging = true;
        crop.lastX = event.clientX;
        crop.lastY = event.clientY;
        stage.setPointerCapture(event.pointerId);
    });
    stage.addEventListener('pointermove', event => {
        if (!crop || !crop.dragging) return;
        crop.x += event.clientX - crop.lastX;
        crop.y += event.clientY - crop.lastY;
        crop.lastX = event.clientX;
        crop.lastY = event.clientY;
        clampCrop();
        paintCrop();
    });
    const stopDrag = () => { if (crop) crop.dragging = false; };
    stage.addEventListener('pointerup', stopDrag);
    stage.addEventListener('pointercancel', stopDrag);
    stage.addEventListener('wheel', event => {
        if (!crop) return;
        event.preventDefault();
        const next = currentScale() * (event.deltaY < 0 ? 1.08 : 0.92);
        const zoomValue = next / crop.minScale;
        zoom.value = String(Math.min(4, Math.max(1, zoomValue)));
        setScale(crop.minScale * Number(zoom.value));
    }, { passive: false });
    zoom.addEventListener('input', () => setScale(currentScale()));
    document.getElementById('avatar-crop-cancel').addEventListener('click', closeCrop);
    document.getElementById('avatar-crop-root').addEventListener('click', event => {
        if (event.target.hasAttribute('data-crop-dismiss')) closeCrop();
    });
    document.getElementById('avatar-crop-ok').addEventListener('click', () => {
        exportCrop(blob => {
            if (!blob) {
                showNotice('برش عکس ممکن نشد.');
                return;
            }
            setPendingBlob(blob);
            closeCrop();
        });
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !document.getElementById('avatar-crop-root').hidden) closeCrop();
    });
}

onReady(async () => {
    try {
        const profile = await apiJson('/api/auth/me');
        applySavedProfile(profile);
        const adminLink = document.getElementById('profile-admin-link');
        if (adminLink) {
            adminLink.href = SITE.page('admin.html');
            adminLink.hidden = profile.is_admin !== true;
        }
    } catch (err) {
        if (err.message !== 'auth') showNotice('بارگذاری حساب ممکن نشد.');
        return;
    }

    const fileInput = document.getElementById('avatar-file');
    document.getElementById('avatar-pick').addEventListener('click', () => fileInput.click());
    document.getElementById('avatar-clear').addEventListener('click', clearPreview);
    bindCrop();

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
        openCrop(file);
    });

    document.getElementById('profile-form').addEventListener('submit', async event => {
        event.preventDefault();
        setError('first_name', '');
        setError('last_name', '');
        const first = document.getElementById('first_name').value.trim();
        const last = document.getElementById('last_name').value.trim();
        const role = document.getElementById('role_title').value.trim();
        const org = document.getElementById('organization').value.trim();
        if (first.length < 2) {
            setError('first_name', 'نام را وارد کنید.');
            document.getElementById('first_name').focus();
            return;
        }
        if (plainTextError(first)) {
            setError('first_name', plainTextError(first));
            document.getElementById('first_name').focus();
            return;
        }
        if (last.length < 2) {
            setError('last_name', 'نام خانوادگی را وارد کنید.');
            document.getElementById('last_name').focus();
            return;
        }
        if (plainTextError(last)) {
            setError('last_name', plainTextError(last));
            document.getElementById('last_name').focus();
            return;
        }
        if (plainTextError(role)) {
            showNotice(plainTextError(role));
            return;
        }
        if (plainTextError(org)) {
            showNotice(plainTextError(org));
            return;
        }

        const submit = document.getElementById('profile-submit');
        submit.disabled = true;
        try {
            let profile = await apiJson('/api/auth/profile', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    first_name: first,
                    last_name: last,
                    role_title: role,
                    organization: org
                })
            });
            if (pendingClear) {
                profile = await apiJson('/api/auth/profile/avatar', { method: 'DELETE' });
            } else if (pendingBlob) {
                const body = new FormData();
                body.append('file', pendingBlob, 'avatar.webp');
                profile = await apiJson('/api/auth/profile/avatar', { method: 'POST', body: body });
            }
            applySavedProfile(profile);
            showNotice('تغییرات ذخیره شد.', 'ok');
        } catch (err) {
            if (err.code === 'first_name' || err.code === 'last_name') setError(err.code, err.message);
            else showNotice(err.message || 'ذخیره ممکن نشد.');
        } finally {
            submit.disabled = false;
        }
    });
});

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

function markFilled(el) {
    if (!el) return;
    el.classList.toggle('is-filled', !!String(el.value || '').trim());
}

function fillForm(profile) {
    document.getElementById('first_name').value = profile.first_name || '';
    document.getElementById('last_name').value = profile.last_name || '';
    document.getElementById('phone').value = profile.phone || '';
    if (typeof window.setJalaliFromGregorian === 'function') window.setJalaliFromGregorian(profile.birth_date || '');
    else document.getElementById('birth_date').value = profile.birth_date || '';
    document.getElementById('email').value = profile.email || '';
    document.getElementById('address').value = profile.address || '';
    document.getElementById('role_title').value = profile.role_title || '';
    document.getElementById('organization').value = profile.organization || '';
    document.querySelectorAll('#profile-form input').forEach(markFilled);
}

function showImage(url) {
    const preview = document.getElementById('avatar-preview');
    if (!url) {
        preview.style.backgroundImage = '';
        preview.classList.remove('is-image');
        return;
    }
    preview.style.backgroundImage = cssUrl(url);
    preview.classList.add('is-image');
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
        window.location.href = SITE.page('index.html') + '#auth';
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

const JALALI_MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];

function gregorianToJalali(gy, gm, gd) {
    const g_d_m = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    const gy2 = gm > 2 ? gy + 1 : gy;
    let days = 355666 + (365 * gy) + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100) + Math.floor((gy2 + 399) / 400) + gd + g_d_m[gm - 1];
    let jy = -1595 + 33 * Math.floor(days / 12053);
    days %= 12053;
    jy += 4 * Math.floor(days / 1461);
    days %= 1461;
    if (days > 365) {
        jy += Math.floor((days - 1) / 365);
        days = (days - 1) % 365;
    }
    const jm = days < 186 ? 1 + Math.floor(days / 31) : 7 + Math.floor((days - 186) / 30);
    const jd = 1 + (days < 186 ? days % 31 : (days - 186) % 30);
    return { jy: jy, jm: jm, jd: jd };
}

function jalaliToGregorian(jy, jm, jd) {
    jy += 1595;
    let days = -355668 + (365 * jy) + Math.floor(jy / 33) * 8 + Math.floor(((jy % 33) + 3) / 4) + jd + (jm < 7 ? (jm - 1) * 31 : ((jm - 7) * 30) + 186);
    let gy = 400 * Math.floor(days / 146097);
    days %= 146097;
    if (days > 36524) {
        gy += 100 * Math.floor(--days / 36524);
        days %= 36524;
        if (days >= 365) days += 1;
    }
    gy += 4 * Math.floor(days / 1461);
    days %= 1461;
    if (days > 365) {
        gy += Math.floor((days - 1) / 365);
        days = (days - 1) % 365;
    }
    let gd = days + 1;
    const leap = (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0;
    const sal = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let gm = 1;
    while (gm < 13 && gd > sal[gm]) {
        gd -= sal[gm];
        gm += 1;
    }
    return { gy: gy, gm: gm, gd: gd };
}

function jalaliLeap(jy) {
    return ((((((jy - 474) % 2820) + 2820) % 2820) + 474 + 38) * 682) % 2816 < 682;
}

function jalaliMonthLength(jy, jm) {
    if (jm <= 6) return 31;
    if (jm <= 11) return 30;
    return jalaliLeap(jy) ? 30 : 29;
}

function pad2(n) {
    return (n < 10 ? '0' : '') + n;
}

function bindJalaliPicker() {
    const hidden = document.getElementById('birth_date');
    const trigger = document.getElementById('birth-trigger');
    const cal = document.getElementById('jalali-cal');
    const yearSel = document.getElementById('jalali-year');
    const monthSel = document.getElementById('jalali-month');
    const grid = document.getElementById('jalali-grid');
    const field = document.getElementById('birth-field');
    if (!hidden || !trigger || !cal || !yearSel || !monthSel || !grid || !field) return;

    for (let y = 1410; y >= 1300; y -= 1) {
        const opt = document.createElement('option');
        opt.value = String(y);
        opt.textContent = String(y);
        yearSel.appendChild(opt);
    }
    JALALI_MONTHS.forEach((name, i) => {
        const opt = document.createElement('option');
        opt.value = String(i + 1);
        opt.textContent = name;
        monthSel.appendChild(opt);
    });
    yearSel.value = '1360';
    monthSel.value = '1';

    function selectedJalali() {
        if (!hidden.value) return null;
        const p = hidden.value.split('-');
        if (p.length !== 3) return null;
        return gregorianToJalali(Number(p[0]), Number(p[1]), Number(p[2]));
    }

    function renderGrid() {
        const jy = Number(yearSel.value);
        const jm = Number(monthSel.value);
        const len = jalaliMonthLength(jy, jm);
        const g = jalaliToGregorian(jy, jm, 1);
        const offset = (new Date(g.gy, g.gm - 1, g.gd).getDay() + 1) % 7;
        const picked = selectedJalali();
        grid.replaceChildren();
        for (let i = 0; i < offset; i += 1) {
            const empty = document.createElement('span');
            grid.appendChild(empty);
        }
        for (let d = 1; d <= len; d += 1) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = String(d);
            if (picked && picked.jy === jy && picked.jm === jm && picked.jd === d) btn.classList.add('is-selected');
            btn.addEventListener('click', () => {
                const greg = jalaliToGregorian(jy, jm, d);
                hidden.value = greg.gy + '-' + pad2(greg.gm) + '-' + pad2(greg.gd);
                trigger.textContent = jy + '/' + pad2(jm) + '/' + pad2(d);
                field.classList.add('is-filled');
                markFilled(hidden);
                cal.hidden = true;
                field.classList.remove('is-expanded');
            });
            grid.appendChild(btn);
        }
    }

    function openCal() {
        const cur = selectedJalali();
        yearSel.value = String(cur ? cur.jy : 1360);
        monthSel.value = String(cur ? cur.jm : 1);
        renderGrid();
        cal.hidden = false;
        field.classList.add('is-expanded');
    }

    trigger.addEventListener('click', event => {
        event.preventDefault();
        if (cal.hidden) openCal();
        else {
            cal.hidden = true;
            field.classList.remove('is-expanded');
        }
    });
    yearSel.addEventListener('change', renderGrid);
    monthSel.addEventListener('change', renderGrid);
    document.addEventListener('click', event => {
        if (!field.contains(event.target)) {
            cal.hidden = true;
            field.classList.remove('is-expanded');
        }
    });

    window.setJalaliFromGregorian = function (iso) {
        if (!iso) {
            hidden.value = '';
            trigger.textContent = '';
            field.classList.remove('is-filled');
            yearSel.value = '1360';
            monthSel.value = '1';
            return;
        }
        const p = String(iso).slice(0, 10).split('-');
        const j = gregorianToJalali(Number(p[0]), Number(p[1]), Number(p[2]));
        hidden.value = p[0] + '-' + p[1] + '-' + p[2];
        trigger.textContent = j.jy + '/' + pad2(j.jm) + '/' + pad2(j.jd);
        field.classList.add('is-filled');
        yearSel.value = String(j.jy);
        monthSel.value = String(j.jm);
    };
}

onReady(async () => {
    if (!document.getElementById('profile-form')) return;
    bindJalaliPicker();

    window.loadCurtainProfile = async function () {
        try {
            const profile = await apiJson('/api/auth/me');
            applySavedProfile(profile);
            const adminLink = document.getElementById('profile-admin-link');
            if (adminLink) {
                adminLink.href = SITE.page('admin.html');
                adminLink.hidden = profile.is_admin !== true;
            }
        } catch (err) {
            if (err.message === 'auth') {
                if (typeof window.openCurtainAuth === 'function') window.openCurtainAuth();
                else window.location.href = SITE.page('index.html') + '#auth';
                return;
            }
            showNotice('بارگذاری حساب ممکن نشد.');
        }
    };

    if (!document.getElementById('entry-auth-shell')) {
        await window.loadCurtainProfile();
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
        setError('birth_date', '');
        setError('email', '');
        setError('address', '');
        const first = document.getElementById('first_name').value.trim();
        const last = document.getElementById('last_name').value.trim();
        const role = document.getElementById('role_title').value.trim();
        const org = document.getElementById('organization').value.trim();
        const birth = document.getElementById('birth_date').value.trim();
        const email = document.getElementById('email').value.trim();
        const address = document.getElementById('address').value.trim();
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
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            setError('email', 'ایمیل نامعتبر است.');
            document.getElementById('email').focus();
            return;
        }
        if (plainTextError(address)) {
            setError('address', plainTextError(address));
            document.getElementById('address').focus();
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
                    organization: org,
                    birth_date: birth,
                    email: email,
                    address: address
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
            if (err.code === 'first_name' || err.code === 'last_name' || err.code === 'email' || err.code === 'birth_date' || err.code === 'address') {
                setError(err.code, err.message);
            } else showNotice(err.message || 'ذخیره ممکن نشد.');
        } finally {
            submit.disabled = false;
        }
    });

    document.querySelectorAll('#profile-form input').forEach(el => {
        el.addEventListener('input', () => markFilled(el));
        el.addEventListener('blur', () => markFilled(el));
    });

    const profilePhone = () => document.getElementById('phone').value.trim();
    let resendTimer = 0;
    let resendLeft = 0;

    function showProfilePanel(id) {
        ['profile-main', 'profile-otp', 'profile-reset'].forEach(name => {
            const el = document.getElementById(name);
            if (el) el.hidden = name !== id;
        });
    }

    function stopResendTimer() {
        window.clearInterval(resendTimer);
        resendTimer = 0;
        const btn = document.getElementById('profile-otp-resend');
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'ارسال دوباره';
        }
    }

    function startResendTimer(seconds) {
        const btn = document.getElementById('profile-otp-resend');
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
        const box = document.getElementById('profile-otp-sending');
        const form = document.getElementById('profile-otp-form');
        const hint = document.getElementById('profile-otp-resend-wrap');
        if (box) box.hidden = !on;
        if (form) form.hidden = on;
        if (hint) hint.hidden = on;
    }

    async function startPasswordOtp() {
        const phone = profilePhone();
        document.getElementById('profile-otp-phone').textContent = phone;
        document.getElementById('profile-otp-code').value = '';
        setError('profile-otp-code', '');
        showProfilePanel('profile-otp');
        setOtpSending(true);
        try {
            const data = await apiJson('/api/auth/otp/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone: phone, purpose: 'reset' })
            });
            setOtpSending(false);
            startResendTimer((data && data.resend_seconds) || 60);
            document.getElementById('profile-otp-code').focus();
        } catch (err) {
            setOtpSending(false);
            showNotice(err.message || 'ارسال کد ممکن نشد.');
            showProfilePanel('profile-main');
        }
    }

    document.getElementById('profile-password-btn').addEventListener('click', startPasswordOtp);
    document.getElementById('profile-otp-back').addEventListener('click', () => {
        stopResendTimer();
        setOtpSending(false);
        showProfilePanel('profile-main');
    });
    document.getElementById('profile-reset-back').addEventListener('click', () => {
        showProfilePanel('profile-otp');
    });

    document.getElementById('profile-otp-form').addEventListener('submit', async event => {
        event.preventDefault();
        setError('profile-otp-code', '');
        const code = (document.getElementById('profile-otp-code').value || '').replace(/\D/g, '');
        if (code.length !== 6) {
            setError('profile-otp-code', 'کد باید ۶ رقم باشد.');
            return;
        }
        const submit = document.getElementById('profile-otp-submit');
        submit.disabled = true;
        try {
            await apiJson('/api/auth/otp/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone: profilePhone(), purpose: 'reset', code: code })
            });
            showProfilePanel('profile-reset');
            document.getElementById('profile-reset-password').focus();
        } catch (err) {
            setError('profile-otp-code', err.message || 'کد نامعتبر است.');
        } finally {
            submit.disabled = false;
        }
    });

    document.getElementById('profile-otp-resend').addEventListener('click', async () => {
        const btn = document.getElementById('profile-otp-resend');
        if (btn.disabled) return;
        setOtpSending(true);
        try {
            const data = await apiJson('/api/auth/otp/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone: profilePhone(), purpose: 'reset' })
            });
            setOtpSending(false);
            startResendTimer((data && data.resend_seconds) || 60);
        } catch (err) {
            setOtpSending(false);
            setError('profile-otp-code', err.message || 'ارسال دوباره ممکن نشد.');
        }
    });

    document.getElementById('profile-reset-form').addEventListener('submit', async event => {
        event.preventDefault();
        setError('profile-reset-password', '');
        setError('profile-reset-password-confirm', '');
        const password = document.getElementById('profile-reset-password').value;
        const confirm = document.getElementById('profile-reset-password-confirm').value;
        if (password.length < 8) {
            setError('profile-reset-password', 'رمز عبور حداقل ۸ نویسه باشد.');
            return;
        }
        if (confirm !== password) {
            setError('profile-reset-password-confirm', 'تکرار رمز با رمز عبور یکی نیست.');
            return;
        }
        const submit = document.getElementById('profile-reset-submit');
        submit.disabled = true;
        try {
            await apiJson('/api/auth/password/reset', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone: profilePhone(), password: password })
            });
            showNotice('رمز عبور تغییر کرد.', 'ok');
            showProfilePanel('profile-main');
        } catch (err) {
            showNotice(err.message || 'تغییر رمز ممکن نشد.');
        } finally {
            submit.disabled = false;
        }
    });
});

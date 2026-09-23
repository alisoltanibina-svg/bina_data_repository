// File: shared.js
// Purpose: Helpers used by atlas, explorer, bubble, and province-profile pages.

function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, ch => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
}

function cssUrl(path) {
    return 'url(' + JSON.stringify(String(path || '')) + ')';
}

function hexToRgb(hex, fallback) {
    const fb = fallback || { r: 0, g: 120, b: 215 };
    if (!hex) return { r: fb.r, g: fb.g, b: fb.b };
    let h = String(hex).trim().replace('#', '');
    if (h.length === 3 && /^[a-f\d]{3}$/i.test(h)) {
        h = h.split('').map(ch => ch + ch).join('');
    }
    if (!/^[a-f\d]{6}$/i.test(h)) return { r: fb.r, g: fb.g, b: fb.b };
    return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16)
    };
}

function toFa(num) {
    if (num === null || num === undefined) return '';
    return String(num).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]);
}

function toFaFixed(num, digits = 2) {
    if (num === null || num === undefined || num === '' || !isFinite(Number(num))) return '';
    return toFa(Number(num).toFixed(digits));
}

function debounce(fn, wait) {
    let t;
    return function (...args) {
        clearTimeout(t);
        t = setTimeout(() => fn.apply(this, args), wait);
    };
}

function initLazyBackgrounds(root) {
    const lazyEls = Array.from((root || document).querySelectorAll('[data-bg]'));
    if (lazyEls.length === 0) return;

    function applyBg(el) {
        const url = el.dataset.bg;
        if (url) {
            el.style.backgroundImage = cssUrl(url);
            el.removeAttribute('data-bg');
            el.classList.remove('bg-placeholder');
        }
    }

    if ('IntersectionObserver' in window) {
        const io = new IntersectionObserver((entries, obs) => {
            entries.forEach((entry) => {
                if (!entry.isIntersecting) return;
                applyBg(entry.target);
                obs.unobserve(entry.target);
            });
        }, { rootMargin: '200px 0px' });
        lazyEls.forEach((el) => io.observe(el));
        return;
    }
    lazyEls.forEach(applyBg);
}

function showNotice(message, kind) {
    kind = kind || 'error';
    let el = document.getElementById('app-notice');
    if (!el) {
        el = document.createElement('div');
        el.id = 'app-notice';
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', 'polite');
        document.body.appendChild(el);
    }
    el.textContent = message;
    el.dataset.kind = kind;
    el.hidden = false;
    clearTimeout(showNotice._timer);
    showNotice._timer = setTimeout(() => {
        el.hidden = true;
    }, 4200);
}

function applyChartDefaults() {
    if (typeof Chart === 'undefined') return false;
    if (typeof ChartDataLabels !== 'undefined') {
        try {
            Chart.register(ChartDataLabels);
        } catch (e) {}
    }
    Chart.defaults.font.family = "'PeydaFaNumWeb', Tahoma, sans-serif";
    Chart.defaults.color = '#333333';
    Chart.defaults.devicePixelRatio = window.devicePixelRatio || 1;
    if (Chart.defaults.animation === false) Chart.defaults.animation = {};
    if (Chart.defaults.animation) Chart.defaults.animation.duration = 1000;
    return true;
}

function setTopicChrome(accentHex) {
    const hex = accentHex || '#0078d7';
    document.documentElement.style.setProperty('--topic-accent', hex);
}

function onReady(fn) {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', fn);
    } else {
        fn();
    }
}

function toEnDigits(raw) {
    return String(raw || '')
        .replace(/[۰-۹]/g, d => '0123456789'['۰۱۲۳۴۵۶۷۸۹'.indexOf(d)])
        .replace(/[٠-٩]/g, d => '0123456789'['٠١٢٣٤٥٦٧٨٩'.indexOf(d)]);
}

function digitsOnlyPhone(raw) {
    return toEnDigits(raw).replace(/\D/g, '').slice(0, 11);
}

function bindPhoneInput(input) {
    if (!input || input.readOnly || input.disabled) return;
    input.setAttribute('maxlength', '11');
    input.setAttribute('inputmode', 'numeric');
    input.setAttribute('autocomplete', input.getAttribute('autocomplete') || 'tel');
    const apply = () => {
        const next = digitsOnlyPhone(input.value);
        if (input.value !== next) input.value = next;
    };
    input.addEventListener('input', apply);
    input.addEventListener('blur', apply);
    input.addEventListener('paste', event => {
        event.preventDefault();
        input.value = digitsOnlyPhone((event.clipboardData || window.clipboardData).getData('text'));
    });
    apply();
}

function looksLikeCodeOrUrl(value) {
    const t = String(value || '');
    if (/[<>]/.test(t)) return true;
    if (/https?:\/\/|www\.|javascript:|data:|<\/?[a-z]/i.test(t)) return true;
    return false;
}

function plainTextError(value) {
    if (looksLikeCodeOrUrl(value)) return 'این فیلد نباید شامل پیوند یا کد باشد.';
    return '';
}

function avatarSrc(url) {
    if (!url) return '';
    if (/^https?:\/\//i.test(url)) return url;
    return (typeof API_BASE_URL === 'string' ? API_BASE_URL : '') + url;
}

const BANNER_PROFILE_KEY = 'binaBannerProfile';

function readBannerProfile() {
    try {
        const raw = sessionStorage.getItem(BANNER_PROFILE_KEY);
        if (!raw) return null;
        const data = JSON.parse(raw);
        if (!data || typeof data !== 'object') return null;
        if (!data.first_name && !data.last_name && !data.avatar_url) return null;
        return data;
    } catch (err) {
        return null;
    }
}

function writeBannerProfile(profile) {
    try {
        if (!profile) {
            sessionStorage.removeItem(BANNER_PROFILE_KEY);
            return;
        }
        sessionStorage.setItem(BANNER_PROFILE_KEY, JSON.stringify({
            id: profile.id,
            first_name: profile.first_name || '',
            last_name: profile.last_name || '',
            role_title: profile.role_title || '',
            organization: profile.organization || '',
            is_admin: profile.is_admin === true,
            avatar_url: profile.avatar_url || ''
        }));
    } catch (err) {}
}

function applyBannerAvatar(url) {
    const img = document.getElementById('user-avatar-img');
    const btn = document.getElementById('user-menu-btn');
    if (!img || !btn) return;
    const src = avatarSrc(url);
    if (src) {
        img.src = src;
        img.hidden = false;
        btn.classList.add('has-photo');
    } else {
        img.removeAttribute('src');
        img.hidden = true;
        btn.classList.remove('has-photo');
    }
}

function authApiRoot() {
    if (typeof API_BASE_URL === 'string' && API_BASE_URL) return String(API_BASE_URL).replace(/\/+$/, '');
    try {
        if (window.location && window.location.origin) {
            if (window.location.protocol === 'http:' && /rasadbina\.ir$/i.test(window.location.hostname || '')) {
                return window.location.origin.replace(/^http:/i, 'https:');
            }
            return window.location.origin;
        }
    } catch (e) {}
    return '';
}

function authRequestUrls(path) {
    const root = authApiRoot();
    const clean = ('/' + String(path || '').replace(/^\/+/, '')).replace(/\/+$/, '');
    const urls = [root + clean, root + clean + '/'];
    if (/^http:\/\//i.test(root)) {
        const httpsRoot = root.replace(/^http:/i, 'https:');
        urls.push(httpsRoot + clean, httpsRoot + clean + '/');
    }
    return urls.filter((url, i, all) => all.indexOf(url) === i);
}

function encodeAuthJsonHeader(body) {
    const json = JSON.stringify(body == null ? {} : body);
    return btoa(unescape(encodeURIComponent(json)));
}

function authFailDetail(data, fallback) {
    if (!data || data.detail == null) return fallback;
    if (Array.isArray(data.detail) && data.detail.length && data.detail[0] && data.detail[0].msg) {
        return data.detail[0].msg;
    }
    if (typeof data.detail === 'string') return data.detail;
    if (data.detail.message) return data.detail.message;
    return fallback;
}

function authErrorFromResponse(data, status) {
    const err = new Error(authFailDetail(data, '') || ('انجام این اقدام ممکن نشد. (HTTP ' + status + ')'));
    err.code = data && data.detail && data.detail.code;
    err.httpStatus = status;
    return err;
}

async function authReadJson(response) {
    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = null; }
    return data;
}

async function authRequest(path, body) {
    const payload = JSON.stringify(body == null ? {} : body);
    const urls = authRequestUrls(path);
    let lastErr = null;
    for (let i = 0; i < urls.length; i += 1) {
        const url = urls[i];
        let response;
        try {
            response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                credentials: 'include',
                body: payload
            });
        } catch (networkErr) {
            lastErr = new Error('ارتباط با سرور برقرار نشد.');
            continue;
        }
        const data = await authReadJson(response);
        if (response.ok) return data;
        lastErr = authErrorFromResponse(data, response.status);
        const code = lastErr.code;
        if (response.status === 401) throw lastErr;
        if (code !== 'method' && response.status !== 404 && response.status !== 405) throw lastErr;
    }
    const header = encodeAuthJsonHeader(body);
    for (let i = 0; i < urls.length; i += 1) {
        const url = urls[i];
        let response;
        try {
            response = await fetch(url, {
                method: 'GET',
                credentials: 'include',
                headers: { Accept: 'application/json', 'X-Auth-JSON': header }
            });
        } catch (networkErr) {
            lastErr = new Error('ارتباط با سرور برقرار نشد.');
            continue;
        }
        const data = await authReadJson(response);
        if (response.ok) return data;
        lastErr = authErrorFromResponse(data, response.status);
        if (response.status === 401) throw lastErr;
        if (lastErr.code !== 'method' && response.status !== 404 && response.status !== 405) throw lastErr;
    }
    if (String(path).indexOf('/api/auth/gate') >= 0 && body && body.phone) {
        const url = authApiRoot() + '/api/auth/gate?phone=' + encodeURIComponent(body.phone);
        const response = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
        const data = await authReadJson(response);
        if (response.ok) return data;
        throw authErrorFromResponse(data, response.status);
    }
    throw lastErr || new Error('ارتباط با سرور برقرار نشد.');
}

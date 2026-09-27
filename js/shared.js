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
    return toEnDigits(raw).replace(/[^0-9]/g, '').slice(0, 11);
}

function normalizeOtpCode(raw) {
    return toEnDigits(String(raw || ''))
        .replace(/[\u200c\u200d\u200e\u200f\u202a-\u202e\ufeff]/g, '')
        .replace(/[^0-9]/g, '')
        .slice(0, 6);
}

const otpFillState = { raf: 0 };

function stopOtpVisualTimer(submitBtn, resendBtn) {
    if (otpFillState.raf) window.cancelAnimationFrame(otpFillState.raf);
    otpFillState.raf = 0;
    if (submitBtn) submitBtn.style.setProperty('--otp-fill', '100%');
    if (resendBtn) {
        resendBtn.disabled = false;
        resendBtn.textContent = 'ارسال دوباره';
    }
}

function startOtpVisualTimer(submitBtn, resendBtn, seconds) {
    stopOtpVisualTimer(submitBtn, resendBtn);
    const total = Math.max(1, Number(seconds) || 60) * 1000;
    if (resendBtn) {
        resendBtn.disabled = true;
        resendBtn.textContent = 'ارسال دوباره';
    }
    if (!submitBtn) return;
    submitBtn.style.setProperty('--otp-fill', '0%');
    const t0 = performance.now();
    const tick = (now) => {
        const p = Math.min(1, (now - t0) / total);
        submitBtn.style.setProperty('--otp-fill', (p * 100).toFixed(3) + '%');
        if (p < 1) otpFillState.raf = window.requestAnimationFrame(tick);
        else {
            otpFillState.raf = 0;
            if (resendBtn) resendBtn.disabled = false;
        }
    };
    otpFillState.raf = window.requestAnimationFrame(tick);
}

function bindOtpInput(input) {
    if (!input) return;
    input.setAttribute('inputmode', 'numeric');
    input.setAttribute('autocomplete', 'one-time-code');
    input.setAttribute('maxlength', '6');
    input.setAttribute('lang', 'en');
    input.setAttribute('dir', 'ltr');
    const apply = () => {
        const next = normalizeOtpCode(input.value);
        if (input.value !== next) input.value = next;
    };
    input.addEventListener('input', apply);
    input.addEventListener('blur', apply);
    input.addEventListener('paste', event => {
        event.preventDefault();
        input.value = normalizeOtpCode((event.clipboardData || window.clipboardData).getData('text'));
    });
    apply();
}

function quietMobileField(input) {
    if (!input) return;
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('spellcheck', 'false');
    if (input.getAttribute('autocomplete') === 'one-time-code') return;
    if (window.matchMedia('(max-width: 767px)').matches) {
        if (!input.getAttribute('autocomplete') || input.getAttribute('autocomplete') === 'tel') {
            input.setAttribute('autocomplete', 'off');
        }
        if (!input.readOnly) {
            input.setAttribute('readonly', 'readonly');
            const unlock = () => input.removeAttribute('readonly');
            input.addEventListener('focus', unlock, { once: true });
            input.addEventListener('touchstart', unlock, { once: true });
        }
    }
}

function bindPhoneInput(input) {
    if (!input || input.readOnly || input.disabled) return;
    input.setAttribute('maxlength', '11');
    input.setAttribute('inputmode', 'numeric');
    if (!input.getAttribute('autocomplete')) input.setAttribute('autocomplete', 'off');
    quietMobileField(input);
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

const AUTH_NEXT_KEY = 'bina-auth-next';
const AUTH_NEXT_PAGES = { explorer: true, bubble: true };

function setAuthNext(spec) {
    try {
        if (!spec || !AUTH_NEXT_PAGES[spec.page]) {
            sessionStorage.removeItem(AUTH_NEXT_KEY);
            return;
        }
        const search = typeof spec.search === 'string' && spec.search.charAt(0) === '?'
            ? spec.search
            : '';
        sessionStorage.setItem(AUTH_NEXT_KEY, JSON.stringify({ page: spec.page, search: search }));
    } catch (err) {}
}

function takeAuthNext() {
    try {
        const raw = sessionStorage.getItem(AUTH_NEXT_KEY);
        sessionStorage.removeItem(AUTH_NEXT_KEY);
        if (!raw) return null;
        const data = JSON.parse(raw);
        if (!data || !AUTH_NEXT_PAGES[data.page]) return null;
        const search = typeof data.search === 'string' && data.search.charAt(0) === '?'
            ? data.search
            : '';
        return { page: data.page, search: search };
    } catch (err) {
        return null;
    }
}

function authLoginUrl() {
    return SITE.page('index.html') + '#auth';
}

function isCompactViewport() {
    return window.matchMedia('(max-width: 767px)').matches;
}

function placeMobilePageNav() {
    const slot = document.getElementById('atlas-page-nav') || document.getElementById('explorer-page-nav');
    const bannerRight = document.querySelector('#top-banner .banner-right');
    const nav = document.querySelector('#atlas-page-nav .banner-seg, #explorer-page-nav .banner-seg, #top-banner .banner-seg');
    if (!slot || !bannerRight || !nav) return;
    const compactApp = isCompactViewport() && (
        document.documentElement.classList.contains('atlas-view') ||
        document.body.classList.contains('explorer-body')
    );
    if (compactApp) {
        if (nav.parentElement !== slot) slot.appendChild(nav);
        slot.hidden = false;
    } else {
        if (nav.parentElement !== bannerRight) bannerRight.appendChild(nav);
        slot.hidden = true;
    }
}

function hrefForAuthNext(next) {
    if (!next) return '';
    if (next.page === 'explorer') return SITE.page('explorer.html') + (next.search || '');
    if (next.page === 'bubble') return SITE.page('bubble-chart.html') + (next.search || '');
    return '';
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

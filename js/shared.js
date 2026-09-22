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

function rgbaFromHex(hex, a, fallback) {
    const c = hexToRgb(hex, fallback);
    return `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`;
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
    document.documentElement.style.setProperty('--banner-fg', hex);
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

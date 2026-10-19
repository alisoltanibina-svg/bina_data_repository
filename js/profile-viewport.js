// Keep profile fields inside the area above a mobile software keyboard.
(() => {
    'use strict';
    const workspace = document.querySelector('body.profile-body .register-workspace');
    if (!workspace) return;
    const root = document.documentElement;
    const viewport = window.visualViewport;
    let frame = 0;
    let width = window.innerWidth;
    let fullHeight = window.innerHeight;

    function sync() {
        frame = 0;
        if (!window.matchMedia('(max-width: 767px), (pointer: coarse)').matches || (viewport && viewport.scale > 1.05)) {
            root.classList.remove('profile-keyboard-open');
            root.style.removeProperty('--profile-keyboard-inset');
            root.style.removeProperty('--vvh');
            return;
        }
        const height = viewport ? viewport.height : window.innerHeight;
        const offset = viewport ? viewport.offsetTop : 0;
        if (Math.abs(width - window.innerWidth) > 100) {
            width = window.innerWidth;
            fullHeight = window.innerHeight;
        }
        fullHeight = Math.max(fullHeight, window.innerHeight, height);
        const field = document.activeElement;
        const editing = field && workspace.contains(field) && !field.disabled && !field.readOnly
            && field.matches('input:not([type="hidden"]):not([type="file"]):not([type="range"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]), textarea, select')
            && field.getClientRects().length > 0;
        const keyboard = !!editing && fullHeight - height > 120;
        root.style.setProperty('--vvh', Math.round(height) + 'px');
        root.style.setProperty('--profile-keyboard-inset', keyboard ? Math.max(0, window.innerHeight - height - offset) + 'px' : '0px');
        root.classList.toggle('profile-keyboard-open', keyboard);
        if (!editing) return;
        const bounds = field.getBoundingClientRect();
        const banner = document.getElementById('top-banner');
        const top = Math.max(offset + 12, banner ? banner.getBoundingClientRect().bottom + 12 : 0);
        const bottom = offset + height - 16;
        if (bottom <= top) return;
        let delta = 0;
        if (bounds.height > bottom - top || bounds.top < top) delta = bounds.top - top;
        else if (bounds.bottom > bottom) delta = bounds.bottom - bottom;
        if (Math.abs(delta) > 1) window.scrollBy({top: delta, left: 0, behavior: 'auto'});
    }
    function schedule() {
        if (frame) window.cancelAnimationFrame(frame);
        frame = window.requestAnimationFrame(sync);
    }
    document.addEventListener('focusin', () => {
        schedule();
        // Some mobile keyboards finish opening after the initial focus event.
        window.setTimeout(schedule, 150);
        window.setTimeout(schedule, 350);
    });
    document.addEventListener('focusout', schedule);
    window.addEventListener('resize', schedule);
    window.addEventListener('pageshow', schedule);
    if (viewport) {
        viewport.addEventListener('resize', schedule);
        viewport.addEventListener('scroll', schedule);
    }
    schedule();
})();

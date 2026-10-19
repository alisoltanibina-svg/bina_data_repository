// Mobile-only scheduling around the existing CSS curtain transition.
(() => {
    'use strict';
    const root = document.documentElement;
    let moving = false, pendingMap = false, generation = 0, cleanup = () => {};
    const isMobile = () => window.matchMedia('(max-width: 767px)').matches;
    const isOpen = () => root.classList.contains('atlas-view');
    function begin(open) {
        if (!isMobile()) return false;
        const curtain = document.getElementById('entry-view-curtain');
        if (!curtain) return true;
        const changed = moving || isOpen() !== open || curtain.classList.contains('curtain-up') !== open;
        if (!changed) {
            if (open) window.requestAnimationFrame(() => {
                if (!moving && isOpen() && typeof scheduleMapSync === 'function') scheduleMapSync({animate:false});
            });
            return true;
        }
        cleanup();
        if (typeof map !== 'undefined' && map && typeof map.stop === 'function') map.stop();
        const version = ++generation;
        if (!moving) root.style.setProperty('--curtain-motion-height', curtain.getBoundingClientRect().height + 'px');
        moving = true; pendingMap = open;
        root.classList.add('mobile-curtain-moving');
        let timer;
        const finish = event => {
            if (version !== generation || !moving) return;
            if (event && (event.target !== curtain || event.propertyName !== 'transform')) return;
            cleanup(); moving = false;
            root.classList.remove('mobile-curtain-moving');
            root.style.removeProperty('--curtain-motion-height');
            const syncMap = pendingMap; pendingMap = false;
            window.requestAnimationFrame(() => {
                if (version !== generation || moving) return;
                window.dispatchEvent(new CustomEvent('atlascurtainsettled'));
                if (syncMap && isOpen() && typeof scheduleMapSync === 'function') scheduleMapSync({animate:false});
            });
        };
        const resized = () => { if (!isMobile()) finish(); };
        cleanup = () => {
            window.clearTimeout(timer);
            curtain.removeEventListener('transitionend', finish);
            window.removeEventListener('resize', resized);
        };
        curtain.addEventListener('transitionend', finish);
        window.addEventListener('resize', resized);
        // A hidden tab or interrupted transition may not emit transitionend.
        timer = window.setTimeout(() => finish(), 1100);
        return true;
    }
    window.atlasCurtainMotion = {
        begin, isMobile, isMoving: () => moving,
        deferMapSync() { if (!moving) return false; pendingMap = true; return true; }
    };
})();

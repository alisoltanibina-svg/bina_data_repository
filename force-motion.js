// File: force-motion.js
// Purpose: Play dashboard motion even when Windows/browser reduced-motion is on.
// Load this before Chart.js and page scripts so matchMedia reports no-preference.

(function forceDashboardMotion() {
    const original = window.matchMedia.bind(window);
    window.matchMedia = function (query) {
        if (/\bprefers-reduced-motion\b/i.test(String(query))) {
            return {
                matches: false,
                media: query,
                onchange: null,
                addListener() {},
                removeListener() {},
                addEventListener() {},
                removeEventListener() {},
                dispatchEvent() { return false; }
            };
        }
        return original(query);
    };
})();

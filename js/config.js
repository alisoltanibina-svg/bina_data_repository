// File: config.js
// Purpose: Site path helpers after js/css/html folders, plus API_BASE_URL.
//   Local uvicorn: absolute http://127.0.0.1:8000
//   Deployed (Nginx same host /api): empty string so requests stay on this origin.

(function (global) {
    var path = (global.location && global.location.pathname) || '';
    var inHtmlDir = /(^|\/)html\//.test(path);
    global.SITE = {
        html: inHtmlDir ? '' : 'html/',
        root: inHtmlDir ? '../' : '',
        page: function (file) {
            var m = String(file || '').match(/^([^?#]*)(.*)$/);
            var base = m[1];
            var rest = m[2];
            if (base === 'index.html' || base === '') {
                return this.root + 'index.html' + rest;
            }
            return this.html + base + rest;
        },
        asset: function (rel) {
            return this.root + 'assets/' + String(rel || '').replace(/^\/+/, '');
        }
    };
})(typeof window !== 'undefined' ? window : this);

// برای آنلاین بودن از کامنت دربیاید
// (function (global) {
//     const hostname = (window.location.hostname || '').toLowerCase();
//     const isLocal = hostname === '127.0.0.1' || hostname === 'localhost';
//     global.API_BASE_URL = isLocal ? 'http://127.0.0.1:8000' : '';
// })(window);

// برای آفلاین بودن از کامنت دربیاید
(function (global) {
    var loc = global.location;
    if (loc && /rasadbina\.ir$/i.test(loc.hostname || '') && loc.protocol === 'http:') {
        global.API_BASE_URL = 'https://' + loc.host;
        loc.replace('https://' + loc.host + loc.pathname + loc.search + loc.hash);
        return;
    }

    if (!loc || loc.hostname === 'localhost' || loc.hostname === '127.0.0.1') {
        // صفحه از لپ‌تاپ باز شده: API همان سایت آنلاین
        global.API_BASE_URL = 'https://app.rasadbina.ir';
        return;
    }

    // صفحه روی دامنه واقعی: همان origin با https
    global.API_BASE_URL = loc.origin || '';
})(typeof window !== 'undefined' ? window : this);

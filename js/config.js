// File: config.js
// Purpose: Site path helpers after js/css/html folders, plus API_BASE_URL.
//   Local uvicorn: absolute http://127.0.0.1:8000
//   Deployed (Nginx same host /api): empty string so requests stay on this origin.

(function (global) {
    var path = (global.location && global.location.pathname) || '';
    var inHtmlDir = /(^|\/)html\//.test(path);
    var assetVersion = '__ASSET_VERSION__';
    if (/^__.*__$/.test(assetVersion)) assetVersion = '';

    function versioned(url) {
        var value = String(url || '');
        if (!assetVersion || /^(?:[a-z]+:)?\/\//i.test(value) || value.indexOf('data:') === 0) return value;
        var hashAt = value.indexOf('#');
        var hash = hashAt >= 0 ? value.slice(hashAt) : '';
        var base = hashAt >= 0 ? value.slice(0, hashAt) : value;
        return base + (base.indexOf('?') >= 0 ? '&' : '?') + 'v=' + encodeURIComponent(assetVersion) + hash;
    }

    global.SITE = {
        version: assetVersion,
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
            return versioned(this.root + 'assets/' + String(rel || '').replace(/^\/+/, ''));
        },
        staticFile: function (rel) {
            return versioned(this.root + String(rel || '').replace(/^\/+/, ''));
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

    if (!loc || loc.hostname === 'localhost' || loc.hostname === '127.0.0.1') {
        // صفحه از لپ‌تاپ باز شده: API همان سایت آنلاین
        global.API_BASE_URL = 'https://app.rasadbina.ir';
        return;
    }

    // صفحه روی دامنه واقعی: مسیر نسبی /api
    global.API_BASE_URL = '';
})(typeof window !== 'undefined' ? window : this);

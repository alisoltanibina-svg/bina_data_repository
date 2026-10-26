// File: config.js
// Purpose: Site path helpers after js/css/html folders, plus API_BASE_URL.
//   Local previews use the deployed API; hosted pages use same-origin /api.

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

// HTML can be served by Nginx or a separate static host. Check maintenance
// through the API as well as the backend's page gate.
(function (global) {
    if (!global.document || !global.SITE) return;
    var script = global.document.createElement('script');
    script.src = global.SITE.staticFile('js/maintenance.js');
    global.document.head.appendChild(script);
})(typeof window !== 'undefined' ? window : this);

// Local previews use the deployed API; hosted pages use their own origin.
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

// Keep normal data response caching, but use a new cache URL after an import.
// Only the tiny revision check bypasses the browser cache. Concurrent dashboard
// requests share that check; later selections check again for a new revision.
(function (global) {
    var checking = null;
    var lastVersion = '00000000000000000000000000000000';

    function dataVersion() {
        if (!checking) {
            var options = { cache: 'no-store', credentials: 'omit' };
            if (global.AbortSignal && typeof global.AbortSignal.timeout === 'function') {
                options.signal = global.AbortSignal.timeout(5000);
            }
            checking = global.fetch((global.API_BASE_URL || '') + '/api/data-version', options)
                .then(function (response) {
                    if (!response.ok) throw new Error('Data version unavailable');
                    return response.json();
                })
                .then(function (data) {
                    if (/^[0-9a-f]{32}$/.test(data.version)) lastVersion = data.version;
                    return lastVersion;
                })
                .catch(function () { return lastVersion; })
                .finally(function () { checking = null; });
        }
        return checking;
    }

    global.SITE.dataUrl = async function (input) {
        var version = await dataVersion();
        var url = new URL(String(input), global.location.href);
        url.searchParams.set('data_version', version);
        return url.href;
    };
    global.dashboardFetch = async function (input, options) {
        return global.fetch(await global.SITE.dataUrl(input), options);
    };
})(typeof window !== 'undefined' ? window : this);

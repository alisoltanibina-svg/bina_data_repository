// File: config.js
// Purpose: Site path helpers and same-environment API selection.

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

(function (global) {
    var hostname = (global.location && global.location.hostname || '').toLowerCase();
    var isLocal = hostname === '127.0.0.1' || hostname === 'localhost';
    // A local/static copy never silently sends credentials or mutations to production.
    global.API_BASE_URL = isLocal ? 'http://127.0.0.1:8000' : '';
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
            var timeout;
            if (typeof global.AbortController === 'function') {
                var controller = new global.AbortController();
                options.signal = controller.signal;
                timeout = global.setTimeout(function () { controller.abort(); }, 5000);
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
                .finally(function () {
                    if (timeout !== undefined) global.clearTimeout(timeout);
                    checking = null;
                });
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

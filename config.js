// File: config.js
// Purpose: Resolve the FastAPI base URL. Production is same-host HTTPS only.
//   Local uvicorn (127.0.0.1 / localhost) still uses this origin or port 8000.

(function (global) {
    const PRODUCTION_ORIGIN = 'https://app.rasadbina.ir';
    const loc = window.location;
    const hostname = (loc.hostname || '').toLowerCase();

    if (hostname === 'app.rasadbina.ir') {
        global.API_BASE_URL = PRODUCTION_ORIGIN;
        return;
    }

    if (loc.protocol === 'file:' || !hostname) {
        global.API_BASE_URL = 'http://127.0.0.1:8000';
        return;
    }

    const host = hostname.indexOf(':') >= 0 ? '[' + hostname + ']' : hostname;
    const port = loc.port;
    if (!port || port === '8000') {
        global.API_BASE_URL = loc.origin;
        return;
    }

    global.API_BASE_URL = loc.protocol + '//' + host + ':8000';
})(window);

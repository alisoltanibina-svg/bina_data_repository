// File: config.js
// Purpose: Resolve the FastAPI base URL for local copies of this project.
//   Same-origin when uvicorn serves the pages; otherwise API port 8000 on this host.

(function (global) {
    var loc = window.location;
    var hostname = loc.hostname || '127.0.0.1';
    var host = hostname.indexOf(':') >= 0 ? '[' + hostname + ']' : hostname;
    var port = loc.port;

    if (loc.protocol === 'file:' || !hostname) {
        global.API_BASE_URL = 'http://127.0.0.1:8000';
        return;
    }

    if (!port || port === '8000') {
        global.API_BASE_URL = loc.origin;
        return;
    }

    global.API_BASE_URL = loc.protocol + '//' + host + ':8000';
})(window);

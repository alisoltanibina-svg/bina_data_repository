// File: config.js
// Purpose: API base for fetch(`${API_BASE_URL}/api/...`).
//   Local uvicorn: absolute http://127.0.0.1:8000
//   Deployed (Nginx same host /api): empty string so requests stay on this origin.

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

// File: config.js
// Purpose: API base for fetch(`${API_BASE_URL}/api/...`).
//   Local uvicorn: absolute http://127.0.0.1:8000
//   Deployed (Nginx same host /api): empty string so requests stay on this origin.

(function (global) {
    const hostname = (window.location.hostname || '').toLowerCase();
    const isLocal = hostname === '127.0.0.1' || hostname === 'localhost';
    global.API_BASE_URL = isLocal ? 'http://127.0.0.1:8000' : '';
})(window);

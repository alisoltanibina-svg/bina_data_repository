// Works with both backend-served pages and independently hosted static HTML.
(function () {
    const current = new URL(window.location.href);
    const page = current.pathname.replace(/\/+$/, '');
    if (/\/html\/(?:admin|admin-login)(?:\.html)?$/.test(page)) return;

    const onMaintenancePage = /\/html\/maintenance(?:\.html)?$/.test(page);
    const maintenanceUrl = new URL(SITE.page('maintenance.html'), current);
    let pending = false;
    let navigating = false;

    async function checkMaintenance() {
        if (pending || navigating) return;
        pending = true;
        try {
            const response = await fetch((window.API_BASE_URL || '') + '/api/maintenance/status', {
                cache: 'no-store', credentials: 'omit'
            });
            if (!response.ok) return;
            const status = await response.json();
            if (status.maintenance_enabled === true && !onMaintenancePage) {
                maintenanceUrl.searchParams.set('return', current.pathname + current.search + current.hash);
                navigating = true;
                window.location.replace(maintenanceUrl.href);
            } else if (status.maintenance_enabled === false && onMaintenancePage) {
                const target = new URL(current.searchParams.get('return') || SITE.page('index.html'), current);
                // Only return to this site's own public pages; never redirect
                // to an external URL or back into the maintenance page.
                const safe = target.origin === current.origin
                    && !/\/html\/maintenance(?:\.html)?\/?$/.test(target.pathname);
                navigating = true;
                window.location.replace(safe ? target.href : new URL(SITE.page('index.html'), current).href);
            }
        } catch (_) {
            // A network outage alone must not be mistaken for maintenance.
        } finally {
            pending = false;
        }
    }

    checkMaintenance();
    window.setInterval(checkMaintenance, 15000);
    window.addEventListener('pageshow', checkMaintenance);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) checkMaintenance();
    });
})();

# Temporary maintenance mode

## Decision

Maintenance is an Nginx edge-mode, not a frontend flag and not an application
shutdown.  The API process, database, jobs, and monitoring remain online.  The
edge returns `503 Service Unavailable` for public pages, static files, and API
requests before they reach the application.  `maintenance.html` is a standalone
document with no external assets, so it continues to render when the rest of the
site is intentionally unavailable.

Operators reach the normal site only from a fixed VPN/operations network. Do not
use a shared password, URL query parameter, header, or a browser cookie as a
maintenance bypass: each is easy to leak, cache, or replay. Configure the real
client IP correctly before relying on an IP allowlist (for example, when a CDN
or load balancer is in front of Nginx).

`/healthz` remains public and returns `204` without querying the database. It is
for liveness monitoring only; it must not be used as a general status page.

## Nginx setup

Build and deploy the frontend once so `dist/maintenance.html` exists. In the
Nginx `http` block, define the operations network. Replace the example CIDR with
the actual, stable VPN range:

```nginx
geo $dashboard_ops_network {
    default 0;
    10.20.0.0/16 1;
}
```

In the application's `server` block, add the following before the existing
public and `/api/` locations. Keep the existing proxy headers in `/api/`.
`map` belongs in the `http` block, so put that directive in an `http`-level
include if the virtual host is an isolated `server` file.

```nginx
# http block
map $dashboard_ops_network $dashboard_maintenance_public {
    default 0;  # change only this value to 1 to enable maintenance
    1       0;  # operations VPN always bypasses maintenance
}

# application server block

error_page 503 /maintenance.html;
location = /maintenance.html {
    internal;
    root /opt/app/dist;
    add_header Cache-Control "no-store, max-age=0" always;
    add_header Retry-After "900" always;
}
location = /healthz {
    proxy_pass http://127.0.0.1:8000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
location /api/ {
    if ($dashboard_maintenance_public) { return 503; }
    proxy_pass http://127.0.0.1:8000;
    # Retain the existing proxy_set_header directives here.
}
location / {
    if ($dashboard_maintenance_public) { return 503; }
    try_files $uri $uri/ /index.html;
}
```

The Nginx `if` statements above only return a code; this restricted use is safe.
If a server already defines these locations, merge the two maintenance checks
into the existing locations rather than adding duplicates.

## Operating runbook

1. Before the first use, test in staging: a public anonymous request and a
   public API request return `503`; `/healthz` returns `204`; and a request from
   the operations VPN can use the admin panel and API.
2. Start maintenance by changing the map's `default` value to `1`, then run
   `sudo nginx -t`. Only if validation succeeds, run `sudo systemctl reload nginx`.
   Do not stop Uvicorn or PostgreSQL.
3. Verify from an anonymous browser window that the response is `503`, includes
   `Retry-After`, has `Cache-Control: no-store`, and renders the Persian page.
   Verify `/healthz` separately.
4. Finish maintenance by changing the map's `default` value back to `0`, repeating the syntax
   test and reload, then smoke-test one public page and one API request.
5. Record the change owner, start/end time, release version, and rollback result.

For an extended outage, update the page wording and `Retry-After` value to match
the expected return time. Never cache the maintenance response at a CDN without
an explicit, separately tested purge/rollback plan.

# Temporary maintenance mode

## Decision

Maintenance is an Nginx edge-mode, not a frontend flag and not an application
shutdown.  The API process, database, jobs, and monitoring remain online.  The
edge returns `503 Service Unavailable` for public pages, static files, and API
requests before they reach the application.  `maintenance.html` is a standalone
document with no external assets, so it continues to render when the rest of the
site is intentionally unavailable.

This edge switch is separate from the application's admin-panel maintenance
switch. When edge mode blocks all public traffic, turn it off through Nginx
configuration over SSH. The application and its admin panel cannot override it.

`/healthz` remains public and returns `204` without querying the database. It is
for liveness monitoring only; it must not be used as a general status page.

## Nginx setup

Build and deploy the frontend once so `dist/maintenance.html` exists.
`python scripts/build_frontend.py` embeds the shared maintenance layout, font,
background, map, and animated gear mask in that document. It makes no external
asset or script requests, so the Nginx edge switch cannot block its artwork.
Edit `html/maintenance.html` and `css/maintenance.css` for UI changes; the build
regenerates the standalone document automatically. Reduced-motion preferences
disable gear rotation.

In the application's `server` block, add the following before the existing
public and `/api/` locations. Keep the existing proxy headers in `/api/`.
`map` belongs in the `http` block, so put that directive in an `http`-level
include if the virtual host is an isolated `server` file.

```nginx
# http block
map $uri $dashboard_maintenance_public {
    # Re-evaluate after the internal redirect to the exempt error-page URI.
    volatile;
    default 0;  # change only this value to 1 to enable maintenance
    /healthz 0;
    /__dashboard_maintenance 0;
}

# application server block

# Use the SAME root as the deployed frontend. Replace this example path with
# the actual release directory; maintenance.html must exist directly inside it.
root /opt/app/dist;
error_page 503 =503 /__dashboard_maintenance;
location = /__dashboard_maintenance {
    internal;
    try_files /maintenance.html =503;
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

A server-level `if ($dashboard_maintenance_public) { return 503; }` also runs
on the internal redirect to the error document. It works with the `$uri` map
above only when the map includes both `volatile;` and the exemption for
`/__dashboard_maintenance`. Without `volatile;`, Nginx reuses the original
value of `1` and returns its generic 503 page instead of the custom document.
Do not add a maintenance check to the exact maintenance location.

The API and page proxy locations should explicitly use
`proxy_intercept_errors off;` so application-generated maintenance HTML and
JSON are passed through unchanged. The edge's own `return 503` still uses the
local error document above.

### If Nginx shows its generic “temporarily unavailable” page

Apply the error-page block in the active **HTTPS** server, not just the HTTP
redirect server. Remove competing `error_page 503` directives in public
locations. For a server-level maintenance check, first confirm the map includes
`volatile;` so the exempt internal redirect is re-evaluated. Confirm that the
deployed document exists and is readable by Nginx:

```sh
test -r /opt/app/dist/maintenance.html
sudo nginx -t
```

Use the actual frontend root in both commands and configuration. `nginx -t`
checks configuration syntax but does not verify that the error document exists.
Inspect `/var/log/nginx/error.log` if the custom page still fails; a missing
file or permission error there identifies the remaining deployment problem.
Never point the fallback at `/html/maintenance.html` in edge mode: that page
loads site assets, which edge mode intentionally blocks. The top-level
`maintenance.html` is the standalone edge document.

## Operating runbook

1. Before the first use, test in staging: a public anonymous request and a
   public API request return `503`; `/healthz` returns `204`; and the custom
   document renders without loading any external resources.
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

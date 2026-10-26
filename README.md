# دیده‌بان فرهنگ — بک‌اند

API روی FastAPI است و داده را از **PostgreSQL** می‌خواند. فایل SQLite دیگر استفاده نمی‌شود.

## پیش‌نیاز

- Python 3.11+
- PostgreSQL خالی (یک دیتابیس و یک یوزر محدود برای اپ، نه سوپریوزر)

## نصب و اجرای محلی

```bash
pip install -r requirements.txt
copy .env.example .env
```

در `.env` مقدار `DATABASE_URL` را پر کنید:

```
DATABASE_URL=postgresql+psycopg://USER:PASSWORD@HOST:5432/DBNAME
```

ساخت اسکیما روی دیتابیس خالی (جدول‌ها بدون داده):

```bash
alembic upgrade head
```

برای عکس پروفایل و سابقهٔ ویرایش (مهاجرت `0003_user_avatars_and_revisions`) همین فرمان را از ریشهٔ پروژه بزنید تا ستون `users.avatar_path` و جدول `profile_revisions` ساخته شود. فایل عکس‌ها در `assets/images/avatars/` ذخیره می‌شود.

اجرای API:

```bash
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

فرانت همان مسیرهای `/api/...` را صدا می‌زند. داده را جداگانه در Postgres بریزید؛ این مخزن اسکریپت کپی از SQLite ندارد.

اگر `DATABASE_URL` نباشد یا SQLite باشد، فرایند با خطای واضح متوقف می‌شود و به فایل لوکال برنمی‌گردد.

## امنیت

یوزر و پسورد فقط از محیط (`.env` یا متغیر سیستم). `.env` را در Git نگذارید. URL دیتابیس در لاگ چاپ نمی‌شود.

`ADMIN_PHONE` و `ADMIN_PASSWORD` فقط برای ساخت حساب مدیر اولیه استفاده می‌شوند. پس از ساخت حساب، شروع دوبارهٔ برنامه رمز یا وضعیت آن حساب را تغییر نمی‌دهد؛ می‌توانید `ADMIN_PASSWORD` را از محیط حذف کنید. اگر `ADMIN_PHONE` متعلق به یک کاربر غیرمدیر باشد، برنامه با خطا متوقف می‌شود و به او دسترسی مدیر نمی‌دهد. بازیابی رمز مدیر مثل سایر حساب‌ها با OTP انجام می‌شود و نشست‌های قبلی را باطل می‌کند.

برای محدودسازی درخواست‌ها، برنامه IP را فقط از `request.client` می‌گیرد. وقتی ترافیک مستقیم به Nginx می‌رسد، Uvicorn را فقط روی loopback و با اعتماد به همان پروکسی اجرا کنید:

```bash
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --proxy-headers --forwarded-allow-ips 127.0.0.1
```

در بلوک `location ^~ /api/` تنظیمات Nginx زیر باید جایگزین سرآیندهای ارسالی کاربر شوند:

```nginx
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-Proto $scheme;
```

از `$proxy_add_x_forwarded_for` استفاده نکنید؛ این متغیر مقدار ارسالی کاربر را هم حفظ می‌کند. `RATE_LIMIT_TRUST_PROXY` دیگر استفاده نمی‌شود و می‌توانید آن را از محیط حذف کنید. پس از تغییر Nginx، ابتدا `sudo nginx -t` را اجرا کنید و فقط در صورت موفقیت پیکربندی را reload کنید.

پنج رمز عبور نادرست در ۱۵ دقیقه، ورود را برای ۱۵ دقیقه محدود می‌کند؛ حساب همچنان فعال می‌ماند و نشست‌های فعلی بسته نمی‌شوند. تا پایان محدودیت، ارسال و تأیید پیامک بازیابی و بازنشانی رمز نیز مسدود است؛ کدهای تأییدشده قبلی و فعال‌سازی توسط مدیر محدودیت را دور نمی‌زنند. غیرفعال‌سازی حساب توسط مدیر جداست و فقط با فعال‌سازی مدیر برطرف می‌شود. علت و زمان غیرفعال‌سازی و سابقه وضعیت در جزئیات حساب قابل مشاهده است. حساب‌های غیرفعال قدیمی خودکار فعال نمی‌شوند؛ علت وضعیت پیشین آن‌ها «نامشخص» نمایش داده می‌شود و باید بررسی شوند.

عبور از سهمیه API فقط تا آزاد شدن همان پنجره محدود می‌شود؛ ممنوعیت دو ساعته حذف شده است. پاسخ `429` شامل `Retry-After` است و درخواست‌های ردشده محدودیت را تمدید نمی‌کنند. شمارنده‌ها در حافظه هر فرایند هستند و بین workerها مشترک نیستند.

CORS پیش‌فرض فقط `https://app.rasadbina.ir` است (HTTPS). برای عوض کردن، `CORS_ORIGINS` را در `.env` بگذارید (چند مبدأ با ویرگول). فرانت روی همان دامنه همیشه `https://app.rasadbina.ir` را برای API می‌گیرد.

پیامک OTP (عضویت و فراموشی رمز) از Kavenegar است. در `.env`:
برای محافظت از ورود، CAPTCHA داخلیِ پنج‌نویسه استفاده می‌شود. `CAPTCHA_HMAC_SECRET` را با یک مقدار تصادفیِ دست‌کم ۳۲ نویسه در `.env` تنظیم کنید. پاسخ‌ها فقط به شکل HMAC در پایگاه‌داده نگهداری می‌شوند؛ چالش‌ها پنج دقیقه اعتبار و یک تلاش دارند، به شمارهٔ ورود متصل‌اند و تصویرشان cache نمی‌شود.


```
KAVENEGAR_API_KEY=
KAVENEGAR_SENDER=
KAVENEGAR_OTP_MESSAGE=سامانه دیده‌بان فرهنگ\nکد ورود شما: {code}
```

اگر `KAVENEGAR_API_KEY` خالی باشد پیامک ارسال نمی‌شود و در محیط توسعه کد ثابت `123456` پذیرفته می‌شود. جدول `otp_challenges` با `alembic upgrade head` ساخته می‌شود.

## ساخت و کش فایل‌های فرانت‌اند

پیش از هر استقرار، خروجی فرانت‌اند را بسازید:

```bash
python scripts/build_frontend.py
```

این فرمان محتوای فایل‌های عمومی را هش می‌کند، یک نسخهٔ ۱۲ کاراکتری می‌سازد و خروجی را در `dist/` قرار می‌دهد. همهٔ ارجاع‌های محلی HTML و CSS و همچنین URLهایی که با `SITE.asset()` یا `SITE.staticFile()` ساخته می‌شوند، خودکار `?v=<hash>` می‌گیرند. بنابراین نام فایل‌های منبع و ارجاع‌های کد را دستی تغییر ندهید. فایل دیتابیس و عکس‌های آپلودی کاربران وارد خروجی نمی‌شوند.

ریشهٔ استاتیک Nginx را روی `/opt/app/dist` بگذارید و قواعد نمونهٔ `deploy/nginx-dashboard.conf.example` را با تنظیمات فعلی HTTPS ادغام کنید. عکس‌های کاربران باید با `alias` از `/opt/app/assets/images/avatars/` سرو شوند. HTML همیشه revalidate می‌شود؛ فایل‌های دارای نسخه یک سال و به‌صورت `immutable` کش می‌شوند.

روال استقرار:

```bash
git pull --ff-only
python scripts/build_frontend.py
sudo nginx -t
sudo systemctl reload nginx
sudo systemctl restart YOUR_UVICORN_SERVICE
```

اگر Uvicorn نیز باید فایل‌های فرانت‌اند را سرو کند، در محیط سرویس مقدار زیر را اضافه کنید:

```text
STATIC_ROOT=/opt/app/dist
```

پس از استقرار، `dist/release.json` نسخهٔ فعال خروجی را نشان می‌دهد. هر تغییر واقعی در فایل عمومی، هش جدید می‌سازد و مرورگر URL جدید را بدون پاک‌کردن دستی کش دریافت می‌کند.


## Site maintenance mode

In the admin panel, open «وضعیت سامانه» and use «حالت به‌روزرسانی سایت».
The setting is stored in the existing `site_settings` table; no migration is needed.
Public pages return HTTP 503 with only the Iran artwork and
«سایت در حال به روز رسانی است». Public data APIs also return 503.
The admin panel and `/html/admin-login.html` remain accessible, together with
the authentication APIs and static assets required to sign in and disable it.
The shared frontend also checks `/api/maintenance/status` on page load, when a
tab becomes visible, and every 15 seconds. This redirects independently served
HTML to the maintenance artwork page and returns visitors to their original
page when maintenance is disabled. Admin and recovery login pages are exempt.
The status endpoint stays readable while other public APIs return 503.

Deploy backend and frontend together, run `python scripts/build_frontend.py`,
set `STATIC_ROOT=/opt/app/dist`, and restart the backend. Merge the updated
`location /` from `deploy/nginx-dashboard.conf.example` into the live Nginx
configuration, validate it with `nginx -t`, and reload Nginx. Page requests must
be proxied to the backend for HTTP 503 page responses. If Nginx serves HTML
directly, the frontend check still displays maintenance after checking status.
Preserve the API and static asset locations in that example.

Verification: `python -B -m unittest discover -s tests -p test_maintenance.py -v`
and `node --test tests/admin_maintenance.test.cjs tests/maintenance_navigation.test.cjs`. Tests use isolated fixtures
and never change the project database or enable maintenance on the live site.

## Refreshing Explorer indicator scores

After committing a data import in the live PostgreSQL database, run from the
server's project directory:

```bash
python scripts/refresh_data_cache.py
```

This rotates `data/.cache-version`. Every running API worker checks that shared
file on cache access, discards old computed results, and uses new HTTP ETags.
Cached results are rebuilt on demand. Existing cache lifetimes and HTTP caching
headers stay the same. Before dashboard data requests, the frontend retrieves
`/api/data-version` with caching disabled and adds that revision to the data URL.
Browsers therefore fetch new data after an import while reusing cached responses
when the revision has not changed. Concurrent requests share the version check.
Users do not need to clear their browser cache or perform a hard refresh: the
next page load or indicator selection uses the new revision. Already displayed
charts update when the user requests data again. If the revision endpoint is
temporarily unavailable, the frontend retains its last known revision.
No frontend build or backend restart is required
for subsequent data refreshes. Deploy this implementation and restart the API
once before using the command for the first time. Deploy the updated frontend
build together with the backend so browsers have the version-aware requests.

Run the command in the same deployed checkout as the API. If replicas use
separate checkouts or containers, set `DATA_CACHE_VERSION_FILE` to the same
shared, readable file for the API workers and refresh command, or run the
command in each replica. Do not copy the runtime revision file from a laptop.
Atlas topic scores are separate and come from `trend_score`.

## Neshan Atlas and Explorer maps

Atlas and Explorer use Neshan's Leaflet SDK and the `dreamy` base map. Set the web map key
in the deployment server's project `.env` (or service environment):

```dotenv
NESHAN_MAP_API_KEY=your_neshan_web_map_key
```

Enable the web map service in Neshan and authorize `app.rasadbina.ir`.
The key is visible to browsers by design; restrict its allowed domains in Neshan.
Deploy the backend and frontend changes together, run
`python scripts/build_frontend.py`, and restart the existing Uvicorn service.
No database migration is required. Environment variables override `.env`.

Both maps retrieve the key from `/api/maps/config` with caching disabled. A missing
key returns HTTP 503 and the map shows a loading error. After deployment, verify
map tiles, province selection, popups, and zoom on desktop and mobile. If your
server sets a Content Security Policy, allow `https://static.neshan.org` for SDK
CSS/JS and the Neshan SDK's tile/image hosts.


### Diagnosing unexpected API rate limits

An exceeded rate-limit window logs one `rate_limit_window_started` warning containing the
resolved client IP, triggering API path, quota, limit, window, and retry delay.
Inspect the Uvicorn service journal for this warning. Rejected requests during
an existing window do not repeat the warning or extend the restriction.

If unrelated visitors are logged as `127.0.0.1` or one proxy IP, inspect Nginx's
forwarded headers and Uvicorn's trusted proxy configuration before raising
quotas. If a CDN sits in front of Nginx, its real-IP configuration also needs to
be verified. Do not trust arbitrary forwarded headers from the public internet.
Rate-limit settings currently read the process environment; a project `.env`
entry only affects them if the service also loads it as an environment file.

## Ticket support for authentication and user accounts

`html/support.html` is public and linked only from the login,
registration, OTP, and password recovery step. Support is provided only through
written tickets. The curtain retains its original general contact popover;
authentication support and ticket replies use the ticket flow. No callback,
email, or ticket SMS delivery is configured.
Name and phone are required for new tickets; the phone is user-supplied and must not be
treated as verified identity or used alone to authorize account changes.

Users receive a single random tracking code (80 bits of randomness, 20 characters
including `SUP-`). They can copy or download a receipt and use that code alone to
read and reply without signing in. There is no separate access key. Tracking and
reply requests carry the code in POST bodies, never URLs or browser storage.
Existing ticket references continue to work without their former keys. The code
provides access to the conversation and should be retained by its owner.
The legacy `access_hash` column remains for schema compatibility and is no longer
used for authorization. Profile-ticket ownership uses migration `0013_account_tickets`. Deploy the
backend and frontend together. Registration passwords and OTP proofs are kept
only in page memory, never session storage.

The admin panel's «تیکت‌های پشتیبانی» tab lists tickets, supports written replies,
and records status transitions (open, in progress, awaiting user, closed).
Closed tickets are read-only for users; only an administrator can reopen them. Error references and the originating auth
step accompany tickets opened from an error screen; passwords and OTP codes must
never be requested in tickets. Unexpected server errors log the reference as
`unexpected_api_error reference=...` for investigation.

Public support has independent quotas: 20 requests/minute, 5/second, and
10 ticket creation attempts/hour per IP, plus a separate support CAPTCHA budget.
Exhausting the main API quota does not block support. Exhausting the creation
quota does not block tracking. These limits still apply to visitors sharing a
public IP. All ticket API responses disable caching.

Deploy backend and frontend together. In the deployment environment, run:

```bash
cd /opt/app
source venv/bin/activate
alembic upgrade head
python scripts/build_frontend.py
sudo systemctl restart app-api
```

Migration `0012_support_recovery` adds ticket tables, account status history and
separate temporary lock fields. It preserves existing inactive accounts. The
existing `CAPTCHA_HMAC_SECRET` is required; no new support service keys are needed.
After deployment, create a ticket while signed out, reply in the admin inbox,
and read the reply using only its tracking code. Also verify an inactive account gets
«حساب غیرفعال است» and can still open support. Database backups should include
the new support tables as they contain the conversation and contact data.

### Personal ticket history

The profile dropdown includes «تیکت‌های من», opening `html/tickets.html` in the same
tab. Signed-in users can view their own history, create tickets about the Atlas,
Explorer, profile, or authentication, and read or reply to the admin's responses.
Name and phone are taken from the authenticated account; clients cannot set the
owner or substitute a different account's identity. A new login returns users to
the ticket page when their session has expired.

Both guest and account tickets use the same ticket, message, and status tables,
and the same admin inbox. The migration adds only nullable `support_tickets.user_id`
and one partial composite index on `(user_id, updated_at DESC, id DESC)` for owned
tickets. Adding the nullable column without a default avoids rewriting existing
rows. History requests select only summary columns, fetch at most 26 rows to show
25, and use cursor pagination without `COUNT`, `OFFSET`, or message joins.
Conversations load only when selected. No additional ticket tables or per-message
ownership fields are needed.

Every account list, detail, and reply endpoint checks the session and owner. Guest
tracking endpoints only accept guest tickets; an account ticket cannot be opened
through its tracking code while signed out. Existing guest tickets remain guest
tickets, because their user-supplied phone number is not proof of ownership. No
bulk association by phone is performed. Deleting an account cascades to its owned
tickets and their conversations; guest tickets are preserved. Admins review both
kinds of ticket in the existing support inbox, which shows the account owner.

Deploy backend and frontend together and run `alembic upgrade head` before
restarting `app-api`, then build the frontend with `python scripts/build_frontend.py`.
Migration `0013_account_tickets` is required. No new environment variables are
needed. Account ticket creation uses the existing creation throttle (10/hour per
IP); exhausting creation capacity does not prevent reading existing tickets.


The legacy `bubble-chart` page is retired. The API static server redirects its
root and `/html/` URLs (with or without `.html`) to `/html/explorer.html`.
The published `html/bubble-chart.html` is a redirect-only fallback for Nginx
static hosting; it no longer loads the old chart UI or its chart libraries.
Old saved post-login destinations also resolve to Explorer.
For an HTTP redirect when Nginx serves static pages directly, add this rule
inside the existing `server` block, before any broad regex locations:

```nginx
location ~ ^/(html/)?bubble-chart(?:\.html)?/?$ {
    return 308 /html/explorer.html;
}
```

After editing the server configuration, run `sudo nginx -t` and reload Nginx
only if validation succeeds.


Private ticket image attachments
-------------------------------

Signed-in account tickets and administrator replies accept JPG/JPEG, PNG, and
WebP images. Guest tickets remain text-only. PDF, SVG, HTML, executables, archives,
Office files, and animated images are not accepted; no malware-scanner service
or external document processing is required or enabled in this release.

Each message accepts at most three files, each at most 3 MiB. The server checks
the extension and decoded format, rejects images above 16 million pixels or an
8192-pixel edge, applies EXIF orientation, and saves a new metadata-free WebP
with a maximum 4096-pixel edge. Original bytes and filenames are never used as
public assets or filesystem paths. Processing is bounded to two decoders per
API process. Per-account limits are 60 successful uploads / 100 MiB of source
files per rolling 24 hours, 20 MiB of staged images, and 250 MiB of retained
images. A ticket accepts at most 50 MiB of attachments. Upload requests also
have dedicated IP rate limits. Deleted staged metadata remains for 24 hours
so removing files cannot reset the upload quota.

Files live in `TICKET_ATTACHMENT_DIR`, defaulting to the project sibling
`<project-name>-private/support-attachments`. This must be outside the project
and `STATIC_ROOT`, outside every Nginx document root/alias, and writable only by
the API service user. Directories are created with mode 0700 and files with 0600
on Linux. Only the original uploader can access staged files; after attachment,
only the ticket owner and active administrators can download them. Download
routes check the session and ticket ownership on every request, return re-encoded
WebP only with `nosniff`, download disposition, and `Cache-Control: no-store`.
User-submitted filenames and messages are rendered as text in both interfaces.

One metadata table (`support_attachments`, migration `0014_ticket_attachments`)
links images to messages. No file binaries are stored in PostgreSQL. Uploads
are staged for 30 minutes, then claimed atomically with message creation under
the ticket lock. Concurrent claims and quota reservations are serialized. A
closed ticket rejects attachments and user replies even if it closes while an
image is being processed. An uncommitted/failed message never claims an image;
text and files remain available in the form for retry. Retrying the same message
with its already-claimed attachments does not create duplicate messages.

A background cleanup runs at startup and every 24 hours. It expires unused
staged uploads and removes orphan files after a one-hour grace period following
ticket/account deletion or interrupted file/DB writes. Attachments on tickets
that have remained closed for three UTC calendar months are automatically
retired and physically deleted; ticket text, message history and attachment
metadata remain. Both user and admin uploads follow this policy. Open tickets
are excluded. Reopening before expiry cancels eligibility; closing again starts
another three-month period using the latest closure event. For legacy closed
tickets without a closure event, `updated_at` is the fallback. Month-end dates
are clamped to the last day of the target month. Cleanup processes at most 500
attachments from 100 tickets per run and locks tickets against concurrent
reopening. Failed file deletions are retried by the orphan sweep. The picker
shows the policy before upload. This applies to existing attachments as well
when this release starts; reopening cannot restore files already deleted.
No additional migration is required for retention. Back up the private directory
together with the database, with
the same access controls as other account data. Restore both together; database
backups alone do not contain the images. Existing backups are not pruned by this
job; apply a separate backup retention policy. Existing guest tracking behavior and
closed-ticket read-only behavior are preserved.

Deployment for this release:

1. Install the existing pinned dependencies and run `alembic upgrade head` before
   restarting the API. This adds one new table without rewriting existing ticket
   or message rows. Downgrading to `0013_account_tickets` removes attachment
   metadata; do not downgrade once uploads must be retained without a backup.
2. Create `/opt/app-private/support-attachments` owned by the user configured in
   the `app-api` service, mode 0700. Set
   `TICKET_ATTACHMENT_DIR=/opt/app-private/support-attachments` in the deployment
   environment if the default sibling path is unsuitable. Never add a static
   location or alias for this directory.
   If the systemd service uses `ProtectSystem=strict` or otherwise mounts `/opt`
   read-only, directory ownership alone is insufficient. Create the private
   directory on the host first, then add a service drop-in with a narrow exception:

   ```ini
   [Service]
   ReadWritePaths=/opt/app-private/support-attachments
   ```

   Keep existing filesystem protections and other `ReadWritePaths` entries.
   Run `sudo systemctl daemon-reload` and restart `app-api` after adding the
   drop-in. `OSError: [Errno 30] Read-only file system` during upload indicates
   that this mount restriction (or a read-only host filesystem) still applies;
   changing permissions with `chmod` alone cannot fix it.

3. In the existing Nginx `location ^~ /api/` block, allow bounded image requests:

   ```nginx
   client_max_body_size 6m;
   client_body_timeout 30s;
   proxy_read_timeout 60s;
   proxy_cache off;
   ```

   Retain the existing proxy headers. Validate with `sudo nginx -t` before reload.
   Without an explicit limit, Nginx can reject uploads above its default 1 MiB.
   The proxy allows 6 MiB for existing avatar multipart uploads; ticket images
   are independently limited to 3 MiB in the picker, request middleware, streamed
   upload route, and image processing code.
   Nginx may buffer request bodies to its own managed temporary storage; do not
   expose that directory either. The API independently limits JSON bodies to
   64 KiB, avatar multipart bodies to 6 MiB, and streamed ticket uploads to 3 MiB.
4. Build with `python scripts/build_frontend.py` and deploy the backend and the
   matching frontend release together. Restart `app-api` after migration. User
   and admin forms share a paperclip picker, previews, removal, progress, and
   private download controls; closed conversations hide the reply interface.
5. `CORS_ORIGINS` now controls the actual middleware allowlist and must contain
   exact trusted origins, with HTTPS for production. Local development requires
   explicitly adding the local frontend origin. Wildcards are rejected. Unsafe
   API requests validate Origin; cookie-authenticated requests without Origin
   must carry `X-CSRF-Protection: 1`. The shared frontend request helper supplies
   this header, and uploads always require it. Guest form requests remain JSON;
   form-encoded submissions and unexpected body fields are rejected. Input
   validation preserves Persian letters and half-spaces, bounds every declared
   text field, rejects control/direction-spoofing characters, and does not echo
   validation inputs or secrets in error responses. Existing password
   normalization is retained for compatibility with stored password hashes.

Security checks run only against `TEST_DATABASE_URL` in disposable schemas and
temporary private directories. The regression coverage includes cross-account
reads/claims, forged formats, traversal/control filenames, image bombs, metadata
stripping, quotas, concurrent claims, close-during-upload races, stale uploads,
orphan cleanup, CSRF, chunked body limits, and unexpected fields.

## Polygon coverage and 3 km settlement collection

The collector now supports a full-polygon plan rather than one small circle per
city. The same PostgreSQL job/request/place tables, admin controls, managed worker,
provider adapter, and stable `(provider, provider_id)` identity constraint are used.
Migration `0019_poi_polygon_coverage` adds coverage plans, tile certificates, shared
circles, owned-area contributions, and parent/child search links. It pauses existing
collection and preserves all historical jobs, requests, and resolved Details.

### Geographic inputs and generated files

The eight inputs are read from `data/search area/area_to_search1.geojson` through
`area_to_search8.geojson`. Their roles are detected explicitly, not from sequential
file numbers in older directories:

| Number | Role |
| --- | --- |
| 1 | 3,633 settlement observations |
| 2 | 1,457 earlier settlement observations, merged with layer 1 |
| 3 | 485 direct county polygons |
| 4 | 1,196 district polygons |
| 5 | Lake Urmia polygon; included in the requested polygon scope |
| 6 | 31 province polygons |
| 7 | 2,792 rural/municipal/special polygons |
| 8 | 62,284 village/rural-place observations |

The source compiler preserves file hashes and every observation's source fields.
Layer 8's Latin-1/Windows-1256 text mix-up is recovered reversibly in memory, without
editing its original file. Polygon associations use spatial intersections and
versioned source codes, avoiding the inconsistent county/district identifiers in
the supplied attributes. The layer names do not establish a complete current census
of settlements: farms, facilities, and other named places also occur.

The combined snapshot contains **65,911 named point targets**. Exact coincident
centres use one shared 3,000 m request while retaining all source associations;
there are **65,906 distinct 3 km query centres** in the inspected snapshot. Points
outside the supplied province/county polygons are retained with quality flags and
an explicitly unassigned queue group; their valid geometry is not silently dropped
or assigned a fabricated province. One questionable name is retained for review.

Generated local source exports are in `output/poi_coverage/`:
`search_boundaries.geojson`, `point_searches_3000m.geojson`, and
`source_manifest.json`. Point exports are anchors with a `radius_m` of 3000, not
village footprint polygons. Full planned circle exports are produced after the
coverage build, and include `latitude`, `longitude`, `radius_m`, kind, and all
source/polygon associations.

```bash
python -m scripts.plan_poi_coverage sources --output-directory output/poi_coverage
python -m scripts.plan_poi_coverage audit --radius 2000 --output output/coverage-audit.json
```

These commands are offline and do not access PostgreSQL or Neshan. Output source
exports refuse to overwrite an existing directory's generated files. The audit's
request count is an area-based estimate before 3 km seed reuse, edge treatment,
and redundancy removal; the exact count comes from the completed build.

The completed **2 km polygon / 3 km point** build contains **197,700 base circles
per category**: 131,794 polygon-fill circles and 65,906 shared point circles.
Every one of its 2,804 tiles is verified; the final tile union also covers the
complete target union. `national_search_centres.csv.gz` and
`national_coverage_certificate.json` contain the generated result. Adaptive
subdivision can add further requests. The earlier 500 m plan and exports are
preserved under `output/poi_coverage/previous_500m/` for comparison.

The [downloadable data bundle](output/poi_coverage/coverage_plan_bundle.zip) contains
all eight original geographic inputs, the generated exports, certificates, and
verification manifest. It contains geographic planning data; deploy the repository
code separately using the instructions below.

At the existing 30-60 second pacing, those base Nearby calls alone require about
68-138 days per category, before Details, retries, and subdivision. The pacing
was not silently changed. Saturated 2 km searches are subdivided into smaller
circles after the provider's result cap is confirmed and configured.

### Coverage algorithm and its guarantee

GeoPandas projects the WGS84 inputs into an Iran-centred, conformal transverse
Mercator metric CRS (central meridian 54 degrees; scale factor 0.9996). A single
national triangular lattice avoids UTM-zone and shared-polygon seam duplicates.
Horizontal spacing is `0.98 * sqrt(3) * radius`, vertical spacing is
`0.98 * 1.5 * radius`, with alternating half-row offsets. Circles intersecting the
target are retained even when their centres are outside the polygon.

The supplied polygons are dissolved into their union before coverage planning.
Every valid settlement point has a fixed **3 km query**. These fixed circles also
cover polygon areas, reducing the smaller polygon-fill requests needed. Polygon
radius defaults to **2,000 m**. An inscribed, conservatively scaled circle polygon
accounts for projection distortion; tests compare exported footprints to WGS84
geodesic distances. Source-coordinate extent is validated before projection.

Planning uses deterministic bounded tiles and one shared circle key across tiles.
For each tile, the planner computes `target - union(search footprints)`, repairs
remaining gaps, removes redundant circles only when coverage survives, and verifies
again. Numeric geometry uses a recorded **1 mm metric precision**. Ownership pieces
partition the target so shared circles/overlaps do not inflate area progress.
Final verification also checks that verified tile geometries cover the entire
polygon union and that the area ledger reconciles. Failed certificates cannot
activate collection. The guarantee applies to the supplied projected geometry at
that recorded precision, not the real-world currency of administrative boundaries
or the completeness of Neshan's database.

The complete Tabriz **County** example was checked offline: 311 distinct searches
(107 point circles at 3 km plus 204 polygon-fill circles at 2 km), with zero
uncovered area at planning precision. It is not a newly obtained Tabriz city
boundary. Example centres and its certificate are in `output/poi_coverage/`.

### Prepare the plan in admin (recommended)

After deploying the updated code, run the normal migration/frontend build and
restart the API and managed worker. Migration `0020_poi_admin_preparation` adds
only durable preparation status; it does not erase saved POI Details or old jobs.
No planning CLI commands or copied plan IDs are needed for the admin workflow.

In **گردآوری مکان‌ها**, pause collection and use **آماده‌سازی / ادامهٔ ساخت پوشش**.
The server reads the eight files already in `data/search area`, prepares 2 km
polygon coverage and 3 km point searches, and verifies complete coverage in a
separate process. An existing matching active plan is reused. Replacing a legacy
job preserves its history and all resolved places. Duplicate clicks cannot launch
concurrent preparations. If pending Details remain, finish them before preparing.

The HTTP request returns immediately after scheduling. Closing the browser does
not cancel preparation. Reports remain manual: press **تازه‌سازی گزارش** to see
its current stage and verified tile count. No five-second polling is introduced.
A service/server restart may interrupt the preparation process; once reported as
interrupted, the same preparation button resumes committed verified tiles. An
interrupted uncommitted source import restarts its transaction. Preparation uses
one geometry worker to limit its impact on the API server and never calls Neshan.

In **وضعیت سقف نتایج هر درخواست**, choose and save one of these modes:

- **نشان هنوز سقفی اعلام نکرده است**: collect without inventing a numeric cap.
  Geographic coverage is still verified, but result completeness is unverified;
  count-based dense-area subdivision is disabled.
- **نشان سقف عددی را تأیید کرده است**: enter the positive integer supplied by
  Neshan. Count-based adaptive subdivision is enabled.
- **نشان صریحاً بدون سقف بودن پاسخ را تأیید کرده است**: use only after that
  explicit provider confirmation. No numeric count-based subdivision is used.

A fresh plan still starts unconfigured and paused: selecting and saving a mode
never starts collection. Once geometric coverage is ready and worker/key/access
checks pass, use **شروع / ادامهٔ گردآوری خودکار**. Existing saved Details and the
verified search plan remain intact; no rebuild is needed to configure this mode.
No manually typed coordinates are required.

The CLI workflow below remains available for operators who prefer it.

### Build and deploy a replacement plan

Coverage dependencies require Python **3.11 or newer**. Stop the actual worker for
deployment and finish any live Details batch first. Restarting FastAPI alone does
not replace an already running worker. The production unit remains
`deploy/poi-worker.service` for `/opt/app/venv/bin/python`; its persisted pause state,
boot startup, and process-restart behavior are unchanged.

From `/opt/app`, with the production environment activated:

```bash
source venv/bin/activate
python -m pip install -r requirements.txt
alembic upgrade head
python -m scripts.plan_poi_coverage audit --radius 2000
python -m scripts.plan_poi_coverage create --categories mosque --radius 2000 --replace-active
```

Use the categories actually required by your project; multiple categories are
comma-separated. The final command returns a new plan ID. `--replace-active`
explicitly preserves the old job as `needs_review` history, creates a paused job,
and imports an immutable source snapshot. It refuses to replace a plan with an
in-flight request or unresolved in-memory Details batch. Old records are not edited
into a different geographic scope. Full source snapshots cannot be attached through
the legacy point-only job form, preventing accidental regression to 500 m anchor
searches.

Plan creation reports source-import batches and geometry preparation to stderr.
Its JSON plan ID is printed only after the database transaction commits. To save
the UUID directly, add `--plan-id-file output/poi-plan-id.txt` to `create`; that
option refuses an existing file, so an earlier plan is not silently overwritten.
`python -m scripts.plan_poi_coverage list` lists the last 20 committed plans
without compiling source inputs or sending provider requests. A Ctrl+C during
creation rolls back the uncommitted import and plan changes; creation must restart,
whereas the tile build below resumes its committed checkpoints.

Substitute the returned ID in these commands:

```bash
python -m scripts.plan_poi_coverage build --plan PLAN_ID --workers 2
python -m scripts.plan_poi_coverage export --plan PLAN_ID --output output/search-centres.geojson
```

The build can be long. `--workers` accepts 1–4 geometry threads; PostgreSQL writes
remain sequential and atomic per tile. An advisory lock prevents concurrent builds
of the same database. A stopped/interrupted build resumes with the **same command**;
verified tiles are not rebuilt and incomplete tile writes roll back. `--max-tiles N`
can bound a run without losing its checkpoint. There is no Neshan traffic during
source import, planning, verification, or export. No worker may execute this plan
until all tiles are verified. CSV export is available by using a `.csv` filename; `.csv.gz` and `.geojson.gz` produce compressed exports.

### Result limits and recursive subdivision

A new plan defaults to `result_limit=0` and an unconfigured result-limit mode.
Configure the mode in admin before starting. The explicit unknown mode permits
collection with result completeness labelled unverified and count-based
subdivision disabled. A numeric cap is not guessed. Zero alone continues to mean
unconfigured; it does not silently opt a plan into unknown or unlimited mode.

For a confirmed numeric maximum, the CLI remains available:

```bash
python -m scripts.plan_poi_coverage set-limit --plan PLAN_ID --result-limit CONFIRMED_LIMIT
```

`CONFIRMED_LIMIT` must be the actual positive integer supplied by Neshan, not an
example value or the largest count seen in a test. A positive value can also be
supplied with `create --result-limit ...`. The setting is immutable after this job
has dispatched requests. Unexpected continuation/pagination markers still halt
collection in every mode; unknown mode does not guess how to fetch another page.
The geometric coverage guarantee does not prove that a provider response contains
every matching place.

When a response reaches the configured limit, its valid new hashes go through
Details first. The affected target is covered again using verified smaller circles,
recursively, down to the configured minimum radius (default 50 m). Descendant links
and search geometry are durable. A parent contributes completed area only after
all descendants and their Details handoffs finish. Saturation at the minimum
radius pauses for review and never reports that area complete. Stable provider IDs
prevent overlapping/recursive searches from creating duplicate stored places.

### Execution, retries, and progress

After deployment, build the frontend, restart the existing API service under its
actual installed unit name, and start one managed worker:

```bash
python scripts/build_frontend.py
sudo install -m 0644 deploy/poi-worker.service /etc/systemd/system/poi-worker.service
sudo systemctl daemon-reload
sudo systemctl enable poi-worker.service
sudo systemctl restart poi-worker.service
sudo systemctl status poi-worker.service --no-pager
```

In admin, hard-refresh and click **شروع / ادامهٔ گردآوری خودکار** once the plan is
ready and its result-limit mode is saved. The new plan uses its own verified
centres; no manual coordinates or repeated pilot are needed. Empty/no-new-hash
responses advance automatically. New valid hashes are sent to Details before the
next Nearby call. Point, tile, and province transitions need no manual restart.
All calls/retries retain the persistent 30–60 second minimum cooldown and respect
longer provider deadlines.

Transient transport failures on new coverage jobs have bounded retries with
backoff (up to five attempts). In-memory Details hashes are preserved during those
retries. Persistent network failures, authorization/quota errors, unexpected
response schemas, and minimum-radius saturation pause for review. The managed
service remains running while collection is paused. A process crash still loses
unsaved Nearby hashes: recovery marks the interrupted segment uncertain and
requires explicit reviewed requeueing. Geographic progress and child searches are
retained; arbitrary exact restoration of volatile hashes is not claimed.

Reports are manual: opening the tab, completing an action, or pressing refresh
reads PostgreSQL. There is no browser polling. The admin shows polygon-area
completion (averaged across selected categories), root search counts, 3 km point
search completion, pending verification tiles, and provider-limit readiness. Area
contributions are disjoint, so overlapping circles and administrative layers do not
double-count progress. A capped parent remains incomplete until its subtree ends.
The worker code revision check prevents resuming an outdated loaded worker.

### Retention and access restrictions

Nearby output is transient. Neither payloads nor unresolved hashes enter place
placeholders, disk queues, caches, or request bodies stored in PostgreSQL. Only
successfully retrieved Details creates/updates a stored place; existing provider
identities and UUIDs are preserved across replacement plans. Durable coverage
geometry and associations come from the operator's geographic files, not Nearby.
Request parameters/counts/status/timestamps remain operational metadata.

The operator's Neshan instructions permit Details retention for internal use and
forbid map display. `/api/pois` and `/api/pois/counts` remain HTTP 403; internal
admin aggregates are not connected to maps. `NESHAN_COLLECTION_AUTHORIZED` remains
an operator acknowledgement, not independent verification of provider permissions.
No existing Nearby-retention safeguard or reviewed legacy-cleanup requirement is
removed. Backups, WAL, proxy logs, swap and dumps have separate retention; avoid
payload logging.

For read-only key/access diagnosis:

```bash
python -m backend.poi_diagnostics
```

HTTP 484 indicates an access/whitelist issue; a restart or larger radius cannot
correct the provider's permissions. Check the named endpoint and have Neshan verify
the key's scope and observed request source. Never share the private key.

Tests use an isolated `TEST_DATABASE_URL` and mocked providers. They cover holes,
islands, outside-centred circles, spacing, conservative geodesic radii, redundancy
removal, shared-boundary coverage, tile rollback/resumption, minimum-radius
saturation, Details-first subdivision, transport backoff, non-retention, and legacy
job preservation. No live Nearby/Details calls are used for verification.

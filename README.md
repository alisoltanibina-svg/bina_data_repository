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

## POI collection: NDA and retention restrictions

Neshan's account-specific support instruction supplied for this project permits
retaining only POI Details output for internal use, forbids retaining Search/Nearby
output, and forbids displaying the retained POI data on a map. The previous GeoJSON
endpoint is disabled (HTTP 403), including for administrators. The aggregate endpoint
is now admin-only at `/api/admin/poi/counts` for internal analysis; it must not be
wired into a map. The generic `/api/pois/counts` endpoint is also disabled.

Collection is disabled by default. `NESHAN_COLLECTION_AUTHORIZED=true` is an operator
acknowledgement that the required NDA has been completed and Neshan has authorized
this internal use; it is not automatic verification or a grant of rights. Confirm
the applicable agreement covers the intended acquisition scope, permanent identity
keys attached to successfully retrieved Details, internal aggregation, and the
30–60 second scheduled handoff. Do not enable collection before that confirmation.

Nearby bodies are used transiently to extract hashes in memory. They are not saved
in request history, place tables, caches, or durable task queues. Nearby names,
coordinates, icons, categories and addresses are discarded. Only successful Details
output creates or updates a place. Stable UUIDs and unique `(provider, provider_id)`
identities apply to those Details records. Category associations come exclusively
from Details output. Request timestamps/status, request origins and operational
counts are retained; no Nearby payload or pending hash is written to them.

The worker prioritizes every fresh hash in the current in-memory batch before any
further Nearby search. All calls, including retries, share the persisted 30–60 second
cooldown and respect longer provider deadlines. A response with zero new eligible
hashes (including an empty `nearestPoints` array, all missing hashes, or only resolved
identities) automatically pauses collection. This conservative local rule prevents
an unattended sequence of Nearby-only calls. It is not a provider-published request
limit. Review the origin/category and obtain guidance from Neshan on handling empty
rural/border cells before resuming; do not repeatedly resume to bypass this stop.
There is no fake Details call when a response contains no hash.

Pause finishes an already dispatched request. Successful Details is saved; Nearby
is still never saved. Pending hashes can remain in memory while the same worker is
paused. A worker restart loses that volatile batch, marks its geographic segment
uncertain, and pauses for review. Explicitly requeueing the segment reissues Nearby
and skips Details identities already saved. Exact restoration of pending Nearby
hashes across restarts is intentionally not supported under the non-retention rule.
Operating-system swap, process dumps and external proxy/HTTP logs must also be
reviewed; the service example disables core dumps. Avoid HTTP payload logging.

### Upgrade an existing installation

1. Pause collection and stop the actual collector process/service. FastAPI and the
   worker are independent; restarting FastAPI alone does not stop an old worker.
2. Deploy the new code and install requirements, then run `alembic upgrade head`.
   Migration `0016_poi_nonretention` adds operational counts and a constraint that
   rejects every new Nearby payload write. It pauses existing control state and
   deliberately leaves old payloads for the explicit reviewed cleanup command.
3. Review the cleanup dry run from the project root:

   ```bash
   python -m scripts.cleanup_nearby_storage
   ```

4. To apply that reviewed removal, with the worker stopped:

   ```bash
   python -m scripts.cleanup_nearby_storage --apply
   ```

   This irreversibly clears existing Nearby payloads, removes unresolved discovery
   records and obsolete durable hash tasks, and rebuilds category links using only
   saved Details output. It preserves confirmed Details records and UUIDs. It refuses
   to apply while a worker owns the collection lock and leaves collection paused.
   Database backups, WAL archives, exports and logs are not erased by this command;
   arrange their retention/remediation according to the NDA and your records policy.
5. Review the NDA/internal-use authorization and set `NESHAN_SERVICE_API_KEY` plus
   `NESHAN_COLLECTION_AUTHORIZED=true` only when authorized. Do not put the private
   service key in `NESHAN_MAP_API_KEY`, which is browser-visible.
6. Build the frontend (`python scripts/build_frontend.py`), restart the existing
   FastAPI service, and start one worker with `python -m backend.poi_worker` under a
   supervisor. `deploy/poi-worker.service.example` is an example, not an installed
   service. Confirm its paths and actual installed unit name.
7. Prepare and run a single-area pilot as described below. The nationwide grid stays
   paused; the empty searches already observed do not demonstrate POI access.

The admin panel shows explicit setup blockers, worker heartbeat, waiting/paused
state, request totals, empty-search counts and Details handoff counts. Request
history provides `result_count`, `hash_count`, and `queued_count` for Nearby; its raw
response is always null, even when historical payloads await cleanup. Polling the
status route only reads the application's database and does not call Neshan.

### Diagnose access failures before retrying

HTTP 484 is Neshan's `ApiWhiteListError` (key scope/whitelist authorization), not the
quota code 481. The collector now names the rejected service in its pause reason:
Nearby `/v1/nearby` or POI Details `/v1/point`. A restart does not verify or modify the
provider's restrictions. Do not repeatedly resume an unchanged access failure.

From the same activated environment/shell used to launch the worker, run:

```bash
python -m backend.poi_diagnostics
```

This is read-only. It makes no Nearby/Details calls, does not resume collection,
and does not read response payloads or place records. It reports configuration
source, secret-free SHA-256 key fingerprints, duplicate key assignments, accidental
browser-key reuse, proxy types, migrations, heartbeat and recent request metadata.
It suppresses exception text and database URLs to avoid leaking credentials. Newly
started workers record their key fingerprint in their existing worker identifier
and print that fingerprint at startup; an older worker's fingerprint is unknown.

For one optional unauthenticated public IPv4 lookup, use:

```bash
python -m backend.poi_diagnostics --egress-ip
```

That lookup contacts `api.ipify.org`, never Neshan, and sends no API key. It reports
the IP that observer sees. Destination-specific routing/proxies may differ, so
Neshan must confirm the source it sees on the rejected request.

If the report shows an environment override that differs from `.env`, update or
remove that override in the actual launcher. For an interactive Bash worker whose
reviewed configuration is `/opt/app/.env`, remove the displayed override names from
that shell, rerun diagnostics, and verify the effective/file fingerprints match.
For example, when the override name is `NESHAN_SERVICE_API_KEY`:

```bash
unset NESHAN_SERVICE_API_KEY
python -m backend.poi_diagnostics --egress-ip
```

Do not unset a key intentionally managed only through the environment; update it
there instead. A systemd/supervisor environment must be corrected in that launcher,
not only in an unrelated interactive shell. The diagnostic's `environment_key_names`
field identifies case variants without printing values.

Once the correct credential source is established, send Neshan the failing service,
HTTP code, request time and observed IP (never paste the secret key into a public
message). Have them verify the authorized server key, key restrictions and the
source they see. Only after they confirm the restriction is corrected, start one
worker with `python -m backend.poi_worker`. If a restart interrupted a volatile
Details batch, explicitly requeue that uncertain segment in the admin panel before
resuming. No new database migration is needed for these diagnostic changes.

### Run one controlled pilot before further geographic collection

Migration `0017_poi_pilot` pauses existing collection and defaults the worker to
single-area pilot mode. Stop the old worker before migration, deploy backend and
frontend together, run `alembic upgrade head` and `python scripts/build_frontend.py`,
and restart the existing FastAPI service and one collector worker. These actions do
not send a pilot request until an administrator explicitly prepares and resumes it.

In the admin collection tab, open **آزمایش تک‌ناحیه‌ای**. Enter a trusted latitude and
longitude around a known place in the current province (currently East Azerbaijan
for the existing plan), one of the job's selected categories, and a provider-approved
radius within the supported range. Coordinates are intentionally blank: no city,
mosque, village or provider coverage is guessed. Prefer a Neshan-approved reference
point when validating account access and the Nearby-to-Details handoff.

Press **آماده‌سازی آزمایش در حالت توقف**. This only creates one pilot segment with
your own search parameters; it makes no provider calls and leaves the job paused.
Verify the displayed origin, category and radius, then press Resume. The worker
searches only that segment, drains its new hashes through Details under the existing
cooldown, and automatically pauses after its last successful Details response. An
empty response, missing hashes, known resolved hashes or an error also stops the
pilot according to the existing policy. A completed Nearby search alone is not a
successful end-to-end pilot: verify at least one successful Details request and its
saved internal record. No stored place data is displayed on a map.

The original grid segments and their origins/history are preserved. Pilot segments
are excluded from geographic coverage totals, so a successful pilot does not mark a
province covered. A further Resume click cannot fall through into the nationwide
grid. Replacing a queued pilot creates a new segment and marks the previous one
cancelled, preserving its origin/history. A pilot cannot be switched while any live
Details batch is still being processed, or skip ahead to a different province.
Interrupted pilots still lose unsaved hashes, pause, and require reviewed requeueing.

The same paused preparation is available from the project root through the CLI;
replace the example variable names with the actual reviewed coordinates:

```bash
python -m backend.poi_worker pilot --latitude "$PILOT_LAT" --longitude "$PILOT_LON" --category mosque --radius 500
```

The source workflow below enables only buffers around supplied settlement points,
following a successful pilot with the same radius as the job. The old nationwide
grid is preserved and excluded from this new scope. A successful pilot is a
functional check, not provider authorization or proof of complete coverage.

### Integrate all four user-supplied search layers

The importer reads all four WGS84 layers without modifying them:

| File | Role |
| --- | --- |
| `area_to_search.geojson` | 2,792 rural/municipal/special-area boundaries |
| `area_to_search2.geojson` | 31 province boundaries and capital names |
| `area_to_search3.geojson` | 1,196 district boundaries; county polygons derived by union within each normalized province/county name |
| `area_to_search4.geojson` | 1,457 named settlement points used as search anchors |

The current audit yields **1,454 ready points and 3 quarantined points**. زیوه is
labelled اردبیل but spatially falls in آذربایجان غربی. درگهان and ابوموسی fall outside
the supplied administrative polygons. They remain in the catalogue with reasons,
but cannot be selected or automatically queried. Nine zero rural-area IDs receive
content-derived fallback identities. Settlement `id`, `OBJECTID`, and `center` are
not assumed unique or interpreted as documented settlement classifications.
Source properties and file SHA256 hashes are preserved for provenance.

These are user-supplied planning inputs, distinct from provider responses. One
circle around each point does **not** cover an entire city, every village, or all
land in Iran. The first file contains broad administrative areas, not reliable
built-up footprints. Its named centres are not geocoded or guessed. County unions
are explicitly labelled as derived from the supplied districts; they are not a
separate authoritative county layer. No population coverage is inferred.

Deploy backend/frontend and all four files together. Pause the collector and stop
its existing process before migration/import. Use the existing service/process
manager; do not assume a `poi-worker.service` unit exists. Then, from `/opt/app`
with its virtual environment active:

```bash
alembic upgrade head
python -m scripts.import_search_layers
python -m scripts.import_search_layers --apply
python scripts/build_frontend.py
```

The first import command is a dry run with no database/network access. `--apply`
imports an immutable snapshot, requires collection paused, and remains offline.
Repeated identical imports are idempotent. Migration `0018_poi_search_sources`
pauses collection, preserves historical grid requests, and adds source metadata.
Restart the existing FastAPI service after deployment and start **one** worker
using its existing process manager or `python -m backend.poi_worker`.

In **گردآوری مکان‌ها**:

1. Select the imported collection and click **اتصال مجموعه در حالت توقف**. This
   attaches the snapshot to the current active job; it does not resume collection.
2. Select a ready point in the current province. Capitals matched to the province
   layer's capital name appear first. For this dataset the first point is تبریز:
   latitude `38.07579266300007`, longitude `46.29811443300008`. This is a supplied
   city anchor, not a verified mosque position. Select the intended category and
   use the job's radius (500 m for the current production job).
3. Prepare the pilot and explicitly resume it. Verify at least one successful
   Details response. The pilot automatically pauses afterwards. Empty, duplicate-only,
   quota, or access responses still pause for review; no false Details request is
   sent when Nearby has no hashes.
4. After reviewing the successful pilot, click **آماده‌سازی برنامهٔ نقاط پس از آزمایش موفق**,
   then explicitly resume. This processes ready anchors in province order, one
   point/category circle each, capital first. An identical successful pilot is
   reused so its circle is not immediately queried again. Old grid segments are
   preserved and never dispatched by the attached-source plan.

Preparing/importing/attaching/enabling does not call Neshan. Existing key, NDA
configuration, cooldown, non-retention, access-error and restart safeguards apply.
No provider Nearby payload or unresolved hash is durably stored; hashes are handed
in memory to Details before proceeding. Details remain internal and unavailable
for map display. This change does not establish legal authorization; the supplied
Neshan restrictions still govern acquisition. Existing old empty results remain
in history and are not retried automatically by the new point plan.

### Audit the supplied area-to-search dataset before importing

`data/area_to_search.geojson` currently contains 2,792 valid Polygon/MultiPolygon
features, with province (`Pname`), county (`Cname`), area (`Rname`) and named centre
(`vcenter_na`) attributes. Its CRS84 coordinates are longitude/latitude. These are
mostly broad administrative regions, with a few explicitly named municipal/special
areas; they must not all be described as individual built-up village/city footprints.
There are no explicit centre-coordinate attributes. The median polygon is roughly
328 km2, and some exceed 20,000 km2. Names alone do not locate populated origins.

The file has 31 province labels matching the existing province catalogue. Nine
features share zero-valued `rCode`/`r_shenaseh` placeholders; those must never be
merged into one region. The offline audit proposes content-based fallback keys for
those records while preserving unique positive source IDs. Province membership is
checked at an internal geometry point, not asserted for every boundary vertex.

Inspect a reproducible audit without changing any collection state:

```bash
python -m scripts.audit_search_areas --radius 500
```

Optionally use `--check-point LATITUDE LONGITUDE` to identify containing search
regions, or `--output /path/to/audit.json` to write the report. No provider or database
access occurs, no search origins are generated, and neither input file is changed.
The search-count estimate is area-based, not an executed plan. Regridding these
large administrative regions alone still implies millions of searches per category
at a 500 m radius and does not solve the initial empty-origin problem.

This single-file audit does not import a live collection job. Use the four-layer
source importer above to prioritize the supplied point anchors.
Neshan's non-retention rules and the pause on empty/no-new-hash searches still apply.

### Geographic planning and internal analysis

The existing `data/iran.geojson` supplies 31 province polygons. The planner snapshots
and hashes these boundaries and visits stable province order, with overlapping
500–5000 metre circles covering every intersecting grid cell, including remote land
and border slivers. Planning a province commits atomically. Search coverage is never
labelled as proven completeness of real-world places. This geometric plan remains
subject to the authorized acquisition scope and the empty-search pause above.

Only Details coordinates are spatially matched using Shapely against versioned
polygons. Province/county names parsed from addresses remain separate, heuristic
fields. For attached search sources, county polygons are derived from supplied districts.
For legacy jobs without attached sources, import WGS84 county polygons when creating
a paused job, provide a GeoJSON FeatureCollection with `name`, `province_name`, and
preferably stable `code` properties:

```bash
python -m backend.poi_worker create --categories mosque,library --radius 2000 --counties /path/to/counties.geojson
```

Without either source, spatial county assignment stays null. Population density
indicators require corresponding population data. Initial jobs skip identities
already resolved through Details. Refresh jobs explicitly select `mode=refresh`
and a timezone-aware `refresh_before` cutoff to intentionally retrieve old Details.

The worker is independent of the browser and FastAPI, holds a dedicated PostgreSQL
session advisory lock, and emits a heartbeat every five seconds. Quota/access errors
pause collection, rate-limit responses extend backoff, and uncertain failures require
review. Multiple hashes with matching Details names and close Details coordinates
are flagged for internal review and never automatically merged.

Tests use an explicitly supplied disposable `TEST_DATABASE_URL`, isolated schemas,
and mocked provider responses; they make no Nearby or Details calls:

```bash
python -B -m unittest discover -s tests -p test_poi_collection.py -v
node --test tests/admin_poi_controls.test.cjs
```

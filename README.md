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

Each message accepts at most three files, each at most 5 MiB. The server checks
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

A background cleanup runs at startup and every ten minutes. It expires unused
staged uploads and removes orphan files after a one-hour grace period following
ticket/account deletion or interrupted file/DB writes. Attached files are retained
with the ticket. Back up the private directory together with the database, with
the same access controls as other account data. Restore both together; database
backups alone do not contain the images. Existing guest tracking behavior and
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
   Nginx may buffer request bodies to its own managed temporary storage; do not
   expose that directory either. The API independently limits JSON bodies to
   64 KiB, avatar multipart bodies to 6 MiB, and streamed ticket uploads to 5 MiB.
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

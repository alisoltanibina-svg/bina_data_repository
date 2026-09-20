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

اجرای API:

```bash
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

فرانت همان مسیرهای `/api/...` را صدا می‌زند. داده را جداگانه در Postgres بریزید؛ این مخزن اسکریپت کپی از SQLite ندارد.

اگر `DATABASE_URL` نباشد یا SQLite باشد، فرایند با خطای واضح متوقف می‌شود و به فایل لوکال برنمی‌گردد.

## امنیت

یوزر و پسورد فقط از محیط (`.env` یا متغیر سیستم). `.env` را در Git نگذارید. URL دیتابیس در لاگ چاپ نمی‌شود.

CORS پیش‌فرض فقط `https://app.rasadbina.ir` است (HTTPS). برای عوض کردن، `CORS_ORIGINS` را در `.env` بگذارید (چند مبدأ با ویرگول). فرانت روی همان دامنه همیشه `https://app.rasadbina.ir` را برای API می‌گیرد.

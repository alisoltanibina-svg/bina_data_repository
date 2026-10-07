"""Load process settings from the environment. Secrets never have a code default."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import SecretStr, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict

PROJECT_ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = PROJECT_ROOT / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=ENV_FILE,
        env_file_encoding="utf-8",
        extra="ignore",
    )

    database_url: SecretStr
    admin_phone: str = ""
    admin_password: SecretStr = SecretStr("")
    kavenegar_api_key: SecretStr = SecretStr("")
    kavenegar_sender: str = ""
    kavenegar_otp_message: str = "سامانه دیده‌بان فرهنگ\nکد ورود شما: {code}"
    kavenegar_otp_template: str = "binaappotp"
    otp_ttl_seconds: int = 180
    otp_max_attempts: int = 5
    otp_resend_seconds: int = 60
    captcha_enabled: bool = True
    captcha_hmac_secret: SecretStr = SecretStr("")
    captcha_ttl_seconds: int = 300
    captcha_max_per_phone: int = 10
    captcha_max_per_ip: int = 20
    captcha_cleanup_interval_seconds: int = 18_000

def _require_postgres_url(url: str) -> str:
    raw = (url or "").strip()
    if not raw:
        raise RuntimeError(
            "DATABASE_URL is empty. Copy .env.example to .env and set a PostgreSQL URL. "
            "SQLite is not used."
        )
    lowered = raw.lower()
    if lowered.startswith("sqlite"):
        raise RuntimeError(
            "SQLite is not supported. Set DATABASE_URL to a PostgreSQL URL "
            "(postgresql+psycopg://USER:PASSWORD@HOST:5432/DBNAME)."
        )
    if not (lowered.startswith("postgresql") or lowered.startswith("postgres")):
        raise RuntimeError(
            "DATABASE_URL must be a PostgreSQL URL "
            "(postgresql+psycopg://USER:PASSWORD@HOST:5432/DBNAME)."
        )
    return raw


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    try:
        settings = Settings()
    except ValidationError:
        raise RuntimeError(
            "DATABASE_URL is not set. Copy .env.example to .env and set a PostgreSQL URL. "
            "The app will not fall back to a local SQLite file."
        ) from None
    _require_postgres_url(settings.database_url.get_secret_value())
    if settings.captcha_enabled:
        if len(settings.captcha_hmac_secret.get_secret_value()) < 32:
            raise RuntimeError("CAPTCHA_HMAC_SECRET must contain at least 32 characters when CAPTCHA_ENABLED=1.")
        if not 120 <= settings.captcha_ttl_seconds <= 300:
            raise RuntimeError("CAPTCHA_TTL_SECONDS must be between 120 and 300.")
        if settings.captcha_max_per_phone < 1 or settings.captcha_max_per_ip < 1:
            raise RuntimeError("CAPTCHA rate limits must be positive.")
        if settings.captcha_cleanup_interval_seconds < 60:
            raise RuntimeError("CAPTCHA_CLEANUP_INTERVAL_SECONDS must be at least 60.")
    return settings

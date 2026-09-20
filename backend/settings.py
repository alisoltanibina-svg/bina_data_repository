"""Load process settings from the environment. Secrets never have a code default."""

from __future__ import annotations

from functools import lru_cache

from pydantic import SecretStr, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    database_url: SecretStr


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
    return settings

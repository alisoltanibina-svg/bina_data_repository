"""
File: backend/database.py
Purpose: PostgreSQL access for the dashboard (SQLAlchemy engine + session).

Connection comes only from DATABASE_URL. There is no SQLite fallback.
Table names and columns match the previous snapshot; `id` replaces SQLite rowid
so ORDER BY id keeps the same display order the API used with ORDER BY rowid.
"""

from __future__ import annotations

import threading
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from typing import Any, Callable, TypeVar

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from backend.settings import get_settings

NATIONAL_NAME = "کل کشور"

T = TypeVar("T")


def _engine() -> Engine:
    return create_engine(
        get_settings().database_url.get_secret_value(),
        pool_pre_ping=True,
        pool_size=5,
        max_overflow=10,
        future=True,
    )


engine: Engine = _engine()
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


class DbConn:
    """Thin wrapper so existing conn.execute(sql, params) call sites stay readable."""

    def __init__(self, conn: Connection) -> None:
        self._conn = conn

    def execute(self, sql: str, params: Mapping[str, Any] | Sequence[Any] | None = None):
        if isinstance(params, Sequence) and not isinstance(params, (str, bytes, Mapping)):
            raise TypeError("SQL parameters must be a dict of named binds")
        return self._conn.execute(text(sql), dict(params or {}))


@contextmanager
def db_session() -> Iterator[Session]:
    session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


@contextmanager
def db_connection() -> Iterator[DbConn]:
    with engine.connect() as conn:
        yield DbConn(conn)


def fetchall_dicts(
    conn: DbConn,
    sql: str,
    params: Mapping[str, Any] | None = None,
) -> list[dict]:
    return [dict(row._mapping) for row in conn.execute(sql, params)]


def fetchone_dict(
    conn: DbConn,
    sql: str,
    params: Mapping[str, Any] | None = None,
) -> dict | None:
    row = conn.execute(sql, params).fetchone()
    return dict(row._mapping) if row is not None else None


def check_connection() -> None:
    """Fail startup if Postgres is unreachable. Do not log the URL (it has a password)."""
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
    except SQLAlchemyError as exc:
        raise RuntimeError(
            "Could not connect to PostgreSQL. Check DATABASE_URL, network, and that "
            "the database exists. The connection URL is not printed because it contains a password."
        ) from exc


def dispose_engine() -> None:
    engine.dispose()


def normalize_fa_name(s) -> str:
    """Collapse Persian/Arabic letter variants and whitespace for name matching."""
    if not s:
        return ""
    return (
        str(s)
        .replace("ي", "ی")
        .replace("ى", "ی")
        .replace("ك", "ک")
        .replace("\u200c", "")
        .replace(" ", "")
        .strip()
    )


def resolve_catalog_name(raw: str | None, candidates) -> str | None:
    """Map an API/user name onto a catalog value. Exact match, then normalized equality."""
    text_value = (raw or "").strip()
    if not text_value:
        return None
    names = list(candidates or [])
    if text_value in names:
        return text_value
    wanted = normalize_fa_name(text_value)
    if not wanted:
        return None
    for name in names:
        if normalize_fa_name(name) == wanted:
            return name
    return None


def _canonical_province_map(conn: DbConn) -> dict[str, str]:
    names = [
        row[0]
        for row in conn.execute("SELECT DISTINCT province_name FROM trend_score")
        if row[0]
    ]
    return {normalize_fa_name(name): name for name in names}


def fetch_latest_province_pop(conn: DbConn) -> list[dict]:
    """Latest province_pop year per province, names aligned to trend_score spellings."""
    canon = _canonical_province_map(conn)
    rows = fetchall_dicts(
        conn,
        "SELECT province_name, province_pop, year FROM province_pop",
    )
    best: dict[str, dict] = {}
    for row in rows:
        raw_name = row["province_name"]
        name = canon.get(normalize_fa_name(raw_name))
        if not name:
            continue
        year = int(row["year"]) if row["year"] is not None else None
        prev = best.get(name)
        prev_year = prev["year"] if prev and prev["year"] is not None else None
        if prev is None or (year is not None and (prev_year is None or year > prev_year)):
            best[name] = {
                "province_name": name,
                "province_pop": row["province_pop"],
                "year": row["year"],
            }
    return list(best.values())


def list_dashboard_provinces(conn: DbConn) -> list[str]:
    """Non-national provinces in display order. Falls back to trend_score if needed."""
    try:
        rows = conn.execute(
            "SELECT province_name FROM provinces WHERE is_national = 0 ORDER BY province_name"
        ).fetchall()
        if rows:
            return [row[0] for row in rows]
    except SQLAlchemyError:
        pass
    return [
        row[0]
        for row in conn.execute(
            "SELECT DISTINCT province_name FROM trend_score "
            "WHERE province_name != :national ORDER BY province_name",
            {"national": NATIONAL_NAME},
        )
    ]


class ResultCache:
    """Thread-safe memo keyed by string. Process-lifetime (no SQLite file stamp)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._values: dict[str, object] = {}
        self._waiters: dict[str, threading.Event] = {}
        self._stamp = 1

    def fingerprint(self) -> tuple[int, int]:
        return (self._stamp, 0)

    def get(self, key: str, factory: Callable[[], T]) -> T:
        with self._lock:
            if key in self._values:
                return self._values[key]  # type: ignore[return-value]
            waiter = self._waiters.get(key)
            owner = waiter is None
            if owner:
                waiter = threading.Event()
                self._waiters[key] = waiter

        if not owner:
            waiter.wait(timeout=120)
            with self._lock:
                if key in self._values:
                    return self._values[key]  # type: ignore[return-value]
            return self.get(key, factory)

        try:
            value = factory()
        except Exception:
            with self._lock:
                self._waiters.pop(key, None)
            waiter.set()
            raise

        with self._lock:
            self._values[key] = value
            self._waiters.pop(key, None)
        waiter.set()
        return value


_CACHE = ResultCache()


def get_cache() -> ResultCache:
    return _CACHE

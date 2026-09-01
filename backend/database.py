"""
File: backend/database.py
Purpose: SQLite access and schema upkeep for the dashboard.

Storage layout
--------------
SQLite snapshot: data/bina_dashboard_database.db
  Dimensions : topics, kdescription, provinces, users
  Facts      : trend_score, province_pop, clusters, kindicator_score, pyramid
  Names are stored as Persian TEXT (denormalized). That matches how the UI
  looks up rows and avoids brittle integer-id rewrites of a published dataset.
Static GIS   : data/iran.geojson, data/Shahrestan.geojson
Media        : assets/images/*.webp named after topic/subtopic labels

Runtime
-------
  - WAL + busy timeout so concurrent readers do not stall each other
  - Unique indexes / primary keys on natural keys (idempotent at startup)
  - Request connections are query-only
  - Result cache with single-flight fills, dropped when the DB file changes
"""

from __future__ import annotations

import os
import sqlite3
import threading
from contextlib import contextmanager
from typing import Callable, Iterator, TypeVar

BASE_DIR = os.path.dirname(__file__)
DB_PATH = os.path.abspath(os.path.join(BASE_DIR, "..", "data", "bina_dashboard_database.db"))
NATIONAL_NAME = "کل کشور"
SCHEMA_USER_VERSION = 1

T = TypeVar("T")

# Unique indexes that also serve as lookup indexes. Extra non-unique indexes
# are listed separately when the query prefix is not the unique key.
_UNIQUE_INDEXES = (
    ("uq_topics_name", "topics", "topic_name"),
    ("uq_kdescription_indicator", "kdescription", "indicator_name"),
    ("uq_trend_score", "trend_score", "province_name, year, topic_name"),
    ("uq_province_pop", "province_pop", "province_name, year"),
    ("uq_kindicator_score", "kindicator_score", "indicator_name, year, province_name"),
    ("uq_clusters", "clusters", "province_name, topic_name, subtopic_name"),
)

_EXTRA_INDEXES = (
    ("kindicator_score", "CREATE INDEX IF NOT EXISTS idx_kindicator_province ON kindicator_score(province_name)"),
    ("kindicator_score", "CREATE INDEX IF NOT EXISTS idx_kindicator_topic_sub ON kindicator_score(topic_name, subtopic_name, province_name, indicator_name, year)"),
    ("kdescription", "CREATE INDEX IF NOT EXISTS idx_kdescription_topic_sub ON kdescription(topic_name, subtopic_name)"),
    ("trend_score", "CREATE INDEX IF NOT EXISTS idx_trend_score_topic_year ON trend_score(topic_name, year)"),
)

_LEGACY_INDEXES = (
    "idx_users_phone",
    "idx_topics_name",
    "idx_kdescription_indicator",
    "idx_ktopics_lookup",
    "idx_kindicator_name",
    "idx_kbubble_latest",
    "idx_map_scores_lookup",
    "idx_subtopic_scores_lookup",
    "idx_trend_score_lookup",
    "idx_pyramid_lookup",
    "idx_clusters_lookup",
    "uq_subtopics_name",
)


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


def get_db_connection(*, readonly: bool = False) -> sqlite3.Connection:
    """Open a sqlite3 connection with concurrency-friendly PRAGMAs."""
    if not os.path.isfile(DB_PATH):
        raise FileNotFoundError(f"Database not found: {DB_PATH}")

    conn = sqlite3.connect(
        DB_PATH,
        timeout=30.0,
        isolation_level=None,
        check_same_thread=True,
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 8000")
    conn.execute("PRAGMA temp_store = MEMORY")
    conn.execute("PRAGMA cache_size = -65536")
    conn.execute("PRAGMA mmap_size = 268435456")
    conn.execute("PRAGMA foreign_keys = ON")
    if readonly:
        conn.execute("PRAGMA query_only = ON")
    else:
        try:
            conn.execute("PRAGMA journal_mode = WAL")
            conn.execute("PRAGMA synchronous = NORMAL")
            conn.execute("PRAGMA wal_autocheckpoint = 1000")
        except sqlite3.Error:
            # Another connection may still hold DELETE-mode; serve without WAL.
            pass
    return conn


@contextmanager
def db_connection(*, readonly: bool = True) -> Iterator[sqlite3.Connection]:
    conn = get_db_connection(readonly=readonly)
    try:
        yield conn
    finally:
        conn.close()


def fetchall_dicts(conn: sqlite3.Connection, sql: str, params: tuple = ()) -> list[dict]:
    return [dict(row) for row in conn.execute(sql, params)]


def fetchone_dict(conn: sqlite3.Connection, sql: str, params: tuple = ()) -> dict | None:
    row = conn.execute(sql, params).fetchone()
    return dict(row) if row is not None else None


def table_exists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (name,),
    ).fetchone()
    return row is not None


def _table_columns(conn: sqlite3.Connection, name: str) -> list[str]:
    return [row[1] for row in conn.execute(f'PRAGMA table_info("{name}")')]


def _table_pk_columns(conn: sqlite3.Connection, name: str) -> list[str]:
    return [row[1] for row in conn.execute(f'PRAGMA table_info("{name}")') if row[5]]


def _index_names(conn: sqlite3.Connection) -> set[str]:
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name IS NOT NULL"
    ).fetchall()
    return {row[0] for row in rows}


def _rebuild_users(conn: sqlite3.Connection) -> None:
    """Give users a real PRIMARY KEY and UNIQUE phone. 4 rows; preserves ids."""
    pk = _table_pk_columns(conn, "users")
    if pk == ["id"]:
        return
    conn.execute("DROP TABLE IF EXISTS users__new")
    conn.execute(
        """
        CREATE TABLE users__new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            phone TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        INSERT INTO users__new (id, phone, created_at)
        SELECT id, phone, created_at FROM users ORDER BY rowid
        """
    )
    conn.execute("DROP TABLE users")
    conn.execute("ALTER TABLE users__new RENAME TO users")


def _canonical_province_map(conn: sqlite3.Connection) -> dict[str, str]:
    names = [
        row[0]
        for row in conn.execute("SELECT DISTINCT province_name FROM trend_score")
        if row[0]
    ]
    return {normalize_fa_name(name): name for name in names}


def _pyramid_needs_rebuild(conn: sqlite3.Connection) -> bool:
    cols = _table_columns(conn, "pyramid")
    if "Unnamed: 0" in cols:
        return True
    if _table_pk_columns(conn, "pyramid") != ["province_name", "year", "age"]:
        return True
    canon = _canonical_province_map(conn)
    for (name,) in conn.execute("SELECT DISTINCT province_name FROM pyramid"):
        mapped = canon.get(normalize_fa_name(name))
        if mapped and mapped != name:
            return True
    return False


def _rebuild_pyramid(conn: sqlite3.Connection) -> None:
    """Drop pandas leftover column, pin a composite PK, canonicalize province names."""
    if not _pyramid_needs_rebuild(conn):
        return
    canon = _canonical_province_map(conn)
    conn.execute("DROP TABLE IF EXISTS pyramid__new")
    conn.execute(
        """
        CREATE TABLE pyramid__new (
            province_name TEXT NOT NULL,
            year INTEGER NOT NULL,
            age INTEGER NOT NULL,
            male INTEGER NOT NULL DEFAULT 0,
            female INTEGER NOT NULL DEFAULT 0,
            urban INTEGER NOT NULL DEFAULT 0,
            rural INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (province_name, year, age)
        )
        """
    )
    rows = conn.execute(
        "SELECT province_name, year, age, male, female, urban, rural FROM pyramid ORDER BY rowid"
    ).fetchall()
    mapped = []
    for row in rows:
        name = canon.get(normalize_fa_name(row["province_name"]), row["province_name"])
        mapped.append(
            (
                name,
                row["year"],
                row["age"],
                row["male"] if row["male"] is not None else 0,
                row["female"] if row["female"] is not None else 0,
                row["urban"] if row["urban"] is not None else 0,
                row["rural"] if row["rural"] is not None else 0,
            )
        )
    conn.executemany(
        "INSERT OR REPLACE INTO pyramid__new "
        "(province_name, year, age, male, female, urban, rural) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        mapped,
    )
    conn.execute("DROP TABLE pyramid")
    conn.execute("ALTER TABLE pyramid__new RENAME TO pyramid")


def _ensure_provinces(conn: sqlite3.Connection) -> None:
    """Canonical province list (31 provinces + national), sourced from trend_score."""
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS provinces (
            province_name TEXT PRIMARY KEY,
            is_national INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    conn.execute("DELETE FROM provinces")
    conn.execute(
        """
        INSERT INTO provinces (province_name, is_national)
        SELECT DISTINCT province_name,
               CASE WHEN province_name = ? THEN 1 ELSE 0 END
        FROM trend_score
        WHERE province_name IS NOT NULL
        """,
        (NATIONAL_NAME,),
    )


def _ensure_indexes(conn: sqlite3.Connection) -> None:
    existing = _index_names(conn)
    for legacy in _LEGACY_INDEXES:
        if legacy in existing:
            conn.execute(f'DROP INDEX IF EXISTS "{legacy}"')
    for index_name, table, columns in _UNIQUE_INDEXES:
        if not table_exists(conn, table):
            continue
        conn.execute(
            f"CREATE UNIQUE INDEX IF NOT EXISTS {index_name} ON {table}({columns})"
        )
    pk_users = _table_pk_columns(conn, "users")
    if pk_users != ["id"]:
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS uq_users_phone ON users(phone)")
    for table, statement in _EXTRA_INDEXES:
        if not table_exists(conn, table):
            continue
        conn.execute(statement)


def ensure_runtime() -> None:
    """Apply schema upkeep, unique indexes, and planner stats. Safe to repeat."""
    with db_connection(readonly=False) as conn:
        _rebuild_users(conn)
        _rebuild_pyramid(conn)
        _ensure_provinces(conn)
        _ensure_indexes(conn)
        conn.execute(f"PRAGMA user_version = {SCHEMA_USER_VERSION}")
        conn.execute("ANALYZE")


def fetch_latest_province_pop(conn: sqlite3.Connection) -> list[dict]:
    """Latest province_pop year per province, names aligned to trend_score spellings."""
    if not table_exists(conn, "province_pop"):
        return []
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


def list_dashboard_provinces(conn: sqlite3.Connection) -> list[str]:
    """Non-national provinces in display order. Falls back to trend_score if needed."""
    try:
        rows = conn.execute(
            "SELECT province_name FROM provinces WHERE is_national = 0 ORDER BY province_name"
        ).fetchall()
        if rows:
            return [row[0] for row in rows]
    except sqlite3.Error:
        pass
    return [
        row[0]
        for row in conn.execute(
            "SELECT DISTINCT province_name FROM trend_score "
            "WHERE province_name != ? ORDER BY province_name",
            (NATIONAL_NAME,),
        )
    ]


class ResultCache:
    """Thread-safe memo keyed by string, dropped when the DB file mtime changes.

    Concurrent callers of the same missing key wait for a single factory run
    (single-flight) instead of stampeding SQLite.
    """

    def __init__(self, db_path: str) -> None:
        self._db_path = db_path
        self._lock = threading.Lock()
        self._values: dict[str, object] = {}
        self._waiters: dict[str, threading.Event] = {}
        self._stamp: tuple[float, ...] | None = None

    def _fingerprint(self) -> tuple[float, ...]:
        parts = []
        for suffix in ("", "-wal", "-shm"):
            try:
                parts.append(os.path.getmtime(self._db_path + suffix))
            except OSError:
                parts.append(0.0)
        return tuple(parts)

    def get(self, key: str, factory: Callable[[], T]) -> T:
        stamp = self._fingerprint()
        with self._lock:
            if self._stamp != stamp:
                self._values.clear()
                self._stamp = stamp
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


_CACHE = ResultCache(DB_PATH)


def get_cache() -> ResultCache:
    return _CACHE

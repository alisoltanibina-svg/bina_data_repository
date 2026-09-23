# File: backend/main.py
# Purpose: FastAPI backend that serves data for the dashboard frontend.
#   Provides endpoints for atlas initialization, explorer data, and bubble chart data.
# Notes: Atlas map snapshots come from the latest year of trend_score per topic.
#   Province population comes from province_pop (latest year per province).
#   Static files: HTML/JS/CSS, assets/, and data/*.geojson only — not source, git, or env.
#   Public deploy: DATABASE_URL (required PostgreSQL), CORS_ORIGINS, optional
#   THREAD_POOL_SIZE, and RATE_LIMIT_* (see backend/ratelimit.py).

from __future__ import annotations

import hashlib
import json
import os
import random
from contextlib import asynccontextmanager

from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.exception_handlers import http_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from pydantic import BaseModel, Field, field_validator
from fastapi.staticfiles import StaticFiles
from starlette.datastructures import MutableHeaders
from starlette.middleware.base import BaseHTTPMiddleware

from backend.database import (
    NATIONAL_NAME,
    check_connection,
    db_connection,
    dispose_engine,
    fetch_latest_province_pop,
    fetchall_dicts,
    fetchone_dict,
    get_cache,
    list_dashboard_provinces,
    normalize_fa_name,
    resolve_catalog_name,
)
from backend.membership import (
    SESSION_COOKIE,
    SESSION_DAYS,
    MembershipError,
    approve_registration,
    authenticate,
    avatar_download,
    clear_user_avatar,
    delete_session_token,
    delete_user_account,
    get_user_for_admin,
    list_registration_requests,
    list_users_for_admin,
    lookup_auth_gate,
    profile_from_session_token,
    register_after_otp,
    reject_registration,
    repair_approved_user_hashes,
    reset_password_after_otp,
    seed_admin,
    set_user_avatar,
    update_own_profile,
)
from backend.avatars import MAX_BYTES as AVATAR_MAX_BYTES
from backend.authlog import init_auth_log, mask_phone, write_auth_log
from backend.otp import send_otp, verify_otp
from backend.ratelimit import RateLimitMiddleware

JSON_MEDIA = "application/json"
# Data and assets change rarely. Browsers may reuse copies:
#   API JSON     — 1 hour fresh, then stale-while-revalidate for 7 days
#   HTML / JS / CSS / GeoJSON — always revalidate (small); 304 if unchanged
#   images / fonts            — 7 days, then SWR 30 days
# Hard refresh (Ctrl+F5) still bypasses this.
_API_CACHE_CONTROL = (
    "public, max-age=3600, stale-while-revalidate=604800, stale-if-error=86400"
)
_CACHE_HEADERS = {
    "Cache-Control": _API_CACHE_CONTROL,
    "Vary": "Accept-Encoding",
}

_HTML_CACHE_CONTROL = "public, max-age=0, must-revalidate"
_MEDIA_CACHE_CONTROL = "public, max-age=604800, stale-while-revalidate=2592000"

_MEDIA_SUFFIXES = {
    ".webp",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".svg",
    ".ico",
    ".woff",
    ".woff2",
    ".ttf",
    ".geojson",
}
_CODE_SUFFIXES = {".js", ".css"}
_HTML_SUFFIXES = {".html", ""}
_PUBLIC_ROOT_SUFFIXES = _HTML_SUFFIXES | _CODE_SUFFIXES
_PUBLIC_ASSET_SUFFIXES = _MEDIA_SUFFIXES | _CODE_SUFFIXES
_BLOCKED_SUFFIXES = {
    ".db",
    ".sqlite",
    ".sqlite3",
    ".py",
    ".pyc",
    ".pyo",
    ".pyd",
    ".bat",
    ".md",
    ".env",
}
_BLOCKED_DIR_PREFIXES = (
    "backend/",
    ".git/",
    ".vscode/",
    "__pycache__/",
)
_BLOCKED_NAMES = {
    ".gitignore",
    ".gitconfig",
    ".env",
    "uvicorn.bat",
}


def _normalized_static_path(path: str) -> str | None:
    """Return a slash-normalized relative path, or None if it escapes the root."""
    relative = (path or "").split("?", 1)[0].replace("\\", "/").lstrip("/")
    parts: list[str] = []
    for part in relative.split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            return None
        parts.append(part)
    return "/".join(parts)


def _static_is_public(path: str) -> bool:
    """Pages, assets, and GeoJSON only. Database, source, and git stay private."""
    relative = _normalized_static_path(path)
    if relative is None:
        return False
    if not relative:
        return True

    lower = relative.lower()
    name = Path(lower).name
    suffix = Path(lower).suffix

    if any(lower == prefix.rstrip("/") or lower.startswith(prefix) for prefix in _BLOCKED_DIR_PREFIXES):
        return False
    if name in _BLOCKED_NAMES or name.startswith("benchmark_"):
        return False
    if suffix in _BLOCKED_SUFFIXES:
        return False
    if ".db-" in lower or lower.endswith(("-wal", "-shm", "-journal")):
        return False

    if lower.startswith("data/"):
        return suffix == ".geojson"
    if lower.startswith("assets/"):
        return suffix in _PUBLIC_ASSET_SUFFIXES
    return "/" not in lower and suffix in _PUBLIC_ROOT_SUFFIXES


def _static_cache_control(path: str) -> str:
    relative = _normalized_static_path(path) or ""
    suffix = Path(relative).suffix.lower() if relative else ".html"
    if suffix in _HTML_SUFFIXES or suffix in _CODE_SUFFIXES or suffix == ".geojson":
        return _HTML_CACHE_CONTROL
    if suffix in _MEDIA_SUFFIXES:
        return _MEDIA_CACHE_CONTROL
    return _HTML_CACHE_CONTROL


class CachedStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope):
        relative = (path or "").replace("\\", "/").lstrip("/")
        if relative.startswith("api/"):
            write_auth_log(
                f"static-fallback path=/{relative} method={scope.get('method')}"
            )
        if not _static_is_public(path):
            return Response(status_code=404, content="Not Found")
        response = await super().get_response(path, scope)
        if response.status_code in (200, 304):
            response.headers["Cache-Control"] = _static_cache_control(path)
        return response


def _json_bytes(payload: object) -> bytes:
    return json.dumps(
        payload,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
    ).encode("utf-8")


def _name_key(*parts: str) -> str:
    return "::".join(normalize_fa_name(part) or (part or "").strip() for part in parts)


def _etag_for(key: str) -> str:
    mtime, size = get_cache().fingerprint()
    digest = hashlib.sha1(f"{mtime}:{size}:{key}".encode("utf-8")).hexdigest()
    return f'"{digest}"'


def _cached_json(key: str, factory, request: Request | None = None) -> Response:
    etag = _etag_for(key)
    if request is not None:
        incoming = request.headers.get("if-none-match", "").strip()
        if incoming == etag or incoming == f"W/{etag}":
            return Response(status_code=304, headers={"ETag": etag, **_CACHE_HEADERS})
    body = get_cache().get(key, lambda: _json_bytes(factory()))
    return Response(
        content=body,
        media_type=JSON_MEDIA,
        headers={"ETag": etag, **_CACHE_HEADERS},
    )


def _thread_pool_size() -> int:
    raw = os.environ.get("THREAD_POOL_SIZE", "256")
    try:
        size = int(raw)
    except ValueError:
        size = 256
    return max(32, min(size, 1024))


_PRODUCTION_ORIGIN = "https://app.rasadbina.ir"


def _cors_origins() -> list[str]:
    raw = os.environ.get("CORS_ORIGINS", "").strip()
    configured = [origin.strip().rstrip("/") for origin in raw.split(",") if origin.strip()]
    defaults = [
        _PRODUCTION_ORIGIN,
        "http://127.0.0.1:8000",
        "http://localhost:8000",
        "http://127.0.0.1:5500",
        "http://localhost:5500",
        "http://127.0.0.1:5501",
        "http://localhost:5501",
        "http://127.0.0.1",
        "http://localhost",
    ]
    seen: set[str] = set()
    origins: list[str] = []
    for origin in configured + defaults:
        if origin and origin not in seen:
            seen.add(origin)
            origins.append(origin)
    return origins


def _expand_thread_pool(size: int | None = None) -> None:
    try:
        import anyio

        anyio.to_thread.current_default_thread_limiter().total_tokens = size or _thread_pool_size()
    except Exception:
        pass


def _warm_cache() -> None:
    cache = get_cache()
    cache.get("topics-min", _compute_topics_min)
    cache.get("trend-provinces", _compute_trend_provinces)
    cache.get("indicator-names", _compute_indicator_names)
    cache.get("subtopic-names", _compute_subtopic_names)
    cache.get("init-atlas", lambda: _json_bytes(_compute_atlas()))
    cache.get("explorer-init", lambda: _json_bytes(_compute_explorer_init()))
    cache.get("race-indicators", _compute_race_indicator_names)


def bootstrap() -> None:
    init_auth_log()
    check_connection()
    repair_approved_user_hashes()
    seed_admin()
    _warm_cache()


@asynccontextmanager
async def lifespan(app: FastAPI):
    _expand_thread_pool()
    bootstrap()
    yield
    dispose_engine()


app = FastAPI(
    title="دیده‌بان فرهنگ",
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
    redirect_slashes=False,
)

_SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "Content-Security-Policy": (
        "default-src 'self'; "
        "base-uri 'self'; "
        "form-action 'self'; "
        "frame-ancestors 'none'; "
        "object-src 'none'; "
        "script-src 'self' 'unsafe-inline' https://unpkg.com https://cdn.jsdelivr.net; "
        "style-src 'self' 'unsafe-inline' https://unpkg.com; "
        "img-src 'self' data: blob:; "
        "font-src 'self'; "
        "connect-src 'self' https://app.rasadbina.ir http://127.0.0.1:8000 http://localhost:8000"
    ),
}


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        for name, value in _SECURITY_HEADERS.items():
            response.headers.setdefault(name, value)
        proto = (request.headers.get("x-forwarded-proto") or request.url.scheme or "").split(",")[0].strip()
        if proto == "https":
            response.headers.setdefault(
                "Strict-Transport-Security",
                "max-age=15552000; includeSubDomains",
            )
        return response


class AuthJsonContentTypeMiddleware:
    """Log /api/auth hits. Restore POST if a proxy turned it into GET but left a body."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and (scope.get("path") or "").startswith("/api/auth"):
            headers = MutableHeaders(scope=scope)
            qs = (scope.get("query_string") or b"").decode("latin-1")
            method = scope.get("method") or ""
            cl = headers.get("content-length") or "0"
            write_auth_log(
                "http "
                f"method={method} path={scope.get('path')} qs={qs!s} "
                f"origin={headers.get('origin')!s} "
                f"xfp={headers.get('x-forwarded-proto')!s} "
                f"cl={cl} content_type={headers.get('content-type')!s}"
            )
            if method in {"GET", "HEAD"} and cl.isdigit() and int(cl) > 0:
                write_auth_log(f"rewrite GET->POST path={scope.get('path')} cl={cl}")
                scope = dict(scope)
                scope["method"] = "POST"
                method = "POST"
            if method in {"POST", "PUT", "PATCH"}:
                ctype = (headers.get("content-type") or "").split(";")[0].strip().lower()
                if ctype not in {"application/json", "application/x-www-form-urlencoded", "multipart/form-data"}:
                    if ctype != "application/x-www-form-urlencoded":
                        headers["content-type"] = "application/json"
        await self.app(scope, receive, send)


def _jsonable_errors(errors):
    """RequestValidationError.input can be raw bytes; JSONResponse cannot encode that."""

    def convert(value):
        if isinstance(value, (bytes, bytearray)):
            return value.decode("utf-8", "replace")
        if isinstance(value, dict):
            return {str(key): convert(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [convert(item) for item in value]
        if isinstance(value, (str, int, float, bool)) or value is None:
            return value
        return str(value)

    return convert(errors)


# Innermost first: 429s still pass through CORS, gzip, and security headers.
app.add_middleware(AuthJsonContentTypeMiddleware)
app.add_middleware(RateLimitMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins(),
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=[
        "Accept",
        "Content-Type",
        "If-None-Match",
        "Authorization",
        "X-Requested-With",
        "Cache-Control",
        "Pragma",
    ],
    expose_headers=[
        "ETag",
        "Retry-After",
        "RateLimit",
        "RateLimit-Policy",
        "X-RateLimit-Limit",
        "X-RateLimit-Remaining",
        "X-RateLimit-Reset",
    ],
)

app.add_middleware(GZipMiddleware, minimum_size=500)
app.add_middleware(SecurityHeadersMiddleware)


@app.exception_handler(RequestValidationError)
async def auth_validation_handler(request: Request, exc: RequestValidationError):
    errors = _jsonable_errors(exc.errors())
    if request.url.path.startswith("/api/auth"):
        write_auth_log(
            f"validation path={request.url.path} method={request.method} "
            f"content_type={request.headers.get('content-type')!s} errors={errors!s}"
        )
    return JSONResponse(status_code=422, content={"detail": errors}, headers=_AUTH_NO_STORE)


@app.exception_handler(Exception)
async def auth_unhandled_handler(request: Request, exc: Exception):
    if isinstance(exc, HTTPException):
        return await http_exception_handler(request, exc)
    if request.url.path.startswith("/api/auth"):
        write_auth_log(f"unhandled path={request.url.path} method={request.method}", exc)
        return JSONResponse(
            status_code=500,
            content={"detail": {"code": "server", "message": "خطای داخلی سرور."}},
            headers=_AUTH_NO_STORE,
        )
    raise exc


def _round_field(rows: list[dict], field: str) -> None:
    for row in rows:
        if row.get(field) is not None:
            row[field] = round(float(row[field]), 2)


def _compute_atlas() -> dict:
    """Latest-year scores for map coloring, plus topics and population. History is on demand."""
    with db_connection() as conn:
        topics = fetchall_dicts(
            conn,
            "SELECT topic_name, topic_description, lower_color, upper_color, master_color "
            "FROM topics ORDER BY id",
        )
        trend_score = fetchall_dicts(
            conn,
            "SELECT t.province_name, t.year, t.topic_name, t.index_score, t.province_rank "
            "FROM trend_score t "
            "INNER JOIN ("
            "    SELECT topic_name, MAX(year) AS year FROM trend_score GROUP BY topic_name"
            ") latest ON t.topic_name = latest.topic_name AND t.year = latest.year "
            "WHERE t.province_name != :national "
            "ORDER BY t.topic_name, t.province_name",
            {"national": NATIONAL_NAME},
        )
        province_pop = fetch_latest_province_pop(conn)
    _round_field(trend_score, "index_score")
    return {
        "topics": topics,
        "trend_score": trend_score,
        "province_pop": province_pop,
    }


@app.get("/api/init-atlas")
def get_atlas_data(request: Request):
    """Atlas bootstrap: topics, latest map scores, latest population."""
    return _cached_json("init-atlas", _compute_atlas, request)


def _compute_atlas_trend(province: str, topic: str) -> dict:
    provinces = get_cache().get("trend-provinces", _compute_trend_provinces)
    topic_canon = resolve_catalog_name(topic, _topic_names()) or (topic or "").strip()
    prov_canon = resolve_catalog_name(province, provinces) or (province or "").strip()
    if not topic_canon or not prov_canon:
        return {"province_name": prov_canon, "topic_name": topic_canon, "series": []}
    with db_connection() as conn:
        series = fetchall_dicts(
            conn,
            "SELECT year, index_score FROM trend_score "
            "WHERE province_name = :province AND topic_name = :topic ORDER BY year",
            {"province": prov_canon, "topic": topic_canon},
        )
    _round_field(series, "index_score")
    return {"province_name": prov_canon, "topic_name": topic_canon, "series": series}


@app.get("/api/atlas/trend")
def get_atlas_trend(province: str, topic: str, request: Request):
    """Full year series for one province and topic (right-panel trend chart)."""
    return _cached_json(
        f"atlas-trend::{_name_key(province, topic)}",
        lambda: _compute_atlas_trend(province, topic),
        request,
    )


def _compute_explorer_init() -> dict:
    with db_connection() as conn:
        colors = fetchall_dicts(
            conn,
            "SELECT topic_name, upper_color, lower_color, master_color FROM topics ORDER BY id",
        )
        kdesc_rows = fetchall_dicts(
            conn,
            "SELECT topic_name, subtopic_name, indicator_name FROM kdescription ORDER BY id",
        )
        provinces = list_dashboard_provinces(conn)

    hierarchy: dict[str, dict[str, list[str]]] = {}
    for row in kdesc_rows:
        t, s, i = row["topic_name"], row["subtopic_name"], row["indicator_name"]
        if t not in hierarchy:
            hierarchy[t] = {}
        if s not in hierarchy[t]:
            hierarchy[t][s] = []
        if i not in hierarchy[t][s]:
            hierarchy[t][s].append(i)

    return {"colors": colors, "hierarchy": hierarchy, "provinces": provinces}


@app.get("/api/explorer/init")
def get_explorer_init(request: Request):
    """Builds the hierarchy and province list on the server."""
    return _cached_json("explorer-init", _compute_explorer_init, request)


def _compute_indicator_names() -> list[str]:
    with db_connection() as conn:
        return [
            row[0]
            for row in conn.execute(
                "SELECT DISTINCT indicator_name FROM kdescription ORDER BY indicator_name"
            )
        ]


def _compute_explorer_indicator(name: str) -> dict:
    names = get_cache().get("indicator-names", _compute_indicator_names)
    canon = resolve_catalog_name(name, names) or (name or "").strip()
    with db_connection() as conn:
        desc_row = fetchone_dict(
            conn,
            "SELECT description, source_name FROM kdescription "
            "WHERE indicator_name = :name ORDER BY id",
            {"name": canon},
        )
        scores = fetchall_dicts(
            conn,
            "SELECT province_name, year, value FROM kindicator_score "
            "WHERE indicator_name = :name ORDER BY id",
            {"name": canon},
        )
        latest_year_row = conn.execute(
            "SELECT MAX(year) AS y FROM kindicator_score WHERE indicator_name = :name",
            {"name": canon},
        ).fetchone()
        latest_year = latest_year_row[0] if latest_year_row else None
        latest_scores = []
        if latest_year is not None:
            latest_scores = fetchall_dicts(
                conn,
                "SELECT province_name, year, value FROM kindicator_score "
                "WHERE indicator_name = :name AND year = :year AND province_name != :national "
                "ORDER BY province_name",
                {"name": canon, "year": latest_year, "national": NATIONAL_NAME},
            )
    return {
        "description": desc_row,
        "scores": scores,
        "latest_year": latest_year,
        "latest_scores": latest_scores,
    }


@app.get("/api/explorer/indicator")
def get_explorer_indicator(name: str, request: Request):
    """Fetches data only for the specifically clicked indicator."""
    return _cached_json(
        f"explorer-indicator::{_name_key(name)}",
        lambda: _compute_explorer_indicator(name),
        request,
    )


def _compute_subtopic_names() -> list[str]:
    with db_connection() as conn:
        return [
            row[0]
            for row in conn.execute(
                "SELECT DISTINCT subtopic_name FROM kdescription ORDER BY subtopic_name"
            )
        ]


def _topic_names() -> list[str]:
    return [row["topic_name"] for row in get_cache().get("topics-min", _compute_topics_min)]


def _compute_bubble_init(topic: str, subtopic: str) -> dict:
    topic_canon = resolve_catalog_name(topic, _topic_names()) or (topic or "").strip()
    sub_canon = resolve_catalog_name(
        subtopic, get_cache().get("subtopic-names", _compute_subtopic_names)
    ) or (subtopic or "").strip()
    with db_connection() as conn:
        color_row = fetchone_dict(
            conn,
            "SELECT upper_color, lower_color, master_color FROM topics WHERE topic_name = :topic",
            {"topic": topic_canon},
        )
        scores = fetchall_dicts(
            conn,
            "SELECT k.province_name, k.indicator_name, k.year, k.standard_value "
            "FROM kindicator_score k "
            "WHERE k.topic_name = :topic AND k.subtopic_name = :subtopic AND k.year = ("
            "    SELECT MAX(k2.year) FROM kindicator_score k2 "
            "    WHERE k2.province_name = k.province_name "
            "      AND k2.indicator_name = k.indicator_name "
            "      AND k2.topic_name = k.topic_name "
            "      AND k2.subtopic_name = k.subtopic_name"
            ")",
            {"topic": topic_canon, "subtopic": sub_canon},
        )

    provinces = sorted({s["province_name"] for s in scores})
    indicators = sorted({s["indicator_name"] for s in scores})
    return {
        "colors": color_row,
        "provinces": provinces,
        "indicators": indicators,
        "scores": scores,
    }


@app.get("/api/bubble/init")
def get_bubble_init(request: Request, topic: str = "", subtopic: str = ""):
    """Fetches filtered data specifically for the dynamic bubble chart."""
    return _cached_json(
        f"bubble-init::{_name_key(topic, subtopic)}",
        lambda: _compute_bubble_init(topic, subtopic),
        request,
    )


def _compute_topics_min() -> list[dict]:
    with db_connection() as conn:
        return fetchall_dicts(
            conn,
            "SELECT topic_name, master_color FROM topics ORDER BY id",
        )


def _compute_trend_provinces() -> list[str]:
    with db_connection() as conn:
        return list_dashboard_provinces(conn)


def _compute_race_indicator_names() -> list[str]:
    """Indicators with a long enough non-national time series for the curtain race."""
    with db_connection() as conn:
        return [
            row[0]
            for row in conn.execute(
                "SELECT indicator_name FROM kindicator_score "
                "WHERE indicator_name IS NOT NULL AND TRIM(indicator_name) != '' "
                "AND province_name != :national AND value IS NOT NULL AND year IS NOT NULL "
                "GROUP BY indicator_name "
                "HAVING COUNT(DISTINCT year) > 15",
                {"national": NATIONAL_NAME},
            )
        ]


def _pack_curtain_race(conn, candidate: str) -> dict | None:
    years = [
        int(row[0])
        for row in conn.execute(
            "SELECT DISTINCT year FROM kindicator_score "
            "WHERE indicator_name = :indicator AND year IS NOT NULL ORDER BY year",
            {"indicator": candidate},
        )
    ]
    if len(years) <= 15:
        return None
    rows = fetchall_dicts(
        conn,
        "SELECT province_name, year, value FROM kindicator_score "
        "WHERE indicator_name = :indicator AND province_name != :national AND value IS NOT NULL "
        "ORDER BY year, province_name",
        {"indicator": candidate, "national": NATIONAL_NAME},
    )
    year_index = {year: idx for idx, year in enumerate(years)}
    series: dict[str, list] = {}
    for row in rows:
        prov = row.get("province_name")
        year = row.get("year")
        if not prov or year is None or year not in year_index:
            continue
        if prov not in series:
            series[prov] = [None] * len(years)
        try:
            series[prov][year_index[int(year)]] = round(float(row["value"]), 2)
        except (TypeError, ValueError):
            continue
    provinces = [name for name, values in series.items() if any(v is not None for v in values)]
    provinces.sort()
    if not provinces:
        return None
    topic_row = fetchone_dict(
        conn,
        "SELECT topic_name, subtopic_name FROM kindicator_score "
        "WHERE indicator_name = :indicator LIMIT 1",
        {"indicator": candidate},
    ) or {}
    colors = None
    if topic_row.get("topic_name"):
        colors = fetchone_dict(
            conn,
            "SELECT master_color, lower_color, upper_color FROM topics WHERE topic_name = :topic",
            {"topic": topic_row["topic_name"]},
        )
    return {
        "indicator_name": candidate,
        "topic_name": topic_row.get("topic_name") or "",
        "subtopic_name": topic_row.get("subtopic_name") or "",
        "master_color": (colors or {}).get("master_color"),
        "lower_color": (colors or {}).get("lower_color"),
        "upper_color": (colors or {}).get("upper_color"),
        "years": years,
        "provinces": provinces,
        "series": {name: series[name] for name in provinces},
    }


def _compute_curtain_race() -> dict:
    """Pick a random long-series indicator and pack the race payload."""
    names = get_cache().get("race-indicators", _compute_race_indicator_names)
    if not names:
        raise HTTPException(status_code=404, detail="شاخصی یافت نشد")
    order = list(names)
    random.shuffle(order)
    with db_connection() as conn:
        for candidate in order[:8]:
            packed = _pack_curtain_race(conn, candidate)
            if packed:
                return packed
    raise HTTPException(status_code=404, detail="شاخص معتبری یافت نشد")


@app.get("/api/curtain/race")
def get_curtain_race():
    """Random valid indicator series for the curtain racing-bar motion graphic."""
    return Response(
        content=_json_bytes(_compute_curtain_race()),
        media_type=JSON_MEDIA,
        headers={"Cache-Control": "no-store", "Vary": "Accept-Encoding"},
    )


class LoginBody(BaseModel):
    phone: str = Field(min_length=1)
    password: str = Field(min_length=1)


_AUTH_NO_STORE = {"Cache-Control": "no-store", "Vary": "Accept-Encoding"}
_LOGIN_FAIL = "شماره یا رمز نادرست است."


def _cookie_secure(request: Request) -> bool:
    host = (
        (request.headers.get("x-forwarded-host") or request.url.hostname or "")
        .split(",")[0]
        .strip()
        .split(":")[0]
        .lower()
    )
    if host in {"127.0.0.1", "localhost"}:
        return False
    proto = (request.headers.get("x-forwarded-proto") or request.url.scheme or "").split(",")[0].strip()
    return proto == "https" or bool(host)


def _set_session_cookie(response: JSONResponse, token: str, request: Request) -> None:
    response.set_cookie(
        key=SESSION_COOKIE,
        value=token,
        max_age=SESSION_DAYS * 24 * 3600,
        httponly=True,
        secure=_cookie_secure(request),
        samesite="lax",
        path="/",
    )


class GateBody(BaseModel):
    phone: str = Field(min_length=1, max_length=32)

    @field_validator("phone", mode="before")
    @classmethod
    def _coerce_phone(cls, value):
        from backend.membership import normalize_phone

        if value is None:
            return ""
        if isinstance(value, bool):
            return str(value)
        if isinstance(value, (int, float)):
            digits = str(int(value))
            if len(digits) == 10 and digits.startswith("9"):
                digits = "0" + digits
            return normalize_phone(digits)
        return normalize_phone(str(value))


def _gate_status_response(phone: str, request: Request) -> JSONResponse:
    write_auth_log(
        "gate start "
        f"phone={mask_phone(phone)} origin={request.headers.get('origin')!s} "
        f"host={request.headers.get('host')!s} "
        f"content_type={request.headers.get('content-type')!s} "
        f"method={request.method}"
    )
    try:
        status = lookup_auth_gate(phone)
    except MembershipError as err:
        write_auth_log(f"gate membership code={err.code} message={err.message}")
        _raise_membership(err)
    except Exception as err:
        write_auth_log("gate crash", err)
        raise
    write_auth_log(f"gate ok status={status}")
    return JSONResponse(content={"status": status}, headers=_AUTH_NO_STORE)


def auth_gate(body: GateBody, request: Request):
    return _gate_status_response(body.phone, request)


def auth_gate_get(request: Request, phone: str = ""):
    if not phone:
        write_auth_log(f"gate GET without phone origin={request.headers.get('origin')!s}")
        raise HTTPException(
            status_code=405,
            detail={"code": "method", "message": "ارسال شماره باید با POST باشد."},
        )
    return _gate_status_response(phone, request)


app.add_api_route("/api/auth/gate", auth_gate, methods=["POST"])
app.add_api_route("/api/auth/gate/", auth_gate, methods=["POST"])
app.add_api_route("/api/auth/gate", auth_gate_get, methods=["GET", "HEAD"])
app.add_api_route("/api/auth/gate/", auth_gate_get, methods=["GET", "HEAD"])


def _parse_login_payload(raw: bytes, request: Request) -> tuple[str, str]:
    from urllib.parse import parse_qs

    from backend.membership import normalize_phone

    phone = request.query_params.get("phone") or ""
    password = request.query_params.get("password") or ""
    if raw:
        text = raw.decode("utf-8", "replace").strip()
        if text.startswith("{"):
            data = json.loads(text)
            phone = str(data.get("phone") or phone)
            password = str(data.get("password") or password)
        else:
            parsed = parse_qs(text, keep_blank_values=True)
            phone = (parsed.get("phone") or [phone])[0]
            password = (parsed.get("password") or [password])[0]
    return normalize_phone(phone), password


async def auth_login(request: Request):
    raw = await request.body()
    write_auth_log(
        "login hit "
        f"method={request.method} xfp={request.headers.get('x-forwarded-proto')!s} "
        f"cl={request.headers.get('content-length')!s} body_len={len(raw)} "
        f"ct={request.headers.get('content-type')!s} "
        f"accept={request.headers.get('accept')!s}"
    )
    try:
        phone, password = _parse_login_payload(raw, request)
    except Exception as err:
        write_auth_log("login parse", err)
        raise HTTPException(status_code=400, detail=_LOGIN_FAIL) from err
    if not phone or not password:
        write_auth_log(f"login rejected method={request.method} body_len={len(raw)}")
        raise HTTPException(
            status_code=405 if request.method in {"GET", "HEAD"} else 400,
            detail={"code": "method", "message": "ورود باید با POST باشد."},
        )
    result = authenticate(phone, password)
    if result is None:
        write_auth_log("login fail")
        raise HTTPException(status_code=401, detail=_LOGIN_FAIL)
    write_auth_log(f"login ok phone={mask_phone(phone)}")
    accept = (request.headers.get("accept") or "").lower()
    if "text/html" in accept and "application/json" not in accept:
        response = RedirectResponse("/", status_code=303, headers=_AUTH_NO_STORE)
    else:
        response = JSONResponse(content=result["profile"], headers=_AUTH_NO_STORE)
    _set_session_cookie(response, result["token"], request)
    return response


app.add_api_route("/api/auth/login", auth_login, methods=["GET", "HEAD", "POST", "PUT", "PATCH"])
app.add_api_route("/api/auth/login/", auth_login, methods=["GET", "HEAD", "POST", "PUT", "PATCH"])


@app.post("/api/auth/logout")
@app.post("/api/auth/logout/")
def auth_logout(request: Request):
    delete_session_token(request.cookies.get(SESSION_COOKIE) or "")
    response = JSONResponse(content={"ok": True}, headers=_AUTH_NO_STORE)
    response.delete_cookie(
        SESSION_COOKIE,
        path="/",
        secure=_cookie_secure(request),
        samesite="lax",
    )
    return response


@app.get("/api/auth/me")
def auth_me(request: Request):
    profile = profile_from_session_token(request.cookies.get(SESSION_COOKIE) or "")
    if profile is None:
        raise HTTPException(status_code=401, detail="وارد نشده‌اید.")
    return JSONResponse(content=profile, headers=_AUTH_NO_STORE)


class RegisterBody(BaseModel):
    first_name: str = Field(min_length=1, max_length=80)
    last_name: str = Field(min_length=1, max_length=80)
    phone: str = Field(min_length=1, max_length=16)
    role_title: str = Field(min_length=1, max_length=80)
    organization: str = ""
    password: str = Field(min_length=8, max_length=200)


class RejectBody(BaseModel):
    note: str = ""


class ProfileBody(BaseModel):
    first_name: str = Field(min_length=1, max_length=80)
    last_name: str = Field(min_length=1, max_length=80)
    role_title: str = ""
    organization: str = ""
    birth_date: str = ""
    email: str = ""
    address: str = ""


_MEMBERSHIP_HTTP = {
    "first_name": 400,
    "last_name": 400,
    "phone": 400,
    "role": 400,
    "password": 400,
    "avatar": 400,
    "email": 400,
    "address": 400,
    "birth_date": 400,
    "otp": 400,
    "cooldown": 429,
    "rejected": 403,
    "pending": 409,
    "exists": 409,
    "not-found": 404,
    "not-pending": 409,
    "forbidden": 403,
    "server": 500,
}


def _raise_membership(err: MembershipError) -> None:
    raise HTTPException(
        status_code=_MEMBERSHIP_HTTP.get(err.code, 400),
        detail={"code": err.code, "message": err.message},
    )


def _require_user(request: Request) -> dict:
    profile = profile_from_session_token(request.cookies.get(SESSION_COOKIE) or "")
    if profile is None:
        raise HTTPException(status_code=401, detail="وارد نشده‌اید.")
    return profile


def _require_admin(request: Request) -> dict:
    profile = _require_user(request)
    if not profile.get("is_admin"):
        raise HTTPException(status_code=403, detail="این بخش فقط برای مدیر است.")
    return profile


class OtpSendBody(BaseModel):
    phone: str = Field(min_length=1, max_length=16)
    purpose: str = Field(min_length=1, max_length=16)


class OtpVerifyBody(BaseModel):
    phone: str = Field(min_length=1, max_length=16)
    purpose: str = Field(min_length=1, max_length=16)
    code: str = Field(min_length=4, max_length=8)


class PasswordResetBody(BaseModel):
    phone: str = Field(min_length=1, max_length=16)
    password: str = Field(min_length=8, max_length=200)


@app.post("/api/auth/otp/send")
@app.post("/api/auth/otp/send/")
def auth_otp_send(body: OtpSendBody):
    try:
        payload = send_otp(body.phone, body.purpose)
    except MembershipError as err:
        _raise_membership(err)
    return JSONResponse(content=payload, headers=_AUTH_NO_STORE)


@app.post("/api/auth/otp/verify")
@app.post("/api/auth/otp/verify/")
def auth_otp_verify(body: OtpVerifyBody):
    try:
        payload = verify_otp(body.phone, body.purpose, body.code)
    except MembershipError as err:
        _raise_membership(err)
    return JSONResponse(content=payload, headers=_AUTH_NO_STORE)


@app.post("/api/auth/register")
@app.post("/api/auth/register/")
def auth_register(body: RegisterBody):
    try:
        row = register_after_otp(
            body.first_name,
            body.last_name,
            body.phone,
            body.role_title,
            body.organization,
            body.password,
        )
    except MembershipError as err:
        _raise_membership(err)
    return JSONResponse(content=row, status_code=201, headers=_AUTH_NO_STORE)


@app.post("/api/auth/password/reset")
@app.post("/api/auth/password/reset/")
def auth_password_reset(body: PasswordResetBody, request: Request):
    try:
        result = reset_password_after_otp(body.phone, body.password)
    except MembershipError as err:
        _raise_membership(err)
    response = JSONResponse(content=result["profile"], headers=_AUTH_NO_STORE)
    _set_session_cookie(response, result["token"], request)
    return response


@app.get("/api/admin/requests")
def admin_list_requests(request: Request):
    _require_admin(request)
    return JSONResponse(content=list_registration_requests(), headers=_AUTH_NO_STORE)


@app.post("/api/admin/requests/{request_id}/approve")
def admin_approve_request(request_id: int, request: Request):
    admin = _require_admin(request)
    try:
        row = approve_registration(request_id, admin["id"])
    except MembershipError as err:
        _raise_membership(err)
    return JSONResponse(content=row, headers=_AUTH_NO_STORE)


@app.post("/api/admin/requests/{request_id}/reject")
def admin_reject_request(request_id: int, request: Request, body: RejectBody | None = None):
    admin = _require_admin(request)
    payload = body or RejectBody()
    try:
        row = reject_registration(request_id, admin["id"], payload.note)
    except MembershipError as err:
        _raise_membership(err)
    return JSONResponse(content=row, headers=_AUTH_NO_STORE)


@app.patch("/api/auth/profile")
def auth_update_profile(body: ProfileBody, request: Request):
    user = _require_user(request)
    try:
        profile = update_own_profile(
            user["id"],
            body.first_name,
            body.last_name,
            body.role_title,
            body.organization,
            body.birth_date,
            body.email,
            body.address,
        )
    except MembershipError as err:
        _raise_membership(err)
    return JSONResponse(content=profile, headers=_AUTH_NO_STORE)


@app.post("/api/auth/profile/avatar")
async def auth_upload_avatar(request: Request, file: UploadFile = File(...)):
    user = _require_user(request)
    try:
        declared = int(request.headers.get("content-length") or "0")
    except ValueError:
        declared = 0
    if declared > AVATAR_MAX_BYTES + 65536:
        raise HTTPException(status_code=413, detail="حجم عکس بیش از حد مجاز است.")
    data = await file.read(AVATAR_MAX_BYTES + 1)
    if len(data) > AVATAR_MAX_BYTES:
        raise HTTPException(status_code=413, detail="حجم عکس بیش از حد مجاز است.")
    try:
        profile = set_user_avatar(user["id"], data, user["id"], "self")
    except MembershipError as err:
        _raise_membership(err)
    return JSONResponse(content=profile, headers=_AUTH_NO_STORE)


@app.delete("/api/auth/profile/avatar")
def auth_delete_avatar(request: Request):
    user = _require_user(request)
    try:
        profile = clear_user_avatar(user["id"], user["id"], "self")
    except MembershipError as err:
        _raise_membership(err)
    return JSONResponse(content=profile, headers=_AUTH_NO_STORE)


@app.get("/api/admin/users")
def admin_list_users(request: Request):
    _require_admin(request)
    return JSONResponse(content=list_users_for_admin(), headers=_AUTH_NO_STORE)


@app.get("/api/admin/users/{user_id}")
def admin_get_user(user_id: int, request: Request):
    _require_admin(request)
    try:
        payload = get_user_for_admin(user_id)
    except MembershipError as err:
        _raise_membership(err)
    return JSONResponse(content=payload, headers=_AUTH_NO_STORE)


@app.get("/api/admin/users/{user_id}/avatar")
def admin_download_avatar(user_id: int, request: Request):
    _require_admin(request)
    try:
        path, filename = avatar_download(user_id)
    except MembershipError as err:
        _raise_membership(err)
    return FileResponse(
        path=str(path),
        media_type="image/webp",
        filename=filename,
        headers=_AUTH_NO_STORE,
    )


@app.delete("/api/admin/users/{user_id}")
def admin_delete_user(user_id: int, request: Request):
    admin = _require_admin(request)
    try:
        delete_user_account(user_id, admin["id"])
    except MembershipError as err:
        _raise_membership(err)
    return JSONResponse(content={"ok": True}, headers=_AUTH_NO_STORE)


@app.delete("/api/admin/users/{user_id}/avatar")
def admin_delete_avatar(user_id: int, request: Request):
    admin = _require_admin(request)
    try:
        profile = clear_user_avatar(user_id, admin["id"], "admin")
    except MembershipError as err:
        _raise_membership(err)
    return JSONResponse(content=profile, headers=_AUTH_NO_STORE)


_PROJECT_ROOT = Path(__file__).resolve().parent.parent
app.mount(
    "/",
    CachedStaticFiles(directory=str(_PROJECT_ROOT), html=True),
    name="static",
)

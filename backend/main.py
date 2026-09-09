# File: backend/main.py
# Purpose: FastAPI backend that serves data for the dashboard frontend.
#   Provides endpoints for atlas initialization, explorer data, bubble chart data,
#   and province profile data. Indexes needed for efficient queries are created
#   at startup (safe to run repeatedly).
# Notes: Atlas map snapshots come from the latest year of trend_score per topic.
#   Province population comes from province_pop (latest year per province).
#   Static files: HTML/JS/CSS, assets/, and data/*.geojson only — not the SQLite file,
#   backend source, or git. Public deploy: CORS_ORIGINS and optional THREAD_POOL_SIZE.

from __future__ import annotations

import hashlib
import json
import os
import random
from collections import defaultdict
from contextlib import asynccontextmanager

from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles

from backend.database import (
    NATIONAL_NAME,
    db_connection,
    ensure_runtime,
    fetch_latest_province_pop,
    fetchall_dicts,
    fetchone_dict,
    get_cache,
    list_dashboard_provinces,
    normalize_fa_name,
    resolve_catalog_name,
)

JSON_MEDIA = "application/json"
# Data and assets change rarely. Browsers may reuse copies:
#   API JSON     — 1 hour fresh, then stale-while-revalidate for 7 days
#   JS / CSS     — 1 day, then SWR 7 days
#   images / GIS — 7 days, then SWR 30 days
#   HTML         — always revalidate (small); 304 if unchanged
# Hard refresh (Ctrl+F5) still bypasses this.
_API_CACHE_CONTROL = (
    "public, max-age=3600, stale-while-revalidate=604800, stale-if-error=86400"
)
_CACHE_HEADERS = {
    "Cache-Control": _API_CACHE_CONTROL,
    "Vary": "Accept-Encoding",
}

_HTML_CACHE_CONTROL = "public, max-age=0, must-revalidate"
_CODE_CACHE_CONTROL = "public, max-age=86400, stale-while-revalidate=604800"
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
    if suffix in _HTML_SUFFIXES:
        return _HTML_CACHE_CONTROL
    if suffix in _CODE_SUFFIXES:
        return _CODE_CACHE_CONTROL
    if suffix in _MEDIA_SUFFIXES:
        return _MEDIA_CACHE_CONTROL
    return _CODE_CACHE_CONTROL


class CachedStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope):
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


def _cors_origins() -> list[str]:
    raw = os.environ.get("CORS_ORIGINS", "").strip()
    if raw:
        return [origin.strip() for origin in raw.split(",") if origin.strip()]
    # Local copies of this folder (any device, any path) must work without extra env.
    return ["*"]


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
    cache.get("national-trends", _compute_national_trends)
    cache.get("pyramid-names", _compute_pyramid_names)
    cache.get("indicator-names", _compute_indicator_names)
    cache.get("subtopic-names", _compute_subtopic_names)
    cache.get("init-atlas", lambda: _json_bytes(_compute_atlas()))
    cache.get("explorer-init", lambda: _json_bytes(_compute_explorer_init()))


def bootstrap() -> None:
    ensure_runtime()
    _warm_cache()


@asynccontextmanager
async def lifespan(app: FastAPI):
    _expand_thread_pool()
    bootstrap()
    yield


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins(),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["ETag"],
)
app.add_middleware(GZipMiddleware, minimum_size=500)


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
            "FROM topics ORDER BY rowid",
        )
        trend_score = fetchall_dicts(
            conn,
            "SELECT t.province_name, t.year, t.topic_name, t.index_score, t.province_rank "
            "FROM trend_score t "
            "INNER JOIN ("
            "    SELECT topic_name, MAX(year) AS year FROM trend_score GROUP BY topic_name"
            ") latest ON t.topic_name = latest.topic_name AND t.year = latest.year "
            "WHERE t.province_name != ? "
            "ORDER BY t.topic_name, t.province_name",
            (NATIONAL_NAME,),
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
            "WHERE province_name = ? AND topic_name = ? ORDER BY year",
            (prov_canon, topic_canon),
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


def _compute_atlas_clusters(topic: str) -> dict:
    topic_canon = resolve_catalog_name(topic, _topic_names()) or (topic or "").strip()
    if not topic_canon:
        return {"topic_name": topic_canon, "clusters": []}
    with db_connection() as conn:
        clusters = fetchall_dicts(
            conn,
            "SELECT province_name, topic_name, subtopic_name, cluster_group, subtopic_score "
            "FROM clusters WHERE topic_name = ? ORDER BY province_name, subtopic_name",
            (topic_canon,),
        )
    _round_field(clusters, "subtopic_score")
    return {"topic_name": topic_canon, "clusters": clusters}


@app.get("/api/atlas/clusters")
def get_atlas_clusters(topic: str, request: Request):
    """Cluster rows for گونه‌شناسی (one topic)."""
    return _cached_json(
        f"atlas-clusters::{_name_key(topic)}",
        lambda: _compute_atlas_clusters(topic),
        request,
    )


def _compute_atlas_topic_trends(topic: str) -> dict:
    topic_canon = resolve_catalog_name(topic, _topic_names()) or (topic or "").strip()
    if not topic_canon:
        return {"topic_name": topic_canon, "trends": []}
    with db_connection() as conn:
        trends = fetchall_dicts(
            conn,
            "SELECT province_name, year, index_score FROM trend_score "
            "WHERE topic_name = ? AND province_name != ? "
            "ORDER BY province_name, year",
            (topic_canon, NATIONAL_NAME),
        )
    _round_field(trends, "index_score")
    return {"topic_name": topic_canon, "trends": trends}


@app.get("/api/atlas/topic-trends")
def get_atlas_topic_trends(topic: str, request: Request):
    """All-province time series for one topic (گونه‌شناسی trend cards)."""
    return _cached_json(
        f"atlas-topic-trends::{_name_key(topic)}",
        lambda: _compute_atlas_topic_trends(topic),
        request,
    )


def _compute_explorer_init() -> dict:
    with db_connection() as conn:
        colors = fetchall_dicts(
            conn,
            "SELECT topic_name, upper_color, lower_color, master_color FROM topics ORDER BY rowid",
        )
        kdesc_rows = fetchall_dicts(
            conn,
            "SELECT topic_name, subtopic_name, indicator_name FROM kdescription ORDER BY rowid",
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
            "WHERE indicator_name = ? ORDER BY rowid",
            (canon,),
        )
        scores = fetchall_dicts(
            conn,
            "SELECT province_name, year, value FROM kindicator_score "
            "WHERE indicator_name = ? ORDER BY rowid",
            (canon,),
        )
        latest_year_row = conn.execute(
            "SELECT MAX(year) AS y FROM kindicator_score WHERE indicator_name = ?",
            (canon,),
        ).fetchone()
        latest_year = latest_year_row["y"] if latest_year_row else None
        latest_scores = []
        if latest_year is not None:
            latest_scores = fetchall_dicts(
                conn,
                "SELECT province_name, year, value FROM kindicator_score "
                "WHERE indicator_name = ? AND year = ? AND province_name != ? "
                "ORDER BY province_name",
                (canon, latest_year, NATIONAL_NAME),
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
            "SELECT upper_color, lower_color, master_color FROM topics WHERE topic_name = ?",
            (topic_canon,),
        )
        scores = fetchall_dicts(
            conn,
            "SELECT k.province_name, k.indicator_name, k.year, k.standard_value "
            "FROM kindicator_score k "
            "WHERE k.topic_name = ? AND k.subtopic_name = ? AND k.year = ("
            "    SELECT MAX(k2.year) FROM kindicator_score k2 "
            "    WHERE k2.province_name = k.province_name "
            "      AND k2.indicator_name = k.indicator_name "
            "      AND k2.topic_name = k.topic_name "
            "      AND k2.subtopic_name = k.subtopic_name"
            ")",
            (topic_canon, sub_canon),
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
            "SELECT topic_name, master_color FROM topics ORDER BY rowid",
        )


def _compute_trend_provinces() -> list[str]:
    with db_connection() as conn:
        return list_dashboard_provinces(conn)


def _compute_national_trends() -> list[dict]:
    with db_connection() as conn:
        return fetchall_dicts(
            conn,
            "SELECT topic_name, year, index_score FROM trend_score "
            "WHERE province_name = ? ORDER BY year ASC",
            (NATIONAL_NAME,),
        )


def _compute_problem_init(province: str) -> dict:
    cache = get_cache()
    topics = cache.get("topics-min", _compute_topics_min)
    provinces_list = cache.get("trend-provinces", _compute_trend_provinces)
    nat_trends = cache.get("national-trends", _compute_national_trends)
    canon = resolve_catalog_name(province, provinces_list)

    if not canon:
        prov_trends: list[dict] = []
    else:
        with db_connection() as conn:
            prov_trends = fetchall_dicts(
                conn,
                "SELECT topic_name, year, index_score FROM trend_score "
                "WHERE province_name = ? ORDER BY year ASC",
                (canon,),
            )

    prov_by_topic = defaultdict(list)
    for r in prov_trends:
        prov_by_topic[r["topic_name"]].append(r)

    nat_by_topic = defaultdict(list)
    for r in nat_trends:
        nat_by_topic[r["topic_name"]].append(r)

    scatter_data = []
    for topic, p_data in prov_by_topic.items():
        if len(p_data) >= 2:
            cur_prov = float(p_data[-1]["index_score"])
            prev_prov = float(p_data[-2]["index_score"])
            n_data = nat_by_topic.get(topic, [])
            if len(n_data) >= 1:
                cur_nat = float(n_data[-1]["index_score"])
                y_val = round(cur_prov - cur_nat, 2)
                x_val = round(cur_prov - prev_prov, 2)
                color = "#3b82f6"
                for t in topics:
                    if t["topic_name"] == topic and t["master_color"]:
                        color = t["master_color"]
                        break
                scatter_data.append({"topic": topic, "x": x_val, "y": y_val, "color": color})

    def national_gap_fields(topic_name, cur_score):
        n_data = nat_by_topic.get(topic_name, [])
        if not n_data or cur_score is None:
            return {
                "national_score": None,
                "national_year": None,
                "gap_from_national": None,
                "gap_pct": None,
                "gap_direction": "na",
            }
        nat_cur = n_data[-1]
        national_score = round(float(nat_cur["index_score"]), 2)
        gap = round(cur_score - national_score, 2)
        nat_abs = abs(national_score)
        gap_pct = round((gap / nat_abs) * 100, 1) if nat_abs > 0 else None
        if gap > 0.005:
            gap_direction = "above"
        elif gap < -0.005:
            gap_direction = "below"
        else:
            gap_direction = "even"
        return {
            "national_score": national_score,
            "national_year": nat_cur["year"],
            "gap_from_national": gap,
            "gap_pct": gap_pct,
            "gap_direction": gap_direction,
        }

    topic_changes = []
    for t in topics:
        topic = t["topic_name"]
        color = t["master_color"] or "#3b82f6"
        p_data = prov_by_topic.get(topic, [])
        if len(p_data) >= 2:
            cur = p_data[-1]
            prev = p_data[-2]
            cur_score = round(float(cur["index_score"]), 2)
            prev_score = round(float(prev["index_score"]), 2)
            change = round(cur_score - prev_score, 2)
            prev_abs = abs(prev_score)
            change_pct = round((change / prev_abs) * 100, 1) if prev_abs > 0 else None
            if change > 0.005:
                direction = "up"
            elif change < -0.005:
                direction = "down"
            else:
                direction = "flat"
            topic_changes.append(
                {
                    "topic": topic,
                    "color": color,
                    "current_score": cur_score,
                    "previous_score": prev_score,
                    "change": change,
                    "change_pct": change_pct,
                    "current_year": cur["year"],
                    "previous_year": prev["year"],
                    "direction": direction,
                    **national_gap_fields(topic, cur_score),
                }
            )
        else:
            cur_score = round(float(p_data[-1]["index_score"]), 2) if p_data else None
            cur_year = p_data[-1]["year"] if p_data else None
            topic_changes.append(
                {
                    "topic": topic,
                    "color": color,
                    "current_score": cur_score,
                    "previous_score": None,
                    "change": None,
                    "change_pct": None,
                    "current_year": cur_year,
                    "previous_year": None,
                    "direction": "na",
                    **national_gap_fields(topic, cur_score),
                }
            )

    return {
        "topics": list(topics),
        "trends": prov_trends,
        "scatter_data": scatter_data,
        "topic_changes": topic_changes,
        "provinces": list(provinces_list),
    }


@app.get("/api/problem/init")
def get_problem_init(province: str, request: Request):
    key = f"problem-init::{_name_key(province)}"
    return _cached_json(key, lambda: _compute_problem_init(province), request)


def _compute_problem_data(province: str, topic: str) -> dict:
    empty = {"score": 0, "rank": "-", "subtopics": []}
    provinces_list = get_cache().get("trend-provinces", _compute_trend_provinces)
    province_canon = resolve_catalog_name(province, provinces_list)
    topic_canon = resolve_catalog_name(topic, _topic_names())
    if not province_canon or not topic_canon:
        return empty
    with db_connection() as conn:
        map_row = fetchone_dict(
            conn,
            "SELECT index_score, province_rank FROM trend_score "
            "WHERE province_name = ? AND topic_name = ? AND year = ("
            "    SELECT MAX(year) FROM trend_score WHERE topic_name = ?"
            ")",
            (province_canon, topic_canon, topic_canon),
        )
        sub_rows = fetchall_dicts(
            conn,
            "SELECT subtopic_name, subtopic_score FROM clusters "
            "WHERE province_name = ? AND topic_name = ? ORDER BY rowid",
            (province_canon, topic_canon),
        )
    return {
        "score": map_row["index_score"] if map_row else 0,
        "rank": map_row["province_rank"] if map_row else "-",
        "subtopics": sub_rows,
    }


@app.get("/api/problem/data")
def get_problem_data(province: str, topic: str, request: Request):
    key = f"problem-data::{_name_key(province, topic)}"
    return _cached_json(key, lambda: _compute_problem_data(province, topic), request)


def _pyramid_from_rows(matched: list[dict]) -> dict:
    years = sorted({int(r["year"]) for r in matched if r["year"] is not None})
    ages = sorted({int(r["age"]) for r in matched if r["age"] is not None})
    by_year = {}
    for y in years:
        male = []
        female = []
        lookup = {
            int(r["age"]): r
            for r in matched
            if int(r["year"]) == y and r["age"] is not None
        }
        for age in ages:
            row = lookup.get(age)
            male.append(float(row["male"]) if row and row["male"] is not None else 0)
            female.append(float(row["female"]) if row and row["female"] is not None else 0)
        by_year[str(y)] = {"male": male, "female": female}
    return {"years": years, "ages": ages, "by_year": by_year}


def _compute_pyramid_names() -> list[str]:
    with db_connection() as conn:
        return [
            row[0]
            for row in conn.execute(
                "SELECT DISTINCT province_name FROM pyramid "
                "WHERE province_name != ? ORDER BY province_name",
                (NATIONAL_NAME,),
            )
        ]


def _pyramid_payload(province: str) -> dict:
    names = get_cache().get("pyramid-names", _compute_pyramid_names)
    canon = resolve_catalog_name(province, names)
    if not canon:
        return {"years": [], "ages": [], "by_year": {}}
    with db_connection() as conn:
        matched = fetchall_dicts(
            conn,
            "SELECT year, age, male, female FROM pyramid "
            "WHERE province_name = ? ORDER BY year ASC, age ASC",
            (canon,),
        )
    return _pyramid_from_rows(matched)


@app.get("/api/problem/pyramid")
def get_province_pyramid(province: str, request: Request):
    """Yearly population pyramid (by sex) for a province, from the pyramid table."""
    return _cached_json(
        f"problem-pyramid::{_name_key(province)}",
        lambda: _pyramid_payload(province),
        request,
    )


def _compute_curtain_race() -> dict:
    """Pick a random indicator with more than 15 distinct years, then pack the race series."""
    with db_connection() as conn:
        names = [
            row[0]
            for row in conn.execute(
                "SELECT DISTINCT indicator_name FROM kindicator_score "
                "WHERE indicator_name IS NOT NULL AND TRIM(indicator_name) != ''"
            )
        ]
        if not names:
            raise HTTPException(status_code=404, detail="شاخصی یافت نشد")

        chosen = None
        years: list[int] = []
        rows: list[dict] = []
        topic_row: dict = {}
        colors = None
        series: dict[str, list] = {}
        provinces: list[str] = []

        for _ in range(100):
            candidate = random.choice(names)
            year_n = conn.execute(
                "SELECT COUNT(DISTINCT year) FROM kindicator_score WHERE indicator_name = ?",
                (candidate,),
            ).fetchone()[0]
            if year_n is None or int(year_n) <= 10:
                continue

            years = [
                int(row[0])
                for row in conn.execute(
                    "SELECT DISTINCT year FROM kindicator_score "
                    "WHERE indicator_name = ? AND year IS NOT NULL ORDER BY year",
                    (candidate,),
                )
            ]
            rows = fetchall_dicts(
                conn,
                "SELECT province_name, year, value FROM kindicator_score "
                "WHERE indicator_name = ? AND province_name != ? AND value IS NOT NULL "
                "ORDER BY year, province_name",
                (candidate, NATIONAL_NAME),
            )
            year_index = {year: idx for idx, year in enumerate(years)}
            series = {}
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
            if not provinces or len(years) <= 15:
                continue

            chosen = candidate
            topic_row = fetchone_dict(
                conn,
                "SELECT topic_name, subtopic_name FROM kindicator_score "
                "WHERE indicator_name = ? LIMIT 1",
                (chosen,),
            ) or {}
            if topic_row.get("topic_name"):
                colors = fetchone_dict(
                    conn,
                    "SELECT master_color, lower_color, upper_color FROM topics WHERE topic_name = ?",
                    (topic_row["topic_name"],),
                )
            break

        if chosen is None:
            raise HTTPException(status_code=404, detail="شاخص معتبری یافت نشد")

    return {
        "indicator_name": chosen,
        "topic_name": topic_row.get("topic_name") or "",
        "subtopic_name": topic_row.get("subtopic_name") or "",
        "master_color": (colors or {}).get("master_color"),
        "lower_color": (colors or {}).get("lower_color"),
        "upper_color": (colors or {}).get("upper_color"),
        "years": years,
        "provinces": provinces,
        "series": {name: series[name] for name in provinces},
    }


@app.get("/api/curtain/race")
def get_curtain_race():
    """Random valid indicator series for the curtain racing-bar motion graphic."""
    return Response(
        content=_json_bytes(_compute_curtain_race()),
        media_type=JSON_MEDIA,
        headers={"Cache-Control": "no-store", "Vary": "Accept-Encoding"},
    )


_PROJECT_ROOT = Path(__file__).resolve().parent.parent
app.mount(
    "/",
    CachedStaticFiles(directory=str(_PROJECT_ROOT), html=True),
    name="static",
)

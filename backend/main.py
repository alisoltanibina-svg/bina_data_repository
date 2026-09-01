# File: backend/main.py
# Purpose: FastAPI backend that serves data for the dashboard frontend.
#   Provides endpoints for atlas initialization, explorer data, bubble chart data,
#   and province profile data. Indexes needed for efficient queries are created
#   at startup (safe to run repeatedly).
# Notes: Atlas map snapshots come from the latest year of trend_score per topic.
#   Province population comes from province_pop (latest year per province).

from __future__ import annotations

import json
from collections import defaultdict
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import Response
from pydantic import BaseModel

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
)

JSON_MEDIA = "application/json"


def _json_bytes(payload: object) -> bytes:
    return json.dumps(
        payload,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
    ).encode("utf-8")


def _cached_json(key: str, factory) -> Response:
    body = get_cache().get(key, lambda: _json_bytes(factory()))
    return Response(content=body, media_type=JSON_MEDIA)


def _expand_thread_pool(size: int = 100) -> None:
    try:
        import anyio

        anyio.to_thread.current_default_thread_limiter().total_tokens = size
    except Exception:
        pass


def _warm_cache() -> None:
    cache = get_cache()
    cache.get("pyramid-index", _compute_pyramid_index)
    cache.get("topics-min", _compute_topics_min)
    cache.get("trend-provinces", _compute_trend_provinces)
    cache.get("national-trends", _compute_national_trends)
    cache.get("init-atlas", lambda: _json_bytes(_compute_atlas()))
    cache.get("explorer-init", lambda: _json_bytes(_compute_explorer_init()))


def bootstrap() -> None:
    ensure_runtime()
    _warm_cache()


@asynccontextmanager
async def lifespan(app: FastAPI):
    _expand_thread_pool(100)
    bootstrap()
    yield


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(GZipMiddleware, minimum_size=500)


def _round_field(rows: list[dict], field: str) -> None:
    for row in rows:
        if row.get(field) is not None:
            row[field] = round(float(row[field]), 2)


def _compute_atlas() -> dict:
    with db_connection() as conn:
        payload = {
            name: fetchall_dicts(conn, f'SELECT * FROM "{name}" ORDER BY rowid')
            for name in ("topics", "trend_score", "clusters")
        }
        province_pop = fetch_latest_province_pop(conn)
    _round_field(payload["trend_score"], "index_score")
    _round_field(payload["clusters"], "subtopic_score")
    return {
        "topics": payload["topics"],
        "trend_score": payload["trend_score"],
        "clusters": payload["clusters"],
        "province_pop": province_pop,
    }


@app.get("/api/init-atlas")
def get_atlas_data():
    """Provides the initial payload required by index.html"""
    return _cached_json("init-atlas", _compute_atlas)


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
def get_explorer_init():
    """Builds the hierarchy and province list on the server."""
    return _cached_json("explorer-init", _compute_explorer_init)


def _compute_explorer_indicator(name: str) -> dict:
    with db_connection() as conn:
        desc_row = fetchone_dict(
            conn,
            "SELECT description, source_name FROM kdescription "
            "WHERE indicator_name = ? ORDER BY rowid",
            (name,),
        )
        scores = fetchall_dicts(
            conn,
            "SELECT province_name, year, value FROM kindicator_score "
            "WHERE indicator_name = ? ORDER BY rowid",
            (name,),
        )
        latest_year_row = conn.execute(
            "SELECT MAX(year) AS y FROM kindicator_score WHERE indicator_name = ?",
            (name,),
        ).fetchone()
        latest_year = latest_year_row["y"] if latest_year_row else None
        latest_scores = []
        if latest_year is not None:
            latest_scores = fetchall_dicts(
                conn,
                "SELECT province_name, year, value FROM kindicator_score "
                "WHERE indicator_name = ? AND year = ? AND province_name != ? "
                "ORDER BY province_name",
                (name, latest_year, NATIONAL_NAME),
            )
    return {
        "description": desc_row,
        "scores": scores,
        "latest_year": latest_year,
        "latest_scores": latest_scores,
    }


@app.get("/api/explorer/indicator")
def get_explorer_indicator(name: str):
    """Fetches data only for the specifically clicked indicator."""
    return _cached_json(
        f"explorer-indicator::{name}",
        lambda: _compute_explorer_indicator(name),
    )


def _compute_bubble_init(topic: str, subtopic: str) -> dict:
    with db_connection() as conn:
        color_row = fetchone_dict(
            conn,
            "SELECT upper_color, lower_color, master_color FROM topics WHERE topic_name = ?",
            (topic,),
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
            (topic, subtopic),
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
def get_bubble_init(topic: str = "", subtopic: str = ""):
    """Fetches filtered data specifically for the dynamic bubble chart."""
    return _cached_json(
        f"bubble-init::{topic}::{subtopic}",
        lambda: _compute_bubble_init(topic, subtopic),
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

    with db_connection() as conn:
        prov_trends = fetchall_dicts(
            conn,
            "SELECT topic_name, year, index_score FROM trend_score "
            "WHERE province_name LIKE ? ORDER BY year ASC",
            (f"%{province.strip()}%",),
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
def get_problem_init(province: str):
    key = f"problem-init::{province.strip()}"
    return _cached_json(key, lambda: _compute_problem_init(province))


def _compute_problem_data(province: str, topic: str) -> dict:
    with db_connection() as conn:
        topic_like = f"%{topic.strip()}%"
        province_like = f"%{province.strip()}%"
        map_row = fetchone_dict(
            conn,
            "SELECT index_score, province_rank FROM trend_score "
            "WHERE province_name LIKE ? AND topic_name LIKE ? AND year = ("
            "    SELECT MAX(year) FROM trend_score WHERE topic_name LIKE ?"
            ") ORDER BY rowid",
            (province_like, topic_like, topic_like),
        )
        sub_rows = fetchall_dicts(
            conn,
            "SELECT subtopic_name, subtopic_score FROM clusters "
            "WHERE province_name LIKE ? AND topic_name LIKE ? ORDER BY rowid",
            (province_like, topic_like),
        )
    return {
        "score": map_row["index_score"] if map_row else 0,
        "rank": map_row["province_rank"] if map_row else "-",
        "subtopics": sub_rows,
    }


@app.get("/api/problem/data")
def get_problem_data(province: str, topic: str):
    key = f"problem-data::{province.strip()}::{topic.strip()}"
    return _cached_json(key, lambda: _compute_problem_data(province, topic))


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


def _compute_pyramid_index() -> dict:
    with db_connection() as conn:
        rows = fetchall_dicts(
            conn,
            "SELECT province_name, year, age, male, female FROM pyramid "
            "WHERE province_name != ? ORDER BY year ASC, age ASC",
            (NATIONAL_NAME,),
        )
    names = []
    seen = set()
    for row in rows:
        name = row["province_name"]
        if name not in seen:
            seen.add(name)
            names.append(name)
    return {"rows": rows, "names": names}


def _pyramid_payload(province: str) -> dict:
    index = get_cache().get("pyramid-index", _compute_pyramid_index)
    target = normalize_fa_name(province)
    matched_names = [n for n in index["names"] if normalize_fa_name(n) == target]
    if not matched_names:
        matched_names = [
            n
            for n in index["names"]
            if target and (target in normalize_fa_name(n) or normalize_fa_name(n) in target)
        ]
    if not matched_names:
        return {"years": [], "ages": [], "by_year": {}}
    wanted = set(matched_names)
    matched = [r for r in index["rows"] if r["province_name"] in wanted]
    return _pyramid_from_rows(matched)


@app.get("/api/problem/pyramid")
def get_province_pyramid(province: str):
    """Yearly population pyramid (by sex) for a province, from the pyramid table."""
    return _cached_json(
        f"problem-pyramid::{province}",
        lambda: _pyramid_payload(province),
    )


class LoginRequest(BaseModel):
    phone: str
    # captcha: str (Reserved for future CAPTCHA implementation)


@app.post("/api/auth/login")
def verify_user_login(request: LoginRequest):
    """Validates the provided phone number against the registered users table."""
    with db_connection() as conn:
        user = conn.execute(
            "SELECT id, phone FROM users WHERE phone = ?",
            (request.phone.strip(),),
        ).fetchone()

    if user:
        return {
            "status": "success",
            "token": "auth_token_simulated_string",
            "redirect_url": "index.html",
        }
    raise HTTPException(status_code=401, detail="شماره تلفن ثبت نشده است")

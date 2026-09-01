"""
File: benchmark_100_users.py
Purpose: Concurrent-user load test that mimics real dashboard sessions.
         Default: 100 users hitting login, atlas, explorer, province profile,
         bubble chart, and (if available) frontend pages at the same time.
Notes: Requires the FastAPI backend on :8000. Frontend on :8080 is optional.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import random
import sqlite3
import statistics
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx

from backend.database import DB_PATH

ROOT = Path(__file__).resolve().parent
REPORT_JSON = ROOT / "benchmark_100_users_report.json"
NATIONAL_NAME = "کل کشور"


def percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    k = (len(ordered) - 1) * (p / 100.0)
    lo = int(k)
    hi = min(lo + 1, len(ordered) - 1)
    frac = k - lo
    return ordered[lo] * (1.0 - frac) + ordered[hi] * frac


def load_fixtures() -> dict[str, Any]:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        phones = [r["phone"] for r in conn.execute("SELECT phone FROM users").fetchall()]
        topics = [r["topic_name"] for r in conn.execute("SELECT topic_name FROM topics").fetchall()]
        provinces = [
            r["province_name"]
            for r in conn.execute(
                "SELECT DISTINCT province_name FROM trend_score WHERE province_name != ? ORDER BY province_name",
                (NATIONAL_NAME,),
            ).fetchall()
        ]
        pairs = conn.execute(
            "SELECT DISTINCT topic_name, subtopic_name FROM kdescription"
        ).fetchall()
        subtopics = [{"topic": r["topic_name"], "subtopic": r["subtopic_name"]} for r in pairs]
        indicators = [
            r["indicator_name"]
            for r in conn.execute("SELECT DISTINCT indicator_name FROM kdescription").fetchall()
        ]
    finally:
        conn.close()

    if not phones:
        raise RuntimeError("No users in the database - cannot simulate login.")
    if not topics or not provinces:
        raise RuntimeError("Missing topics or provinces - cannot simulate dashboard use.")
    return {
        "phones": phones,
        "topics": topics,
        "provinces": provinces,
        "subtopics": subtopics,
        "indicators": indicators,
    }


class Recorder:
    def __init__(self) -> None:
        self.rows: list[dict[str, Any]] = []
        self._lock = asyncio.Lock()

    async def add(self, row: dict[str, Any]) -> None:
        async with self._lock:
            self.rows.append(row)


async def timed_request(
    client: httpx.AsyncClient,
    recorder: Recorder,
    method: str,
    url: str,
    user_id: int,
    name: str,
    **kwargs: Any,
) -> httpx.Response | None:
    started = time.perf_counter()
    error = None
    status = 0
    bytes_out = 0
    try:
        response = await client.request(method, url, **kwargs)
        status = response.status_code
        bytes_out = len(response.content)
        if status >= 400:
            error = f"HTTP {status}"
        row_ok = response
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"
        row_ok = None
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    await recorder.add(
        {
            "user_id": user_id,
            "name": name,
            "method": method,
            "url": url,
            "status": status,
            "ms": elapsed_ms,
            "bytes": bytes_out,
            "error": error,
        }
    )
    return row_ok


async def user_session(
    client: httpx.AsyncClient,
    recorder: Recorder,
    fixtures: dict[str, Any],
    user_id: int,
    api: str,
    frontend: str | None,
    include_frontend: bool,
) -> float:
    """One virtual user walking through the same pages a real visitor hits."""
    rng = random.Random(user_id * 997 + 13)
    phone = fixtures["phones"][user_id % len(fixtures["phones"])]
    province = fixtures["provinces"][user_id % len(fixtures["provinces"])]
    topic = fixtures["topics"][user_id % len(fixtures["topics"])]
    indicator = fixtures["indicators"][user_id % len(fixtures["indicators"])]
    pair = fixtures["subtopics"][user_id % len(fixtures["subtopics"])] if fixtures["subtopics"] else None
    # Extra clicks so users are not perfectly identical.
    extra_province = rng.choice(fixtures["provinces"])
    extra_topic = rng.choice(fixtures["topics"])
    extra_indicator = rng.choice(fixtures["indicators"])

    t0 = time.perf_counter()

    if include_frontend and frontend:
        await timed_request(client, recorder, "GET", f"{frontend}/log_in.html", user_id, "FE log_in.html")

    await timed_request(
        client,
        recorder,
        "POST",
        f"{api}/api/auth/login",
        user_id,
        "API POST /api/auth/login",
        json={"phone": phone},
        headers={"Content-Type": "application/json"},
    )

    if include_frontend and frontend:
        await timed_request(client, recorder, "GET", f"{frontend}/index.html", user_id, "FE index.html")
        await timed_request(client, recorder, "GET", f"{frontend}/index.js", user_id, "FE index.js")
        await timed_request(client, recorder, "GET", f"{frontend}/data/iran.geojson", user_id, "FE iran.geojson")

    await timed_request(client, recorder, "GET", f"{api}/api/init-atlas", user_id, "API GET /api/init-atlas")
    await timed_request(client, recorder, "GET", f"{api}/api/explorer/init", user_id, "API GET /api/explorer/init")

    if include_frontend and frontend:
        await timed_request(client, recorder, "GET", f"{frontend}/explorer.html", user_id, "FE explorer.html")

    await timed_request(
        client,
        recorder,
        "GET",
        f"{api}/api/explorer/indicator",
        user_id,
        "API GET /api/explorer/indicator",
        params={"name": indicator},
    )
    await timed_request(
        client,
        recorder,
        "GET",
        f"{api}/api/explorer/indicator",
        user_id,
        "API GET /api/explorer/indicator (2nd click)",
        params={"name": extra_indicator},
    )

    if include_frontend and frontend:
        q = quote(province)
        await timed_request(
            client,
            recorder,
            "GET",
            f"{frontend}/problem.html?province={q}",
            user_id,
            "FE problem.html",
        )

    await timed_request(
        client,
        recorder,
        "GET",
        f"{api}/api/problem/init",
        user_id,
        "API GET /api/problem/init",
        params={"province": province},
    )
    await timed_request(
        client,
        recorder,
        "GET",
        f"{api}/api/problem/data",
        user_id,
        "API GET /api/problem/data",
        params={"province": province, "topic": topic},
    )
    await timed_request(
        client,
        recorder,
        "GET",
        f"{api}/api/problem/pyramid",
        user_id,
        "API GET /api/problem/pyramid",
        params={"province": province},
    )
    # User switches province on the profile page (problem.html select).
    await timed_request(
        client,
        recorder,
        "GET",
        f"{api}/api/problem/init",
        user_id,
        "API GET /api/problem/init (switch province)",
        params={"province": extra_province},
    )
    await timed_request(
        client,
        recorder,
        "GET",
        f"{api}/api/problem/data",
        user_id,
        "API GET /api/problem/data (switch topic)",
        params={"province": extra_province, "topic": extra_topic},
    )

    if pair:
        if include_frontend and frontend:
            await timed_request(client, recorder, "GET", f"{frontend}/bubble-chart.html", user_id, "FE bubble-chart.html")
        await timed_request(
            client,
            recorder,
            "GET",
            f"{api}/api/bubble/init",
            user_id,
            "API GET /api/bubble/init",
            params={"topic": pair["topic"], "subtopic": pair["subtopic"]},
        )

    return (time.perf_counter() - t0) * 1000.0


def summarize(rows: list[dict[str, Any]], session_ms: list[float], wall_s: float, users: int) -> dict[str, Any]:
    by_name: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        by_name[row["name"]].append(row)

    def stats_for(group: list[dict[str, Any]]) -> dict[str, Any]:
        times = [r["ms"] for r in group]
        errors = [r for r in group if r["error"]]
        ok = [r for r in group if not r["error"]]
        statuses: dict[str, int] = defaultdict(int)
        for r in group:
            statuses[str(r["status"])] += 1
        return {
            "requests": len(group),
            "ok": len(ok),
            "errors": len(errors),
            "error_rate_pct": round(100.0 * len(errors) / len(group), 2) if group else 0.0,
            "bytes_total": sum(r["bytes"] for r in group),
            "status_counts": dict(statuses),
            "latency_ms": {
                "min": round(min(times), 1) if times else 0.0,
                "mean": round(statistics.mean(times), 1) if times else 0.0,
                "p50": round(percentile(times, 50), 1) if times else 0.0,
                "p95": round(percentile(times, 95), 1) if times else 0.0,
                "p99": round(percentile(times, 99), 1) if times else 0.0,
                "max": round(max(times), 1) if times else 0.0,
            },
            "sample_errors": [e["error"] for e in errors[:5]],
        }

    endpoints = {name: stats_for(group) for name, group in sorted(by_name.items())}
    overall = stats_for(rows)
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "concurrent_users": users,
        "wall_seconds": round(wall_s, 3),
        "throughput_rps": round(len(rows) / wall_s, 2) if wall_s else 0.0,
        "session_ms": {
            "min": round(min(session_ms), 1) if session_ms else 0.0,
            "mean": round(statistics.mean(session_ms), 1) if session_ms else 0.0,
            "p50": round(percentile(session_ms, 50), 1) if session_ms else 0.0,
            "p95": round(percentile(session_ms, 95), 1) if session_ms else 0.0,
            "p99": round(percentile(session_ms, 99), 1) if session_ms else 0.0,
            "max": round(max(session_ms), 1) if session_ms else 0.0,
        },
        "overall": overall,
        "endpoints": endpoints,
    }


def print_report(report: dict[str, Any]) -> None:
    overall = report["overall"]
    lat = overall["latency_ms"]
    sess = report["session_ms"]
    print()
    print("=" * 92)
    print("  100-USER CONCURRENT BENCHMARK  -  Cultural Observatory Dashboard")
    print("=" * 92)
    print(f"  Concurrent users : {report['concurrent_users']}")
    print(f"  Wall time        : {report['wall_seconds']:.2f} s")
    print(f"  Total requests   : {overall['requests']}")
    print(f"  Successful       : {overall['ok']}")
    print(f"  Failed           : {overall['errors']}  ({overall['error_rate_pct']}%)")
    print(f"  Throughput       : {report['throughput_rps']} req/s")
    print(f"  Payload received : {overall['bytes_total'] / (1024 * 1024):.2f} MB")
    print(f"  Status codes     : {overall['status_counts']}")
    print()
    print("  Per-user session duration (login -> full browse)")
    print(f"    min {sess['min']:.0f} ms | p50 {sess['p50']:.0f} ms | mean {sess['mean']:.0f} ms | "
          f"p95 {sess['p95']:.0f} ms | p99 {sess['p99']:.0f} ms | max {sess['max']:.0f} ms")
    print()
    print("  Overall request latency")
    print(f"    min {lat['min']:.0f} ms | p50 {lat['p50']:.0f} ms | mean {lat['mean']:.0f} ms | "
          f"p95 {lat['p95']:.0f} ms | p99 {lat['p99']:.0f} ms | max {lat['max']:.0f} ms")
    print()
    print("-" * 92)
    print(f"  {'endpoint':<46} {'n':>5} {'err':>5} {'p50':>8} {'p95':>8} {'p99':>8} {'max':>9} {'mean':>8}")
    print("-" * 92)
    for name, stats in report["endpoints"].items():
        L = stats["latency_ms"]
        print(
            f"  {name:<46} {stats['requests']:>5} {stats['errors']:>5} "
            f"{L['p50']:>7.0f} {L['p95']:>7.0f} {L['p99']:>7.0f} {L['max']:>8.0f} {L['mean']:>7.0f}"
        )
    print("-" * 92)
    if overall["sample_errors"]:
        print()
        print("  Sample errors:")
        for err in overall["sample_errors"]:
            print(f"    - {err}")
    print()
    print(f"  JSON report written to: {REPORT_JSON}")
    print("=" * 92)
    print()


async def probe(url: str, timeout: float = 3.0) -> bool:
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.get(url)
            return r.status_code < 500
    except Exception:
        return False


async def run(args: argparse.Namespace) -> int:
    print("Loading fixtures from SQLite...")
    fixtures = load_fixtures()
    print(
        f"  phones={len(fixtures['phones'])}  provinces={len(fixtures['provinces'])}  "
        f"topics={len(fixtures['topics'])}  indicators={len(fixtures['indicators'])}  "
        f"subtopics={len(fixtures['subtopics'])}"
    )

    api_ok = await probe(f"{args.api}/docs")
    if not api_ok:
        print(f"ERROR: FastAPI backend is not reachable at {args.api}")
        print("Start it with: python -m uvicorn backend.main:app --reload")
        return 2

    frontend_ok = await probe(f"{args.frontend}/index.html")
    include_frontend = bool(frontend_ok) and not args.api_only
    if include_frontend:
        print(f"Frontend detected at {args.frontend} - static pages included in the session.")
    else:
        print("Frontend not included (server down or --api-only). API-only sessions will run.")

    print("Warm-up (3 sequential requests)...")
    async with httpx.AsyncClient(timeout=30.0) as warm:
        await warm.post(f"{args.api}/api/auth/login", json={"phone": fixtures["phones"][0]})
        await warm.get(f"{args.api}/api/explorer/init")
        await warm.get(f"{args.api}/api/init-atlas")

    users = args.users
    print(f"Launching {users} concurrent users now...")
    recorder = Recorder()
    limits = httpx.Limits(max_connections=users, max_keepalive_connections=users)
    timeout = httpx.Timeout(args.timeout)
    session_ms: list[float] = []

    async with httpx.AsyncClient(limits=limits, timeout=timeout, follow_redirects=True) as client:
        t0 = time.perf_counter()
        results = await asyncio.gather(
            *[
                user_session(
                    client,
                    recorder,
                    fixtures,
                    user_id,
                    args.api,
                    args.frontend,
                    include_frontend,
                )
                for user_id in range(users)
            ],
            return_exceptions=True,
        )
        wall_s = time.perf_counter() - t0

    for item in results:
        if isinstance(item, Exception):
            print(f"  user task failed: {type(item).__name__}: {item}")
        else:
            session_ms.append(float(item))

    report = summarize(recorder.rows, session_ms, wall_s, users)
    report["api"] = args.api
    report["frontend"] = args.frontend if include_frontend else None
    report["include_frontend"] = include_frontend
    report["timeout_s"] = args.timeout
    REPORT_JSON.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print_report(report)
    return 0 if report["overall"]["errors"] == 0 else 1


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="100 concurrent user benchmark for the dashboard.")
    p.add_argument("--users", type=int, default=100, help="Number of simultaneous virtual users (default 100).")
    p.add_argument("--api", default="http://127.0.0.1:8000", help="FastAPI base URL.")
    p.add_argument("--frontend", default="http://127.0.0.1:8080", help="Static frontend base URL.")
    p.add_argument("--timeout", type=float, default=90.0, help="Per-request timeout in seconds.")
    p.add_argument("--api-only", action="store_true", help="Skip frontend static pages even if they are up.")
    return p.parse_args()


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(run(parse_args())))
    except KeyboardInterrupt:
        print("Interrupted.")
        sys.exit(130)

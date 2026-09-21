"""
File: backend/ratelimit.py
Purpose: Per-IP sliding-window rate limiting for /api/* (not static files).

Two policies stack: a per-minute quota and a short per-second cap so a client
cannot spend the whole minute in one burst. Disable with RATE_LIMIT_ENABLED=0
for load tests.

Env (all optional)
------------------
  RATE_LIMIT_ENABLED          default on; 0/false/off/no disables
  RATE_LIMIT_API              e.g. 120/minute  (all /api/*)
  RATE_LIMIT_API_BURST        e.g. 20/second   (short-window cap)
  RATE_LIMIT_EXPENSIVE        e.g. 30/minute   (uncached / large endpoints)
  RATE_LIMIT_EXPENSIVE_BURST  e.g. 8/second
  RATE_LIMIT_TRUST_PROXY      default off; honor X-Forwarded-For / X-Real-IP
"""

from __future__ import annotations

import json
import os
import threading
import time
from collections import deque
from dataclasses import dataclass, field

from fastapi import Request
from fastapi.responses import Response
from starlette.middleware.base import BaseHTTPMiddleware

JSON_MEDIA = "application/json"
_DETAIL = "تعداد درخواست‌ها بیش از حد مجاز است. کمی بعد دوباره تلاش کنید."

_EXPENSIVE_PATHS = frozenset(
    {
        "/api/curtain/race",
        "/api/explorer/indicator",
        "/api/atlas/topic-trends",
        "/api/bubble/init",
        "/api/auth/login",
        "/api/auth/register",
    }
)

_RATE_UNITS = {
    "s": 1.0,
    "sec": 1.0,
    "second": 1.0,
    "seconds": 1.0,
    "m": 60.0,
    "min": 60.0,
    "minute": 60.0,
    "minutes": 60.0,
    "h": 3600.0,
    "hr": 3600.0,
    "hour": 3600.0,
    "hours": 3600.0,
}


def _env_enabled(name: str, default: bool = True) -> bool:
    raw = os.environ.get(name)
    if raw is None or not str(raw).strip():
        return default
    return str(raw).strip().lower() not in {"0", "false", "off", "no"}


def _parse_rate(raw: str | None, default: tuple[int, float]) -> tuple[int, float]:
    """Return (limit, window_seconds) from '120/minute' or a bare integer."""
    text = (raw or "").strip().lower().replace(" ", "")
    if not text:
        return default
    if "/" not in text:
        try:
            limit = int(text)
        except ValueError:
            return default
        if limit < 1:
            return default
        return limit, default[1]
    count_s, unit = text.split("/", 1)
    try:
        limit = int(count_s)
    except ValueError:
        return default
    window = _RATE_UNITS.get(unit)
    if window is None or limit < 1:
        return default
    return limit, window


@dataclass(frozen=True)
class Quota:
    name: str
    limit: int
    window: float


@dataclass(frozen=True)
class RateLimitConfig:
    enabled: bool
    trust_proxy: bool
    api: Quota
    api_burst: Quota
    expensive: Quota
    expensive_burst: Quota

    @classmethod
    def from_env(cls) -> RateLimitConfig:
        api_limit, api_window = _parse_rate(os.environ.get("RATE_LIMIT_API"), (120, 60.0))
        api_burst_limit, api_burst_window = _parse_rate(
            os.environ.get("RATE_LIMIT_API_BURST"), (20, 1.0)
        )
        exp_limit, exp_window = _parse_rate(
            os.environ.get("RATE_LIMIT_EXPENSIVE"), (30, 60.0)
        )
        exp_burst_limit, exp_burst_window = _parse_rate(
            os.environ.get("RATE_LIMIT_EXPENSIVE_BURST"), (8, 1.0)
        )
        return cls(
            enabled=_env_enabled("RATE_LIMIT_ENABLED", True),
            trust_proxy=_env_enabled("RATE_LIMIT_TRUST_PROXY", False),
            api=Quota("api", api_limit, api_window),
            api_burst=Quota("api_burst", api_burst_limit, api_burst_window),
            expensive=Quota("expensive", exp_limit, exp_window),
            expensive_burst=Quota("expensive_burst", exp_burst_limit, exp_burst_window),
        )


@dataclass
class _Window:
    times: deque[float] = field(default_factory=deque)


@dataclass(frozen=True)
class LimitDecision:
    allowed: bool
    quota: Quota
    remaining: int
    retry_after: int
    reset_unix: int


class SlidingWindowStore:
    """Thread-safe sliding windows with a hard cap so spoofed IPs cannot grow RAM."""

    def __init__(self, max_keys: int = 8192) -> None:
        self._lock = threading.Lock()
        self._windows: dict[str, _Window] = {}
        self._max_keys = max_keys
        self._ops = 0

    def consume(self, now: float, client: str, quotas: list[Quota]) -> LimitDecision:
        wall = time.time()
        with self._lock:
            self._ops += 1
            if self._ops % 64 == 0:
                self._prune(now)
            snapshots: list[tuple[Quota, _Window, int]] = []
            blocking: LimitDecision | None = None
            for quota in quotas:
                key = f"{client}:{quota.name}"
                window = self._windows.get(key)
                if window is None:
                    window = _Window()
                    self._evict_if_needed()
                    self._windows[key] = window
                cutoff = now - quota.window
                times = window.times
                while times and times[0] <= cutoff:
                    times.popleft()
                used = len(times)
                remaining = max(0, quota.limit - used)
                snapshots.append((quota, window, remaining))
                if remaining < 1 and blocking is None:
                    wait = quota.window - (now - times[0]) if times else quota.window
                    wait = max(0.05, wait)
                    retry = max(1, int(wait + 0.999))
                    blocking = LimitDecision(
                        allowed=False,
                        quota=quota,
                        remaining=0,
                        retry_after=retry,
                        reset_unix=int(wall + wait),
                    )
            if blocking is not None:
                return blocking
            tightest: LimitDecision | None = None
            for quota, window, remaining in snapshots:
                window.times.append(now)
                left = remaining - 1
                reset_s = quota.window
                if window.times:
                    reset_s = max(1.0, quota.window - (now - window.times[0]))
                decision = LimitDecision(
                    allowed=True,
                    quota=quota,
                    remaining=left,
                    retry_after=0,
                    reset_unix=int(wall + reset_s),
                )
                if tightest is None:
                    tightest = decision
                elif decision.quota.window > tightest.quota.window:
                    tightest = decision
                elif (
                    decision.quota.window == tightest.quota.window
                    and decision.remaining < tightest.remaining
                ):
                    tightest = decision
            return tightest or LimitDecision(
                allowed=True,
                quota=quotas[0],
                remaining=0,
                retry_after=0,
                reset_unix=int(wall + 1),
            )

    def _evict_if_needed(self) -> None:
        if len(self._windows) < self._max_keys:
            return
        oldest_key = min(
            self._windows,
            key=lambda k: self._windows[k].times[0] if self._windows[k].times else 0.0,
        )
        self._windows.pop(oldest_key, None)

    def _prune(self, now: float) -> None:
        stale = [
            key
            for key, window in self._windows.items()
            if not window.times or now - window.times[-1] > 1800
        ]
        for key in stale:
            self._windows.pop(key, None)


def _client_ip(request: Request, trust_proxy: bool) -> str:
    if trust_proxy:
        forwarded = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
        if forwarded:
            return forwarded
        real_ip = (request.headers.get("x-real-ip") or "").strip()
        if real_ip:
            return real_ip
    host = request.client.host if request.client else "unknown"
    if host.startswith("::ffff:"):
        return host[7:]
    return host or "unknown"


def _is_expensive(path: str) -> bool:
    normalized = path.rstrip("/") or "/"
    return normalized in _EXPENSIVE_PATHS


def _limit_headers(decision: LimitDecision, *, rejected: bool) -> dict[str, str]:
    quota = decision.quota
    reset_s = (
        decision.retry_after
        if rejected
        else max(1, decision.reset_unix - int(time.time()))
    )
    headers = {
        "RateLimit-Policy": f"{quota.limit};w={int(quota.window)}",
        "RateLimit": (
            f"limit={quota.limit}, remaining={decision.remaining}, reset={reset_s}"
        ),
        "X-RateLimit-Limit": str(quota.limit),
        "X-RateLimit-Remaining": str(decision.remaining),
        "X-RateLimit-Reset": str(decision.reset_unix),
    }
    if rejected:
        headers["Retry-After"] = str(decision.retry_after)
        headers["Cache-Control"] = "no-store"
    return headers


def _reject(decision: LimitDecision) -> Response:
    return Response(
        content=json.dumps({"detail": _DETAIL}, ensure_ascii=False).encode("utf-8"),
        status_code=429,
        media_type=JSON_MEDIA,
        headers=_limit_headers(decision, rejected=True),
    )


class RateLimitMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, config: RateLimitConfig | None = None) -> None:
        super().__init__(app)
        self.config = config or RateLimitConfig.from_env()
        self.store = SlidingWindowStore()

    async def dispatch(self, request: Request, call_next):
        config = self.config
        if not config.enabled or request.method == "OPTIONS":
            return await call_next(request)
        path = request.url.path
        if not path.startswith("/api/"):
            return await call_next(request)

        quotas = [config.api, config.api_burst]
        if _is_expensive(path):
            quotas.extend((config.expensive, config.expensive_burst))
        try:
            decision = self.store.consume(
                time.monotonic(),
                _client_ip(request, config.trust_proxy),
                quotas,
            )
        except Exception:
            return await call_next(request)

        if not decision.allowed:
            return _reject(decision)

        response = await call_next(request)
        for name, value in _limit_headers(decision, rejected=False).items():
            response.headers.setdefault(name, value)
        return response

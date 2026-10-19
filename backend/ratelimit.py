"""
File: backend/ratelimit.py
Purpose: Per-IP sliding-window rate limiting for /api/* (not static files).

Two policies stack: a per-minute quota and a short per-second cap so a client
cannot spend the whole minute in one burst. Rejections last only until the
exceeded sliding window has capacity again. Disable with RATE_LIMIT_ENABLED=0 for load tests.

Env (all optional)
------------------
  RATE_LIMIT_ENABLED          default on; 0/false/off/no disables
  RATE_LIMIT_API              e.g. 120/minute  (all /api/*)
  RATE_LIMIT_API_BURST        e.g. 20/second   (short-window cap)
  RATE_LIMIT_EXPENSIVE        e.g. 30/minute   (uncached / large endpoints)
  RATE_LIMIT_EXPENSIVE_BURST  e.g. 8/second

Client IP comes from the ASGI connection scope. Configure Uvicorn to trust only
the Nginx peer and have Nginx replace incoming X-Forwarded-For headers.
"""

from __future__ import annotations

import json
import logging
import math
import os
import threading
import time
from collections import deque
from dataclasses import dataclass, field, replace

from fastapi import Request
from fastapi.responses import Response
from starlette.middleware.base import BaseHTTPMiddleware

log = logging.getLogger("backend.ratelimit")

JSON_MEDIA = "application/json"

_EXPENSIVE_PATHS = frozenset(
    {
        "/api/curtain/race",
        "/api/admin/avatars/export",
        "/api/explorer/indicator",
        "/api/atlas/topic-trends",
        "/api/bubble/init",
        "/api/auth/login",
        "/api/auth/captcha",
        "/api/auth/register",
        "/api/auth/gate",
        "/api/auth/otp/send",
        "/api/auth/otp/verify",
        "/api/auth/password/reset",
        "/api/auth/profile/avatar",
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
    api: Quota
    api_burst: Quota
    expensive: Quota
    expensive_burst: Quota
    support: Quota = Quota("support", 20, 60.0)
    support_burst: Quota = Quota("support_burst", 5, 1.0)
    support_create: Quota = Quota("support_create", 10, 3600.0)

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
            api=Quota("api", api_limit, api_window),
            api_burst=Quota("api_burst", api_burst_limit, api_burst_window),
            expensive=Quota("expensive", exp_limit, exp_window),
            expensive_burst=Quota("expensive_burst", exp_burst_limit, exp_burst_window),
        )


@dataclass
class _Window:
    times: deque[float] = field(default_factory=deque)
    window_seconds: float = 60.0


@dataclass(frozen=True)
class LimitDecision:
    allowed: bool
    quota: Quota
    remaining: int
    retry_after: int
    reset_unix: int
    cooldown_started: bool = False


class SlidingWindowStore:
    """Thread-safe sliding windows; rejected attempts do not extend a restriction."""

    def __init__(self, max_keys: int = 8192) -> None:
        self._lock = threading.Lock()
        self._windows: dict[str, _Window] = {}
        self._cooldowns: dict[str, tuple[float, Quota]] = {}
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
                    window = _Window(window_seconds=quota.window)
                    self._evict_if_needed()
                    self._windows[key] = window
                cutoff = now - quota.window
                times = window.times
                while times and times[0] <= cutoff:
                    times.popleft()
                used = len(times)
                remaining = max(0, quota.limit - used)
                snapshots.append((quota, window, remaining))
                if remaining < 1:
                    wait = quota.window - (now - times[0]) if times else quota.window
                    wait = max(0.05, wait)
                    retry = max(1, int(wait + 0.999))
                    candidate = LimitDecision(
                        allowed=False,
                        quota=quota,
                        remaining=0,
                        retry_after=retry,
                        reset_unix=math.ceil(wall + wait),
                    )
                    if blocking is None or candidate.retry_after > blocking.retry_after:
                        blocking = candidate
            if blocking is not None:
                # This bounded map suppresses duplicate log lines; it never enforces a ban.
                notice_key = f"{client}:{blocking.quota.name}"
                previous = self._cooldowns.get(notice_key)
                first = previous is None or previous[0] <= now
                if first:
                    if len(self._cooldowns) >= self._max_keys:
                        oldest = min(self._cooldowns, key=lambda key: self._cooldowns[key][0])
                        self._cooldowns.pop(oldest, None)
                    self._cooldowns[notice_key] = (now + blocking.retry_after, blocking.quota)
                return replace(blocking, cooldown_started=first)
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
            if not window.times or now - window.times[-1] >= window.window_seconds
        ]
        for key in stale:
            self._windows.pop(key, None)
        expired_cooldowns = [client for client, (until, _) in self._cooldowns.items() if until <= now]
        for client in expired_cooldowns:
            self._cooldowns.pop(client, None)


def _client_ip(request: Request) -> str:
    """Use only the address resolved by the server's trusted-proxy policy."""
    host = request.client.host if request.client else "unknown"
    if host.startswith("::ffff:"):
        return host[7:]
    return host or "unknown"


def _is_expensive(path: str) -> bool:
    normalized = path.rstrip("/") or "/"
    return normalized in _EXPENSIVE_PATHS or (
        normalized.startswith("/api/auth/captcha/") and normalized.endswith("/image")
    )


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
    wait = decision.retry_after
    if wait >= 60:
        detail = f"تعداد درخواست‌ها بیش از حد مجاز است. {math.ceil(wait / 60)} دقیقه دیگر دوباره تلاش کنید."
    else:
        detail = f"تعداد درخواست‌ها بیش از حد مجاز است. {wait} ثانیه دیگر دوباره تلاش کنید."
    return Response(
        content=json.dumps({"detail": {"code": "rate-limit", "message": detail, "retry_after": wait}, "retry_after": wait}, ensure_ascii=False).encode("utf-8"),
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

        client_ip = _client_ip(request)
        if path.startswith("/api/support/"):
            quotas = [config.support, config.support_burst]
            if path == "/api/support/tickets" and request.method == "POST":
                quotas.append(config.support_create)
            client_key = "support:" + client_ip
        else:
            quotas = [config.api, config.api_burst]
            if path.rstrip("/") == "/api/account/ticket-attachments" and request.method == "POST":
                quotas.extend((Quota("attachment-minute", 12, 60), Quota("attachment-burst", 2, 1)))
            if path.rstrip("/") == "/api/account/tickets" and request.method == "POST":
                quotas.append(config.support_create)
            if _is_expensive(path):
                quotas.extend((config.expensive, config.expensive_burst))
            client_key = "api:" + client_ip
        try:
            decision = self.store.consume(
                time.monotonic(),
                client_key,
                quotas,
            )
        except Exception:
            return await call_next(request)

        if not decision.allowed:
            if decision.cooldown_started:
                log.warning(
                    "rate_limit_window_started client_ip=%s path=%s quota=%s "
                    "limit=%s window_seconds=%s retry_after_seconds=%s forwarded_for_present=%s",
                    client_ip, path, decision.quota.name, decision.quota.limit,
                    decision.quota.window, decision.retry_after,
                    bool(request.headers.get("x-forwarded-for")),
                )
            return _reject(decision)

        response = await call_next(request)
        for name, value in _limit_headers(decision, rejected=False).items():
            response.headers.setdefault(name, value)
        return response

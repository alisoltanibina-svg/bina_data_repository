"""Cloudflare Turnstile configuration and server-side verification for login."""

from __future__ import annotations

import json
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from backend.settings import get_settings

VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
LOGIN_ACTION = "login"


class TurnstileError(RuntimeError):
    """A challenge was absent, invalid, expired, reused, or could not be verified."""


def public_config() -> dict[str, object]:
    settings = get_settings()
    if not settings.turnstile_enabled:
        return {"enabled": False}
    return {"enabled": True, "site_key": settings.turnstile_site_key, "action": LOGIN_ACTION}


def verify_login_token(token: str) -> None:
    """Fail closed after checking a fresh Turnstile token with Cloudflare."""
    settings = get_settings()
    if not settings.turnstile_enabled:
        return
    value = (token or "").strip()
    if not value or len(value) > 2048:
        raise TurnstileError("تأیید امنیتی را انجام دهید.")

    payload = urlencode({"secret": settings.turnstile_secret.get_secret_value(), "response": value}).encode("ascii")
    request = Request(VERIFY_URL, data=payload, method="POST")
    request.add_header("Content-Type", "application/x-www-form-urlencoded")
    try:
        with urlopen(request, timeout=5) as response:  # nosec B310: fixed HTTPS endpoint
            result = json.loads(response.read().decode("utf-8"))
    except (URLError, TimeoutError, OSError, ValueError) as exc:
        raise TurnstileError("تأیید امنیتی موقتاً در دسترس نیست. دوباره تلاش کنید.") from exc

    expected_hosts = set(settings.turnstile_hostname_list)
    if not isinstance(result, dict):
        raise TurnstileError("تأیید امنیتی نامعتبر است. دوباره تلاش کنید.")
    if (
        not result.get("success")
        or result.get("action") != LOGIN_ACTION
        or str(result.get("hostname") or "").lower() not in expected_hosts
    ):
        raise TurnstileError("تأیید امنیتی نامعتبر، منقضی یا استفاده‌شده است. دوباره تلاش کنید.")
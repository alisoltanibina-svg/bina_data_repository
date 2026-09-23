"""Append-only debug log for /api/auth/* failures. No passwords, OTP codes, or API keys."""

from __future__ import annotations

import logging
import sys
import traceback
from datetime import datetime, timezone

from backend.settings import PROJECT_ROOT

log = logging.getLogger("backend.auth")
AUTH_DEBUG_LOG = PROJECT_ROOT / "auth_debug.log"
_FA_DIGITS = str.maketrans("۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩", "01234567890123456789")


def mask_phone(phone: str) -> str:
    digits = "".join(ch for ch in (phone or "").translate(_FA_DIGITS) if ch.isdigit())
    if len(digits) < 7:
        return "***"
    return digits[:4] + "***" + digits[-3:]


def write_auth_log(line: str, exc: BaseException | None = None) -> None:
    """Never raise: a log failure must not turn a real auth error into a blank 500."""
    try:
        stamp = datetime.now(timezone.utc).isoformat()
        parts = [f"{stamp} {line}"]
        if exc is not None:
            parts.append(f"exc_type={type(exc).__name__} exc={exc!s}")
            parts.append("".join(traceback.format_exception(type(exc), exc, exc.__traceback__)))
        text = "\n".join(parts).rstrip() + "\n"
        try:
            log.error("%s", line)
        except Exception:
            pass
        try:
            print("AUTH_DEBUG " + text, end="", file=sys.stderr, flush=True)
        except Exception:
            pass
        try:
            with AUTH_DEBUG_LOG.open("a", encoding="utf-8") as handle:
                handle.write(text)
        except OSError as err:
            try:
                print(f"AUTH_DEBUG file write failed path={AUTH_DEBUG_LOG} err={err}", file=sys.stderr, flush=True)
            except Exception:
                pass
    except Exception:
        pass

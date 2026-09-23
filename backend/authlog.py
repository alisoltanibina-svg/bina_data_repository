"""Append-only debug log for /api/auth/* failures. No passwords, OTP codes, or API keys."""

from __future__ import annotations

import logging
import traceback
from datetime import datetime, timezone

from backend.settings import PROJECT_ROOT

log = logging.getLogger("backend.auth")
AUTH_DEBUG_LOG = PROJECT_ROOT / "auth_debug.log"


def mask_phone(phone: str) -> str:
    digits = "".join(ch for ch in (phone or "") if ch.isdigit())
    if len(digits) < 7:
        return "***"
    return digits[:4] + "***" + digits[-3:]


def write_auth_log(line: str, exc: BaseException | None = None) -> None:
    stamp = datetime.now(timezone.utc).isoformat()
    parts = [f"{stamp} {line}"]
    if exc is not None:
        parts.append(f"exc_type={type(exc).__name__} exc={exc!s}")
        parts.append(traceback.format_exc())
    text = "\n".join(parts).rstrip() + "\n"
    log.error("%s", line)
    try:
        with AUTH_DEBUG_LOG.open("a", encoding="utf-8") as handle:
            handle.write(text)
    except OSError:
        pass

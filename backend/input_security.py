"""Bound user input and reject cross-site mutations before parsing request bodies."""
from __future__ import annotations
import asyncio
import json
import re
import time
import unicodedata
from pydantic import BaseModel, ConfigDict, field_validator, ValidationInfo
from starlette.responses import JSONResponse


def safe_text(value: str, *, multiline: bool = False) -> str:
    for char in value:
        if unicodedata.category(char) in {"Cc", "Cs"} and not (multiline and char in "\n\r\t"):
            raise ValueError("Unsupported control character")
        if char in "\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069":
            raise ValueError("Unsupported direction override")
    return value


class InputBody(BaseModel):
    model_config = ConfigDict(extra="forbid", str_max_length=4000)

    @field_validator("*", mode="after")
    @classmethod
    def validate_text(cls, value, info: ValidationInfo):
        # Preserve existing password semantics; never apply text sanitization to secrets.
        if isinstance(value, str):
            if any(unicodedata.category(char) == "Cs" for char in value):
                raise ValueError("Invalid Unicode")
            if info.field_name not in {"password", "password_confirm"}:
                return safe_text(value, multiline=info.field_name in {"message", "address", "note"})
        return value


class InputSecurityMiddleware:
    """A bounded pre-parser for JSON/multipart; raw uploads have a streamed route cap."""
    def __init__(self, app, allowed_origins):
        self.app = app
        self.allowed_origins = frozenset(origin.rstrip("/") for origin in allowed_origins)

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope.get("path", "").startswith("/api/"):
            return await self.app(scope, receive, send)
        path = scope["path"]
        headers = {key.lower(): value.decode("latin-1") for key, value in scope.get("headers", [])}
        async def reject(status, code, message):
            response = JSONResponse({"detail": {"code": code, "message": message}}, status_code=status, headers={"Cache-Control": "no-store"})
            await response(scope, receive, send)
        if len(scope.get("query_string", b"")) > 4096 or len(path) > 2048:
            return await reject(414, "input-limit", "نشانی درخواست بیش از حد طولانی است.")
        if scope["method"] in {"GET", "HEAD", "OPTIONS"}:
            return await self.app(scope, receive, send)
        origin = headers.get(b"origin")
        host = headers.get(b"host", "")
        own = scope.get("scheme", "http") + "://" + host
        if origin:
            # Explicit Origin is authoritative. Do not trust a custom header from an untrusted origin.
            if origin == "null" or origin not in self.allowed_origins | {own}:
                return await reject(403, "csrf", "مبدأ درخواست معتبر نیست. صفحه را دوباره باز کنید.")
        elif headers.get(b"sec-fetch-site") == "cross-site":
            return await reject(403, "csrf", "درخواست از این صفحه مجاز نیست.")
        elif "bina_session=" in headers.get(b"cookie", "") and headers.get(b"x-csrf-protection") != "1":
            return await reject(403, "csrf", "صفحه را تازه‌سازی کنید و دوباره تلاش کنید.")
        if headers.get(b"content-encoding", "identity").lower() not in {"", "identity"}:
            return await reject(415, "input-format", "قالب درخواست پشتیبانی نمی‌شود.")
        raw_upload = path.rstrip("/") == "/api/account/ticket-attachments" and scope["method"] == "POST"
        avatar = bool(re.fullmatch(r"/api/(?:auth/profile|admin/users/\d+)/avatar", path)) and scope["method"] == "POST"
        maximum = 5 * 1024 * 1024 if raw_upload else 6 * 1024 * 1024 if avatar else 64 * 1024
        try:
            length = int(headers.get(b"content-length", "0"))
            if length < 0: raise ValueError()
        except ValueError:
            return await reject(400, "input-limit", "حجم درخواست معتبر نیست.")
        if length > maximum:
            return await reject(413, "input-limit", "حجم درخواست بیش از حد مجاز است.")
        kind = headers.get(b"content-type", "").split(";", 1)[0].lower()
        if raw_upload:
            if kind != "application/octet-stream" or headers.get(b"x-csrf-protection") != "1":
                return await reject(415, "input-format", "قالب بارگذاری معتبر نیست. صفحه را تازه‌سازی کنید.")
            return await self.app(scope, receive, send)
        if kind and kind != "application/json" and not (avatar and kind == "multipart/form-data"):
            return await reject(415, "input-format", "قالب درخواست معتبر نیست.")
        chunks = []
        total = 0
        deadline = time.monotonic() + 30
        while True:
            try:
                packet = await asyncio.wait_for(receive(), timeout=max(.01, deadline-time.monotonic()))
            except asyncio.TimeoutError:
                return await reject(408, "input-timeout", "زمان ارسال درخواست تمام شد.")
            if packet["type"] == "http.disconnect": return
            data = packet.get("body", b"")
            total += len(data)
            if total > maximum:
                return await reject(413, "input-limit", "حجم درخواست بیش از حد مجاز است.")
            chunks.append(data)
            if not packet.get("more_body", False): break
        if total and not kind:
            return await reject(415, "input-format", "قالب درخواست معتبر نیست.")
        body = b"".join(chunks)
        if body and kind == "application/json":
            def unique_object(pairs):
                result = {}
                for key, value in pairs:
                    if key in result: raise ValueError("Duplicate field")
                    result[key] = value
                return result
            def invalid_constant(value):
                raise ValueError("Non-standard JSON number")
            try:
                decoded = json.loads(body, object_pairs_hook=unique_object, parse_constant=invalid_constant)
                if not isinstance(decoded, dict): raise ValueError("Object required")
                pending = [(decoded, 0)]
                while pending:
                    value, depth = pending.pop()
                    if depth > 32: raise ValueError("JSON nesting limit")
                    if isinstance(value, dict):
                        pending.extend((item, depth + 1) for item in value.values())
                    elif isinstance(value, list):
                        pending.extend((item, depth + 1) for item in value)
            except (ValueError, UnicodeError, RecursionError):
                return await reject(400, "input-format", "قالب اطلاعات ارسال‌شده معتبر نیست.")
        replayed = False
        async def replay():
            nonlocal replayed
            if not replayed:
                replayed = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()
        return await self.app(scope, replay, send)

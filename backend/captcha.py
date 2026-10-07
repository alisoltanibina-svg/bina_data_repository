"""First-party, single-use image CAPTCHA challenges for authentication flows."""

from __future__ import annotations

import hashlib
import hmac
import io
import re
import secrets
from datetime import datetime, timedelta, timezone

from PIL import Image, ImageDraw, ImageFont
from sqlalchemy import delete, func, select, text, update

from backend.database import db_session
from backend.membership import is_mobile_phone, lookup_auth_gate, normalize_phone
from backend.models import CaptchaChallenge
from backend.settings import get_settings

CAPTCHA_PURPOSES = frozenset({"login", "register", "reset"})
CAPTCHA_LENGTH = 5
CAPTCHA_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
CAPTCHA_ID_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")


class CaptchaError(RuntimeError):
    pass


class CaptchaRateLimit(CaptchaError):
    pass


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _hmac(label: str, value: str) -> str:
    secret = get_settings().captcha_hmac_secret.get_secret_value().encode("utf-8")
    return hmac.new(secret, f"{label}:{value}".encode("utf-8"), hashlib.sha256).hexdigest()


def _answer_hash(challenge_id: str, answer: str) -> str:
    return _hmac("answer", f"{challenge_id}:{answer}")


def _binding_hash(purpose: str, phone: str) -> str:
    return _hmac(f"captcha-{purpose}-phone", phone)


def _ip_hash(client_ip: str) -> str:
    return _hmac("captcha-ip", client_ip or "unknown")


def _new_answer() -> str:
    return "".join(secrets.choice(CAPTCHA_ALPHABET) for _ in range(CAPTCHA_LENGTH))


def _font(size: int):
    try:
        return ImageFont.truetype("DejaVuSans-Bold.ttf", size)
    except OSError:
        return ImageFont.load_default()


def _captcha_png(answer: str) -> bytes:
    """Use readable text with varied placement, rotation, lines, and dots."""
    width, height = 220, 76
    image = Image.new("RGB", (width, height), (247, 242, 226))
    draw = ImageDraw.Draw(image)
    for _ in range(11):
        draw.line(
            (
                secrets.randbelow(width), secrets.randbelow(height),
                secrets.randbelow(width), secrets.randbelow(height),
            ),
            fill=(185, 171, 123),
            width=1 + secrets.randbelow(2),
        )
    for _ in range(70):
        x, y = secrets.randbelow(width), secrets.randbelow(height)
        draw.ellipse((x, y, x + 2, y + 2), fill=(203, 191, 150))

    font = _font(43)
    for index, char in enumerate(answer):
        glyph = Image.new("RGBA", (52, 62), (0, 0, 0, 0))
        glyph_draw = ImageDraw.Draw(glyph)
        glyph_draw.text(
            (8 + secrets.randbelow(5), 3 + secrets.randbelow(8)),
            char,
            font=font,
            fill=(61, 70, 26, 255),
        )
        glyph = glyph.rotate(secrets.randbelow(17) - 8, resample=Image.Resampling.BICUBIC)
        image.paste(glyph, (8 + index * 42, 6 + secrets.randbelow(7)), glyph)

    output = io.BytesIO()
    image.save(output, format="PNG", optimize=True)
    return output.getvalue()


def cleanup_expired_challenges(now: datetime | None = None) -> int:
    """Delete CAPTCHA data that can no longer be used.

    A consumed challenge is retained only until its normal expiration time. This
    keeps the rate-limit window intact while ensuring the PNG payloads do not
    accumulate indefinitely.
    """
    cutoff = now or _now()
    with db_session() as session:
        result = session.execute(
            delete(CaptchaChallenge).where(CaptchaChallenge.expires_at <= cutoff)
        )
        return int(result.rowcount or 0)


def issue_challenge(phone_raw: str, purpose: str, client_ip: str) -> dict[str, object]:
    phone = normalize_phone(phone_raw)
    if not is_mobile_phone(phone) or purpose not in CAPTCHA_PURPOSES:
        raise CaptchaError("Invalid CAPTCHA request")
    # Reset and password challenges only exist for an established login account.
    if purpose in {"login", "reset"} and lookup_auth_gate(phone) != "login":
        raise CaptchaError("Invalid CAPTCHA request")

    settings = get_settings()
    now = _now()
    cutoff = now - timedelta(minutes=10)
    binding = _binding_hash(purpose, phone)
    ip = _ip_hash(client_ip)
    with db_session() as session:
        # Serializes issuance for one intended operation/account binding.
        session.execute(text("SELECT pg_advisory_xact_lock(hashtext(:key))"), {"key": f"captcha:{binding}"})
        phone_count = session.scalar(
            select(func.count()).select_from(CaptchaChallenge).where(
                CaptchaChallenge.purpose == purpose,
                CaptchaChallenge.binding_hash == binding,
                CaptchaChallenge.created_at >= cutoff,
            )
        ) or 0
        ip_count = session.scalar(
            select(func.count()).select_from(CaptchaChallenge).where(
                CaptchaChallenge.purpose == purpose,
                CaptchaChallenge.ip_hash == ip,
                CaptchaChallenge.created_at >= cutoff,
            )
        ) or 0
        if phone_count >= settings.captcha_max_per_phone or ip_count >= settings.captcha_max_per_ip:
            raise CaptchaRateLimit("Please wait before requesting another CAPTCHA")

        challenge_id = secrets.token_urlsafe(32)
        answer = _new_answer()
        session.add(
            CaptchaChallenge(
                id=challenge_id,
                purpose=purpose,
                binding_hash=binding,
                ip_hash=ip,
                answer_hmac=_answer_hash(challenge_id, answer),
                image_png=_captcha_png(answer),
                expires_at=now + timedelta(seconds=settings.captcha_ttl_seconds),
                created_at=now,
            )
        )
    return {"captcha_id": challenge_id, "expires_in_seconds": settings.captcha_ttl_seconds}


def captcha_image(challenge_id: str) -> bytes | None:
    if not CAPTCHA_ID_RE.fullmatch(challenge_id or ""):
        return None
    with db_session() as session:
        row = session.scalar(
            select(CaptchaChallenge).where(
                CaptchaChallenge.id == challenge_id,
                CaptchaChallenge.purpose.in_(CAPTCHA_PURPOSES),
                CaptchaChallenge.consumed_at.is_(None),
                CaptchaChallenge.expires_at > _now(),
            )
        )
        return bytes(row.image_png) if row is not None else None


def verify_challenge(challenge_id: str, answer_raw: str, phone_raw: str, purpose: str) -> bool:
    phone = normalize_phone(phone_raw)
    answer = (answer_raw or "").strip().upper()
    if not (
        CAPTCHA_ID_RE.fullmatch(challenge_id or "")
        and purpose in CAPTCHA_PURPOSES
        and is_mobile_phone(phone)
        and len(answer) == CAPTCHA_LENGTH
        and all(char in CAPTCHA_ALPHABET for char in answer)
    ):
        return False

    now = _now()
    with db_session() as session:
        # Consume on every attempt, successful or not, to prevent answer guessing.
        stored_hmac = session.execute(
            update(CaptchaChallenge)
            .where(
                CaptchaChallenge.id == challenge_id,
                CaptchaChallenge.purpose == purpose,
                CaptchaChallenge.binding_hash == _binding_hash(purpose, phone),
                CaptchaChallenge.consumed_at.is_(None),
                CaptchaChallenge.expires_at > now,
            )
            .values(consumed_at=now, attempts=CaptchaChallenge.attempts + 1)
            .returning(CaptchaChallenge.answer_hmac)
        ).scalar_one_or_none()
    return stored_hmac is not None and hmac.compare_digest(stored_hmac, _answer_hash(challenge_id, answer))
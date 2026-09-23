"""SMS OTP for registration and password reset. Not used as a login method."""

from __future__ import annotations

import hashlib
import json
import logging
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen

from sqlalchemy import select

from backend.database import db_session
from backend.membership import MembershipError, is_mobile_phone, normalize_phone
from backend.models import OtpChallenge, RegistrationRequest, User
from backend.settings import PROJECT_ROOT, get_settings

log = logging.getLogger("backend.otp")
OTP_DEBUG_LOG = PROJECT_ROOT / "kavenegar_otp.log"

PURPOSES = frozenset({"register", "reset"})
DEV_OTP = "123456"
_DEFAULT_MESSAGE = "سامانه دیده‌بان فرهنگ\nکد ورود شما: {code}"


def _mask_phone(phone: str) -> str:
    if len(phone) < 7:
        return "***"
    return phone[:4] + "***" + phone[-3:]


def _hash_code(salt: str, code: str) -> str:
    return hashlib.sha256(f"{salt}:{code}".encode("utf-8")).hexdigest()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _active_user(session, phone: str) -> User | None:
    user = session.execute(
        select(User).where(User.phone == phone)
    ).scalar_one_or_none()
    if user is None or user.is_active is False:
        return None
    return user


def _assert_send_allowed(session, phone: str, purpose: str) -> None:
    user = _active_user(session, phone)
    if purpose == "register":
        if user is not None:
            raise MembershipError("exists", "برای این شماره قبلاً حساب پذیرفته شده است.")
        pending = session.execute(
            select(RegistrationRequest).where(
                RegistrationRequest.phone == phone,
                RegistrationRequest.status == "pending",
            )
        ).scalar_one_or_none()
        if pending is not None:
            raise MembershipError("pending", "برای این شماره یک درخواست در انتظار بررسی است.")
        rejected = session.execute(
            select(RegistrationRequest)
            .where(
                RegistrationRequest.phone == phone,
                RegistrationRequest.status == "rejected",
            )
            .order_by(RegistrationRequest.created_at.desc())
        ).scalars().first()
        if rejected is not None:
            raise MembershipError("rejected", "درخواست عضویت این شماره پذیرفته نشده است.")
        return
    if purpose == "reset":
        if user is None:
            raise MembershipError("not-found", "حسابی با این شماره پیدا نشد.")
        return
    raise MembershipError("otp", "نوع درخواست نامعتبر است.")


def _kavenegar_key() -> str:
    raw = get_settings().kavenegar_api_key.get_secret_value().strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in {"'", '"'}:
        raw = raw[1:-1].strip()
    return raw


def _kavenegar_configured() -> bool:
    return bool(_kavenegar_key())


def _build_message(code: str) -> str:
    template = (get_settings().kavenegar_otp_message or "").strip() or _DEFAULT_MESSAGE
    if "{code}" not in template:
        template = _DEFAULT_MESSAGE
    return template.replace("{code}", code)


def _redact_url(url: str) -> str:
    parts = urlsplit(url)
    path = parts.path
    segs = path.split("/")
    if len(segs) >= 3 and segs[1] == "v1":
        segs[2] = "***"
        path = "/".join(segs)
    query = []
    for key, value in parse_qsl(parts.query, keep_blank_values=True):
        if key == "message":
            query.append((key, f"<redacted len={len(value)}>"))
        elif key == "receptor" and len(value) >= 7:
            query.append((key, _mask_phone(value)))
        else:
            query.append((key, value))
    return urlunsplit((parts.scheme, parts.netloc, path, urlencode(query), ""))


def _write_otp_log(line: str) -> None:
    stamp = _now().isoformat()
    text = f"{stamp} {line}\n"
    log.error("%s", line)
    try:
        with OTP_DEBUG_LOG.open("a", encoding="utf-8") as handle:
            handle.write(text)
    except OSError:
        pass


def _send_kavenegar(phone: str, text: str) -> None:
    key = _kavenegar_key()
    sender = (get_settings().kavenegar_sender or "").strip()
    params = {"receptor": phone, "message": text}
    if sender:
        params["sender"] = sender
    url = f"https://api.kavenegar.com/v1/{key}/sms/send.json?{urlencode(params)}"
    _write_otp_log(
        "kavenegar request "
        f"phone={_mask_phone(phone)} key_len={len(key)} sender_set={bool(sender)} "
        f"message_len={len(text)} url={_redact_url(url)}"
    )
    request = Request(url, method="GET")
    try:
        with urlopen(request, timeout=15) as response:
            raw = response.read().decode("utf-8", errors="replace")
            http_status = getattr(response, "status", None) or response.getcode()
    except HTTPError as err:
        body = ""
        try:
            body = err.read().decode("utf-8", errors="replace")[:2000]
        except OSError:
            body = ""
        _write_otp_log(
            "kavenegar HTTPError "
            f"http_status={err.code} reason={err.reason!s} body={body!r}"
        )
        raise MembershipError("otp", "ارسال پیامک ممکن نشد.") from None
    except (URLError, TimeoutError, OSError) as err:
        _write_otp_log(f"kavenegar network error type={type(err).__name__} detail={err!s}")
        raise MembershipError("otp", "ارسال پیامک ممکن نشد.") from None
    except (ValueError, json.JSONDecodeError) as err:
        _write_otp_log(f"kavenegar decode error type={type(err).__name__} detail={err!s}")
        raise MembershipError("otp", "ارسال پیامک ممکن نشد.") from None

    _write_otp_log(f"kavenegar HTTP {http_status} body={raw[:2000]!r}")
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as err:
        _write_otp_log(f"kavenegar JSON parse failed detail={err!s}")
        raise MembershipError("otp", "ارسال پیامک ممکن نشد.") from None
    status = ((payload or {}).get("return") or {}).get("status")
    message = ((payload or {}).get("return") or {}).get("message")
    if status != 200:
        _write_otp_log(f"kavenegar API status={status} message={message!s}")
        raise MembershipError("otp", "ارسال پیامک ممکن نشد.")
    _write_otp_log(f"kavenegar OK status={status}")


def send_otp(phone: str, purpose: str) -> dict:
    phone = normalize_phone(phone)
    purpose = (purpose or "").strip()
    if not is_mobile_phone(phone):
        raise MembershipError("phone", "شماره موبایل نامعتبر است.")
    if purpose not in PURPOSES:
        raise MembershipError("otp", "نوع درخواست نامعتبر است.")

    settings = get_settings()
    ttl = max(120, min(int(settings.otp_ttl_seconds or 180), 300))
    cooldown = max(20, int(settings.otp_resend_seconds or 60))
    now = _now()

    with db_session() as session:
        _assert_send_allowed(session, phone, purpose)
        latest = session.execute(
            select(OtpChallenge)
            .where(
                OtpChallenge.phone == phone,
                OtpChallenge.purpose == purpose,
            )
            .order_by(OtpChallenge.created_at.desc())
        ).scalars().first()
        if latest is not None and latest.consumed_at is None:
            created = latest.created_at or now
            if created.tzinfo is None:
                created = created.replace(tzinfo=timezone.utc)
            wait = cooldown - int((now - created).total_seconds())
            if wait > 0:
                raise MembershipError("cooldown", f"برای ارسال دوباره {wait} ثانیه صبر کنید.")
        open_rows = session.execute(
            select(OtpChallenge).where(
                OtpChallenge.phone == phone,
                OtpChallenge.purpose == purpose,
                OtpChallenge.consumed_at.is_(None),
            )
        ).scalars().all()
        for row in open_rows:
            row.consumed_at = now

    code = DEV_OTP if not _kavenegar_configured() else f"{secrets.randbelow(1_000_000):06d}"
    if _kavenegar_configured():
        _send_kavenegar(phone, _build_message(code))
    else:
        log.info("otp send skipped (no API key) phone=%s purpose=%s", _mask_phone(phone), purpose)

    salt = secrets.token_hex(8)
    with db_session() as session:
        session.add(
            OtpChallenge(
                phone=phone,
                purpose=purpose,
                salt=salt,
                code_hash=_hash_code(salt, code),
                expires_at=now + timedelta(seconds=ttl),
                attempts=0,
            )
        )
    return {"ok": True, "ttl_seconds": ttl, "resend_seconds": cooldown}


def verify_otp(phone: str, purpose: str, code: str) -> dict:
    phone = normalize_phone(phone)
    purpose = (purpose or "").strip()
    code = "".join(ch for ch in (code or "") if ch.isdigit())
    if not is_mobile_phone(phone):
        raise MembershipError("phone", "شماره موبایل نامعتبر است.")
    if purpose not in PURPOSES:
        raise MembershipError("otp", "نوع درخواست نامعتبر است.")
    if len(code) != 6:
        raise MembershipError("otp", "کد باید ۶ رقم باشد.")

    settings = get_settings()
    max_attempts = max(3, int(settings.otp_max_attempts or 5))
    now = _now()

    with db_session() as session:
        row = session.execute(
            select(OtpChallenge)
            .where(
                OtpChallenge.phone == phone,
                OtpChallenge.purpose == purpose,
                OtpChallenge.consumed_at.is_(None),
            )
            .order_by(OtpChallenge.created_at.desc())
        ).scalars().first()
        if row is None:
            raise MembershipError("otp", "کد نامعتبر است.")
        expires_at = row.expires_at
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        if expires_at < now:
            raise MembershipError("otp", "کد منقضی شده است. دوباره ارسال کنید.")
        if int(row.attempts or 0) >= max_attempts:
            raise MembershipError("otp", "تعداد تلاش بیش از حد است. دوباره ارسال کنید.")
        if _hash_code(row.salt, code) != row.code_hash:
            row.attempts = int(row.attempts or 0) + 1
            raise MembershipError("otp", "کد نامعتبر است.")
        row.verified_at = now
        row.attempts = int(row.attempts or 0) + 1
    return {"ok": True, "purpose": purpose}


def consume_verified_otp_in_session(session, phone: str, purpose: str) -> None:
    phone = normalize_phone(phone)
    purpose = (purpose or "").strip()
    now = _now()
    row = session.execute(
        select(OtpChallenge)
        .where(
            OtpChallenge.phone == phone,
            OtpChallenge.purpose == purpose,
            OtpChallenge.consumed_at.is_(None),
            OtpChallenge.verified_at.is_not(None),
        )
        .order_by(OtpChallenge.created_at.desc())
    ).scalars().first()
    if row is None:
        raise MembershipError("otp", "ابتدا کد پیامک را تأیید کنید.")
    expires_at = row.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at < now:
        raise MembershipError("otp", "کد منقضی شده است. دوباره ارسال کنید.")
    row.consumed_at = now

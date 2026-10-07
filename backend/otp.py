"""SMS OTP for registration and password reset. Not used as a login method."""

from __future__ import annotations

import hashlib
import json
import logging
import secrets
import threading
from datetime import datetime, timedelta, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from sqlalchemy import delete, select, update

from backend.database import db_session
from backend.membership import MembershipError, is_mobile_phone, normalize_phone, registration_is_open
from backend.models import OtpChallenge, RegistrationRequest, User
from backend.settings import get_settings

log = logging.getLogger("backend.otp")

PURPOSES = frozenset({"register", "reset"})
DEV_OTP = "123456"
_LOOKUP_TEMPLATE_DEFAULT = "binaappotp"


def _mask_phone(phone: str) -> str:
    if len(phone) < 7:
        return "***"
    return phone[:4] + "***" + phone[-3:]


def _hash_code(salt: str, code: str) -> str:
    return hashlib.sha256(f"{salt}:{code}".encode("utf-8")).hexdigest()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def cleanup_expired_challenges(now: datetime | None = None) -> int:
    """Retain OTP records briefly so daily operational counts remain accurate."""
    cutoff = (now or _now()) - timedelta(days=2)
    with db_session() as session:
        result = session.execute(
            delete(OtpChallenge).where(OtpChallenge.created_at < cutoff)
        )
        return int(result.rowcount or 0)


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
        if not registration_is_open():
            raise MembershipError("closed", "ثبت‌نام موقتاً بسته است.")
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


def _lookup_template() -> str:
    name = (get_settings().kavenegar_otp_template or "").strip() or _LOOKUP_TEMPLATE_DEFAULT
    return name


def _read_kavenegar_payload(raw: bytes) -> dict:
    try:
        data = json.loads(raw.decode("utf-8"))
    except (ValueError, json.JSONDecodeError, UnicodeDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _kavenegar_status(payload: dict):
    return ((payload or {}).get("return") or {}).get("status")


def _send_kavenegar_lookup(phone: str, code: str) -> None:
    key = _kavenegar_key()
    params = {
        "receptor": phone,
        "token": code,
        "template": _lookup_template(),
    }
    body = urlencode(params).encode("utf-8")
    url = f"https://api.kavenegar.com/v1/{key}/verify/lookup.json"
    request = Request(url, data=body, method="POST")
    request.add_header("Content-Type", "application/x-www-form-urlencoded")
    payload = {}
    try:
        with urlopen(request, timeout=8) as response:
            payload = _read_kavenegar_payload(response.read())
    except HTTPError as err:
        try:
            payload = _read_kavenegar_payload(err.read() or b"")
        except Exception:
            payload = {}
        status = _kavenegar_status(payload)
        log.warning("kavenegar lookup http phone=%s status=%s", _mask_phone(phone), status)
        if status == 200:
            return
        raise MembershipError("otp", "ارسال پیامک ممکن نشد.") from None
    except (URLError, TimeoutError, ValueError, OSError):
        log.warning("kavenegar lookup timeout/network phone=%s", _mask_phone(phone))
        raise TimeoutError("kavenegar lookup timeout") from None
    status = _kavenegar_status(payload)
    if status != 200:
        log.warning("kavenegar lookup status=%s phone=%s", status, _mask_phone(phone))
        raise MembershipError("otp", "ارسال پیامک ممکن نشد.")


SMS_REQUEST_FILED = (
    "سامانه دیده‌بان فرهنگ\n"
    "درخواست شما با موفقیت ثبت شد. نتیجه آن از طریق پیامک به شما اعلام خواهد شد."
)
SMS_ACCOUNT_APPROVED = (
    "سامانه دیده‌بان فرهنگ\n"
    "کاربر گرامی، حساب کاربری شما در سامانه با موفقیت ایجاد شد. لینک سامانه:\n"
    "https://app.rasadbina.ir"
)


def _send_kavenegar_sms(phone: str, text: str) -> None:
    key = _kavenegar_key()
    sender = (get_settings().kavenegar_sender or "").strip()
    params = {"receptor": phone, "message": text}
    if sender:
        params["sender"] = sender
    body = urlencode(params).encode("utf-8")
    url = f"https://api.kavenegar.com/v1/{key}/sms/send.json"
    request = Request(url, data=body, method="POST")
    request.add_header("Content-Type", "application/x-www-form-urlencoded")
    payload = {}
    try:
        with urlopen(request, timeout=12) as response:
            payload = _read_kavenegar_payload(response.read())
    except HTTPError as err:
        try:
            payload = _read_kavenegar_payload(err.read() or b"")
        except Exception:
            payload = {}
        status = ((payload or {}).get("return") or {}).get("status")
        log.warning("kavenegar sms http failed phone=%s status=%s", _mask_phone(phone), status)
        raise MembershipError("otp", "ارسال پیامک ممکن نشد.") from None
    except (URLError, TimeoutError, ValueError, OSError):
        log.warning("kavenegar sms failed phone=%s", _mask_phone(phone))
        raise MembershipError("otp", "ارسال پیامک ممکن نشد.") from None
    status = ((payload or {}).get("return") or {}).get("status")
    if status != 200:
        log.warning("kavenegar sms status=%s phone=%s", status, _mask_phone(phone))
        raise MembershipError("otp", "ارسال پیامک ممکن نشد.")


def send_plain_sms(phone: str, text: str) -> None:
    phone = normalize_phone(phone)
    if not is_mobile_phone(phone) or not text or not _kavenegar_configured():
        return

    def _run() -> None:
        try:
            _send_kavenegar_sms(phone, text)
        except Exception:
            log.warning("plain sms not delivered phone=%s", _mask_phone(phone))

    threading.Thread(target=_run, daemon=True, name="kavenegar-sms").start()


def notify_registration_filed(phone: str) -> None:
    send_plain_sms(phone, SMS_REQUEST_FILED)


def notify_account_approved(phone: str) -> None:
    send_plain_sms(phone, SMS_ACCOUNT_APPROVED)


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
        salt = secrets.token_hex(8)
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

    if not _kavenegar_configured():
        log.info("otp send skipped (no API key) phone=%s purpose=%s", _mask_phone(phone), purpose)
        return {"ok": True, "ttl_seconds": ttl, "resend_seconds": cooldown}

    def _deliver() -> None:
        try:
            _send_kavenegar_lookup(phone, code)
        except TimeoutError:
            log.warning("otp lookup timed out after store phone=%s", _mask_phone(phone))
        except MembershipError:
            log.warning("otp lookup rejected after store phone=%s", _mask_phone(phone))
        except Exception:
            log.warning("otp lookup failed after store phone=%s", _mask_phone(phone))

    threading.Thread(target=_deliver, daemon=True, name="kavenegar-otp").start()
    return {"ok": True, "ttl_seconds": ttl, "resend_seconds": cooldown}


_FA_DIGITS = str.maketrans("۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩", "01234567890123456789")
_OTP_JUNK = dict.fromkeys(map(ord, "\u200c\u200d\u200e\u200f\u202a\u202b\u202c\u202d\u202e\ufeff \t\r\n"), None)


def normalize_otp_code(raw: str) -> str:
    s = (raw or "").translate(_FA_DIGITS).translate(_OTP_JUNK)
    return "".join(ch for ch in s if ch in "0123456789")[:6]


def verify_otp(phone: str, purpose: str, code: str) -> dict:
    phone = normalize_phone(phone)
    purpose = (purpose or "").strip()
    code = normalize_otp_code(code)
    if not is_mobile_phone(phone):
        raise MembershipError("phone", "شماره موبایل نامعتبر است.")
    if purpose not in PURPOSES:
        raise MembershipError("otp", "نوع درخواست نامعتبر است.")
    if len(code) != 6:
        raise MembershipError("otp", "کد باید ۶ رقم باشد.")

    settings = get_settings()
    max_attempts = max(3, int(settings.otp_max_attempts or 5))
    verification_token = None

    with db_session() as session:
        row = session.execute(
            select(OtpChallenge)
            .where(
                OtpChallenge.phone == phone,
                OtpChallenge.purpose == purpose,
                OtpChallenge.consumed_at.is_(None),
            )
            .order_by(OtpChallenge.created_at.desc())
            .limit(1)
            .with_for_update()
        ).scalars().first()
        if row is None:
            raise MembershipError("otp", "کد نامعتبر است.")
        # The row lock serializes attempts, including requests waiting in parallel.
        now = _now()
        expires_at = row.expires_at
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        if expires_at < now:
            raise MembershipError("otp", "کد منقضی شده است. دوباره ارسال کنید.")
        if row.verified_at is not None:
            raise MembershipError("otp", "این کد قبلاً تأیید شده است. دوباره ارسال کنید.")
        if int(row.attempts or 0) >= max_attempts:
            raise MembershipError("otp", "تعداد تلاش بیش از حد است. دوباره ارسال کنید.")
        row.attempts = int(row.attempts or 0) + 1
        if secrets.compare_digest(_hash_code(row.salt, code), row.code_hash):
            row.verified_at = now
            verification_token = secrets.token_urlsafe(32)
            row.verification_token_hash = hashlib.sha256(verification_token.encode("ascii")).hexdigest()
    # Reject only after db_session commits the attempt. Raising inside the
    # transaction would roll back the counter and allow unlimited wrong guesses.
    if verification_token is None:
        raise MembershipError("otp", "کد نامعتبر است.")
    return {"ok": True, "purpose": purpose, "verification_token": verification_token}


def consume_verified_otp_in_session(session, phone: str, purpose: str, verification_token: str) -> None:
    """Consume the caller's proof atomically, in the same transaction as the action.

    A verified phone alone never authorizes an action. Existing challenges without
    a proof hash cannot be consumed. Resends invalidate proofs through consumed_at.
    """
    phone = normalize_phone(phone)
    purpose = (purpose or "").strip()
    if (
        not isinstance(verification_token, str)
        or len(verification_token) != 43
        or any(c not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-" for c in verification_token)
    ):
        raise MembershipError("otp", "ابتدا کد پیامک را تأیید کنید.")
    token_hash = hashlib.sha256(verification_token.encode("ascii")).hexdigest()
    now = _now()
    consumed_id = session.execute(
        update(OtpChallenge)
        .where(
            OtpChallenge.phone == phone,
            OtpChallenge.purpose == purpose,
            OtpChallenge.consumed_at.is_(None),
            OtpChallenge.verified_at.is_not(None),
            OtpChallenge.verification_token_hash == token_hash,
            OtpChallenge.expires_at > now,
        )
        .values(consumed_at=now, verification_token_hash=None)
        .returning(OtpChallenge.id)
        .execution_options(synchronize_session=False)
    ).scalar_one_or_none()
    if consumed_id is None:
        raise MembershipError("otp", "تأیید شماره نامعتبر یا منقضی شده است. دوباره کد بگیرید.")

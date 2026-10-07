"""Membership helpers: phone normalize, password hash, sessions, first-admin seed."""

from __future__ import annotations

import hashlib
import io
import logging
import re
import secrets
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from xml.sax.saxutils import escape as xml_escape

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHash, VerificationError, VerifyMismatchError
from sqlalchemy import delete, func, or_, select
from sqlalchemy.exc import IntegrityError, ProgrammingError, OperationalError

from backend.avatars import (
    AVATAR_DIR,
    AvatarError,
    delete_avatar_file,
    is_managed_path,
    public_url,
    save_user_avatar,
)
from backend.database import db_session
from backend.models import (
    LoginFailure,
    OtpChallenge,
    ProfileRevision,
    RegistrationRequest,
    SiteSetting,
    User,
    UserSession,
)
from backend.settings import get_settings

log = logging.getLogger("backend.membership")

_PROFILE_FIELDS = (
    "first_name",
    "last_name",
    "role_title",
    "organization",
    "birth_date",
    "email",
    "address",
    "avatar_path",
)
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

SESSION_COOKIE = "bina_session"
SESSION_DAYS = 1
LOGIN_FAILURE_LIMIT = 5
LOGIN_FAILURE_WINDOW = timedelta(minutes=15)
_ADMIN_STATE_LOCK = 0x526173616442696E

_hasher = PasswordHasher()

_FA_DIGITS = str.maketrans("۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩", "01234567890123456789")
_URL_OR_CODE = re.compile(
    r"(https?://|www\.|javascript:|data:text|</?[a-zA-Z]|[<>])",
    re.IGNORECASE,
)


def normalize_phone(raw: str) -> str:
    s = (raw or "").translate(_FA_DIGITS)
    s = s.replace(" ", "").replace("-", "")
    if s.startswith("+98"):
        s = "0" + s[3:]
    elif s.startswith("0098"):
        s = "0" + s[4:]
    elif s.startswith("98") and len(s) == 12:
        s = "0" + s[2:]
    return s


def is_mobile_phone(phone: str) -> bool:
    return len(phone) == 11 and phone.startswith("09") and phone.isdigit()


def assert_plain_text(value: str, code: str, label: str) -> str:
    value = (value or "").strip()
    if _URL_OR_CODE.search(value):
        raise MembershipError(code, f"{label} نباید شامل پیوند یا کد باشد.")
    return value


def normalize_secret(raw: str) -> str:
    s = (raw or "").translate(_FA_DIGITS).strip()
    for ch in ("\u200c", "\u200d", "\u200b", "\ufeff"):
        s = s.replace(ch, "")
    return s


def hash_password(plain: str) -> str:
    return _hasher.hash(normalize_secret(plain))


def verify_password(password_hash: str, plain: str) -> bool:
    try:
        return bool(_hasher.verify((password_hash or "").strip(), normalize_secret(plain)))
    except (VerifyMismatchError, InvalidHash, VerificationError, ValueError, TypeError):
        return False


def argon2_hash_is_well_formed(value: str) -> bool:
    value = (value or "").strip()
    if not value.startswith("$argon2"):
        return False
    try:
        _hasher.verify(value, "__probe__")
    except VerifyMismatchError:
        return True
    except (InvalidHash, VerificationError, ValueError, TypeError):
        return False
    return True


def repair_approved_user_hashes() -> None:
    """Copy a usable hash from the approved request when the user hash is missing or truncated."""
    with db_session() as session:
        users = session.execute(select(User)).scalars().all()
        for user in users:
            if argon2_hash_is_well_formed(user.password_hash or ""):
                continue
            req = session.execute(
                select(RegistrationRequest)
                .where(
                    RegistrationRequest.phone == user.phone,
                    RegistrationRequest.status == "approved",
                )
                .order_by(RegistrationRequest.reviewed_at.desc())
            ).scalars().first()
            if req is None or not argon2_hash_is_well_formed(req.password_hash or ""):
                continue
            user.password_hash = req.password_hash.strip()
            if user.is_active is None:
                user.is_active = True


def seed_admin() -> None:
    """Create the initial env admin without changing an existing account."""
    settings = get_settings()
    phone = normalize_phone(settings.admin_phone)
    password = settings.admin_password.get_secret_value()
    if not phone and not password:
        return
    if not is_mobile_phone(phone):
        raise RuntimeError("ADMIN_PHONE must be an 11-digit Iranian mobile like 09121234567.")

    with db_session() as session:
        user = session.execute(select(User).where(User.phone == phone)).scalar_one_or_none()
        if user is not None:
            if not user.is_admin:
                raise RuntimeError("ADMIN_PHONE belongs to a non-admin account; choose another phone.")
            return
        if len(password) < 8:
            raise RuntimeError("ADMIN_PASSWORD must be at least 8 characters to create the admin.")
        session.add(
            User(
                phone=phone,
                first_name="مدیر",
                last_name="سامانه",
                role_title="مدیر",
                password_hash=hash_password(password),
                is_admin=True,
                is_active=True,
            )
        )


class MembershipError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def public_profile(user: User) -> dict:
    return {
        "id": user.id,
        "first_name": user.first_name or "",
        "last_name": user.last_name or "",
        "phone": user.phone,
        "role_title": user.role_title or "",
        "organization": user.organization or "",
        "birth_date": user.birth_date.isoformat() if user.birth_date else "",
        "email": user.email or "",
        "address": user.address or "",
        "is_admin": bool(user.is_admin),
        "is_active": user.is_active is not False,
        "avatar_url": public_url(user.avatar_path),
        "updated_at": _iso(user.updated_at),
    }


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat()


def serialize_request(row: RegistrationRequest) -> dict:
    return {
        "id": row.id,
        "phone": row.phone,
        "first_name": row.first_name,
        "last_name": row.last_name,
        "role_title": row.role_title,
        "organization": row.organization or "",
        "status": row.status,
        "note": row.note or "",
        "created_at": _iso(row.created_at),
        "reviewed_at": _iso(row.reviewed_at),
    }


def _token_hash(raw: str) -> str:
    return hashlib.sha256(raw.encode("ascii")).hexdigest()


def _create_session_in_transaction(session, user_id: int) -> tuple[str, datetime]:
    raw = secrets.token_urlsafe(32)
    expires_at = datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS)
    session.add(UserSession(user_id=user_id, token_hash=_token_hash(raw), expires_at=expires_at))
    return raw, expires_at


def cleanup_expired_sessions(now: datetime | None = None) -> int:
    """Delete session records whose login lifetime has ended."""
    cutoff = now or datetime.now(timezone.utc)
    with db_session() as session:
        maximum_age = cutoff - timedelta(days=SESSION_DAYS)
        result = session.execute(
            delete(UserSession).where(
                or_(
                    UserSession.expires_at <= cutoff,
                    UserSession.created_at <= maximum_age,
                )
            )
        )
        return int(result.rowcount or 0)



def _lock_admin_state(session) -> None:
    """Serialize admin deactivations across app workers."""
    session.execute(select(func.pg_advisory_xact_lock(_ADMIN_STATE_LOCK))).scalar_one()


def _active_admin_count(session) -> int:
    return int(
        session.execute(
            select(func.count())
            .select_from(User)
            .where(User.is_admin.is_(True), User.is_active.is_(True))
        ).scalar_one()
    )


def _clear_login_failures(user: User) -> None:
    user.login_failed_attempts = 0
    user.login_failure_window_started_at = None


def _record_wrong_password(session, user: User, now: datetime) -> None:
    started = user.login_failure_window_started_at
    if started is not None and started.tzinfo is None:
        started = started.replace(tzinfo=timezone.utc)
    if started is None or now >= started + LOGIN_FAILURE_WINDOW:
        user.login_failure_window_started_at = now
        user.login_failed_attempts = 0
    user.login_failed_attempts = min(LOGIN_FAILURE_LIMIT, int(user.login_failed_attempts or 0) + 1)
    if user.login_failed_attempts < LOGIN_FAILURE_LIMIT:
        return
    if user.is_admin:
        _lock_admin_state(session)
        if _active_admin_count(session) <= 1:
            return
    user.is_active = False
    user.updated_at = now
    session.execute(delete(UserSession).where(UserSession.user_id == user.id))


def authenticate(phone: str, password: str) -> dict | None:
    phone = normalize_phone(phone)
    password = normalize_secret(password)
    if not is_mobile_phone(phone) or not password:
        return None
    result = None
    reason = "unknown"
    with db_session() as session:
        user = session.execute(
            select(User)
            .where(or_(User.phone == phone, func.trim(User.phone) == phone))
            .with_for_update()
        ).scalars().first()
        if user is not None:
            if user.is_active is False:
                reason = "inactive"
            else:
                stored_hash = (user.password_hash or "").strip()
                if not stored_hash or not verify_password(stored_hash, password):
                    reason = "password"
                    _record_wrong_password(session, user, datetime.now(timezone.utc))
                else:
                    reason = "ok"
                    _clear_login_failures(user)
                    profile = public_profile(user)
                    token, expires_at = _create_session_in_transaction(session, user.id)
                    result = {"profile": profile, "token": token, "expires_at": expires_at}
    record_login_failure(phone, reason)
    return result


def lookup_auth_gate(phone: str) -> str:
    """Route a phone to login, register, pending, or rejected. No extra profile data."""
    phone = normalize_phone(phone)
    if not is_mobile_phone(phone):
        raise MembershipError("phone", "شماره موبایل نامعتبر است.")
    with db_session() as session:
        user = session.execute(
            select(User).where(or_(User.phone == phone, func.trim(User.phone) == phone))
        ).scalars().first()
        requests = session.execute(
            select(RegistrationRequest)
            .where(
                or_(
                    RegistrationRequest.phone == phone,
                    func.trim(RegistrationRequest.phone) == phone,
                )
            )
            .order_by(RegistrationRequest.created_at.desc())
        ).scalars().all()
        if any(row.status == "pending" for row in requests):
            return "pending"
        if user is not None:
            return "login"
        latest = requests[0] if requests else None
        if latest is not None and latest.status == "rejected":
            return "rejected"
        if latest is not None and latest.status == "approved":
            return "login"
        if not registration_is_open():
            return "closed"
        return "register"


def profile_from_session_token(token: str) -> dict | None:
    if not token:
        return None
    digest = _token_hash(token)
    now = datetime.now(timezone.utc)
    with db_session() as session:
        row = session.execute(
            select(UserSession).where(UserSession.token_hash == digest)
        ).scalar_one_or_none()
        if row is None:
            return None
        expires_at = row.expires_at
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        if expires_at < now:
            session.delete(row)
            return None
        user = session.get(User, row.user_id)
        if user is None or not user.is_active:
            return None
        return public_profile(user)


def delete_session_token(token: str) -> None:
    if not token:
        return
    digest = _token_hash(token)
    with db_session() as session:
        row = session.execute(
            select(UserSession).where(UserSession.token_hash == digest)
        ).scalar_one_or_none()
        if row is not None:
            session.delete(row)


def submit_registration(
    first_name: str,
    last_name: str,
    phone: str,
    role_title: str,
    organization: str,
    password: str,
) -> dict:
    first_name = assert_plain_text(first_name, "first_name", "نام")
    last_name = assert_plain_text(last_name, "last_name", "نام خانوادگی")
    role_title = assert_plain_text(role_title, "role", "سمت")
    organization = assert_plain_text(organization, "role", "سازمان")
    phone = normalize_phone(phone)
    if len(first_name) < 2:
        raise MembershipError("first_name", "نام را وارد کنید.")
    if len(last_name) < 2:
        raise MembershipError("last_name", "نام خانوادگی را وارد کنید.")
    if not is_mobile_phone(phone):
        raise MembershipError("phone", "شماره موبایل نامعتبر است.")
    if not role_title:
        raise MembershipError("role", "سمت را وارد کنید.")
    password = normalize_secret(password)
    if len(password) < 8:
        raise MembershipError("password", "رمز عبور حداقل ۸ نویسه باشد.")
    if not registration_is_open():
        raise MembershipError("closed", "ثبت‌نام موقتاً بسته است.")

    with db_session() as session:
        user = session.execute(select(User).where(User.phone == phone)).scalar_one_or_none()
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
        row = RegistrationRequest(
            phone=phone,
            first_name=first_name,
            last_name=last_name,
            role_title=role_title,
            organization=organization or None,
            password_hash=hash_password(password),
            status="pending",
        )
        session.add(row)
        try:
            session.flush()
        except IntegrityError:
            raise MembershipError("pending", "برای این شماره یک درخواست در انتظار بررسی است.") from None
        session.refresh(row)
        payload = serialize_request(row)
        filed_phone = phone
    from backend.otp import notify_registration_filed
    notify_registration_filed(filed_phone)
    return payload


def register_after_otp(
    first_name: str,
    last_name: str,
    phone: str,
    role_title: str,
    organization: str,
    password: str,
    verification_token: str,
) -> dict:
    from backend.otp import consume_verified_otp_in_session

    first_name = assert_plain_text(first_name, "first_name", "نام")
    last_name = assert_plain_text(last_name, "last_name", "نام خانوادگی")
    role_title = assert_plain_text(role_title, "role", "سمت")
    organization = assert_plain_text(organization, "role", "سازمان")
    phone = normalize_phone(phone)
    if len(first_name) < 2:
        raise MembershipError("first_name", "نام را وارد کنید.")
    if len(last_name) < 2:
        raise MembershipError("last_name", "نام خانوادگی را وارد کنید.")
    if not is_mobile_phone(phone):
        raise MembershipError("phone", "شماره موبایل نامعتبر است.")
    if not role_title:
        raise MembershipError("role", "سمت را وارد کنید.")
    password = normalize_secret(password)
    if len(password) < 8:
        raise MembershipError("password", "رمز عبور حداقل ۸ نویسه باشد.")
    if not registration_is_open():
        raise MembershipError("closed", "ثبت‌نام موقتاً بسته است.")

    with db_session() as session:
        existing = session.execute(select(User).where(User.phone == phone)).scalar_one_or_none()
        if existing is not None:
            raise MembershipError("exists", "برای این شماره قبلاً حساب پذیرفته شده است.")
        pending = session.execute(
            select(RegistrationRequest).where(
                RegistrationRequest.phone == phone,
                RegistrationRequest.status == "pending",
            )
        ).scalar_one_or_none()
        if pending is not None:
            raise MembershipError("pending", "برای این شماره یک درخواست در انتظار بررسی است.")
        consume_verified_otp_in_session(session, phone, "register", verification_token)
        row = RegistrationRequest(
            phone=phone,
            first_name=first_name,
            last_name=last_name,
            role_title=role_title,
            organization=organization or None,
            password_hash=hash_password(password),
            status="pending",
        )
        session.add(row)
        try:
            session.flush()
        except IntegrityError:
            raise MembershipError("pending", "برای این شماره یک درخواست در انتظار بررسی است.") from None
        session.refresh(row)
        payload = serialize_request(row)
        filed_phone = phone
    from backend.otp import notify_registration_filed
    notify_registration_filed(filed_phone)
    return payload


def reset_password_after_otp(phone: str, password: str, verification_token: str) -> dict:
    from backend.otp import consume_verified_otp_in_session

    phone = normalize_phone(phone)
    password = normalize_secret(password)
    if not is_mobile_phone(phone):
        raise MembershipError("phone", "شماره موبایل نامعتبر است.")
    if len(password) < 8:
        raise MembershipError("password", "رمز عبور حداقل ۸ نویسه باشد.")
    now = datetime.now(timezone.utc)
    with db_session() as session:
        user = session.execute(
            select(User).where(User.phone == phone).with_for_update()
        ).scalar_one_or_none()
        if user is None or user.is_active is False:
            raise MembershipError("not-found", "حسابی با این شماره پیدا نشد.")
        consume_verified_otp_in_session(session, phone, "reset", verification_token)
        user.password_hash = hash_password(password)
        user.updated_at = now
        _clear_login_failures(user)
        session.execute(delete(UserSession).where(UserSession.user_id == user.id))
        profile = public_profile(user)
        token, expires_at = _create_session_in_transaction(session, user.id)
    return {"profile": profile, "token": token, "expires_at": expires_at}


def list_registration_requests() -> list[dict]:
    with db_session() as session:
        rows = session.execute(
            select(RegistrationRequest).order_by(RegistrationRequest.created_at.desc())
        ).scalars().all()
        return [serialize_request(row) for row in rows]


def approve_registration(request_id: int, admin_id: int) -> dict:
    now = datetime.now(timezone.utc)
    with db_session() as session:
        req = session.get(RegistrationRequest, request_id)
        if req is None:
            raise MembershipError("not-found", "درخواست پیدا نشد.")
        if req.status not in ("pending", "rejected"):
            raise MembershipError("not-pending", "این درخواست قابل پذیرش نیست.")
        existing = session.execute(select(User).where(User.phone == req.phone)).scalar_one_or_none()
        if existing is not None:
            raise MembershipError("exists", "برای این شماره قبلاً حساب ساخته شده است.")
        password_hash = (req.password_hash or "").strip()
        if not password_hash:
            raise MembershipError("not-pending", "این درخواست رمز معتبری ندارد.")
        user = User(
            phone=normalize_phone(req.phone),
            first_name=req.first_name,
            last_name=req.last_name,
            role_title=req.role_title,
            organization=req.organization,
            password_hash=password_hash,
            is_admin=False,
            is_active=True,
            approved_at=now,
            approved_by=admin_id,
        )
        session.add(user)
        req.status = "approved"
        req.reviewed_at = now
        req.reviewed_by = admin_id
        session.flush()
        payload = serialize_request(req)
        approved_phone = normalize_phone(req.phone)
    from backend.otp import notify_account_approved
    notify_account_approved(approved_phone)
    return payload


def reject_registration(request_id: int, admin_id: int, note: str) -> dict:
    now = datetime.now(timezone.utc)
    with db_session() as session:
        req = session.get(RegistrationRequest, request_id)
        if req is None:
            raise MembershipError("not-found", "درخواست پیدا نشد.")
        if req.status != "pending":
            raise MembershipError("not-pending", "این درخواست قابل رد نیست.")
        req.status = "rejected"
        note = assert_plain_text(note, "not-pending", "یادداشت")
        req.note = note or None
        req.reviewed_at = now
        req.reviewed_by = admin_id
        session.flush()
        return serialize_request(req)


def _profile_snapshot(user: User) -> dict:
    return {
        "first_name": user.first_name or "",
        "last_name": user.last_name or "",
        "role_title": user.role_title or "",
        "organization": user.organization or "",
        "birth_date": user.birth_date.isoformat() if user.birth_date else "",
        "email": user.email or "",
        "address": user.address or "",
        "avatar_path": user.avatar_path or "",
    }


def _profile_diff(before: dict, after: dict) -> dict:
    changes: dict = {}
    for key in _PROFILE_FIELDS:
        old = before.get(key) or ""
        new = after.get(key) or ""
        if old != new:
            changes[key] = {"before": old or None, "after": new or None}
    return changes


def _display_name(user: User | None) -> str:
    if user is None:
        return ""
    return " ".join(part for part in (user.first_name, user.last_name) if part).strip()


def _add_revision(session, user: User, actor_id: int | None, source: str, before: dict) -> None:
    changes = _profile_diff(before, _profile_snapshot(user))
    if not changes:
        return
    session.add(
        ProfileRevision(
            user_id=user.id,
            actor_id=actor_id,
            source=source,
            changes=changes,
        )
    )


def update_own_profile(
    user_id: int,
    first_name: str,
    last_name: str,
    role_title: str,
    organization: str,
    birth_date: str = "",
    email: str = "",
    address: str = "",
) -> dict:
    from datetime import date as date_type

    first_name = assert_plain_text(first_name, "first_name", "نام")
    last_name = assert_plain_text(last_name, "last_name", "نام خانوادگی")
    role_title = assert_plain_text(role_title, "role", "سمت")
    organization = assert_plain_text(organization, "role", "سازمان")
    email = assert_plain_text(email, "email", "ایمیل").lower()
    address = assert_plain_text(address, "address", "نشانی")
    if len(first_name) < 2:
        raise MembershipError("first_name", "نام را وارد کنید.")
    if len(last_name) < 2:
        raise MembershipError("last_name", "نام خانوادگی را وارد کنید.")
    parsed_birth = None
    birth_raw = (birth_date or "").strip()
    if birth_raw:
        try:
            parsed_birth = date_type.fromisoformat(birth_raw[:10])
        except ValueError:
            raise MembershipError("birth_date", "تاریخ تولد نامعتبر است.") from None
    if email and not _EMAIL_RE.match(email):
        raise MembershipError("email", "ایمیل نامعتبر است.")
    now = datetime.now(timezone.utc)
    with db_session() as session:
        user = session.get(User, user_id)
        if user is None or not user.is_active:
            raise MembershipError("not-found", "حساب پیدا نشد.")
        before = _profile_snapshot(user)
        user.first_name = first_name
        user.last_name = last_name
        user.role_title = role_title or None
        user.organization = organization or None
        user.birth_date = parsed_birth
        user.email = email or None
        user.address = address or None
        user.updated_at = now
        _add_revision(session, user, user_id, "self", before)
        session.flush()
        return public_profile(user)


def set_user_avatar(user_id: int, data: bytes, actor_id: int, source: str) -> dict:
    try:
        new_path = save_user_avatar(user_id, data)
    except AvatarError as err:
        raise MembershipError("avatar", err.message) from err
    now = datetime.now(timezone.utc)
    old_path = None
    try:
        with db_session() as session:
            user = session.get(User, user_id)
            if user is None or not user.is_active:
                raise MembershipError("not-found", "حساب پیدا نشد.")
            before = _profile_snapshot(user)
            old_path = user.avatar_path
            user.avatar_path = new_path
            user.updated_at = now
            _add_revision(session, user, actor_id, source, before)
            session.flush()
            profile = public_profile(user)
    except Exception:
        delete_avatar_file(new_path)
        raise
    if old_path and old_path != new_path:
        delete_avatar_file(old_path)
    return profile


def clear_user_avatar(user_id: int, actor_id: int, source: str) -> dict:
    now = datetime.now(timezone.utc)
    old_path = None
    with db_session() as session:
        user = session.get(User, user_id)
        if user is None or not user.is_active:
            raise MembershipError("not-found", "حساب پیدا نشد.")
        if not user.avatar_path:
            return public_profile(user)
        before = _profile_snapshot(user)
        old_path = user.avatar_path
        user.avatar_path = None
        user.updated_at = now
        _add_revision(session, user, actor_id, source, before)
        session.flush()
        profile = public_profile(user)
    delete_avatar_file(old_path)
    return profile


def delete_user_account(user_id: int, actor_id: int) -> None:
    if int(user_id) == int(actor_id):
        raise MembershipError("forbidden", "نمی‌توانید حساب خودتان را حذف کنید.")
    avatar_path = None
    with db_session() as session:
        user = session.execute(
            select(User).where(User.id == user_id).with_for_update()
        ).scalar_one_or_none()
        if user is None:
            raise MembershipError("not-found", "حساب پیدا نشد.")
        if user.is_admin:
            _lock_admin_state(session)
            admin_count = session.execute(
                select(func.count()).select_from(User).where(User.is_admin.is_(True))
            ).scalar_one()
            if int(admin_count or 0) <= 1:
                raise MembershipError("forbidden", "آخرین مدیر را نمی‌توان حذف کرد.")
            if user.is_active and _active_admin_count(session) <= 1:
                raise MembershipError("forbidden", "آخرین مدیر فعال را نمی‌توان حذف کرد.")
        phone = user.phone
        avatar_path = user.avatar_path
        for row in session.execute(select(OtpChallenge).where(OtpChallenge.phone == phone)).scalars().all():
            session.delete(row)
        for row in session.execute(
            select(RegistrationRequest).where(RegistrationRequest.phone == phone)
        ).scalars().all():
            session.delete(row)
        session.delete(user)
        session.flush()
    delete_avatar_file(avatar_path)


def set_user_active(user_id: int, actor_id: int, active: bool) -> dict:
    if int(user_id) == int(actor_id) and not active:
        raise MembershipError("forbidden", "نمی‌توانید حساب خودتان را غیرفعال کنید.")
    now = datetime.now(timezone.utc)
    with db_session() as session:
        user = session.execute(
            select(User).where(User.id == user_id).with_for_update()
        ).scalar_one_or_none()
        if user is None:
            raise MembershipError("not-found", "حساب پیدا نشد.")
        if user.is_admin and user.is_active and not active:
            _lock_admin_state(session)
            if _active_admin_count(session) <= 1:
                raise MembershipError("forbidden", "آخرین مدیر فعال را نمی‌توان غیرفعال کرد.")
        user.is_active = bool(active)
        user.updated_at = now
        if active:
            _clear_login_failures(user)
        else:
            session.execute(delete(UserSession).where(UserSession.user_id == user_id))
        session.flush()
        return public_profile(user)


def _mask_phone(phone: str) -> str:
    if len(phone) < 7:
        return "***"
    return phone[:4] + "***" + phone[-3:]


def record_login_failure(phone: str, reason: str) -> None:
    try:
        with db_session() as session:
            session.add(LoginFailure(phone_mask=_mask_phone(phone), reason=reason[:24]))
    except Exception:
        return


def registration_is_open() -> bool:
    with db_session() as session:
        row = session.get(SiteSetting, "registration_open")
        if row is None:
            return True
        return (row.value or "1").strip() not in ("0", "false", "off", "no")


def set_registration_open(open_: bool) -> bool:
    value = "1" if open_ else "0"
    with db_session() as session:
        row = session.get(SiteSetting, "registration_open")
        if row is None:
            session.add(SiteSetting(key="registration_open", value=value))
        else:
            row.value = value
        session.flush()
    return open_


def _tehran_tz():
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo("Asia/Tehran")
    except Exception:
        return timezone(timedelta(hours=3, minutes=30))


def _tehran_now():
    return datetime.now(_tehran_tz())


def _tehran_day_start_utc():
    now = _tehran_now()
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return start.astimezone(timezone.utc)


def _fail_reason_label(reason: str) -> str:
    return {
        "unknown": "شماره ناشناخته",
        "password": "رمز نادرست",
        "inactive": "حساب غیرفعال",
        "ok": "موفق",
    }.get(reason, "نامشخص")


def _add_months(value: datetime, months: int) -> datetime:
    month_index = value.year * 12 + value.month - 1 + months
    return value.replace(year=month_index // 12, month=month_index % 12 + 1)


def _gregorian_to_jalali(year: int, month: int, day: int) -> tuple[int, int, int]:
    """Convert a Gregorian date to Solar Hijri without an external dependency."""
    month_days = (0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334)
    if year > 1600:
        jalali_year = 979
        year -= 1600
    else:
        jalali_year = 0
        year -= 621
    adjusted_year = year + 1 if month > 2 else year
    days = (
        365 * year
        + (adjusted_year + 3) // 4
        - (adjusted_year + 99) // 100
        + (adjusted_year + 399) // 400
        - 80
        + day
        + month_days[month - 1]
    )
    jalali_year += 33 * (days // 12053)
    days %= 12053
    jalali_year += 4 * (days // 1461)
    days %= 1461
    if days > 365:
        jalali_year += (days - 1) // 365
        days = (days - 1) % 365
    if days < 186:
        return jalali_year, 1 + days // 31, 1 + days % 31
    return jalali_year, 7 + (days - 186) // 30, 1 + (days - 186) % 30


def _jalali_label(value: datetime, include_year: bool = False, include_hour: bool = False) -> str:
    year, month, day = _gregorian_to_jalali(value.year, value.month, value.day)
    date_label = f"{year:04d}/{month:02d}/{day:02d}" if include_year else f"{month:02d}/{day:02d}"
    return f"{date_label} {value:%H}:00" if include_hour else date_label
def _login_trend_buckets(kind: str) -> list[tuple[datetime, datetime, str]]:
    now = _tehran_now()
    hour_start = now.replace(minute=0, second=0, microsecond=0)
    day_start = hour_start.replace(hour=0)
    if kind == "hourly":
        start = hour_start - timedelta(hours=23)
        return [
            (start + timedelta(hours=index), start + timedelta(hours=index + 1),
             _jalali_label(start + timedelta(hours=index), include_hour=True))
            for index in range(24)
        ]
    if kind == "daily":
        start = day_start - timedelta(days=29)
        return [
            (start + timedelta(days=index), start + timedelta(days=index + 1),
             _jalali_label(start + timedelta(days=index)))
            for index in range(30)
        ]
    if kind == "weekly":
        week_start = day_start - timedelta(days=day_start.weekday())
        start = week_start - timedelta(weeks=11)
        return [
            (start + timedelta(weeks=index), start + timedelta(weeks=index + 1),
             _jalali_label(start + timedelta(weeks=index)))
            for index in range(12)
        ]
    month_start = day_start.replace(day=1)
    start = _add_months(month_start, -11)
    return [
        (_add_months(start, index), _add_months(start, index + 1),
         _jalali_label(_add_months(start, index), include_year=True))
        for index in range(12)
    ]

def _bucket_login_trend(kind: str, rows: list[LoginFailure]) -> dict:
    tz = _tehran_tz()
    labels = []
    success = []
    fail = []
    for bucket_start, bucket_end, label in _login_trend_buckets(kind):
        labels.append(label)
        ok_n = 0
        fail_n = 0
        for row in rows:
            when = row.created_at
            if when is None:
                continue
            if when.tzinfo is None:
                when = when.replace(tzinfo=timezone.utc)
            local = when.astimezone(tz)
            if bucket_start <= local < bucket_end:
                if row.reason == "ok":
                    ok_n += 1
                else:
                    fail_n += 1
        success.append(ok_n)
        fail.append(fail_n)
    return {
        "labels": labels,
        "success": success,
        "fail": fail,
        "total": [success[index] + fail[index] for index in range(len(success))],
    }

def ops_overview() -> dict:
    payload = {
        "registration_open": True,
        "otp_sent_today": 0,
        "login_stats_available": True,
        "login_failures": {"today": 0, "last_7_days": 0, "recent": []},
        "login_trend": {
            "hourly": _bucket_login_trend("hourly", []),
            "daily": _bucket_login_trend("daily", []),
            "weekly": _bucket_login_trend("weekly", []),
            "monthly": _bucket_login_trend("monthly", []),
        },
    }
    try:
        payload["registration_open"] = registration_is_open()
    except Exception:
        log.exception("ops registration_open")
    start_today = _tehran_day_start_utc()
    start_week = start_today - timedelta(days=6)
    start_month = _login_trend_buckets("monthly")[0][0].astimezone(timezone.utc)
    try:
        with db_session() as session:
            otp_today = session.execute(
                select(func.count()).select_from(OtpChallenge).where(OtpChallenge.created_at >= start_today)
            ).scalar_one()
            payload["otp_sent_today"] = int(otp_today or 0)
    except (ProgrammingError, OperationalError):
        log.warning("ops otp count skipped (schema)")
    try:
        with db_session() as session:
            fail_today = session.execute(
                select(func.count()).select_from(LoginFailure).where(
                    LoginFailure.created_at >= start_today,
                    LoginFailure.reason != "ok",
                )
            ).scalar_one()
            fail_week = session.execute(
                select(func.count()).select_from(LoginFailure).where(
                    LoginFailure.created_at >= start_week,
                    LoginFailure.reason != "ok",
                )
            ).scalar_one()
            recent = session.execute(
                select(LoginFailure)
                .where(LoginFailure.reason != "ok")
                .order_by(LoginFailure.created_at.desc())
                .limit(20)
            ).scalars().all()
            trend_rows = session.execute(
                select(LoginFailure).where(LoginFailure.created_at >= start_month)
            ).scalars().all()
            # ORM attributes expire when db_session commits, so serialize rows
            # before leaving this context.
            payload["login_failures"] = {
                "today": int(fail_today or 0),
                "last_7_days": int(fail_week or 0),
                "recent": [
                    {
                        "when": _iso(row.created_at),
                        "phone_mask": row.phone_mask,
                        "reason": _fail_reason_label(row.reason),
                    }
                    for row in recent
                ],
            }
            payload["login_trend"] = {
                "hourly": _bucket_login_trend("hourly", trend_rows),
                "daily": _bucket_login_trend("daily", trend_rows),
                "weekly": _bucket_login_trend("weekly", trend_rows),
                "monthly": _bucket_login_trend("monthly", trend_rows),
            }
    except Exception:
        # Do not present a database/read failure as genuine zero activity.
        payload["login_stats_available"] = False
        log.exception("ops login statistics unavailable")
    return payload


_REQUEST_STATUS_FA = {
    "pending": "در انتظار",
    "approved": "پذیرفته",
    "rejected": "رد شده",
}


def requests_xlsx_bytes() -> bytes:
    rows = list_registration_requests()
    headers = [
        "شناسه",
        "نام",
        "نام خانوادگی",
        "موبایل",
        "سمت",
        "سازمان",
        "وضعیت",
        "یادداشت",
        "تاریخ ثبت",
        "تاریخ بررسی",
    ]
    data = [
        [
            str(row.get("id") or ""),
            row.get("first_name") or "",
            row.get("last_name") or "",
            row.get("phone") or "",
            row.get("role_title") or "",
            row.get("organization") or "",
            _REQUEST_STATUS_FA.get(row.get("status"), row.get("status") or ""),
            row.get("note") or "",
            row.get("created_at") or "",
            row.get("reviewed_at") or "",
        ]
        for row in rows
    ]
    return _xlsx_bytes("requests", headers, data)


def _xlsx_bytes(sheet_name: str, headers: list[str], rows: list[list[str]]) -> bytes:
    def cell_xml(col_idx: int, row_idx: int, value: str) -> str:
        col = ""
        n = col_idx
        while n:
            n, rem = divmod(n - 1, 26)
            col = chr(65 + rem) + col
        ref = f"{col}{row_idx}"
        text = xml_escape(str(value or ""), {"'": "&apos;", '"': "&quot;"})
        return f'<c r="{ref}" t="inlineStr"><is><t xml:space="preserve">{text}</t></is></c>'

    sheet_rows = []
    header_cells = "".join(cell_xml(i + 1, 1, headers[i]) for i in range(len(headers)))
    sheet_rows.append(f'<row r="1">{header_cells}</row>')
    for r, values in enumerate(rows, start=2):
        cells = "".join(cell_xml(i + 1, r, values[i] if i < len(values) else "") for i in range(len(headers)))
        sheet_rows.append(f'<row r="{r}">{cells}</row>')
    sheet = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f'<sheetData>{"".join(sheet_rows)}</sheetData></worksheet>'
    )
    workbook = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f'<sheets><sheet name="{xml_escape(sheet_name)}" sheetId="1" r:id="rId1"/></sheets></workbook>'
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        "</Relationships>"
    )
    wb_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
        "</Relationships>"
    )
    ctypes = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        "</Types>"
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", ctypes)
        zf.writestr("_rels/.rels", rels)
        zf.writestr("xl/workbook.xml", workbook)
        zf.writestr("xl/_rels/workbook.xml.rels", wb_rels)
        zf.writestr("xl/worksheets/sheet1.xml", sheet)
    return buf.getvalue()


def list_users_for_admin() -> list[dict]:
    with db_session() as session:
        rows = session.execute(select(User).order_by(User.id.desc())).scalars().all()
        return [public_profile(user) for user in rows]


def get_user_for_admin(user_id: int) -> dict:
    with db_session() as session:
        user = session.get(User, user_id)
        if user is None:
            raise MembershipError("not-found", "حساب پیدا نشد.")
        payload = public_profile(user)
        payload["revisions"] = _serialize_revisions(session, user_id)
        return payload


def avatar_download(user_id: int) -> tuple[Path, str]:
    with db_session() as session:
        user = session.get(User, user_id)
        if user is None or not user.avatar_path:
            raise MembershipError("not-found", "عکسی برای این حساب نیست.")
        path = user.avatar_path
        name = _display_name(user) or f"user-{user.id}"
    if not is_managed_path(path):
        raise MembershipError("not-found", "عکسی برای این حساب نیست.")
    filename = (path or "").replace("\\", "/").rsplit("/", 1)[-1]
    file_path = AVATAR_DIR / filename
    if not file_path.is_file():
        raise MembershipError("not-found", "فایل عکس پیدا نشد.")
    safe_name = re.sub(r"[^\w\u0600-\u06FF-]+", "_", name).strip("_") or f"user-{user_id}"
    return file_path, f"{safe_name}.webp"


def _serialize_revisions(session, user_id: int) -> list[dict]:
    rows = session.execute(
        select(ProfileRevision)
        .where(ProfileRevision.user_id == user_id)
        .order_by(ProfileRevision.created_at.desc())
        .limit(40)
    ).scalars().all()
    actor_ids = {row.actor_id for row in rows if row.actor_id}
    actors: dict[int, User] = {}
    if actor_ids:
        found = session.execute(select(User).where(User.id.in_(actor_ids))).scalars().all()
        actors = {item.id: item for item in found}
    out = []
    for row in rows:
        actor = actors.get(row.actor_id) if row.actor_id else None
        out.append(
            {
                "id": row.id,
                "source": row.source,
                "actor_name": _display_name(actor),
                "created_at": _iso(row.created_at),
                "changes": row.changes or {},
            }
        )
    return out

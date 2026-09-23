"""Membership helpers: phone normalize, password hash, sessions, first-admin seed."""

from __future__ import annotations

import hashlib
import re
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHash, VerificationError, VerifyMismatchError
from sqlalchemy import func, or_, select, text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy import inspect as sa_inspect

from backend.avatars import (
    AVATAR_DIR,
    AvatarError,
    delete_avatar_file,
    is_managed_path,
    public_url,
    save_user_avatar,
)
from backend.database import db_session
from backend.models import OtpChallenge, ProfileRevision, RegistrationRequest, User, UserSession
from backend.settings import get_settings

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
SESSION_DAYS = 14

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
    """Create or refresh the env admin so login has one is_admin account."""
    settings = get_settings()
    phone = normalize_phone(settings.admin_phone)
    password = settings.admin_password.get_secret_value()
    if not phone and not password:
        return
    if not is_mobile_phone(phone):
        raise RuntimeError("ADMIN_PHONE must be an 11-digit Iranian mobile like 09121234567.")
    if len(password) < 8:
        raise RuntimeError("ADMIN_PASSWORD must be at least 8 characters.")

    password_hash = hash_password(password)
    with db_session() as session:
        user = session.execute(select(User).where(User.phone == phone)).scalar_one_or_none()
        if user is None:
            session.add(
                User(
                    phone=phone,
                    first_name="مدیر",
                    last_name="سامانه",
                    role_title="مدیر",
                    password_hash=password_hash,
                    is_admin=True,
                    is_active=True,
                )
            )
            return
        user.password_hash = password_hash
        user.is_admin = True
        user.is_active = True


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
        "birth_date": _safe_birth_date(user),
        "email": _safe_attr(user, "email") or "",
        "address": _safe_attr(user, "address") or "",
        "is_admin": bool(user.is_admin),
        "avatar_url": public_url(user.avatar_path),
        "updated_at": _iso(user.updated_at),
    }


def _safe_attr(user, name: str):
    try:
        state = sa_inspect(user)
        if name in state.unloaded:
            return None
        return getattr(user, name)
    except Exception:
        return None


def _safe_birth_date(user) -> str:
    value = _safe_attr(user, "birth_date")
    if value is None:
        return ""
    try:
        return value.isoformat()
    except Exception:
        return ""


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


def create_session(user_id: int) -> tuple[str, datetime]:
    raw = secrets.token_urlsafe(32)
    expires_at = datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS)
    with db_session() as session:
        session.add(
            UserSession(user_id=user_id, token_hash=_token_hash(raw), expires_at=expires_at)
        )
    return raw, expires_at


def authenticate(phone: str, password: str) -> dict | None:
    phone = normalize_phone(phone)
    password = normalize_secret(password)
    if not is_mobile_phone(phone) or not password:
        return None
    with db_session() as session:
        user = session.execute(
            select(User).where(or_(User.phone == phone, func.trim(User.phone) == phone))
        ).scalars().first()
        if user is None:
            return None
        if user.is_active is False:
            return None
        stored_hash = (user.password_hash or "").strip()
        if not stored_hash:
            return None
        if not verify_password(stored_hash, password):
            return None
        profile = public_profile(user)
        user_id = user.id
    token, expires_at = create_session(user_id)
    return {"profile": profile, "token": token, "expires_at": expires_at}


def lookup_auth_gate(phone: str) -> str:
    """Route a phone to login, register, pending, or rejected. No extra profile data."""
    phone = normalize_phone(phone)
    if not is_mobile_phone(phone):
        raise MembershipError("phone", "شماره موبایل نامعتبر است.")
    # Column-limited SQL: the User ORM still maps deferred profile fields.
    try:
        with db_session() as session:
            user = session.execute(
                text("SELECT is_active FROM users WHERE btrim(phone) = :p LIMIT 1"),
                {"p": phone},
            ).first()
            requests = session.execute(
                text(
                    "SELECT status FROM registration_requests "
                    "WHERE btrim(phone) = :p ORDER BY id DESC"
                ),
                {"p": phone},
            ).all()
            statuses = [row[0] for row in requests]
            if any(status == "pending" for status in statuses):
                return "pending"
            if user is not None and user[0] is not False:
                return "login"
            latest = statuses[0] if statuses else None
            if latest == "rejected":
                return "rejected"
            if latest == "approved":
                return "login"
            return "register"
    except SQLAlchemyError as err:
        from backend.authlog import write_auth_log

        write_auth_log("gate sql", err)
        raise MembershipError("server", "خطای داخلی سرور.") from err


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
        try:
            session.refresh(user, attribute_names=["birth_date", "email", "address"])
        except Exception:
            pass
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
        return serialize_request(row)


def register_after_otp(
    first_name: str,
    last_name: str,
    phone: str,
    role_title: str,
    organization: str,
    password: str,
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
        consume_verified_otp_in_session(session, phone, "register")
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
        return serialize_request(row)


def reset_password_after_otp(phone: str, password: str) -> dict:
    from backend.otp import consume_verified_otp_in_session

    phone = normalize_phone(phone)
    password = normalize_secret(password)
    if not is_mobile_phone(phone):
        raise MembershipError("phone", "شماره موبایل نامعتبر است.")
    if len(password) < 8:
        raise MembershipError("password", "رمز عبور حداقل ۸ نویسه باشد.")
    now = datetime.now(timezone.utc)
    with db_session() as session:
        user = session.execute(select(User).where(User.phone == phone)).scalar_one_or_none()
        if user is None or user.is_active is False:
            raise MembershipError("not-found", "حسابی با این شماره پیدا نشد.")
        consume_verified_otp_in_session(session, phone, "reset")
        user.password_hash = hash_password(password)
        user.updated_at = now
        for row in session.execute(select(UserSession).where(UserSession.user_id == user.id)).scalars().all():
            session.delete(row)
        profile = public_profile(user)
        user_id = user.id
    token, expires_at = create_session(user_id)
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
        if req.status != "pending":
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
        return serialize_request(req)


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
        "birth_date": _safe_birth_date(user),
        "email": _safe_attr(user, "email") or "",
        "address": _safe_attr(user, "address") or "",
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
        user = session.get(User, user_id)
        if user is None:
            raise MembershipError("not-found", "حساب پیدا نشد.")
        if user.is_admin:
            admin_count = session.execute(
                select(func.count()).select_from(User).where(User.is_admin.is_(True))
            ).scalar_one()
            if int(admin_count or 0) <= 1:
                raise MembershipError("forbidden", "آخرین مدیر را نمی‌توان حذف کرد.")
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

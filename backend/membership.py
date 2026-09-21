"""Membership helpers: phone normalize, password hash, sessions, first-admin seed."""

from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta, timezone

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from sqlalchemy import select

from backend.database import db_session
from backend.models import User, UserSession
from backend.settings import get_settings

SESSION_COOKIE = "bina_session"
SESSION_DAYS = 14

_hasher = PasswordHasher()

_FA_DIGITS = str.maketrans("۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩", "01234567890123456789")


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


def hash_password(plain: str) -> str:
    return _hasher.hash(plain)


def verify_password(password_hash: str, plain: str) -> bool:
    try:
        return bool(_hasher.verify(password_hash, plain))
    except (VerifyMismatchError, ValueError, TypeError):
        return False


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


def public_profile(user: User) -> dict:
    return {
        "first_name": user.first_name or "",
        "last_name": user.last_name or "",
        "phone": user.phone,
        "role_title": user.role_title or "",
        "organization": user.organization or "",
        "is_admin": bool(user.is_admin),
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
    if not is_mobile_phone(phone) or not password:
        return None
    with db_session() as session:
        user = session.execute(select(User).where(User.phone == phone)).scalar_one_or_none()
        if user is None or not user.is_active or not user.password_hash:
            return None
        if not verify_password(user.password_hash, password):
            return None
        profile = public_profile(user)
        user_id = user.id
    token, expires_at = create_session(user_id)
    return {"profile": profile, "token": token, "expires_at": expires_at}


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

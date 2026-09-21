"""Membership helpers: phone normalize, password hash, first-admin seed from env."""

from __future__ import annotations

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from sqlalchemy import select

from backend.database import db_session
from backend.models import User
from backend.settings import get_settings

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

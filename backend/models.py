"""SQLAlchemy models matching the current dashboard tables (empty Postgres schema)."""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Identity,
    Index,
    LargeBinary,
    Integer,
    MetaData,
    REAL,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    # Keep pre-schema names for implicit single-column indexes. SQLAlchemy's
    # default column label includes the schema after a table moves.
    metadata = MetaData(naming_convention={"ix": "ix_%(table_name)s_%(column_0_name)s"})


class Topic(Base):
    __tablename__ = "topics"
    __table_args__ = (UniqueConstraint("topic_name", name="uq_topics_name"),
        {"schema": "analytics"},
    )

    id: Mapped[int] = mapped_column(Integer, Identity(), primary_key=True)
    topic_name: Mapped[str | None] = mapped_column(Text)
    topic_description: Mapped[str | None] = mapped_column(Text)
    lower_color: Mapped[str | None] = mapped_column(Text)
    upper_color: Mapped[str | None] = mapped_column(Text)
    master_color: Mapped[str | None] = mapped_column(Text)


class KDescription(Base):
    __tablename__ = "kdescription"
    __table_args__ = (
        UniqueConstraint("indicator_name", name="uq_kdescription_indicator"),
        Index("idx_kdescription_topic_sub", "topic_name", "subtopic_name"),
        {"schema": "analytics"},
    )

    id: Mapped[int] = mapped_column(Integer, Identity(), primary_key=True)
    topic_name: Mapped[str | None] = mapped_column(Text)
    subtopic_name: Mapped[str | None] = mapped_column(Text)
    indicator_name: Mapped[str | None] = mapped_column(Text)
    description: Mapped[str | None] = mapped_column(Text)
    source_name: Mapped[str | None] = mapped_column(Text)
    measurement_unit: Mapped[str | None] = mapped_column(Text)
    question: Mapped[str | None] = mapped_column(Text)


class KIndicatorScore(Base):
    __tablename__ = "kindicator_score"
    __table_args__ = (
        UniqueConstraint(
            "indicator_name",
            "year",
            "province_name",
            name="uq_kindicator_score",
        ),
        Index("idx_kindicator_province", "province_name"),
        Index(
            "idx_kindicator_topic_sub",
            "topic_name",
            "subtopic_name",
            "province_name",
            "indicator_name",
            "year",
        ),
        {"schema": "analytics"},
    )

    id: Mapped[int] = mapped_column(Integer, Identity(), primary_key=True)
    province_name: Mapped[str | None] = mapped_column(Text)
    topic_name: Mapped[str | None] = mapped_column(Text)
    subtopic_name: Mapped[str | None] = mapped_column(Text)
    indicator_name: Mapped[str | None] = mapped_column(Text)
    year: Mapped[int | None] = mapped_column(Integer)
    direction: Mapped[float | None] = mapped_column(Float)
    value: Mapped[float | None] = mapped_column(Float)
    standard_value: Mapped[float | None] = mapped_column(Float)


class TrendScore(Base):
    __tablename__ = "trend_score"
    __table_args__ = (
        UniqueConstraint(
            "province_name",
            "year",
            "topic_name",
            name="uq_trend_score",
        ),
        Index("idx_trend_score_topic_year", "topic_name", "year"),
        {"schema": "analytics"},
    )

    id: Mapped[int] = mapped_column(Integer, Identity(), primary_key=True)
    province_name: Mapped[str | None] = mapped_column(Text)
    year: Mapped[int | None] = mapped_column(Integer)
    index_score: Mapped[float | None] = mapped_column(Float)
    topic_name: Mapped[str | None] = mapped_column(Text)
    province_rank: Mapped[float | None] = mapped_column(Float)
    # Imported source metadata is single precision in the production database.
    coverage_count: Mapped[float | None] = mapped_column(REAL)
    max_observation_age: Mapped[float | None] = mapped_column(REAL)


class ProvincePop(Base):
    __tablename__ = "province_pop"
    __table_args__ = (
        UniqueConstraint("province_name", "year", name="uq_province_pop"),
        {"schema": "analytics"},
    )

    id: Mapped[int] = mapped_column(Integer, Identity(), primary_key=True)
    province_name: Mapped[str | None] = mapped_column(Text)
    province_pop: Mapped[float | None] = mapped_column(Float)
    year: Mapped[int | None] = mapped_column(Integer)


class Cluster(Base):
    __tablename__ = "clusters"
    __table_args__ = (
        UniqueConstraint(
            "province_name",
            "topic_name",
            "subtopic_name",
            name="uq_clusters",
        ),
        {"schema": "analytics"},
    )

    id: Mapped[int] = mapped_column(Integer, Identity(), primary_key=True)
    province_name: Mapped[str | None] = mapped_column(Text)
    topic_name: Mapped[str | None] = mapped_column(Text)
    subtopic_name: Mapped[str | None] = mapped_column(Text)
    cluster_group: Mapped[int | None] = mapped_column(Integer)
    subtopic_score: Mapped[float | None] = mapped_column(Float)


class Province(Base):
    __tablename__ = "provinces"
    __table_args__ = {"schema": "analytics"}

    province_name: Mapped[str] = mapped_column(Text, primary_key=True)
    is_national: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")


class Pyramid(Base):
    __tablename__ = "pyramid"
    __table_args__ = {"schema": "analytics"}

    province_name: Mapped[str] = mapped_column(Text, primary_key=True)
    year: Mapped[int] = mapped_column(Integer, primary_key=True)
    age: Mapped[int] = mapped_column(Integer, primary_key=True)
    male: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    female: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    urban: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    rural: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")


class User(Base):
    __tablename__ = "users"
    __table_args__ = (UniqueConstraint("phone", name="users_phone_key"),
        {"schema": "accounts"},
    )

    id: Mapped[int] = mapped_column(Integer, Identity(), primary_key=True)
    phone: Mapped[str] = mapped_column(String(15), nullable=False)
    first_name: Mapped[str] = mapped_column(String(80), nullable=False, server_default="")
    last_name: Mapped[str] = mapped_column(String(80), nullable=False, server_default="")
    role_title: Mapped[str | None] = mapped_column(String(80))
    organization: Mapped[str | None] = mapped_column(String(120))
    birth_date: Mapped[date | None] = mapped_column(Date)
    email: Mapped[str | None] = mapped_column(String(120))
    address: Mapped[str | None] = mapped_column(String(255))
    password_hash: Mapped[str | None] = mapped_column(String(255))
    is_admin: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    login_failed_attempts: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    login_failure_window_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    login_locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deactivation_reason: Mapped[str | None] = mapped_column(String(48))
    deactivated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deactivated_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("accounts.users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
    )
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    approved_by: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("accounts.users.id", ondelete="SET NULL")
    )
    avatar_path: Mapped[str | None] = mapped_column(String(255))
    updated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
    )


class RegistrationRequest(Base):
    __tablename__ = "registration_requests"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'approved', 'rejected')",
            name="ck_registration_requests_status",
        ),
        Index("idx_registration_requests_status_created", "status", "created_at"),
        Index("idx_registration_requests_phone", "phone"),
        Index(
            "uq_registration_requests_pending_phone",
            "phone",
            unique=True,
            postgresql_where=text("status = 'pending'"),
        ),
        {"schema": "accounts"},
    )

    id: Mapped[int] = mapped_column(Integer, Identity(), primary_key=True)
    phone: Mapped[str] = mapped_column(String(15), nullable=False)
    first_name: Mapped[str] = mapped_column(String(80), nullable=False)
    last_name: Mapped[str] = mapped_column(String(80), nullable=False)
    role_title: Mapped[str] = mapped_column(String(80), nullable=False)
    organization: Mapped[str | None] = mapped_column(String(120))
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default="pending"
    )
    note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
    )
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reviewed_by: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("accounts.users.id", ondelete="SET NULL")
    )


class UserSession(Base):
    __tablename__ = "sessions"
    __table_args__ = (
        UniqueConstraint("token_hash", name="uq_sessions_token_hash"),
        Index("idx_sessions_user_id", "user_id"),
        Index("idx_sessions_expires_at", "expires_at"),
        {"schema": "accounts"},
    )

    id: Mapped[int] = mapped_column(Integer, Identity(), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("accounts.users.id", ondelete="CASCADE"), nullable=False
    )
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
    )


class OtpChallenge(Base):
    """Short-lived SMS OTP for register or password reset. Codes are stored hashed."""

    __tablename__ = "otp_challenges"
    __table_args__ = (
        CheckConstraint(
            "purpose IN ('register', 'reset')",
            name="ck_otp_challenges_purpose",
        ),
        Index("idx_otp_challenges_phone_purpose_created", "phone", "purpose", "created_at"),
        {"schema": "accounts"},
    )

    id: Mapped[int] = mapped_column(Integer, Identity(), primary_key=True)
    phone: Mapped[str] = mapped_column(String(15), nullable=False)
    purpose: Mapped[str] = mapped_column(String(16), nullable=False)
    code_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    salt: Mapped[str] = mapped_column(String(32), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    verification_token_hash: Mapped[str | None] = mapped_column(String(64))
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
    )


class CaptchaChallenge(Base):
    """One-time, backend-rendered CAPTCHA for the login operation."""

    __tablename__ = "captcha_challenges"
    __table_args__ = (
        CheckConstraint("purpose IN ('login', 'register', 'reset', 'support')", name="ck_captcha_challenges_purpose"),
        Index("idx_captcha_challenges_binding_created", "binding_hash", "created_at"),
        Index("idx_captcha_challenges_ip_created", "ip_hash", "created_at"),
        Index("idx_captcha_challenges_expires", "expires_at"),
        {"schema": "accounts"},
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    purpose: Mapped[str] = mapped_column(String(16), nullable=False)
    binding_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    ip_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    answer_hmac: Mapped[str] = mapped_column(String(64), nullable=False)
    image_png: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

class SiteSetting(Base):
    __tablename__ = "site_settings"
    __table_args__ = {"schema": "app"}

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(String(255), nullable=False, server_default="")


class LoginFailure(Base):
    __tablename__ = "login_failures"
    __table_args__ = (Index("idx_login_failures_created_at", "created_at"),
        {"schema": "accounts"},
    )

    id: Mapped[int] = mapped_column(Integer, Identity(), primary_key=True)
    phone_mask: Mapped[str] = mapped_column(String(20), nullable=False)
    reason: Mapped[str] = mapped_column(String(24), nullable=False)
    created_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
    )


class ProfileRevision(Base):
    """Append-only log of profile field and avatar changes."""

    __tablename__ = "profile_revisions"
    __table_args__ = (
        CheckConstraint(
            "source IN ('self', 'admin', 'system')",
            name="ck_profile_revisions_source",
        ),
        Index("idx_profile_revisions_user_created", "user_id", "created_at"),
        {"schema": "accounts"},
    )

    id: Mapped[int] = mapped_column(Integer, Identity(), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("accounts.users.id", ondelete="CASCADE"), nullable=False
    )
    actor_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("accounts.users.id", ondelete="SET NULL")
    )
    source: Mapped[str] = mapped_column(String(16), nullable=False)
    changes: Mapped[dict] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
    )


class SupportTicket(Base):
    __tablename__ = "support_tickets"
    __table_args__ = (
        CheckConstraint("status IN ('open', 'in_progress', 'awaiting_user', 'closed')", name="ck_support_ticket_status"),
        Index("idx_support_tickets_status_updated", "status", "updated_at"),
        Index("idx_support_tickets_user_updated_id", "user_id", text("updated_at DESC"), text("id DESC"), postgresql_where=text("user_id IS NOT NULL")),
        {"schema": "support"},
    )
    id: Mapped[int] = mapped_column(Integer, Identity(), primary_key=True)
    user_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("accounts.users.id", name="fk_support_tickets_user", ondelete="CASCADE"))
    reference: Mapped[str] = mapped_column(String(20), nullable=False, unique=True)
    # Legacy column retained for schema compatibility; tracking now uses reference only.
    access_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    name: Mapped[str | None] = mapped_column(String(80))
    phone: Mapped[str | None] = mapped_column(String(15))
    category: Mapped[str] = mapped_column(String(20), nullable=False)
    subject: Mapped[str] = mapped_column(String(160), nullable=False)
    stage: Mapped[str | None] = mapped_column(String(32))
    error_code: Mapped[str | None] = mapped_column(String(48))
    error_reference: Mapped[str | None] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(20), nullable=False, server_default="open")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class SupportMessage(Base):
    __tablename__ = "support_messages"
    __table_args__ = (Index("idx_support_messages_ticket_id", "ticket_id", "id"),
        {"schema": "support"},
    )
    id: Mapped[int] = mapped_column(Integer, Identity(), primary_key=True)
    ticket_id: Mapped[int] = mapped_column(Integer, ForeignKey("support.support_tickets.id", ondelete="CASCADE"), nullable=False)
    author: Mapped[str] = mapped_column(String(12), nullable=False)
    actor_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("accounts.users.id", ondelete="SET NULL"))
    body: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class SupportStatusEvent(Base):
    __tablename__ = "support_status_events"
    __table_args__ = {"schema": "support"}
    id: Mapped[int] = mapped_column(Integer, Identity(), primary_key=True)
    ticket_id: Mapped[int] = mapped_column(Integer, ForeignKey("support.support_tickets.id", ondelete="CASCADE"), nullable=False, index=True)
    actor_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("accounts.users.id", ondelete="SET NULL"))
    from_status: Mapped[str] = mapped_column(String(20), nullable=False)
    to_status: Mapped[str] = mapped_column(String(20), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class AccountStatusEvent(Base):
    __tablename__ = "account_status_events"
    __table_args__ = {"schema": "accounts"}
    id: Mapped[int] = mapped_column(Integer, Identity(), primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("accounts.users.id", ondelete="CASCADE"), nullable=False, index=True)
    actor_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("accounts.users.id", ondelete="SET NULL"))
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    reason: Mapped[str | None] = mapped_column(String(160))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class SupportAttachment(Base):
    """Private, re-encoded images; staged rows expire unless claimed by a message."""
    __tablename__ = "support_attachments"
    __table_args__ = (
        CheckConstraint("state IN ('ready', 'deleted')", name="ck_support_attachment_state"),
        CheckConstraint("size_bytes > 0 AND source_bytes > 0", name="ck_support_attachment_size"),
        Index("idx_support_attachments_message", "message_id", postgresql_where=text("message_id IS NOT NULL")),
        Index("idx_support_attachments_ticket", "ticket_id", postgresql_where=text("ticket_id IS NOT NULL")),
        Index("idx_support_attachments_uploader_created", "uploader_id", "created_at"),
        Index("idx_support_attachments_pending_expires", "expires_at", postgresql_where=text("message_id IS NULL")),
        {"schema": "support"},
    )
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    uploader_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("accounts.users.id", ondelete="SET NULL"))
    ticket_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("support.support_tickets.id", ondelete="CASCADE"))
    message_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("support.support_messages.id", ondelete="CASCADE"))
    original_name: Mapped[str] = mapped_column(String(180), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    source_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    width: Mapped[int] = mapped_column(Integer, nullable=False)
    height: Mapped[int] = mapped_column(Integer, nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    state: Mapped[str] = mapped_column(String(12), nullable=False, server_default="ready")
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

# Register acquisition tables for Alembic and application/test metadata.
from backend import poi_models as _poi_models  # noqa: E402,F401

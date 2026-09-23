"""SQLAlchemy models matching the current dashboard tables (empty Postgres schema)."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Identity,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Topic(Base):
    __tablename__ = "topics"
    __table_args__ = (UniqueConstraint("topic_name", name="uq_topics_name"),)

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
    )

    id: Mapped[int] = mapped_column(Integer, Identity(), primary_key=True)
    topic_name: Mapped[str | None] = mapped_column(Text)
    subtopic_name: Mapped[str | None] = mapped_column(Text)
    indicator_name: Mapped[str | None] = mapped_column(Text)
    description: Mapped[str | None] = mapped_column(Text)
    source_name: Mapped[str | None] = mapped_column(Text)


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
    )

    id: Mapped[int] = mapped_column(Integer, Identity(), primary_key=True)
    province_name: Mapped[str | None] = mapped_column(Text)
    year: Mapped[int | None] = mapped_column(Integer)
    index_score: Mapped[float | None] = mapped_column(Float)
    topic_name: Mapped[str | None] = mapped_column(Text)
    province_rank: Mapped[float | None] = mapped_column(Float)


class ProvincePop(Base):
    __tablename__ = "province_pop"
    __table_args__ = (
        UniqueConstraint("province_name", "year", name="uq_province_pop"),
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
    )

    id: Mapped[int] = mapped_column(Integer, Identity(), primary_key=True)
    province_name: Mapped[str | None] = mapped_column(Text)
    topic_name: Mapped[str | None] = mapped_column(Text)
    subtopic_name: Mapped[str | None] = mapped_column(Text)
    cluster_group: Mapped[int | None] = mapped_column(Integer)
    subtopic_score: Mapped[float | None] = mapped_column(Float)


class Province(Base):
    __tablename__ = "provinces"

    province_name: Mapped[str] = mapped_column(Text, primary_key=True)
    is_national: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")


class Pyramid(Base):
    __tablename__ = "pyramid"

    province_name: Mapped[str] = mapped_column(Text, primary_key=True)
    year: Mapped[int] = mapped_column(Integer, primary_key=True)
    age: Mapped[int] = mapped_column(Integer, primary_key=True)
    male: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    female: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    urban: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    rural: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")


class User(Base):
    __tablename__ = "users"
    __table_args__ = (UniqueConstraint("phone", name="users_phone_key"),)

    id: Mapped[int] = mapped_column(Integer, Identity(), primary_key=True)
    phone: Mapped[str] = mapped_column(String(15), nullable=False)
    first_name: Mapped[str] = mapped_column(String(80), nullable=False, server_default="")
    last_name: Mapped[str] = mapped_column(String(80), nullable=False, server_default="")
    role_title: Mapped[str | None] = mapped_column(String(80))
    organization: Mapped[str | None] = mapped_column(String(120))
    password_hash: Mapped[str | None] = mapped_column(String(255))
    is_admin: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    created_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
    )
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    approved_by: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="SET NULL")
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
        Integer, ForeignKey("users.id", ondelete="SET NULL")
    )


class UserSession(Base):
    __tablename__ = "sessions"
    __table_args__ = (
        UniqueConstraint("token_hash", name="uq_sessions_token_hash"),
        Index("idx_sessions_user_id", "user_id"),
        Index("idx_sessions_expires_at", "expires_at"),
    )

    id: Mapped[int] = mapped_column(Integer, Identity(), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
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
    )

    id: Mapped[int] = mapped_column(Integer, Identity(), primary_key=True)
    phone: Mapped[str] = mapped_column(String(15), nullable=False)
    purpose: Mapped[str] = mapped_column(String(16), nullable=False)
    code_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    salt: Mapped[str] = mapped_column(String(32), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
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
    )

    id: Mapped[int] = mapped_column(Integer, Identity(), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    actor_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="SET NULL")
    )
    source: Mapped[str] = mapped_column(String(16), nullable=False)
    changes: Mapped[dict] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
    )

"""SQLAlchemy models matching the current dashboard tables (empty Postgres schema)."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    DateTime,
    Float,
    Identity,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
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
    created_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
    )

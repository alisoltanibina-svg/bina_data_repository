"""membership accounts: users, registration_requests, sessions

Revision ID: 0002_membership_accounts
Revises: 0001_initial_schema
Create Date: 2026-09-21
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0002_membership_accounts"
down_revision: Union[str, Sequence[str], None] = "0001_initial_schema"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_USER_NEW_COLUMNS = (
    ("first_name", sa.Column("first_name", sa.String(80), nullable=False, server_default="")),
    ("last_name", sa.Column("last_name", sa.String(80), nullable=False, server_default="")),
    ("role_title", sa.Column("role_title", sa.String(80))),
    ("organization", sa.Column("organization", sa.String(120))),
    ("password_hash", sa.Column("password_hash", sa.String(255))),
    ("is_admin", sa.Column("is_admin", sa.Boolean(), nullable=False, server_default=sa.text("false"))),
    ("is_active", sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true"))),
    ("approved_at", sa.Column("approved_at", sa.DateTime(timezone=True))),
    ("approved_by", sa.Column("approved_by", sa.Integer())),
)


def _table_names() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _column_names(table: str) -> set[str]:
    return {col["name"] for col in sa.inspect(op.get_bind()).get_columns(table)}


def _ensure_users_table() -> None:
    if "users" not in _table_names():
        op.create_table(
            "users",
            sa.Column("id", sa.Integer(), sa.Identity(always=False), primary_key=True),
            sa.Column("phone", sa.String(15), nullable=False),
            sa.Column("first_name", sa.String(80), nullable=False, server_default=""),
            sa.Column("last_name", sa.String(80), nullable=False, server_default=""),
            sa.Column("role_title", sa.String(80)),
            sa.Column("organization", sa.String(120)),
            sa.Column("password_hash", sa.String(255)),
            sa.Column("is_admin", sa.Boolean(), nullable=False, server_default=sa.text("false")),
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
            sa.Column("approved_at", sa.DateTime(timezone=True)),
            sa.Column("approved_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL")),
            sa.UniqueConstraint("phone", name="users_phone_key"),
        )
        return
    existing = _column_names("users")
    for name, column in _USER_NEW_COLUMNS:
        if name not in existing:
            op.add_column("users", column)
    fks = {fk["name"] for fk in sa.inspect(op.get_bind()).get_foreign_keys("users")}
    if "fk_users_approved_by" not in fks and "approved_by" in _column_names("users"):
        op.create_foreign_key(
            "fk_users_approved_by",
            "users",
            "users",
            ["approved_by"],
            ["id"],
            ondelete="SET NULL",
        )


def upgrade() -> None:
    _ensure_users_table()

    if "registration_requests" not in _table_names():
        op.create_table(
            "registration_requests",
            sa.Column("id", sa.Integer(), sa.Identity(always=False), primary_key=True),
            sa.Column("phone", sa.String(15), nullable=False),
            sa.Column("first_name", sa.String(80), nullable=False),
            sa.Column("last_name", sa.String(80), nullable=False),
            sa.Column("role_title", sa.String(80), nullable=False),
            sa.Column("organization", sa.String(120)),
            sa.Column("password_hash", sa.String(255), nullable=False),
            sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
            sa.Column("note", sa.Text()),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
            sa.Column("reviewed_at", sa.DateTime(timezone=True)),
            sa.Column("reviewed_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL")),
            sa.CheckConstraint(
                "status IN ('pending', 'approved', 'rejected')",
                name="ck_registration_requests_status",
            ),
        )
        op.create_index(
            "idx_registration_requests_status_created",
            "registration_requests",
            ["status", "created_at"],
        )
        op.create_index("idx_registration_requests_phone", "registration_requests", ["phone"])
        op.create_index(
            "uq_registration_requests_pending_phone",
            "registration_requests",
            ["phone"],
            unique=True,
            postgresql_where=sa.text("status = 'pending'"),
        )

    if "sessions" not in _table_names():
        op.create_table(
            "sessions",
            sa.Column("id", sa.Integer(), sa.Identity(always=False), primary_key=True),
            sa.Column(
                "user_id",
                sa.Integer(),
                sa.ForeignKey("users.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("token_hash", sa.String(64), nullable=False),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
            sa.UniqueConstraint("token_hash", name="uq_sessions_token_hash"),
        )
        op.create_index("idx_sessions_user_id", "sessions", ["user_id"])
        op.create_index("idx_sessions_expires_at", "sessions", ["expires_at"])


def downgrade() -> None:
    names = _table_names()
    if "sessions" in names:
        op.drop_index("idx_sessions_expires_at", table_name="sessions")
        op.drop_index("idx_sessions_user_id", table_name="sessions")
        op.drop_table("sessions")
    if "registration_requests" in names:
        op.drop_index("uq_registration_requests_pending_phone", table_name="registration_requests")
        op.drop_index("idx_registration_requests_phone", table_name="registration_requests")
        op.drop_index("idx_registration_requests_status_created", table_name="registration_requests")
        op.drop_table("registration_requests")
    if "users" in names:
        fks = {fk["name"] for fk in sa.inspect(op.get_bind()).get_foreign_keys("users")}
        if "fk_users_approved_by" in fks:
            op.drop_constraint("fk_users_approved_by", "users", type_="foreignkey")
        existing = _column_names("users")
        for name, _column in reversed(_USER_NEW_COLUMNS):
            if name in existing:
                op.drop_column("users", name)

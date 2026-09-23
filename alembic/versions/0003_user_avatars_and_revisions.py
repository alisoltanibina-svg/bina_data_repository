"""user avatars and profile_revisions audit log

Revision ID: 0003_user_avatars_and_revisions
Revises: 0002_membership_accounts
Create Date: 2026-09-23
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "0003_user_avatars_and_revisions"
down_revision: Union[str, Sequence[str], None] = "0002_membership_accounts"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _table_names() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _column_names(table: str) -> set[str]:
    return {col["name"] for col in sa.inspect(op.get_bind()).get_columns(table)}


def upgrade() -> None:
    if "users" in _table_names():
        existing = _column_names("users")
        if "avatar_path" not in existing:
            op.add_column("users", sa.Column("avatar_path", sa.String(255)))
        if "updated_at" not in existing:
            op.add_column(
                "users",
                sa.Column(
                    "updated_at",
                    sa.DateTime(timezone=True),
                    server_default=sa.func.now(),
                ),
            )

    if "profile_revisions" not in _table_names():
        op.create_table(
            "profile_revisions",
            sa.Column("id", sa.Integer(), sa.Identity(always=False), primary_key=True),
            sa.Column(
                "user_id",
                sa.Integer(),
                sa.ForeignKey("users.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column(
                "actor_id",
                sa.Integer(),
                sa.ForeignKey("users.id", ondelete="SET NULL"),
            ),
            sa.Column("source", sa.String(16), nullable=False),
            sa.Column("changes", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
            ),
            sa.CheckConstraint(
                "source IN ('self', 'admin', 'system')",
                name="ck_profile_revisions_source",
            ),
        )
        op.create_index(
            "idx_profile_revisions_user_created",
            "profile_revisions",
            ["user_id", "created_at"],
        )


def downgrade() -> None:
    names = _table_names()
    if "profile_revisions" in names:
        op.drop_index("idx_profile_revisions_user_created", table_name="profile_revisions")
        op.drop_table("profile_revisions")
    if "users" in names:
        existing = _column_names("users")
        if "updated_at" in existing:
            op.drop_column("users", "updated_at")
        if "avatar_path" in existing:
            op.drop_column("users", "avatar_path")

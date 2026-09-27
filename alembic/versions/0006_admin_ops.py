"""site_settings and login_failures for admin ops

Revision ID: 0006_admin_ops
Revises: 0005_user_profile_fields
Create Date: 2026-09-27
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0006_admin_ops"
down_revision: Union[str, Sequence[str], None] = "0005_user_profile_fields"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    names = set(sa.inspect(op.get_bind()).get_table_names())
    if "site_settings" not in names:
        op.create_table(
            "site_settings",
            sa.Column("key", sa.String(64), primary_key=True),
            sa.Column("value", sa.String(255), nullable=False, server_default=""),
        )
        op.execute("INSERT INTO site_settings (key, value) VALUES ('registration_open', '1')")
    if "login_failures" not in names:
        op.create_table(
            "login_failures",
            sa.Column("id", sa.Integer(), sa.Identity(always=False), primary_key=True),
            sa.Column("phone_mask", sa.String(20), nullable=False),
            sa.Column("reason", sa.String(24), nullable=False),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
            ),
        )
        op.create_index("idx_login_failures_created_at", "login_failures", ["created_at"])


def downgrade() -> None:
    names = set(sa.inspect(op.get_bind()).get_table_names())
    if "login_failures" in names:
        op.drop_index("idx_login_failures_created_at", table_name="login_failures")
        op.drop_table("login_failures")
    if "site_settings" in names:
        op.drop_table("site_settings")

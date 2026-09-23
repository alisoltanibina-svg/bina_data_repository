"""otp_challenges for register and password-reset SMS codes

Revision ID: 0004_otp_challenges
Revises: 0003_user_avatars_and_revisions
Create Date: 2026-09-23
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0004_otp_challenges"
down_revision: Union[str, Sequence[str], None] = "0003_user_avatars_and_revisions"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    names = set(sa.inspect(op.get_bind()).get_table_names())
    if "otp_challenges" in names:
        return
    op.create_table(
        "otp_challenges",
        sa.Column("id", sa.Integer(), sa.Identity(always=False), primary_key=True),
        sa.Column("phone", sa.String(15), nullable=False),
        sa.Column("purpose", sa.String(16), nullable=False),
        sa.Column("code_hash", sa.String(64), nullable=False),
        sa.Column("salt", sa.String(32), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("verified_at", sa.DateTime(timezone=True)),
        sa.Column("consumed_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.CheckConstraint(
            "purpose IN ('register', 'reset')",
            name="ck_otp_challenges_purpose",
        ),
    )
    op.create_index(
        "idx_otp_challenges_phone_purpose_created",
        "otp_challenges",
        ["phone", "purpose", "created_at"],
    )


def downgrade() -> None:
    names = set(sa.inspect(op.get_bind()).get_table_names())
    if "otp_challenges" not in names:
        return
    op.drop_index("idx_otp_challenges_phone_purpose_created", table_name="otp_challenges")
    op.drop_table("otp_challenges")

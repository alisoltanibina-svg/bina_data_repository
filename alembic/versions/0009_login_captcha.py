"""Add first-party, single-use CAPTCHA challenges.

Revision ID: 0009_login_captcha
Revises: 0008_account_login_lockout
"""

from alembic import op
import sqlalchemy as sa

revision = "0009_login_captcha"
down_revision = "0008_account_login_lockout"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "captcha_challenges",
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column("purpose", sa.String(length=16), nullable=False),
        sa.Column("binding_hash", sa.String(length=64), nullable=False),
        sa.Column("ip_hash", sa.String(length=64), nullable=False),
        sa.Column("answer_hmac", sa.String(length=64), nullable=False),
        sa.Column("image_png", sa.LargeBinary(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("consumed_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("purpose = 'login'", name="ck_captcha_challenges_purpose"),
    )
    op.create_index("idx_captcha_challenges_binding_created", "captcha_challenges", ["binding_hash", "created_at"])
    op.create_index("idx_captcha_challenges_ip_created", "captcha_challenges", ["ip_hash", "created_at"])
    op.create_index("idx_captcha_challenges_expires", "captcha_challenges", ["expires_at"])


def downgrade() -> None:
    op.drop_table("captcha_challenges")
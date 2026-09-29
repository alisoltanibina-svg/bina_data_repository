"""Persist per-account login failures for administrator-reviewed deactivation.

Revision ID: 0008_account_login_lockout
Revises: 0007_otp_verification_tokens
"""

from alembic import op
import sqlalchemy as sa


revision = "0008_account_login_lockout"
down_revision = "0007_otp_verification_tokens"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("login_failed_attempts", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "users",
        sa.Column("login_failure_window_started_at", sa.DateTime(timezone=True)),
    )


def downgrade() -> None:
    op.drop_column("users", "login_failure_window_started_at")
    op.drop_column("users", "login_failed_attempts")

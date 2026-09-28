"""Bind OTP completion to a single-use verification credential.

Revision ID: 0007_otp_verification_tokens
Revises: 0006_admin_ops
"""
from alembic import op
import sqlalchemy as sa

revision = "0007_otp_verification_tokens"
down_revision = "0006_admin_ops"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("otp_challenges", sa.Column("verification_token_hash", sa.String(64), nullable=True))
    # In-flight OTPs from the old flow must be restarted after deployment.
    op.execute("UPDATE otp_challenges SET consumed_at = CURRENT_TIMESTAMP WHERE consumed_at IS NULL")


def downgrade() -> None:
    op.drop_column("otp_challenges", "verification_token_hash")

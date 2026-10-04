"""Allow CAPTCHA challenges for gate and password-reset flows.

Revision ID: 0010_captcha_purposes
Revises: 0009_login_captcha
"""

from alembic import op

revision = "0010_captcha_purposes"
down_revision = "0009_login_captcha"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("ck_captcha_challenges_purpose", "captcha_challenges", type_="check")
    op.create_check_constraint(
        "ck_captcha_challenges_purpose",
        "captcha_challenges",
        "purpose IN ('gate', 'login', 'reset')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_captcha_challenges_purpose", "captcha_challenges", type_="check")
    op.create_check_constraint("ck_captcha_challenges_purpose", "captcha_challenges", "purpose = 'login'")
"""Move CAPTCHA protection from the phone gate to registration.

Revision ID: 0011_registration_captcha_purpose
Revises: 0010_captcha_purposes
"""

from alembic import op

revision = "0011_registration_captcha_purpose"
down_revision = "0010_captcha_purposes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("ck_captcha_challenges_purpose", "captcha_challenges", type_="check")
    op.create_check_constraint(
        "ck_captcha_challenges_purpose",
        "captcha_challenges",
        "purpose IN ('login', 'register', 'reset')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_captcha_challenges_purpose", "captcha_challenges", type_="check")
    op.create_check_constraint(
        "ck_captcha_challenges_purpose",
        "captcha_challenges",
        "purpose IN ('login', 'register', 'reset')",
    )
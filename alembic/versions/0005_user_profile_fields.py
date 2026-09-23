"""users.birth_date, email, address

Revision ID: 0005_user_profile_fields
Revises: 0004_otp_challenges
Create Date: 2026-09-23
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0005_user_profile_fields"
down_revision: Union[str, Sequence[str], None] = "0004_otp_challenges"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    names = set(sa.inspect(op.get_bind()).get_table_names())
    if "users" not in names:
        return
    existing = {col["name"] for col in sa.inspect(op.get_bind()).get_columns("users")}
    if "birth_date" not in existing:
        op.add_column("users", sa.Column("birth_date", sa.Date()))
    if "email" not in existing:
        op.add_column("users", sa.Column("email", sa.String(120)))
    if "address" not in existing:
        op.add_column("users", sa.Column("address", sa.String(255)))


def downgrade() -> None:
    names = set(sa.inspect(op.get_bind()).get_table_names())
    if "users" not in names:
        return
    existing = {col["name"] for col in sa.inspect(op.get_bind()).get_columns("users")}
    if "address" in existing:
        op.drop_column("users", "address")
    if "email" in existing:
        op.drop_column("users", "email")
    if "birth_date" in existing:
        op.drop_column("users", "birth_date")

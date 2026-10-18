"""Associate profile tickets with their account and index paginated history.

Revision ID: 0013_account_tickets
Revises: 0012_support_recovery
"""
from alembic import op
import sqlalchemy as sa

revision = "0013_account_tickets"
down_revision = "0012_support_recovery"
branch_labels = None
depends_on = None


def upgrade():
    # Nullable with no default: PostgreSQL can add this without rewriting ticket rows.
    op.add_column("support_tickets", sa.Column("user_id", sa.Integer(), nullable=True))
    op.create_foreign_key("fk_support_tickets_user", "support_tickets", "users", ["user_id"], ["id"], ondelete="CASCADE")
    # Guest tickets do not need entries in the per-account history index.
    op.create_index("idx_support_tickets_user_updated_id", "support_tickets", ["user_id", sa.text("updated_at DESC"), sa.text("id DESC")], postgresql_where=sa.text("user_id IS NOT NULL"))


def downgrade():
    op.drop_index("idx_support_tickets_user_updated_id", table_name="support_tickets")
    op.drop_constraint("fk_support_tickets_user", "support_tickets", type_="foreignkey")
    op.drop_column("support_tickets", "user_id")

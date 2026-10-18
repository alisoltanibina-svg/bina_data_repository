"""Ticket-only support and temporary login restrictions.

Revision ID: 0012_support_recovery
Revises: 0011_register_captcha
"""
from alembic import op
import sqlalchemy as sa

revision = "0012_support_recovery"
down_revision = "0011_register_captcha"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("users", sa.Column("login_locked_until", sa.DateTime(timezone=True)))
    op.add_column("users", sa.Column("deactivation_reason", sa.String(48)))
    op.add_column("users", sa.Column("deactivated_at", sa.DateTime(timezone=True)))
    op.add_column("users", sa.Column("deactivated_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL")))
    # Existing inactive users cannot be reliably classified; never reactivate them automatically.
    op.execute("UPDATE users SET deactivation_reason = 'legacy_unknown' WHERE is_active = false")
    op.drop_constraint("ck_captcha_challenges_purpose", "captcha_challenges", type_="check")
    op.create_check_constraint("ck_captcha_challenges_purpose", "captcha_challenges", "purpose IN ('login', 'register', 'reset', 'support')")
    op.create_table("support_tickets",
        sa.Column("id", sa.Integer(), sa.Identity(), primary_key=True),
        sa.Column("reference", sa.String(20), nullable=False, unique=True),
        sa.Column("access_hash", sa.String(64), nullable=False),
        sa.Column("name", sa.String(80)), sa.Column("phone", sa.String(15)),
        sa.Column("category", sa.String(20), nullable=False),
        sa.Column("subject", sa.String(160), nullable=False),
        sa.Column("stage", sa.String(32)), sa.Column("error_code", sa.String(48)),
        sa.Column("error_reference", sa.String(32)),
        sa.Column("status", sa.String(20), nullable=False, server_default="open"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("status IN ('open', 'in_progress', 'awaiting_user', 'closed')", name="ck_support_ticket_status"))
    op.create_index("idx_support_tickets_status_updated", "support_tickets", ["status", "updated_at"])
    op.create_table("support_messages",
        sa.Column("id", sa.Integer(), sa.Identity(), primary_key=True),
        sa.Column("ticket_id", sa.Integer(), sa.ForeignKey("support_tickets.id", ondelete="CASCADE"), nullable=False),
        sa.Column("author", sa.String(12), nullable=False),
        sa.Column("actor_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()))
    op.create_index("idx_support_messages_ticket_id", "support_messages", ["ticket_id", "id"])
    op.create_table("support_status_events",
        sa.Column("id", sa.Integer(), sa.Identity(), primary_key=True),
        sa.Column("ticket_id", sa.Integer(), sa.ForeignKey("support_tickets.id", ondelete="CASCADE"), nullable=False),
        sa.Column("actor_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("from_status", sa.String(20), nullable=False), sa.Column("to_status", sa.String(20), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()))
    op.create_index("ix_support_status_events_ticket_id", "support_status_events", ["ticket_id"])
    op.create_table("account_status_events",
        sa.Column("id", sa.Integer(), sa.Identity(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("actor_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("kind", sa.String(32), nullable=False), sa.Column("reason", sa.String(160)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()))
    op.create_index("ix_account_status_events_user_id", "account_status_events", ["user_id"])


def downgrade():
    for table in ("account_status_events", "support_status_events", "support_messages", "support_tickets"):
        op.drop_table(table)
    op.execute("DELETE FROM captcha_challenges WHERE purpose = 'support'")
    op.drop_constraint("ck_captcha_challenges_purpose", "captcha_challenges", type_="check")
    op.create_check_constraint("ck_captcha_challenges_purpose", "captcha_challenges", "purpose IN ('login', 'register', 'reset')")
    for column in ("deactivated_by", "deactivated_at", "deactivation_reason", "login_locked_until"):
        op.drop_column("users", column)

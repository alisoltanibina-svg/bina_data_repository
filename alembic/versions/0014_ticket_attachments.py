"""Private ticket image attachments with staged-upload cleanup and quota indexes.

Revision ID: 0014_ticket_attachments
Revises: 0013_account_tickets
"""
from alembic import op
import sqlalchemy as sa
revision = "0014_ticket_attachments"
down_revision = "0013_account_tickets"
branch_labels = None
depends_on = None

def upgrade():
    op.create_table("support_attachments",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("uploader_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("ticket_id", sa.Integer(), sa.ForeignKey("support_tickets.id", ondelete="CASCADE")),
        sa.Column("message_id", sa.Integer(), sa.ForeignKey("support_messages.id", ondelete="CASCADE")),
        sa.Column("original_name", sa.String(180), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("source_bytes", sa.Integer(), nullable=False),
        sa.Column("width", sa.Integer(), nullable=False), sa.Column("height", sa.Integer(), nullable=False),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("state", sa.String(12), nullable=False, server_default="ready"),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("state IN ('ready', 'deleted')", name="ck_support_attachment_state"),
        sa.CheckConstraint("size_bytes > 0 AND source_bytes > 0", name="ck_support_attachment_size"))
    op.create_index("idx_support_attachments_message", "support_attachments", ["message_id"], postgresql_where=sa.text("message_id IS NOT NULL"))
    op.create_index("idx_support_attachments_ticket", "support_attachments", ["ticket_id"], postgresql_where=sa.text("ticket_id IS NOT NULL"))
    op.create_index("idx_support_attachments_uploader_created", "support_attachments", ["uploader_id", "created_at"])
    op.create_index("idx_support_attachments_pending_expires", "support_attachments", ["expires_at"], postgresql_where=sa.text("message_id IS NULL"))

def downgrade():
    op.drop_table("support_attachments")

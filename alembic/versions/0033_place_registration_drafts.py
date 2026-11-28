"""Durable account-owned place registration wizard drafts."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID,JSONB

revision='0033_place_registration_drafts'
down_revision='0032_poi_matching_indexes'
branch_labels=depends_on=None


def upgrade():
    op.drop_constraint('ck_poi_edit_status','poi_edit_revisions',schema='poi',type_='check')
    op.create_check_constraint('ck_poi_edit_status','poi_edit_revisions',"status IN ('pending','approved','rejected','cancelled')",schema='poi')
    op.create_table('poi_registration_drafts',
        sa.Column('id',UUID(as_uuid=True),primary_key=True),
        sa.Column('user_id',sa.Integer(),sa.ForeignKey('accounts.users.id',ondelete='CASCADE'),nullable=False),
        sa.Column('scope',sa.String(40),nullable=False),
        sa.Column('place_id',UUID(as_uuid=True)),
        sa.Column('revision_id',UUID(as_uuid=True),sa.ForeignKey('poi.poi_edit_revisions.id')),
        sa.Column('photo_id',UUID(as_uuid=True),sa.ForeignKey('poi.poi_place_photos.id',ondelete='SET NULL')),
        sa.Column('status',sa.String(12),nullable=False,server_default='draft'),
        sa.Column('version',sa.Integer(),nullable=False,server_default='0'),
        sa.Column('step',sa.Integer(),nullable=False,server_default='1'),
        sa.Column('data',JSONB,nullable=False,server_default='{}'),
        sa.Column('created_at',sa.DateTime(timezone=True),nullable=False,server_default=sa.func.now()),
        sa.Column('updated_at',sa.DateTime(timezone=True),nullable=False,server_default=sa.func.now()),
        sa.CheckConstraint("status IN ('draft','pending','rejected','approved','cancelled')",name='ck_poi_registration_draft_status'),
        sa.CheckConstraint('step BETWEEN 1 AND 4',name='ck_poi_registration_draft_step'),schema='poi')
    op.create_index('idx_poi_registration_draft_owner','poi_registration_drafts',['user_id','scope','status'],schema='poi')


def downgrade():
    op.drop_table('poi_registration_drafts',schema='poi')
    # Preserve cancellation history when reverting to the older status vocabulary.
    op.execute("UPDATE poi.poi_edit_revisions SET status='rejected' WHERE status='cancelled'")
    op.drop_constraint('ck_poi_edit_status','poi_edit_revisions',schema='poi',type_='check')
    op.create_check_constraint('ck_poi_edit_status','poi_edit_revisions',"status IN ('pending','approved','rejected')",schema='poi')

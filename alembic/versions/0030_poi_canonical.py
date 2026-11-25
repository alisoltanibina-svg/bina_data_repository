"""Stable source aliases without removing collector rows or editorial history."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID,JSONB

revision='0030_poi_canonical'
down_revision='0029_place_photos_sms'
branch_labels=depends_on=None


def upgrade():
    op.create_index('idx_poi_request_nearby_target','poi_requests',['job_id','target_id','id'],schema='poi',
        postgresql_where=sa.text("kind='nearby' AND target_type='segment' AND outcome='successful'"))
    op.create_table('poi_place_links',
        sa.Column('source_id',UUID(as_uuid=True),sa.ForeignKey('poi.poi_places.id'),primary_key=True),
        sa.Column('canonical_id',UUID(as_uuid=True),sa.ForeignKey('poi.poi_places.id'),nullable=False),
        sa.Column('reason',sa.Text(),nullable=False),sa.Column('linked_by',sa.String(100),nullable=False),
        sa.Column('created_at',sa.DateTime(timezone=True),nullable=False,server_default=sa.func.now()),
        sa.CheckConstraint('source_id <> canonical_id',name='ck_poi_place_link_not_self'),schema='poi')
    op.create_index('idx_poi_place_link_canonical','poi_place_links',['canonical_id'],schema='poi')
    op.create_table('poi_provider_aliases',sa.Column('provider',sa.String(30),primary_key=True),
        sa.Column('token_digest',sa.String(64),primary_key=True),
        sa.Column('place_id',UUID(as_uuid=True),sa.ForeignKey('poi.poi_places.id'),nullable=False),
        sa.Column('observed_at',sa.DateTime(timezone=True),nullable=False,server_default=sa.func.now()),schema='poi')
    op.create_index('idx_poi_provider_alias_place','poi_provider_aliases',['place_id'],schema='poi')
    op.create_table('poi_canonical_events',sa.Column('id',UUID(as_uuid=True),primary_key=True),
        sa.Column('canonical_id',UUID(as_uuid=True),sa.ForeignKey('poi.poi_places.id'),nullable=False),
        sa.Column('members',JSONB(),nullable=False),sa.Column('previous_mapping',JSONB(),nullable=False),
        sa.Column('actor',sa.String(100),nullable=False),sa.Column('reason',sa.Text(),nullable=False),
        sa.Column('created_at',sa.DateTime(timezone=True),nullable=False,server_default=sa.func.now()),schema='poi')


def downgrade():
    # The original records, their provider identifiers and all editorial rows
    # survive a rollback; only the new registry is removed.
    op.drop_index('idx_poi_request_nearby_target',table_name='poi_requests',schema='poi')
    op.drop_table('poi_canonical_events',schema='poi')
    op.drop_table('poi_provider_aliases',schema='poi')
    op.drop_table('poi_place_links',schema='poi')

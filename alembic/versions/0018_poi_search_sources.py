"""Immutable user search sources and settlement-buffer planning."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID
revision='0018_poi_search_sources'
down_revision='0017_poi_pilot'
branch_labels=None
depends_on=None


def upgrade():
    op.create_table('poi_source_datasets',
        sa.Column('version',sa.String(64),primary_key=True),
        sa.Column('manifest',JSONB,nullable=False),sa.Column('summary',JSONB,nullable=False),
        sa.Column('created_at',sa.DateTime(timezone=True),nullable=False,server_default=sa.func.now()))
    op.create_table('poi_settlements',
        sa.Column('id',UUID(as_uuid=True),primary_key=True),
        sa.Column('version',sa.String(64),sa.ForeignKey('poi_source_datasets.version'),nullable=False),
        sa.Column('code',sa.String(64),nullable=False),sa.Column('name',sa.Text,nullable=False),
        sa.Column('declared_province',sa.Text,nullable=False),sa.Column('province_name',sa.Text),
        sa.Column('county_name',sa.Text),sa.Column('district_code',sa.Text),sa.Column('rural_area_code',sa.Text),
        sa.Column('latitude',sa.Float,nullable=False),sa.Column('longitude',sa.Float,nullable=False),
        sa.Column('state',sa.String(16),nullable=False),sa.Column('review_reason',sa.Text),
        sa.Column('priority',sa.Integer,nullable=False),sa.Column('source_metadata',JSONB,nullable=False),
        sa.UniqueConstraint('version','code',name='uq_poi_settlement_source'),
        sa.CheckConstraint("state IN ('ready','review')",name='ck_poi_settlement_state'))
    op.create_index('idx_poi_settlement_province','poi_settlements',['version','province_name','state','priority'])
    op.add_column('poi_boundaries',sa.Column('source_metadata',JSONB))
    op.add_column('poi_jobs',sa.Column('search_dataset_version',sa.String(64),sa.ForeignKey('poi_source_datasets.version')))
    op.add_column('poi_jobs',sa.Column('planned_settlement_provinces',sa.Integer,nullable=False,server_default='0'))
    op.add_column('poi_segments',sa.Column('settlement_id',UUID(as_uuid=True),sa.ForeignKey('poi_settlements.id')))
    op.add_column('poi_segments',sa.Column('planning_note',sa.Text))
    op.execute("UPDATE poi_control SET paused=true, reason='Search sources available; review the search scope before resuming'")


def downgrade():
    op.drop_column('poi_segments','planning_note')
    op.drop_column('poi_segments','settlement_id')
    op.drop_column('poi_jobs','planned_settlement_provinces')
    op.drop_column('poi_jobs','search_dataset_version')
    op.drop_column('poi_boundaries','source_metadata')
    op.drop_table('poi_settlements')
    op.drop_table('poi_source_datasets')

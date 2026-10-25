"""Certified polygon coverage, shared circles, and resumable refinement."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB,UUID
revision='0019_poi_polygon_coverage'
down_revision='0018_poi_search_sources'
branch_labels=None
depends_on=None

def upgrade():
    op.create_table('poi_coverage_plans',sa.Column('id',UUID(as_uuid=True),primary_key=True),
        sa.Column('job_id',UUID(as_uuid=True),sa.ForeignKey('poi_jobs.id'),nullable=False,unique=True),
        sa.Column('source_version',sa.String(64),sa.ForeignKey('poi_source_datasets.version'),nullable=False),
        sa.Column('state',sa.String(20),nullable=False),sa.Column('metric_crs',sa.Text,nullable=False),
        sa.Column('geometry',JSONB,nullable=False),sa.Column('radius_m',sa.Integer,nullable=False),
        sa.Column('point_radius_m',sa.Integer,nullable=False),sa.Column('minimum_radius_m',sa.Integer,nullable=False),
        sa.Column('result_limit',sa.Integer,nullable=False),sa.Column('metric_area_m2',sa.Float,nullable=False),
        sa.Column('summary',JSONB,nullable=False),sa.Column('created_at',sa.DateTime(timezone=True),nullable=False,server_default=sa.func.now()))
    op.create_table('poi_coverage_tiles',sa.Column('id',sa.BigInteger,primary_key=True),
        sa.Column('plan_id',UUID(as_uuid=True),sa.ForeignKey('poi_coverage_plans.id'),nullable=False),
        sa.Column('code',sa.Text,nullable=False),sa.Column('geometry',JSONB,nullable=False),
        sa.Column('state',sa.String(16),nullable=False),sa.Column('certificate',JSONB),
        sa.UniqueConstraint('plan_id','code',name='uq_poi_coverage_tile'))
    op.create_index('ix_poi_coverage_tiles_plan_id','poi_coverage_tiles',['plan_id'])
    op.create_table('poi_coverage_circles',sa.Column('id',sa.BigInteger,primary_key=True),
        sa.Column('plan_id',UUID(as_uuid=True),sa.ForeignKey('poi_coverage_plans.id'),nullable=False),
        sa.Column('code',sa.Text,nullable=False),sa.Column('kind',sa.String(16),nullable=False),
        *[sa.Column(n,sa.Float,nullable=False) for n in ('x','y','latitude','longitude')],
        sa.Column('radius_m',sa.Integer,nullable=False),sa.Column('province_order',sa.Integer,nullable=False),
        sa.Column('province_name',sa.Text,nullable=False),sa.Column('associations',JSONB,nullable=False),
        sa.Column('target_geometry',JSONB),sa.UniqueConstraint('plan_id','code',name='uq_poi_coverage_circle'))
    op.create_index('ix_poi_coverage_circles_plan_id','poi_coverage_circles',['plan_id'])
    op.create_table('poi_coverage_contributions',sa.Column('tile_id',sa.BigInteger,sa.ForeignKey('poi_coverage_tiles.id'),primary_key=True),
        sa.Column('circle_id',sa.BigInteger,sa.ForeignKey('poi_coverage_circles.id'),primary_key=True),
        sa.Column('province_name',sa.Text,primary_key=True),sa.Column('area_m2',sa.Float,nullable=False))
    op.add_column('poi_segments',sa.Column('coverage_circle_id',sa.BigInteger,sa.ForeignKey('poi_coverage_circles.id')))
    op.add_column('poi_segments',sa.Column('parent_segment_id',sa.BigInteger,sa.ForeignKey('poi_segments.id')))
    op.create_index('idx_poi_segment_parent','poi_segments',['parent_segment_id'])
    op.create_unique_constraint('uq_poi_coverage_dispatch','poi_segments',['job_id','coverage_circle_id','category'])
    op.execute("UPDATE poi_control SET paused=true,reason='Polygon coverage upgrade; review the new plan before resuming'")

def downgrade():
    op.drop_index('idx_poi_segment_parent',table_name='poi_segments')
    op.drop_constraint('uq_poi_coverage_dispatch','poi_segments',type_='unique')
    op.drop_column('poi_segments','parent_segment_id')
    op.drop_column('poi_segments','coverage_circle_id')
    op.drop_table('poi_coverage_contributions')
    op.drop_table('poi_coverage_circles')
    op.drop_table('poi_coverage_tiles')
    op.drop_table('poi_coverage_plans')

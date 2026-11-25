"""Spatial candidate and scoped province indexes for interactive place lookup."""
from alembic import op
import sqlalchemy as sa

revision='0032_poi_matching_indexes'
down_revision='0031_poi_retired_sources'
branch_labels=depends_on=None

PROVINCE=sa.text(r"lower(trim(regexp_replace(replace(translate(province_name, 'يك', 'یک'), U&'\200C', ' '), '\s+', ' ', 'g')))")
LAT=sa.text("CAST(((published -> 'overrides') ->> 'latitude') AS FLOAT)")
LON=sa.text("CAST(((published -> 'overrides') ->> 'longitude') AS FLOAT)")


def upgrade():
    op.create_index('idx_poi_segment_province_gate','poi_segments',['job_id',PROVINCE,'parent_segment_id','status'],schema='poi',
        postgresql_where=sa.text("kind='coverage'"),postgresql_include=['pending_details','review_reason','coverage_circle_id'])
    op.create_index('idx_poi_segment_root_gate','poi_segments',['job_id','coverage_circle_id','status'],schema='poi',
        postgresql_where=sa.text("kind='coverage' AND parent_segment_id IS NULL"),postgresql_include=['pending_details','review_reason'])
    op.create_index('idx_poi_circle_province_gate','poi_coverage_circles',['plan_id',PROVINCE,'id'],schema='poi')
    op.create_index('idx_poi_contribution_province_gate','poi_coverage_contributions',[PROVINCE,'circle_id'],schema='poi',
        postgresql_where=sa.text("province_name<>'__union__'"))
    op.create_index('idx_poi_retired_extent','poi_retired_places',['longitude','latitude'],schema='poi')
    op.create_index('idx_poi_editorial_override_extent','poi_editorial',[LON,LAT],schema='poi',postgresql_where=sa.text('published_version>0'))
    op.create_index('idx_poi_editorial_override_lat','poi_editorial',[LAT],schema='poi',postgresql_where=sa.text('published_version>0'))


def downgrade():
    for name,table in [('idx_poi_editorial_override_lat','poi_editorial'),('idx_poi_editorial_override_extent','poi_editorial'),
        ('idx_poi_retired_extent','poi_retired_places'),('idx_poi_contribution_province_gate','poi_coverage_contributions'),
        ('idx_poi_circle_province_gate','poi_coverage_circles'),('idx_poi_segment_root_gate','poi_segments'),('idx_poi_segment_province_gate','poi_segments')]:
        op.drop_index(name,table_name=table,schema='poi')

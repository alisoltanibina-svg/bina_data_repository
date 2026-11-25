"""Archive physically removed duplicate sources without losing original UUIDs."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID,JSONB

revision='0031_poi_retired_sources'
down_revision='0030_poi_canonical'
branch_labels=depends_on=None


def upgrade():
    op.create_table('poi_retired_places',
        sa.Column('source_id',UUID(as_uuid=True),primary_key=True),
        sa.Column('canonical_id',UUID(as_uuid=True),sa.ForeignKey('poi.poi_places.id'),nullable=False),
        sa.Column('provider',sa.String(30),nullable=False),
        sa.Column('category',sa.String(100),nullable=False),
        sa.Column('name',sa.Text(),nullable=False),
        sa.Column('province_name',sa.Text()),
        sa.Column('latitude',sa.Float(),nullable=False),
        sa.Column('longitude',sa.Float(),nullable=False),
        sa.Column('snapshot',JSONB(),nullable=False),
        sa.Column('retired_by',sa.String(100),nullable=False),
        sa.Column('retired_at',sa.DateTime(timezone=True),nullable=False,server_default=sa.func.now()),
        sa.CheckConstraint('source_id <> canonical_id',name='ck_poi_retired_not_self'),
        sa.CheckConstraint('latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180',name='ck_poi_retired_coordinates'),schema='poi')
    op.create_index('idx_poi_retired_canonical','poi_retired_places',['canonical_id'],schema='poi')


def downgrade():
    # Old source UUIDs and preserved histories would lose their route if a
    # populated archive were dropped. Restore compacted rows before downgrade.
    op.execute("""DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM poi.poi_retired_places) THEN
            RAISE EXCEPTION 'Restore retired POI sources before downgrading 0031';
        END IF;
    END; $$""")
    op.drop_table('poi_retired_places',schema='poi')

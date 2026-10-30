"""Bound collection to an explicitly selected single-area pilot by default."""
from alembic import op
import sqlalchemy as sa
revision='0017_poi_pilot'
down_revision='0016_poi_nonretention'
branch_labels=None
depends_on=None

def upgrade():
    op.add_column('poi_segments',sa.Column('kind',sa.String(16),nullable=False,server_default='grid'))
    op.add_column('poi_control',sa.Column('collection_mode',sa.String(16),nullable=False,server_default='pilot'))
    op.add_column('poi_control',sa.Column('pilot_segment_id',sa.BigInteger()))
    op.create_foreign_key('fk_poi_control_pilot_segment','poi_control','poi_segments',['pilot_segment_id'],['id'])
    op.create_check_constraint('ck_poi_collection_mode','poi_control',"collection_mode IN ('pilot','coverage')")
    op.execute("UPDATE poi_control SET paused=true, collection_mode='pilot', reason='Choose a single-area pilot before continuing; nationwide grid is paused'")

def downgrade():
    op.drop_constraint('ck_poi_collection_mode','poi_control',type_='check')
    op.drop_constraint('fk_poi_control_pilot_segment','poi_control',type_='foreignkey')
    op.drop_column('poi_control','pilot_segment_id')
    op.drop_column('poi_control','collection_mode')
    op.drop_column('poi_segments','kind')

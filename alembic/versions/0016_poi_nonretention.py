"""Enforce Nearby non-retention and identify volatile Details handoffs.

Legacy payloads are deliberately not deleted by this migration. The NOT VALID
constraint still prevents all new Nearby payload writes. Run the explicit cleanup
command with the worker stopped, after reviewing its dry-run output.
"""
from alembic import op
import sqlalchemy as sa
revision = '0016_poi_nonretention'
down_revision = '0015_poi_collection'
branch_labels = None
depends_on = None

def upgrade():
    op.add_column('poi_segments',sa.Column('pending_details',sa.Integer(),nullable=False,server_default='0'))
    op.add_column('poi_requests',sa.Column('target_type',sa.String(16),nullable=False,server_default='segment'))
    for name in ('result_count','hash_count','queued_count'):
        op.add_column('poi_requests',sa.Column(name,sa.Integer()))
    op.execute("UPDATE poi_requests SET target_type='detail_task' WHERE kind='details'")
    op.execute("ALTER TABLE poi_requests ADD CONSTRAINT ck_poi_no_nearby_payload CHECK (kind != 'nearby' OR raw_response IS NULL) NOT VALID")
    op.execute("UPDATE poi_control SET paused=true, reason='Updated retention policy; review NDA authorization and legacy cleanup before resuming'")

def downgrade():
    op.drop_constraint('ck_poi_no_nearby_payload','poi_requests',type_='check')
    for name in ('queued_count','hash_count','result_count','target_type'):
        op.drop_column('poi_requests',name)
    op.drop_column('poi_segments','pending_details')

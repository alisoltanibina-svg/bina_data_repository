"""Place photo paths and transactional contribution SMS notifications."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision='0029_place_photos_sms'
down_revision='0028_place_registration'
branch_labels=depends_on=None

def upgrade():
    op.create_table('poi_place_photos',sa.Column('id',UUID(as_uuid=True),primary_key=True),
        sa.Column('path',sa.String(255),nullable=False,unique=True),
        sa.Column('uploader_id',sa.Integer(),sa.ForeignKey('accounts.users.id',ondelete='SET NULL')),
        sa.Column('place_id',UUID(as_uuid=True)),sa.Column('revision_id',UUID(as_uuid=True),sa.ForeignKey('poi.poi_edit_revisions.id')),
        sa.Column('created_at',sa.DateTime(timezone=True),nullable=False,server_default=sa.func.now()),schema='poi')
    op.create_index('ix_poi_place_photos_created_at','poi_place_photos',['created_at'],schema='poi')
    op.create_table('poi_sms_notifications',sa.Column('id',UUID(as_uuid=True),primary_key=True),
        sa.Column('revision_id',UUID(as_uuid=True),sa.ForeignKey('poi.poi_edit_revisions.id'),nullable=False),
        sa.Column('user_id',sa.Integer(),sa.ForeignKey('accounts.users.id',ondelete='SET NULL')),
        sa.Column('event',sa.String(12),nullable=False),sa.Column('attempts',sa.Integer(),nullable=False,server_default='0'),
        sa.Column('available_at',sa.DateTime(timezone=True),nullable=False,server_default=sa.func.now()),
        sa.Column('sent_at',sa.DateTime(timezone=True)),sa.Column('created_at',sa.DateTime(timezone=True),nullable=False,server_default=sa.func.now()),
        sa.UniqueConstraint('revision_id','event',name='uq_poi_sms_event'),schema='poi')
    op.create_index('ix_poi_sms_notifications_available_at','poi_sms_notifications',['available_at'],schema='poi')

def downgrade():
    op.drop_table('poi_sms_notifications',schema='poi')
    op.drop_table('poi_place_photos',schema='poi')

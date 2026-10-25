"""Durable progress for admin-triggered offline geographic preparation."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB,UUID

revision='0020_poi_admin_preparation'
down_revision='0019_poi_polygon_coverage'
branch_labels=None
depends_on=None


def upgrade():
    op.create_table('poi_preparations',
        sa.Column('id',UUID(as_uuid=True),primary_key=True),
        sa.Column('plan_id',UUID(as_uuid=True),sa.ForeignKey('poi_coverage_plans.id')),
        sa.Column('state',sa.String(20),nullable=False),
        sa.Column('phase',sa.String(20),nullable=False),
        sa.Column('message',sa.Text,nullable=False),
        sa.Column('categories',JSONB,nullable=False),
        sa.Column('radius_m',sa.Integer,nullable=False),
        sa.Column('verified_tiles',sa.Integer,nullable=False),
        sa.Column('total_tiles',sa.Integer,nullable=False),
        sa.Column('created_at',sa.DateTime(timezone=True),nullable=False,server_default=sa.func.now()),
        sa.Column('updated_at',sa.DateTime(timezone=True),nullable=False,server_default=sa.func.now()))


def downgrade():
    op.drop_table('poi_preparations')

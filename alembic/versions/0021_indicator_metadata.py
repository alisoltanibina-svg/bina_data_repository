"""Expose indicator measurement units and explanatory questions."""

from alembic import op

revision = "0021_indicator_metadata"
down_revision = "0020_poi_admin_preparation"
branch_labels = None
depends_on = None


def upgrade():
    # These columns may already have been populated by an external data import.
    # Adopting them must preserve their existing values and types.
    op.execute("ALTER TABLE kdescription ADD COLUMN IF NOT EXISTS measurement_unit TEXT")
    op.execute("ALTER TABLE kdescription ADD COLUMN IF NOT EXISTS question TEXT")


def downgrade():
    op.drop_column("kdescription", "question")
    op.drop_column("kdescription", "measurement_unit")

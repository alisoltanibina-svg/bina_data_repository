"""Adopt imported trend metadata without changing existing values or precision."""
from alembic import op

revision = "0022_trend_metadata"
down_revision = "0021_indicator_metadata"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("ALTER TABLE public.trend_score ADD COLUMN IF NOT EXISTS coverage_count REAL")
    op.execute("ALTER TABLE public.trend_score ADD COLUMN IF NOT EXISTS max_observation_age REAL")
    op.execute("""
        DO $$ BEGIN
            IF (SELECT count(*) FROM pg_attribute
                WHERE attrelid='public.trend_score'::regclass
                  AND attname IN ('coverage_count','max_observation_age')
                  AND atttypid='real'::regtype AND NOT attnotnull
                  AND NOT attisdropped) <> 2 THEN
                RAISE EXCEPTION 'Imported trend metadata differs from the reviewed nullable REAL columns';
            END IF;
        END $$
    """)


def downgrade():
    # These columns existed outside Alembic on production. A downgrade cannot
    # know which values came from imports; deliberately retain both columns.
    pass

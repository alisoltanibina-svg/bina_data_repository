"""Published Location Information category subset; no live provider data is retained."""
from alembic import op
import sqlalchemy as sa

revision = '0025_poi_explorecat'
down_revision = '0024_explorer_dimensions'
branch_labels = None
depends_on = None


def upgrade():
    conn = op.get_bind()
    conn.execute(sa.text("SET LOCAL lock_timeout = '5s'"))
    op.create_table('poi_explorecat',
        sa.Column('category', sa.String(100), sa.ForeignKey('poi.poi_categories.slug'), primary_key=True),
        sa.Column('title', sa.Text(), nullable=False),
        sa.Column('icon_url', sa.Text(), nullable=False),
        sa.Column('is_published', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('sort_order', sa.Integer(), nullable=False, server_default='0'), schema='poi')
    conn.execute(sa.text('''INSERT INTO poi.poi_explorecat (category, title, icon_url)
        SELECT slug, title, 'https://static.neshanmap.ir/poi/64/' || slug || '.png'
        FROM poi.poi_categories WHERE slug ~ '^[a-z_]+$' '''))
    # This index lets category counts avoid scanning every category association.
    op.create_index('idx_poi_place_category_category', 'poi_place_categories', ['category', 'place_id'], schema='poi')
    columns = {column['name'] for column in sa.inspect(conn).get_columns('modules', schema='analytics')}
    name = 'Module_name' if 'Module_name' in columns else 'module_name'
    conn.execute(sa.text(f'''INSERT INTO analytics.modules ("{name}", ref_table, description, topic, subtopic, indicator, "filter")
        SELECT 'اطلاعات مکانی', 'poi', 'کاوش مکان‌ها؛ آمار استانی و نمایش زندهٔ مکان‌های نزدیک', '', '', '', ''
        WHERE NOT EXISTS (SELECT 1 FROM analytics.modules
            WHERE lower(trim(ref_table)) IN ('poi', 'poi_explorecat', 'poi.poi_explorecat', 'poi_places', 'poi.poi_places')
            OR replace(replace(lower("{name}"), ' ', ''), '‌', '') IN ('اطلاعاتمکانی', 'اطلاعاتمکان', 'locationinformation'))'''))


def downgrade():
    op.drop_index('idx_poi_place_category_category', table_name='poi_place_categories', schema='poi')
    op.drop_table('poi_explorecat', schema='poi')
    # The module row may predate this migration; never delete operator configuration.

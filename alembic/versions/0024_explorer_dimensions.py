"""Dimension-aware Explorer catalog. Preserves previously imported columns and data."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = '0024_explorer_dimensions'
down_revision = '0023_domain_schemas'
branch_labels = None
depends_on = None


def upgrade():
    conn = op.get_bind()
    conn.execute(sa.text("SET LOCAL lock_timeout='5s'"))
    inspector = sa.inspect(conn)
    for table, columns in {
        'kdescription': [('dimensions', sa.Text()), ('index_include', sa.Text())],
        'kindicator_score': [('dim_cat_values', JSONB()), ('province_name', sa.Text())],
    }.items():
        existing = {c['name'] for c in inspector.get_columns(table, schema='analytics')}
        for name, typ in columns:
            if name not in existing:
                op.add_column(table, sa.Column(name, typ), schema='analytics')
    tables = set(inspector.get_table_names(schema='analytics'))
    # Imported public tables keep their OID and all rows when moved.
    public_tables = set(inspector.get_table_names(schema='public'))
    for table in ('dimensions', 'modules'):
        if table in tables and table in public_tables:
            raise RuntimeError(f'Both public.{table} and analytics.{table} exist; reconcile the imported tables first')
        if table not in tables and table in public_tables:
            conn.execute(sa.text(f'ALTER TABLE public."{table}" SET SCHEMA analytics'))
            tables.add(table)
    if 'dimensions' not in tables:
        op.create_table('dimensions',
            sa.Column('dimension_name', sa.Text(), primary_key=True),
            sa.Column('dimension_value', sa.Text(), primary_key=True),
            sa.Column('dimension_key', sa.Text(), nullable=False), schema='analytics')
    if 'modules' not in tables:
        op.create_table('modules',
            sa.Column('module_name', sa.Text(), primary_key=True),
            *[sa.Column(c, sa.Text(), nullable=(c == 'description')) for c in ('ref_table', 'description', 'topic', 'subtopic', 'indicator', 'filter')],
            schema='analytics')
    module_columns = {c['name'] for c in sa.inspect(conn).get_columns('modules', schema='analytics')}
    for column in ('topic', 'subtopic', 'indicator', 'filter'):
        if column not in module_columns:
            op.add_column('modules', sa.Column(column, sa.Text()), schema='analytics')
    # Seed only an empty catalog; never replace operator-provided module records.
    name_column = 'Module_name' if 'Module_name' in module_columns else 'module_name'
    conn.execute(sa.text(f'''INSERT INTO analytics.modules ("{name_column}", ref_table, description, topic, subtopic, indicator, "filter")
        SELECT 'نماگرهای دیده بان', 'kdescription', 'بررسی و مقایسه نماگرهای دیده‌بان فرهنگ',
            'topic_name', 'subtopic_name', 'indicator_name', 'dimensions'
        WHERE NOT EXISTS (SELECT 1 FROM analytics.modules)'''))
    # Province/year uniqueness would reject valid new breakdowns.
    for constraint in sa.inspect(conn).get_unique_constraints('kindicator_score', schema='analytics'):
        if set(constraint['column_names']) == {'indicator_name', 'year', 'province_name'}:
            op.drop_constraint(constraint['name'], 'kindicator_score', schema='analytics', type_='unique')
    conn.execute(sa.text('''CREATE UNIQUE INDEX IF NOT EXISTS uq_kindicator_dimensions
        ON analytics.kindicator_score (indicator_name, year, (COALESCE(dim_cat_values::text, province_name)))'''))


def downgrade():
    raise RuntimeError('Dimension data cannot safely downgrade to province-only uniqueness. Restore a reviewed backup instead.')

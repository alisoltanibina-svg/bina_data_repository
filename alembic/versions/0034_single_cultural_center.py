"""Use one cultural and artistic center field for mosque registration."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql as pg

revision = '0034_single_cultural_center'
down_revision = '0033_place_registration_drafts'
branch_labels = depends_on = None


def upgrade():
    fields = sa.table('poi_field_definitions', sa.column('key', sa.String()),
                      sa.column('label', sa.Text()), schema='poi')
    op.execute(fields.update().where(fields.c.key == op.inline_literal('has_cultural_artistic_center'))
               .values(label=op.inline_literal('کانون فرهنگی و هنری')))
    # This redundant definition has no submitted answers. The application stores
    # extensible fields as definition rows, not individual place-table columns.
    op.execute(fields.delete().where(fields.c.key == op.inline_literal('has_arts_group')))


def downgrade():
    fields = sa.table('poi_field_definitions', sa.column('key', sa.String()), sa.column('label', sa.Text()),
                      sa.column('kind', sa.String()), sa.column('categories', pg.JSONB()), sa.column('choices', pg.JSONB()),
                      sa.column('required', sa.Boolean()), sa.column('public', sa.Boolean()),
                      sa.column('active', sa.Boolean()), sa.column('constraints', pg.JSONB()), schema='poi')
    op.execute(fields.update().where(fields.c.key == op.inline_literal('has_cultural_artistic_center'))
               .values(label=op.inline_literal('کانون فرهنگی')))
    from sqlalchemy.dialects.postgresql import insert
    statement = insert(fields).values(key=op.inline_literal('has_arts_group'), label=op.inline_literal('گروه هنری'),
        kind=op.inline_literal('boolean'), categories=sa.cast(op.inline_literal('["mosque"]'), pg.JSONB()),
        choices=sa.cast(op.inline_literal('[]'), pg.JSONB()), required=op.inline_literal(False),
        public=op.inline_literal(True), active=op.inline_literal(True),
        constraints=sa.cast(op.inline_literal('{"order":7}'), pg.JSONB()))
    op.execute(statement.on_conflict_do_nothing(index_elements=['key']))

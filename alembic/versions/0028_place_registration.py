"""Focused mosque registration fields; preserve previous values and history."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql as pg
import json

revision='0028_place_registration'
down_revision='0027_mosque_editor_schema'
branch_labels=depends_on=None

ROWS=[
    ('settlement_type','نوع محل','choice',['شهر','روستا'],{}),
    ('operational_status','وضعیت فعالیت','choice',['فعال','نیمه‌فعال','غیرفعال','در حال ساخت'],{}),
    ('daily_congregational_prayers','تعداد نماز جماعت روزانه','number',[],{'integer':True,'minimum':0,'maximum':2147483647}),
    ('has_board_of_trustees','هیئت امنا','boolean',[],{}),
    ('has_imam','امام جماعت','boolean',[],{}),
    ('has_basij_base','پایگاه بسیج','boolean',[],{}),
    ('has_cultural_artistic_center','کانون فرهنگی','boolean',[],{}),
    ('has_arts_group','گروه هنری','boolean',[],{}),
    ('has_charity_fund','صندوق خیریه','boolean',[],{}),
    ('has_sports_complex','مجموعه ورزشی','boolean',[],{}),
    ('has_assembly_hall','سالن اجتماعات','boolean',[],{}),
    ('heritage_registered','ثبت میراث فرهنگی','boolean',[],{}),
    ('is_waqf','وقفی بودن','boolean',[],{}),
]

def upgrade():
    fields=sa.table('poi_field_definitions',sa.column('key',sa.String()),sa.column('label',sa.Text()),sa.column('kind',sa.String()),
        sa.column('categories',pg.JSONB()),sa.column('choices',pg.JSONB()),sa.column('required',sa.Boolean()),
        sa.column('public',sa.Boolean()),sa.column('active',sa.Boolean()),sa.column('constraints',pg.JSONB()),schema='poi')
    allowed=[key for key,*_ in ROWS]+['province']
    op.execute(fields.update().where(fields.c.categories.contains(sa.cast(op.inline_literal('["mosque"]'),pg.JSONB())),
        fields.c.key.not_in([op.inline_literal(key) for key in allowed])).values(active=op.inline_literal(False),required=op.inline_literal(False)))
    from sqlalchemy.dialects.postgresql import insert
    for order,(key,label,kind,choices,constraints) in enumerate(ROWS):
        as_json=lambda value:sa.cast(op.inline_literal(json.dumps(value,ensure_ascii=False)),pg.JSONB())
        statement=insert(fields).values(key=op.inline_literal(key),label=op.inline_literal(label),kind=op.inline_literal(kind),
            categories=as_json(['mosque']),choices=as_json(choices),required=op.inline_literal(False),public=op.inline_literal(True),
            active=op.inline_literal(True),constraints=as_json({**constraints,'order':order}))
        op.execute(statement.on_conflict_do_update(index_elements=['key'],set_={k:getattr(statement.excluded,k) for k in ('label','active','required','public','constraints')}))

def downgrade():
    # Definitions and saved values are retained to avoid losing contributions.
    pass

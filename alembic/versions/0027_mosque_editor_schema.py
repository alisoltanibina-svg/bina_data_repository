"""Enable mosque editing only and install typed, extensible mosque fields."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql as pg
import json

revision='0027_mosque_editor_schema'
down_revision='0026_poi_editorial'
branch_labels=depends_on=None


def upgrade():
    op.add_column('poi_field_definitions',sa.Column('constraints',pg.JSONB(),nullable=False,server_default=sa.text("'{}'::jsonb")),schema='poi')
    op.create_table('poi_category_policies',sa.Column('category',sa.String(100),primary_key=True),
        sa.Column('editing_enabled',sa.Boolean(),nullable=False,server_default=sa.false()),schema='poi')
    policy=sa.table('poi_category_policies',sa.column('category',sa.String()),sa.column('editing_enabled',sa.Boolean()),schema='poi')
    op.bulk_insert(policy,[dict(category='mosque',editing_enabled=True)])
    fields=sa.table('poi_field_definitions',sa.column('key',sa.String()),sa.column('label',sa.Text()),sa.column('kind',sa.String()),
        sa.column('categories',pg.JSONB()),sa.column('choices',pg.JSONB()),sa.column('required',sa.Boolean()),
        sa.column('public',sa.Boolean()),sa.column('active',sa.Boolean()),sa.column('constraints',pg.JSONB()),schema='poi')
    rows=[
        ('imam_name','نام امام جماعت','text',[],{'max_length':200}),
        ('province','استان','text',[],{'coordinate_province':True,'max_length':120}),
        ('county','شهرستان','text',[],{'county_suggestions':True,'max_length':120}),
        ('settlement_type','نوع محل','choice',['شهر','روستا'],{}),
        ('settlement_name','نام شهر یا روستا','text',[],{'max_length':150}),
        ('prayer_capacity','گنجایش نمازگزاران','number',[],{'integer':True,'minimum':0,'maximum':2147483647}),
        ('operational_status','وضعیت فعالیت','choice',['فعال','نیمه‌فعال','غیرفعال','در حال ساخت'],{}),
        ('ownership_type','نوع مالکیت','choice',['وقفی','دولتی','خصوصی','عمومی','سایر'],{}),
        ('staff_count','تعداد کارکنان و خادمان','number',[],{'integer':True,'minimum':0,'maximum':2147483647}),
        ('has_cultural_artistic_center','کانون فرهنگی هنری','boolean',[],{}),
        ('has_basij_base','پایگاه بسیج','boolean',[],{}),
        ('daily_congregational_prayers','تعداد نماز جماعت روزانه','number',[],{'integer':True,'minimum':0,'maximum':2147483647}),
        ('itikaf_status','وضعیت برگزاری اعتکاف','choice',['برگزار می‌شود','برگزار نمی‌شود','موردی'],{}),
        ('quranic_activities_status','وضعیت فعالیت‌های قرآنی','choice',['فعال','غیرفعال','موردی'],{}),
        ('heritage_registered','ثبت میراث فرهنگی','boolean',[],{}),
    ]
    # Upsert safely if an administrator already defined one of these stable keys.
    for position,(key,label,kind,choices,constraints) in enumerate(rows):
        constraints={**constraints,'order':position}
        from sqlalchemy.dialects.postgresql import insert
        as_json=lambda value:sa.cast(op.inline_literal(json.dumps(value,ensure_ascii=False)),pg.JSONB())
        op.execute(insert(fields).values(key=op.inline_literal(key),label=op.inline_literal(label),kind=op.inline_literal(kind),
            categories=as_json(['mosque']),choices=as_json(choices),required=op.inline_literal(key=='province'),
            public=op.inline_literal(True),active=op.inline_literal(True),constraints=as_json(constraints)).on_conflict_do_nothing(index_elements=['key']))


def downgrade():
    # Venue values are retained in revisions; category policy removal closes editing.
    op.drop_table('poi_category_policies',schema='poi')
    op.drop_column('poi_field_definitions','constraints',schema='poi')

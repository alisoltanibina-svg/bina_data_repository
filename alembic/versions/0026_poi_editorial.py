"""Local venue corrections, revision history, editor scopes and contribution scores."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql as pg

revision = '0026_poi_editorial'
down_revision = '0025_poi_explorecat'
branch_labels = depends_on = None


def user(name):
    return sa.Column(name, sa.Integer(), sa.ForeignKey('accounts.users.id', ondelete='SET NULL'))


def upgrade():
    op.execute("SET LOCAL lock_timeout = '5s'")
    # Matching belongs to editing. Do not alter collector tables, columns, indexes, or triggers.
    op.create_table('poi_source_identities',
        sa.Column('place_id',pg.UUID(as_uuid=True),primary_key=True),
        sa.Column('match_key',sa.String(64),nullable=False),
        sa.UniqueConstraint('match_key',name='uq_poi_source_identity'),schema='poi')
    op.create_index('idx_poi_editor_identity_prefix','poi_source_identities',[sa.text('substr(match_key, 1, 8)')],schema='poi')
    op.execute("""INSERT INTO poi.poi_source_identities (place_id,match_key)
        SELECT id,encode(sha256(convert_to(provider_id,'UTF8')),'hex') FROM poi.poi_places WHERE provider='neshan'""")
    op.create_table('poi_editorial',
        sa.Column('place_id', pg.UUID(as_uuid=True), primary_key=True),
        sa.Column('tag', sa.String(12), nullable=False),
        sa.Column('version', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('published_version', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('published', pg.JSONB()), sa.Column('name',sa.Text()), sa.Column('category',sa.String(100)),
        sa.Column('latitude',sa.Float()), sa.Column('longitude',sa.Float()), sa.Column('province_name',sa.Text()),
        user('created_by'),user('updated_by'),user('published_by'),
        sa.Column('updated_at',sa.DateTime(timezone=True),nullable=False,server_default=sa.func.now()),
        sa.CheckConstraint("tag IN ('added','edited')",name='ck_poi_editorial_tag'),schema='poi')
    op.create_index('idx_poi_editorial_extent','poi_editorial',['longitude','latitude'],schema='poi')
    op.create_table('poi_edit_revisions',
        sa.Column('id',pg.UUID(as_uuid=True),primary_key=True),
        sa.Column('place_id',pg.UUID(as_uuid=True),sa.ForeignKey('poi.poi_editorial.place_id'),nullable=False),
        sa.Column('submission_id',pg.UUID(as_uuid=True),nullable=False,unique=True),
        sa.Column('version',sa.Integer(),nullable=False),sa.Column('base_published_version',sa.Integer(),nullable=False),
        user('actor_id'),user('reviewer_id'),sa.Column('actor_name',sa.Text(),nullable=False,server_default=''),
        sa.Column('reviewer_name',sa.Text()),sa.Column('action',sa.String(12),nullable=False),
        sa.Column('status',sa.String(12),nullable=False,server_default='pending'),
        sa.Column('payload',pg.JSONB(),nullable=False),sa.Column('source_snapshot',pg.JSONB(),nullable=False),
        sa.Column('reason',sa.Text(),nullable=False),sa.Column('review_note',sa.Text()),
        sa.Column('created_at',sa.DateTime(timezone=True),nullable=False,server_default=sa.func.now()),
        sa.Column('reviewed_at',sa.DateTime(timezone=True)),
        sa.UniqueConstraint('place_id','version',name='uq_poi_edit_version'),
        sa.CheckConstraint("status IN ('pending','approved','rejected')",name='ck_poi_edit_status'),schema='poi')
    op.create_index('ix_poi_edit_revisions_place_id','poi_edit_revisions',['place_id'],schema='poi')
    op.create_index('idx_poi_edit_actor','poi_edit_revisions',['actor_id','created_at'],schema='poi')
    op.create_table('poi_source_revisions',
        sa.Column('id',pg.UUID(as_uuid=True),primary_key=True),
        sa.Column('place_id',pg.UUID(as_uuid=True),sa.ForeignKey('poi.poi_source_identities.place_id'),nullable=False),
        sa.Column('digest',sa.String(64),nullable=False),sa.Column('details',pg.JSONB(),nullable=False),
        sa.Column('observed_at',sa.DateTime(timezone=True)),
        sa.UniqueConstraint('place_id','digest',name='uq_poi_source_snapshot'),schema='poi')
    op.create_index('ix_poi_source_revisions_place_id','poi_source_revisions',['place_id'],schema='poi')
    op.create_table('poi_editor_grants',
        sa.Column('user_id',sa.Integer(),sa.ForeignKey('accounts.users.id',ondelete='CASCADE'),primary_key=True),
        sa.Column('provinces',pg.JSONB(),nullable=False),sa.Column('all_provinces',sa.Boolean(),nullable=False),
        sa.Column('can_review',sa.Boolean(),nullable=False),sa.Column('active',sa.Boolean(),nullable=False),user('granted_by'),schema='poi')
    op.create_table('poi_field_definitions',sa.Column('key',sa.String(60),primary_key=True),
        sa.Column('label',sa.Text(),nullable=False),sa.Column('kind',sa.String(12),nullable=False),
        sa.Column('categories',pg.JSONB(),nullable=False),sa.Column('choices',pg.JSONB(),nullable=False),
        sa.Column('required',sa.Boolean(),nullable=False),sa.Column('public',sa.Boolean(),nullable=False),
        sa.Column('active',sa.Boolean(),nullable=False),schema='poi')
    op.create_table('poi_contribution_awards',sa.Column('id',pg.UUID(as_uuid=True),primary_key=True),
        sa.Column('user_id',sa.Integer(),sa.ForeignKey('accounts.users.id',ondelete='CASCADE'),nullable=False),
        sa.Column('place_id',pg.UUID(as_uuid=True),sa.ForeignKey('poi.poi_editorial.place_id'),nullable=False),
        sa.Column('revision_id',pg.UUID(as_uuid=True),sa.ForeignKey('poi.poi_edit_revisions.id'),nullable=False),
        sa.Column('action',sa.String(12),nullable=False),sa.Column('points',sa.Integer(),nullable=False),
        sa.Column('revoked',sa.Boolean(),nullable=False,server_default=sa.false()),
        sa.Column('created_at',sa.DateTime(timezone=True),nullable=False,server_default=sa.func.now()),
        sa.UniqueConstraint('user_id','place_id','action',name='uq_poi_contribution_once'),schema='poi')
    op.create_index('ix_poi_contribution_awards_user_id','poi_contribution_awards',['user_id'],schema='poi')
    # Preserve existing manual venues and attribution without awarding retroactive points.
    op.execute("""INSERT INTO poi.poi_editorial
        (place_id,tag,version,published_version,published,name,category,latitude,longitude,province_name,created_by,updated_by)
        SELECT p.id,'added',1,1,jsonb_build_object('overrides',jsonb_build_object(
            'name',p.name,'category',c.category,'latitude',p.latitude,'longitude',p.longitude,
            'address',p.address,'phoneNumber',NULL,'website',NULL,'workHours',NULL,'socialNetworks',NULL),
            'attributes','{}'::jsonb),p.name,c.category,p.latitude,p.longitude,p.province_name,cu.id,uu.id
        FROM poi.poi_places p
        JOIN LATERAL (SELECT category FROM poi.poi_place_categories WHERE place_id=p.id ORDER BY category LIMIT 1) c ON true
        LEFT JOIN accounts.users cu ON cu.id::text=p.raw_details->>'created_by'
        LEFT JOIN accounts.users uu ON uu.id::text=p.raw_details->>'updated_by'
        WHERE p.provider='manual' AND p.resolved_at IS NOT NULL""")


def downgrade():
    for table in ('poi_contribution_awards','poi_field_definitions','poi_editor_grants','poi_source_revisions','poi_edit_revisions','poi_editorial'):
        op.drop_table(table,schema='poi')
    op.drop_table('poi_source_identities',schema='poi')

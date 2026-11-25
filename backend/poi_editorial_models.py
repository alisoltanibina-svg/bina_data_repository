"""Editing-owned storage. The collector does not import these models."""
from uuid import uuid4
from sqlalchemy import Column as C, Boolean, Integer as I, Text as T, String as S, Float as F, DateTime, ForeignKey as FK, UniqueConstraint as UQ, CheckConstraint as CK, Index, func,text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from backend.models import Base
from backend.poi_sql import published_coordinate

def uid(): return C(UUID(as_uuid=True), primary_key=True, default=uuid4)
def timestamp(): return C(DateTime(timezone=True))

class PoiSourceIdentity(Base):
    __tablename__ = 'poi_source_identities'
    __table_args__ = (UQ('match_key', name='uq_poi_source_identity'), {'schema':'poi'})
    place_id = C(UUID(as_uuid=True), primary_key=True)
    match_key = C(S(64), nullable=False)

Index('idx_poi_editor_identity_prefix',func.substr(PoiSourceIdentity.match_key,1,8))

class PoiEditorial(Base):
    __tablename__ = 'poi_editorial'
    __table_args__ = (CK("tag IN ('added','edited')", name='ck_poi_editorial_tag'),
        Index('idx_poi_editorial_extent', 'longitude', 'latitude'), {"schema": "poi"})
    place_id = C(UUID(as_uuid=True), primary_key=True)
    tag = C(S(12), nullable=False)
    version = C(I, nullable=False, default=0, server_default='0')
    published_version = C(I, nullable=False, default=0, server_default='0')
    published = C(JSONB)
    name = C(T)
    category = C(S(100))
    latitude = C(F)
    longitude = C(F)
    province_name = C(T)
    created_by = C(I, FK('accounts.users.id', ondelete='SET NULL'))
    updated_by = C(I, FK('accounts.users.id', ondelete='SET NULL'))
    published_by = C(I, FK('accounts.users.id', ondelete='SET NULL'))
    updated_at = C(DateTime(timezone=True), nullable=False, server_default=func.now())

class PoiEditRevision(Base):
    __tablename__ = 'poi_edit_revisions'
    __table_args__ = (UQ('place_id','version',name='uq_poi_edit_version'),
        CK("status IN ('pending','approved','rejected')",name='ck_poi_edit_status'),
        Index('idx_poi_edit_actor','actor_id','created_at'), {"schema": "poi"})
    id = uid()
    place_id = C(UUID(as_uuid=True), FK('poi.poi_editorial.place_id'), nullable=False, index=True)
    submission_id = C(UUID(as_uuid=True), nullable=False, unique=True)
    version = C(I, nullable=False)
    base_published_version = C(I, nullable=False)
    actor_id = C(I, FK('accounts.users.id', ondelete='SET NULL'))
    reviewer_id = C(I, FK('accounts.users.id', ondelete='SET NULL'))
    actor_name = C(T, nullable=False, default='', server_default='')
    reviewer_name = C(T)
    action = C(S(12), nullable=False)
    status = C(S(12), nullable=False, default='pending', server_default='pending')
    payload = C(JSONB, nullable=False)
    source_snapshot = C(JSONB, nullable=False)
    reason = C(T, nullable=False)
    review_note = C(T)
    created_at = C(DateTime(timezone=True), nullable=False, server_default=func.now())
    reviewed_at = timestamp()

class PoiSourceRevision(Base):
    __tablename__ = 'poi_source_revisions'
    __table_args__ = (UQ('place_id','digest',name='uq_poi_source_snapshot'), {"schema": "poi"})
    id = uid()
    place_id = C(UUID(as_uuid=True), FK('poi.poi_source_identities.place_id'), nullable=False, index=True)
    digest = C(S(64), nullable=False)
    details = C(JSONB, nullable=False)
    observed_at = timestamp()

class PoiEditorGrant(Base):
    __tablename__ = 'poi_editor_grants'
    __table_args__ = {"schema": "poi"}
    user_id = C(I, FK('accounts.users.id', ondelete='CASCADE'), primary_key=True)
    provinces = C(JSONB, nullable=False, default=list)
    all_provinces = C(Boolean, nullable=False, default=False)
    can_review = C(Boolean, nullable=False, default=False)
    active = C(Boolean, nullable=False, default=True)
    granted_by = C(I, FK('accounts.users.id', ondelete='SET NULL'))

class PoiFieldDefinition(Base):
    __tablename__ = 'poi_field_definitions'
    __table_args__ = {"schema": "poi"}
    key = C(S(60), primary_key=True)
    label = C(T, nullable=False)
    kind = C(S(12), nullable=False)
    categories = C(JSONB, nullable=False)
    choices = C(JSONB, nullable=False, default=list)
    required = C(Boolean, nullable=False, default=False)
    public = C(Boolean, nullable=False, default=False)
    active = C(Boolean, nullable=False, default=True)
    constraints = C(JSONB, nullable=False, default=dict, server_default='{}')

class PoiCategoryPolicy(Base):
    __tablename__ = 'poi_category_policies'
    __table_args__ = {"schema": "poi"}
    category = C(S(100), primary_key=True)
    editing_enabled = C(Boolean, nullable=False, default=False, server_default='false')

class PoiContributionAward(Base):
    __tablename__ = 'poi_contribution_awards'
    __table_args__ = (UQ('user_id','place_id','action',name='uq_poi_contribution_once'), {"schema": "poi"})
    id = uid()
    user_id = C(I, FK('accounts.users.id', ondelete='CASCADE'), nullable=False, index=True)
    place_id = C(UUID(as_uuid=True), FK('poi.poi_editorial.place_id'), nullable=False)
    revision_id = C(UUID(as_uuid=True), FK('poi.poi_edit_revisions.id'), nullable=False)
    action = C(S(12), nullable=False)
    points = C(I, nullable=False)
    revoked = C(Boolean, nullable=False, default=False, server_default='false')
    created_at = C(DateTime(timezone=True), nullable=False, server_default=func.now())

class PoiPlacePhoto(Base):
    __tablename__='poi_place_photos'
    __table_args__={'schema':'poi'}
    id=uid()
    path=C(S(255),nullable=False,unique=True)
    uploader_id=C(I,FK('accounts.users.id',ondelete='SET NULL'))
    place_id=C(UUID(as_uuid=True))  # Logical reference; no collector dependency.
    revision_id=C(UUID(as_uuid=True),FK('poi.poi_edit_revisions.id'))
    created_at=C(DateTime(timezone=True),nullable=False,server_default=func.now(),index=True)

class PoiSmsNotification(Base):
    __tablename__='poi_sms_notifications'
    __table_args__=(UQ('revision_id','event',name='uq_poi_sms_event'),{'schema':'poi'})
    id=uid()
    revision_id=C(UUID(as_uuid=True),FK('poi.poi_edit_revisions.id'),nullable=False)
    user_id=C(I,FK('accounts.users.id',ondelete='SET NULL'))
    event=C(S(12),nullable=False)
    attempts=C(I,nullable=False,default=0,server_default='0')
    available_at=C(DateTime(timezone=True),nullable=False,server_default=func.now(),index=True)
    sent_at=timestamp()
    created_at=C(DateTime(timezone=True),nullable=False,server_default=func.now())


Index('idx_poi_editorial_override_extent',published_coordinate(PoiEditorial.published,'longitude'),
    published_coordinate(PoiEditorial.published,'latitude'),postgresql_where=text('published_version>0'),_table=PoiEditorial.__table__).ddl_if(dialect='postgresql')
Index('idx_poi_editorial_override_lat',published_coordinate(PoiEditorial.published,'latitude'),
    postgresql_where=text('published_version>0'),_table=PoiEditorial.__table__).ddl_if(dialect='postgresql')


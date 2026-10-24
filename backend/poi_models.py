"""Persistent collector models in the existing SQLAlchemy metadata."""
from uuid import uuid4
from sqlalchemy import Column as C, BigInteger as B, Boolean, Integer as I, Text as T, String as S, Float as F, DateTime, ForeignKey as FK, UniqueConstraint as UQ, CheckConstraint as CK, Index, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from backend.models import Base

def uid(): return C(UUID(as_uuid=True), primary_key=True, default=uuid4)
def timestamp(): return C(DateTime(timezone=True))
def job_fk(): return C(UUID(as_uuid=True), FK('poi_jobs.id'), nullable=False)
def counter(): return C(I, nullable=False, default=0, server_default='0')

class PoiControl(Base):
    __tablename__ = 'poi_control'
    __table_args__ = (CK('id = 1', name='ck_poi_single_control'),)
    id = C(I, primary_key=True)
    paused = C(Boolean, nullable=False, default=True, server_default='true')
    reason = C(T, nullable=False, default='', server_default='')
    next_request_at = timestamp()
    heartbeat_at = timestamp()
    worker_id = C(S(100))
    in_flight = C(B)

class PoiBoundary(Base):
    __tablename__ = 'poi_boundaries'
    __table_args__ = (UQ('version', 'level', 'code', name='uq_poi_boundary'),)
    id = C(I, primary_key=True)
    version = C(S(64), nullable=False, index=True)
    level = C(S(16), nullable=False)
    code = C(T, nullable=False)
    name = C(T, nullable=False)
    parent_name = C(T)
    geometry = C(JSONB, nullable=False)

class PoiCategory(Base):
    __tablename__ = 'poi_categories'
    slug = C(S(100), primary_key=True)
    title = C(T, nullable=False)

class PoiJob(Base):
    __tablename__ = 'poi_jobs'
    __table_args__ = (CK("mode IN ('initial', 'refresh')", name='ck_poi_job_mode'),
        CK("status IN ('pending','running','completed','needs_review')", name='ck_poi_job_status'),
        Index('uq_poi_active_job', 'provider', unique=True, postgresql_where=text("status IN ('pending','running')")))
    id = uid()
    provider = C(S(30), nullable=False, default='neshan', server_default='neshan')
    status = C(S(20), nullable=False, default='pending')
    mode = C(S(12), nullable=False, default='initial')
    refresh_before = timestamp()
    boundary_version = C(S(64), nullable=False)
    radius_m = C(I, nullable=False)
    categories = C(JSONB, nullable=False)
    planned_provinces = counter()
    duplicates_skipped = counter()
    missing_hashes = counter()
    created_at = C(DateTime(timezone=True), nullable=False, server_default=func.now())

class PoiSegment(Base):
    __tablename__ = 'poi_segments'
    __table_args__ = (Index('idx_poi_segment_queue', 'job_id','province_order','status','id'),)
    id = C(B, primary_key=True)
    job_id = job_fk()
    province_order = C(I, nullable=False)
    province_name = C(T, nullable=False)
    category = C(S(100), FK('poi_categories.slug'), nullable=False)
    latitude = C(F, nullable=False)
    longitude = C(F, nullable=False)
    radius_m = C(I, nullable=False)
    status = C(S(16), nullable=False, default='pending', server_default='pending')
    attempts = counter()
    review_reason = C(T)

class PoiPlace(Base):
    __tablename__ = 'poi_places'
    __table_args__ = (UQ('provider','provider_id', name='uq_poi_provider_identifier'),
        CK('latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180', name='ck_poi_coordinates'),
        Index('idx_poi_place_extent','longitude','latitude'), Index('idx_poi_place_admin','province_name','county_name'),
        Index('idx_poi_place_name','normalized_name'))
    id = uid()
    provider = C(S(30), nullable=False)
    provider_id = C(T, nullable=False)
    name = C(T, nullable=False)
    normalized_name = C(T, nullable=False)
    latitude = C(F, nullable=False)
    longitude = C(F, nullable=False)
    address = C(T)
    address_province = C(T)
    address_county = C(T)
    address_city = C(T)
    address_parse_status = C(S(20))
    province_name = C(T)
    county_name = C(T)
    spatial_status = C(S(30))
    boundary_version = C(S(64))
    raw_details = C(JSONB)
    resolved_at = timestamp()
    discovered_at = C(DateTime(timezone=True), nullable=False, server_default=func.now())

class PoiPlaceCategory(Base):
    __tablename__ = 'poi_place_categories'
    place_id = C(UUID(as_uuid=True), FK('poi_places.id'), primary_key=True)
    category = C(S(100), FK('poi_categories.slug'), primary_key=True)

class PoiDetailTask(Base):
    __tablename__ = 'poi_detail_tasks'
    __table_args__ = (UQ('job_id','place_id', name='uq_poi_detail_task'),
        Index('idx_poi_detail_queue','job_id','province_order','status','id'))
    id = C(B, primary_key=True)
    job_id = job_fk()
    place_id = C(UUID(as_uuid=True), FK('poi_places.id'), nullable=False)
    segment_id = C(B, FK('poi_segments.id'), nullable=False)
    province_order = C(I, nullable=False)
    status = C(S(16), nullable=False, default='pending', server_default='pending')
    attempts = counter()

class PoiRequest(Base):
    __tablename__ = 'poi_requests'
    __table_args__ = (Index('idx_poi_request_job_outcome','job_id','kind','outcome'),)
    id = C(B, primary_key=True)
    job_id = job_fk()
    kind = C(S(12), nullable=False)
    target_id = C(B, nullable=False)
    outcome = C(S(16), nullable=False, default='dispatched')
    http_status = C(I)
    error = C(T)
    raw_response = C(JSONB)
    started_at = C(DateTime(timezone=True), nullable=False, server_default=func.now())
    finished_at = timestamp()

class PoiDuplicateReview(Base):
    __tablename__ = 'poi_duplicate_reviews'
    place_id = C(UUID(as_uuid=True), FK('poi_places.id'), primary_key=True)
    other_place_id = C(UUID(as_uuid=True), FK('poi_places.id'), primary_key=True)
    reason = C(T, nullable=False)
    status = C(S(16), nullable=False, default='pending', server_default='pending')

"""Editorial data is separate from worker-owned source data and live discovery."""
from collections import defaultdict
from datetime import date
import hashlib
import json
import math
import re

from fastapi import HTTPException
from pydantic import Field, FiniteFloat, field_validator
from sqlalchemy import select, func
from sqlalchemy.dialects.postgresql import insert
from uuid import uuid4

from backend.input_security import InputBody, safe_text
from backend.poi_geo import normalize
from backend.poi_models import (PoiPlace, PoiPlaceCategory, PoiJob, PoiCoveragePlan, PoiCoverageCircle,
    PoiSegment, PoiBoundary)
from backend.poi_editorial_models import PoiEditorGrant, PoiFieldDefinition, PoiEditorial, PoiSourceIdentity, PoiSourceRevision
from backend.poi_editorial_models import PoiEditRevision
from backend.models import User
from backend import poi_identity

COMMON = ('name','category','latitude','longitude','address','phoneNumber','website','workHours','socialNetworks')


def fingerprint(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()


def source_identity(row):
    return hashlib.sha256(row.provider_id.encode('utf-8')).hexdigest() if row.provider=='neshan' else None


def source_identity_expression():
    """Cold lookup only. Private identities make subsequent lookups indexed."""
    return func.encode(func.sha256(func.convert_to(PoiPlace.provider_id,'UTF8')),'hex')


def observe_source(session,row):
    """Capture only source versions actually read by editing; never write collector rows."""
    identity=source_identity(row)
    if not identity:return
    session.execute(insert(PoiSourceIdentity).values(place_id=row.id,match_key=identity)
        .on_conflict_do_update(index_elements=['place_id'],set_={'match_key':identity}))
    if row.resolved_at and isinstance(row.raw_details,dict):
        session.execute(insert(PoiSourceRevision).values(id=uuid4(),place_id=row.id,digest=fingerprint(row.raw_details),
            details=row.raw_details,observed_at=row.resolved_at).on_conflict_do_nothing(constraint='uq_poi_source_snapshot'))


def coordinate_expression(key):
    return func.coalesce(PoiEditorial.published['overrides'][key].as_float(),getattr(PoiPlace,key))


def category_expression():
    return func.coalesce(PoiEditorial.published['overrides']['category'].as_string(),
        PoiPlace.raw_details['layer']['slug'].as_string(),PoiPlaceCategory.category)


def edited_coordinates(editorial):
    overrides=(editorial.published or {}).get('overrides',{}) if editorial else {}
    return 'latitude' in overrides or 'longitude' in overrides


def effective_province(row,editorial):
    return editorial.province_name if edited_coordinates(editorial) else row.province_name


def permissions(session, actor):
    admin = bool(actor.get('is_admin'))
    grant = None if admin else session.get(PoiEditorGrant, actor['id'])
    active = bool(grant and grant.active)
    return dict(can_edit=admin or active, can_review=admin or bool(active and grant.can_review),
        can_manage=admin, all_provinces=admin or bool(active and grant.all_provinces),
        provinces=grant.provinces if active else [])


def in_scope(permission, province):
    return bool(permission['can_edit'] and (permission['all_provinces'] or
        normalize(province) in {normalize(p) for p in permission['provinces']}))


def completion_row(province, total, done, ready=True):
    return dict(province=province, expected_searches=total, completed_searches=done,
        eligible=bool(ready and total > 0 and done == total))


def eligibility(session):
    """Same root-search counters as the worker table, without area projection work."""
    job = session.scalar(select(PoiJob).order_by(PoiJob.created_at.desc(),PoiJob.id.desc()).limit(1))
    if not job:
        return dict(job_id=None,categories=[],provinces=[])
    plan = session.scalar(select(PoiCoveragePlan).where(PoiCoveragePlan.job_id == job.id))
    if plan:
        ready = plan.state == 'ready' and bool((plan.summary or {}).get('coverage_verified'))
        counts = defaultdict(lambda: [0,0])
        rows = session.execute(select(PoiCoverageCircle.province_name,PoiSegment.status,func.count()).join(
            PoiSegment,PoiSegment.coverage_circle_id==PoiCoverageCircle.id).where(
                PoiCoverageCircle.plan_id==plan.id,PoiSegment.job_id==job.id,PoiSegment.kind=='coverage',
                PoiSegment.parent_segment_id.is_(None)).group_by(PoiCoverageCircle.province_name,PoiSegment.status)).all()
        for name,status,n in rows:
            counts[normalize(name)][0] += n
            if status == 'complete': counts[normalize(name)][1] += n
        names = session.scalars(select(PoiBoundary.name).where(PoiBoundary.version==plan.source_version,
            PoiBoundary.level=='province').order_by(PoiBoundary.name)).all()
        provinces = [completion_row(name,*counts[normalize(name)],ready) for name in names]
    elif job.search_dataset_version:
        from backend.poi import geographic_progress
        provinces = [completion_row(r['province'],r['expected_searches'],r['completed_searches'])
            for r in geographic_progress(session,job)['provinces']]
    else:
        # Legacy grid and pilot work do not establish the provincial progress in this workflow.
        provinces = []
    return dict(job_id=str(job.id),categories=list(job.categories),provinces=provinces)


def require_region(permission, coverage, province, category):
    if not in_scope(permission,province):
        raise HTTPException(403,detail='ویرایش این استان در دسترسی شما نیست.')
    row = next((r for r in coverage['provinces'] if normalize(r['province']) == normalize(province)),None)
    if not row or not row['eligible'] or category not in coverage['categories']:
        raise HTTPException(409,detail='گردآوری این استان یا نوع مکان هنوز کامل نشده است؛ ثبت و ویرایش فعلاً بسته است.')


def source_values(row, category):
    raw = row.raw_details if row.provider == 'neshan' and isinstance(row.raw_details,dict) else {}
    return dict(name=row.name,category=category,latitude=row.latitude,longitude=row.longitude,address=row.address,
        phoneNumber=raw.get('phoneNumber'),website=raw.get('website'),workHours=raw.get('workHours'),
        socialNetworks=raw.get('socialNetworks'))


def source_category(session, row):
    layer=(row.raw_details or {}).get('layer') if row.provider=='neshan' and isinstance(row.raw_details,dict) else None
    if isinstance(layer,dict) and isinstance(layer.get('slug'),str):return layer['slug']
    return session.scalar(select(PoiPlaceCategory.category).where(PoiPlaceCategory.place_id==row.id)
        .order_by(PoiPlaceCategory.category).limit(1))


def effective(source, payload):
    return {**source, **(payload or {}).get('overrides',{})}


def make_payload(source, values, attributes):
    # Presence distinguishes clearing a value (null) from using the source value.
    return dict(overrides={key:value for key,value in values.items() if source.get(key) != value},attributes=attributes)


class HoursRange(InputBody):
    start: str = Field(pattern=r'^([01]\d|2[0-3]):[0-5]\d$')
    end: str = Field(pattern=r'^([01]\d|2[0-3]):[0-5]\d$')


class HoursDay(InputBody):
    day: str = Field(min_length=1,max_length=20)
    ranges: list[HoursRange] = Field(max_length=8)


class VenueValues(InputBody):
    name: str = Field(min_length=1,max_length=250)
    category: str = Field(min_length=1,max_length=100)
    latitude: FiniteFloat = Field(ge=24,le=41)
    longitude: FiniteFloat = Field(ge=43,le=64)
    address: str | None = Field(default=None,max_length=2000)
    phoneNumber: str | None = Field(default=None,max_length=150)
    website: str | None = Field(default=None,max_length=800)
    workHours: list[HoursDay] | None = Field(default=None,max_length=7)
    socialNetworks: list[dict[str,str]] | None = Field(default=None,max_length=20)

    @field_validator('name')
    @classmethod
    def name_present(cls,value):
        if not value.strip(): raise ValueError('Name is required')
        return value.strip()

    @field_validator('workHours')
    @classmethod
    def unique_days(cls,value):
        if value is not None and len({normalize(r.day) for r in value}) != len(value):
            raise ValueError('Duplicate weekday')
        return value

    @field_validator('socialNetworks')
    @classmethod
    def bounded_social(cls,value):
        for item in value or []:
            if len(item)>8: raise ValueError('Too many social network properties')
            for key,text in item.items():
                if len(key)>60 or len(text)>800: raise ValueError('Social network entry too long')
                safe_text(text)
        return value


def definitions(session):
    rows=session.scalars(select(PoiFieldDefinition).order_by(PoiFieldDefinition.label)).all()
    return sorted(rows,key=lambda row:((row.constraints or {}).get('order',100),row.label))


def field_dict(row):
    return dict(key=row.key,label=row.label,kind=row.kind,categories=row.categories,choices=row.choices,
        required=row.required,public=row.public,active=row.active,constraints=row.constraints or {})


def validate_attributes(catalogue, category, values, existing=None):
    if len(values)>100: raise HTTPException(422,detail='تعداد ویژگی‌ها بیش از حد مجاز است.')
    allowed = {r.key:r for r in catalogue if category in r.categories}
    for key,value in values.items():
        row = allowed.get(key)
        if not row or (not row.active and (existing or {}).get(key) != value):
            raise HTTPException(422,detail='یکی از ویژگی‌ها برای این نوع مکان تعریف نشده است.')
        valid = value is None
        if row.kind=='text': valid |= isinstance(value,str) and len(value)<=2000
        elif row.kind=='number': valid |= type(value) is int or type(value) is float and math.isfinite(value)
        elif row.kind=='boolean': valid |= type(value) is bool
        elif row.kind=='choice': valid |= value in row.choices
        elif row.kind=='date':
            try: valid |= isinstance(value,str) and date.fromisoformat(value).isoformat()==value
            except ValueError: pass
        if not valid: raise HTTPException(422,detail=f'مقدار «{row.label}» معتبر نیست.')
        rules=row.constraints or {}
        if value is not None and row.kind=='number':
            if rules.get('integer') and int(value)!=value:raise HTTPException(422,detail=f'«{row.label}» باید عدد صحیح باشد.')
            if rules.get('minimum') is not None and value<rules['minimum']:raise HTTPException(422,detail=f'«{row.label}» کمتر از حد مجاز است.')
            if rules.get('maximum') is not None and value>rules['maximum']:raise HTTPException(422,detail=f'«{row.label}» بیشتر از حد مجاز است.')
            if rules.get('integer'):values[key]=int(value)
        if isinstance(value,str) and len(value)>rules.get('max_length',2000):raise HTTPException(422,detail=f'متن «{row.label}» بیش از حد طولانی است.')
        if isinstance(value,str):
            try:safe_text(value)
            except ValueError:raise HTTPException(422,detail='متن ویژگی معتبر نیست.') from None
    for row in allowed.values():
        if row.active and row.required and values.get(row.key) in (None,''):
            raise HTTPException(422,detail=f'«{row.label}» الزامی است.')
    return values


def public_attributes(catalogue, payload):
    allowed={r.key for r in catalogue if r.public and r.active}
    return {key:value for key,value in (payload or {}).get('attributes',{}).items() if key in allowed}


def attribute_values(row,editorial,catalogue,category,private=False):
    from backend.poi_venue_schema import source_administration
    allowed=[r.key for r in catalogue if r.active and category in r.categories and (private or r.public)]
    defaults=source_administration(row,effective_province(row,editorial))
    values={**defaults,**((editorial.published or {}).get('attributes',{}) if editorial else {})}
    return {key:values.get(key) for key in allowed}


def attributions(session,editorials):
    if not editorials:return {}
    ids=[e.place_id for e in editorials]
    revisions=session.scalars(select(PoiEditRevision).join(PoiEditorial,PoiEditorial.place_id==PoiEditRevision.place_id)
        .where(PoiEditRevision.place_id.in_(ids),
            (PoiEditRevision.version==PoiEditorial.published_version)|(PoiEditRevision.version==1))).all()
    snapshots={(r.place_id,r.version):r for r in revisions}
    user_ids={value for e in editorials for value in (e.created_by,e.updated_by) if value is not None}
    user_ids.update(r.actor_id for r in revisions if r.actor_id is not None)
    names={r.id:' '.join(filter(None,[r.first_name,r.last_name])) for r in session.execute(select(User.id,User.first_name,User.last_name).where(User.id.in_(user_ids))).all()} if user_ids else {}
    def person(user_id,snapshot=None):
        return dict(user_id=user_id,name=(snapshot.actor_name if snapshot and snapshot.actor_name else names.get(user_id)) or 'ثبت‌کننده مشخص نیست')
    result={}
    for e in editorials:
        first=snapshots.get((e.place_id,1));latest=snapshots.get((e.place_id,e.published_version))
        first=first if first and first.actor_id==e.created_by else None
        result[e.place_id]=dict(created_by=person(e.created_by,first),last_edited_by=person(latest.actor_id if latest else e.updated_by or e.created_by,latest),
            action=latest.action if latest else e.tag,at=latest.created_at.isoformat() if latest and latest.created_at else None)
    return result


def public_place(row, editorial, source, catalogue,contributors=None):
    payload=editorial.published
    values=effective(source,payload)
    return dict(id=str(row.id),**values,province=effective_province(row,editorial),tag=editorial.tag,
        identity=source_identity(row),version=editorial.version,published_version=editorial.published_version,
        attributes=attribute_values(row,editorial,catalogue,values['category']),contributors=contributors,
        match_id=poi_identity.prefix32_key(row.provider_id) if poi_identity.enabled() and row.provider=='neshan' else None)

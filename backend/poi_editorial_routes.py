"""Province-gated local revisions. Never persist live Nearby results."""
from datetime import datetime,timezone
from uuid import UUID,uuid4
import math
import re
from typing import Literal
from fastapi import APIRouter,HTTPException,Query,Request
from pydantic import Field,FiniteFloat
from sqlalchemy import select,func,or_,and_
from sqlalchemy.dialects.postgresql import insert
from backend import database,poi_editorial as edit
from backend import poi_venue_schema as venue_schema
from backend.models import User
from backend.poi_models import PoiPlace,PoiPlaceCategory
from backend.poi_editorial_models import (PoiEditorial,PoiEditRevision,
    PoiEditorGrant,PoiFieldDefinition,PoiContributionAward,PoiSourceRevision,PoiSourceIdentity)
from backend.poi_manual import assign_province
from backend.poi_geo import normalize
from backend.poi_explore import response,published_category,within_search_radius
from backend.input_security import InputBody


class Submission(InputBody):
    submission_id: UUID
    version: int = Field(ge=0,strict=True)
    source_version: str | None = Field(default=None,max_length=64)
    values: edit.VenueValues
    attributes: dict = Field(default_factory=dict)
    reason: str = Field(min_length=3,max_length=1000)


class Restore(InputBody):
    submission_id: UUID
    version: int = Field(ge=0,strict=True)
    revision_id: UUID
    reason: str = Field(min_length=3,max_length=1000)


class Review(InputBody):
    approve: bool
    note: str = Field(default='',max_length=1000)


class Overlay(InputBody):
    category: str = Field(max_length=100)
    south: FiniteFloat = Field(ge=24,le=41)
    north: FiniteFloat = Field(ge=24,le=41)
    west: FiniteFloat = Field(ge=43,le=64)
    east: FiniteFloat = Field(ge=43,le=64)
    latitude: FiniteFloat = Field(ge=24,le=41)
    longitude: FiniteFloat = Field(ge=43,le=64)
    radius: int = Field(ge=10,le=100000,strict=True)
    zoom: int = Field(ge=8,le=19,strict=True)
    identities: list[str] = Field(default_factory=list,max_length=500)
    prefixes: list[str] = Field(default_factory=list,max_length=5000)
    include_places: bool = True


class Grant(InputBody):
    provinces: list[str] = Field(default_factory=list,max_length=31)
    all_provinces: bool = False
    can_review: bool = False
    active: bool = True


class FieldConstraints(InputBody):
    order: int = Field(default=100,ge=0,le=10000)
    integer: bool = False
    minimum: FiniteFloat | None = None
    maximum: FiniteFloat | None = None
    max_length: int = Field(default=2000,ge=1,le=2000)
    coordinate_province: bool = False
    county_suggestions: bool = False


class Definition(InputBody):
    label: str = Field(min_length=1,max_length=100)
    kind: Literal['text','number','boolean','choice','date']
    categories: list[str] = Field(min_length=1,max_length=100)
    choices: list[str] = Field(default_factory=list,max_length=100)
    required: bool = False
    public: bool = False
    active: bool = True
    constraints: FieldConstraints = Field(default_factory=FieldConstraints)


def iso(value): return value.isoformat() if value else None
def actor_name(actor):return ' '.join(filter(None,[actor.get('first_name'),actor.get('last_name')])) or f"کاربر {actor['id']}"
def source(session,row): return edit.source_values(row,edit.source_category(session,row))
def scoped(permission,row,editorial):
    target=edit.effective_province(row,editorial)
    return edit.in_scope(permission,row.province_name) and (not target or edit.in_scope(permission,target))


def lock_editorial(session,place_id):
    """Serialize editorial revisions without row-locking the collector's source table."""
    if session.get_bind().dialect.name=='postgresql':
        key=int(edit.fingerprint(str(place_id))[:8],16)&0x7fffffff
        session.execute(select(func.pg_advisory_xact_lock(741923817,key)))
    return session.scalar(select(PoiEditorial).where(PoiEditorial.place_id==place_id).with_for_update())


def prevent_duplicate_addition(session,values,province,exclude=None):
    # Serialize same-name additions/publications across contributors on PostgreSQL.
    # Never merge identities by name; only stop an obvious duplicate for review.
    if session.get_bind().dialect.name=='postgresql':
        key=int(edit.fingerprint([normalize(values['name']),normalize(province)])[:15],16)
        session.execute(select(func.pg_advisory_xact_lock(key)))
    lat=edit.coordinate_expression('latitude');lon=edit.coordinate_expression('longitude')
    pending=select(PoiEditRevision.id).where(PoiEditRevision.place_id==PoiPlace.id,PoiEditRevision.status=='pending').exists()
    rows=session.execute(select(PoiPlace,PoiEditorial).outerjoin(PoiEditorial,PoiEditorial.place_id==PoiPlace.id)
        .join(PoiPlaceCategory,PoiPlaceCategory.place_id==PoiPlace.id).where(
            edit.category_expression()==values['category'],
            or_(PoiPlace.provider!='manual',PoiEditorial.published_version>0,pending),
            lat.between(values['latitude']-.001,values['latitude']+.001),lon.between(values['longitude']-.001,values['longitude']+.001))
        .limit(100)).all()
    for row,editorial in rows:
        if row.id==exclude:continue
        candidate=edit.effective(edit.source_values(row,values['category']),editorial.published if editorial else None)
        if normalize(candidate['name'])==normalize(values['name']) and within_search_radius(candidate['latitude'],candidate['longitude'],
                (values['latitude'],values['longitude']),30):
            raise HTTPException(409,detail='مکانی با همین نام و نوع در این نقطه ثبت شده است؛ ابتدا مکان موجود را از روی نقشه باز کنید.')


def detail(session,row,actor,allow_pending=False):
    edit.observe_source(session,row)
    baseline=source(session,row); editorial=session.get(PoiEditorial,row.id)
    permission=edit.permissions(session,actor); payload=editorial.published if editorial else None
    values=edit.effective(baseline,payload);catalogue=edit.definitions(session)
    output=dict(id=str(row.id),values=values,tag=editorial.tag if editorial and editorial.published_version else None,
        published=bool(editorial and editorial.published_version),identity=edit.source_identity(row),province=edit.effective_province(row,editorial),
        attributes=edit.attribute_values(row,editorial,catalogue,values['category']),can_edit=False,
        contributors=edit.attributions(session,[editorial]).get(row.id) if editorial and editorial.published_version else None)
    if scoped(permission,row,editorial):
        coverage=edit.eligibility(session);allowed=True
        try:
            venue_schema.require_editable_category(session,baseline['category'])
            venue_schema.require_editable_category(session,values['category'])
            edit.require_region(permission,coverage,row.province_name,baseline['category'])
            target=edit.effective_province(row,editorial)
            if editorial and target:edit.require_region(permission,coverage,target,edit.effective(baseline,payload)['category'])
        except HTTPException as error:allowed=False;output['locked_reason']=error.detail
        output.update(can_edit=bool(allowed and (row.resolved_at or row.provider=='manual')),source=baseline,source_version=edit.fingerprint(baseline),
            version=editorial.version if editorial else 0,published_version=editorial.published_version if editorial else 0,
            attributes=edit.attribute_values(row,editorial,catalogue,values['category'],private=True),
            source_attributes=venue_schema.source_administration(row,row.province_name))
        pending=session.scalar(select(PoiEditRevision).where(PoiEditRevision.place_id==row.id,PoiEditRevision.status=='pending')
            .order_by(PoiEditRevision.version.desc()).limit(1))
        if allow_pending and pending and (pending.actor_id==actor['id'] or permission['can_review']):
            proposed=edit.effective(baseline,pending.payload)
            province=assign_province(proposed['latitude'],proposed['longitude'])['province_name']
            output.update(values=proposed,attributes={**venue_schema.source_administration(row,province),**pending.payload.get('attributes',{})},
                pending_revision=str(pending.id),pending_actor=dict(user_id=pending.actor_id,name=pending.actor_name))
    if not row.resolved_at and row.provider!='manual':output['locked_reason']='جزئیات این مکان هنوز در پایگاه داده کامل نشده است.'
    return output


def revision_dict(row):
    return dict(id=str(row.id),place_id=str(row.place_id),version=row.version,actor_id=row.actor_id,reviewer_id=row.reviewer_id,
        actor_name=row.actor_name,reviewer_name=row.reviewer_name,action=row.action,status=row.status,reason=row.reason,review_note=row.review_note,created_at=iso(row.created_at),
        before=row.source_snapshot.get('previous',row.source_snapshot['values']),after=edit.effective(row.source_snapshot['values'],row.payload),attributes=row.payload.get('attributes',{}))


def grant_dict(row):
    return dict(user_id=row.user_id,provinces=row.provinces,all_provinces=row.all_provinces,can_review=row.can_review,active=row.active)


def build_router(require_admin,require_user):
    router=APIRouter()

    @router.get('/api/poi-explore/editor/config')
    def configuration(request:Request):
        actor=require_user(request)
        with database.db_session() as session:
            permission=edit.permissions(session,actor)
            return response(dict(permissions=permission,coverage=edit.eligibility(session),
                editable_categories=sorted(venue_schema.editable_categories(session)),administrative_areas=venue_schema.administrative_areas() if permission['can_edit'] else {},
                fields=[edit.field_dict(r) for r in edit.definitions(session) if r.active and (permission['can_edit'] or r.public)]))

    @router.get('/api/poi-explore/venue-match/{identity}')
    def match(identity:str,request:Request,draft:bool=False,latitude:float|None=Query(default=None,ge=24,le=41),longitude:float|None=Query(default=None,ge=43,le=64)):
        actor=require_user(request)
        if not re.fullmatch('[a-f0-9]{64}',identity):raise HTTPException(422,detail='شناسه معتبر نیست.')
        with database.db_session() as session:
            row=session.scalar(select(PoiPlace).join(PoiSourceIdentity,PoiSourceIdentity.place_id==PoiPlace.id)
                .where(PoiPlace.provider=='neshan',PoiSourceIdentity.match_key==identity))
            if row and edit.source_identity(row)!=identity:row=None
            if row is None:
                query=select(PoiPlace).where(PoiPlace.provider=='neshan',edit.source_identity_expression()==identity)
                if latitude is not None and longitude is not None:
                    row=session.scalar(query.where(PoiPlace.latitude.between(latitude-1,latitude+1),PoiPlace.longitude.between(longitude-1.5,longitude+1.5)).limit(1))
                if row is None:row=session.scalar(query.limit(1))
            if not row:raise HTTPException(404,detail='این مکان هنوز در پایگاه داده ثبت نشده است؛ ویرایش فعلاً ممکن نیست.')
            return response(detail(session,row,actor,draft))

    @router.get('/api/poi-explore/editor/eligibility')
    def point_eligibility(request:Request,category:str,latitude:float=Query(ge=24,le=41),longitude:float=Query(ge=43,le=64)):
        actor=require_user(request)
        with database.db_session() as session:
            permission=edit.permissions(session,actor);assignment=assign_province(latitude,longitude)
            try:
                venue_schema.require_editable_category(session,category)
                if not assignment['province_name']:raise HTTPException(409,detail='نقطه داخل مرز استان‌های ایران نیست.')
                edit.require_region(permission,edit.eligibility(session),assignment['province_name'],category)
                return response(dict(eligible=True,province=assignment['province_name']))
            except HTTPException as error:return response(dict(eligible=False,province=assignment['province_name'],reason=error.detail))

    @router.get('/api/poi-explore/venues/{place_id}')
    def venue(place_id:UUID,request:Request,draft:bool=False):
        actor=require_user(request)
        with database.db_session() as session:
            row=session.get(PoiPlace,place_id)
            if not row:raise HTTPException(404,detail='مکان یافت نشد.')
            editorial=session.get(PoiEditorial,place_id)
            if row.provider=='manual' and not (editorial and editorial.published_version) and not scoped(edit.permissions(session,actor),row,editorial):
                raise HTTPException(404,detail='مکان یافت نشد.')
            return response(detail(session,row,actor,draft))

    @router.post('/api/poi-explore/overlays')
    def overlays(body:Overlay,request:Request):
        require_user(request);published_category(body.category)
        if body.south>body.north or body.west>body.east or any(not re.fullmatch('[a-f0-9]{64}',v) for v in body.identities) or any(not re.fullmatch('[a-f0-9]{8}',v) for v in body.prefixes):
            raise HTTPException(422,detail='محدوده یا شناسه معتبر نیست.')
        with database.db_session() as session:
            suppressed=session.scalars(select(PoiSourceIdentity.match_key).join(PoiEditorial,PoiEditorial.place_id==PoiSourceIdentity.place_id).where(
                PoiEditorial.published_version>0,or_(PoiSourceIdentity.match_key.in_(body.identities),
                    func.substr(PoiSourceIdentity.match_key,1,8).in_(body.prefixes)))).all() if body.identities or body.prefixes else []
            if not body.include_places:return response(dict(places=[],suppressed=suppressed,has_more=False))
            dy=body.radius/110000
            dx=body.radius/(110000*math.cos(math.radians(min(89,abs(body.latitude)+dy))))
            rows=session.execute(select(PoiPlace,PoiEditorial).join(PoiEditorial,PoiEditorial.place_id==PoiPlace.id)
                .join(PoiPlaceCategory,PoiPlaceCategory.place_id==PoiPlace.id).where(
                PoiEditorial.published_version>0,edit.category_expression()==body.category,
                edit.coordinate_expression('latitude').between(max(body.south,body.latitude-dy),min(body.north,body.latitude+dy)),
                edit.coordinate_expression('longitude').between(max(body.west,body.longitude-dx),min(body.east,body.longitude+dx)))
                .distinct()
                .order_by(PoiEditorial.place_id).limit(1001)).all()
            catalogue=edit.definitions(session);places=[]
            authors=edit.attributions(session,[editorial for row,editorial in rows])
            for row,editorial in rows:
                values=edit.effective(edit.source_values(row,body.category),editorial.published)
                if within_search_radius(values['latitude'],values['longitude'],(body.latitude,body.longitude),body.radius):
                    places.append(edit.public_place(row,editorial,edit.source_values(row,body.category),catalogue,authors.get(row.id)))
                    if len(places)>500:break
            return response(dict(places=places[:500],suppressed=suppressed,has_more=len(places)>500 or len(rows)>1000))

    @router.get('/api/poi-explore/editor/places')
    def editable_places(request:Request,category:str,south:float=Query(ge=24,le=41),north:float=Query(ge=24,le=41),
                        west:float=Query(ge=43,le=64),east:float=Query(ge=43,le=64),province:str|None=Query(default=None,max_length=120)):
        actor=require_user(request)
        if south>north or west>east:raise HTTPException(422,detail='محدوده معتبر نیست.')
        with database.db_session() as session:
            permission=edit.permissions(session,actor)
            if not permission['can_edit']:raise HTTPException(403,detail='دسترسی ویرایش ندارید.')
            venue_schema.require_editable_category(session,category)
            if province:edit.require_region(permission,edit.eligibility(session),province,category)
            lat=edit.coordinate_expression('latitude');lon=edit.coordinate_expression('longitude')
            rows=session.execute(select(PoiPlace,PoiEditorial).outerjoin(PoiEditorial,PoiEditorial.place_id==PoiPlace.id)
                .join(PoiPlaceCategory,PoiPlaceCategory.place_id==PoiPlace.id).where(
                    edit.category_expression()==category,
                    or_(PoiPlace.province_name==province,PoiEditorial.province_name==province) if province else True,
                    lat.between(south,north),lon.between(west,east),or_(PoiPlace.resolved_at.is_not(None),
                        and_(PoiPlace.provider=='manual',PoiEditorial.created_by==actor['id'])))
                .distinct().order_by(PoiPlace.name,PoiPlace.id).limit(201)).all()
            return response(dict(places=[dict(id=str(r.id),name=edit.effective(edit.source_values(r,category),e.published if e else None)['name'],
                latitude=edit.effective(edit.source_values(r,category),e.published if e else None)['latitude'],longitude=edit.effective(edit.source_values(r,category),e.published if e else None)['longitude'],
                identity=edit.source_identity(r),province=r.province_name,source=r.provider,tag=e.tag if e and e.published_version else None)
                for r,e in rows[:200] if scoped(permission,r,e) and (not province or normalize(edit.effective_province(r,e))==normalize(province))],has_more=len(rows)>200))

    def submit(body,actor,place_id=None):
        if not body.reason.strip():raise HTTPException(422,detail='دلیل تغییر را بنویسید.')
        published_category(body.values.category)
        with database.db_session() as session:
            session.scalar(select(User.id).where(User.id==actor['id']).with_for_update())
            previous=session.scalar(select(PoiEditRevision).where(PoiEditRevision.submission_id==body.submission_id))
            if previous:
                if previous.actor_id!=actor['id'] or (place_id and previous.place_id!=place_id):raise HTTPException(409,detail='شناسه ارسال تکراری است.')
                return dict(id=str(previous.place_id),revision_id=str(previous.id),version=previous.version,status=previous.status)
            permission=edit.permissions(session,actor);coverage=edit.eligibility(session)
            venue_schema.require_editable_category(session,body.values.category)
            assignment=assign_province(body.values.latitude,body.values.longitude)
            if not assignment['province_name']:raise HTTPException(422,detail='نقطه باید داخل مرز استان‌های ایران باشد.')
            edit.require_region(permission,coverage,assignment['province_name'],body.values.category)
            if place_id:
                lock_editorial(session,place_id)
                row=session.get(PoiPlace,place_id)
                if not row or (not row.resolved_at and row.provider!='manual'):raise HTTPException(409,detail='ثبت جزئیات این مکان کامل نشده است.')
                baseline=source(session,row)
                venue_schema.require_editable_category(session,baseline['category'])
                edit.observe_source(session,row)
                edit.require_region(permission,coverage,row.province_name,baseline['category'])
                if body.source_version!=edit.fingerprint(baseline):raise HTTPException(409,detail='دادهٔ منبع تغییر کرده است؛ اطلاعات مکان را دوباره باز کنید.')
            else:
                prevent_duplicate_addition(session,body.values.model_dump(),assignment['province_name'])
                row=PoiPlace(id=uuid4(),provider='manual',provider_id=str(uuid4()),name=body.values.name,
                    normalized_name=normalize(body.values.name),latitude=body.values.latitude,longitude=body.values.longitude,
                    province_name=assignment['province_name'],spatial_status=assignment['spatial_status'],raw_details={})
                session.add(row);session.flush();session.add(PoiPlaceCategory(place_id=row.id,category=body.values.category))
                baseline=edit.source_values(row,body.values.category)
            editorial=session.get(PoiEditorial,row.id)
            if not editorial:
                editorial=PoiEditorial(place_id=row.id,tag='added' if row.provider=='manual' else 'edited',version=0,published_version=0,created_by=actor['id'])
                session.add(editorial)
            if editorial.version!=body.version:raise HTTPException(409,detail='نسخهٔ جدیدتری ثبت شده است؛ اطلاعات مکان را دوباره باز کنید.')
            if editorial.province_name:edit.require_region(permission,coverage,edit.effective_province(row,editorial),edit.effective(baseline,editorial.published)['category'])
            current=editorial.published or {}
            # Keep previously recorded, now retired fields out of the form without
            # deleting their values when an editor changes the current fields.
            supplied={**current.get('attributes',{}),**venue_schema.prepare_administration(body.attributes,assignment['province_name'])}
            attributes=edit.validate_attributes(edit.definitions(session),body.values.category,supplied,current.get('attributes'))
            attributes=venue_schema.attribute_overrides(attributes,venue_schema.source_administration(row,assignment['province_name']))
            values={**edit.effective(baseline,current),**body.values.model_dump(exclude_unset=True)}
            payload=edit.make_payload(baseline,values,attributes)
            if place_id and payload==dict(overrides=current.get('overrides',{}),attributes=current.get('attributes',{})):
                raise HTTPException(409,detail='تغییری برای ثبت وجود ندارد.')
            if editorial.version:
                latest=session.scalar(select(PoiEditRevision).where(PoiEditRevision.place_id==row.id).order_by(PoiEditRevision.version.desc()).limit(1))
                if latest and latest.status=='pending' and latest.base_published_version==editorial.published_version and latest.payload==payload:
                    raise HTTPException(409,detail='همین تغییر قبلاً برای بررسی ارسال شده است.')
            editorial.version+=1;editorial.updated_by=actor['id'];editorial.updated_at=datetime.now(timezone.utc)
            revision=PoiEditRevision(id=uuid4(),place_id=row.id,submission_id=body.submission_id,version=editorial.version,
                base_published_version=editorial.published_version,actor_id=actor['id'],actor_name=actor_name(actor),action='added' if row.provider=='manual' and not editorial.published_version else 'edited',
                status='pending',payload=payload,source_snapshot=dict(values=baseline,previous=edit.effective(baseline,current),raw_details=row.raw_details or {}),reason=body.reason.strip())
            session.add(revision)
            return dict(id=str(row.id),revision_id=str(revision.id),version=editorial.version,status='pending')

    @router.post('/api/poi-explore/manual-places')
    def create(body:Submission,request:Request):return response(submit(body,require_user(request)),201)

    @router.patch('/api/poi-explore/manual-places/{place_id}')
    def change(place_id:UUID,body:Submission,request:Request):return response(submit(body,require_user(request),place_id))

    @router.get('/api/poi-explore/venues/{place_id}/history')
    def history(place_id:UUID,request:Request,page:int=Query(default=0,ge=0,le=10000)):
        actor=require_user(request)
        with database.db_session() as session:
            row=session.get(PoiPlace,place_id)
            if not row or not scoped(edit.permissions(session,actor),row,session.get(PoiEditorial,place_id)):raise HTTPException(403,detail='دسترسی به سابقه ندارید.')
            rows=session.scalars(select(PoiEditRevision).where(PoiEditRevision.place_id==place_id).order_by(PoiEditRevision.version.desc()).offset(page*50).limit(51)).all()
            snapshots=session.scalars(select(PoiSourceRevision).where(PoiSourceRevision.place_id==place_id)
                .order_by(PoiSourceRevision.observed_at.desc()).offset(page*20).limit(21)).all()
            source_history=[]
            for snapshot in snapshots[:20]:
                raw=snapshot.details;location=raw.get('location') or {};layer=raw.get('layer') or {}
                source_history.append(dict(observed_at=iso(snapshot.observed_at),values={
                    **{key:raw.get(key) for key in ('name','address','phoneNumber','website','workHours','socialNetworks')},
                    'latitude':location.get('latitude',location.get('y')),'longitude':location.get('longitude',location.get('x')),
                    'category':layer.get('slug') if isinstance(layer,dict) else None}))
            return response(dict(revisions=[revision_dict(r) for r in rows[:50]],source_history=source_history,has_more=len(rows)>50 or len(snapshots)>20))

    @router.post('/api/poi-explore/venues/{place_id}/restore')
    def restore(place_id:UUID,body:Restore,request:Request):
        actor=require_user(request)
        with database.db_session() as session:
            row=session.get(PoiPlace,place_id);revision=session.get(PoiEditRevision,body.revision_id)
            if not row or not revision or revision.place_id!=place_id or not scoped(edit.permissions(session,actor),row,session.get(PoiEditorial,place_id)):
                raise HTTPException(403,detail='این سابقه قابل بازیابی نیست.')
            baseline=source(session,row)
            values=edit.effective(baseline,revision.payload)
            for key in ('workHours','socialNetworks'):
                if key not in revision.payload.get('overrides',{}):values.pop(key,None)
            submission=Submission(submission_id=body.submission_id,version=body.version,source_version=edit.fingerprint(baseline),
                values=values,attributes=revision.payload.get('attributes',{}),reason=body.reason)
        return response(submit(submission,actor,place_id))

    @router.get('/api/poi-explore/editor/revisions')
    def pending(request:Request):
        actor=require_user(request)
        with database.db_session() as session:
            permission=edit.permissions(session,actor)
            if not permission['can_review']:raise HTTPException(403,detail='دسترسی بررسی ندارید.')
            rows=session.execute(select(PoiEditRevision,PoiPlace).join(PoiPlace,PoiPlace.id==PoiEditRevision.place_id)
                .where(PoiEditRevision.status=='pending').order_by(PoiEditRevision.created_at).limit(200)).all()
            return response(dict(revisions=[{**revision_dict(r),'name':p.name} for r,p in rows if scoped(permission,p,session.get(PoiEditorial,p.id))]))

    @router.post('/api/poi-explore/editor/revisions/{revision_id}/review')
    def review(revision_id:UUID,body:Review,request:Request):
        actor=require_user(request)
        with database.db_session() as session:
            revision=session.get(PoiEditRevision,revision_id)
            if not revision:raise HTTPException(404,detail='تغییر یافت نشد.')
            editorial=lock_editorial(session,revision.place_id);row=session.get(PoiPlace,revision.place_id)
            session.refresh(revision)
            permission=edit.permissions(session,actor)
            if not permission['can_review'] or not scoped(permission,row,editorial):raise HTTPException(403,detail='دسترسی بررسی ندارید.')
            if revision.actor_id==actor['id'] and not actor.get('is_admin'):raise HTTPException(403,detail='تغییر خود را به بررسی‌کنندهٔ دیگری بسپارید.')
            if revision.status!='pending':return response(dict(status=revision.status))
            if not body.approve and not body.note.strip():raise HTTPException(422,detail='دلیل رد تغییر را بنویسید.')
            if body.approve:
                if revision.base_published_version!=editorial.published_version:raise HTTPException(409,detail='نسخهٔ منتشرشده تغییر کرده است؛ این پیشنهاد نیاز به بازبینی دارد.')
                baseline=source(session,row);edit.observe_source(session,row);values=edit.effective(baseline,revision.payload)
                venue_schema.require_editable_category(session,baseline['category'])
                venue_schema.require_editable_category(session,values['category'])
                assignment=assign_province(values['latitude'],values['longitude']);coverage=edit.eligibility(session)
                edit.require_region(permission,coverage,row.province_name,baseline['category'])
                edit.require_region(permission,coverage,assignment['province_name'],values['category']);published_category(values['category'])
                if row.provider=='manual':prevent_duplicate_addition(session,values,assignment['province_name'],row.id)
                verified=venue_schema.prepare_administration({**venue_schema.source_administration(row,assignment['province_name']),**revision.payload.get('attributes',{})},assignment['province_name'],
                    validate_county=any(field.active and field.key=='county' for field in edit.definitions(session)))
                edit.validate_attributes(edit.definitions(session),values['category'],verified,revision.payload.get('attributes',{}))
                editorial.published=revision.payload;editorial.published_version=revision.version;editorial.name=values['name'];editorial.category=values['category']
                editorial.latitude=values['latitude'];editorial.longitude=values['longitude'];editorial.province_name=assignment['province_name'];editorial.published_by=actor['id']
                if row.provider=='manual' and not row.resolved_at:row.resolved_at=datetime.now(timezone.utc)
                if revision.actor_id:
                    session.execute(insert(PoiContributionAward).values(id=uuid4(),user_id=revision.actor_id,place_id=row.id,revision_id=revision.id,
                        action=revision.action,points=10 if revision.action=='added' else 3,revoked=False).on_conflict_do_nothing(constraint='uq_poi_contribution_once'))
            revision.status='approved' if body.approve else 'rejected';revision.reviewer_id=actor['id'];revision.reviewer_name=actor_name(actor);revision.review_note=body.note;revision.reviewed_at=datetime.now(timezone.utc)
            return response(dict(status=revision.status))

    @router.get('/api/account/contributions')
    def contributions(request:Request,page:int=Query(default=0,ge=0,le=10000)):
        actor=require_user(request)
        with database.db_session() as session:
            summary=dict(session.execute(select(PoiEditRevision.status,func.count()).where(PoiEditRevision.actor_id==actor['id']).group_by(PoiEditRevision.status)).all())
            points=session.scalar(select(func.coalesce(func.sum(PoiContributionAward.points),0)).where(PoiContributionAward.user_id==actor['id'],PoiContributionAward.revoked.is_(False)))
            permission=edit.permissions(session,actor)
            coverage=edit.eligibility(session) if permission['can_edit'] else None
            enabled=venue_schema.editable_categories(session) if permission['can_edit'] else set()
            rows=session.execute(select(PoiEditRevision,PoiPlace,PoiEditorial).join(PoiPlace,PoiPlace.id==PoiEditRevision.place_id)
                .outerjoin(PoiEditorial,PoiEditorial.place_id==PoiPlace.id).where(PoiEditRevision.actor_id==actor['id'])
                .order_by(PoiEditRevision.created_at.desc(),PoiEditRevision.id.desc()).offset(page*20).limit(21)).all()
            writable={}
            for revision,row,editorial in rows[:20]:
                if row.id in writable:continue
                allowed=bool(permission['can_edit'] and scoped(permission,row,editorial) and (row.resolved_at or row.provider=='manual'))
                baseline=source(session,row)
                target=edit.effective(baseline,editorial.published if editorial else None)
                if baseline['category'] not in enabled or target['category'] not in enabled:allowed=False
                if allowed:
                    try:
                        edit.require_region(permission,coverage,row.province_name,baseline['category'])
                        edit.require_region(permission,coverage,edit.effective_province(row,editorial),target['category'])
                    except HTTPException:allowed=False
                writable[row.id]=allowed
            return response(dict(points=points,summary=summary,page=page,has_more=len(rows)>20,contributions=[dict(id=str(r.id),place_id=str(p.id),
                name=edit.effective(r.source_snapshot['values'],r.payload)['name'],action=r.action,status=r.status,created_at=iso(r.created_at),review_note=r.review_note,
                can_reedit=writable[p.id]) for r,p,e in rows[:20]],
                scoring=dict(added=10,edited=3,once_per_user_place_action=True)))

    @router.get('/api/admin/poi/editors')
    def editors(request:Request):
        require_admin(request)
        with database.db_session() as session:
            users=session.scalars(select(User).where(User.is_active.is_(True)).order_by(User.id)).all();grants={r.user_id:r for r in session.scalars(select(PoiEditorGrant)).all()}
            return response(dict(users=[dict(id=u.id,name=' '.join(filter(None,[u.first_name,u.last_name])) or str(u.id),admin=u.is_admin,
                grant=grant_dict(grants[u.id]) if u.id in grants else None) for u in users]))

    @router.patch('/api/admin/poi/editors/{user_id}')
    def grant(user_id:int,body:Grant,request:Request):
        actor=require_admin(request)
        with database.db_session() as session:
            user=session.get(User,user_id)
            if not user or not user.is_active:raise HTTPException(404,detail='کاربر فعال یافت نشد.')
            known={normalize(r['province']):r['province'] for r in edit.eligibility(session)['provinces']}
            if any(normalize(p) not in known for p in body.provinces):raise HTTPException(422,detail='استان معتبر انتخاب کنید.')
            row=session.get(PoiEditorGrant,user_id)
            if not row:row=PoiEditorGrant(user_id=user_id);session.add(row)
            for key,value in body.model_dump().items():setattr(row,key,value)
            row.provinces=sorted({known[normalize(p)] for p in body.provinces})
            row.granted_by=actor['id'];return response(grant_dict(row))

    @router.get('/api/admin/poi/fields')
    def fields(request:Request):
        require_admin(request)
        with database.db_session() as session:return response(dict(fields=[edit.field_dict(r) for r in edit.definitions(session)]))

    @router.patch('/api/admin/poi/fields/{key}')
    def field(key:str,body:Definition,request:Request):
        require_admin(request)
        if not re.fullmatch('[a-z][a-z0-9_]{0,59}',key):raise HTTPException(422,detail='شناسه ویژگی باید ثابت و لاتین باشد.')
        if key in set(edit.COMMON)|{'id','provider','provider_id','version','tag','constructor','prototype'}:
            raise HTTPException(422,detail='این شناسه برای فیلدهای اصلی سامانه رزرو شده است.')
        for category in body.categories:published_category(category)
        if body.kind=='choice' and not body.choices:raise HTTPException(422,detail='گزینه‌های ویژگی را وارد کنید.')
        with database.db_session() as session:
            row=session.get(PoiFieldDefinition,key)
            if row and (row.kind!=body.kind or set(row.categories)-set(body.categories)):raise HTTPException(409,detail='نوع و کاربرد ویژگی موجود را حذف نکنید؛ آن را غیرفعال و ویژگی تازه‌ای تعریف کنید.')
            if row and set(row.choices or [])-set(body.choices):raise HTTPException(409,detail='گزینهٔ موجود را حذف نکنید؛ برای تغییر ساختار، ویژگی تازه‌ای تعریف کنید.')
            if not row:row=PoiFieldDefinition(key=key);session.add(row)
            for name,value in body.model_dump().items():setattr(row,name,value)
            row.constraints=body.constraints.model_dump(exclude_none=True)
            return response(edit.field_dict(row))

    return router

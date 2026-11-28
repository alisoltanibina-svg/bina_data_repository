"""Province-gated local revisions. Never persist live Nearby results."""
from datetime import datetime,timezone
from uuid import UUID,uuid4
import math
import re
import json
from typing import Literal
from fastapi import APIRouter,HTTPException,Query,Request,UploadFile,File,Form,BackgroundTasks
from fastapi.responses import FileResponse
from pydantic import Field,FiniteFloat
from sqlalchemy import select,func,or_,and_
from sqlalchemy.dialects.postgresql import insert
from backend import database,poi_editorial as edit
from backend import poi_venue_schema as venue_schema
from backend import place_photos,place_notifications,place_drafts,place_geocoding
from backend import poi_place_matching as matching
from backend import poi_canonical as canonical
from backend.models import User
from backend.poi_models import PoiPlace,PoiPlaceCategory,PoiPlaceLink,PoiRetiredPlace,PoiExploreCategory
from backend.poi_editorial_models import (PoiEditorial,PoiEditRevision,
    PoiEditorGrant,PoiFieldDefinition,PoiContributionAward,PoiSourceRevision,PoiPlacePhoto,PoiRegistrationDraft)
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
    photo_id: UUID | None = None
    remove_photo: bool = False
    draft_id: UUID | None = None
    draft_version: int | None = Field(default=None,ge=0,strict=True)


class DraftStart(InputBody):
    place_id:UUID|None=None
    start_new:bool=False


class AddressPoint(InputBody):
    category:str=Field(min_length=1,max_length=100)
    latitude:FiniteFloat=Field(ge=24,le=41)
    longitude:FiniteFloat=Field(ge=43,le=64)


class Restore(InputBody):
    submission_id: UUID
    version: int = Field(ge=0,strict=True)
    revision_id: UUID
    reason: str = Field(min_length=3,max_length=1000)


class Review(InputBody):
    approve: bool
    note: str = Field(default='',max_length=1000)

class MatchPoint(InputBody):
    name: str = Field(min_length=1,max_length=250)
    latitude: FiniteFloat = Field(ge=24,le=41)
    longitude: FiniteFloat = Field(ge=43,le=64)

class PlaceMatch(MatchPoint):
    category: str = Field(min_length=1,max_length=100)

class LiveMatchPoint(MatchPoint):
    reference: int = Field(ge=0,le=20000,strict=True)


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
    live_places: list[LiveMatchPoint] = Field(default_factory=list,max_length=200)
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

def canonical_row(session,place_id):
    try:
        for _ in range(3):
            root=canonical.canonical_id(session,place_id)
            row=session.get(PoiPlace,root)
            if row is not None:return row
            # A source may have been retired after resolving its UUID. Resolve
            # once more instead of turning a preserved URL into a transient404.
            target=canonical.canonical_id(session,root)
            if target==root:return None
            place_id=target
    except canonical.IdentityConflict:raise HTTPException(409,detail='شناسهٔ مکان نیاز به بررسی مدیر دارد.') from None
    raise HTTPException(409,detail='شناسهٔ مکان در حال یکپارچه‌سازی است؛ دوباره تلاش کنید.')
def scoped(permission,row,editorial,*,staff=False):
    target=edit.effective_province(row,editorial)
    check=edit.in_staff_scope if staff else edit.in_scope
    return check(permission,row.province_name) and (not target or check(permission,target))


def reviewable(permission,row,editorial):
    return bool(permission['can_review'] and scoped(permission,row,editorial,staff=True))


def accessible_place(actor,permission,row,editorial):
    return bool(row.provider!='manual' or (editorial and (editorial.published_version or editorial.created_by==actor['id'])) or
        reviewable(permission,row,editorial))


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
        .outerjoin(PoiPlaceCategory,PoiPlaceCategory.place_id==PoiPlace.id).where(
            edit.category_expression()==values['category'],
            or_(PoiPlace.provider!='manual',PoiEditorial.published_version>0,pending),
            lat.between(values['latitude']-.001,values['latitude']+.001),lon.between(values['longitude']-.001,values['longitude']+.001))
        .limit(100)).all()
    for row,editorial in rows:
        if canonical.canonical_id(session,row.id)==exclude:continue
        candidate=edit.effective(edit.source_values(row,values['category']),editorial.published if editorial else None)
        if matching.normalized(edit.effective_province(row,editorial))==matching.normalized(province) and matching.normalized(candidate['name'])==matching.normalized(values['name']) and within_search_radius(candidate['latitude'],candidate['longitude'],
                (values['latitude'],values['longitude']),matching.RADIUS):
            raise HTTPException(409,detail='مکانی با همین نام و نوع در این نقطه ثبت شده است؛ ابتدا مکان موجود را از روی نقشه باز کنید.')


def detail(session,row,actor,allow_pending=False):
    row=canonical_row(session,row.id)
    editorial=session.get(PoiEditorial,row.id);permission=edit.permissions(session,actor)
    if not accessible_place(actor,permission,row,editorial):raise HTTPException(404,detail='مکان یافت نشد.')
    edit.observe_source(session,row)
    baseline=source(session,row);payload=editorial.published if editorial else None
    values=edit.effective(baseline,payload);catalogue=edit.definitions(session)
    private=scoped(permission,row,editorial,staff=True)
    output=dict(id=str(row.id),values=values,tag=editorial.tag if editorial and editorial.published_version else None,
        published=bool(editorial and editorial.published_version),identity=edit.source_identity(row),province=edit.effective_province(row,editorial),
        attributes=edit.attribute_values(row,editorial,catalogue,values['category']),can_edit=False,
        contributors=edit.attributions(session,[editorial]).get(row.id) if editorial and editorial.published_version else None,
        photo_url=place_photos.url((payload or {}).get('photo_path')))
    if scoped(permission,row,editorial):
        coverage=edit.eligibility_for_provinces(session,[row.province_name,edit.effective_province(row,editorial)]);allowed=True
        try:
            venue_schema.require_editable_category(session,baseline['category'])
            venue_schema.require_editable_category(session,values['category'])
            edit.require_region(permission,coverage,row.province_name,baseline['category'])
            target=edit.effective_province(row,editorial)
            if editorial and target:edit.require_region(permission,coverage,target,edit.effective(baseline,payload)['category'])
        except HTTPException as error:allowed=False;output['locked_reason']=error.detail
        output.update(can_edit=bool(allowed and (row.resolved_at or row.provider=='manual')),source=baseline,source_version=edit.fingerprint(baseline),
            version=editorial.version if editorial else 0,published_version=editorial.published_version if editorial else 0,
            attributes=edit.attribute_values(row,editorial,catalogue,values['category'],private=private),
            source_attributes=venue_schema.source_administration(row,row.province_name))
        pending_query=select(PoiEditRevision).where(PoiEditRevision.place_id==row.id,PoiEditRevision.status=='pending')
        if not reviewable(permission,row,editorial):pending_query=pending_query.where(PoiEditRevision.actor_id==actor['id'])
        pending=session.scalar(pending_query.order_by(PoiEditRevision.version.desc()).limit(1))
        if allow_pending and pending and (pending.actor_id==actor['id'] or reviewable(permission,row,editorial)):
            proposed=edit.effective(baseline,pending.payload)
            province=assign_province(proposed['latitude'],proposed['longitude'])['province_name']
            attributes=pending.payload.get('attributes',{}) if private else edit.public_attributes(catalogue,pending.payload)
            output.update(values=proposed,attributes={**venue_schema.source_administration(row,province),**attributes},
                pending_revision=str(pending.id),pending_actor=dict(user_id=pending.actor_id,name=pending.actor_name),photo_url=place_photos.url(pending.payload.get('photo_path')))
    if not row.resolved_at and row.provider!='manual':output['locked_reason']='جزئیات این مکان هنوز در پایگاه داده کامل نشده است.'
    return output


def revision_dict(row):
    return dict(id=str(row.id),place_id=str(row.place_id),version=row.version,actor_id=row.actor_id,reviewer_id=row.reviewer_id,
        actor_name=row.actor_name,reviewer_name=row.reviewer_name,action=row.action,status=row.status,reason=row.reason,review_note=row.review_note,created_at=iso(row.created_at),
        before=row.source_snapshot.get('previous',row.source_snapshot['values']),after=edit.effective(row.source_snapshot['values'],row.payload),attributes=row.payload.get('attributes',{}),photo_url=place_photos.url(row.payload.get('photo_path')))


def grant_dict(row):
    return dict(user_id=row.user_id,provinces=row.provinces,all_provinces=row.all_provinces,can_review=row.can_review,active=row.active)


def build_router(require_admin,require_user):
    router=APIRouter(lifespan=place_notifications.lifespan)

    @router.post('/api/poi-explore/photos')
    def upload_photo(request:Request,file:UploadFile=File(...),crop:str=Form(...,max_length=500),latitude:FiniteFloat=Form(ge=24,le=41),longitude:FiniteFloat=Form(ge=43,le=64)):
        actor=require_user(request);data=file.file.read(place_photos.MAX_BYTES+1);stored=None
        try:
            try:crop_values=json.loads(crop)
            except (ValueError,TypeError):raise HTTPException(422,detail='محدودهٔ برش معتبر نیست.') from None
            with database.db_session() as session:
                permission=edit.permissions(session,actor);assignment=assign_province(latitude,longitude)
                venue_schema.require_editable_category(session,'mosque');edit.require_region(permission,edit.eligibility(session),assignment['province_name'],'mosque')
                stored=place_photos.stage(session,actor,data,file.filename,crop_values)
                result=dict(id=str(stored.id),url=place_photos.url(stored.path))
            return response(result,201)
        except Exception:
            if stored:place_photos.managed_file(stored.path).unlink(missing_ok=True)
            raise
        finally:file.file.close()

    @router.delete('/api/poi-explore/photos/{identity}')
    def discard_photo(identity:UUID,request:Request):
        actor=require_user(request)
        with database.db_session() as session:
            session.scalar(select(User.id).where(User.id==actor['id']).with_for_update())
            photo=session.scalar(select(PoiPlacePhoto).where(PoiPlacePhoto.id==identity).with_for_update())
            if not photo or photo.uploader_id!=actor['id'] or photo.revision_id:raise HTTPException(404,detail='عکس یافت نشد.')
            # Keep the last saved photo until its replacement has been saved.
            # A failed replacement upload must not damage the durable draft.
            retained=session.scalar(select(PoiRegistrationDraft.id).where(PoiRegistrationDraft.photo_id==identity,
                PoiRegistrationDraft.status.in_(place_drafts.ACTIVE)).limit(1))
            if retained:return response(dict(deleted=False))
            path=photo.path;session.delete(photo)
        place_photos.managed_file(path).unlink(missing_ok=True)
        return response(dict(deleted=True))

    @router.get('/api/poi-explore/photos/{identity}')
    def photo_file(identity:UUID,request:Request):
        actor=require_user(request)
        with database.db_session() as session:
            photo=session.get(PoiPlacePhoto,identity)
            if not photo:raise HTTPException(404,detail='عکس یافت نشد.')
            root=canonical.canonical_id(session,photo.place_id) if photo.place_id else None
            editorial=session.get(PoiEditorial,root) if root else None
            published=bool(editorial and editorial.published_version and (editorial.published or {}).get('photo_path')==photo.path)
            permission=edit.permissions(session,actor)
            allowed=photo.uploader_id==actor['id'] or published
            if not allowed and permission['can_review'] and photo.place_id:
                row=session.get(PoiPlace,root);allowed=bool(row and reviewable(permission,row,editorial))
            path=place_photos.managed_file(photo.path)
            if not allowed or not path or not path.is_file():raise HTTPException(404,detail='عکس یافت نشد.')
        return FileResponse(path,media_type='image/webp',headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'})

    @router.get('/api/poi-explore/editor/config')
    def configuration(request:Request):
        actor=require_user(request)
        with database.db_session() as session:
            permission=edit.permissions(session,actor)
            categories=session.scalars(select(PoiExploreCategory).where(PoiExploreCategory.is_published.is_(True))
                .order_by(PoiExploreCategory.sort_order,PoiExploreCategory.title)).all()
            return response(dict(permissions=permission,coverage=edit.eligibility(session),
                categories=[dict(category=r.category,title=r.title,icon_url=r.icon_url) for r in categories],
                editable_categories=sorted(venue_schema.editable_categories(session)),administrative_areas=venue_schema.administrative_areas() if permission['can_edit'] else {},
                fields=[edit.field_dict(r) for r in edit.definitions(session) if r.active and (permission['can_view_private'] or r.public)]))

    @router.post('/api/poi-explore/editor/address')
    def point_address(body:AddressPoint,request:Request):
        actor=require_user(request)
        with database.db_session() as session:
            province=assign_province(body.latitude,body.longitude)['province_name']
            if not province:raise HTTPException(422,detail='نقطه باید داخل مرز استان‌های ایران باشد.')
            venue_schema.require_editable_category(session,body.category)
            edit.require_region(edit.permissions(session,actor),edit.eligibility_for_provinces(session,[province]),province,body.category)
        # Release the DB connection before contacting the provider. Only the
        # user-confirmed address subsequently travels through the normal draft/review flow.
        return response(dict(address=place_geocoding.address(body.latitude,body.longitude)))

    def current_draft(session,actor,place_id=None):
        query=select(PoiRegistrationDraft).where(PoiRegistrationDraft.user_id==actor['id'],PoiRegistrationDraft.status.in_(place_drafts.ACTIVE))
        if place_id:
            members=canonical.member_ids(session,place_id)
            query=query.where(PoiRegistrationDraft.place_id.in_(members))
        else:query=query.where(PoiRegistrationDraft.scope=='new')
        return session.scalar(query.order_by(PoiRegistrationDraft.status=='pending',PoiRegistrationDraft.updated_at.desc(),PoiRegistrationDraft.id.desc()).limit(1))

    @router.get('/api/poi-explore/registration-drafts/current')
    def resume_draft(request:Request,place_id:UUID|None=None):
        actor=require_user(request)
        with database.db_session() as session:
            row=current_draft(session,actor,place_id)
            return response(dict(draft=place_drafts.describe(row) if row else None))

    @router.post('/api/poi-explore/registration-drafts')
    def create_draft(body:DraftStart,request:Request):
        actor=require_user(request)
        with database.db_session() as session:
            session.scalar(select(User.id).where(User.id==actor['id']).with_for_update())
            if not edit.permissions(session,actor)['can_edit']:raise HTTPException(403,detail='دسترسی ثبت مکان ندارید.')
            target=canonical_row(session,body.place_id) if body.place_id else None
            if body.place_id and not target:raise HTTPException(404,detail='مکان یافت نشد.')
            previous=current_draft(session,actor,target.id if target else None)
            if previous and not (body.start_new and not target and previous.status=='pending'):
                return response(place_drafts.describe(previous))
            if session.scalar(select(func.count()).select_from(PoiRegistrationDraft).where(PoiRegistrationDraft.user_id==actor['id'],PoiRegistrationDraft.status.in_(place_drafts.ACTIVE)))>=50:
                raise HTTPException(429,detail='تعداد پیش‌نویس‌های فعال بیش از حد مجاز است.')
            data=place_drafts.DraftData(submission_id=uuid4()).model_dump(mode='json');step=1;photo_id=None
            if target:
                information=detail(session,target,actor,allow_pending=True)
                if not information['can_edit']:raise HTTPException(403,detail=information.get('locked_reason') or 'ویرایش مکان در دسترس نیست.')
                values=information['values'];photo_url=information['photo_url']
                photo_id=UUID(photo_url.rsplit('/',1)[-1]) if photo_url else None
                data.update(category=values['category'],province=information['attributes'].get('province') or information['province'],
                    latitude=values['latitude'],longitude=values['longitude'],values={k:values.get(k) or '' for k in ('name','address','phoneNumber','website')},
                    attributes=information['attributes'],base_version=information['version'],source_version=information['source_version'],photo_id=str(photo_id) if photo_id else None)
                step=4
            row=PoiRegistrationDraft(id=uuid4(),user_id=actor['id'],scope=str(target.id) if target else 'new',place_id=target.id if target else None,
                status='draft',step=step,version=0,data=data,photo_id=photo_id)
            session.add(row);session.flush();return response(place_drafts.describe(row),201)

    @router.get('/api/poi-explore/registration-drafts/{identity}')
    def get_draft(identity:UUID,request:Request):
        with database.db_session() as session:return response(place_drafts.describe(place_drafts.owned(session,identity,require_user(request))))

    @router.put('/api/poi-explore/registration-drafts/{identity}')
    def save_draft(identity:UUID,body:place_drafts.DraftSave,request:Request):
        actor=require_user(request)
        with database.db_session() as session:
            state=session.scalar(select(PoiRegistrationDraft.status).where(PoiRegistrationDraft.id==identity,PoiRegistrationDraft.user_id==actor['id']))
            if state=='pending':canonical.identity_lock(session)
            session.scalar(select(User.id).where(User.id==actor['id']).with_for_update())
            row=place_drafts.owned(session,identity,actor,body.version)
            place_drafts.save(session,row,body,actor);return response(place_drafts.describe(row))

    @router.delete('/api/poi-explore/registration-drafts/{identity}')
    def cancel_draft(identity:UUID,body:place_drafts.DraftVersion,request:Request):
        actor=require_user(request)
        with database.db_session() as session:
            canonical.identity_lock(session)
            session.scalar(select(User.id).where(User.id==actor['id']).with_for_update())
            row=place_drafts.owned(session,identity,actor,body.version)
            if row.status=='approved':raise HTTPException(409,detail='این درخواست تأیید شده است و امکان لغو ندارد.')
            place_drafts.withdraw(session,row,'درخواست توسط ثبت‌کننده لغو شد.')
            row.status='cancelled';row.data={};row.photo_id=None;row.version+=1;row.updated_at=datetime.now(timezone.utc)
            return response(place_drafts.describe(row))

    @router.get('/api/poi-explore/venue-match/{identity}')
    def legacy_match(identity:str,request:Request):
        require_user(request)
        raise HTTPException(409,detail='روش تطبیق مکان تغییر کرده است؛ صفحه را دوباره بارگذاری کنید.')

    @router.post('/api/poi-explore/venue-match')
    def match(body:PlaceMatch,request:Request):
        actor=require_user(request);published_category(body.category)
        with database.db_session() as session:
            try:results=matching.match_points(session,body.category,[body],assign_province)
            except matching.TooManyCandidates:raise HTTPException(409,detail='تعداد رکوردهای نزدیک بیش از حد مجاز است؛ تطبیق یکتا ممکن نیست.') from None
            matches=results[0][1]
            if len(matches)>1:raise HTTPException(409,detail='چند مکان با همین نوع، موقعیت، استان و نام ثبت شده است؛ تطبیق یکتا ممکن نیست.')
            if not matches:raise HTTPException(404,detail='مکانی با نوع، موقعیت در فاصلهٔ ۲۰ متر، استان و نام یکسان در پایگاه داده پیدا نشد.')
            row=canonical_row(session,matches[0].place_id)
            if not row:raise HTTPException(404,detail='مکان یافت نشد.')
            return response(detail(session,row,actor))

    @router.get('/api/poi-explore/editor/eligibility')
    def point_eligibility(request:Request,category:str,latitude:float=Query(ge=24,le=41),longitude:float=Query(ge=43,le=64)):
        actor=require_user(request)
        with database.db_session() as session:
            permission=edit.permissions(session,actor);assignment=assign_province(latitude,longitude)
            try:
                venue_schema.require_editable_category(session,category)
                if not assignment['province_name']:raise HTTPException(409,detail='نقطه داخل مرز استان‌های ایران نیست.')
                edit.require_region(permission,edit.eligibility_for_provinces(session,[assignment['province_name']]),assignment['province_name'],category)
                return response(dict(eligible=True,province=assignment['province_name']))
            except HTTPException as error:return response(dict(eligible=False,province=assignment['province_name'],reason=error.detail))

    @router.get('/api/poi-explore/venues/{place_id}')
    def venue(place_id:UUID,request:Request,draft:bool=False):
        actor=require_user(request)
        with database.db_session() as session:
            row=canonical_row(session,place_id)
            if not row:raise HTTPException(404,detail='مکان یافت نشد.')
            return response(detail(session,row,actor,draft))

    @router.post('/api/poi-explore/overlays')
    def overlays(body:Overlay,request:Request):
        require_user(request);published_category(body.category)
        if body.south>body.north or body.west>body.east or any(not re.fullmatch('[a-f0-9]{64}',v) for v in body.identities) or any(not re.fullmatch('[a-f0-9]{8}',v) for v in body.prefixes):
            raise HTTPException(422,detail='محدوده یا شناسه معتبر نیست.')
        with database.db_session() as session:
            references=[point.reference for point in body.live_places]
            if len(references)!=len(set(references)):raise HTTPException(422,detail='ارجاع مکان تکراری است.')
            suppressed_refs=[];ambiguous_refs=[];matching_overflow=False
            if body.live_places:
                try:
                    published=matching.match_points(session,body.category,body.live_places,assign_province,published_only=True)
                    relevant=[point for point,hits in published if hits]
                    for point,hits in matching.match_points(session,body.category,relevant,assign_province):
                        if len(hits)>1:ambiguous_refs.append(point.reference)
                        elif hits and hits[0].published:suppressed_refs.append(point.reference)
                except matching.TooManyCandidates:matching_overflow=True
            if not body.include_places:return response(dict(places=[],suppressed=[],suppressed_refs=suppressed_refs,ambiguous_refs=ambiguous_refs,has_more=matching_overflow))
            dy=body.radius/110000
            dx=body.radius/(110000*math.cos(math.radians(min(89,abs(body.latitude)+dy))))
            rows=session.execute(select(PoiPlace,PoiEditorial).join(PoiEditorial,PoiEditorial.place_id==PoiPlace.id)
                .outerjoin(PoiPlaceCategory,PoiPlaceCategory.place_id==PoiPlace.id).where(
                canonical.canonical_predicate(),PoiEditorial.published_version>0,edit.category_expression()==body.category,
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
            return response(dict(places=places[:500],suppressed=[],suppressed_refs=suppressed_refs,ambiguous_refs=ambiguous_refs,has_more=matching_overflow or len(places)>500 or len(rows)>1000))

    @router.get('/api/poi-explore/editor/places')
    def editable_places(request:Request,category:str,south:float=Query(ge=24,le=41),north:float=Query(ge=24,le=41),
                        west:float=Query(ge=43,le=64),east:float=Query(ge=43,le=64),province:str|None=Query(default=None,max_length=120)):
        actor=require_user(request)
        if south>north or west>east:raise HTTPException(422,detail='محدوده معتبر نیست.')
        with database.db_session() as session:
            permission=edit.permissions(session,actor)
            if not permission['can_edit']:raise HTTPException(403,detail='دسترسی ویرایش ندارید.')
            venue_schema.require_editable_category(session,category)
            if province:edit.require_region(permission,edit.eligibility_for_provinces(session,[province]),province,category)
            lat=edit.coordinate_expression('latitude');lon=edit.coordinate_expression('longitude')
            rows=session.execute(select(PoiPlace,PoiEditorial).outerjoin(PoiEditorial,PoiEditorial.place_id==PoiPlace.id)
                .outerjoin(PoiPlaceCategory,PoiPlaceCategory.place_id==PoiPlace.id).where(
                    canonical.canonical_predicate(),edit.category_expression()==category,
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
            canonical.identity_lock(session)
            if place_id:place_id=canonical.canonical_id(session,place_id)
            session.scalar(select(User.id).where(User.id==actor['id']).with_for_update())
            previous=session.scalar(select(PoiEditRevision).where(PoiEditRevision.submission_id==body.submission_id))
            if previous:
                if previous.actor_id!=actor['id'] or (place_id and canonical.canonical_id(session,previous.place_id)!=place_id):raise HTTPException(409,detail='شناسه ارسال تکراری است.')
                result=dict(id=str(previous.place_id),revision_id=str(previous.id),version=previous.version,status=previous.status)
                if body.draft_id:
                    draft=place_drafts.owned(session,body.draft_id,actor)
                    if draft.revision_id!=previous.id:raise HTTPException(409,detail='این ارسال مربوط به نسخهٔ فعلی پیش‌نویس نیست.')
                    result['draft']=place_drafts.describe(draft)
                return result
            draft=None
            if body.draft_id:
                if body.draft_version is None:raise HTTPException(422,detail='نسخهٔ پیش‌نویس الزامی است.')
                draft=place_drafts.owned(session,body.draft_id,actor,body.draft_version)
                if draft.status not in ('draft','rejected'):raise HTTPException(409,detail='برای ارسال دوباره، ابتدا پیش‌نویس را ویرایش کنید.')
                if (canonical.canonical_id(session,draft.place_id) if draft.place_id else None)!=place_id:
                    raise HTTPException(409,detail='پیش‌نویس متعلق به این مکان نیست.')
            permission=edit.permissions(session,actor);coverage=edit.eligibility(session)
            venue_schema.require_editable_category(session,body.values.category)
            assignment=assign_province(body.values.latitude,body.values.longitude)
            if not assignment['province_name']:raise HTTPException(422,detail='نقطه باید داخل مرز استان‌های ایران باشد.')
            edit.require_region(permission,coverage,assignment['province_name'],body.values.category)
            if place_id:
                lock_editorial(session,place_id)
                row=session.get(PoiPlace,place_id)
                if not row or (not row.resolved_at and row.provider!='manual'):raise HTTPException(409,detail='ثبت جزئیات این مکان کامل نشده است.')
                if not accessible_place(actor,permission,row,session.get(PoiEditorial,row.id)):raise HTTPException(404,detail='مکان یافت نشد.')
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
                # Production sessions use autoflush=False. Persist the parent
                # explicitly before inserting a revision that references it.
                # This remains part of the same transaction and rolls back if
                # validation, revision insertion, or notification setup fails.
                session.flush()
            if editorial.version!=body.version:raise HTTPException(409,detail='نسخهٔ جدیدتری ثبت شده است؛ اطلاعات مکان را دوباره باز کنید.')
            if editorial.province_name:edit.require_region(permission,coverage,edit.effective_province(row,editorial),edit.effective(baseline,editorial.published)['category'])
            current=editorial.published or {}
            # Keep previously recorded, now retired fields out of the form without
            # deleting their values when an editor changes the current fields.
            supplied={**current.get('attributes',{}),**venue_schema.prepare_administration(body.attributes,assignment['province_name'])}
            catalogue=edit.definitions(session)
            private=scoped(permission,row,editorial,staff=True) and edit.in_staff_scope(permission,assignment['province_name'])
            if not private and any(not field.public and field.key in body.attributes for field in catalogue):
                raise HTTPException(403,detail='دسترسی تغییر ویژگی‌های خصوصی این مکان را ندارید.')
            attributes=edit.validate_attributes(catalogue,body.values.category,supplied,current.get('attributes'))
            attributes=venue_schema.attribute_overrides(attributes,venue_schema.source_administration(row,assignment['province_name']))
            values={**edit.effective(baseline,current),**body.values.model_dump(exclude_unset=True)}
            payload=edit.make_payload(baseline,values,attributes)
            revision_id=uuid4()
            attached_photo=None
            if body.photo_id and body.remove_photo:raise HTTPException(422,detail='حذف و افزودن عکس هم‌زمان مجاز نیست.')
            if body.photo_id:
                attached_photo=place_photos.claim(session,body.photo_id,actor,row.id)
                payload['photo_path']=attached_photo.path
            elif not body.remove_photo and current.get('photo_path'):payload['photo_path']=current['photo_path']
            if place_id and payload==dict(overrides=current.get('overrides',{}),attributes=current.get('attributes',{}),**({'photo_path':current['photo_path']} if current.get('photo_path') else {})):
                raise HTTPException(409,detail='تغییری برای ثبت وجود ندارد.')
            if editorial.version:
                latest=session.scalar(select(PoiEditRevision).where(PoiEditRevision.place_id==row.id).order_by(PoiEditRevision.version.desc()).limit(1))
                if latest and latest.status=='pending' and latest.base_published_version==editorial.published_version and latest.payload==payload:
                    raise HTTPException(409,detail='همین تغییر قبلاً برای بررسی ارسال شده است.')
            editorial.version+=1;editorial.updated_by=actor['id'];editorial.updated_at=datetime.now(timezone.utc)
            revision=PoiEditRevision(id=revision_id,place_id=row.id,submission_id=body.submission_id,version=editorial.version,
                base_published_version=editorial.published_version,actor_id=actor['id'],actor_name=actor_name(actor),action='added' if row.provider=='manual' and not editorial.published_version else 'edited',
                status='pending',payload=payload,source_snapshot=dict(values=baseline,previous=edit.effective(baseline,current),photo_path=current.get('photo_path'),raw_details=row.raw_details or {}),reason=body.reason.strip())
            session.add(revision)
            session.flush()
            if attached_photo and not attached_photo.revision_id:attached_photo.place_id=row.id;attached_photo.revision_id=revision.id
            place_notifications.enqueue(session,revision,'submitted')
            result=dict(id=str(row.id),revision_id=str(revision.id),version=editorial.version,status='pending')
            if draft:
                place_drafts.attach(draft,revision,edit.fingerprint(baseline));result['draft']=place_drafts.describe(draft)
            return result

    @router.post('/api/poi-explore/manual-places')
    def create(body:Submission,request:Request,background_tasks:BackgroundTasks):
        result=submit(body,require_user(request));background_tasks.add_task(place_notifications.dispatch_pending);return response(result,201)

    @router.patch('/api/poi-explore/manual-places/{place_id}')
    def change(place_id:UUID,body:Submission,request:Request,background_tasks:BackgroundTasks):
        result=submit(body,require_user(request),place_id);background_tasks.add_task(place_notifications.dispatch_pending);return response(result)

    @router.get('/api/poi-explore/venues/{place_id}/history')
    def history(place_id:UUID,request:Request,page:int=Query(default=0,ge=0,le=10000)):
        actor=require_user(request)
        with database.db_session() as session:
            row=canonical_row(session,place_id)
            permission=edit.permissions(session,actor);editorial=session.get(PoiEditorial,row.id) if row else None
            if not row or not scoped(permission,row,editorial) or not accessible_place(actor,permission,row,editorial):raise HTTPException(403,detail='دسترسی به سابقه ندارید.')
            members=canonical.member_ids(session,row.id)
            rows=session.scalars(select(PoiEditRevision).where(PoiEditRevision.place_id.in_(members),
                or_(PoiEditRevision.status=='approved',PoiEditRevision.actor_id==actor['id'],reviewable(permission,row,editorial)))
                .order_by(PoiEditRevision.created_at.desc(),PoiEditRevision.id.desc()).offset(page*50).limit(51)).all()
            snapshots=session.scalars(select(PoiSourceRevision).where(PoiSourceRevision.place_id.in_(members))
                .order_by(PoiSourceRevision.observed_at.desc()).offset(page*20).limit(21)).all()
            source_history=[]
            for snapshot in snapshots[:20]:
                raw=snapshot.details;location=raw.get('location') or {};layer=raw.get('layer') or {}
                source_history.append(dict(observed_at=iso(snapshot.observed_at),values={
                    **{key:raw.get(key) for key in ('name','address','phoneNumber','website','workHours','socialNetworks')},
                    'latitude':location.get('latitude',location.get('y')),'longitude':location.get('longitude',location.get('x')),
                    'category':layer.get('slug') if isinstance(layer,dict) else None}))
            revisions=[];catalogue=edit.definitions(session);private=scoped(permission,row,editorial,staff=True)
            for revision in rows[:50]:
                item=revision_dict(revision)
                if not private:item['attributes']=edit.public_attributes(catalogue,revision.payload)
                revisions.append(item)
            return response(dict(revisions=revisions,source_history=source_history,has_more=len(rows)>50 or len(snapshots)>20))

    @router.post('/api/poi-explore/venues/{place_id}/restore')
    def restore(place_id:UUID,body:Restore,request:Request,background_tasks:BackgroundTasks):
        actor=require_user(request)
        with database.db_session() as session:
            row=canonical_row(session,place_id);revision=session.get(PoiEditRevision,body.revision_id)
            permission=edit.permissions(session,actor);editorial=session.get(PoiEditorial,row.id) if row else None
            if not row or not revision or canonical.canonical_id(session,revision.place_id)!=row.id or not scoped(permission,row,editorial) or not accessible_place(actor,permission,row,editorial) or not (
                    revision.status=='approved' or revision.actor_id==actor['id'] or reviewable(permission,row,editorial)):
                raise HTTPException(403,detail='این سابقه قابل بازیابی نیست.')
            baseline=source(session,row)
            # A retired alias can have a different source baseline; restore its
            # historical effective values rather than rebasing old overrides.
            values=edit.effective(revision.source_snapshot['values'],revision.payload)
            for key in ('workHours','socialNetworks'):
                if key not in revision.payload.get('overrides',{}):values.pop(key,None)
            attributes=revision.payload.get('attributes',{}) if scoped(permission,row,editorial,staff=True) else edit.public_attributes(edit.definitions(session),revision.payload)
            submission=Submission(submission_id=body.submission_id,version=body.version,source_version=edit.fingerprint(baseline),
                values=values,attributes=attributes,reason=body.reason,
                photo_id=UUID(revision.payload['photo_path'][len(place_photos.PREFIX):-5]) if place_photos.managed_file(revision.payload.get('photo_path')) else None,
                remove_photo=not revision.payload.get('photo_path'))
            target_place_id=row.id
        result=submit(submission,actor,target_place_id);background_tasks.add_task(place_notifications.dispatch_pending);return response(result)

    @router.get('/api/poi-explore/editor/revisions')
    def pending(request:Request):
        actor=require_user(request)
        with database.db_session() as session:
            permission=edit.permissions(session,actor)
            if not permission['can_review']:raise HTTPException(403,detail='دسترسی بررسی ندارید.')
            target=func.coalesce(PoiPlaceLink.canonical_id,PoiRetiredPlace.canonical_id,PoiEditRevision.place_id)
            rows=session.execute(select(PoiEditRevision,PoiPlace).select_from(PoiEditRevision)
                .outerjoin(PoiPlaceLink,PoiPlaceLink.source_id==PoiEditRevision.place_id)
                .outerjoin(PoiRetiredPlace,PoiRetiredPlace.source_id==PoiEditRevision.place_id).join(PoiPlace,PoiPlace.id==target)
                .where(PoiEditRevision.status=='pending').order_by(PoiEditRevision.created_at).limit(200)).all()
            return response(dict(revisions=[{**revision_dict(r),'name':p.name,
                'canonical_place_id':str(p.id),'is_consolidated_alias':p.id!=r.place_id}
                for r,p in rows if reviewable(permission,p,session.get(PoiEditorial,p.id))]))

    @router.post('/api/poi-explore/editor/revisions/{revision_id}/review')
    def review(revision_id:UUID,body:Review,request:Request,background_tasks:BackgroundTasks):
        actor=require_user(request)
        with database.db_session() as session:
            canonical.identity_lock(session)
            revision=session.get(PoiEditRevision,revision_id)
            if not revision:raise HTTPException(404,detail='تغییر یافت نشد.')
            editorial=lock_editorial(session,revision.place_id);row=canonical_row(session,revision.place_id)
            session.refresh(revision)
            permission=edit.permissions(session,actor)
            permission_editorial=session.get(PoiEditorial,row.id) if row else None
            if not row or not reviewable(permission,row,permission_editorial):raise HTTPException(403,detail='دسترسی بررسی ندارید.')
            if revision.actor_id==actor['id'] and not actor.get('is_admin'):raise HTTPException(403,detail='تغییر خود را به بررسی‌کنندهٔ دیگری بسپارید.')
            if revision.status!='pending':return response(dict(status=revision.status))
            root=canonical.canonical_id(session,revision.place_id)
            if body.approve and root!=revision.place_id:
                raise HTTPException(409,detail='این پیشنهاد متعلق به رکوردی است که یکپارچه شده است؛ اطلاعات را از صفحهٔ مکان اصلی دوباره ثبت کنید.')
            if not body.approve and not body.note.strip():raise HTTPException(422,detail='دلیل رد تغییر را بنویسید.')
            if body.approve:
                if revision.base_published_version!=editorial.published_version:raise HTTPException(409,detail='نسخهٔ منتشرشده تغییر کرده است؛ این پیشنهاد نیاز به بازبینی دارد.')
                baseline=source(session,row);edit.observe_source(session,row);values=edit.effective(baseline,revision.payload)
                if edit.fingerprint(baseline)!=edit.fingerprint(revision.source_snapshot['values']):
                    raise HTTPException(409,detail='دادهٔ منبع پس از ثبت پیشنهاد تغییر کرده است؛ اطلاعات مکان را بازبینی و پیشنهاد را دوباره ثبت کنید.')
                venue_schema.require_editable_category(session,baseline['category'])
                venue_schema.require_editable_category(session,values['category'])
                assignment=assign_province(values['latitude'],values['longitude']);coverage=edit.eligibility(session)
                edit.require_region(permission,coverage,row.province_name,baseline['category'],review=True)
                edit.require_region(permission,coverage,assignment['province_name'],values['category'],review=True);published_category(values['category'])
                if row.provider=='manual':prevent_duplicate_addition(session,values,assignment['province_name'],row.id)
                verified=venue_schema.prepare_administration({**venue_schema.source_administration(row,assignment['province_name']),**revision.payload.get('attributes',{})},assignment['province_name'],
                    validate_county=any(field.active and field.key=='county' for field in edit.definitions(session)))
                edit.validate_attributes(edit.definitions(session),values['category'],verified,revision.payload.get('attributes',{}))
                editorial.published=revision.payload;editorial.published_version=revision.version;editorial.name=values['name'];editorial.category=values['category']
                editorial.latitude=values['latitude'];editorial.longitude=values['longitude'];editorial.province_name=assignment['province_name'];editorial.published_by=actor['id']
                if row.provider=='manual' and not row.resolved_at:row.resolved_at=datetime.now(timezone.utc)
                members=canonical.member_ids(session,row.id)
                awarded=session.scalar(select(PoiContributionAward.id).where(PoiContributionAward.user_id==revision.actor_id,
                    PoiContributionAward.place_id.in_(members),PoiContributionAward.action==revision.action,PoiContributionAward.revoked.is_(False)).limit(1)) if revision.actor_id else None
                if revision.actor_id and not awarded:
                    session.execute(insert(PoiContributionAward).values(id=uuid4(),user_id=revision.actor_id,place_id=row.id,revision_id=revision.id,
                        action=revision.action,points=10 if revision.action=='added' else 3,revoked=False).on_conflict_do_nothing(constraint='uq_poi_contribution_once'))
            revision.status='approved' if body.approve else 'rejected';revision.reviewer_id=actor['id'];revision.reviewer_name=actor_name(actor);revision.review_note=body.note;revision.reviewed_at=datetime.now(timezone.utc)
            place_drafts.reviewed(session,revision)
            if body.approve:place_notifications.enqueue(session,revision,'approved')
            result=dict(status=revision.status)
        background_tasks.add_task(place_notifications.dispatch_pending)
        return response(result)

    @router.get('/api/account/contributions')
    def contributions(request:Request,page:int=Query(default=0,ge=0,le=10000)):
        actor=require_user(request)
        with database.db_session() as session:
            summary=dict(session.execute(select(PoiEditRevision.status,func.count()).where(PoiEditRevision.actor_id==actor['id']).group_by(PoiEditRevision.status)).all())
            award_target=func.coalesce(PoiPlaceLink.canonical_id,PoiRetiredPlace.canonical_id,PoiContributionAward.place_id)
            awards=select(award_target.label('place'),
                PoiContributionAward.action,func.max(PoiContributionAward.points).label('points')).outerjoin(PoiPlaceLink,
                    PoiPlaceLink.source_id==PoiContributionAward.place_id).outerjoin(PoiRetiredPlace,
                        PoiRetiredPlace.source_id==PoiContributionAward.place_id).where(PoiContributionAward.user_id==actor['id'],
                        PoiContributionAward.revoked.is_(False)).group_by(award_target,PoiContributionAward.action).subquery()
            points=session.scalar(select(func.coalesce(func.sum(awards.c.points),0)))
            permission=edit.permissions(session,actor)
            coverage=edit.eligibility(session) if permission['can_edit'] else None
            enabled=venue_schema.editable_categories(session) if permission['can_edit'] else set()
            target=func.coalesce(PoiPlaceLink.canonical_id,PoiRetiredPlace.canonical_id,PoiEditRevision.place_id)
            rows=session.execute(select(PoiEditRevision,PoiPlace,PoiEditorial).select_from(PoiEditRevision)
                .outerjoin(PoiPlaceLink,PoiPlaceLink.source_id==PoiEditRevision.place_id)
                .outerjoin(PoiRetiredPlace,PoiRetiredPlace.source_id==PoiEditRevision.place_id).join(PoiPlace,PoiPlace.id==target)
                .outerjoin(PoiEditorial,PoiEditorial.place_id==PoiPlace.id).where(PoiEditRevision.actor_id==actor['id'])
                .order_by(PoiEditRevision.created_at.desc(),PoiEditRevision.id.desc()).offset(page*20).limit(21)).all()
            roots={row.id:canonical.canonical_id(session,row.id) for revision,row,editorial in rows[:20]}
            writable={}
            for revision,row,editorial in rows[:20]:
                row=session.get(PoiPlace,roots[row.id]);editorial=session.get(PoiEditorial,row.id)
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
            return response(dict(points=points,summary=summary,page=page,has_more=len(rows)>20,contributions=[dict(id=str(r.id),place_id=str(roots[p.id]),
                name=edit.effective(r.source_snapshot['values'],r.payload)['name'],action=r.action,status=r.status,created_at=iso(r.created_at),review_note=r.review_note,
                can_reedit=writable[roots[p.id]]) for r,p,e in rows[:20]],
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

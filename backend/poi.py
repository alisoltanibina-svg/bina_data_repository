"""Transactional acquisition state. Only the standalone worker dispatches requests."""
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path
import random
from uuid import uuid4
from sqlalchemy import select, func, update
from sqlalchemy.dialects.postgresql import insert
from backend import database
from backend.poi_models import (PoiControl, PoiBoundary, PoiCategory, PoiJob, PoiSegment,
    PoiPlace, PoiPlaceCategory, PoiDetailTask, PoiRequest, PoiDuplicateReview)
from backend.poi_geo import BoundaryIndex, grid, load_boundaries, normalize, parse_address
from backend.poi_provider import nearby_items, details, access_error_message

LOCK_KEY = 741923816
ACTIVE = ('pending', 'running')
TERMINAL = ('complete', 'failed', 'uncertain')


def now(): return datetime.now(timezone.utc)


def control(session):
    session.execute(insert(PoiControl).values(id=1).on_conflict_do_nothing())
    return session.scalar(select(PoiControl).where(PoiControl.id == 1).with_for_update())


def create_job(session, categories, radius_m=2000, mode='initial', refresh_before=None, county_path=None):
    c = control(session)
    if session.scalar(select(PoiJob.id).where(PoiJob.status.in_(ACTIVE))):
        raise ValueError('An existing collection job must finish before creating another')
    if mode not in {'initial','refresh'} or (mode == 'refresh' and not refresh_before):
        raise ValueError('Refresh requires an explicit refresh_before timestamp')
    if refresh_before and (refresh_before.tzinfo is None or refresh_before > now()):
        raise ValueError('refresh_before must be a past timezone-aware timestamp')
    if not 500 <= radius_m <= 5000: raise ValueError('radius_m must be between 500 and 5000')
    from backend.poi_provider import LAYERS
    if not categories or len(categories) > 60 or not set(categories) <= LAYERS:
        raise ValueError('Unknown or empty Nearby category selection')
    version, boundaries = load_boundaries(Path(__file__).resolve().parent.parent / 'data/iran.geojson', county_path)
    for row in boundaries:
        session.execute(insert(PoiBoundary).values(version=version, **row).on_conflict_do_nothing())
    for category in set(categories):
        session.execute(insert(PoiCategory).values(slug=category, title=category).on_conflict_do_nothing())
    job = PoiJob(id=uuid4(), categories=sorted(set(categories)), radius_m=radius_m, mode=mode,
                 refresh_before=refresh_before, boundary_version=version)
    session.add(job)
    # New work starts paused. A job creation is never an implicit network action.
    c.paused, c.reason = True, 'New job ready; resume to begin'
    session.flush()
    return job


def set_paused(session, paused):
    c = control(session)
    c.paused = paused
    c.reason = 'Paused by administrator' if paused else ''
    return {'paused': paused, 'state': 'pausing' if paused and c.in_flight else 'paused' if paused else 'waiting'}


@lru_cache(maxsize=4)
def boundary_index(version):
    with database.db_session() as session:
        rows = session.scalars(select(PoiBoundary).where(PoiBoundary.version == version)).all()
        return BoundaryIndex(rows)


def plan_province(session, job):
    provinces = session.scalars(select(PoiBoundary).where(PoiBoundary.version == job.boundary_version,
                               PoiBoundary.level == 'province').order_by(PoiBoundary.code)).all()
    if job.planned_provinces >= len(provinces): return False
    order = job.planned_provinces
    province = provinces[order]
    batch = []
    for lat, lon in grid(province.geometry, job.radius_m):
        for category in job.categories:
            batch.append(dict(job_id=job.id, province_order=order, province_name=province.name,
                              latitude=lat, longitude=lon, radius_m=job.radius_m, category=category))
        if len(batch) >= 1000:
            session.execute(insert(PoiSegment), batch)
            batch.clear()
    if batch: session.execute(insert(PoiSegment), batch)
    # Plan a province atomically; rollback leaves no partial coverage after a crash.
    job.planned_provinces += 1
    return True


def next_target(session, job):
    segment = session.scalar(select(PoiSegment).where(PoiSegment.job_id == job.id,
        PoiSegment.status == 'pending').order_by(PoiSegment.province_order, PoiSegment.id).limit(1))
    if segment:
        return 'nearby', segment, {'location': f'{segment.latitude},{segment.longitude}',
                                  'layer': segment.category, 'searchRadius': segment.radius_m}
    return None


def discover(session, job, segment, items):
    """Return an in-memory handoff, never write Nearby places or identifiers to disk."""
    hashes, seen = [], set()
    for item in items:
        provider_id = item.get('poiHash')
        if not provider_id:
            job.missing_hashes += 1
            segment.review_reason = 'Some results have no usable poiHash'
            continue
        if provider_id in seen:
            job.duplicates_skipped += 1
            continue
        seen.add(provider_id)
        place = session.scalar(select(PoiPlace).where(PoiPlace.provider == job.provider,
                                                     PoiPlace.provider_id == provider_id))
        if place and place.resolved_at and (job.mode == 'initial' or place.resolved_at >= job.refresh_before):
            job.duplicates_skipped += 1
        else:
            hashes.append(provider_id)
    return hashes


def save_details(session, job, provider_id, body, stamp):
    lat, lon = details(body)
    session.execute(insert(PoiPlace).values(id=uuid4(), provider=job.provider, provider_id=provider_id,
        name=body['name'], normalized_name=normalize(body['name']), latitude=lat, longitude=lon)
        .on_conflict_do_nothing(index_elements=['provider','provider_id']))
    place = session.scalar(select(PoiPlace).where(PoiPlace.provider==job.provider, PoiPlace.provider_id==provider_id))
    for key, value in {**parse_address(body), **boundary_index(job.boundary_version).assign(lat,lon)}.items():
        setattr(place, key, value)
    place.name, place.normalized_name = body['name'], normalize(body['name'])
    place.latitude, place.longitude = lat, lon
    place.raw_details, place.resolved_at, place.boundary_version = body, stamp, job.boundary_version
    layer = body.get('layer')
    if isinstance(layer, dict) and isinstance(layer.get('slug'), str) and 0 < len(layer['slug']) <= 100:
        slug = layer['slug']
        title = layer.get('title') if isinstance(layer.get('title'), str) else slug
        session.execute(insert(PoiCategory).values(slug=slug, title=title).on_conflict_do_nothing())
        session.execute(insert(PoiPlaceCategory).values(place_id=place.id, category=slug).on_conflict_do_nothing())
    # Review candidates only; never automatically merge independent provider identities.
    peers = session.scalars(select(PoiPlace).where(PoiPlace.id != place.id,
        PoiPlace.normalized_name == place.normalized_name,
        PoiPlace.latitude.between(lat-.0005, lat+.0005),
        PoiPlace.longitude.between(lon-.0006, lon+.0006))).all()
    for other in peers:
        a, b = sorted([place.id, other.id])
        session.execute(insert(PoiDuplicateReview).values(place_id=a, other_place_id=b,
            reason='Same normalized name within approximately 80 metres').on_conflict_do_nothing())


def apply_reply(session, request_id, reply, result_cap=0, detail_hash=None, detail_attempts=0):
    c = control(session)
    req = session.get(PoiRequest, request_id)
    job = session.get(PoiJob, req.job_id)
    target = session.get(PoiSegment if req.target_type == 'segment' else PoiDetailTask, req.target_id)
    stamp = now()
    req.http_status, req.finished_at = reply.status, stamp
    req.raw_response = reply.body if req.kind == 'details' and isinstance(reply.body,(dict,list)) else None
    handoff = []
    attempts = detail_attempts if req.kind == 'details' else target.attempts
    retry_status = 'processing' if req.kind == 'details' else 'pending'
    c.in_flight = None
    delay = random.uniform(30,60)
    req.error = reply.error or None
    if reply.status == 200:
        try:
            # Validate before writes so a malformed batch cannot be half-applied.
            if req.kind == 'nearby': nearby_items(reply.body)
            else: details(reply.body)
        except (ValueError, TypeError, KeyError, OverflowError):
            req.outcome, req.error, target.status = 'uncertain', 'unexpected_provider_schema', 'uncertain'
            c.paused, c.reason = True, 'Unexpected provider response; inspect request history before retrying'
        else:
            if req.kind == 'nearby':
                items = nearby_items(reply.body)
                handoff = discover(session, job, target, items)
                req.result_count = len(items)
                req.hash_count = sum(bool(item.get('poiHash')) for item in items)
                req.queued_count = len(handoff)
                target.pending_details = len(handoff)
                if not handoff:
                    c.paused, c.reason = True, 'Nearby produced no new usable hashes; review area/category with Neshan before continuing'
                if result_cap and len(items) >= result_cap:
                    target.review_reason = 'Provider result cap reached; repeat with smaller search radius'
            else:
                if not detail_hash: raise RuntimeError('Details response has no in-memory request identity')
                save_details(session, job, detail_hash, reply.body, stamp)
                target.pending_details = max(0, target.pending_details - 1)
            req.outcome = 'successful'
            target.status = 'processing' if target.pending_details else 'complete'
    elif reply.status in {401,402,403,480,481,483,484,485}:
        req.outcome, target.status = 'failed', retry_status
        c.paused, c.reason = True, access_error_message(req.kind, reply.status)
    elif reply.status in {429,482}:
        req.outcome, target.status = 'failed', retry_status
        delay = max(delay, reply.retry_after, min(3600, 60 * 2 ** min(attempts, 6)))
    elif reply.status is None:
        req.outcome, target.status = 'uncertain', 'uncertain'
        c.paused, c.reason = True, 'Transport outcome unknown; review before explicitly retrying'
    elif reply.status >= 500 and attempts < 5:
        req.outcome, target.status = 'failed', retry_status
        delay = max(delay, reply.retry_after, min(3600, 60 * 2 ** attempts))
    else:
        req.outcome, target.status = 'failed', 'failed'
        c.paused, c.reason = True, f'Request failed (HTTP {reply.status}); inspect history'
    if reply.retry_after:
        delay = max(delay, min(reply.retry_after, 31536000))
    # No pause/resume action can shorten this provider-wide deadline.
    c.next_request_at = stamp + timedelta(seconds=delay)
    return handoff


def retry_unresolved(session, job_id):
    c = control(session)
    job = session.get(PoiJob, job_id)
    if not job: raise ValueError('Job not found')
    if c.in_flight: raise ValueError('Wait until the in-flight request finishes')
    if session.scalar(select(PoiJob.id).where(PoiJob.status.in_(ACTIVE), PoiJob.id != job.id)):
        raise ValueError('Another job is active')
    for model in (PoiSegment, PoiDetailTask):
        session.execute(update(model).where(model.job_id == job.id, model.status.in_(['failed','uncertain']))
                        .values(status='pending', attempts=0))
    job.status = 'running'
    c.paused, c.reason = True, 'Unresolved work requeued; resume when ready'


def storage_cleanup_required(session):
    return bool(session.scalar(select(PoiRequest.id).where(PoiRequest.kind=='nearby',
        PoiRequest.raw_response.is_not(None)).limit(1)) or
        session.scalar(select(PoiPlace.id).where(PoiPlace.resolved_at.is_(None)).limit(1)) or
        session.scalar(select(PoiDetailTask.id).where(PoiDetailTask.status=='pending').limit(1)))


def collection_readiness(c, job, cleanup_required=False):
    from backend.settings import get_settings
    key_configured = bool(get_settings().neshan_service_api_key.get_secret_value().strip())
    alive = bool(c and c.heartbeat_at and (now()-c.heartbeat_at).total_seconds() < 45)
    active_job = bool(job and job.status in ACTIVE)
    authorized = get_settings().neshan_collection_authorized
    blocked = ('missing_service_key' if not key_configured else 'authorization_required' if not authorized
               else 'storage_cleanup_required' if cleanup_required else 'no_active_job' if not active_job
               else 'worker_not_running' if not alive else '')
    return dict(service_key_configured=key_configured, collection_authorized=authorized, worker_alive=alive,
                resume_blocked_reason=blocked, can_resume=bool(c and c.paused and not blocked),
                can_pause=bool(active_job and (not c or not c.paused)))


def resume_collection(session):
    c = control(session)
    job = session.scalar(select(PoiJob).where(PoiJob.status.in_(ACTIVE)).limit(1))
    readiness = collection_readiness(c, job, storage_cleanup_required(session))
    messages = {
        'authorization_required': 'ابتدا تکمیل NDA و مجوز استفادهٔ داخلی را تأیید و NESHAN_COLLECTION_AUTHORIZED را تنظیم کنید.',
        'storage_cleanup_required': 'دادهٔ قدیمی Nearby هنوز ذخیره شده است؛ پاک‌سازی بررسی‌شده باید پیش از ادامه انجام شود.',
        'missing_service_key': 'کلید سرویس نشان تنظیم نشده است. ابتدا NESHAN_SERVICE_API_KEY را روی سرور تنظیم کنید.',
        'no_active_job': 'برنامهٔ فعالی برای ادامه وجود ندارد. ابتدا یک برنامهٔ گردآوری بسازید.',
        'worker_not_running': 'پردازشگر گردآوری اجرا نشده یا ارتباط آن قطع است. ابتدا پردازشگر را اجرا کنید.',
    }
    reason = readiness['resume_blocked_reason']
    if reason: raise ValueError(messages[reason])
    return set_paused(session, False)


def status(session):
    c = session.get(PoiControl, 1)
    job = session.scalar(select(PoiJob).order_by(PoiJob.created_at.desc()).limit(1))
    readiness = collection_readiness(c, job, storage_cleanup_required(session))
    alive = readiness['worker_alive']
    state = 'interrupted'
    if c and c.paused: state = 'pausing' if c.in_flight and alive else 'paused'
    elif alive: state = 'running' if c.in_flight else 'waiting'
    if not alive and not readiness['service_key_configured']: state = 'not_configured'
    elif not alive and (not job or job.status not in ACTIVE): state = 'idle'
    output = dict(**readiness, state=state, paused=c.paused if c else True, reason=c.reason if c else 'No worker or job yet',
        heartbeat_at=c.heartbeat_at if c else None,
        next_request_at=c.next_request_at if c else None, in_flight=c.in_flight if c else None,
        coverage_label='Completed searches do not establish completeness of real-world POIs',
        completeness_verified=False, job=None)
    if job:
        counts = session.execute(select(PoiRequest.kind, PoiRequest.outcome, func.count()).where(
            PoiRequest.job_id == job.id).group_by(PoiRequest.kind, PoiRequest.outcome)).all()
        provinces = session.execute(select(PoiSegment.province_order, PoiSegment.province_name,
            PoiSegment.status, func.count()).where(PoiSegment.job_id == job.id).group_by(
                PoiSegment.province_order,PoiSegment.province_name,PoiSegment.status).order_by(PoiSegment.province_order)).all()
        incomplete = {o for o,p,s,n in provinces if s != 'complete'}
        incomplete.update(session.scalars(select(PoiDetailTask.province_order).where(
            PoiDetailTask.job_id==job.id,PoiDetailTask.status!='complete').distinct()).all())
        complete_provinces = len({o for o,p,s,n in provinces} - incomplete)
        output['job'] = dict(completed_provinces=complete_provinces, remaining_provinces=31-complete_provinces,
            id=str(job.id),status=job.status,mode=job.mode,radius_m=job.radius_m,
            boundary_version=job.boundary_version,planned_provinces=job.planned_provinces,total_provinces=31,
            duplicates_skipped=job.duplicates_skipped,missing_hashes=job.missing_hashes,
            requests=[dict(kind=k,outcome=o,count=n) for k,o,n in counts],
            areas=[dict(order=o,province=p,status=s,count=n) for o,p,s,n in provinces],
            details={'complete':sum(n for k,o,n in counts if k=='details' and o=='successful'),
                'pending':session.scalar(select(func.coalesce(func.sum(PoiSegment.pending_details),0)).where(
                    PoiSegment.job_id==job.id,PoiSegment.status=='processing')),
                'uncertain':session.scalar(select(func.coalesce(func.sum(PoiSegment.pending_details),0)).where(
                    PoiSegment.job_id==job.id,PoiSegment.status.in_(['uncertain','failed'])))},
            empty_searches=session.scalar(select(func.count()).select_from(PoiRequest).where(
                PoiRequest.job_id==job.id,PoiRequest.kind=='nearby',PoiRequest.result_count==0)),
            flagged_segments=session.scalar(select(func.count()).select_from(PoiSegment).where(
                PoiSegment.job_id==job.id,PoiSegment.review_reason.is_not(None))))
    output['categories'] = [dict(category=slug,unique_saved=n) for slug,n in session.execute(
        select(PoiPlaceCategory.category,func.count()).join(PoiPlace,PoiPlace.id==PoiPlaceCategory.place_id)
        .where(PoiPlace.resolved_at.is_not(None)).group_by(PoiPlaceCategory.category))]
    output['unique_saved'] = session.scalar(select(func.count()).select_from(PoiPlace).where(PoiPlace.resolved_at.is_not(None)))
    output['duplicate_reviews'] = session.scalar(select(func.count()).select_from(PoiDuplicateReview).where(PoiDuplicateReview.status=='pending'))
    return output

"""Transactional acquisition state. Only the standalone worker dispatches requests."""
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path
import random
import math
import hashlib
import re
from collections import Counter
from uuid import uuid4
from sqlalchemy import select, func, update
from sqlalchemy.dialects.postgresql import insert
from backend import database
from backend.poi_models import (PoiControl, PoiBoundary, PoiCategory, PoiJob, PoiSegment,
    PoiPlace, PoiPlaceCategory, PoiDetailTask, PoiRequest, PoiDuplicateReview, PoiSourceDataset, PoiSettlement)
from backend.poi_geo import BoundaryIndex, grid, load_boundaries, normalize, parse_address
from backend.poi_provider import nearby_items, details, access_error_message
from backend import poi_coverage_state as coverage

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


def create_pilot(session, latitude, longitude, category, radius_m=500, settlement_id=None):
    """Prepare one user-selected area; preserve the nationwide grid and request history."""
    c=control(session)
    if not c.paused or c.in_flight:
        raise ValueError('ابتدا گردآوری را متوقف کنید و تا پایان درخواست جاری صبر کنید.')
    job=session.scalar(select(PoiJob).where(PoiJob.status.in_(ACTIVE)).limit(1))
    if not job: raise ValueError('ابتدا یک برنامهٔ گردآوری در حالت توقف بسازید.')
    if coverage.plan_for(session,job):raise ValueError('برنامهٔ چندضلعی از مراکز تأییدشدهٔ خودش استفاده می‌کند؛ بررسی تک‌نقطه‌ای برای این برنامه لازم نیست.')
    if session.scalar(select(PoiSegment.id).where(PoiSegment.job_id==job.id,
            PoiSegment.status=='processing',PoiSegment.pending_details>0).limit(1)):
        raise ValueError('هش‌های یک ناحیه هنوز در حافظهٔ پردازشگر منتظر POI هستند؛ ابتدا همان ناحیه را تعیین تکلیف کنید.')
    settlement=None
    if job.search_dataset_version:
        settlement=session.get(PoiSettlement,settlement_id) if settlement_id else None
        if not settlement or settlement.version!=job.search_dataset_version or settlement.state!='ready':
            raise ValueError('یک نقطهٔ آماده از مجموعهٔ متصل انتخاب کنید.')
        latitude,longitude=settlement.latitude,settlement.longitude
    if category not in job.categories:
        raise ValueError('دستهٔ آزمایش باید از دسته‌های برنامهٔ فعلی باشد.')
    if not all(math.isfinite(v) for v in (latitude,longitude)) or not (24<=latitude<=41 and 43<=longitude<=64):
        raise ValueError('مختصات باید عرض و طول جغرافیایی معتبر در محدودهٔ ایران باشند.')
    if not 500<=radius_m<=5000: raise ValueError('شعاع باید بین ۵۰۰ و ۵۰۰۰ متر باشد.')
    assignment=boundary_index(job.search_dataset_version or job.boundary_version).assign(latitude,longitude)
    province=assignment['province_name']
    if not province: raise ValueError('مبدأ باید داخل یک استان مشخص باشد؛ نقاط مرزی یا خارج از مرز پذیرفته نمی‌شوند.')
    provinces=session.scalars(select(PoiBoundary).where(PoiBoundary.version==job.boundary_version,
        PoiBoundary.level=='province').order_by(PoiBoundary.code)).all()
    province_order=next(i for i,p in enumerate(provinces) if normalize(p.name)==normalize(province))
    current=session.scalar(select(PoiSegment).where(PoiSegment.job_id==job.id,PoiSegment.kind=='grid',
        PoiSegment.status!='complete').order_by(PoiSegment.province_order,PoiSegment.id).limit(1))
    current_order=current.province_order if current else min(max(job.planned_provinces-1,0),len(provinces)-1)
    if job.search_dataset_version:
        pending=session.scalar(select(PoiSegment).where(PoiSegment.job_id==job.id,PoiSegment.kind=='settlement',
            PoiSegment.status!='complete').order_by(PoiSegment.province_order,PoiSegment.id).limit(1))
        current_order=pending.province_order if pending else min(max(job.planned_settlement_provinces-1,0),len(provinces)-1)
    if province_order!=current_order:
        raise ValueError('مبدأ آزمایش باید در استان فعلی برنامه باشد تا ترتیب استانی حفظ شود.')
    previous=session.get(PoiSegment,c.pilot_segment_id) if c.pilot_segment_id else None
    if previous and previous.status=='pending':
        previous.status='cancelled'  # Preserve the old origin/history rather than editing it.
    segment=PoiSegment(job_id=job.id,province_order=province_order,province_name=province,
        category=category,latitude=latitude,longitude=longitude,radius_m=radius_m,kind='pilot',
        settlement_id=settlement.id if settlement else None)
    session.add(segment);session.flush()
    c.collection_mode,c.pilot_segment_id='pilot',segment.id
    c.reason='Single-area pilot prepared; resume explicitly to run it'
    return segment


def set_paused(session, paused):
    c = control(session)
    c.paused = paused
    c.reason = 'Paused by administrator' if paused else ''
    return {'paused': paused, 'state': 'pausing' if paused and c.in_flight else 'paused' if paused else 'waiting'}


@lru_cache(maxsize=4)
def boundary_index(version):
    with database.db_session() as session:
        rows = session.scalars(select(PoiBoundary).where(PoiBoundary.version == version,
            PoiBoundary.level.in_(['province','county']))).all()
        return BoundaryIndex(rows)


def plan_province(session, job):
    if coverage.plan_for(session,job):return False
    if job.search_dataset_version: return plan_settlement_province(session,job)
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


def next_target(session, job, pilot_segment_id=None):
    coverage_plan=coverage.plan_for(session,job)
    segment = session.scalar(select(PoiSegment).where(PoiSegment.job_id == job.id,
        PoiSegment.status == 'pending',
        PoiSegment.id==pilot_segment_id if pilot_segment_id else PoiSegment.kind==('coverage' if coverage_plan else 'settlement' if job.search_dataset_version else 'grid'))
        .order_by(PoiSegment.province_order,PoiSegment.parent_segment_id.is_(None), PoiSegment.id).limit(1))
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
    for key, value in {**parse_address(body), **boundary_index(job.search_dataset_version or job.boundary_version).assign(lat,lon)}.items():
        setattr(place, key, value)
    place.name, place.normalized_name = body['name'], normalize(body['name'])
    place.latitude, place.longitude = lat, lon
    place.raw_details, place.resolved_at, place.boundary_version = body, stamp, job.search_dataset_version or job.boundary_version
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
    coverage_plan=coverage.plan_for(session,job)
    target = session.get(PoiSegment if req.target_type == 'segment' else PoiDetailTask, req.target_id)
    stamp = now()
    req.http_status, req.finished_at = reply.status, stamp
    # Failed/unvalidated Details can echo a still-unresolved Nearby hash.
    req.raw_response = None
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
                if not handoff and (c.collection_mode=='pilot' or not job.search_dataset_version):
                    c.paused, c.reason = True, 'Nearby produced no new usable hashes; review area/category with Neshan before continuing'
                if coverage_plan and coverage_plan.result_limit and len(items)>=coverage_plan.result_limit:
                    coverage.subdivide(session,job,target,coverage_plan)
                if not coverage_plan and result_cap and len(items) >= result_cap:
                    target.review_reason = 'Provider result cap reached; repeat with smaller search radius'
            else:
                if not detail_hash: raise RuntimeError('Details response has no in-memory request identity')
                save_details(session, job, detail_hash, reply.body, stamp)
                req.raw_response=reply.body
                target.pending_details = max(0, target.pending_details - 1)
            req.outcome = 'successful'
            target.status = 'processing' if target.pending_details else 'complete'
            if coverage_plan and not target.pending_details:coverage.settle(session,target)
            if req.kind=='details' and target.status=='complete' and c.collection_mode=='pilot' and c.pilot_segment_id==target.id:
                c.paused,c.reason=True,'Single-area pilot finished; nationwide grid remains paused'
    elif reply.status in {401,402,403,480,481,483,484,485}:
        req.outcome, target.status = 'failed', retry_status
        c.paused, c.reason = True, access_error_message(req.kind, reply.status)
    elif reply.status in {429,482}:
        req.outcome, target.status = 'failed', retry_status
        delay = max(delay, reply.retry_after, min(3600, 60 * 2 ** min(attempts, 6)))
    elif reply.status is None:
        req.outcome='uncertain'
        if coverage_plan and attempts<5:
            target.status=retry_status
            delay=max(delay,min(3600,60*2**attempts))
        else:
            target.status='uncertain'
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
        if job.search_dataset_version and model==PoiDetailTask: continue
        query=update(model).where(model.job_id == job.id, model.status.in_(['failed','uncertain']))
        if model==PoiSegment:
            query=query.where(PoiSegment.id==c.pilot_segment_id if c.collection_mode=='pilot' else
                PoiSegment.kind==('coverage' if coverage.plan_for(session,job) else 'settlement' if job.search_dataset_version else 'grid'))
        if model==PoiSegment and coverage.plan_for(session,job):
            session.execute(query.values(status='pending',attempts=0,review_reason=None))
        else:session.execute(query.values(status='pending',attempts=0))
    job.status = 'running'
    c.paused, c.reason = True, 'Unresolved work requeued; resume when ready'


def storage_cleanup_required(session):
    return bool(session.scalar(select(PoiRequest.id).where(PoiRequest.kind=='nearby',
        PoiRequest.raw_response.is_not(None)).limit(1)) or
        session.scalar(select(PoiPlace.id).where(PoiPlace.resolved_at.is_(None)).limit(1)) or
        session.scalar(select(PoiDetailTask.id).where(PoiDetailTask.status=='pending').limit(1)))


def collection_readiness(c, job, cleanup_required=False, pilot=None, unresolved_work=False, coverage_block=''):
    from backend.settings import get_settings
    key_configured = bool(get_settings().neshan_service_api_key.get_secret_value().strip())
    alive = bool(c and c.heartbeat_at and (now()-c.heartbeat_at).total_seconds() < 45)
    active_job = bool(job and job.status in ACTIVE)
    authorized = get_settings().neshan_collection_authorized
    pilot_block=''
    if c and c.collection_mode=='pilot':
        if not pilot or not job or pilot.job_id!=job.id: pilot_block='pilot_required'
        elif pilot.status=='complete': pilot_block='pilot_completed'
        elif pilot.status in ('failed','uncertain'): pilot_block='pilot_review_required'
    revision=collector_revision()
    worker_revision=re.search(r':v([0-9a-f]{12})(?::|$)',c.worker_id or '') if c else None
    outdated=bool(alive and c.worker_id and (not worker_revision or worker_revision.group(1)!=revision))
    blocked = ('worker_outdated' if outdated else 'missing_service_key' if not key_configured else 'authorization_required' if not authorized
               else 'storage_cleanup_required' if cleanup_required else 'no_active_job' if not active_job
               else coverage_block if coverage_block else pilot_block if pilot_block else 'unresolved_work' if unresolved_work
               else 'worker_not_running' if not alive else '')
    return dict(service_key_configured=key_configured, collection_authorized=authorized, worker_alive=alive,
                worker_revision=worker_revision.group(1) if worker_revision else None,expected_worker_revision=revision,
                resume_blocked_reason=blocked, can_resume=bool(c and c.paused and not blocked),
                can_pause=bool(active_job and (not c or not c.paused)))


def resume_collection(session):
    from backend.poi_preparation import busy
    if busy(session):raise ValueError('آماده‌سازی پوشش در حال اجراست؛ تا پایان آن صبر کنید.')
    c = control(session)
    job = session.scalar(select(PoiJob).where(PoiJob.status.in_(ACTIVE)).limit(1))
    pilot=session.get(PoiSegment,c.pilot_segment_id) if c and c.pilot_segment_id else None
    readiness = collection_readiness(c, job, storage_cleanup_required(session),pilot,unresolved_scope(session,job,c),coverage.blocker(session,job))
    messages = {
        'coverage_algorithm_mismatch':'نسخهٔ الگوریتم پوشش تغییر کرده است؛ برنامهٔ پوشش را با نسخهٔ فعلی بازسازی و تأیید کنید.',
        'coverage_not_ready':'تولید و تأیید هندسی همهٔ کاشی‌های پوشش هنوز تمام نشده است.',
        'coverage_limit_required':'سقف نتایج Nearby باید از نشان تأیید و در برنامه ثبت شود؛ بدون آن کامل‌بودن نتایج قابل بررسی نیست.',
        'unresolved_work':'ابتدا درخواست‌های ناموفق یا نامطمئن محدودهٔ فعلی را بررسی و در صورت نیاز به صف بازگردانید.',
        'worker_outdated':'پردازشگر نسخهٔ قدیمی را اجرا می‌کند؛ سرویس گردآوری را بازراه‌اندازی کنید.',
        'pilot_required': 'ابتدا یک آزمایش تک‌ناحیه‌ای در استان فعلی آماده کنید؛ اجرای سراسری متوقف است.',
        'pilot_completed': 'آزمایش تک‌ناحیه‌ای پایان یافته است؛ گزارش آن را بررسی کنید. اجرای سراسری همچنان متوقف است.',
        'pilot_review_required': 'آزمایش ناموفق یا نامطمئن است؛ پیش از تلاش دوباره تاریخچه را بررسی و موارد حل‌نشده را بازگردانی کنید.',
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
    pilot=session.get(PoiSegment,c.pilot_segment_id) if c and c.pilot_segment_id else None
    readiness = collection_readiness(c, job, storage_cleanup_required(session),pilot,unresolved_scope(session,job,c),coverage.blocker(session,job))
    alive = readiness['worker_alive']
    state = 'interrupted'
    if c and c.paused: state = 'pausing' if c.in_flight and alive else 'paused'
    elif alive: state = 'running' if c.in_flight else 'waiting'
    if not alive and not readiness['service_key_configured']: state = 'not_configured'
    elif not alive and (not job or job.status not in ACTIVE): state = 'idle'
    if job and job.status not in ACTIVE and not (c and c.in_flight):state=job.status
    output = dict(**readiness, state=state, paused=c.paused if c else True, reason=c.reason if c else 'No worker or job yet',
        heartbeat_at=c.heartbeat_at if c else None,
        next_request_at=c.next_request_at if c else None, in_flight=c.in_flight if c else None,
        coverage_label='Completed searches do not establish completeness of real-world POIs',
        completeness_verified=False, job=None,collection_mode=c.collection_mode if c else 'pilot',
        pilot=dict(id=pilot.id,status=pilot.status,latitude=pilot.latitude,longitude=pilot.longitude,
            radius_m=pilot.radius_m,category=pilot.category,province=pilot.province_name,
            details_saved=session.scalar(select(func.count()).select_from(PoiRequest).where(
                PoiRequest.target_type=='segment',PoiRequest.target_id==pilot.id,
                PoiRequest.kind=='details',PoiRequest.outcome=='successful'))) if pilot else None)
    if job:
        counts = session.execute(select(PoiRequest.kind, PoiRequest.outcome, func.count()).where(
            PoiRequest.job_id == job.id).group_by(PoiRequest.kind, PoiRequest.outcome)).all()
        provinces = session.execute(select(PoiSegment.province_order, PoiSegment.province_name,
            PoiSegment.status, func.count()).where(PoiSegment.job_id == job.id,PoiSegment.kind==('settlement' if job.search_dataset_version else 'grid')).group_by(
                PoiSegment.province_order,PoiSegment.province_name,PoiSegment.status).order_by(PoiSegment.province_order)).all()
        incomplete = {o for o,p,s,n in provinces if s != 'complete'}
        incomplete.update(session.scalars(select(PoiDetailTask.province_order).where(
            PoiDetailTask.job_id==job.id,PoiDetailTask.status!='complete').distinct()).all())
        complete_provinces = len({o for o,p,s,n in provinces} - incomplete)
        output['job'] = dict(completed_provinces=complete_provinces, remaining_provinces=31-complete_provinces,
            id=str(job.id),status=job.status,mode=job.mode,radius_m=job.radius_m,categories=job.categories,
            boundary_version=job.boundary_version,search_dataset_version=job.search_dataset_version,
            planned_provinces=job.planned_settlement_provinces if job.search_dataset_version else job.planned_provinces,total_provinces=31,
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
    output['search_sources']=[dict(version=d.version,summary=d.summary) for d in session.scalars(
        select(PoiSourceDataset).order_by(PoiSourceDataset.created_at.desc())).all()]
    if job and job.search_dataset_version:
        output['coverage_label']='فقط محدودهٔ شعاع جست‌وجو پیرامون نقاط فایل؛ پوشش کامل شهرها و روستاها تأیید نشده است.'
    coverage_plan=coverage.plan_for(session,job)
    output['geography']=coverage.progress(session,coverage_plan) if coverage_plan else geographic_progress(session,job) if job and job.search_dataset_version else None
    output['reported_at']=now()
    proof=bool(job and pilot and pilot.job_id==job.id and pilot.settlement_id and pilot.status=='complete' and
        pilot.radius_m==job.radius_m and not pilot.review_reason and not pilot.pending_details and output['pilot']['details_saved'])
    output['can_start_collection']=bool((c and c.collection_mode=='coverage' or proof) and job and job.search_dataset_version and c and c.paused and alive and
        readiness['service_key_configured'] and readiness['collection_authorized'] and
        not storage_cleanup_required(session) and readiness['resume_blocked_reason'] in ('','pilot_completed'))
    if coverage_plan:
        output['coverage_label']='پوشش کامل هندسهٔ چندضلعی‌ها و جست‌وجوی شعاع ۳ کیلومتر برای نقاط؛ پیشرفت مساحتی جداگانه نمایش داده می‌شود.'
    if output['geography']:
        output['job']['completed_provinces']=sum(r['complete'] for r in output['geography']['provinces'])
        output['job']['remaining_provinces']=len(output['geography']['provinces'])-output['job']['completed_provinces']
    output['categories'] = [dict(category=slug,unique_saved=n) for slug,n in session.execute(
        select(PoiPlaceCategory.category,func.count()).join(PoiPlace,PoiPlace.id==PoiPlaceCategory.place_id)
        .where(PoiPlace.resolved_at.is_not(None)).group_by(PoiPlaceCategory.category))]
    output['unique_saved'] = session.scalar(select(func.count()).select_from(PoiPlace).where(PoiPlace.resolved_at.is_not(None)))
    output['duplicate_reviews'] = session.scalar(select(func.count()).select_from(PoiDuplicateReview).where(PoiDuplicateReview.status=='pending'))
    from backend import poi_preparation as preparation
    output['preparation']=preparation.status(session)
    preparing=bool(output['preparation'] and output['preparation']['state'] in preparation.LIVE)
    output['coverage_setup']=dict(sources_available=all((preparation.SOURCE_DIRECTORY/f'area_to_search{i}.geojson').is_file() for i in range(1,9)),
        can_prepare=bool((not c or c.paused) and not (c and c.in_flight) and not preparing and not (output['job'] or {}).get('details',{}).get('pending')),
        has_plan=bool(coverage_plan))
    if preparing:
        output.update(can_resume=False,can_start_collection=False,resume_blocked_reason='coverage_preparing')
    return output


def paused_job(session):
    c=control(session)
    job=session.scalar(select(PoiJob).where(PoiJob.status.in_(ACTIVE)).limit(1))
    if not job: raise ValueError('برنامهٔ فعال گردآوری وجود ندارد.')
    if not c.paused or c.in_flight: raise ValueError('ابتدا گردآوری را متوقف کنید و تا پایان درخواست جاری صبر کنید.')
    if session.scalar(select(PoiSegment.id).where(PoiSegment.job_id==job.id,
        PoiSegment.status=='processing',PoiSegment.pending_details>0).limit(1)):
        raise ValueError('ابتدا دریافت جزئیات هش‌های منتظر در حافظه را تعیین تکلیف کنید.')
    return c,job


def attach_sources(session,version):
    c,job=paused_job(session)
    dataset=session.get(PoiSourceDataset,version)
    if not dataset:raise ValueError('ابتدا مجموعهٔ فایل‌ها را روی سرور وارد کنید.')
    if job.search_dataset_version==version:return job
    if dataset.summary.get('algorithm','').startswith('full-polygon-and-point'):
        raise ValueError('این مجموعه باید با برنامه‌ساز پوشش چندضلعی آماده شود؛ اتصال به برنامهٔ قدیمی فقط جست‌وجوی نقطه‌ای ایجاد می‌کند.')
    if job.search_dataset_version:raise ValueError('این برنامه قبلاً به یک نسخهٔ ثابت از مجموعه متصل شده است.')
    original=session.scalars(select(PoiBoundary.name).where(PoiBoundary.version==job.boundary_version,PoiBoundary.level=='province')).all()
    supplied=session.scalars(select(PoiBoundary.name).where(PoiBoundary.version==version,PoiBoundary.level=='province')).all()
    if {normalize(n) for n in original}!={normalize(n) for n in supplied}:raise ValueError('فهرست استان‌های مجموعه با برنامهٔ فعلی تطابق ندارد.')
    job.search_dataset_version=version
    c.collection_mode,c.pilot_segment_id='pilot',None
    c.reason='Search sources attached; prepare one settlement pilot first'
    return job


def enable_settlement_plan(session):
    c,job=paused_job(session)
    if not job.search_dataset_version:raise ValueError('ابتدا مجموعهٔ فایل‌ها را به برنامه متصل کنید.')
    pilot=session.get(PoiSegment,c.pilot_segment_id) if c.pilot_segment_id else None
    point=session.get(PoiSettlement,pilot.settlement_id) if pilot and pilot.settlement_id else None
    if not point or pilot.job_id!=job.id or point.version!=job.search_dataset_version or point.state!='ready' or pilot.status!='complete' or pilot.radius_m!=job.radius_m or pilot.review_reason or pilot.pending_details:
        raise ValueError('ابتدا آزمایش یک نقطه از مجموعه را با همان شعاع برنامه با موفقیت تمام کنید.')
    saved=session.scalar(select(PoiRequest.id).where(PoiRequest.target_type=='segment',PoiRequest.target_id==pilot.id,
        PoiRequest.kind=='details',PoiRequest.outcome=='successful').limit(1))
    if not saved:raise ValueError('آزمایش باید حداقل یک پاسخ موفق جزئیات POI ذخیره کرده باشد.')
    c.collection_mode='coverage'
    c.reason='Settlement buffers enabled; collection remains paused until explicit resume'
    return {'paused':True,'scope':'supplied_settlement_buffers'}


def source_points(session):
    job=session.scalar(select(PoiJob).where(PoiJob.status.in_(ACTIVE)).limit(1))
    if not job or not job.search_dataset_version:return []
    provinces=session.scalars(select(PoiBoundary).where(PoiBoundary.version==job.boundary_version,
        PoiBoundary.level=='province').order_by(PoiBoundary.code)).all()
    pending=session.scalar(select(PoiSegment).where(PoiSegment.job_id==job.id,PoiSegment.kind=='settlement',
        PoiSegment.status!='complete').order_by(PoiSegment.province_order,PoiSegment.id).limit(1))
    order=pending.province_order if pending else min(max(job.planned_settlement_provinces-1,0),len(provinces)-1)
    name=normalize(provinces[order].name)
    points=session.scalars(select(PoiSettlement).where(PoiSettlement.version==job.search_dataset_version,
        PoiSettlement.state=='ready').order_by(PoiSettlement.priority,PoiSettlement.county_name,PoiSettlement.name,PoiSettlement.code)).all()
    return [dict(id=str(p.id),name=p.name,province=p.province_name,county=p.county_name,latitude=p.latitude,longitude=p.longitude)
        for p in points if normalize(p.province_name)==name]


def plan_settlement_province(session,job):
    provinces=session.scalars(select(PoiBoundary).where(PoiBoundary.version==job.boundary_version,
        PoiBoundary.level=='province').order_by(PoiBoundary.code)).all()
    order=job.planned_settlement_provinces
    if order>=len(provinces):return False
    province=provinces[order]
    points=session.scalars(select(PoiSettlement).where(PoiSettlement.version==job.search_dataset_version,
        PoiSettlement.state=='ready').order_by(PoiSettlement.priority,PoiSettlement.county_name,PoiSettlement.name,PoiSettlement.code)).all()
    for point in points:
        if normalize(point.province_name)!=normalize(province.name):continue
        for category in job.categories:
            pilot=session.scalar(select(PoiSegment).where(PoiSegment.job_id==job.id,PoiSegment.kind=='pilot',
                PoiSegment.settlement_id==point.id,PoiSegment.category==category,PoiSegment.radius_m==job.radius_m,
                PoiSegment.latitude==point.latitude,PoiSegment.longitude==point.longitude,PoiSegment.status=='complete',
                PoiSegment.review_reason.is_(None),PoiSegment.pending_details==0,
                PoiSegment.id.in_(select(PoiRequest.target_id).where(PoiRequest.target_type=='segment',
                    PoiRequest.kind=='details',PoiRequest.outcome=='successful'))).order_by(PoiSegment.id.desc()).limit(1))
            session.add(PoiSegment(job_id=job.id,province_order=order,province_name=province.name,category=category,
                latitude=point.latitude,longitude=point.longitude,radius_m=job.radius_m,kind='settlement',settlement_id=point.id,
                status='complete' if pilot else 'pending',planning_note=f'Reused identical successful pilot {pilot.id}' if pilot else None))
    job.planned_settlement_provinces+=1
    return True


def collector_revision():
    """Identify loaded collector releases without recording secrets or response data."""
    root=Path(__file__).resolve().parent
    digest=hashlib.sha256()
    for name in ('poi.py','poi_worker.py','poi_models.py','poi_provider.py','poi_geo.py','poi_coverage.py','poi_coverage_state.py','poi_coverage_sources.py'):
        digest.update(name.encode());digest.update((root/name).read_bytes())
    return digest.hexdigest()[:12]


def start_collection(session):
    from backend.poi_preparation import busy
    if busy(session):raise ValueError('آماده‌سازی پوشش در حال اجراست؛ تا پایان آن صبر کنید.')
    c,job=paused_job(session)
    if not job.search_dataset_version:raise ValueError('ابتدا مجموعهٔ جغرافیایی را به برنامه متصل کنید.')
    if c.collection_mode=='pilot':enable_settlement_plan(session)
    # This transaction rolls back promotion if readiness fails; it never dispatches HTTP.
    return resume_collection(session)


def geographic_progress(session,job):
    """Progress of finite supplied-point/category searches; never national land coverage."""
    provinces=session.scalars(select(PoiBoundary).where(PoiBoundary.version==job.boundary_version,
        PoiBoundary.level=='province').order_by(PoiBoundary.code)).all()
    point_counts=Counter()
    for name,n in session.execute(select(PoiSettlement.province_name,func.count()).where(
        PoiSettlement.version==job.search_dataset_version,PoiSettlement.state=='ready').group_by(PoiSettlement.province_name)):
        point_counts[normalize(name)]+=n
    scope=(PoiSegment.job_id==job.id,PoiSegment.kind=='settlement',PoiSegment.category.in_(job.categories),
        PoiSettlement.version==job.search_dataset_version,PoiSettlement.state=='ready')
    totals={}
    for name,state,n in session.execute(select(PoiSettlement.province_name,PoiSegment.status,func.count()).join(
        PoiSettlement,PoiSettlement.id==PoiSegment.settlement_id).where(*scope).group_by(PoiSettlement.province_name,PoiSegment.status)):
        totals.setdefault(normalize(name),Counter())[state]+=n
    finished_points=Counter()
    # A point finishes only after every requested category and its Details handoff finish.
    finished=select(PoiSettlement.id,PoiSettlement.province_name).join(PoiSegment,PoiSegment.settlement_id==PoiSettlement.id).where(
        *scope,PoiSegment.status=='complete',PoiSegment.pending_details==0).group_by(PoiSettlement.id,PoiSettlement.province_name).having(
        func.count(func.distinct(PoiSegment.category))==len(job.categories))
    for _,name in session.execute(finished):finished_points[normalize(name)]+=1
    empty=Counter()
    empty_request=select(PoiRequest.id).where(PoiRequest.target_type=='segment',PoiRequest.target_id==PoiSegment.id,
        PoiRequest.kind=='nearby',PoiRequest.outcome=='successful',PoiRequest.queued_count==0).exists()
    for name,n in session.execute(select(PoiSettlement.province_name,func.count()).select_from(PoiSegment).join(
        PoiSettlement,PoiSettlement.id==PoiSegment.settlement_id).where(*scope,empty_request).group_by(PoiSettlement.province_name)):
        empty[normalize(name)]+=n
    flagged=Counter()
    for name,n in session.execute(select(PoiSettlement.province_name,func.count()).select_from(PoiSegment).join(
        PoiSettlement,PoiSettlement.id==PoiSegment.settlement_id).where(*scope,
        PoiSegment.review_reason.is_not(None),~PoiSegment.status.in_(['failed','uncertain'])).group_by(PoiSettlement.province_name)):
        flagged[normalize(name)]+=n
    rows=[]
    for order,p in enumerate(provinces):
        key=normalize(p.name);counts=totals.get(key,Counter());expected=point_counts[key]*len(job.categories)
        done=counts['complete'];planned=sum(counts.values());review=counts['failed']+counts['uncertain']+flagged[key]
        rows.append(dict(order=order,province=p.name,total_points=point_counts[key],completed_points=finished_points[key],
            expected_searches=expected,completed_searches=done,pending_searches=max(0,expected-done),
            in_progress=counts['processing'],review_searches=review,empty_searches=empty[key],
            unplanned_searches=max(0,expected-planned),percent=round(100*done/expected,2) if expected else None,
            complete=bool(expected and done==expected)))
    expected=sum(r['expected_searches'] for r in rows);done=sum(r['completed_searches'] for r in rows)
    total_points=sum(point_counts.values());points_done=sum(finished_points.values())
    current=next((r['province'] for r in rows if r['expected_searches'] and not r['complete']),None)
    return dict(scope='supplied_point_buffers',expected_searches=expected,completed_searches=done,
        percent=round(100*done/expected,2) if expected else None,total_points=total_points,completed_points=points_done,
        point_percent=round(100*points_done/total_points,2) if total_points else None,
        excluded_points=session.scalar(select(func.count()).select_from(PoiSettlement).where(
            PoiSettlement.version==job.search_dataset_version,PoiSettlement.state=='review')),
        current_province=current,empty_searches=sum(empty.values()),provinces=rows)


def unresolved_scope(session,job,c):
    if not job or job.status not in ACTIVE:return False
    scope=PoiSegment.id==c.pilot_segment_id if c and c.collection_mode=='pilot' else PoiSegment.kind==('coverage' if coverage.plan_for(session,job) else 'settlement' if job.search_dataset_version else 'grid')
    return bool(session.scalar(select(PoiSegment.id).where(PoiSegment.job_id==job.id,scope,
        PoiSegment.status.in_(['failed','uncertain'])).limit(1)))

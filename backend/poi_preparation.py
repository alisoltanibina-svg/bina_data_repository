"""Offline geographic preparation launched by admin; never calls the provider."""
import logging
import os
import subprocess
import sys
from datetime import timedelta
from pathlib import Path
from uuid import UUID,uuid4
from sqlalchemy import select,func,text,update
from sqlalchemy.orm import Session
from backend import database,poi
from backend import poi_coverage_state as coverage
from backend.poi_models import PoiPreparation as Task,PoiCoveragePlan as Plan,PoiCoverageTile as Tile,PoiJob,PoiSegment,PoiRequest

ROOT=Path(__file__).resolve().parent.parent
SOURCE_DIRECTORY=ROOT/'data/search area'
PLANNING_LOCK=poi.LOCK_KEY+1
QUEUE_LOCK=poi.LOCK_KEY+2
LIVE=('queued','running')
log=logging.getLogger(__name__)


def lock_held(session):
    return bool(session.scalar(text("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=0 AND objid=:key AND objsubid=1 AND granted)"),dict(key=PLANNING_LOCK)))


def task_state(session,row):
    if row.state in LIVE and row.updated_at<poi.now()-timedelta(seconds=30) and not lock_held(session):return 'interrupted'
    return row.state


def status(session):
    row=session.scalar(select(Task).order_by(Task.created_at.desc()).limit(1))
    if not row:return None
    state=task_state(session,row)
    return dict(id=str(row.id),plan_id=str(row.plan_id) if row.plan_id else None,state=state,phase=row.phase,
        message='آماده‌سازی قطع شده است؛ برای ادامه دکمهٔ آماده‌سازی را بزنید.' if state=='interrupted' else row.message,
        verified_tiles=row.verified_tiles,total_tiles=row.total_tiles,updated_at=row.updated_at)


def busy(session):
    row=session.scalar(select(Task).where(Task.state.in_(LIVE)).order_by(Task.created_at.desc()).limit(1))
    return bool(row and task_state(session,row) in LIVE)


def enqueue(session,categories,radius=2000):
    from backend.poi_provider import LAYERS
    if not categories or not set(categories)<=LAYERS:raise ValueError('دسته‌های جست‌وجو معتبر نیستند.')
    if radius!=2000:raise ValueError('شعاع این برنامه ۲۰۰۰ متر است؛ شعاع نقاط ۳۰۰۰ متر باقی می‌ماند.')
    if not session.scalar(text('SELECT pg_try_advisory_xact_lock(:key)'),dict(key=QUEUE_LOCK)):
        raise ValueError('درخواست آماده‌سازی دیگری در حال ثبت است؛ گزارش را تازه کنید.')
    existing=session.scalar(select(Task).where(Task.state.in_(LIVE)).order_by(Task.created_at.desc()).limit(1))
    if existing and task_state(session,existing) in LIVE:return existing,False
    if lock_held(session):raise ValueError('آماده‌سازی دیگری در حال اجراست؛ پس از پایان آن گزارش را تازه کنید.')
    if existing:existing.state='interrupted'
    c=poi.control(session)
    if not c.paused or c.in_flight:raise ValueError('ابتدا گردآوری را متوقف کنید و تا پایان درخواست جاری صبر کنید.')
    if session.scalar(select(PoiSegment.id).where(PoiSegment.status=='processing',PoiSegment.pending_details>0).limit(1)):
        raise ValueError('جزئیات هش‌های موجود باید پیش از آماده‌سازی پایان یابد.')
    for number in range(1,9):
        if not (SOURCE_DIRECTORY/f'area_to_search{number}.geojson').is_file():
            raise ValueError(f'فایل جغرافیایی area_to_search{number}.geojson در پوشهٔ داده موجود نیست.')
    plan=session.scalar(select(Plan).join(PoiJob,Plan.job_id==PoiJob.id).where(PoiJob.status.in_(poi.ACTIVE)).order_by(Plan.created_at.desc()).limit(1))
    if plan and plan.radius_m!=radius:plan=None  # Rebuild the earlier 500 m scope as a new paused job.
    if plan:
        job=session.get(PoiJob,plan.job_id)
        if sorted(job.categories)!=sorted(set(categories)):
            raise ValueError('برنامهٔ فعال تنظیمات دیگری دارد؛ دسته‌های همان برنامه را انتخاب کنید.')
        if (plan.summary or {}).get('algorithm')!=coverage.ALGORITHM:
            raise ValueError('نسخهٔ برنامهٔ فعال متفاوت است و باید پیش از جایگزینی بررسی شود.')
    row=Task(id=uuid4(),plan_id=plan.id if plan else None,state='queued',phase='sources',
        message='آماده‌سازی در صف است؛ این مرحله درخواستی به نشان نمی‌فرستد.',categories=sorted(set(categories)),radius_m=radius,
        verified_tiles=0,total_tiles=0)
    if plan and plan.state=='ready':
        row.state,row.phase,row.message='completed','done','پوشش آماده و تأیید شده است؛ نیازی به ساخت دوباره نیست.'
        row.total_tiles=row.verified_tiles=(plan.summary or {}).get('tiles',0)
    session.add(row);session.flush()
    return row,row.state=='queued'


def launch(task_id):
    kwargs=dict(cwd=str(ROOT),stdin=subprocess.DEVNULL,close_fds=True)
    if os.name=='nt':kwargs['creationflags']=subprocess.CREATE_NO_WINDOW|subprocess.CREATE_NEW_PROCESS_GROUP
    else:kwargs['start_new_session']=True
    try:
        subprocess.Popen([sys.executable,'-m','backend.poi_preparation',str(task_id)],**kwargs)
    except OSError:
        fail(task_id,'اجرای آماده‌سازی ممکن نشد؛ دوباره تلاش کنید و دسترسی سرویس را بررسی کنید.')
        raise ValueError('اجرای آماده‌سازی ممکن نشد؛ دوباره تلاش کنید.') from None


def checkpoint(task_id,**values):
    with database.db_session() as session:
        session.execute(update(Task).where(Task.id==task_id).values(updated_at=poi.now(),**values))


def fail(task_id,message):checkpoint(task_id,state='failed',message=message)


def progress_message(message):
    prefixes={
        'Checking paused collection':'بررسی توقف گردآوری و پایان جزئیات',
        'Checking geographic source snapshot':'بررسی مجموعهٔ جغرافیایی',
        'Existing complete source snapshot reused':'استفاده از مجموعهٔ جغرافیایی موجود',
        'Importing boundaries':'در حال ورود مرزها',
        'Boundaries imported:':'مرزهای واردشده:',
        'Point targets imported:':'نقاط واردشده:',
        'Projecting and dissolving':'آماده‌سازی پوشش مرزها',
        'Preparing 3000 m circles':'آماده‌سازی جست‌وجوهای سه کیلومتری نقاط',
        'Point targets associated:':'نقاط بررسی‌شده:',
        'Point circles saved:':'جست‌وجوهای نقاط ذخیره‌شده:',
        'Preparing polygon coverage tiles':'آماده‌سازی بخش‌های پوشش',
        'Preparation complete;':'ذخیرهٔ برنامهٔ آماده‌شده',
    }
    for prefix,label in prefixes.items():
        if message.startswith(prefix):
            tail=message[len(prefix):].strip()
            return label+(' '+tail if prefix in ('Importing boundaries','Boundaries imported:','Point targets imported:','Point targets associated:','Point circles saved:') else '')
    return 'آماده‌سازی داده‌های جغرافیایی'


def run(task_id):
    """Single detached process; each verified tile commits its own checkpoint."""
    with database.engine.connect() as connection:
        acquired=connection.scalar(text('SELECT pg_try_advisory_lock(:key)'),dict(key=PLANNING_LOCK));connection.commit()
        if not acquired:
            fail(task_id,'آماده‌سازی دیگری در حال اجراست؛ پس از پایان آن دوباره ادامه دهید.');return
        try:
            with Session(bind=connection) as session,session.begin():
                task=session.get(Task,task_id)
                if not task or task.state!='queued':return
                categories,radius,plan_id=task.categories,task.radius_m,task.plan_id
                task.state,task.updated_at='running',poi.now()
            checkpoint(task_id,message='خواندن و بررسی فایل‌های جغرافیایی')
            if not plan_id:
                from backend.poi_coverage_sources import compile_sources
                catalogue=compile_sources(SOURCE_DIRECTORY)
                def report(message):checkpoint(task_id,message=progress_message(message))
                with Session(bind=connection,expire_on_commit=False) as session,session.begin():
                    plan=coverage.create_plan(session,catalogue,categories,radius,replace_active=True,progress=report)
                    plan_id=plan.id
                    task=session.get(Task,task_id);task.plan_id=plan_id
            checkpoint(task_id,phase='coverage',message='ساخت و تأیید پوشش کامل مرزها')
            with Session(bind=connection,expire_on_commit=False) as session,session.begin():
                plan=session.get(Plan,plan_id)
                builder=coverage.Builder(session,plan)
                total=session.scalar(select(func.count()).select_from(Tile).where(Tile.plan_id==plan_id))
                verified=session.scalar(select(func.count()).select_from(Tile).where(Tile.plan_id==plan_id,Tile.state=='verified'))
            checkpoint(task_id,total_tiles=total,verified_tiles=verified)
            while True:
                with Session(bind=connection,expire_on_commit=False) as session,session.begin():
                    c=poi.control(session)
                    if not c.paused or c.in_flight:raise ValueError('گردآوری باید در زمان آماده‌سازی متوقف بماند.')
                    tile=session.scalar(select(Tile).where(Tile.plan_id==plan_id,Tile.state!='verified').order_by(Tile.id).limit(1))
                    if not tile:break
                    tile_id,geometry=tile.id,tile.geometry
                solution=builder.solve(geometry,radius)
                with Session(bind=connection,expire_on_commit=False) as session,session.begin():
                    c=poi.control(session)
                    if not c.paused or c.in_flight:raise ValueError('گردآوری باید در زمان آماده‌سازی متوقف بماند.')
                    coverage.Builder.build_one(builder,session,session.get(Plan,plan_id),session.get(Tile,tile_id),solution)
                verified+=1
                checkpoint(task_id,verified_tiles=verified,message=f'پوشش تأییدشده: {verified} از {total} بخش')
            checkpoint(task_id,phase='verification',message='بررسی نهایی پوشش همهٔ مرزها')
            with Session(bind=connection,expire_on_commit=False) as session,session.begin():
                coverage.finalize_plan(session,session.get(Plan,plan_id))
            checkpoint(task_id,state='completed',phase='done',verified_tiles=total,message='پوشش کامل تأیید شد؛ گردآوری همچنان متوقف است.')
        except Exception as error:
            connection.rollback()
            log.exception('Offline POI preparation failed: %s',task_id)
            message=str(error) if isinstance(error,ValueError) else 'آماده‌سازی به خطا رسید؛ دوباره ادامه دهید. اگر تکرار شد، گزارش سرویس را بررسی کنید.'
            fail(task_id,message)
        finally:
            if not connection.invalidated:
                connection.rollback();connection.execute(text('SELECT pg_advisory_unlock(:key)'),dict(key=PLANNING_LOCK));connection.commit()


def set_limit(session,limit):
    if not 1<=limit<=2147483647:raise ValueError('سقف تأییدشده باید عدد صحیح مثبت باشد.')
    if busy(session):raise ValueError('ابتدا تا پایان آماده‌سازی صبر کنید.')
    c=poi.control(session)
    if not c.paused or c.in_flight:raise ValueError('ابتدا گردآوری را متوقف کنید.')
    plan=session.scalar(select(Plan).join(PoiJob,Plan.job_id==PoiJob.id).where(PoiJob.status.in_(poi.ACTIVE)).order_by(Plan.created_at.desc()).limit(1))
    if not plan:raise ValueError('ابتدا برنامهٔ پوشش را آماده کنید.')
    if session.scalar(select(PoiRequest.id).where(PoiRequest.job_id==plan.job_id).limit(1)):
        raise ValueError('پس از ارسال درخواست، سقف این برنامه قابل تغییر نیست.')
    plan.result_limit=limit
    if plan.state=='ready':c.reason='Polygon plan verified; resume explicitly to begin'


if __name__=='__main__':
    logging.basicConfig(level=logging.INFO)
    run(UUID(sys.argv[1]))

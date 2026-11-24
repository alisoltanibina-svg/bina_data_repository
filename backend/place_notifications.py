"""API-owned SMS outbox. No changes to the independent POI collector."""
import asyncio
from contextlib import asynccontextmanager,suppress
from datetime import datetime,timedelta,timezone
import logging
from uuid import uuid4
from sqlalchemy import select,or_,exists
from sqlalchemy.orm import aliased
from backend import database
from backend.models import User
from backend.poi_editorial_models import PoiSmsNotification
from backend.otp import deliver_plain_sms

log=logging.getLogger(__name__)
MESSAGES={
    'submitted':'از همکاری شما در بهبود خدمات سامانه سپاسگزاریم. اطلاعات شما پس از تایید، بارگزاری خواهد شد',
    'approved':'اطلاعات شما با موفقیت ثبت و نمایش داده شد',
}

def enqueue(session,revision,event):
    if revision.actor_id:
        session.add(PoiSmsNotification(id=uuid4(),revision_id=revision.id,user_id=revision.actor_id,event=event))

def dispatch_pending(limit=10):
    # A row lock prevents API processes from dispatching the same pending row.
    for _ in range(limit):
        with database.db_session() as session:
            now=datetime.now(timezone.utc)
            first=aliased(PoiSmsNotification)
            waiting=exists(select(first.id).where(first.revision_id==PoiSmsNotification.revision_id,first.event=='submitted',first.sent_at.is_(None)))
            row=session.scalar(select(PoiSmsNotification).where(PoiSmsNotification.sent_at.is_(None),PoiSmsNotification.attempts>=0,
                or_(PoiSmsNotification.event!='approved',~waiting),
                PoiSmsNotification.available_at<=now).order_by(PoiSmsNotification.created_at,PoiSmsNotification.id).with_for_update(skip_locked=True).limit(1))
            if not row:return
            user=session.get(User,row.user_id) if row.user_id else None
            if not user or not user.is_active:row.attempts=-1;continue
            row.attempts+=1
            try:
                if deliver_plain_sms(user.phone,MESSAGES[row.event]):row.sent_at=now;continue
            except Exception:log.warning('Place SMS delivery failed: notification=%s attempt=%s',row.id,row.attempts)
            row.available_at=now+timedelta(seconds=min(3600,30*2**min(row.attempts,7)))

async def _loop():
    cleanup_at=datetime.min.replace(tzinfo=timezone.utc)
    while True:
        try:
            await asyncio.to_thread(dispatch_pending)
            if datetime.now(timezone.utc)>=cleanup_at:
                from backend.place_photos import cleanup_staged
                await asyncio.to_thread(cleanup_staged)
                cleanup_at=datetime.now(timezone.utc)+timedelta(hours=1)
        except Exception:log.exception('Place notification outbox unavailable')
        await asyncio.sleep(30)

@asynccontextmanager
async def lifespan(app):
    task=asyncio.create_task(_loop())
    try:yield
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError):await task

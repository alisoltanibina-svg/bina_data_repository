"""Neshan dispatch metadata only: never accepts or stores provider response content."""
import math
import time
from sqlalchemy import Float, String, cast, func, select
from sqlalchemy.dialects.postgresql import insert
from backend.models import SiteSetting

LIVE_NEXT_KEY = 'neshan_explore_next_dispatch'
BACKOFF_KEY = 'neshan_provider_backoff_until'


class ProviderBusy(Exception):
    def __init__(self, seconds):
        self.seconds = max(1, math.ceil(seconds))


def _deadline(value):
    if not value:
        return 0.0
    deadline = float(value)
    if not math.isfinite(deadline):
        raise ValueError('Invalid provider pacing metadata')
    return deadline


def provider_backoff_until(session):
    row = session.get(SiteSetting, BACKOFF_KEY)
    return _deadline(row.value) if row else 0.0


def reserve_live_slot(session, interval_seconds, stamp=None):
    stamp = time.time() if stamp is None else stamp
    keys = sorted((LIVE_NEXT_KEY, BACKOFF_KEY))
    session.execute(insert(SiteSetting).values([dict(key=key, value='0') for key in keys])
                    .on_conflict_do_nothing(index_elements=[SiteSetting.key]))
    rows = {row.key: row for row in session.scalars(select(SiteSetting)
        .where(SiteSetting.key.in_(keys)).order_by(SiteSetting.key).with_for_update(nowait=True)).all()}
    deadline = max(_deadline(rows[key].value) for key in keys)
    if deadline > stamp:
        raise ProviderBusy(deadline - stamp)
    rows[LIVE_NEXT_KEY].value = str(stamp + interval_seconds)


def record_provider_backoff(session, seconds, stamp=None):
    stamp = time.time() if stamp is None else stamp
    deadline = stamp + min(31536000, max(0, seconds))
    statement = insert(SiteSetting).values(key=BACKOFF_KEY, value=str(deadline))
    session.execute(statement.on_conflict_do_update(index_elements=[SiteSetting.key],
        set_={'value': cast(func.greatest(cast(SiteSetting.value, Float), deadline), String(255))}))

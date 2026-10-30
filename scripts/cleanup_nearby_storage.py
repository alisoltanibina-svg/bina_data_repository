"""Review and explicitly remove legacy Nearby output. No Neshan calls.

Run from the project root:
  python -m scripts.cleanup_nearby_storage          # counts only
  python -m scripts.cleanup_nearby_storage --apply  # worker must be stopped

The apply operation removes Nearby payloads, unresolved discovery records and
legacy hash queues; it rebuilds place category links solely from successful
Details output. Saved Details payloads and stable place UUIDs are preserved.
Backups, WAL archives, exports and database logs require separate retention review.
"""
import argparse
from sqlalchemy import select,func,delete,update,text
from sqlalchemy.dialects.postgresql import insert
from backend import database
from backend.poi import LOCK_KEY,control,now
from backend.poi_models import PoiRequest,PoiPlace,PoiPlaceCategory,PoiDetailTask,PoiDuplicateReview,PoiCategory,PoiSegment


def cleanup(session, apply=False):
    unresolved=select(PoiPlace.id).where(PoiPlace.resolved_at.is_(None))
    counts=dict(nearby_payloads=session.scalar(select(func.count()).select_from(PoiRequest).where(
        PoiRequest.kind=='nearby',PoiRequest.raw_response.is_not(None))),
        unresolved_discoveries=session.scalar(select(func.count()).select_from(PoiPlace).where(PoiPlace.resolved_at.is_(None))),
        legacy_detail_tasks=session.scalar(select(func.count()).select_from(PoiDetailTask)))
    if not apply: return counts
    c=control(session)
    # The command holds the same advisory lock as the worker, so no request is
    # still owned by a live collector. Preserve uncertain outcomes, never invent success.
    session.execute(update(PoiRequest).where(PoiRequest.kind=='nearby').values(raw_response=None))
    session.execute(update(PoiRequest).where(PoiRequest.outcome=='dispatched').values(
        outcome='uncertain',error='worker_stopped_before_cleanup',finished_at=now()))
    c.in_flight=None
    c.paused,c.reason=True,'Legacy Nearby storage removed; review authorization before resuming'
    # Keep successful request history, but remove obsolete durable hash queues.
    session.execute(delete(PoiDetailTask))
    session.execute(delete(PoiDuplicateReview).where(
        PoiDuplicateReview.place_id.in_(unresolved) | PoiDuplicateReview.other_place_id.in_(unresolved)))
    session.execute(delete(PoiPlaceCategory))
    session.execute(delete(PoiPlace).where(PoiPlace.resolved_at.is_(None)))
    for place in session.scalars(select(PoiPlace)).yield_per(500):
        layer=(place.raw_details or {}).get('layer')
        if isinstance(layer,dict) and isinstance(layer.get('slug'),str) and 0<len(layer['slug'])<=100:
            slug=layer['slug'];title=layer.get('title') if isinstance(layer.get('title'),str) else slug
            session.execute(insert(PoiCategory).values(slug=slug,title=title).on_conflict_do_nothing())
            session.execute(insert(PoiPlaceCategory).values(place_id=place.id,category=slug).on_conflict_do_nothing())
    session.execute(update(PoiSegment).where(PoiSegment.status=='processing').values(status='uncertain'))
    session.execute(text('ALTER TABLE poi_requests VALIDATE CONSTRAINT ck_poi_no_nearby_payload'))
    return counts


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply',action='store_true',help='Delete legacy Nearby output after reviewing the default dry run')
    args=parser.parse_args()
    with database.engine.connect() as connection:
        if args.apply:
            acquired=connection.scalar(text('SELECT pg_try_advisory_lock(:key)'),{'key':LOCK_KEY})
            connection.commit()
            if not acquired: raise SystemExit('Stop the collector worker before applying cleanup')
        try:
            from sqlalchemy.orm import Session
            with Session(bind=connection) as session,session.begin():
                if not args.apply: session.execute(text('SET TRANSACTION READ ONLY'))
                counts=cleanup(session,args.apply)
            print('Applied' if args.apply else 'Dry run; no changes',counts)
        finally:
            if args.apply:
                connection.rollback()
                connection.execute(text('SELECT pg_advisory_unlock(:key)'),{'key':LOCK_KEY});connection.commit()

if __name__=='__main__': main()

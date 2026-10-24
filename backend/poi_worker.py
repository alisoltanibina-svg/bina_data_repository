"""Run with python -m backend.poi_worker. Never started by FastAPI lifecycle hooks."""
import argparse
from datetime import timedelta
from pathlib import Path
import logging
import signal
import socket
import threading
from uuid import uuid4
from sqlalchemy import select, text, update, func
from sqlalchemy.orm import Session
from backend import database
from backend.poi import (LOCK_KEY, ACTIVE, control, now, plan_province, next_target, apply_reply, create_job)
from backend.poi_models import PoiControl, PoiJob, PoiSegment, PoiDetailTask, PoiRequest
from backend.poi_provider import Neshan
from backend.settings import get_settings

log = logging.getLogger('poi_worker')

class Worker:
    def __init__(self, provider, result_cap=0):
        self.provider, self.result_cap = provider, result_cap
        self.worker_id = socket.gethostname()[:50] + ':' + uuid4().hex
        self.stop = threading.Event()

    def heartbeat(self):
        while not self.stop.wait(5):
            try:
                with database.db_session() as session:
                    session.execute(update(PoiControl).where(PoiControl.id==1, PoiControl.worker_id==self.worker_id)
                        .values(heartbeat_at=now()))
            except Exception:
                # If the DB disappears, do not dispatch more HTTP traffic.
                self.stop.set()
                log.error('Heartbeat unavailable; collector stopping')

    def recover(self, session):
        c = control(session)
        pending = session.scalars(select(PoiRequest).where(PoiRequest.outcome=='dispatched')).all()
        for req in pending:
            req.outcome, req.error, req.finished_at = 'uncertain', 'worker_interrupted_after_dispatch', now()
            target = session.get(PoiSegment if req.kind=='nearby' else PoiDetailTask, req.target_id)
            if target: target.status = 'uncertain'
        if pending or c.in_flight:
            c.paused, c.reason = True, 'Interrupted request has an unknown outcome; inspect history before retrying'
            c.next_request_at = max(c.next_request_at or now(), now()+timedelta(seconds=60))
        c.in_flight, c.worker_id, c.heartbeat_at = None, self.worker_id, now()

    def tick(self, connection, backend_pid):
        # A reconnected SQLAlchemy connection no longer owns the original session lock.
        if connection.scalar(text('SELECT pg_backend_pid()')) != backend_pid:
            raise RuntimeError('Collector lock connection changed')
        connection.commit()
        planning_job_id = None
        with Session(bind=connection, expire_on_commit=False) as session, session.begin():
            c = control(session)
            c.heartbeat_at = now()
            if c.paused or self.stop.is_set(): return
            job = session.scalar(select(PoiJob).where(PoiJob.status.in_(ACTIVE)).order_by(PoiJob.created_at).limit(1))
            if not job: return
            job.status = 'running'
            target = next_target(session, job)
            if target is None:
                planning_job_id = job.id
            else:
                if target[0] == 'skip': return
                if c.next_request_at and c.next_request_at > now(): return
                kind, row, params = target
                row.attempts += 1
                req = PoiRequest(job_id=job.id, kind=kind, target_id=row.id, outcome='dispatched')
                session.add(req)
                session.flush()
                request_id = req.id
                c.in_flight = request_id
                # Reserve a conservative deadline before dispatch in case the process dies.
                c.next_request_at = now()+timedelta(seconds=80)
        if planning_job_id:
            # Planning can be lengthy. Do not hold the pause/heartbeat row lock while
            # generating coverage. A concurrent pause prevents the next dispatch.
            with Session(bind=connection) as session, session.begin():
                job = session.get(PoiJob, planning_job_id)
                if plan_province(session, job): return
                unresolved = sum(session.scalar(select(func.count()).select_from(model).where(model.job_id==job.id,
                    model.status.in_(['failed','uncertain']))) for model in (PoiSegment,PoiDetailTask))
                flagged = session.scalar(select(func.count()).select_from(PoiSegment).where(PoiSegment.job_id==job.id,
                    PoiSegment.review_reason.is_not(None)))
                job.status = 'needs_review' if unresolved or flagged or job.missing_hashes else 'completed'
            return
        # Committed dispatch is the boundary for pause. No DB transaction spans HTTP.
        reply = self.provider.request(kind, params)
        if connection.scalar(text('SELECT pg_backend_pid()')) != backend_pid:
            raise RuntimeError('Collector lost its lock during the request')
        connection.commit()
        with Session(bind=connection) as session, session.begin():
            apply_reply(session, request_id, reply, self.result_cap)

    def run(self):
        with database.engine.connect() as connection:
            acquired = connection.scalar(text('SELECT pg_try_advisory_lock(:key)'), {'key': LOCK_KEY})
            backend_pid = connection.scalar(text('SELECT pg_backend_pid()'))
            connection.commit()
            if not acquired: raise RuntimeError('Another collector already owns the PostgreSQL lock')
            heartbeat = None
            try:
                with Session(bind=connection) as session, session.begin(): self.recover(session)
                heartbeat = threading.Thread(target=self.heartbeat, daemon=True)
                heartbeat.start()
                while not self.stop.is_set():
                    self.tick(connection, backend_pid)
                    self.stop.wait(1)
            finally:
                self.stop.set()
                if heartbeat: heartbeat.join(timeout=6)
                # No unlock is needed after a broken connection; Postgres releases it.
                if not connection.invalidated:
                    connection.rollback()
                    with Session(bind=connection) as session, session.begin():
                        session.execute(update(PoiControl).where(PoiControl.worker_id==self.worker_id)
                            .values(heartbeat_at=None,worker_id=None))
                    connection.execute(text('SELECT pg_advisory_unlock(:key)'), {'key': LOCK_KEY})
                    connection.commit()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command')
    create = sub.add_parser('create', help='Create a paused nationwide job, optionally importing county boundaries')
    create.add_argument('--categories', required=True, help='Comma-separated documented Nearby layer identifiers')
    create.add_argument('--radius', type=int, default=2000)
    create.add_argument('--counties', type=Path)
    args = parser.parse_args()
    if args.command == 'create':
        with database.db_session() as session:
            job = create_job(session, args.categories.split(','), args.radius, county_path=args.counties)
            print('Created paused job:', job.id)
        return
    settings = get_settings()
    key = settings.neshan_service_api_key.get_secret_value().strip()
    if not key:
        with database.db_session() as session:
            c=control(session);c.paused=True;c.reason='NESHAN_SERVICE_API_KEY is not configured'
        raise SystemExit('Configure the server service key before starting the worker')
    worker = Worker(Neshan(key), max(0,settings.neshan_nearby_result_cap))
    for event in (signal.SIGINT, signal.SIGTERM): signal.signal(event, lambda *_: worker.stop.set())
    worker.run()

if __name__ == '__main__': main()

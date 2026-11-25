"""Audit or prepare nationwide saturation backfill without calling Neshan.

  venv/bin/python -m scripts.repair_poi_coverage
  venv/bin/python -m scripts.repair_poi_coverage --apply --expect-database appdb_test
  venv/bin/python -m scripts.repair_poi_coverage --apply --recover-interrupted --expect-database appdb_test
  venv/bin/python -m scripts.repair_poi_coverage --job JOB_UUID --apply --expect-database appdb_test
  venv/bin/python -m scripts.repair_poi_coverage --activate JOB_UUID --expect-database appdb_test

The default is a read-only report. --apply requires paused collection and no
volatile Details batch; each repaired leaf commits independently and rerunning
continues from the remaining work. --activate selects a prepared historical job
but keeps collection paused. Resume through the existing administrator UI.
"""
import argparse
import json
from uuid import UUID


def selected_plans(session,job_id=None):
    from sqlalchemy import select
    from backend.poi_models import PoiCoveragePlan as Plan
    query=select(Plan).order_by(Plan.created_at,Plan.id)
    if job_id:query=query.where(Plan.job_id==job_id)
    return session.scalars(query).all()


def plan_report(session,plan):
    from sqlalchemy import select,func
    from backend import poi_coverage_state as coverage
    from backend.poi_models import PoiJob,PoiSegment
    job=session.get(PoiJob,plan.job_id)
    candidates=session.scalar(select(func.count()).select_from(coverage.saturation_candidates(session,job,plan).subquery()))
    valid=bool(plan.state=='ready' and (plan.summary or {}).get('coverage_verified')
        and (plan.summary or {}).get('algorithm')==coverage.ALGORITHM)
    return dict(job_id=str(job.id),plan_id=str(plan.id),job_status=job.status,
        geometry_ready=valid,configured_result_limit=plan.result_limit,effective_result_limit=coverage.effective_result_limit(plan),
        historical_saturated_leaves=candidates,discovery_policy_ready=coverage.discovery_ready(plan),
        pending_searches=session.scalar(select(func.count()).select_from(PoiSegment).where(
            PoiSegment.job_id==job.id,PoiSegment.kind=='coverage',PoiSegment.status=='pending')),
        provider_calls_made=0)


def require_paused(session):
    from sqlalchemy import select
    from backend import poi
    from backend.poi_models import PoiSegment
    c=poi.control(session)
    if not c.paused or c.in_flight:raise ValueError('Pause collection and wait for the in-flight request before offline repair')
    if session.scalar(select(PoiSegment.id).where(PoiSegment.status=='processing',PoiSegment.pending_details>0).limit(1)):
        raise ValueError('Finish the transient Details batch before offline repair')
    return c


def verify_write_session(session,expected_database,backend_pid):
    from sqlalchemy import text
    actual=session.execute(text('SELECT current_database(), pg_backend_pid()')).one()
    if actual[0]!=expected_database:raise ValueError('Database changed during repair; no further changes were applied')
    if actual[1]!=backend_pid:raise ValueError('Repair connection changed; rerun to reacquire the maintenance lock')


def activate(session,job_id):
    from sqlalchemy import select
    from backend import poi,poi_coverage_state as coverage
    from backend.poi_models import PoiJob,PoiSegment
    c=require_paused(session);job=session.get(PoiJob,job_id)
    if not job:raise ValueError('Job not found')
    other=session.scalar(select(PoiJob.id).where(PoiJob.status.in_(poi.ACTIVE),PoiJob.id!=job.id).limit(1))
    if other:raise ValueError('Finish the active collection job before activating historical backfill')
    plan=coverage.plan_for(session,job)
    if not plan or not coverage.discovery_ready(plan):raise ValueError('Prepare this job before activating it')
    if coverage.blocker(session,job):raise ValueError('The geometry plan requires review before activation')
    if not session.scalar(select(PoiSegment.id).where(PoiSegment.job_id==job.id,PoiSegment.kind=='coverage',PoiSegment.status=='pending').limit(1)):
        raise ValueError('This job has no pending backfill searches')
    job.status='pending';c.collection_mode='coverage';c.pilot_segment_id=None
    c.reason='Historical coverage backfill ready; resume explicitly to begin'
    return dict(job_id=str(job.id),paused=True,provider_calls_made=0)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--job',type=UUID,help='Limit preparation to one job; otherwise all polygon plans are inspected')
    parser.add_argument('--apply',action='store_true',help='Prepare backfill; leave collection paused')
    parser.add_argument('--activate',type=UUID,help='Activate a prepared job only when no other job is active')
    parser.add_argument('--max-segments',type=int,default=0,help='Bound repaired leaves per invocation; 0 continues all selected plans')
    parser.add_argument('--api-pid',type=int,help='Use a running checkout process environment on Linux')
    parser.add_argument('--expect-database',help='Required before writes; must exactly match current_database()')
    parser.add_argument('--recover-interrupted',action='store_true',help='After stopping the worker, safely requeue interrupted in-memory Details handoffs')
    args=parser.parse_args()
    if args.max_segments<0:parser.error('--max-segments must be nonnegative')
    if args.activate and (args.job or args.apply):parser.error('--activate is a separate action')
    if args.recover_interrupted and not args.apply:parser.error('--recover-interrupted requires --apply')
    if (args.apply or args.activate) and not args.expect_database:parser.error('--expect-database is required for preparation or activation')
    if args.api_pid:
        from scripts.diagnose_poi_identity import use_process_settings
        use_process_settings(args.api_pid)
    from sqlalchemy import select,text
    from sqlalchemy.orm import Session
    from backend import database,poi,poi_coverage_state as coverage
    from backend.poi_models import PoiCoveragePlan as Plan,PoiJob,PoiSegment,PoiRequest
    try:
        with database.engine.connect() as connection:
            actual_database=connection.scalar(text('SELECT current_database()'));connection.rollback()
            if args.expect_database and actual_database!=args.expect_database:
                raise ValueError(f'Database mismatch: expected {args.expect_database}, connected to {actual_database}')
            if not args.apply and not args.activate:
                with connection.begin():
                    connection.exec_driver_sql('SET TRANSACTION READ ONLY')
                    connection.exec_driver_sql("SET LOCAL statement_timeout='30s'")
                    with Session(bind=connection) as session:
                        report=[plan_report(session,plan) for plan in selected_plans(session,args.job)]
                print(json.dumps(dict(database=actual_database,database_changed=False,provider_calls_made=0,plans=report),indent=2));return
            # Control-row locks serialize each checkpoint with pause/resume and
            # worker dispatch. A separate lock prevents two offline repair CLIs.
            acquired=connection.scalar(text('SELECT pg_try_advisory_lock(:key)'),dict(key=poi.LOCK_KEY+2));connection.commit()
            if not acquired:raise ValueError('Another coverage repair process is running')
            backend_pid=connection.scalar(text('SELECT pg_backend_pid()'));connection.commit()
            collector_locked=False
            try:
                if args.activate:
                    with Session(bind=connection) as session,session.begin():
                        verify_write_session(session,args.expect_database,backend_pid);report=activate(session,args.activate)
                    print(json.dumps(dict(database=actual_database,**report),indent=2));return
                recovered=0
                if args.recover_interrupted:
                    collector_locked=connection.scalar(text('SELECT pg_try_advisory_lock(:key)'),dict(key=poi.LOCK_KEY));connection.commit()
                    if not collector_locked:raise ValueError('Stop the standalone worker before recovering its interrupted Details handoff')
                    with Session(bind=connection) as session,session.begin():
                        verify_write_session(session,args.expect_database,backend_pid)
                        c=poi.control(session)
                        if not c.paused:raise ValueError('Pause collection and stop the worker before recovery')
                        requests=select(PoiRequest).join(PoiSegment,PoiRequest.target_id==PoiSegment.id).where(
                            PoiRequest.target_type=='segment',PoiRequest.outcome=='dispatched',PoiSegment.kind=='coverage')
                        if args.job:requests=requests.where(PoiRequest.job_id==args.job)
                        interrupted=session.scalars(requests).all()
                        for request in interrupted:
                            request.outcome,request.error,request.finished_at='uncertain','worker_interrupted_after_dispatch',poi.now()
                            segment=session.get(PoiSegment,request.target_id);segment.status='uncertain'
                        if c.in_flight in {request.id for request in interrupted}:c.in_flight=None
                        if c.in_flight:raise ValueError('The interrupted request requires another job or legacy-scope recovery')
                        session.flush()
                        query=select(PoiSegment).where(PoiSegment.kind=='coverage',PoiSegment.status.in_(['processing','uncertain']))
                        if args.job:query=query.where(PoiSegment.job_id==args.job)
                        for segment in session.scalars(query).all():
                            if coverage.recover_interrupted_handoff(session,segment):recovered+=1
                        if recovered:
                            from datetime import timedelta
                            c.next_request_at=max(c.next_request_at or poi.now(),poi.now()+timedelta(seconds=60))
                with Session(bind=connection) as session,session.begin():
                    verify_write_session(session,args.expect_database,backend_pid)
                    require_paused(session);plan_ids=[plan.id for plan in selected_plans(session,args.job)]
                repaired=0;reports=[]
                for plan_id in plan_ids:
                    first_checkpoint=True
                    while True:
                        with Session(bind=connection) as session,session.begin():
                            verify_write_session(session,args.expect_database,backend_pid)
                            require_paused(session);plan=session.get(Plan,plan_id);job=session.get(PoiJob,plan.job_id)
                            report=plan_report(session,plan)
                            if not report['geometry_ready']:report['skipped']='geometry_requires_rebuild_or_verification';break
                            if args.max_segments and repaired>=args.max_segments:report['stopped_at_budget']=True;break
                            # A plan previously marked reconciled can be audited
                            # again if imported history introduced capped leaves.
                            if first_checkpoint and coverage.discovery_ready(plan):
                                plan.summary={**plan.summary,'discovery_policy':{**plan.summary['discovery_policy'],'reconciled':False}}
                            first_checkpoint=False
                            changed=coverage.repair_one(session,job,plan)
                            if changed:
                                repaired+=1
                                if job.status not in poi.ACTIVE:job.status='needs_review'
                            if not changed:report=plan_report(session,plan)
                        if not changed:break
                        if repaired%20==0:print(json.dumps(dict(prepared_leaves=repaired,provider_calls_made=0)),flush=True)
                    reports.append(report)
                    if args.max_segments and repaired>=args.max_segments:break
                print(json.dumps(dict(database=actual_database,database_changed=True,recovered_handoffs=recovered,prepared_leaves=repaired,paused=True,provider_calls_made=0,plans=reports),indent=2))
            finally:
                connection.rollback()
                if collector_locked:connection.execute(text('SELECT pg_advisory_unlock(:key)'),dict(key=poi.LOCK_KEY))
                connection.execute(text('SELECT pg_advisory_unlock(:key)'),dict(key=poi.LOCK_KEY+2));connection.commit()
    except Exception as error:
        # Raw SQL exceptions may contain credentials or protected source data.
        print(json.dumps(dict(status='repair_unavailable',error_type=type(error).__name__,
            reason=str(error) if type(error) is ValueError else 'Database details suppressed')))
        raise SystemExit(2)


if __name__=='__main__':main()

"""Archive and physically remove exact-coordinate duplicate Neshan source rows.

Preview: python -m scripts.purge_exact_poi_duplicates --expect-database appdb_test
Apply:   python -m scripts.purge_exact_poi_duplicates --apply --expect-database appdb_test

Requires migration 0031. Stop the API and worker and pause collection before
applying. No provider request is made. Stored X/Y floats must be exactly equal:
no rounding, distance tolerance, hash comparison, or nearest-point selection.
Category and normalized province/name must also match. Conflicting independent
user histories remain for explicit reconciliation; nothing is cascaded away.
"""
import argparse
from collections import Counter,defaultdict
from contextlib import contextmanager
from datetime import date,datetime,timezone
import json
from uuid import UUID
from sqlalchemy import select,func,or_,delete,update,text
from sqlalchemy.dialects.postgresql import insert
from backend import poi_canonical as identity
from backend.poi_identity_rules import normalized
from backend.poi_models import (PoiPlace,PoiPlaceCategory,PoiPlaceLink,PoiProviderAlias,PoiCanonicalEvent,
    PoiRetiredPlace,PoiDetailTask,PoiDuplicateReview,PoiRequest,PoiControl)
from scripts.reconcile_poi_places import history_places,check_database

MAX_REFERENCES=10000
KNOWN_REFERENCES={('poi_place_categories','place_id'),('poi_detail_tasks','place_id'),
    ('poi_duplicate_reviews','place_id'),('poi_duplicate_reviews','other_place_id'),
    ('poi_place_links','source_id'),('poi_place_links','canonical_id'),
    ('poi_provider_aliases','place_id'),('poi_canonical_events','canonical_id'),('poi_retired_places','canonical_id')}


def serialized(value):
    if isinstance(value,(UUID,datetime,date)):return str(value) if isinstance(value,UUID) else value.isoformat()
    if isinstance(value,dict):return {key:serialized(item) for key,item in value.items()}
    if isinstance(value,(list,tuple)):return [serialized(item) for item in value]
    return value


def record(row):return {column.key:serialized(getattr(row,column.key)) for column in row.__table__.columns}


def source_record(session,row):
    if session.get_bind().dialect.name=='postgresql':
        return session.scalar(text('SELECT to_jsonb(source_row) FROM poi.poi_places AS source_row WHERE id=:id'),dict(id=row.id))
    return record(row)


def category_values():
    raw=PoiPlace.raw_details['layer']['slug'].as_string()
    fallback=select(func.min(PoiPlaceCategory.category)).where(PoiPlaceCategory.place_id==PoiPlace.id).having(func.count()==1).scalar_subquery()
    return func.coalesce(func.nullif(raw,''),fallback)


def exact_key(row):
    return (row.provider,row.category,normalized(row.province_name),normalized(row.name),row.latitude,row.longitude)


def group_rows(rows):
    groups=defaultdict(list)
    for row in rows:
        if row.category and normalized(row.name) and normalized(row.province_name):groups[exact_key(row)].append(row)
    return [members for members in groups.values() if len(members)>1]


def metadata(session,ids=None,province=None,category=None,limit=100000):
    cat=category_values()
    query=select(PoiPlace.id,PoiPlace.provider,PoiPlace.name,PoiPlace.province_name,PoiPlace.latitude,PoiPlace.longitude,
        PoiPlace.discovered_at,cat.label('category')).where(PoiPlace.provider=='neshan',PoiPlace.resolved_at.is_not(None))
    if ids is not None:query=query.where(PoiPlace.id.in_(ids))
    if category:query=query.where(cat==category)
    if province:
        prov=func.lower(func.trim(func.regexp_replace(func.replace(func.translate(PoiPlace.province_name,'يك','یک'),'\u200c',' '),r'\s+',' ','g')))
        query=query.where(prov==normalized(province))
    rows=session.execute(query.order_by(PoiPlace.id).limit(limit+1)).all()
    return rows[:limit],len(rows)>limit


def rank(row):
    stamp=row.discovered_at
    if stamp and stamp.tzinfo is None:stamp=stamp.replace(tzinfo=timezone.utc)
    return (stamp.timestamp() if stamp else float('inf'),str(row.id))


def decision(session,rows):
    ids={row.id for row in rows};roots={identity.canonical_id(session,key) for key in ids}
    expanded=set(ids)
    for root in roots:expanded.update(identity.member_ids(session,root))
    protected={identity.canonical_id(session,key) for key in history_places(session,expanded)}
    if len(roots)>1 and len(protected)>1:
        return dict(state='review_required',reason='conflicting_user_histories',member_ids=sorted(map(str,ids)))
    root=next(iter(roots)) if len(roots)==1 else next(iter(protected)) if len(protected)==1 else min(rows,key=rank).id
    keeper=root if root in ids else min(rows,key=rank).id
    try:identity.validate_members(session,root,ids)
    except identity.IdentityConflict as error:
        return dict(state='review_required',reason=error.reason,member_ids=sorted(map(str,ids)))
    return dict(state='ready',canonical_id=str(root),keeper_id=str(keeper),member_ids=sorted(map(str,ids)),
        delete_ids=sorted(str(key) for key in ids if key!=keeper),category=rows[0].category,
        province=rows[0].province_name,latitude=rows[0].latitude,longitude=rows[0].longitude)


def preview(session,province=None,category=None,limit=100000):
    rows,truncated=metadata(session,province=province,category=category,limit=limit)
    groups=[decision(session,members) for members in group_rows(rows)]
    return dict(source_rows_inspected=len(rows),truncated=truncated,group_counts=dict(Counter(group['state'] for group in groups)),
        incomplete_identity_rows=sum(not row.category or not normalized(row.name) or not normalized(row.province_name) for row in rows),
        planned_deletions=sum(len(group.get('delete_ids',[])) for group in groups),groups=groups)


def verify_foreign_keys(session):
    """An unexpected referencing table must never be removed by CASCADE."""
    if session.get_bind().dialect.name!='postgresql':return
    rows=session.execute(text("""SELECT ns.nspname, rel.relname, att.attname
        FROM pg_constraint con JOIN pg_class rel ON rel.oid=con.conrelid
        JOIN pg_namespace ns ON ns.oid=rel.relnamespace
        JOIN pg_attribute att ON att.attrelid=rel.oid AND att.attnum=ANY(con.conkey)
        WHERE con.contype='f' AND con.confrelid='poi.poi_places'::regclass""")).all()
    unknown=[f'{schema}.{table}.{column}' for schema,table,column in rows
        if schema!='poi' or (table,column) not in KNOWN_REFERENCES]
    if unknown:raise ValueError('Unsupported place foreign keys: '+', '.join(sorted(unknown)))


def bounded(session,query):
    rows=session.scalars(query.limit(MAX_REFERENCES+1)).all()
    if len(rows)>MAX_REFERENCES:raise ValueError('Reference limit reached; no duplicate rows in this group were removed')
    return rows


def merge_status(first,second):
    # No unresolved work is converted to a successful task during compaction.
    if first not in ('complete','pending','failed','uncertain') or second not in ('complete','pending','failed','uncertain'):
        raise ValueError('Unfinished or unknown Details task status requires review')
    for value in ('uncertain','failed','pending'):
        if value in (first,second):return value
    if first==second=='complete':return 'complete'
    raise ValueError('Unfinished or unknown Details task status requires review')


def apply_group(session,member_ids):
    identity.identity_lock(session)
    rows,truncated=metadata(session,ids=member_ids)
    if truncated or len(rows)!=len(member_ids):raise ValueError('Source group changed; rerun preview')
    if len({exact_key(row) for row in rows})!=1:raise ValueError('Coordinates or identity changed; rerun preview')
    plan=decision(session,rows)
    if plan['state']!='ready':return plan
    root=UUID(plan['canonical_id']);keeper=UUID(plan['keeper_id']);deleted={UUID(key) for key in plan['delete_ids']}
    original_links=[record(row) for row in bounded(session,select(PoiPlaceLink).where(
        or_(PoiPlaceLink.source_id.in_(deleted),PoiPlaceLink.canonical_id.in_(deleted))))]
    original_aliases=[record(row) for row in bounded(session,select(PoiProviderAlias).where(PoiProviderAlias.place_id.in_(deleted)))]
    # This linkage preserves every user-history identity before source removal.
    identity.link_members(session,root,set(member_ids),actor='exact-duplicate-cleanup',reason='exact_coordinates')
    places=session.scalars(select(PoiPlace).where(PoiPlace.id.in_(deleted)).order_by(PoiPlace.id).with_for_update()).all()
    storage=identity.collection_row(session,'neshan',root,preferred_source=keeper).id
    tasks=bounded(session,select(PoiDetailTask).where(PoiDetailTask.place_id.in_(deleted)))
    if any(task.status in ('processing','running') for task in tasks):raise ValueError('Details task still processing; resolve interrupted work first')
    reviews=bounded(session,select(PoiDuplicateReview).where(or_(PoiDuplicateReview.place_id.in_(deleted),PoiDuplicateReview.other_place_id.in_(deleted))))
    aliases=bounded(session,select(PoiProviderAlias).where(PoiProviderAlias.place_id.in_(deleted)))
    events=bounded(session,select(PoiCanonicalEvent).where(PoiCanonicalEvent.canonical_id.in_(deleted)))
    task_ids={task.id for task in tasks}
    requests=bounded(session,select(PoiRequest).where(PoiRequest.target_type!='segment',PoiRequest.target_id.in_(task_ids))) if task_ids else []
    keeper_tasks=bounded(session,select(PoiDetailTask).where(PoiDetailTask.place_id==storage,PoiDetailTask.job_id.in_({task.job_id for task in tasks}))) if tasks else []
    if any(task.status not in ('complete','pending','failed','uncertain') for task in tasks+keeper_tasks):
        raise ValueError('Unfinished or unknown Details task status requires review')
    categories=list(session.execute(select(PoiPlaceCategory.place_id,PoiPlaceCategory.category).where(PoiPlaceCategory.place_id.in_(deleted))))
    for place in places:
        snapshot=dict(place=source_record(session,place),categories=[category for source,category in categories if source==place.id],
            detail_tasks=[record(task) for task in tasks if task.place_id==place.id],keeper_tasks_before=[record(task) for task in keeper_tasks],
            duplicate_reviews=[record(row) for row in reviews if place.id in (row.place_id,row.other_place_id)],
            provider_aliases=[row for row in original_aliases if row['place_id']==str(place.id)],
            source_links_before=[row for row in original_links if str(place.id) in (row['source_id'],row['canonical_id'])],
            canonical_events=[record(row) for row in events if row.canonical_id==place.id],
            task_requests_before=[record(row) for row in requests])
        # Fail inside this transaction before any deletion if a snapshot cannot
        # be retained; hashes and Details are never printed to the terminal.
        if len(json.dumps(snapshot,ensure_ascii=True,allow_nan=False))>16*1024*1024:raise ValueError('Recovery snapshot exceeds the per-source limit')
        identity.retire_source(session,place.id,root,snapshot,plan['category'],actor='exact-duplicate-cleanup')
        identity.remember_token(session,place.provider,place.provider_id,storage)
    for alias in aliases:alias.place_id=storage
    for event in events:event.canonical_id=root
    for source,category in categories:
        session.execute(insert(PoiPlaceCategory).values(place_id=keeper,category=category).on_conflict_do_nothing())
    by_job={task.job_id:task for task in keeper_tasks}
    for task in tasks:
        kept=by_job.get(task.job_id)
        if kept is None:task.place_id=storage;by_job[task.job_id]=task
        else:
            kept.status=merge_status(kept.status,task.status);kept.attempts=max(kept.attempts,task.attempts)
            session.execute(update(PoiRequest).where(PoiRequest.target_type!='segment',PoiRequest.target_id==task.id).values(target_id=kept.id))
            session.delete(task)
    # Retain review decisions in the recovery snapshots, remapping only their
    # current pointers; self-pairs are obsolete after identity consolidation.
    copied=[record(row) for row in reviews]
    for row in reviews:session.delete(row)
    session.flush()
    for row in copied:
        first=UUID(row['place_id']);second=UUID(row['other_place_id'])
        first=root if first in deleted else first;second=root if second in deleted else second
        if first==second:continue
        first,second=sorted((first,second),key=str)
        session.execute(insert(PoiDuplicateReview).values(place_id=first,other_place_id=second,reason=row['reason'],status=row['status']).on_conflict_do_nothing())
    session.execute(delete(PoiPlaceCategory).where(PoiPlaceCategory.place_id.in_(deleted)))
    session.execute(delete(PoiPlaceLink).where(PoiPlaceLink.source_id.in_(deleted)))
    session.flush()
    for place in places:session.delete(place)
    session.flush()
    return dict(state='deleted',canonical_id=str(root),keeper_id=str(keeper),deleted_source_rows=len(deleted),
        archived_source_ids=sorted(map(str,deleted)))


@contextmanager
def write_session(connection,expected):
    from sqlalchemy.orm import Session
    with connection.begin():
        connection.exec_driver_sql("SET LOCAL lock_timeout='5s'")
        connection.exec_driver_sql("SET LOCAL statement_timeout='30s'")
        with Session(bind=connection,expire_on_commit=False) as session:
            check_database(session,expected)
            control=session.get(PoiControl,1)
            if control and (not control.paused or control.in_flight):raise ValueError('Pause collection and stop the worker before cleanup')
            identity.identity_lock(session);verify_foreign_keys(session)
            yield session;session.flush()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply',action='store_true')
    parser.add_argument('--expect-database',required=True)
    parser.add_argument('--province')
    parser.add_argument('--category')
    parser.add_argument('--row-limit',type=int,default=100000)
    args=parser.parse_args()
    if not 1<=args.row_limit<=200000:parser.error('--row-limit must be between 1 and 200000')
    from backend import database
    from backend.poi import LOCK_KEY
    from sqlalchemy.orm import Session
    results=[]
    try:
        with database.engine.connect().execution_options(isolation_level='READ COMMITTED') as connection:
            locked=False
            try:
                if args.apply:
                    locked=connection.scalar(select(func.pg_try_advisory_lock(LOCK_KEY)));connection.commit()
                    if not locked:raise ValueError('Stop the collector worker before applying cleanup')
                with connection.begin():
                    connection.exec_driver_sql('SET TRANSACTION READ ONLY')
                    connection.exec_driver_sql("SET LOCAL statement_timeout='30s'")
                    with Session(bind=connection) as session:
                        actual=check_database(session,args.expect_database)
                        report=preview(session,args.province,args.category,args.row_limit)
                if report['truncated'] and args.apply:raise ValueError('Scan truncated; narrow the province/category scope before deleting')
                if args.apply:
                    for group in report['groups']:
                        if group['state']!='ready':continue
                        with write_session(connection,args.expect_database) as session:
                            result=apply_group(session,{UUID(key) for key in group['member_ids']})
                        results.append(result)
                print(json.dumps(dict(database=actual,mode='apply' if args.apply else 'dry_run',provider_calls_made=0,
                    **report,deleted_source_rows=sum(result.get('deleted_source_rows',0) for result in results),results=results),indent=2,ensure_ascii=True))
            finally:
                if locked:
                    connection.rollback();connection.execute(select(func.pg_advisory_unlock(LOCK_KEY)));connection.commit()
    except Exception as error:
        print(json.dumps(dict(status='cleanup_stopped',error_type=type(error).__name__,
            committed_groups=len(results),deleted_source_rows=sum(result.get('deleted_source_rows',0) for result in results),
            reason=str(error) if isinstance(error,(ValueError,identity.IdentityConflict)) else 'Database details suppressed')))
        raise SystemExit(2)


if __name__=='__main__':main()

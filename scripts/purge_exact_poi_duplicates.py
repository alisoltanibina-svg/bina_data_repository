"""Archive and physically remove exact-coordinate duplicate Neshan source rows.

Preview: python -m scripts.purge_exact_poi_duplicates --expect-database appdb_test
Apply:   python -m scripts.purge_exact_poi_duplicates --apply --expect-database appdb_test

Requires migration 0031. Stop the API and worker and pause collection before
applying. No provider request is made. Stored X/Y floats must be exactly equal:
no rounding, distance tolerance, hash comparison, or nearest-point selection.
Category and normalized province/name must also match. Conflicting independent
user histories, conflicting source details, and re-imported archived UUIDs
remain for explicit reconciliation; nothing is cascaded away. Equal map
coordinates alone cannot prove that two real-world venues are the same.
"""
import argparse
from collections import Counter,defaultdict
from contextlib import contextmanager
from datetime import date,datetime,timezone
import json
import math
from uuid import UUID
from sqlalchemy import select,func,or_,delete,update,text,bindparam
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
MUTATED_MODELS=(PoiPlace,PoiPlaceCategory,PoiDetailTask,PoiDuplicateReview,PoiPlaceLink,
    PoiProviderAlias,PoiCanonicalEvent,PoiRetiredPlace,PoiRequest)
DELETED_TABLES=('poi_detail_tasks','poi_duplicate_reviews','poi_place_categories','poi_place_links')
TRIGGER_EVENTS={'poi_places':8,'poi_place_categories':12,'poi_detail_tasks':24,
    'poi_duplicate_reviews':12,'poi_place_links':28,'poi_provider_aliases':20,
    'poi_canonical_events':20,'poi_retired_places':20,'poi_requests':16}


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


def source_signature(row,categories):
    """Conservative evidence comparison, independent of rotating provider IDs.

    Identity spelling and numeric coordinate representations may differ; all
    remaining Details and administrative/contact fields must agree. A sparse
    observation does not silently replace a richer one in the live database.
    """
    from backend.poi_provider import coordinates
    if not isinstance(row.provider_id,str) or not 0<len(row.provider_id)<=2048:
        raise ValueError('invalid_source_token')
    raw=row.raw_details
    if not isinstance(raw,dict) or not isinstance(raw.get('name'),str) or normalized(raw['name'])!=normalized(row.name):
        raise ValueError('inconsistent_source_name')
    layer=raw.get('layer')
    if layer is not None and not isinstance(layer,dict):raise ValueError('invalid_source_category')
    category=(layer or {}).get('slug')
    if category is not None and not isinstance(category,str):raise ValueError('invalid_source_category')
    if category and categories and category not in categories:
        raise ValueError('inconsistent_source_category')
    if not category and len(categories)!=1:raise ValueError('ambiguous_source_category')
    if raw.get('address') is not None and row.address is not None and raw['address']!=row.address:
        raise ValueError('inconsistent_source_address')
    try:
        latitude,longitude=coordinates(raw.get('location'))
        if not (24<=latitude<=41 and 43<=longitude<=64):raise ValueError()
        if (latitude,longitude)!=(row.latitude,row.longitude):raise ValueError()
        for key,expected in (('x',longitude),('longitude',longitude),('y',latitude),('latitude',latitude)):
            value=raw['location'].get(key,expected)
            if isinstance(value,bool) or not math.isfinite(float(value)) or float(value)!=expected:raise ValueError()
    except (ValueError,TypeError,OverflowError):raise ValueError('inconsistent_source_coordinates') from None
    # Keep extra location metadata (e.g. floor/accuracy) in the comparison.
    location={key:value for key,value in raw['location'].items() if key not in ('x','y','latitude','longitude')}
    details={key:value for key,value in raw.items() if key not in ('name','location','poiHash')}
    columns={key:getattr(row,key) for key in ('address','address_province','address_county','address_city',
        'address_parse_status','county_name','spatial_status')}
    return json.dumps(dict(details=details,location_metadata=location,columns=columns,categories=sorted(categories)),sort_keys=True,ensure_ascii=True,allow_nan=False)


def source_evidence_reason(session,ids):
    if session.scalar(select(PoiRetiredPlace.source_id).where(PoiRetiredPlace.source_id.in_(ids)).limit(1)):
        return 'restored_retired_source_requires_review'
    if session.scalar(select(PoiDuplicateReview.place_id).where(PoiDuplicateReview.place_id.in_(ids),
            PoiDuplicateReview.other_place_id.in_(ids),PoiDuplicateReview.status!='pending').limit(1)):
        return 'existing_duplicate_review_decision'
    sources=session.scalars(select(PoiPlace).where(PoiPlace.id.in_(ids))).all()
    if len(sources)!=len(ids):return 'source_group_changed'
    categories=defaultdict(set)
    for key,category in session.execute(select(PoiPlaceCategory.place_id,PoiPlaceCategory.category).where(PoiPlaceCategory.place_id.in_(ids))):
        categories[key].add(category)
    try:signatures={source_signature(row,categories[row.id]) for row in sources}
    except ValueError as error:return str(error)
    except (TypeError,OverflowError):return 'invalid_source_details'
    return 'conflicting_source_details' if len(signatures)!=1 else None


def review_merge_reason(session,root,roots,members):
    """Never turn a recorded distinct/rejected decision into a pending pair."""
    reviews=bounded(session,select(PoiDuplicateReview).where(
        or_(PoiDuplicateReview.place_id.in_(members),PoiDuplicateReview.other_place_id.in_(members))))
    projected={};statuses=defaultdict(set)
    def target(key):
        if key not in projected:
            current=identity.canonical_id(session,key);projected[key]=root if current in roots else current
        return projected[key]
    for review in reviews:
        first,second=target(review.place_id),target(review.other_place_id)
        if first==second:
            if review.status!='pending':return 'existing_duplicate_review_decision'
            continue
        pair=tuple(sorted((first,second),key=str));statuses[pair].add(review.status)
        if len(statuses[pair])>1:return 'conflicting_duplicate_reviews'
    return None


def decision(session,rows):
    ids={row.id for row in rows}
    if len(ids)<2 or len(ids)!=len(rows) or len({exact_key(row) for row in rows})!=1:
        return dict(state='review_required',reason='not_exact_duplicates',member_ids=sorted(map(str,ids)))
    if len(ids)>identity.MAX_MEMBERS:
        return dict(state='review_required',reason='canonical_group_too_large',member_ids=sorted(map(str,ids)))
    reason=source_evidence_reason(session,ids)
    if reason:return dict(state='review_required',reason=reason,member_ids=sorted(map(str,ids)))
    roots={identity.canonical_id(session,key) for key in ids}
    expanded=set(ids)
    for root in roots:expanded.update(identity.member_ids(session,root))
    protected={identity.canonical_id(session,key) for key in history_places(session,expanded)}
    if len(roots)>1 and len(protected)>1:
        return dict(state='review_required',reason='conflicting_user_histories',member_ids=sorted(map(str,ids)))
    root=next(iter(roots)) if len(roots)==1 else next(iter(protected)) if len(protected)==1 else min(rows,key=rank).id
    keeper=root if root in ids else min(rows,key=rank).id
    reason=review_merge_reason(session,root,roots,expanded)
    if reason:return dict(state='review_required',reason=reason,member_ids=sorted(map(str,ids)))
    try:
        if len(roots)>1:
            # Expanding an earlier 20-metre group must not hide another place
            # while this command claims to perform exact-coordinate cleanup.
            members=identity.retained_sources(session,expanded);positions=identity.positions(session,members)
            expected=exact_key(rows[0])
            if any((member.provider,positions[member.id].category,normalized(positions[member.id].province),
                    normalized(positions[member.id].name),positions[member.id].latitude,positions[member.id].longitude)!=expected for member in members):
                return dict(state='review_required',reason='non_exact_canonical_members',member_ids=sorted(map(str,ids)))
            if any(hasattr(member,'_retired_category') for member in members):
                return dict(state='review_required',reason='archived_canonical_group_requires_review',member_ids=sorted(map(str,ids)))
            reason=source_evidence_reason(session,expanded)
            if reason:return dict(state='review_required',reason=reason,member_ids=sorted(map(str,ids)))
        identity.validate_members(session,root,ids)
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
    if session.get_bind().dialect.name!='postgresql':return []
    tables=[model.__tablename__ for model in MUTATED_MODELS]
    columns=defaultdict(set)
    query=text("""SELECT rel.relname,att.attname FROM pg_attribute att
        JOIN pg_class rel ON rel.oid=att.attrelid JOIN pg_namespace ns ON ns.oid=rel.relnamespace
        WHERE ns.nspname='poi' AND rel.relname IN :tables AND att.attnum>0 AND NOT att.attisdropped""").bindparams(bindparam('tables',expanding=True))
    for table,column in session.execute(query,dict(tables=tables)):columns[table].add(column)
    for model in MUTATED_MODELS:
        if columns[model.__tablename__]!={column.name for column in model.__table__.columns}:
            message='Unexpected place columns' if model is PoiPlace else 'Unexpected cleanup table columns: '+model.__tablename__
            raise ValueError(message+' require review before cleanup')
    rows=session.execute(text("""SELECT ns.nspname, rel.relname, att.attname
        FROM pg_constraint con JOIN pg_class rel ON rel.oid=con.conrelid
        JOIN pg_namespace ns ON ns.oid=rel.relnamespace
        JOIN pg_attribute att ON att.attrelid=rel.oid AND att.attnum=ANY(con.conkey)
        WHERE con.contype='f' AND con.confrelid='poi.poi_places'::regclass""")).all()
    unknown=[f'{schema}.{table}.{column}' for schema,table,column in rows
        if schema!='poi' or (table,column) not in KNOWN_REFERENCES]
    if unknown:raise ValueError('Unsupported place foreign keys: '+', '.join(sorted(unknown)))
    incoming=text("""SELECT rel.relname FROM pg_constraint con JOIN pg_class rel ON rel.oid=con.confrelid
        JOIN pg_namespace ns ON ns.oid=rel.relnamespace
        WHERE con.contype='f' AND ns.nspname='poi' AND rel.relname IN :tables LIMIT 1""").bindparams(bindparam('tables',expanding=True))
    if session.scalar(incoming,dict(tables=list(DELETED_TABLES))):
        raise ValueError('Unsupported foreign keys on cleanup child tables require review')
    triggers=text("""SELECT rel.relname,tg.tgtype FROM pg_trigger tg
        JOIN pg_class rel ON rel.oid=tg.tgrelid JOIN pg_namespace ns ON ns.oid=rel.relnamespace
        WHERE ns.nspname='poi' AND rel.relname IN :tables AND NOT tg.tgisinternal AND tg.tgenabled<>'D'""").bindparams(bindparam('tables',expanding=True))
    for table,events in session.execute(triggers,dict(tables=tables)):
        if events & TRIGGER_EVENTS[table]:
            raise ValueError('Custom place deletion triggers require explicit review' if table=='poi_places' else 'Custom cleanup triggers require explicit review')
    return rows


def verify_no_references(session,ids):
    """Fail before DELETE even if a known FK was changed to ON DELETE CASCADE."""
    references=verify_foreign_keys(session)
    quote=session.get_bind().dialect.identifier_preparer.quote
    for schema,table,column in references:
        statement=text(f'SELECT 1 FROM {quote(schema)}.{quote(table)} WHERE {quote(column)} IN :ids LIMIT 1').bindparams(bindparam('ids',expanding=True))
        if session.scalar(statement,dict(ids=list(ids))):
            raise ValueError('Unmoved place reference: '+'.'.join((schema,table,column)))


def lock_cleanup_tables(session):
    if session.get_bind().dialect.name!='postgresql':return
    quote=session.get_bind().dialect.identifier_preparer.quote
    tables=', '.join(quote(model.__table__.schema)+'.'+quote(model.__tablename__) for model in MUTATED_MODELS)
    session.execute(text('LOCK TABLE '+tables+' IN SHARE ROW EXCLUSIVE MODE'))


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
    lock_cleanup_tables(session);verify_foreign_keys(session)
    member_ids={UUID(str(value)) for value in member_ids}
    if len(member_ids)<2:raise ValueError('At least two distinct source rows are required')
    lock_ids=set(member_ids)
    for key in member_ids:lock_ids.update(identity.member_ids(session,key))
    if len(lock_ids)>identity.MAX_MEMBERS:raise ValueError('Canonical group is too large for automatic cleanup')
    # Lock before reading identity/evidence, not after deciding what to delete.
    # This also prevents new FK references to these rows during compaction.
    session.scalars(select(PoiPlace).where(PoiPlace.id.in_(lock_ids)).order_by(PoiPlace.id).with_for_update()
        .execution_options(populate_existing=True)).all()
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
    task_jobs={task.id:task.job_id for task in tasks}
    if any(request.kind!='details' or request.job_id!=task_jobs[request.target_id] for request in requests):
        raise ValueError('Ambiguous Details request references require review')
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
    archives={row.source_id:row for row in session.scalars(select(PoiRetiredPlace).where(PoiRetiredPlace.source_id.in_(deleted))).all()}
    for place in places:
        archived=archives.get(place.id)
        if not archived or archived.canonical_id!=root or archived.snapshot.get('place')!=source_record(session,place):
            raise ValueError('Recovery snapshot does not match the source being removed')
    verify_no_references(session,deleted)
    removed=set(session.scalars(delete(PoiPlace).where(PoiPlace.id.in_(deleted)).returning(PoiPlace.id)).all())
    if removed!=deleted:raise ValueError('Source deletion did not match the reviewed group')
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
            control=session.scalar(select(PoiControl).where(PoiControl.id==1).with_for_update())
            if not control or not control.paused or control.in_flight is not None:raise ValueError('Pause collection and stop the worker before cleanup')
            # Block concurrent direct source writes and schema changes too;
            # application readers can continue, but API writers must be stopped.
            identity.identity_lock(session)
            lock_cleanup_tables(session)
            verify_foreign_keys(session)
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
                        verify_foreign_keys(session)
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

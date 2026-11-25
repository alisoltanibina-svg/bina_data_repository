"""Reconcile permitted Details records without deleting sources or user history.

Dry-run is the default and uses a read-only database transaction:
  venv/bin/python -m scripts.reconcile_poi_places
  venv/bin/python -m scripts.reconcile_poi_places --province NAME --category mosque

--apply links only complete-link groups with at most one history-bearing
canonical member. Groups containing conflicting user work remain unchanged.
Every apply requires --expect-database NAME, checked before every write:
  ... --apply --expect-database appdb_test
For an explicitly reviewed group, choose its surviving public projection:
  ... --canonical UUID --members UUID UUID --apply --expect-database appdb_test

Scans above --row-limit are reported as incomplete and cannot be applied.
For larger collections, reconcile each province/category separately.

This command never calls Neshan or copies/reparents edits, photos, or awards.
It uses only the successful Details records already retained in the database.
"""
import argparse
from collections import defaultdict
from contextlib import contextmanager
from datetime import timezone
import hashlib
import json
import re
from uuid import UUID


class DatabaseMismatch(ValueError):
    def __init__(self,actual,expected):
        self.database=actual;self.expected_database=expected
        super().__init__('configured_database_mismatch')


def check_database(session,expected=None):
    from sqlalchemy import text
    actual=session.scalar(text('SELECT current_database()'))
    if expected is not None and actual!=expected:raise DatabaseMismatch(actual,expected)
    return actual


def _rank(row):
    stamp=row.discovered_at
    if stamp and stamp.tzinfo is None:stamp=stamp.replace(tzinfo=timezone.utc)
    return (stamp.timestamp() if stamp else float('inf'),str(row.id))


def _root(identity,links):
    seen=set()
    while identity in links and links[identity]!=identity:
        if identity in seen:raise ValueError('canonical_cycle_detected')
        seen.add(identity);identity=links[identity]
    return identity


def plan_groups(rows,links,history_ids):
    """Distance is not transitive; a chain is always left for explicit review."""
    from backend.poi_place_matching import normalized
    from scripts.audit_poi_quality import duplicate_candidates
    buckets=defaultdict(list)
    for row in rows:
        if row.category and normalized(row.province_name) and normalized(row.name):
            buckets[(row.provider,row.category,normalized(row.province_name),normalized(row.name))].append(row)
    lookup={str(row.id):row for row in rows};groups=[];truncated=False
    history_roots={_root(identity,links) for identity in history_ids}
    for bucket in buckets.values():
        candidates=duplicate_candidates(bucket)
        truncated |= candidates['truncated']
        for candidate in candidates['groups']:
            members=[lookup[value] for value in candidate['source_ids']]
            roots={_root(row.id,links) for row in members}
            protected=roots & history_roots
            if len(roots)==1:state='already_linked'
            elif not candidate['all_members_within_20m'] or candidates['truncated']:state='distance_chain_requires_review'
            elif len(protected)>1:state='multiple_user_histories_require_review'
            else:state='safe_to_link'
            canonical=next(iter(protected)) if len(protected)==1 else min(members,key=_rank).id
            canonical=_root(canonical,links)
            groups.append(dict(state=state,canonical_id=str(canonical),member_ids=sorted(str(row.id) for row in members),
                history_canonical_ids=sorted(map(str,protected)),category=members[0].category,province=members[0].province_name,
                all_members_within_20m=candidate['all_members_within_20m']))
    groups.sort(key=lambda group:(group['state'],group['canonical_id']))
    return dict(groups=groups,truncated=truncated)


def history_places(session,ids):
    """A baseline observation alone is not conflicting user work."""
    from sqlalchemy import select,or_
    from backend.poi_editorial_models import PoiEditorial,PoiEditRevision,PoiContributionAward,PoiPlacePhoto
    if not ids:return set()
    history=set();values=list(ids)
    for offset in range(0,len(values),1000):
        batch=values[offset:offset+1000]
        history.update(session.scalars(select(PoiEditorial.place_id).where(PoiEditorial.place_id.in_(batch),
            or_(PoiEditorial.version>0,PoiEditorial.published_version>0))).all())
        for model in (PoiEditRevision,PoiContributionAward,PoiPlacePhoto):
            history.update(session.scalars(select(model.place_id).where(model.place_id.in_(batch))).all())
    return history


def relevant_links(session,ids,link_limit=200000):
    from sqlalchemy import select,or_,union_all
    from backend.poi_models import PoiPlaceLink,PoiRetiredPlace
    links={};seen=set();frontier=set(ids)
    while frontier:
        batch=list(frontier)[:1000];frontier.difference_update(batch);seen.update(batch)
        routes=union_all(select(PoiPlaceLink.source_id,PoiPlaceLink.canonical_id).where(
            or_(PoiPlaceLink.source_id.in_(batch),PoiPlaceLink.canonical_id.in_(batch))),
            select(PoiRetiredPlace.source_id,PoiRetiredPlace.canonical_id).where(
                or_(PoiRetiredPlace.source_id.in_(batch),PoiRetiredPlace.canonical_id.in_(batch)))).subquery()
        rows=session.execute(select(routes.c.source_id,routes.c.canonical_id).limit(link_limit+1)).all()
        for source,target in rows:
            if source in links and links[source]!=target:raise ValueError('conflicting_source_routes')
            links[source]=target
            frontier.update({source,target}-seen)
        if len(links)>link_limit or len(frontier)+len(seen)>link_limit*2:
            raise ValueError('canonical_link_scan_limit_reached_narrow_the_scope')
    return links


def read_plan(session,province=None,category=None,row_limit=100000):
    from sqlalchemy import select,func
    from backend.poi_models import PoiPlace,PoiPlaceCategory
    from backend.poi_place_matching import normalized
    slug=PoiPlace.raw_details['layer']['slug'].as_string()
    fallback=select(func.min(PoiPlaceCategory.category)).where(PoiPlaceCategory.place_id==PoiPlace.id).having(func.count()==1).scalar_subquery()
    category_value=func.coalesce(func.nullif(slug,''),fallback)
    query=select(PoiPlace.id,PoiPlace.provider,PoiPlace.name,PoiPlace.latitude,PoiPlace.longitude,PoiPlace.province_name,
        PoiPlace.discovered_at,category_value.label('category')).where(PoiPlace.provider=='neshan',PoiPlace.resolved_at.is_not(None))
    if province:
        province_value=func.lower(func.trim(func.regexp_replace(func.replace(func.translate(PoiPlace.province_name,'يك','یک'),'\u200c',' '),r'\s+',' ','g')))
        query=query.where(province_value==normalized(province))
    if category:query=query.where(category_value==category)
    rows=session.execute(query.order_by(PoiPlace.id).limit(row_limit+1)).all();truncated=len(rows)>row_limit;rows=rows[:row_limit]
    ids={row.id for row in rows};links=relevant_links(session,ids)
    expanded=ids|{_root(identity,links) for identity in ids}
    expanded|={identity for identity in links if _root(identity,links) in expanded}
    history=history_places(session,expanded)
    plan=plan_groups(rows,links,history)
    return dict(source_rows_inspected=len(rows),truncated=truncated or plan['truncated'],groups=plan['groups'])


def apply_group(session,canonical,members,explicit=False,expected_review=None):
    from sqlalchemy import select
    from backend.poi_models import PoiPlace
    from backend import poi_canonical as identities
    identities.identity_lock(session)
    canonical=canonical if explicit else identities.canonical_id(session,canonical)
    expanded=set(members)|{canonical}
    for identity in list(expanded):expanded.update(identities.member_ids(session,identity))
    session.scalars(select(PoiPlace).where(PoiPlace.id.in_(expanded)).order_by(PoiPlace.id).with_for_update()).all()
    if len(identities.retained_sources(session,expanded))!=len(expanded):raise ValueError('source_member_not_found')
    if explicit and expected_review and review_explicit_group(session,canonical,expanded)['review_fingerprint']!=expected_review:
        raise ValueError('explicit_review_changed_rerun_dry_run')
    protected={identities.canonical_id(session,value) for value in history_places(session,expanded)}
    if not explicit and (len(protected)>1 or protected and canonical not in protected):
        return dict(status='skipped',reason='user_history_changed_requires_new_review',canonical_id=str(canonical))
    linked=identities.link_members(session,canonical,expanded,actor='reconcile_poi_places',
        reason='explicit_review' if explicit else 'category-distance-province-name')
    return dict(status='linked',canonical_id=str(canonical),member_ids=sorted(map(str,linked)))


def review_explicit_group(session,canonical,members):
    from sqlalchemy import select
    from backend import poi_canonical as identities
    from backend.poi_editorial_models import PoiEditRevision,PoiEditorial
    expanded=identities.validate_members(session,canonical,members)
    pending=session.execute(select(PoiEditRevision.id,PoiEditRevision.place_id).where(
        PoiEditRevision.place_id.in_(expanded),PoiEditRevision.place_id!=canonical,PoiEditRevision.status=='pending')).all()
    versions=session.execute(select(PoiEditorial.place_id,PoiEditorial.version,PoiEditorial.published_version).where(PoiEditorial.place_id.in_(expanded))).all()
    result=dict(canonical_id=str(canonical),member_ids=sorted(map(str,expanded)),
        other_history_source_ids=sorted(str(value) for value in history_places(session,expanded) if value!=canonical),
        pending_alias_revision_ids=sorted(str(row.id) for row in pending),
        pending_alias_resubmit_canonical=bool(pending))
    fingerprint={**result,'editorial_versions':sorted((str(row.place_id),row.version,row.published_version) for row in versions)}
    result['review_fingerprint']=hashlib.sha256(json.dumps(fingerprint,sort_keys=True).encode()).hexdigest()
    return result


@contextmanager
def write_session(engine,expected_database):
    from sqlalchemy.orm import Session
    with engine.connect().execution_options(isolation_level='READ COMMITTED') as connection:
        with connection.begin():
            connection.exec_driver_sql("SET LOCAL lock_timeout = '5s'")
            connection.exec_driver_sql("SET LOCAL statement_timeout = '30s'")
            with Session(bind=connection) as session:
                check_database(session,expected_database)
                yield session
                session.flush()


def _summary(plan):
    from collections import Counter
    return dict(source_rows_inspected=plan['source_rows_inspected'],truncated=plan['truncated'],
        group_counts=dict(Counter(group['state'] for group in plan['groups'])),groups=plan['groups'])


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--province')
    parser.add_argument('--category')
    parser.add_argument('--apply',action='store_true')
    parser.add_argument('--expect-database',help='Required with --apply; fail unless current_database() matches exactly')
    parser.add_argument('--canonical',type=UUID)
    parser.add_argument('--members',type=UUID,nargs='+')
    parser.add_argument('--api-pid',type=int)
    parser.add_argument('--row-limit',type=int,default=100000)
    args=parser.parse_args()
    if args.apply and not args.expect_database:parser.error('--apply requires --expect-database NAME')
    if bool(args.canonical)!=bool(args.members):parser.error('--canonical and --members must be supplied together')
    if args.canonical and len({args.canonical,*args.members})<2:parser.error('Select at least two distinct source records')
    if not 1<=args.row_limit<=200000:parser.error('--row-limit must be between 1 and 200000')
    try:
        if args.api_pid:
            from scripts.diagnose_poi_identity import use_process_settings
            use_process_settings(args.api_pid)
        from backend import database
        from backend.poi_canonical import IdentityConflict
        from sqlalchemy.orm import Session
        report=dict(mode='apply' if args.apply else 'dry_run',provider_calls_made=0)
        if args.canonical:
            with database.engine.connect().execution_options(isolation_level='REPEATABLE READ') as connection:
                with connection.begin():
                    connection.exec_driver_sql('SET TRANSACTION READ ONLY')
                    connection.exec_driver_sql("SET LOCAL statement_timeout = '30s'")
                    with Session(bind=connection) as session:
                        report['database']=check_database(session,args.expect_database)
                        report['explicit_group']=review_explicit_group(session,args.canonical,set(args.members))
            if args.apply:
                with write_session(database.engine,args.expect_database) as session:
                    report['explicit_result']=apply_group(session,args.canonical,set(args.members),explicit=True,
                        expected_review=report['explicit_group']['review_fingerprint'])
        else:
            with database.engine.connect().execution_options(isolation_level='REPEATABLE READ') as connection:
                with connection.begin():
                    connection.exec_driver_sql('SET TRANSACTION READ ONLY')
                    connection.exec_driver_sql("SET LOCAL statement_timeout = '30s'")
                    connection.exec_driver_sql("SET LOCAL lock_timeout = '2s'")
                    with Session(bind=connection) as session:
                        report['database']=check_database(session,args.expect_database)
                        plan=read_plan(session,args.province,args.category,args.row_limit)
            report.update(_summary(plan));report['applied_groups']=[]
            if args.apply:
                if plan['truncated']:raise ValueError('scan_limit_reached_narrow_the_scope_before_applying')
                for group in plan['groups']:
                    if group['state']!='safe_to_link':continue
                    try:
                        with write_session(database.engine,args.expect_database) as session:
                            result=apply_group(session,UUID(group['canonical_id']),{UUID(value) for value in group['member_ids']})
                        report['applied_groups'].append(result)
                    except (IdentityConflict,ValueError) as error:
                        report['applied_groups'].append(dict(status='skipped',reason=str(error),canonical_id=group['canonical_id']))
        print(json.dumps(report,indent=2,ensure_ascii=True))
    except Exception as error:
        reason=getattr(error,'reason',None)
        if not isinstance(reason,str) or not re.fullmatch('[a-z_]+',reason):
            reason=str(error) if isinstance(error,ValueError) and re.fullmatch('[a-z_]+',str(error)) else 'details_suppressed'
        failure=dict(status='reconciliation_unavailable',error_type=type(error).__name__,reason=reason)
        if isinstance(error,DatabaseMismatch):failure.update(database=error.database,expected_database=error.expected_database)
        print(json.dumps(failure))
        raise SystemExit(2)


if __name__=='__main__':main()

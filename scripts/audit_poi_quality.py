"""Read-only duplicate and collection audit. No Neshan requests or data changes.

Run in the API checkout:
  venv/bin/python -m scripts.audit_poi_quality
  venv/bin/python -m scripts.audit_poi_quality --point 38.0685335 46.2496286

Defaults to East Azerbaijan/mosques. --point takes latitude then longitude and
checks historical search circles around a known missing place. --api-pid reads
the running API's settings on Linux, without printing credentials.
"""
import argparse
from collections import Counter, defaultdict
import json
import math


def duplicate_candidates(rows, pair_limit=100000):
    """Review candidates, never an instruction to merge a transitive cluster."""
    from backend.poi_place_matching import SpatialIndex, Variant
    variants=[Variant(r.id,r.name,r.latitude,r.longitude,r.province_name,False) for r in rows]
    index=SpatialIndex(variants);graph=defaultdict(set);pairs=0;truncated=False
    for row in rows:
        for other in index.matches(row,row.province_name):
            if str(other.place_id)<=str(row.id):continue
            if pairs>=pair_limit:truncated=True;break
            graph[row.id].add(other.place_id);graph[other.place_id].add(row.id);pairs+=1
        if truncated:break
    seen=set();groups=[]
    for key in graph:
        if key in seen:continue
        stack=[key];members=[];seen.add(key)
        while stack:
            current=stack.pop();members.append(current)
            for peer in graph[current]:
                if peer not in seen:seen.add(peer);stack.append(peer)
        # A~B and B~C do NOT imply A~C under the 20-metre rule.
        all_pairs=len(members)*(len(members)-1)//2
        connected_pairs=sum(len(graph[member]) for member in members)//2
        groups.append(dict(records=len(members),all_members_within_20m=connected_pairs==all_pairs,
            source_ids=sorted(map(str,members))))
    groups.sort(key=lambda group:(-group['records'],group['source_ids']))
    return dict(candidate_pairs=pairs,candidate_groups=len(groups),involved_source_rows=len(seen),
        truncated=truncated,groups=groups)


def summarize_searches(rows, result_limit):
    """Only persisted request counters are inspected; no Nearby payload exists."""
    hist=Counter();outcomes=Counter();last_by_segment={};at_limit=0
    for row in rows:
        outcomes[row.outcome]+=1
        if row.outcome!='successful':continue
        if row.result_count is not None:
            hist[row.result_count]+=1
            if result_limit and row.result_count>=result_limit:at_limit+=1
        previous=last_by_segment.get(row.target_id)
        if previous is None or row.id>previous.id:last_by_segment[row.target_id]=row
    return dict(requests=len(rows),outcomes=dict(outcomes),successful_result_counts=dict(sorted(hist.items())),
        requests_at_configured_limit=at_limit,segments_with_success=len(last_by_segment),
        latest_searches_with_missing_hashes=sum((r.hash_count or 0)<r.result_count for r in last_by_segment.values() if r.result_count is not None))


def audit_database(session, province, category, point=None, row_limit=50000, point_name=None):
    from sqlalchemy import select,func,and_,or_,inspect,text
    from backend.poi_models import PoiPlace,PoiPlaceCategory,PoiJob,PoiCoveragePlan,PoiSegment,PoiRequest
    from backend.poi_place_matching import normalized,distance
    from backend.poi_coverage_state import result_limit_mode,effective_result_limit,discovery_ready
    def province_key(column):
        return func.lower(func.trim(func.regexp_replace(func.replace(func.translate(column,'يك','یک'),'\u200c',' '),r'\s+',' ','g')))
    source_category=PoiPlace.raw_details['layer']['slug'].as_string()
    category_matches=or_(source_category==category,and_(or_(source_category.is_(None),source_category==''),
        select(PoiPlaceCategory.place_id).where(PoiPlaceCategory.place_id==PoiPlace.id,PoiPlaceCategory.category==category).exists()))
    scope=(PoiPlace.provider=='neshan',province_key(PoiPlace.province_name)==normalized(province),category_matches)
    fields=(PoiPlace.id,PoiPlace.name,PoiPlace.latitude,PoiPlace.longitude,PoiPlace.province_name,PoiPlace.resolved_at)
    rows=session.execute(select(*fields).where(*scope).order_by(PoiPlace.id).limit(row_limit+1)).all()
    source_truncated=len(rows)>row_limit;rows=rows[:row_limit]
    duplicates=duplicate_candidates(rows);groups=duplicates.pop('groups');duplicates['source_scan_truncated']=source_truncated
    registry_available=inspect(session.connection()).has_table('poi_place_links',schema='poi')
    links={}
    if registry_available and rows:
        from backend.poi_models import PoiPlaceLink
        links={str(source):str(root) for source,root in session.execute(select(PoiPlaceLink.source_id,PoiPlaceLink.canonical_id)
            .where(PoiPlaceLink.source_id.in_([row.id for row in rows])))}
    duplicates['linked_source_rows']=len(links)
    duplicates['unresolved_candidate_groups']=sum(len({links.get(key,key) for key in group['source_ids']})>1 for group in groups)
    # Bound report size; do not expose tokens, contact information or snapshots.
    samples=groups[:10];example_ids={v for group in samples for v in group['source_ids']}
    sample_ids=[r.id for r in rows if str(r.id) in example_ids]
    editorial={}
    if sample_ids and inspect(session.connection()).has_table('poi_editorial',schema='poi'):
        from backend.poi_editorial_models import PoiEditorial
        editorial={str(r.place_id):r for r in session.execute(select(PoiEditorial.place_id,PoiEditorial.version,PoiEditorial.published_version)
            .where(PoiEditorial.place_id.in_(sample_ids)))}
    for group in samples:
        group['canonical_ids']=sorted({links.get(key,key) for key in group['source_ids']})
        group['edited_source_ids']=[key for key in group['source_ids'] if key in editorial and editorial[key].version]
        group['published_source_ids']=[key for key in group['source_ids'] if key in editorial and editorial[key].published_version]
        group['source_ids']=group['source_ids'][:20]
    duplicates['examples']=samples
    report=dict(database=session.scalar(text('SELECT current_database()')),province=province,category=category,
        provider_calls_made=0,read_only=True,source_rows_inspected=len(rows),
        resolved_rows_inspected=sum(r.resolved_at is not None for r in rows),duplicate_candidates=duplicates,
        canonical_registry_available=registry_available,canonical_places_inspected=len({links.get(str(row.id),str(row.id)) for row in rows}),
        inventory_completeness='not_established_by_search_counters',jobs=[])
    jobs=session.scalars(select(PoiJob).where(PoiJob.provider=='neshan').order_by(PoiJob.created_at.desc(),PoiJob.id.desc()).limit(3)).all()
    for job in jobs:
        plan=session.scalar(select(PoiCoveragePlan).where(PoiCoveragePlan.job_id==job.id))
        kind='coverage' if plan else 'settlement' if job.search_dataset_version else 'grid'
        segment_rows=session.execute(select(PoiSegment.id,PoiSegment.status,PoiSegment.parent_segment_id,
            PoiSegment.pending_details,PoiSegment.review_reason,PoiSegment.latitude,PoiSegment.longitude,PoiSegment.radius_m)
            .where(PoiSegment.job_id==job.id,PoiSegment.kind==kind,PoiSegment.category==category,
                province_key(PoiSegment.province_name)==normalized(province)).order_by(PoiSegment.id).limit(row_limit+1)).all()
        segment_truncated=len(segment_rows)>row_limit;segment_rows=segment_rows[:row_limit]
        request_rows=session.execute(select(PoiRequest.id,PoiRequest.target_id,PoiRequest.outcome,PoiRequest.result_count,PoiRequest.hash_count)
            .join(PoiSegment,and_(PoiRequest.target_type=='segment',PoiRequest.target_id==PoiSegment.id))
            .where(PoiRequest.job_id==job.id,PoiRequest.kind=='nearby',PoiSegment.job_id==job.id,
                PoiSegment.kind==kind,PoiSegment.category==category,province_key(PoiSegment.province_name)==normalized(province))
            .order_by(PoiRequest.id.desc()).limit(row_limit+1)).all()
        request_truncated=len(request_rows)>row_limit;request_rows=request_rows[:row_limit]
        roots=[r for r in segment_rows if r.parent_segment_id is None];limit=plan.result_limit if plan else 0
        flags=[]
        if category not in job.categories:flags.append('category_not_in_job')
        if not plan:flags.append('no_verified_polygon_plan')
        elif not (plan.state=='ready' and (plan.summary or {}).get('coverage_verified')):flags.append('polygon_plan_not_verified')
        if plan and not discovery_ready(plan):flags.append('historical_saturation_repair_pending')
        if any(r.review_reason for r in segment_rows):flags.append('searches_flagged_for_review')
        if any(r.status!='complete' for r in segment_rows):flags.append('unfinished_searches')
        if any(r.pending_details for r in segment_rows):flags.append('details_handoff_not_finished')
        search=summarize_searches(request_rows,limit)
        if search['latest_searches_with_missing_hashes']:flags.append('some_results_lacked_hashes')
        success_ids={r.target_id for r in request_rows if r.outcome=='successful'}
        unrecorded_roots=sum(r.status=='complete' and r.id not in success_ids for r in roots)
        if unrecorded_roots:flags.append('completed_roots_without_successful_search_record')
        if segment_truncated or request_truncated:flags.append('audit_row_limit_reached')
        details_counts=dict(session.execute(select(PoiRequest.outcome,func.count()).join(PoiSegment,
            and_(PoiRequest.target_type=='segment',PoiRequest.target_id==PoiSegment.id)).where(
                PoiRequest.job_id==job.id,PoiRequest.kind=='details',PoiSegment.job_id==job.id,
                PoiSegment.kind==kind,PoiSegment.category==category,province_key(PoiSegment.province_name)==normalized(province))
            .group_by(PoiRequest.outcome)).all())
        item=dict(job_id=str(job.id),job_status=job.status,created_at=job.created_at.isoformat(),kind=kind,
            root_status_counts=dict(Counter(r.status for r in roots)),all_segment_status_counts=dict(Counter(r.status for r in segment_rows)),
            flagged_searches=sum(bool(r.review_reason) for r in segment_rows),pending_details=sum(r.pending_details for r in segment_rows),
            plan_id=str(plan.id) if plan else None,result_limit=limit,result_limit_mode=result_limit_mode(plan) if plan else 'not_a_polygon_plan',
            effective_saturation_trigger=effective_result_limit(plan) if plan else None,
            historical_saturation_reconciled=discovery_ready(plan) if plan else False,
            root_counters_equal=bool(roots and all(r.status=='complete' for r in roots)),
            diagnostic_flags=flags,completed_roots_without_search_record=unrecorded_roots,nearby_searches=search,
            details_request_outcomes=details_counts)
        if point:
            # All provinces: a circle assigned to a neighbouring province may
            # still cover this point. Read geometry/counters only.
            max_radius=session.scalar(select(func.max(PoiSegment.radius_m)).where(PoiSegment.job_id==job.id,
                PoiSegment.kind==kind,PoiSegment.category==category)) or 0
            dy=max_radius/110000;dx=dy/math.cos(math.radians(min(89,abs(point[0])+dy)))
            circles=session.execute(select(PoiSegment.id,PoiSegment.province_name,PoiSegment.status,PoiSegment.pending_details,
                PoiSegment.review_reason,PoiSegment.latitude,PoiSegment.longitude,PoiSegment.radius_m)
                .where(PoiSegment.job_id==job.id,PoiSegment.kind==kind,PoiSegment.category==category,
                    PoiSegment.latitude.between(point[0]-dy,point[0]+dy),PoiSegment.longitude.between(point[1]-dx,point[1]+dx))
                .order_by(PoiSegment.id).limit(row_limit+1)).all()
            covering=[r for r in circles[:row_limit] if distance(*point,r.latitude,r.longitude)<=r.radius_m]
            item['point_searches']=dict(covering_circles=len(covering),status_counts=dict(Counter(r.status for r in covering)),
                complete_unflagged=sum(r.status=='complete' and not r.review_reason and not r.pending_details for r in covering),
                scan_truncated=len(circles)>row_limit,
                examples=[dict(segment_id=r.id,province=r.province_name,status=r.status,radius_m=r.radius_m,
                    distance_m=round(distance(*point,r.latitude,r.longitude),1),review_reason=r.review_reason) for r in covering[:10]])
        report['jobs'].append(item)
    if point:
        from backend.poi_place_matching import RADIUS
        dy=RADIUS/110000;dx=dy/math.cos(math.radians(abs(point[0])+dy))
        nearby=session.execute(select(*fields).where(PoiPlace.provider=='neshan',category_matches,
            PoiPlace.latitude.between(point[0]-dy,point[0]+dy),PoiPlace.longitude.between(point[1]-dx,point[1]+dx)).limit(1001)).all()
        report['point_database_records']=[dict(id=str(r.id),name=r.name,province=r.province_name,resolved=r.resolved_at is not None,
            distance_m=round(distance(*point,r.latitude,r.longitude),2)) for r in nearby[:1000] if distance(*point,r.latitude,r.longitude)<=RADIUS]
        report['point_database_records_truncated']=len(nearby)>1000
        if point_name:
            for record in report['point_database_records']:
                record['name_matches']=normalized(record['name'])==normalized(point_name)
                record['province_matches']=normalized(record['province'])==normalized(province)
            report['point_matching_source_ids']=[record['id'] for record in report['point_database_records']
                if record['name_matches'] and record['province_matches'] and record['resolved']]
    return report


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--province',default='آذربایجان شرقی')
    parser.add_argument('--category',default='mosque')
    parser.add_argument('--point',nargs=2,type=float,metavar=('LAT','LON'))
    parser.add_argument('--name',help='Optional expected place name; compare with database records within 20 metres')
    parser.add_argument('--api-pid',type=int)
    args=parser.parse_args()
    if args.name and not args.point:parser.error('--name requires --point')
    try:
        if args.point and not (all(math.isfinite(v) for v in args.point) and 24<=args.point[0]<=41 and 43<=args.point[1]<=64):raise ValueError('invalid_point')
        if args.api_pid:
            from scripts.diagnose_poi_identity import use_process_settings
            use_process_settings(args.api_pid)
        from backend import database
        from sqlalchemy.orm import Session
        with database.engine.connect().execution_options(isolation_level='REPEATABLE READ') as connection:
            with connection.begin():
                connection.exec_driver_sql('SET TRANSACTION READ ONLY')
                connection.exec_driver_sql("SET LOCAL statement_timeout = '20s'")
                connection.exec_driver_sql("SET LOCAL lock_timeout = '2s'")
                with Session(bind=connection) as session:report=audit_database(session,args.province,args.category,args.point,point_name=args.name)
        print(json.dumps(report,indent=2,ensure_ascii=True))
    except Exception as error:
        # Raw SQL exceptions can contain credentials or source details.
        print(json.dumps(dict(status='audit_unavailable',error_type=type(error).__name__)))
        raise SystemExit(2)


if __name__=='__main__':main()

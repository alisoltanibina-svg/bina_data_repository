"""Offline preparation/export for the existing PostgreSQL POI collector.

Audit is read-only. Create/build never dispatch provider requests. Execution
requires an explicitly started existing worker and a confirmed provider result cap.
"""
import argparse,csv,json,math,sys,gzip
from pathlib import Path
from uuid import UUID
from backend.poi_coverage import METRIC_CRS,project,ALGORITHM
from backend.poi_coverage_sources import compile_sources


def main():
    if hasattr(sys.stdout,'reconfigure'):sys.stdout.reconfigure(encoding='utf-8')
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory',type=Path,default=Path(__file__).resolve().parent.parent/'data/search area')
    sub=parser.add_subparsers(dest='command',required=True)
    audit=sub.add_parser('audit');audit.add_argument('--radius',type=int,default=2000);audit.add_argument('--output',type=Path)
    sources=sub.add_parser('sources');sources.add_argument('--output-directory',type=Path,required=True);sources.add_argument('--overwrite',action='store_true')
    create=sub.add_parser('create');create.add_argument('--categories',required=True);create.add_argument('--radius',type=int,default=2000)
    create.add_argument('--minimum-radius',type=int,default=50);create.add_argument('--result-limit',type=int,default=0)
    create.add_argument('--replace-active',action='store_true')
    build=sub.add_parser('build');build.add_argument('--plan',type=UUID,required=True);build.add_argument('--max-tiles',type=int,default=0);build.add_argument('--workers',type=int,default=1)
    export=sub.add_parser('export');export.add_argument('--plan',type=UUID,required=True);export.add_argument('--output',type=Path,required=True);export.add_argument('--include-refinements',action='store_true')
    limit=sub.add_parser('set-limit');limit.add_argument('--plan',type=UUID,required=True);limit.add_argument('--result-limit',type=int,required=True)
    args=parser.parse_args()
    if args.command in ('audit','create','sources'):
        catalogue=compile_sources(args.directory)
        if args.command=='sources':
            from shapely import from_wkb
            from shapely.geometry import mapping
            args.output_directory.mkdir(parents=True,exist_ok=True)
            boundary_path=args.output_directory/'search_boundaries.geojson'
            point_path=args.output_directory/'point_searches_3000m.geojson'
            manifest_path=args.output_directory/'source_manifest.json'
            if not args.overwrite and any(p.exists() for p in (boundary_path,point_path,manifest_path)):raise SystemExit('Output exists; choose a new directory')
            with boundary_path.open('w',encoding='utf-8') as output:
                output.write('{"type":"FeatureCollection","features":[')
                for index,row in enumerate(catalogue.boundaries):
                    if index:output.write(',')
                    output.write(json.dumps(dict(type='Feature',geometry=mapping(from_wkb(row['geometry_wkb'])),properties=dict(
                        code=row['code'],level=row['level'],name=row['name'],parent_name=row['parent_name'],source=row['source_metadata'])),ensure_ascii=False))
                output.write(']}')
            with point_path.open('w',encoding='utf-8') as output:
                output.write('{"type":"FeatureCollection","features":[')
                for index,row in enumerate(catalogue.settlements):
                    if index:output.write(',')
                    output.write(json.dumps(dict(type='Feature',geometry=dict(type='Point',coordinates=[row['longitude'],row['latitude']]),properties=dict(
                        code=row['code'],name=row['name'],province=row['province_name'],county=row['county_name'],latitude=row['latitude'],longitude=row['longitude'],
                        radius_m=3000,source_observations=row['source_metadata']['observations'],warnings=row['source_metadata']['warnings'])),ensure_ascii=False))
                output.write(']}')
            manifest_path.write_text(json.dumps(dict(version=catalogue.version,manifest=catalogue.manifest,summary=catalogue.summary),ensure_ascii=False,indent=2),encoding='utf-8')
            print(json.dumps(dict(boundaries=str(boundary_path),point_searches=str(point_path),manifest=str(manifest_path),summary=catalogue.summary),ensure_ascii=False,indent=2));return
        if args.command=='audit':
            from shapely import from_wkb,union_all
            if not 50<=args.radius<=5000:raise SystemExit('Radius must be 50..5000 m')
            target=union_all(project([from_wkb(r['geometry_wkb']) for r in catalogue.boundaries]))
            estimate=math.ceil(target.area/(.98**2*math.sqrt(3)*1.5*args.radius**2))
            report=dict(version=catalogue.version,source_summary=catalogue.summary,metric_crs=METRIC_CRS,polygon_union_km2=target.area/1e6,
                polygon_radius_m=args.radius,point_radius_m=3000,unseeded_lattice_estimate_per_category=estimate,
                note='Area-based estimate before point-buffer reuse, edge circles and redundancy removal. Exact counts require build.',
                provider_calls_made=0,database_changed=False)
            encoded=json.dumps(report,ensure_ascii=False,indent=2)
            if args.output:
                args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(encoded,encoding='utf-8')
            print(encoded);return
    from backend import database,poi
    from backend.poi_coverage_state import create_plan,Builder,finalize_plan
    from backend.poi_models import PoiCoveragePlan as Plan,PoiCoverageTile as Tile,PoiCoverageCircle as Search,PoiRequest,PoiControl,PoiJob
    from sqlalchemy import select,text,func
    from sqlalchemy.orm import Session
    if args.command=='create':
        with database.db_session() as session:
            plan=create_plan(session,catalogue,args.categories.split(','),args.radius,args.minimum_radius,args.result_limit,args.replace_active)
            print(json.dumps(dict(plan_id=str(plan.id),job_id=str(plan.job_id),paused=True,summary=plan.summary),ensure_ascii=False,indent=2))
    elif args.command=='build':
        if args.max_tiles<0:raise SystemExit('max-tiles must be nonnegative')
        with database.engine.connect() as connection:
            if not connection.scalar(text('SELECT pg_try_advisory_lock(:key)'),dict(key=poi.LOCK_KEY+1)):raise SystemExit('Another coverage builder owns the planning lock')
            connection.commit()
            try:
                with Session(bind=connection,expire_on_commit=False) as session,session.begin():
                    plan=session.get(Plan,args.plan)
                    if not plan:raise SystemExit('Plan not found')
                    c=session.get(PoiControl,1)
                    if not c or not c.paused or c.in_flight:raise SystemExit('Pause collection before offline planning')
                    builder=Builder(session,plan)
                if not 1<=args.workers<=4:raise SystemExit('workers must be between 1 and 4')
                from concurrent.futures import ThreadPoolExecutor
                from collections import deque
                built=0;last_id=0;queue=deque();exhausted=False
                with ThreadPoolExecutor(max_workers=args.workers) as pool:
                    while True:
                        if not exhausted and len(queue)<args.workers:
                            with Session(bind=connection,expire_on_commit=False) as session,session.begin():
                                pending=session.execute(select(Tile.id,Tile.geometry).where(Tile.plan_id==args.plan,Tile.state!='verified',Tile.id>last_id).order_by(Tile.id).limit(args.workers-len(queue))).all()
                            if not pending:exhausted=True
                            for tile_id,geometry in pending:
                                queue.append((tile_id,pool.submit(builder.solve,geometry,plan.radius_m)));last_id=tile_id
                        if not queue:break
                        tile_id,future=queue.popleft();solution=future.result()
                        with Session(bind=connection,expire_on_commit=False) as session,session.begin():
                            c=session.get(PoiControl,1)
                            if not c or not c.paused or c.in_flight:raise SystemExit('Pause collection before offline planning')
                            plan=session.get(Plan,args.plan);tile=session.get(Tile,tile_id)
                            builder.build_one(session,plan,tile,solution);built+=1
                            print(json.dumps(dict(tile=tile.code,verified=True,built_this_run=built,certificate=tile.certificate)),flush=True)
                        if args.max_tiles and built>=args.max_tiles:break
                with Session(bind=connection,expire_on_commit=False) as session,session.begin():
                    plan=session.get(Plan,args.plan)
                    if not session.scalar(select(Tile.id).where(Tile.plan_id==plan.id,Tile.state!='verified').limit(1)):
                        finalize_plan(session,plan);print('Plan verified and ready; collection remains paused')
            finally:
                connection.rollback();connection.execute(text('SELECT pg_advisory_unlock(:key)'),dict(key=poi.LOCK_KEY+1));connection.commit()
    elif args.command=='set-limit':
        if args.result_limit<1:raise SystemExit('Use the positive maximum result count confirmed by Neshan')
        with database.db_session() as session:
            c=poi.control(session);plan=session.get(Plan,args.plan)
            if not plan:raise SystemExit('Plan not found')
            if not c.paused or c.in_flight:raise SystemExit('Pause collection before setting its result limit')
            if session.scalar(select(PoiRequest.id).where(PoiRequest.job_id==plan.job_id).limit(1)):
                raise SystemExit('Result cap is immutable after dispatch; use a new reviewed plan if provider limits change')
            plan.result_limit=args.result_limit
            if plan.state=='ready' and session.scalar(select(PoiJob.id).where(PoiJob.id==plan.job_id,PoiJob.status.in_(poi.ACTIVE))):
                c.reason='Polygon plan verified; resume explicitly to begin'
            print('Confirmed result limit saved; collection remains paused')
    elif args.command=='export':
        if args.output.exists():raise SystemExit('Output already exists; choose another filename')
        args.output.parent.mkdir(parents=True,exist_ok=True)
        with database.db_session() as session:
            plan=session.get(Plan,args.plan)
            if not plan or plan.state!='ready':raise SystemExit('Complete coverage verification before exporting')
            query=select(Search).where(Search.plan_id==plan.id)
            if not args.include_refinements:query=query.where(Search.kind!='refinement')
            rows=session.scalars(query.order_by(Search.province_order,Search.id).execution_options(yield_per=1000))
            opener=gzip.open if args.output.suffix.lower()=='.gz' else open
            mode='wt' if args.output.suffix.lower()=='.gz' else 'w'
            with opener(args.output,mode,encoding='utf-8',newline='') as output:
                geojson=args.output.name.lower().endswith(('.geojson','.geojson.gz'))
                if geojson:
                    output.write('{"type":"FeatureCollection","features":[');separator=''
                    for row in rows:
                        output.write(separator+json.dumps(dict(type='Feature',geometry=dict(type='Point',coordinates=[row.longitude,row.latitude]),
                            properties=dict(circle_id=row.id,latitude=row.latitude,longitude=row.longitude,radius_m=row.radius_m,kind=row.kind,associations=row.associations)),ensure_ascii=False));separator=','
                    output.write(']}')
                else:
                    writer=csv.writer(output);writer.writerow(['circle_id','latitude','longitude','radius_m','kind','associations'])
                    for row in rows:writer.writerow([row.id,row.latitude,row.longitude,row.radius_m,row.kind,json.dumps(row.associations,ensure_ascii=False)])
        print('Exported WGS84 search centers:',args.output)

if __name__=='__main__':main()

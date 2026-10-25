"""PostgreSQL planning/progress and recursive saturation handling for the worker."""
from collections import defaultdict
from uuid import uuid4
from sqlalchemy import select,func,update
from sqlalchemy.dialects.postgresql import insert
from shapely import from_wkb,union_all,set_precision,prepare
from shapely.geometry import Point,shape,mapping
from shapely.strtree import STRtree
from backend.poi_models import (PoiCoveragePlan as Plan,PoiCoverageTile as Tile,PoiCoverageCircle as Search,
    PoiCoverageContribution as Part,PoiSegment,PoiBoundary,PoiSettlement,PoiJob,PoiRequest)
from backend.poi_coverage import Circle,METRIC_CRS,ALGORITHM,PRECISION_M,project,wgs84,cover,tiles,circle_key,refinement_target
from backend.poi_geo import normalize


def result_limit_mode(plan):
    if plan.result_limit>0:return 'capped'
    mode=(plan.summary or {}).get('result_limit_mode')
    return mode if mode in ('unknown','unlimited') else 'unconfigured'


def plan_for(session,job):
    return session.scalar(select(Plan).where(Plan.job_id==job.id)) if job else None


def create_plan(session,catalogue,categories,radius=2000,minimum_radius=50,result_limit=0,replace_active=False,progress=None):
    from backend import poi
    from backend.poi_sources import save_catalogue
    from backend.poi_provider import LAYERS
    report=progress or (lambda message: None)
    report('Checking paused collection and unfinished Details')
    c=poi.control(session)
    if not c.paused or c.in_flight:raise ValueError('Pause collection and wait for in-flight work')
    if session.scalar(select(PoiSegment.id).where(PoiSegment.status=='processing',PoiSegment.pending_details>0).limit(1)):
        raise ValueError('Finish the volatile Details batch before replacing a plan')
    active=session.scalar(select(PoiJob).where(PoiJob.status.in_(poi.ACTIVE)))
    if active and not replace_active:raise ValueError('Existing job active; explicitly use --replace-active to preserve it as history')
    if not categories or not set(categories)<=LAYERS:raise ValueError('Unknown categories')
    if not 50<=minimum_radius<=radius<=5000 or result_limit<0:raise ValueError('Invalid radii or result limit')
    save_catalogue(session,catalogue,progress=report)
    if active:active.status='needs_review';session.flush()
    job=poi.create_job(session,categories,max(500,radius))
    job.radius_m=radius
    job.search_dataset_version=catalogue.version
    # A source snapshot is immutable; geographic migration never edits old jobs.
    polygon_rows=catalogue.boundaries
    report(f'Projecting and dissolving {len(polygon_rows)} polygons')
    metric=project([from_wkb(r['geometry_wkb']) for r in polygon_rows])
    target=set_precision(union_all(metric),PRECISION_M)
    plan=Plan(id=uuid4(),job_id=job.id,source_version=catalogue.version,state='planning',metric_crs=METRIC_CRS,
        geometry=mapping(target),radius_m=radius,point_radius_m=3000,minimum_radius_m=minimum_radius,
        result_limit=result_limit,metric_area_m2=target.area,
        summary=dict(algorithm=ALGORITHM,precision_m=PRECISION_M,previous_job=str(active.id) if active else None,
            source_summary=catalogue.summary,coverage_verified=False))
    session.add(plan);session.flush()
    province_rows=[r for r in polygon_rows if r['level']=='province']
    names=sorted({r['name'] for r in province_rows},key=normalize);orders={normalize(n):i for i,n in enumerate(names)}
    grouped={};point_metric=project([Point(p['longitude'],p['latitude']) for p in catalogue.settlements])
    polygons=STRtree(metric)
    report(f'Preparing 3000 m circles for {len(catalogue.settlements)} point targets')
    for number,(p,g) in enumerate(zip(catalogue.settlements,point_metric),1):
        if number%1000==0:report(f'Point targets associated: {number} / {len(catalogue.settlements)}')
        key=circle_key(g.x,g.y,3000,'point')
        if key in grouped:grouped[key]['associations']['points'].append(p['code']);continue
        cg=Circle(key,g.x,g.y,3000,True);footprint=cg.footprint()
        codes=[polygon_rows[int(i)]['code'] for i in polygons.query(footprint) if metric[int(i)].intersects(footprint)]
        name=p['province_name'] or 'Unassigned source points'
        grouped[key]=dict(plan_id=plan.id,code=key,kind='point',x=g.x,y=g.y,latitude=p['latitude'],longitude=p['longitude'],radius_m=3000,
            province_order=orders.get(normalize(name),len(names)),province_name=name,
            associations=dict(points=[p['code']],polygons=codes))
    rows=list(grouped.values())
    for offset in range(0,len(rows),500):
        created=session.execute(insert(Search).returning(Search.id,Search.province_order,Search.province_name,Search.latitude,Search.longitude,Search.radius_m),rows[offset:offset+500]).mappings().all()
        segments=[dict(job_id=job.id,kind='coverage',coverage_circle_id=r['id'],province_order=r['province_order'],province_name=r['province_name'],
            latitude=r['latitude'],longitude=r['longitude'],radius_m=r['radius_m'],category=category) for r in created for category in job.categories]
        session.execute(insert(PoiSegment),segments)
        report(f'Point circles saved: {min(offset+500,len(rows))} / {len(rows)}')
    report('Preparing polygon coverage tiles')
    tile_rows=[dict(plan_id=plan.id,code=code,geometry=mapping(g),state='pending') for code,g in tiles(target,size=min(25000,radius*50))]
    for offset in range(0,len(tile_rows),100):session.execute(insert(Tile),tile_rows[offset:offset+100])
    plan.summary={**plan.summary,'tiles':len(tile_rows),'point_circles':len(rows),
        'estimated_unseeded_polygon_searches':round(target.area/(.98**2*3**.5*1.5*radius**2)),
        'point_radius_m':3000,'category_count':len(job.categories)}
    c.collection_mode,c.pilot_segment_id,c.paused='coverage',None,True
    c.reason='Polygon plan prepared; complete offline coverage verification before starting'
    report('Preparation complete; committing plan transaction')
    return plan


class Builder:
    """Bounded tile geometry work. Call build_one in an atomic transaction.

    Planning CLI holds a separate advisory lock; each tile commit is its resumable
    checkpoint. No provider call and no control-row lock spans geometry work.
    """
    def __init__(self,session,plan):
        self.plan_id=plan.id
        rows=session.scalars(select(PoiBoundary).where(PoiBoundary.version==plan.source_version)).all()
        from types import SimpleNamespace
        self.boundaries=[SimpleNamespace(level=r.level,name=r.name,code=r.code) for r in rows]
        self.geometry=project([shape(r.geometry) for r in rows]);self.tree=STRtree(self.geometry);prepare(self.geometry)
        self.provinces=[i for i,r in enumerate(rows) if r.level=='province']
        names=sorted({rows[i].name for i in self.provinces},key=normalize);self.orders={normalize(n):i for i,n in enumerate(names)}
        self.seeds=[SimpleNamespace(code=r.code,x=r.x,y=r.y,radius_m=r.radius_m) for r in session.execute(select(Search.code,Search.x,Search.y,Search.radius_m).where(Search.plan_id==plan.id,Search.kind=='point').order_by(Search.code)).all()]
        self.seedtree=STRtree([Point(r.x,r.y) for r in self.seeds])

    def solve(self,geometry,radius):
        target=shape(geometry)
        seed_rows=[self.seeds[int(i)] for i in self.seedtree.query(target.buffer(3300))]
        fixed=[]
        for r in sorted(seed_rows,key=lambda r:r.code):
            c=Circle(r.code,r.x,r.y,r.radius_m,True)
            if c.footprint().intersects(target):fixed.append(c)
        return cover(target,radius,fixed)

    def build_one(self,session,plan,tile,solution=None):
        if tile.state=='verified':return False
        circles,owned,certificate=solution if solution is not None else self.solve(tile.geometry,plan.radius_m)
        existing={r.code:r for r in session.scalars(select(Search).where(Search.plan_id==plan.id,Search.code.in_([c.key for c in circles])))}
        job=session.get(PoiJob,plan.job_id)
        new_rows=[]
        for c in circles:
            if c.key in existing:continue
            footprint=c.footprint();hits=[int(i) for i in self.tree.query(footprint) if self.geometry[int(i)].intersects(footprint)]
            parents=[self.boundaries[i].name for i in hits if self.boundaries[i].level=='province']
            name=min(parents,key=lambda n:self.orders.get(normalize(n),999)) if parents else 'Unassigned source points'
            lat,lon=wgs84(c.x,c.y)
            new_rows.append(dict(plan_id=plan.id,code=c.key,kind='polygon',x=c.x,y=c.y,latitude=lat,longitude=lon,radius_m=c.radius_m,
                province_order=self.orders.get(normalize(name),len(self.orders)),province_name=name,
                associations=dict(points=[],polygons=[self.boundaries[i].code for i in hits])))
        for offset in range(0,len(new_rows),500):
            created=session.execute(insert(Search).returning(Search),new_rows[offset:offset+500]).scalars().all()
            existing.update({r.code:r for r in created})
            segments=[dict(job_id=job.id,kind='coverage',coverage_circle_id=r.id,
                province_order=r.province_order,province_name=r.province_name,latitude=r.latitude,longitude=r.longitude,radius_m=r.radius_m,category=category)
                for r in created for category in job.categories]
            session.execute(insert(PoiSegment),segments)
        parts=[];province_indices=set(self.provinces)
        for c,piece in zip(circles,owned):
            if piece.area<=0:continue
            search=existing[c.key]
            parts.append(dict(tile_id=tile.id,circle_id=search.id,province_name='__union__',area_m2=piece.area))
            for index in self.tree.query(piece):
                i=int(index)
                if i not in province_indices:continue
                area=piece.area if self.geometry[i].covers(piece) else piece.intersection(self.geometry[i]).area
                if area>0:parts.append(dict(tile_id=tile.id,circle_id=search.id,province_name=self.boundaries[i].name,area_m2=area))
        for offset in range(0,len(parts),1000):session.execute(insert(Part),parts[offset:offset+1000])
        tile.certificate=certificate;tile.state='verified'
        return True


def finalize_plan(session,plan):
    pending=session.scalar(select(func.count()).select_from(Tile).where(Tile.plan_id==plan.id,Tile.state!='verified'))
    if pending:raise ValueError(f'{pending} tiles still require coverage verification')
    verified_tiles=session.execute(select(Tile.geometry,Tile.certificate).where(Tile.plan_id==plan.id)).all()
    if any(not proof or not proof.get('verified') or proof.get('uncovered_area_m2')!=0 for _,proof in verified_tiles):
        raise ValueError('Missing or invalid per-tile coverage certificate')
    missing_scope=set_precision(shape(plan.geometry).difference(union_all([shape(g) for g,_ in verified_tiles])),PRECISION_M)
    if not missing_scope.is_empty:raise ValueError('Verified tiles do not cover the entire polygon union')
    certified=session.scalar(select(func.sum(Part.area_m2)).join(Tile,Tile.id==Part.tile_id).where(Tile.plan_id==plan.id,Part.province_name=='__union__')) or 0
    if abs(certified-plan.metric_area_m2)>max(1,plan.metric_area_m2*1e-9):raise ValueError('Coverage ownership area does not match polygon union')
    count=session.scalar(select(func.count()).select_from(Search).where(Search.plan_id==plan.id,Search.kind!='refinement'))
    plan.state='ready';plan.summary={**plan.summary,'coverage_verified':True,'certified_area_m2':certified,'root_circles':count,'uncovered_area_m2':0,'tile_union_verified':True}
    from backend.poi import control,ACTIVE
    if session.scalar(select(PoiJob.id).where(PoiJob.id==plan.job_id,PoiJob.status.in_(ACTIVE))):
        c=control(session);c.paused=True
        c.reason='Polygon plan verified; provider result limit required' if result_limit_mode(plan)=='unconfigured' else 'Polygon plan verified; resume explicitly to begin'
    return plan


def subdivide(session,job,segment,plan):
    parent=session.get(Search,segment.coverage_circle_id)
    if session.scalar(select(PoiSegment.id).where(PoiSegment.parent_segment_id==segment.id).limit(1)):return
    radius=max(plan.minimum_radius_m,parent.radius_m//2)
    if parent.radius_m<=plan.minimum_radius_m:
        segment.review_reason='provider_limit_at_minimum_radius';return
    target=shape(parent.target_geometry) if parent.target_geometry else refinement_target(Circle(parent.code,parent.x,parent.y,parent.radius_m)) if parent.kind=='point' else Circle(parent.code,parent.x,parent.y,parent.radius_m).footprint()
    circles,owned,certificate=cover(target,radius)
    for c,piece in zip(circles,owned):
        if piece.area<=0:continue
        code=f'refine:{segment.id}:{c.key}'
        lat,lon=wgs84(c.x,c.y)
        child=Search(plan_id=plan.id,code=code,kind='refinement',x=c.x,y=c.y,latitude=lat,longitude=lon,radius_m=c.radius_m,
            province_order=parent.province_order,province_name=parent.province_name,associations=parent.associations,target_geometry=mapping(piece))
        session.add(child);session.flush()
        session.add(PoiSegment(job_id=job.id,kind='coverage',coverage_circle_id=child.id,parent_segment_id=segment.id,
            province_order=parent.province_order,province_name=parent.province_name,latitude=lat,longitude=lon,radius_m=c.radius_m,category=segment.category))
    segment.planning_note='Provider result limit reached; recursively subdivided with verified full target coverage'
    session.flush()


def settle(session,segment):
    """A root finishes only when every descendant and Details handoff finishes."""
    if segment.pending_details:return
    if segment.review_reason=='provider_limit_at_minimum_radius':
        from backend.poi import control
        segment.status='failed';c=control(session);c.paused=True;c.reason='Provider result limit still reached at minimum radius; coverage requires review';return
    children=session.scalars(select(PoiSegment).where(PoiSegment.parent_segment_id==segment.id)).all()
    segment.status='complete' if not children or all(c.status=='complete' for c in children) else 'subdivided'
    session.flush()
    if segment.status=='complete' and segment.parent_segment_id:settle(session,session.get(PoiSegment,segment.parent_segment_id))


def progress(session,plan):
    job=session.get(PoiJob,plan.job_id);categories=len(job.categories)
    total=session.scalar(select(func.count()).select_from(Search).where(Search.plan_id==plan.id,Search.kind!='refinement'))
    roots=(PoiSegment.job_id==job.id,PoiSegment.kind=='coverage',PoiSegment.parent_segment_id.is_(None))
    done=session.scalar(select(func.count()).select_from(PoiSegment).where(*roots,PoiSegment.status=='complete'))
    area_rows=session.execute(select(Part.province_name,func.sum(Part.area_m2)).join(Search,Search.id==Part.circle_id).join(
        PoiSegment,PoiSegment.coverage_circle_id==Search.id).where(*roots,PoiSegment.status=='complete',Search.plan_id==plan.id).group_by(Part.province_name)).all()
    completed=dict(area_rows);areas=dict(session.execute(select(Part.province_name,func.sum(Part.area_m2)).join(Tile,Tile.id==Part.tile_id).where(Tile.plan_id==plan.id).group_by(Part.province_name)).all())
    pending_tiles=session.scalar(select(func.count()).select_from(Tile).where(Tile.plan_id==plan.id,Tile.state!='verified'))
    province_boundaries=session.scalars(select(PoiBoundary).where(PoiBoundary.version==plan.source_version,PoiBoundary.level=='province')).all()
    province_geometry=project([shape(r.geometry) for r in province_boundaries])
    areas={r.name:g.area for r,g in zip(province_boundaries,province_geometry)}
    counts=defaultdict(lambda:defaultdict(int));point_total=point_done=0
    for name,kind,status,n in session.execute(select(Search.province_name,Search.kind,PoiSegment.status,func.count()).join(
        PoiSegment,PoiSegment.coverage_circle_id==Search.id).where(*roots,Search.plan_id==plan.id).group_by(Search.province_name,Search.kind,PoiSegment.status)):
        counts[name]['total']+=n
        counts[name][status]+=n
        if kind=='point':
            point_total+=n
            if status=='complete':point_done+=n
    province_rows=[]
    for order,name in enumerate(sorted(set(areas)|set(counts),key=lambda name:(name not in areas,normalize(name)))):
        area=areas.get(name,0);denominator=area*categories;finished=completed.get(name,0);n=counts[name]
        province_rows.append(dict(order=order,province=name,percent=round(100*finished/denominator,2) if denominator else None,
            area_m2=area,completed_area_m2=finished/categories,expected_searches=n['total'],completed_searches=n['complete'],
            pending_searches=n['total']-n['complete'],review_searches=n['failed']+n['uncertain'],empty_searches=0,
            complete=bool(finished>=denominator-max(1,denominator*1e-9) and n['complete']==n['total']) if denominator else bool(n['total'] and n['complete']==n['total'])))
    point_complete=0
    completed_point_rows=select(Search.id,Search.associations).join(PoiSegment,PoiSegment.coverage_circle_id==Search.id).where(
        *roots,Search.kind=='point',Search.plan_id==plan.id,PoiSegment.status=='complete').group_by(Search.id,Search.associations).having(func.count()==categories)
    for _,associations in session.execute(completed_point_rows):point_complete+=len(associations.get('points',[]))
    denominator=plan.metric_area_m2*categories;finished=completed.get('__union__',0)
    expected=(total or 0)*categories
    return dict(scope='verified_polygon_union_and_3km_points',plan_id=str(plan.id),planning_state=plan.state,
        coverage_verified=plan.summary.get('coverage_verified',False),pending_tiles=pending_tiles,result_limit=plan.result_limit,
        result_limit_mode=result_limit_mode(plan),adaptive_subdivision_enabled=plan.result_limit>0,
        point_radius_m=3000,polygon_radius_m=plan.radius_m,metric_area_m2=plan.metric_area_m2,completed_area_m2=finished/categories,
        area_percent=round(100*finished/denominator,4) if denominator else 0,
        percent=round(100*done/expected,2) if expected else 0,completed_searches=done,expected_searches=expected,
        total_points=plan.summary.get('source_summary',{}).get('ready',0),completed_points=point_complete,point_percent=round(100*point_done/point_total,2) if point_total else 0,
        expected_point_searches=point_total,completed_point_searches=point_done,
        excluded_points=0,empty_searches=0,current_province=session.scalar(select(PoiSegment.province_name).where(
            PoiSegment.job_id==job.id,PoiSegment.kind=='coverage',PoiSegment.status!='complete').order_by(PoiSegment.province_order,PoiSegment.id).limit(1)),provinces=province_rows,
        summary=plan.summary)


def blocker(session,job):
    plan=plan_for(session,job)
    if not plan:return ''
    if plan.summary.get('algorithm')!=ALGORITHM:return 'coverage_algorithm_mismatch'
    if plan.state!='ready':return 'coverage_not_ready'
    if result_limit_mode(plan)=='unconfigured':return 'coverage_limit_required'
    return ''

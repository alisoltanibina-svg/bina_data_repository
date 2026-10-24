"""Collector correctness tests. Network is always mocked; PostgreSQL uses an isolated schema."""
import json
import os
from pathlib import Path
import secrets
import threading
import unittest
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import patch
from sqlalchemy import create_engine, text, select, func
from sqlalchemy.orm import sessionmaker
from shapely.geometry import box, mapping, Point
from backend.poi_geo import grid, BoundaryIndex, parse_address
from backend.poi_provider import Reply, nearby_items, coordinates, retry_after

DETAILS = dict(name='Library A', address='Tehran Province, Tehran, Main Street',
               location={'x':51.4,'y':35.7},layer={'slug':'library','title':'Library'})
ITEM = dict(name='Library A',location={'latitude':35.7,'longitude':51.4},poiHash='hash-a')
def nearby(*items): return {'layerPoints':{'nearestPoints':list(items)}}

class GeographyTests(unittest.TestCase):
    def test_grid_covers_holes_islands_and_edges(self):
        from shapely.geometry import MultiPolygon, Polygon
        p=MultiPolygon([Polygon([(50,30),(50.05,30),(50.05,30.05),(50,30.05)],
            holes=[[(50.01,30.01),(50.02,30.01),(50.02,30.02),(50.01,30.02)]]),box(50.08,30.08,50.081,30.081)])
        centres=list(grid(mapping(p),500))
        self.assertGreater(len(centres),1)
        for x in range(82):
            for y in range(82):
                lon,lat=50+x*.001,30+y*.001
                if p.covers(Point(lon,lat)):
                    # Conservative angular distance uses the maximum degree length.
                    self.assertLess(min((((lat-a)*111700)**2+((lon-b)*111700*.867)**2)**.5 for a,b in centres),500)
    def test_spatial_boundary_ambiguity_and_text_are_distinct(self):
        rows=[SimpleNamespace(level='province',name='A',parent_name=None,geometry=mapping(box(50,30,51,31))),
              SimpleNamespace(level='province',name='B',parent_name=None,geometry=mapping(box(51,30,52,31))),
              SimpleNamespace(level='county',name='C',parent_name='A',geometry=mapping(box(50,30,51,31)))]
        index=BoundaryIndex(rows)
        self.assertEqual(index.assign(30.5,50.5)['county_name'],'C')
        self.assertEqual(index.assign(30.5,51)['spatial_status'],'ambiguous')
        hints=parse_address(DETAILS)
        self.assertEqual(hints['address_province'],'Tehran')
        self.assertIsNone(hints['address_county'])
        self.assertEqual(hints['address_city'],'Tehran')
        self.assertEqual(hints['address_parse_status'],'heuristic')
    def test_provider_contract_and_retry_after(self):
        self.assertEqual(nearby_items(nearby(ITEM)),[ITEM])
        self.assertEqual(coordinates(DETAILS['location']),(35.7,51.4))
        for loc in ({'x':float('nan'),'y':35},{'x':False,'y':35},{'x':1,'y':100}):
            with self.assertRaises(ValueError): coordinates(loc)
        with self.assertRaises(ValueError): nearby_items({'items':[]})
        self.assertEqual(retry_after('120'),120)
        self.assertEqual(retry_after('invalid'),0)

@unittest.skipUnless(os.environ.get('TEST_DATABASE_URL'),'Requires isolated TEST_DATABASE_URL')
class CollectorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from backend.settings import Settings
        settings=Settings(_env_file=None,database_url=os.environ['TEST_DATABASE_URL'],captcha_enabled=False)
        cls.settings_patch=patch('backend.settings.get_settings',return_value=settings);cls.settings_patch.start()
        cls.addClassCleanup(cls.settings_patch.stop)
        from backend import database, poi, poi_models as m
        from backend.poi_worker import Worker
        cls.db,cls.poi,cls.m,cls.Worker=database,poi,m,Worker
        cls.schema='poi_test_'+secrets.token_hex(8)
        cls.admin_engine=create_engine(os.environ['TEST_DATABASE_URL'])
        cls.addClassCleanup(cls.admin_engine.dispose)
        with cls.admin_engine.begin() as conn: conn.execute(text('CREATE SCHEMA '+cls.schema))
        cls.addClassCleanup(cls.drop_schema)
        cls.engine=create_engine(os.environ['TEST_DATABASE_URL'],connect_args={'options':'-csearch_path='+cls.schema})
        cls.addClassCleanup(cls.engine.dispose)
        from backend.models import Base
        Base.metadata.create_all(cls.engine)
        for target,value in [('engine',cls.engine),('SessionLocal',sessionmaker(bind=cls.engine,autoflush=False))]:
            p=patch.object(database,target,value);p.start();cls.addClassCleanup(p.stop)
    @classmethod
    def drop_schema(cls):
        with cls.admin_engine.begin() as conn: conn.execute(text('DROP SCHEMA '+cls.schema+' CASCADE'))
    def setUp(self):
        self.poi.boundary_index.cache_clear()
        from backend.models import Base
        with self.engine.begin() as conn:
            for t in reversed(Base.metadata.sorted_tables): conn.execute(t.delete())
        with self.db.db_session() as s:
            s.add(self.m.PoiBoundary(version='test',level='province',code='A',name='A',geometry=mapping(box(50,35,52,37))))
            s.add(self.m.PoiCategory(slug='library',title='Library'));s.flush()
            c=self.poi.control(s);c.paused=False
            job=self.m.PoiJob(categories=['library'],radius_m=2000,boundary_version='test',planned_provinces=31)
            s.add(job);s.flush();self.job_id=job.id
            segment=self.m.PoiSegment(job_id=job.id,province_order=0,province_name='A',category='library',latitude=35.7,longitude=51.4,radius_m=2000)
            s.add(segment);s.flush();self.segment_id=segment.id
        self.calls=[]
        def dispatch(kind,params):
            self.calls.append((kind,params));return Reply(200,nearby(ITEM)) if kind=='nearby' else Reply(200,DETAILS)
        self.provider=SimpleNamespace(request=dispatch)
        self.worker=self.Worker(self.provider)
    def tick(self):
        with self.engine.connect() as conn:
            pid=conn.scalar(text('SELECT pg_backend_pid()'));conn.commit();self.worker.tick(conn,pid)
    def clear_cooldown(self):
        with self.db.db_session() as s: self.poi.control(s).next_request_at=self.poi.now()-timedelta(seconds=1)
    def scalar(self,stmt):
        with self.db.db_session() as s: return s.scalar(stmt)
    def test_overlap_and_categories_resolve_once_after_restart(self):
        self.tick();self.clear_cooldown();self.tick()
        with self.db.db_session() as s:
            p=s.scalar(select(self.m.PoiPlace));place_id=p.id;self.assertIsNotNone(p.resolved_at)
            self.assertEqual(p.province_name,'A');self.assertIsNone(p.county_name)
            # New process, overlapping search and a second category retain one UUID.
            s.add(self.m.PoiCategory(slug='park',title='Park'));s.flush()
            s.add(self.m.PoiSegment(job_id=self.job_id,province_order=0,province_name='A',category='park',latitude=35.7,longitude=51.4,radius_m=2000))
        self.worker=self.Worker(self.provider);self.clear_cooldown();self.tick();self.clear_cooldown();self.tick()
        self.assertEqual([k for k,_ in self.calls],['nearby','details','nearby'])
        self.assertEqual(self.scalar(select(func.count()).select_from(self.m.PoiPlace)),1)
        self.assertEqual(self.scalar(select(self.m.PoiPlace.id)),place_id)
        self.assertEqual(self.scalar(select(func.count()).select_from(self.m.PoiPlaceCategory)),2)
    def test_pause_during_dispatch_saves_response_and_survives_restart(self):
        def dispatch(kind,params):
            with self.db.db_session() as s:
                c=self.poi.control(s);c.heartbeat_at=self.poi.now()
                self.assertEqual(self.poi.set_paused(s,True)['state'],'pausing')
            return Reply(200,nearby(ITEM))
        self.provider.request=dispatch;self.tick()
        with self.db.db_session() as s:
            state=self.poi.status(s);self.assertEqual(state['state'],'paused');deadline=state['next_request_at']
            self.assertEqual(s.get(self.m.PoiSegment,self.segment_id).status,'complete')
            self.worker.recover(s);self.assertTrue(self.poi.control(s).paused)
            self.poi.set_paused(s,False);self.assertEqual(self.poi.control(s).next_request_at,deadline)
        self.tick()
        self.assertEqual(self.scalar(select(func.count()).select_from(self.m.PoiRequest)),1)
    def test_quota_access_and_rate_limits(self):
        for code in (480,481,483,484,485):
            with self.db.db_session() as s: self.poi.set_paused(s,False)
            self.clear_cooldown();self.provider.request=lambda *_:Reply(code,{'status':'error'});self.tick()
            with self.db.db_session() as s:
                self.assertTrue(self.poi.control(s).paused)
                self.assertEqual(s.get(self.m.PoiSegment,self.segment_id).status,'pending')
        with self.db.db_session() as s: self.poi.set_paused(s,False)
        self.clear_cooldown();self.provider.request=lambda *_:Reply(482,{},retry_after=7200);self.tick()
        with self.db.db_session() as s:
            c=self.poi.control(s);self.assertFalse(c.paused)
            self.assertGreater((c.next_request_at-self.poi.now()).total_seconds(),7190)
        self.tick();self.assertEqual(self.scalar(select(func.count()).select_from(self.m.PoiRequest)),6)
    def test_crash_marks_unknown_and_requires_explicit_retry(self):
        with self.db.db_session() as s:
            req=self.m.PoiRequest(job_id=self.job_id,kind='nearby',target_id=self.segment_id,outcome='dispatched')
            s.add(req);s.flush();self.poi.control(s).in_flight=req.id
        with self.db.db_session() as s: self.worker.recover(s)
        self.assertEqual(self.scalar(select(self.m.PoiRequest.outcome)),'uncertain')
        self.tick();self.assertEqual(self.calls,[])
        with self.db.db_session() as s:
            self.poi.retry_unresolved(s,self.job_id);self.poi.set_paused(s,False)
        self.clear_cooldown();self.tick();self.assertEqual(len(self.calls),1)
    def test_malformed_nearby_cannot_partially_apply(self):
        malformed=dict(ITEM,location={'x':float('inf'),'y':35})
        # HTTP parser could produce this non-finite number; avoid JSONB serialization itself masking validation.
        malformed['location']={'x':51,'y':200}
        self.provider.request=lambda *_:Reply(200,nearby(ITEM,malformed));self.tick()
        self.assertEqual(self.scalar(select(func.count()).select_from(self.m.PoiPlace)),0)
        self.assertEqual(self.scalar(select(self.m.PoiRequest.outcome)),'uncertain')
    def test_details_first_province_order_and_refresh_policy(self):
        self.tick()
        with self.db.db_session() as s:
            s.add(self.m.PoiSegment(job_id=self.job_id,province_order=1,province_name='B',category='library',latitude=35.7,longitude=51.4,radius_m=2000))
        self.clear_cooldown();self.tick();self.assertEqual(self.calls[-1][0],'details')
        with self.db.db_session() as s:
            p=s.scalar(select(self.m.PoiPlace));p.resolved_at=self.poi.now()-timedelta(days=2)
            job=s.get(self.m.PoiJob,self.job_id);job.mode='refresh';job.refresh_before=self.poi.now()-timedelta(days=1)
            task=s.scalar(select(self.m.PoiDetailTask));task.status='pending'
        self.clear_cooldown();self.tick();self.assertEqual([k for k,_ in self.calls],['nearby','details','details'])
    def test_cross_hash_duplicates_flagged_without_merge(self):
        self.provider.request=lambda *_:Reply(200,nearby(ITEM,dict(ITEM,poiHash='hash-b')))
        self.tick();self.provider.request=lambda *_:Reply(200,DETAILS)
        self.clear_cooldown();self.tick();self.clear_cooldown();self.tick()
        self.assertEqual(self.scalar(select(func.count()).select_from(self.m.PoiPlace)),2)
        self.assertEqual(self.scalar(select(func.count()).select_from(self.m.PoiDuplicateReview)),1)
    def test_second_worker_cannot_acquire_global_lock(self):
        with self.engine.connect() as conn:
            conn.execute(text('SELECT pg_advisory_lock(:key)'),{'key':self.poi.LOCK_KEY});conn.commit()
            try:
                with self.assertRaisesRegex(RuntimeError,'Another collector'): self.Worker(self.provider).run()
            finally:
                conn.execute(text('SELECT pg_advisory_unlock(:key)'),{'key':self.poi.LOCK_KEY});conn.commit()
    def test_planning_does_not_block_pause_or_dispatch_requests(self):
        from concurrent.futures import ThreadPoolExecutor
        with self.db.db_session() as s:
            s.get(self.m.PoiSegment,self.segment_id).status='complete'
        entered, release = threading.Event(), threading.Event()
        def planning(session,job):
            entered.set()
            if not release.wait(5): raise RuntimeError('Planning test timed out')
            return True
        with patch('backend.poi_worker.plan_province',side_effect=planning),ThreadPoolExecutor(max_workers=1) as pool:
            future=pool.submit(self.tick)
            self.assertTrue(entered.wait(3))
            try:
                with self.db.db_session() as s:
                    s.execute(text("SET LOCAL lock_timeout = '1s'"))
                    self.assertEqual(self.poi.set_paused(s,True)['state'],'paused')
            finally: release.set()
            future.result(timeout=5)
        self.tick();self.assertEqual(self.calls,[])

    def test_create_nationwide_job_and_plan_first_province(self):
        with self.db.db_session() as session:
            session.get(self.m.PoiJob,self.job_id).status='completed'
            session.flush()
            job=self.poi.create_job(session,['library'],5000)
            new_id=job.id
            self.assertTrue(self.poi.control(session).paused)
            self.assertEqual(session.scalar(select(func.count()).select_from(self.m.PoiBoundary).where(
                self.m.PoiBoundary.version==job.boundary_version)),31)
            self.poi.set_paused(session,False)
        self.tick()
        with self.db.db_session() as session:
            job=session.get(self.m.PoiJob,new_id)
            self.assertEqual(job.planned_provinces,1)
            planned=session.scalars(select(self.m.PoiSegment).where(self.m.PoiSegment.job_id==new_id)).all()
            self.assertGreater(len(planned),100)
            self.assertEqual({row.province_order for row in planned},{0})
        self.assertEqual(self.calls,[])

    def test_interrupted_planning_rolls_back_partial_segments(self):
        with self.db.db_session() as session:
            session.get(self.m.PoiSegment,self.segment_id).status='complete'
            session.get(self.m.PoiJob,self.job_id).planned_provinces=0
        def interrupted_grid(*_):
            for _ in range(1005): yield (35.7,51.4)
            raise RuntimeError('simulated planner interruption')
        with patch('backend.poi.grid',side_effect=interrupted_grid):
            with self.assertRaisesRegex(RuntimeError,'planner interruption'): self.tick()
        self.assertEqual(self.scalar(select(func.count()).select_from(self.m.PoiSegment)),1)
        self.assertEqual(self.scalar(select(self.m.PoiJob.planned_provinces)),0)

    def test_authenticated_api_controls_and_local_geojson(self):
        from backend.main import app
        from backend import membership
        from backend.models import User
        from fastapi.testclient import TestClient
        with self.db.db_session() as session:
            user=User(phone='09120000999',first_name='Admin',last_name='Test',is_admin=True,is_active=True,
                password_hash=membership.hash_password('testing-password'))
            session.add(user)
        token=membership.authenticate('09120000999','testing-password')['token']
        client=TestClient(app,headers={'X-CSRF-Protection':'1'})
        self.addCleanup(client.close)
        self.assertEqual(client.get('/api/admin/poi/status').status_code,401)
        self.assertEqual(client.get('/api/pois').status_code,401)
        client.cookies.set(membership.SESSION_COOKIE,token)
        self.assertEqual(client.post('/api/admin/poi/pause',json={}).status_code,200)
        report=client.get('/api/admin/poi/status')
        self.assertEqual(report.status_code,200,report.text)
        self.assertEqual(report.headers['cache-control'],'no-store')
        self.assertEqual(report.json()['state'],'paused')
        client.post('/api/admin/poi/resume',json={})
        self.tick();self.clear_cooldown();self.tick()
        result=client.get('/api/pois?category=library&bbox=50,35,52,37')
        self.assertEqual(result.status_code,200,result.text)
        self.assertEqual(result.json()['features'][0]['geometry']['coordinates'],[51.4,35.7])
        self.assertEqual(client.get('/api/pois?bbox=NaN,0,51,35').status_code,422)
        counts=client.get('/api/pois/counts?category=library').json()
        self.assertEqual(counts['counts'][0]['count'],1)
        self.assertFalse(counts['completeness_verified'])
        self.assertEqual(len(client.get('/api/admin/poi/requests').json()),2)
        self.assertEqual(client.post('/api/admin/poi/jobs',json={'categories':['unverified-layer']}).status_code,409)

    def test_completed_searches_do_not_claim_completeness(self):
        self.tick();self.clear_cooldown();self.tick();self.clear_cooldown();self.tick()
        with self.db.db_session() as s:
            report=self.poi.status(s)
            self.assertEqual(report['job']['status'],'completed')
            self.assertFalse(report['completeness_verified'])
            self.assertEqual(report['unique_saved'],1)

if __name__ == '__main__': unittest.main()

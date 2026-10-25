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
        self.assertEqual(nearby_items(nearby(ITEM)),[{'poiHash':'hash-a'}])
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
        settings=Settings(_env_file=None,database_url=os.environ['TEST_DATABASE_URL'],captcha_enabled=False,neshan_collection_authorized=True)
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
            c=self.poi.control(s);c.paused=False;c.collection_mode='coverage'
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
        self.assertEqual(self.scalar(select(func.count()).select_from(self.m.PoiPlaceCategory)),1)
    def test_pause_during_dispatch_saves_details_and_survives_restart(self):
        self.tick();self.clear_cooldown()
        def dispatch(kind,params):
            self.assertEqual(kind,'details')
            with self.db.db_session() as s:
                c=self.poi.control(s);c.heartbeat_at=self.poi.now()
                self.assertEqual(self.poi.set_paused(s,True)['state'],'pausing')
            return Reply(200,DETAILS)
        self.provider.request=dispatch;self.tick()
        with self.db.db_session() as s:
            state=self.poi.status(s);self.assertEqual(state['state'],'paused');deadline=state['next_request_at']
            self.assertEqual(s.get(self.m.PoiSegment,self.segment_id).status,'complete')
            self.assertEqual(s.scalar(select(self.m.PoiPlace.raw_details)),DETAILS)
            self.worker.recover(s);self.assertTrue(self.poi.control(s).paused)
            self.poi.set_paused(s,False);self.assertEqual(self.poi.control(s).next_request_at,deadline)
        self.tick()
        self.assertEqual(self.scalar(select(func.count()).select_from(self.m.PoiRequest)),2)
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
        malformed['poiHash']=123
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
            from backend.poi_worker import PendingDetail
            segment=s.get(self.m.PoiSegment,self.segment_id);segment.status='processing';segment.pending_details=1
            self.worker.pending=[PendingDetail(self.segment_id,p.provider_id)]
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
        self.assertEqual(report.json()['state'],'not_configured')
        self.assertFalse(report.json()['service_key_configured'])
        self.assertEqual(report.json()['resume_blocked_reason'],'missing_service_key')
        self.assertEqual(client.post('/api/admin/poi/resume',json={}).status_code,409)
        with self.db.db_session() as session: self.poi.control(session).heartbeat_at=self.poi.now()
        from backend.settings import get_settings
        from pydantic import SecretStr
        with patch.object(get_settings(),'neshan_service_api_key',SecretStr('test-service-secret')):
            ready=client.get('/api/admin/poi/status')
            self.assertNotIn('test-service-secret',ready.text)
            self.assertTrue(ready.json()['can_resume'])
            self.assertEqual(client.post('/api/admin/poi/resume',json={}).status_code,200)
        self.tick();self.clear_cooldown();self.tick()
        result=client.get('/api/pois?category=library&bbox=50,35,52,37')
        self.assertEqual(result.status_code,403,result.text)
        self.assertEqual(client.get('/api/pois/counts?category=library').status_code,403)
        counts=client.get('/api/admin/poi/counts?category=library').json()
        self.assertEqual(counts['counts'][0]['count'],1)
        self.assertFalse(counts['completeness_verified'])
        self.assertEqual(len(client.get('/api/admin/poi/requests').json()),2)
        self.assertEqual(client.post('/api/admin/poi/jobs',json={'categories':['unverified-layer']}).status_code,409)

    def test_resume_readiness_distinguishes_setup_job_and_worker(self):
        from backend.settings import get_settings
        from pydantic import SecretStr
        with self.db.db_session() as session:
            self.poi.set_paused(session,True)
            report=self.poi.status(session)
            self.assertEqual(report['state'],'not_configured')
            self.assertEqual(report['resume_blocked_reason'],'missing_service_key')
            self.assertFalse(report['can_resume'])
        with patch.object(get_settings(),'neshan_service_api_key',SecretStr('test-only')):
            with self.db.db_session() as session:
                report=self.poi.status(session)
                self.assertEqual(report['resume_blocked_reason'],'worker_not_running')
                with self.assertRaises(ValueError): self.poi.resume_collection(session)
                self.poi.control(session).heartbeat_at=self.poi.now()
                report=self.poi.status(session)
                self.assertTrue(report['can_resume'])
                session.get(self.m.PoiJob,self.job_id).status='completed'
                session.flush()
                report=self.poi.status(session)
                self.assertEqual(report['resume_blocked_reason'],'no_active_job')
                self.assertFalse(report['can_resume'])
                self.assertFalse(report['can_pause'])

    def test_nearby_payload_and_hashes_are_not_persisted_before_details(self):
        self.tick()
        with self.db.db_session() as s:
            self.assertEqual(s.scalar(select(func.count()).select_from(self.m.PoiPlace)),0)
            self.assertEqual(s.scalar(select(func.count()).select_from(self.m.PoiDetailTask)),0)
            self.assertEqual(s.scalar(select(func.count()).select_from(self.m.PoiPlaceCategory)),0)
            req=s.scalar(select(self.m.PoiRequest))
            self.assertIsNone(req.raw_response)
            self.assertEqual((req.result_count,req.hash_count,req.queued_count),(1,1,1))
            self.assertEqual(s.get(self.m.PoiSegment,self.segment_id).status,'processing')
        self.assertEqual(self.worker.pending[0].provider_id,'hash-a')
        self.clear_cooldown();self.tick()
        with self.db.db_session() as s:
            place=s.scalar(select(self.m.PoiPlace))
            self.assertEqual(place.name,DETAILS['name'])
            self.assertEqual(place.raw_details,DETAILS)
            self.assertEqual(place.provider_id,'hash-a')

    def test_empty_nearby_pauses_instead_of_continuing_nearby_only(self):
        self.provider.request=lambda *_:Reply(200,nearby())
        self.tick()
        with self.db.db_session() as s:
            c=self.poi.control(s);self.assertTrue(c.paused)
            req=s.scalar(select(self.m.PoiRequest))
            self.assertEqual(req.outcome,'successful')
            self.assertEqual((req.result_count,req.hash_count,req.queued_count),(0,0,0))
            self.assertIsNone(req.raw_response)
            self.assertEqual(self.poi.status(s)['job']['empty_searches'],1)
        self.clear_cooldown();self.tick()
        self.assertEqual(self.scalar(select(func.count()).select_from(self.m.PoiRequest)),1)

    def test_restart_cannot_restore_a_nearby_hash_from_database(self):
        self.tick()
        replacement=self.Worker(self.provider)
        with self.db.db_session() as s:
            replacement.recover(s)
            self.assertTrue(self.poi.control(s).paused)
            self.assertEqual(s.get(self.m.PoiSegment,self.segment_id).status,'uncertain')
        self.assertEqual(replacement.pending,[])
        self.assertEqual(self.scalar(select(func.count()).select_from(self.m.PoiPlace)),0)

    def test_nda_authorization_is_required_before_resume(self):
        from backend.settings import get_settings
        from pydantic import SecretStr
        with patch.object(get_settings(),'neshan_service_api_key',SecretStr('test-key')),patch.object(
                get_settings(),'neshan_collection_authorized',False):
            with self.db.db_session() as s:
                self.poi.set_paused(s,True)
                self.poi.control(s).heartbeat_at=self.poi.now()
                self.assertEqual(self.poi.status(s)['resume_blocked_reason'],'authorization_required')
                with self.assertRaises(ValueError): self.poi.resume_collection(s)

    def test_cleanup_is_dry_run_by_default_and_preserves_details(self):
        from scripts.cleanup_nearby_storage import cleanup
        from uuid import uuid4
        self.tick();self.clear_cooldown();self.tick()
        with self.db.db_session() as s:
            saved=s.scalar(select(self.m.PoiPlace));saved_id=saved.id
            legacy=self.m.PoiPlace(id=uuid4(),provider='neshan',provider_id='legacy-discovery',
                name='Nearby only',normalized_name='nearby only',latitude=35,longitude=51)
            s.add(legacy);s.flush()
            s.add(self.m.PoiDetailTask(job_id=self.job_id,place_id=legacy.id,segment_id=self.segment_id,province_order=0))
            s.flush()
            counts=cleanup(s)
            self.assertEqual(counts['unresolved_discoveries'],1)
            self.assertEqual(s.scalar(select(func.count()).select_from(self.m.PoiPlace)),2)
            cleanup(s,apply=True)
        with self.db.db_session() as s:
            self.assertEqual(s.scalar(select(func.count()).select_from(self.m.PoiPlace)),1)
            self.assertEqual(s.scalar(select(self.m.PoiPlace.id)),saved_id)
            self.assertEqual(s.scalar(select(self.m.PoiPlace.raw_details)),DETAILS)
            self.assertEqual(s.scalar(select(func.count()).select_from(self.m.PoiDetailTask)),0)
            self.assertFalse(self.poi.storage_cleanup_required(s))
            self.assertTrue(self.poi.control(s).paused)

    def test_database_rejects_any_new_nearby_payload(self):
        from sqlalchemy.exc import IntegrityError
        with self.assertRaises(IntegrityError):
            with self.db.db_session() as s:
                s.add(self.m.PoiRequest(job_id=self.job_id,kind='nearby',target_id=self.segment_id,
                    raw_response=nearby(ITEM)))

    def test_details_484_pause_identifies_the_actual_rejected_service(self):
        self.tick();self.clear_cooldown()
        self.provider.request=lambda *_:Reply(484,{'status':'ApiWhiteListError'})
        self.tick()
        with self.db.db_session() as session:
            c=self.poi.control(session)
            self.assertTrue(c.paused)
            self.assertIn('POI Details (/v1/point)',c.reason)
            self.assertIn('ApiWhiteListError',c.reason)
            self.assertNotIn('quota',c.reason)
            latest=session.scalar(select(self.m.PoiRequest).order_by(self.m.PoiRequest.id.desc()).limit(1))
            self.assertEqual(latest.kind,'details')
            self.assertEqual(latest.http_status,484)
            self.assertEqual(latest.outcome,'failed')
        self.tick()
        self.assertEqual(self.scalar(select(func.count()).select_from(self.m.PoiRequest)),2)

    def prepare_pilot(self,latitude=35.7,longitude=51.4):
        with self.db.db_session() as session:
            self.poi.set_paused(session,True)
            segment=self.poi.create_pilot(session,latitude,longitude,'library',500)
            return segment.id

    def test_pilot_drains_details_then_pauses_without_touching_grid(self):
        pilot_id=self.prepare_pilot()
        self.assertEqual(self.calls,[])
        with self.db.db_session() as s:
            c=self.poi.control(s)
            self.assertEqual(c.collection_mode,'pilot')
            self.assertEqual(c.pilot_segment_id,pilot_id)
            self.assertTrue(c.paused)
            self.assertEqual(s.get(self.m.PoiSegment,self.segment_id).status,'pending')
            self.poi.set_paused(s,False)
        self.tick();self.clear_cooldown();self.tick();self.clear_cooldown();self.tick()
        self.assertEqual([kind for kind,_ in self.calls],['nearby','details'])
        with self.db.db_session() as s:
            self.assertTrue(self.poi.control(s).paused)
            self.assertEqual(s.get(self.m.PoiSegment,pilot_id).status,'complete')
            self.assertEqual(s.get(self.m.PoiSegment,self.segment_id).status,'pending')
            self.assertEqual(s.scalar(select(func.count()).select_from(self.m.PoiSegment)),2)
            report=self.poi.status(s)
            self.assertEqual(report['pilot']['details_saved'],1)
            self.assertEqual(report['job']['completed_provinces'],0)
            self.assertEqual(sum(row['count'] for row in report['job']['areas']),1)
            # Even a stale/manual resume cannot fall through into grid planning.
            self.poi.set_paused(s,False)
        self.tick();self.assertEqual(len(self.calls),2)

    def test_pilot_empty_response_cannot_advance_the_grid(self):
        pilot_id=self.prepare_pilot()
        self.provider.request=lambda kind,params:self.calls.append((kind,params)) or Reply(200,nearby())
        with self.db.db_session() as s:self.poi.set_paused(s,False)
        self.tick();self.clear_cooldown();self.tick()
        self.assertEqual(len(self.calls),1)
        with self.db.db_session() as s:
            self.assertTrue(self.poi.control(s).paused)
            self.assertEqual(s.get(self.m.PoiSegment,self.segment_id).status,'pending')
            self.assertIsNone(s.scalar(select(self.m.PoiRequest.raw_response)))
            self.assertEqual(s.get(self.m.PoiSegment,pilot_id).status,'complete')

    def test_pilot_requires_pause_valid_scope_and_an_interior_origin(self):
        with self.db.db_session() as s:
            with self.assertRaises(ValueError):self.poi.create_pilot(s,35.7,51.4,'library',500)
            self.poi.set_paused(s,True)
            for lat,lon,category,radius in [(35.7,49,'library',500),(float('nan'),51,'library',500),
                    (35.7,51.4,'mosque',500),(35.7,51.4,'library',499)]:
                with self.assertRaises(ValueError):self.poi.create_pilot(s,lat,lon,category,radius)
            self.poi.control(s).in_flight=123
            with self.assertRaises(ValueError):self.poi.create_pilot(s,35.7,51.4,'library',500)
        self.assertEqual(self.scalar(select(func.count()).select_from(self.m.PoiSegment)),1)
        self.assertEqual(self.calls,[])

    def test_pilot_rejects_an_unfinished_in_memory_details_batch(self):
        self.tick()
        with self.db.db_session() as s:
            self.poi.set_paused(s,True)
            with self.assertRaises(ValueError):self.poi.create_pilot(s,35.7,51.4,'library',500)
        self.assertEqual(self.scalar(select(func.count()).select_from(self.m.PoiSegment)),1)

    def test_pilot_replacement_preserves_the_original_origin(self):
        old_id=self.prepare_pilot();new_id=self.prepare_pilot(35.8,51.5)
        with self.db.db_session() as s:
            old=s.get(self.m.PoiSegment,old_id)
            self.assertEqual((old.latitude,old.longitude),(35.7,51.4))
            self.assertEqual(old.status,'cancelled')
            self.assertEqual(self.poi.control(s).pilot_segment_id,new_id)
            self.assertTrue(self.poi.control(s).paused)
        self.assertEqual(self.calls,[])

    def test_pilot_selection_survives_restart_but_hashes_do_not(self):
        pilot_id=self.prepare_pilot()
        with self.db.db_session() as s:self.poi.set_paused(s,False)
        self.tick()
        replacement=self.Worker(self.provider)
        with self.db.db_session() as s:
            replacement.recover(s)
            self.assertEqual(self.poi.control(s).pilot_segment_id,pilot_id)
            self.assertTrue(self.poi.control(s).paused)
            self.assertEqual(s.get(self.m.PoiSegment,pilot_id).status,'uncertain')
            self.assertEqual(s.get(self.m.PoiSegment,self.segment_id).status,'pending')
        self.assertEqual(replacement.pending,[])
        self.assertEqual(self.scalar(select(func.count()).select_from(self.m.PoiPlace)),0)

    def test_pilot_mode_without_selection_cannot_dispatch_the_old_grid(self):
        with self.db.db_session() as s:
            c=self.poi.control(s);c.collection_mode='pilot';c.paused=False
        self.tick()
        self.assertEqual(self.calls,[])
        self.assertTrue(self.scalar(select(self.m.PoiControl.paused)))

    def test_pilot_with_two_hashes_pauses_only_after_both_details(self):
        self.prepare_pilot()
        self.provider.request=lambda kind,params:self.calls.append((kind,params)) or (
            Reply(200,nearby(ITEM,dict(ITEM,poiHash='hash-b'))) if kind=='nearby' else Reply(200,DETAILS))
        with self.db.db_session() as s:self.poi.set_paused(s,False)
        self.tick();self.clear_cooldown();self.tick()
        self.assertFalse(self.scalar(select(self.m.PoiControl.paused)))
        self.clear_cooldown();self.tick()
        self.assertTrue(self.scalar(select(self.m.PoiControl.paused)))
        self.assertEqual([kind for kind,_ in self.calls],['nearby','details','details'])
        self.assertEqual(self.scalar(select(func.count()).select_from(self.m.PoiPlace)),2)

    def test_pilot_api_prepares_a_paused_area_without_network_calls(self):
        from backend.main import app
        from backend import membership
        from backend.models import User
        from fastapi.testclient import TestClient
        with self.db.db_session() as s:
            s.add(User(phone='09120000888',first_name='Pilot',last_name='Admin',is_admin=True,is_active=True,
                password_hash=membership.hash_password('testing-password')))
            self.poi.set_paused(s,True)
        client=TestClient(app,headers={'X-CSRF-Protection':'1'});self.addCleanup(client.close)
        body=dict(latitude=35.7,longitude=51.4,category='library',radius_m=500)
        self.assertEqual(client.post('/api/admin/poi/pilot',json=body).status_code,401)
        token=membership.authenticate('09120000888','testing-password')['token']
        client.cookies.set(membership.SESSION_COOKIE,token)
        result=client.post('/api/admin/poi/pilot',json=body)
        self.assertEqual(result.status_code,201,result.text)
        self.assertTrue(result.json()['paused'])
        status=client.get('/api/admin/poi/status').json()
        self.assertEqual(status['pilot']['id'],result.json()['id'])
        self.assertEqual(status['pilot']['latitude'],35.7)
        self.assertEqual(status['collection_mode'],'pilot')
        self.assertEqual(self.calls,[])
        self.assertEqual(self.scalar(select(func.count()).select_from(self.m.PoiRequest)),0)

    def test_pilot_cannot_skip_to_another_province(self):
        with self.db.db_session() as s:
            self.poi.set_paused(s,True)
            s.add(self.m.PoiBoundary(version='test',level='province',code='B',name='B',geometry=mapping(box(52,35,54,37))))
        self.poi.boundary_index.cache_clear()
        with self.db.db_session() as s:
            with self.assertRaises(ValueError):self.poi.create_pilot(s,35.7,53,'library',500)
        self.assertEqual(self.scalar(select(func.count()).select_from(self.m.PoiSegment)),1)

    def test_completed_searches_do_not_claim_completeness(self):
        self.tick();self.clear_cooldown();self.tick();self.clear_cooldown();self.tick()
        with self.db.db_session() as s:
            report=self.poi.status(s)
            self.assertEqual(report['job']['status'],'completed')
            self.assertFalse(report['completeness_verified'])
            self.assertEqual(report['unique_saved'],1)

    def import_sources(self):
        from test_search_area_audit import SearchSourceCompilerTests
        from tempfile import TemporaryDirectory
        from backend.poi_sources import compile_catalogue,save_catalogue
        with TemporaryDirectory() as d:catalogue=compile_catalogue(SearchSourceCompilerTests().files(d),['A'])
        with self.db.db_session() as session:
            self.assertTrue(save_catalogue(session,catalogue))
            self.assertFalse(save_catalogue(session,catalogue))
            c=self.poi.control(session);c.paused=True
            self.poi.attach_sources(session,catalogue.version)
        return catalogue

    def test_source_attach_preserves_history_and_requires_pause(self):
        from backend.poi_sources import save_catalogue
        from test_search_area_audit import SearchSourceCompilerTests
        from tempfile import TemporaryDirectory
        from backend.poi_sources import compile_catalogue
        with TemporaryDirectory() as d:catalogue=compile_catalogue(SearchSourceCompilerTests().files(d),['A'])
        with self.db.db_session() as session:
            save_catalogue(session,catalogue)
            with self.assertRaises(ValueError):self.poi.attach_sources(session,catalogue.version)
            self.poi.control(session).paused=True
            self.poi.attach_sources(session,catalogue.version)
            self.assertEqual(session.get(self.m.PoiSegment,self.segment_id).kind,'grid')
            job=session.get(self.m.PoiJob,self.job_id)
            self.assertEqual(job.boundary_version,'test');self.assertEqual(job.search_dataset_version,catalogue.version)
            self.assertEqual(self.poi.control(session).collection_mode,'pilot')
        self.assertEqual(self.calls,[])

    def test_source_plan_requires_successful_pilot_reuses_it_and_ignores_old_grid(self):
        cat=self.import_sources()
        with self.db.db_session() as session:
            with self.assertRaises(ValueError):self.poi.enable_settlement_plan(session)
            points=self.poi.source_points(session)
            self.assertEqual([p['name'] for p in points],['Capital','Other'])
            pilot=self.poi.create_pilot(session,0,0,'library',2000,points[0]['id'])
            pilot_id=pilot.id
            self.poi.control(session).paused=False
        self.tick();self.assertEqual(self.calls[-1][0],'nearby')
        self.clear_cooldown();self.tick();self.assertEqual(self.calls[-1][0],'details')
        with self.db.db_session() as session:
            self.assertTrue(self.poi.control(session).paused)
            pilot=session.get(self.m.PoiSegment,pilot_id)
            pilot.review_reason='Result cap requires review'
            with self.assertRaises(ValueError):self.poi.enable_settlement_plan(session)
            pilot.review_reason=None
            self.poi.enable_settlement_plan(session)
            job=session.get(self.m.PoiJob,self.job_id)
            self.assertTrue(self.poi.plan_province(session,job));session.flush()
            rows=session.scalars(select(self.m.PoiSegment).where(self.m.PoiSegment.kind=='settlement').order_by(self.m.PoiSegment.id)).all()
            self.assertEqual(len(rows),2);self.assertEqual(rows[0].status,'complete');self.assertIn(str(pilot_id),rows[0].planning_note)
            target=self.poi.next_target(session,job)
            self.assertEqual(target[1].settlement_id,rows[1].settlement_id)
            self.assertNotEqual(target[1].id,self.segment_id)
            place=session.scalar(select(self.m.PoiPlace));self.assertEqual(place.boundary_version,cat.version)
            self.assertEqual(session.get(self.m.PoiSegment,self.segment_id).status,'pending')
        self.assertEqual(len(self.calls),2)

    def test_quarantined_source_cannot_be_used_for_pilot(self):
        cat=self.import_sources()
        bad=next(p for p in cat.settlements if p['state']=='review')
        with self.db.db_session() as session:
            with self.assertRaises(ValueError):self.poi.create_pilot(session,0,0,'library',500,bad['id'])
            with self.assertRaises(ValueError):self.poi.create_pilot(session,35.7,51.4,'library',500)
        self.assertEqual(self.calls,[])

    def test_source_empty_result_pauses_and_never_dispatches_preserved_grid(self):
        self.import_sources()
        with self.db.db_session() as session:
            point=self.poi.source_points(session)[0]
            self.poi.create_pilot(session,0,0,'library',2000,point['id'])
            self.poi.control(session).paused=False
        self.provider.request=lambda kind,params:(self.calls.append((kind,params)) or Reply(200,nearby()))
        self.tick();self.clear_cooldown();self.tick()
        self.assertEqual(len(self.calls),1)
        with self.db.db_session() as session:
            self.assertTrue(self.poi.control(session).paused)
            self.assertEqual(session.get(self.m.PoiSegment,self.segment_id).status,'pending')
            request=session.scalar(select(self.m.PoiRequest))
            self.assertIsNone(request.raw_response);self.assertEqual(request.hash_count,0)
            with self.assertRaises(ValueError):self.poi.enable_settlement_plan(session)

    def test_production_empty_skips_to_valid_hash_drains_details_and_finishes(self):
        self.import_sources()
        with self.db.db_session() as session:
            c=self.poi.control(session);c.collection_mode='coverage';c.paused=False
        def response(kind,params):
            self.calls.append((kind,params))
            if kind=='details':return Reply(200,DETAILS)
            return Reply(200,nearby()) if len(self.calls)==1 else Reply(200,nearby(ITEM))
        self.provider.request=response
        self.tick()  # Plan the first province without provider traffic.
        with self.db.db_session() as session:
            g=self.poi.status(session)['geography']
            self.assertEqual((g['completed_searches'],g['expected_searches'],g['percent']),(0,2,0))
            self.assertEqual(g['excluded_points'],2)
        self.tick();self.assertFalse(self.scalar(select(self.m.PoiControl.paused)))
        self.assertFalse(self.worker.stop.is_set())
        self.clear_cooldown();self.tick();self.clear_cooldown();self.tick()
        self.assertEqual([kind for kind,_ in self.calls],['nearby','nearby','details'])
        self.tick()
        with self.db.db_session() as session:
            g=self.poi.status(session)['geography']
            self.assertEqual((g['completed_searches'],g['expected_searches'],g['percent']),(2,2,100))
            self.assertEqual(g['empty_searches'],1);self.assertEqual(g['completed_points'],2)
            self.assertEqual(session.get(self.m.PoiSegment,self.segment_id).status,'pending')
            self.assertEqual(session.get(self.m.PoiJob,self.job_id).status,'completed')
            self.assertEqual(self.poi.status(session)['state'],'completed')
            self.assertTrue(self.poi.control(session).paused)
        self.assertFalse(self.worker.stop.is_set())

    def test_source_progress_includes_unplanned_provinces_and_all_categories(self):
        catalogue=self.import_sources()
        from uuid import uuid4
        with self.db.db_session() as session:
            session.add(self.m.PoiBoundary(version='test',level='province',code='B',name='B',geometry=mapping(box(52,35,54,37))))
            session.add(self.m.PoiSettlement(id=uuid4(),version=catalogue.version,code='b-point',name='B City',declared_province='B',
                province_name='B',county_name='County B',latitude=35.5,longitude=53,state='ready',priority=0,source_metadata={}))
            job=session.get(self.m.PoiJob,self.job_id);job.categories=['library','park']
            session.add(self.m.PoiCategory(slug='park',title='Park'));session.flush()
            self.poi.plan_province(session,job);session.flush()
            segment=session.scalar(select(self.m.PoiSegment).where(self.m.PoiSegment.kind=='settlement').order_by(self.m.PoiSegment.id))
            segment.status='complete';session.flush()
            g=self.poi.geographic_progress(session,job)
            self.assertEqual(g['expected_searches'],6);self.assertEqual(g['completed_searches'],1)
            self.assertEqual(g['completed_points'],0);self.assertEqual(g['percent'],16.67)
            self.assertEqual(g['provinces'][1]['expected_searches'],2)
            self.assertEqual(g['provinces'][1]['unplanned_searches'],2)
            self.assertEqual(g['provinces'][1]['percent'],0)

    def test_production_advances_provinces_without_manual_resume(self):
        catalogue=self.import_sources()
        from uuid import uuid4
        with self.db.db_session() as session:
            session.add(self.m.PoiBoundary(version='test',level='province',code='B',name='B',geometry=mapping(box(52,35,54,37))))
            session.add(self.m.PoiSettlement(id=uuid4(),version=catalogue.version,code='b-point',name='B City',declared_province='B',
                province_name='B',latitude=35.5,longitude=53,state='ready',priority=0,source_metadata={}))
            c=self.poi.control(session);c.collection_mode='coverage';c.paused=False
        self.provider.request=lambda kind,params:self.calls.append((kind,params)) or Reply(200,nearby())
        for _ in range(7):self.clear_cooldown();self.tick()
        self.assertEqual(len(self.calls),3)
        self.assertIn('53',self.calls[-1][1]['location'])
        self.assertEqual(self.scalar(select(self.m.PoiJob.planned_settlement_provinces)),2)
        self.assertEqual(self.scalar(select(self.m.PoiJob.status)),'completed')
        self.assertEqual(self.scalar(select(func.count()).select_from(self.m.PoiPlace)),0)

    def test_current_worker_revision_required_before_resume(self):
        from backend.settings import get_settings
        from pydantic import SecretStr
        with patch.object(get_settings(),'neshan_service_api_key',SecretStr('test-only')):
            with self.db.db_session() as session:
                c=self.poi.control(session);c.paused=True;c.heartbeat_at=self.poi.now();c.worker_id='old-process:k123456abcdef'
                self.assertEqual(self.poi.status(session)['resume_blocked_reason'],'worker_outdated')
                with self.assertRaises(ValueError):self.poi.resume_collection(session)
                c.worker_id=self.worker.worker_id
                self.assertTrue(self.poi.status(session)['can_resume'])
                self.assertLessEqual(len(c.worker_id),100)

    def test_start_promotes_existing_successful_verification_atomically(self):
        self.import_sources()
        with self.db.db_session() as session:
            point=self.poi.source_points(session)[0]
            self.poi.create_pilot(session,0,0,'library',2000,point['id'])
            self.poi.control(session).paused=False
        self.tick();self.clear_cooldown();self.tick()
        from backend.settings import get_settings
        from pydantic import SecretStr
        with patch.object(get_settings(),'neshan_service_api_key',SecretStr('test-only')):
            with self.db.db_session() as session:
                c=self.poi.control(session);c.heartbeat_at=self.poi.now();c.worker_id=self.worker.worker_id
                self.assertTrue(self.poi.status(session)['can_start_collection'])
                self.poi.start_collection(session)
                self.assertEqual(c.collection_mode,'coverage');self.assertFalse(c.paused)
        self.assertEqual(len(self.calls),2)
        self.tick()  # Planning reuses verification, with no provider request.
        self.assertEqual(len(self.calls),2)

    def test_source_retry_does_not_requeue_retired_grid(self):
        self.import_sources()
        with self.db.db_session() as session:
            self.poi.control(session).collection_mode='coverage'
            session.get(self.m.PoiSegment,self.segment_id).status='uncertain'
            job=session.get(self.m.PoiJob,self.job_id);self.poi.plan_province(session,job);session.flush()
            segment=session.scalar(select(self.m.PoiSegment).where(self.m.PoiSegment.kind=='settlement'))
            segment.status='uncertain';session.flush()
            self.poi.retry_unresolved(session,self.job_id);session.flush()
            self.assertEqual(segment.status,'pending')
            self.assertEqual(session.get(self.m.PoiSegment,self.segment_id).status,'uncertain')

    def test_production_start_api_requires_admin_and_reuses_verification(self):
        self.import_sources()
        with self.db.db_session() as session:
            point=self.poi.source_points(session)[0]
            self.poi.create_pilot(session,0,0,'library',2000,point['id'])
            self.poi.control(session).paused=False
        self.tick();self.clear_cooldown();self.tick()
        from backend.main import app
        from backend import membership
        from backend.models import User
        from fastapi.testclient import TestClient
        from backend.settings import get_settings
        from pydantic import SecretStr
        with self.db.db_session() as session:
            session.add(User(phone='09120000888',first_name='Production',last_name='Admin',is_admin=True,is_active=True,
                password_hash=membership.hash_password('testing-password')))
            c=self.poi.control(session);c.heartbeat_at=self.poi.now();c.worker_id=self.worker.worker_id
        client=TestClient(app,headers={'X-CSRF-Protection':'1'});self.addCleanup(client.close)
        self.assertEqual(client.post('/api/admin/poi/start',json={}).status_code,401)
        token=membership.authenticate('09120000888','testing-password')['token'];client.cookies.set(membership.SESSION_COOKIE,token)
        with patch.object(get_settings(),'neshan_service_api_key',SecretStr('test-only')):
            response=client.post('/api/admin/poi/start',json={});self.assertEqual(response.status_code,200,response.text)
        self.assertFalse(response.json()['paused']);self.assertEqual(len(self.calls),2)
        self.assertEqual(self.scalar(select(self.m.PoiControl.collection_mode)),'coverage')

    def test_hashless_items_continue_without_retaining_provider_payload(self):
        self.import_sources()
        with self.db.db_session() as session:
            c=self.poi.control(session);c.collection_mode='coverage';c.paused=False
        self.provider.request=lambda kind,params:self.calls.append((kind,params)) or Reply(200,nearby({'name':'NOT-RETAINED'}))
        self.tick();self.tick()
        with self.db.db_session() as session:
            self.assertFalse(self.poi.control(session).paused)
            req=session.scalar(select(self.m.PoiRequest));self.assertIsNone(req.raw_response)
            self.assertEqual((req.result_count,req.hash_count,req.queued_count),(1,0,0))
            self.assertEqual(session.scalar(select(func.count()).select_from(self.m.PoiPlace)),0)
            g=self.poi.status(session)['geography']
            self.assertEqual(g['completed_searches'],1);self.assertEqual(g['empty_searches'],1)
            self.assertEqual(g['provinces'][0]['review_searches'],1)
        self.clear_cooldown();self.tick();self.assertEqual(len(self.calls),2)

    def prepare_polygon_plan(self,result_limit=2,minimum=50,build=True):
        from backend.poi_sources import Catalogue
        from backend.poi_coverage import project,METRIC_CRS
        from backend.poi_coverage_state import create_plan,Builder,finalize_plan
        from pyproj import Transformer
        from shapely.ops import transform
        from uuid import uuid4
        center=project([Point(51.4,35.7)])[0]
        inverse=Transformer.from_crs(METRIC_CRS,'EPSG:4326',always_xy=True)
        polygon=transform(inverse.transform,box(center.x-1000,center.y-1000,center.x+5000,center.y+1000))
        point=dict(id=uuid4(),code='village-a',name='Village A',declared_province='A',province_name='A',county_name='County',
            district_code=None,rural_area_code=None,latitude=35.7,longitude=51.4,state='ready',review_reason=None,priority=1,source_metadata={})
        catalogue=Catalogue('c'*64,{},[dict(level='province',code='A',name='A',parent_name=None,geometry_wkb=polygon.wkb,source_metadata={})],
            [point],dict(ready=1,review=0,settlements=1,review_points=[]))
        with self.db.db_session() as session:
            self.poi.control(session).paused=True
            plan=create_plan(session,catalogue,['library'],500,minimum,result_limit,True);plan_id=plan.id;job_id=plan.job_id
        if not build:return plan_id,job_id
        with self.db.db_session() as session:
            plan=session.get(self.m.PoiCoveragePlan,plan_id);builder=Builder(session,plan)
        with self.db.db_session() as session:
            plan=session.get(self.m.PoiCoveragePlan,plan_id)
            for tile in session.scalars(select(self.m.PoiCoverageTile).where(self.m.PoiCoverageTile.plan_id==plan_id)):
                builder.build_one(session,plan,tile)
            session.flush();finalize_plan(session,plan)
            self.poi.control(session).paused=False
        self.poi.boundary_index.cache_clear()
        return plan_id,job_id

    def test_polygon_plan_preserves_old_job_and_has_verified_coverage(self):
        plan_id,job_id=self.prepare_polygon_plan()
        with self.db.db_session() as session:
            plan=session.get(self.m.PoiCoveragePlan,plan_id)
            self.assertEqual(plan.state,'ready');self.assertTrue(plan.summary['coverage_verified'])
            self.assertEqual(plan.summary['uncovered_area_m2'],0)
            self.assertEqual(session.get(self.m.PoiJob,self.job_id).status,'needs_review')
            report=self.poi.status(session)['geography']
            self.assertEqual(report['scope'],'verified_polygon_union_and_3km_points')
            self.assertEqual(report['area_percent'],0);self.assertEqual(report['point_radius_m'],3000)
            circles=session.scalars(select(self.m.PoiCoverageCircle).where(self.m.PoiCoverageCircle.plan_id==plan_id)).all()
            self.assertTrue(any(c.kind=='point' and c.radius_m==3000 for c in circles))
            self.assertTrue(any(c.kind=='polygon' for c in circles))
            self.assertEqual(session.get(self.m.PoiSegment,self.segment_id).status,'pending')

    def test_unknown_provider_limit_blocks_polygon_dispatch(self):
        plan_id,job_id=self.prepare_polygon_plan(result_limit=0)
        self.tick();self.assertEqual(self.calls,[])
        self.assertTrue(self.scalar(select(self.m.PoiControl.paused)))

    def test_saturated_polygon_request_subdivides_and_drains_details_first(self):
        plan_id,job_id=self.prepare_polygon_plan()
        self.provider.request=lambda kind,params:self.calls.append((kind,params)) or (
            Reply(200,nearby(ITEM,dict(ITEM,poiHash='hash-b'))) if kind=='nearby' else Reply(200,DETAILS))
        self.tick()
        with self.db.db_session() as session:
            parent=session.scalar(select(self.m.PoiSegment).where(self.m.PoiSegment.job_id==job_id,self.m.PoiSegment.kind=='coverage').order_by(self.m.PoiSegment.id))
            parent_id=parent.id
            children=session.scalars(select(self.m.PoiSegment).where(self.m.PoiSegment.parent_segment_id==parent_id)).all()
            self.assertGreater(len(children),1);self.assertTrue(all(c.radius_m==1500 for c in children))
            self.assertEqual(parent.status,'processing');self.assertEqual(parent.pending_details,2)
            from backend.poi_coverage import Circle,refinement_target,PRECISION_M
            from shapely import set_precision,union_all
            from shapely.geometry import shape
            parent_circle=session.get(self.m.PoiCoverageCircle,parent.coverage_circle_id)
            target=refinement_target(Circle(parent_circle.code,parent_circle.x,parent_circle.y,parent_circle.radius_m))
            pieces=[shape(session.get(self.m.PoiCoverageCircle,c.coverage_circle_id).target_geometry) for c in children]
            self.assertTrue(set_precision(target.difference(union_all(pieces)),PRECISION_M).is_empty)
            self.assertIsNone(session.scalar(select(self.m.PoiRequest.raw_response)))
        self.clear_cooldown();self.tick();self.clear_cooldown();self.tick()
        self.assertEqual([kind for kind,_ in self.calls],['nearby','details','details'])
        self.assertEqual(self.scalar(select(self.m.PoiSegment.status).where(self.m.PoiSegment.id==parent_id)),'subdivided')
        self.provider.request=lambda kind,params:self.calls.append((kind,params)) or Reply(200,nearby())
        for _ in children:self.clear_cooldown();self.tick()
        self.assertEqual(self.scalar(select(self.m.PoiSegment.status).where(self.m.PoiSegment.id==parent_id)),'complete')

    def test_polygon_transport_retry_keeps_in_memory_details_batch(self):
        plan_id,job_id=self.prepare_polygon_plan()
        self.tick();self.clear_cooldown()
        self.provider.request=lambda kind,params:self.calls.append((kind,params)) or Reply(None,error='transport_outcome_unknown')
        self.tick()
        self.assertEqual(len(self.worker.pending),1)
        self.assertFalse(self.scalar(select(self.m.PoiControl.paused)))
        self.clear_cooldown();self.provider.request=lambda kind,params:self.calls.append((kind,params)) or Reply(200,DETAILS)
        self.tick()
        self.assertEqual([kind for kind,_ in self.calls],['nearby','details','details'])
        self.assertEqual(self.scalar(select(func.count()).select_from(self.m.PoiPlace)),1)

    def test_polygon_tile_rollback_and_checkpoint_resume_are_idempotent(self):
        from backend.poi_coverage_state import Builder,finalize_plan
        plan_id,job_id=self.prepare_polygon_plan(build=False)
        with self.db.db_session() as session:builder=Builder(session,session.get(self.m.PoiCoveragePlan,plan_id))
        with self.assertRaisesRegex(RuntimeError,'interrupt'):
            with self.db.db_session() as session:
                plan=session.get(self.m.PoiCoveragePlan,plan_id)
                tile=session.scalar(select(self.m.PoiCoverageTile).where(self.m.PoiCoverageTile.plan_id==plan_id))
                builder.build_one(session,plan,tile);raise RuntimeError('interrupt')
        self.assertEqual(self.scalar(select(func.count()).select_from(self.m.PoiCoverageCircle).where(self.m.PoiCoverageCircle.plan_id==plan_id,self.m.PoiCoverageCircle.kind=='polygon')),0)
        with self.db.db_session() as session:
            plan=session.get(self.m.PoiCoveragePlan,plan_id)
            for tile in session.scalars(select(self.m.PoiCoverageTile).where(self.m.PoiCoverageTile.plan_id==plan_id)):
                self.assertTrue(builder.build_one(session,plan,tile))
                self.assertFalse(builder.build_one(session,plan,tile))
            session.flush();finalize_plan(session,plan);self.assertEqual(plan.state,'ready')
        self.assertEqual(self.calls,[])

    def test_polygon_minimum_radius_saturation_pauses_after_details_drain(self):
        plan_id,job_id=self.prepare_polygon_plan(minimum=500)
        with self.db.db_session() as session:
            for row in session.scalars(select(self.m.PoiSegment).where(self.m.PoiSegment.job_id==job_id,self.m.PoiSegment.radius_m==3000)):row.status='complete'
        self.provider.request=lambda kind,params:self.calls.append((kind,params)) or (
            Reply(200,nearby(ITEM,dict(ITEM,poiHash='hash-b'))) if kind=='nearby' else Reply(200,DETAILS))
        self.tick();self.assertFalse(self.scalar(select(self.m.PoiControl.paused)))
        self.clear_cooldown();self.tick();self.clear_cooldown();self.tick()
        self.assertEqual([kind for kind,_ in self.calls],['nearby','details','details'])
        self.assertTrue(self.scalar(select(self.m.PoiControl.paused)))
        self.tick();self.assertEqual(len(self.calls),3)

    def test_polygon_transport_retries_are_bounded(self):
        plan_id,job_id=self.prepare_polygon_plan()
        self.provider.request=lambda kind,params:self.calls.append((kind,params)) or Reply(None,error='transport_outcome_unknown')
        for _ in range(5):self.clear_cooldown();self.tick()
        self.assertEqual(len(self.calls),5);self.assertTrue(self.scalar(select(self.m.PoiControl.paused)))
        self.clear_cooldown();self.tick();self.assertEqual(len(self.calls),5)
        with self.db.db_session() as session:
            self.assertTrue(all(r.raw_response is None for r in session.scalars(select(self.m.PoiRequest))))

    def test_failed_details_body_cannot_persist_an_unresolved_hash(self):
        self.prepare_polygon_plan();self.tick();self.clear_cooldown()
        self.provider.request=lambda kind,params:Reply(403,{'hash':'hash-a','error':'refused'})
        self.tick()
        with self.db.db_session() as session:
            request=session.scalar(select(self.m.PoiRequest).order_by(self.m.PoiRequest.id.desc()).limit(1))
            self.assertEqual(request.kind,'details');self.assertIsNone(request.raw_response)
            self.assertEqual(session.scalar(select(func.count()).select_from(self.m.PoiPlace)),0)

    def test_full_coverage_sources_cannot_be_attached_as_legacy_point_job(self):
        from backend.poi_sources import save_catalogue
        from test_search_area_audit import SearchSourceCompilerTests
        from backend.poi_sources import compile_catalogue
        from tempfile import TemporaryDirectory
        with TemporaryDirectory() as d:catalogue=compile_catalogue(SearchSourceCompilerTests().files(d),['A'])
        catalogue.summary['algorithm']='full-polygon-and-point-sources-v1'
        with self.db.db_session() as session:
            save_catalogue(session,catalogue);self.poi.control(session).paused=True
            with self.assertRaises(ValueError):self.poi.attach_sources(session,catalogue.version)
        self.assertEqual(self.calls,[])

if __name__ == '__main__': unittest.main()

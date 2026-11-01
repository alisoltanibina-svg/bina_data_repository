"""Synthetic PostgreSQL 16 integration rehearsal. Never accepts production URLs.

SCHEMA_TEST_ADMIN_URL must point to a disposable loopback cluster on a nonstandard
port, using its schema_admin role. Optional SCHEMA_TEST_SCHEMA_FILE is a schema-
only SQL export (never a full backup). Test databases have random dedicated names.
Run: python -m unittest discover -s tests -p test_schema_cutover.py -v
"""
import ast
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import hashlib
import io
import importlib.util
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, MetaData, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import DBAPIError, OperationalError

ROOT = Path(__file__).resolve().parents[1]
HEAD = '0023_domain_schemas'
PREVIOUS = '0022_trend_metadata'


def config(allow=True):
    cfg = Config(str(ROOT / 'alembic.ini'))
    cfg.set_main_option('script_location', str(ROOT / 'alembic'))
    from argparse import Namespace
    cfg.cmd_opts = Namespace(x=['schema_cutover=yes'] if allow else [])
    return cfg


def module_at(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def rows_digest(conn, table_schemas):
    result = {}
    for table, schema in sorted(table_schemas.items()):
        rows = conn.execute(text(f'SELECT to_jsonb(t)::text FROM "{schema}"."{table}" t')).scalars()
        encoded = sorted(rows)
        result[table] = (len(encoded), hashlib.sha256('\n'.join(encoded).encode()).hexdigest())
    return result


class SchemaCutoverTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        raw = os.environ.get('SCHEMA_TEST_ADMIN_URL', '')
        if not raw:
            raise unittest.SkipTest('SCHEMA_TEST_ADMIN_URL is required; production configuration is never used')
        url = make_url(raw)
        if (url.host != '127.0.0.1' or not url.port or url.port == 5432
                or url.username != 'schema_admin' or url.database != 'postgres'
                or url.query):
            raise RuntimeError('Refusing a non-isolated test administrator URL')
        cls.admin_url = url
        cls.admin = create_engine(url, isolation_level='AUTOCOMMIT')
        with cls.admin.connect() as conn:
            if not conn.scalar(text("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='appuser')")):
                conn.execute(text('CREATE ROLE appuser LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'))
            assert conn.scalar(text("SELECT current_setting('server_version_num')::int / 10000")) == 16
        cls.helper = module_at('cutover_helper', ROOT / 'scripts/schema_cutover.py')
        from backend.db_schema import TABLE_SCHEMAS
        cls.groups = TABLE_SCHEMAS

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls, 'admin'):
            cls.admin.dispose()

    def setUp(self):
        self.name = 'bina_schema_test_' + uuid4().hex[:12]
        with self.admin.connect() as conn:
            conn.execute(text(f'CREATE DATABASE "{self.name}" OWNER appuser'))
        self.url = self.admin_url.set(username='appuser', database=self.name)
        self.file_storage = tempfile.TemporaryDirectory(prefix='bina-schema-test-')
        self.env = patch.dict(os.environ, {
            'DATABASE_URL': self.url.render_as_string(hide_password=False),
            'CAPTCHA_HMAC_SECRET': 'synthetic-schema-test-secret-0000000000',
            'CAPTCHA_ENABLED': 'true', 'ADMIN_PHONE': '', 'ADMIN_PASSWORD': '',
            'KAVENEGAR_API_KEY': '', 'NESHAN_MAP_API_KEY': '',
            'NESHAN_SERVICE_API_KEY': '', 'NESHAN_COLLECTION_AUTHORIZED': 'false',
            'TICKET_ATTACHMENT_DIR': str(Path(self.file_storage.name) / 'attachments'),
        })
        self.env.start()
        from backend.settings import get_settings
        get_settings.cache_clear()
        self.engine = create_engine(self.url)
        self.initial_objects = None

    def tearDown(self):
        self.engine.dispose()
        from backend import database
        database.engine.dispose()
        self.env.stop()
        assert Path(self.file_storage.name).resolve().is_relative_to(Path(tempfile.gettempdir()).resolve())
        self.file_storage.cleanup()
        from backend.settings import get_settings
        get_settings.cache_clear()
        with self.admin.connect() as conn:
            assert self.name.startswith('bina_schema_test_')
            conn.execute(text(f'DROP DATABASE "{self.name}" WITH (FORCE)'))

    def old_schema(self, exported=False):
        if exported:
            path = os.environ.get('SCHEMA_TEST_SCHEMA_FILE')
            if not path:
                self.skipTest('Provide a schema-only SCHEMA_TEST_SCHEMA_FILE for exported-schema tests')
            sql = Path(path).read_text(encoding='utf-8')
            if re.search(r'(?m)^(COPY |INSERT INTO |SELECT pg_catalog.setval)', sql):
                raise RuntimeError('Refusing an export with table data or sequence state')
            sql = '\n'.join(line for line in sql.splitlines()
                            if not line.startswith('\\') and line != 'SET transaction_timeout = 0;')
            with self.engine.begin() as conn:
                conn.exec_driver_sql(sql)
                conn.execute(text("INSERT INTO public.alembic_version VALUES ('0020_poi_admin_preparation')"))
        else:
            command.upgrade(config(), '0020_poi_admin_preparation')
        command.upgrade(config(), PREVIOUS)

    def seed_all(self):
        """One synthetic row per table, including JSON, binary, nullable and FK data."""
        metadata = MetaData()
        metadata.reflect(self.engine, schema='public')
        metadata.remove(metadata.tables['public.alembic_version'])
        values = {
            'topics': dict(topic_name='Culture', topic_description='Synthetic', lower_color='#000000', upper_color='#ffffff', master_color='#123456'),
            'kdescription': dict(topic_name='Culture',subtopic_name='Reading',indicator_name='Libraries',description='Synthetic',source_name='Test',measurement_unit='count',question='Synthetic question'),
            'kindicator_score': dict(province_name='Test Province',topic_name='Culture',subtopic_name='Reading',indicator_name='Libraries',year=2025,value=12.5,standard_value=0.5,direction=1),
            'trend_score': dict(province_name='Test Province',year=2025,topic_name='Culture',index_score=50.5,province_rank=1,coverage_count=12.0,max_observation_age=2.0),
            'province_pop': dict(province_name='Test Province',province_pop=1000,year=2025),
            'provinces': dict(province_name='Test Province',is_national=0),
            'clusters': dict(province_name='Test Province',topic_name='Culture',subtopic_name='Reading',cluster_group=1,subtopic_score=50),
            'pyramid': dict(province_name='Test Province',year=2025,age=20,male=10,female=11,urban=12,rural=9),
            'users': dict(phone='09120000001',first_name='Synthetic',last_name='Operator',is_admin=True,is_active=True),
            'registration_requests': dict(phone='09120000002',first_name='Synthetic',last_name='Applicant',role_title='Tester',password_hash='synthetic',status='pending'),
            'sessions': dict(token_hash='a'*64),
            'otp_challenges': dict(phone='09120000002',purpose='register',code_hash='b'*64,salt='c'*32),
            'captcha_challenges': dict(id='d'*43,purpose='login',binding_hash='e'*64,ip_hash='f'*64,answer_hmac='0'*64,image_png=b'synthetic'),
            'login_failures': dict(phone_mask='0912***0001',reason='credentials'),
            'profile_revisions': dict(source='self',changes={'first_name':{'old':'A','new':'B'}}),
            'account_status_events': dict(kind='approved',reason='Synthetic'),
            'site_settings': dict(key='synthetic',value='preserved'),
            'support_tickets': dict(reference='SUP-'+'A'*16,access_hash='1'*64,category='other',subject='Synthetic ticket',status='open'),
            'support_messages': dict(author='user',body='Synthetic message'),
            'support_status_events': dict(from_status='open',to_status='in_progress'),
            'support_attachments': dict(id='2'*32,original_name='synthetic.webp',size_bytes=10,source_bytes=20,width=1,height=1,state='ready',sha256='3'*64),
            'poi_control': dict(id=1,paused=True,reason='Synthetic rehearsal',collection_mode='pilot'),
            'poi_boundaries': dict(version='synthetic-v1',level='province',code='01',name='Test Province',geometry={'type':'Polygon','coordinates':[[[50,30],[52,30],[52,32],[50,32],[50,30]]]}),
            'poi_categories': dict(slug='library',title='Synthetic libraries'),
            'poi_jobs': dict(status='completed',mode='initial',boundary_version='synthetic-v1',radius_m=2000,categories=['library']),
            'poi_segments': dict(province_order=1,province_name='Test Province',latitude=31,longitude=51,radius_m=2000,status='complete'),
            'poi_places': dict(provider='synthetic',provider_id='synthetic-place',name='Synthetic Library',normalized_name='syntheticlibrary',latitude=31,longitude=51,raw_details={'synthetic':True}),
            'poi_place_categories': {},
            'poi_detail_tasks': dict(province_order=1,status='complete'),
            'poi_requests': dict(kind='details',target_id=1,outcome='successful'),
            'poi_duplicate_reviews': dict(reason='Synthetic comparison',status='pending'),
            'poi_source_datasets': dict(version='synthetic-v1',manifest={'synthetic':True},summary={}),
            'poi_settlements': dict(code='S01',name='Synthetic Town',declared_province='Test Province',latitude=31,longitude=51,state='ready',priority=1,source_metadata={}),
            'poi_coverage_plans': dict(state='ready',metric_crs='EPSG:32639',geometry={},radius_m=2000,point_radius_m=3000,minimum_radius_m=50,result_limit=0,metric_area_m2=1,summary={}),
            'poi_coverage_tiles': dict(code='T01',geometry={},state='verified'),
            'poi_coverage_circles': dict(code='C01',kind='point',x=1,y=1,latitude=31,longitude=51,radius_m=3000,province_order=1,province_name='Test Province',associations=[]),
            'poi_coverage_contributions': dict(province_name='Test Province',area_m2=1),
            'poi_preparations': dict(state='completed',phase='done',message='Synthetic',categories=['library'],radius_m=2000,verified_tiles=1,total_tiles=1),
        }
        inserted = {}
        stamp = datetime.now(timezone.utc) + timedelta(days=7)
        with self.engine.begin() as conn:
            # Historical migration 0006 seeded this real setting already.
            conn.execute(text('DELETE FROM public.site_settings'))
            for table in metadata.sorted_tables:
                row = dict(values[table.name])
                for column in table.columns:
                    if column.name in row:
                        continue
                    if column.foreign_keys and not column.nullable:
                        fk = next(iter(column.foreign_keys))
                        row[column.name] = inserted[fk.column.table.name][fk.column.name]
                    elif column.primary_key and column.type.__class__.__name__ == 'UUID':
                        row[column.name] = uuid4()
                    elif column.name == 'expires_at' and not column.nullable:
                        row[column.name] = stamp
                if table.name == 'poi_duplicate_reviews':
                    row['place_id'] = inserted['poi_places']['id']
                    row['other_place_id'] = inserted['poi_places']['id']
                if table.name == 'users':
                    from backend.membership import hash_password
                    row['password_hash'] = hash_password('Synthetic-Test-Password-123')
                record = conn.execute(table.insert().values(**row).returning(*table.c)).mappings().one()
                inserted[table.name] = dict(record)
        return inserted

    def move(self):
        command.upgrade(config(), HEAD)

    def test_01_fresh_database_complete_migration_chain(self):
        command.upgrade(config(), HEAD)
        from backend.models import Base
        from sqlalchemy import inspect
        inspector = inspect(self.engine)
        for table in Base.metadata.tables.values():
            actual = {c['name']:c for c in inspector.get_columns(table.name,schema=table.schema)}
            self.assertEqual(set(actual), set(table.c.keys()), table.fullname)
            for col in table.c:
                self.assertEqual(actual[col.name]['nullable'], col.nullable, f'{table.fullname}.{col.name}')
                actual_type=str(actual[col.name]['type'].compile(dialect=self.engine.dialect))
                expected_type=str(col.type.compile(dialect=self.engine.dialect))
                # PostgreSQL FLOAT without precision means DOUBLE PRECISION.
                self.assertEqual(actual_type.replace('DOUBLE PRECISION','FLOAT'),
                                 expected_type, f'{table.fullname}.{col.name}')
        command.check(config())

    def preservation_roundtrip(self, exported):
        self.old_schema(exported)
        self.seed_all()
        with self.engine.connect() as conn:
            before = self.helper.snapshot(conn)['objects']
            data = rows_digest(conn, dict.fromkeys(self.groups, 'public'))
        self.move()
        if exported:
            # Production DDL and application metadata agree after the move too.
            command.check(config())
        with self.engine.connect() as conn:
            self.assertEqual(before, self.helper.snapshot(conn)['objects'])
            self.assertEqual(data, rows_digest(conn, self.groups))
            self.assertEqual(conn.scalar(text('SELECT version_num FROM public.alembic_version')), HEAD)
        command.downgrade(config(), PREVIOUS)
        with self.engine.connect() as conn:
            self.assertEqual(before, self.helper.snapshot(conn)['objects'])
            self.assertEqual(data, rows_digest(conn, dict.fromkeys(self.groups,'public')))
            self.assertEqual(conn.scalar(text('SELECT question FROM public.kdescription')), 'Synthetic question')
        self.move()
        with self.engine.connect() as conn:
            self.assertEqual(before, self.helper.snapshot(conn)['objects'])
            self.assertEqual(data, rows_digest(conn, self.groups))
            for table in ('topics','users','poi_boundaries','poi_coverage_tiles'):
                schema = self.groups[table]
                sequence = conn.scalar(text('SELECT pg_get_serial_sequence(:t, :c)'),dict(t=f'{schema}.{table}',c='id'))
                maximum = conn.scalar(text(f'SELECT max(id) FROM {schema}.{table}'))
                self.assertGreater(conn.scalar(text('SELECT nextval(CAST(:s AS regclass))'),dict(s=sequence)), maximum)

    def test_02_fresh_schema_data_and_identity_roundtrip(self):
        self.preservation_roundtrip(False)

    def test_03_exported_production_schema_synthetic_roundtrip(self):
        self.preservation_roundtrip(True)

    def test_04_refuses_unacknowledged_cutover_and_running_worker(self):
        self.old_schema()
        with self.assertRaises(RuntimeError):
            command.upgrade(config(allow=False), HEAD)
        with self.engine.connect() as worker:
            worker.execute(text('SELECT pg_advisory_lock(741923816)'))
            worker.commit()
            with self.assertRaises(RuntimeError):
                self.move()
            worker.execute(text('SELECT pg_advisory_unlock(741923816)'))
            worker.commit()
        with self.engine.connect() as conn:
            self.assertEqual(conn.scalar(text('SELECT version_num FROM public.alembic_version')), PREVIOUS)
            self.assertIsNone(conn.scalar(text("SELECT to_regclass('accounts.users')")))

    def test_05_refuses_unresolved_details_and_preparations(self):
        self.old_schema()
        self.seed_all()
        for update, undo in (
            ('UPDATE public.poi_control SET paused=false','UPDATE public.poi_control SET paused=true'),
            ('UPDATE public.poi_control SET in_flight=1','UPDATE public.poi_control SET in_flight=NULL'),
            ('UPDATE public.poi_segments SET pending_details=1','UPDATE public.poi_segments SET pending_details=0'),
            ("UPDATE public.poi_requests SET outcome='dispatched'","UPDATE public.poi_requests SET outcome='successful'"),
            ("UPDATE public.poi_preparations SET state='running'","UPDATE public.poi_preparations SET state='completed'"),
        ):
            with self.engine.begin() as conn:
                conn.execute(text(update))
            with self.assertRaises(RuntimeError):
                self.move()
            with self.engine.begin() as conn:
                self.assertEqual(conn.scalar(text('SELECT version_num FROM public.alembic_version')),PREVIOUS)
                conn.execute(text(undo))

    def test_06_lock_conflict_and_partial_move_rollback(self):
        self.old_schema()
        with self.engine.connect() as reader:
            reader.execute(text('SELECT * FROM public.topics LIMIT 0'))
            with self.assertRaises(DBAPIError):
                self.move()
            reader.rollback()
        migration = module_at('schema_migration', ROOT / 'alembic/versions/0023_domain_schemas.py')
        from alembic.migration import MigrationContext
        from alembic.operations import Operations
        with self.engine.connect() as conn:
            tx = conn.begin()
            ops = Operations(MigrationContext.configure(conn))
            original = migration._verify
            def fail_after_moves(*args):
                original(*args)
                raise RuntimeError('synthetic failure after all table moves')
            with patch.object(migration, 'op', ops), patch.object(migration.context, 'is_offline_mode', return_value=False, create=True), patch.object(migration.context, 'get_x_argument', return_value={'schema_cutover':'yes'}, create=True), patch.object(migration, '_verify', fail_after_moves):
                with self.assertRaises(RuntimeError):
                    migration.upgrade()
            tx.rollback()
            self.assertIsNotNone(conn.scalar(text("SELECT to_regclass('public.users')")))
            self.assertIsNone(conn.scalar(text("SELECT to_regclass('accounts.users')")))

    def test_07_pause_boundary_does_not_discard_or_resume_batches(self):
        self.old_schema()
        self.seed_all()
        with self.engine.begin() as conn:
            conn.execute(text('UPDATE public.poi_control SET paused=false,in_flight=1'))
            self.assertEqual(self.helper.try_pause(conn),(False,'request_in_flight'))
            conn.execute(text('UPDATE public.poi_control SET in_flight=NULL'))
            conn.execute(text('UPDATE public.poi_segments SET pending_details=2'))
            self.assertEqual(self.helper.try_pause(conn),(False,'details_batch_pending'))
            self.assertFalse(conn.scalar(text('SELECT paused FROM public.poi_control')))
            conn.execute(text('UPDATE public.poi_control SET paused=true'))
            self.assertEqual(self.helper.try_pause(conn),(False,'paused_with_unresolved_batch'))
            conn.execute(text('UPDATE public.poi_segments SET pending_details=0'))
            with self.engine.begin() as competing:
                with self.assertRaises(OperationalError):
                    self.helper.try_pause(competing)
            self.assertEqual(self.helper.try_pause(conn),(True,'paused_at_safe_boundary'))

    def bind_application(self):
        from backend import database
        database.engine.dispose()
        database.engine = self.engine
        database.SessionLocal.configure(bind=self.engine)

    def test_08_application_and_foreign_key_behavior(self):
        self.old_schema()
        records = self.seed_all()
        self.move()
        self.bind_application()
        from backend import main, membership, poi_diagnostics
        from backend.maintenance import set_maintenance, maintenance_enabled
        from backend.models import User, SupportTicket, SupportMessage, SupportStatusEvent, SupportAttachment
        from fastapi.testclient import TestClient
        # Permit Windows asyncio's loopback socketpair, forbid external traffic.
        original_connect = socket.socket.connect
        def connect_local_only(sock, address):
            if not isinstance(address, tuple) or address[0] not in ('127.0.0.1','::1'):
                raise AssertionError('Unexpected outbound network')
            return original_connect(sock,address)
        with patch.object(socket.socket, 'connect', connect_local_only):
            with TestClient(main.app, base_url='http://testserver') as client:
                self.assertEqual(client.get('/healthz').status_code,204)
                self.assertEqual(client.get('/api/init-atlas').status_code,200)
                auth = membership.authenticate('09120000001','Synthetic-Test-Password-123')
                self.assertIsNotNone(auth)
                client.cookies.set('bina_session',auth['token'])
                client.headers['X-CSRF-Protection']='1'
                for endpoint in ('/api/auth/me','/api/explorer/init','/api/explorer/indicator?name=Libraries',
                                 '/api/atlas/trend?province=Test%20Province&topic=Culture',
                                 '/api/admin/poi/status','/api/admin/poi/counts','/api/account/tickets'):
                    response=client.get(endpoint)
                    self.assertEqual(response.status_code,200,(endpoint,response.text))
                result=client.post('/api/account/tickets',json=dict(category='other',subject='Synthetic request',message='Synthetic body'))
                self.assertEqual(result.status_code,201,result.text)
                reference=result.json()['reference']
                self.assertEqual(client.post(f'/api/account/tickets/{reference}/reply',json={'message':'Synthetic reply'}).status_code,200)
                from PIL import Image
                image=io.BytesIO()
                Image.new('RGB',(2,2),'blue').save(image,format='PNG')
                upload=client.post('/api/account/ticket-attachments',content=image.getvalue(),headers={
                    'Content-Type':'application/octet-stream','X-Upload-Filename':'synthetic.png','X-Ticket-Reference':reference})
                self.assertEqual(upload.status_code,201,upload.text)
                attachment_id=upload.json()['id']
                attached=client.post(f'/api/account/tickets/{reference}/reply',json={'message':'Synthetic image','attachment_ids':[attachment_id]})
                self.assertEqual(attached.status_code,200,attached.text)
                downloaded=client.get(f'/api/account/ticket-attachments/{attachment_id}')
                self.assertEqual(downloaded.status_code,200,downloaded.text)
                self.assertEqual(downloaded.headers['content-type'],'image/webp')
                for endpoint in ('/api/pois','/api/pois/counts'):
                    self.assertEqual(client.get(endpoint).status_code,403)
                set_maintenance(True)
                self.assertTrue(maintenance_enabled())
                self.assertEqual(client.get('/api/init-atlas').status_code,503)
                set_maintenance(False)
                self.assertEqual(poi_diagnostics.database_report(main.get_settings())['status'],'ok')
        # Cross-schema ON DELETE semantics still work for linked support content.
        with self.engine.begin() as conn:
            ticket = conn.execute(SupportTicket.__table__.insert().values(user_id=records['users']['id'],reference='SUP-'+'B'*16,access_hash='a'*64,category='other',subject='Cascade test').returning(SupportTicket.id)).scalar_one()
            message=conn.execute(SupportMessage.__table__.insert().values(ticket_id=ticket,author='user',body='Cascade').returning(SupportMessage.id)).scalar_one()
            conn.execute(SupportStatusEvent.__table__.insert().values(ticket_id=ticket,from_status='open',to_status='closed'))
            conn.execute(SupportAttachment.__table__.insert().values(id='9'*32,ticket_id=ticket,message_id=message,original_name='synthetic.webp',size_bytes=1,source_bytes=1,width=1,height=1,sha256='4'*64,expires_at=datetime.now(timezone.utc)+timedelta(days=1)))
            conn.execute(User.__table__.delete().where(User.id==records['users']['id']))
            self.assertEqual(conn.scalar(text('SELECT count(*) FROM support.support_tickets WHERE id=:id'),dict(id=ticket)),0)
            self.assertEqual(conn.scalar(text('SELECT count(*) FROM support.support_attachments WHERE ticket_id=:id'),dict(id=ticket)),0)

    def test_09_worker_mocked_details_cycle(self):
        self.old_schema()
        records=self.seed_all()
        self.move()
        self.bind_application()
        from backend.poi_worker import Worker, PendingDetail
        from backend.poi_provider import Reply
        from backend import poi
        from backend.poi_models import PoiJob, PoiSegment, PoiControl, PoiPlace, PoiCoveragePlan
        from backend.poi_coverage import ALGORITHM
        from sqlalchemy import select, func
        from sqlalchemy.orm import Session
        class Provider:
            calls=[]
            def request(self,kind,params):
                self.calls.append(kind)
                if kind=='nearby':
                    return Reply(200,{'layerPoints':{'nearestPoints':[{'poiHash':'synthetic-first'},{'poiHash':'synthetic-second'}]}})
                return Reply(200,dict(name='Synthetic '+params['hash'],location=dict(latitude=31,longitude=51),layer=dict(slug='library',title='Libraries')))
        with self.engine.begin() as conn:
            conn.execute(PoiJob.__table__.update().values(status='running',search_dataset_version=None))
            conn.execute(PoiSegment.__table__.update().values(status='pending',pending_details=0))
            conn.execute(PoiControl.__table__.update().values(paused=False,pilot_segment_id=records['poi_segments']['id'],collection_mode='pilot',next_request_at=None))
            conn.execute(PoiCoveragePlan.__table__.update().values(summary={'result_limit_mode':'unknown','coverage_verified':True,'algorithm':ALGORITHM}))
        worker=Worker(Provider())
        # Spatial resolution uses only the synthetic boundary in this test DB.
        poi.boundary_index.cache_clear()
        with self.engine.connect() as conn:
            conn.execute(text('SELECT pg_advisory_lock(741923816)'))
            pid=conn.scalar(text('SELECT pg_backend_pid()'))
            conn.commit()
            try:
                for step in range(3):
                    conn.execute(PoiControl.__table__.update().values(next_request_at=None))
                    conn.commit()
                    worker.tick(conn,pid)
                    if step<2:
                        with self.engine.begin() as operator:
                            self.assertEqual(self.helper.try_pause(operator),(False,'details_batch_pending'))
            finally:
                conn.rollback()
                conn.execute(text('SELECT pg_advisory_unlock(741923816)'))
                conn.commit()
        self.assertEqual(Provider.calls,['nearby','details','details'])
        self.assertEqual(worker.pending,[])
        with Session(self.engine) as session:
            self.assertEqual(session.scalar(select(PoiSegment.pending_details)),0)
            self.assertIsNone(session.scalar(select(PoiControl.in_flight)))
            self.assertEqual(session.scalar(select(func.count()).select_from(PoiPlace)),3)
        with self.engine.begin() as conn:
            self.assertEqual(self.helper.try_pause(conn),(True,'paused_at_safe_boundary'))

    def test_10_synthetic_pg16_backup_restore(self):
        bin_path=os.environ.get('SCHEMA_TEST_PG_BIN')
        if not bin_path:
            self.skipTest('SCHEMA_TEST_PG_BIN is required for the synthetic backup/restore exercise')
        self.old_schema()
        self.seed_all()
        with self.engine.connect() as conn:
            data=rows_digest(conn,dict.fromkeys(self.groups,'public'))
            counters=[(r['relname'],v['last_value'],v['is_called']) for r,v in zip(self.helper.snapshot(conn)['objects']['sequences'],self.helper.snapshot(conn)['objects']['sequence_values'])]
        destination=self.name+'_restore'
        with self.admin.connect() as conn:
            conn.execute(text(f'CREATE DATABASE "{destination}" OWNER appuser'))
        try:
            with tempfile.TemporaryDirectory(prefix='bina-schema-backup-') as directory:
                archive=str(Path(directory)/'synthetic.backup')
                suffix='.exe' if os.name=='nt' else ''
                source_url=self.url.set(drivername='postgresql').render_as_string(hide_password=False)
                target_url=self.url.set(drivername='postgresql',database=destination).render_as_string(hide_password=False)
                subprocess.run([str(Path(bin_path)/('pg_dump'+suffix)),'--format=custom','--file',archive,'--dbname',source_url],check=True,capture_output=True)
                subprocess.run([str(Path(bin_path)/('pg_restore'+suffix)),'--exit-on-error','--single-transaction','--dbname',target_url,archive],check=True,capture_output=True)
            restored=create_engine(self.url.set(database=destination))
            try:
                with restored.connect() as conn:
                    self.assertEqual(data,rows_digest(conn,dict.fromkeys(self.groups,'public')))
                    objects=self.helper.snapshot(conn)['objects']
                    after=[(r['relname'],v['last_value'],v['is_called']) for r,v in zip(objects['sequences'],objects['sequence_values'])]
                    self.assertEqual(sorted(counters),sorted(after))
            finally:
                restored.dispose()
        finally:
            with self.admin.connect() as conn:
                assert destination.startswith('bina_schema_test_')
                conn.execute(text(f'DROP DATABASE "{destination}" WITH (FORCE)'))

    def test_11_destination_collisions_abort_without_partial_changes(self):
        self.old_schema()
        with self.engine.begin() as conn:
            conn.execute(text('CREATE SCHEMA accounts'))
        with self.assertRaises(RuntimeError):
            self.move()
        with self.engine.begin() as conn:
            self.assertIsNotNone(conn.scalar(text("SELECT to_regclass('public.users')")))
            self.assertIsNone(conn.scalar(text("SELECT to_regclass('analytics.topics')")))
            self.assertEqual(conn.scalar(text('SELECT version_num FROM public.alembic_version')),PREVIOUS)
            conn.execute(text('DROP SCHEMA accounts'))
        self.move()
        with self.engine.begin() as conn:
            conn.execute(text('CREATE TABLE accounts.unexpected_object(id int)'))
        # Downgrade's RESTRICT is deliberate: no CASCADE can delete new objects.
        with self.assertRaises(DBAPIError):
            command.downgrade(config(),PREVIOUS)
        with self.engine.connect() as conn:
            self.assertIsNotNone(conn.scalar(text("SELECT to_regclass('accounts.users')")))
            self.assertIsNone(conn.scalar(text("SELECT to_regclass('public.users')")))
            self.assertIsNotNone(conn.scalar(text("SELECT to_regclass('accounts.unexpected_object')")))
            self.assertEqual(conn.scalar(text('SELECT version_num FROM public.alembic_version')),HEAD)

    def test_12_manifest_models_and_runtime_sql_references_agree(self):
        from backend.models import Base
        migration=module_at('frozen_schema_manifest',ROOT/'alembic/versions/0023_domain_schemas.py')
        frozen={name:schema for schema,names in migration.GROUPS.items() for name in names}
        self.assertEqual(frozen,self.groups)
        self.assertEqual({t.name:t.schema for t in Base.metadata.tables.values()},self.groups)
        self.assertEqual(len(Base.metadata.sorted_tables),38)
        pattern=re.compile(r'\b(?:FROM|JOIN|UPDATE|INTO)\s+(?:public\.)?('+ '|'.join(map(re.escape,self.groups)) +r')\b')
        for file in (ROOT/'backend').glob('*.py'):
            for node in ast.walk(ast.parse(file.read_text(encoding='utf-8'))):
                if isinstance(node,ast.Constant) and isinstance(node.value,str):
                    self.assertIsNone(pattern.search(node.value),f'{file.name}:{node.lineno}: unqualified runtime table')

    def test_13_old_release_rollback_retains_imported_trend_values(self):
        # Simulate externally imported REAL columns while bookkeeping is at 0021.
        command.upgrade(config(),'0021_indicator_metadata')
        with self.engine.begin() as conn:
            conn.execute(text('ALTER TABLE public.trend_score ADD COLUMN coverage_count REAL, ADD COLUMN max_observation_age REAL'))
            conn.execute(text("INSERT INTO public.trend_score(province_name,year,topic_name,coverage_count,max_observation_age) VALUES ('Synthetic',2025,'Synthetic',7.5,2.25)"))
        command.upgrade(config(),PREVIOUS)
        with self.engine.connect() as conn:
            objects=self.helper.snapshot(conn)['objects']
            data=rows_digest(conn,dict.fromkeys(self.groups,'public'))
        self.move()
        command.downgrade(config(),'0021_indicator_metadata')
        with self.engine.connect() as conn:
            self.assertEqual(conn.scalar(text('SELECT version_num FROM public.alembic_version')),'0021_indicator_metadata')
            self.assertEqual(objects,self.helper.snapshot(conn)['objects'])
            self.assertEqual(data,rows_digest(conn,dict.fromkeys(self.groups,'public')))
            self.assertEqual(conn.execute(text('SELECT coverage_count,max_observation_age FROM public.trend_score')).one(),(7.5,2.25))

    def test_14_operator_cli_snapshot_and_verify(self):
        self.old_schema()
        self.seed_all()
        executable=[__import__('sys').executable,str(ROOT/'scripts/schema_cutover.py')]
        report=subprocess.run(executable+['inspect'],cwd=ROOT,check=True,capture_output=True,text=True)
        state=json.loads(report.stdout)
        self.assertEqual(state['database_role'],'appuser')
        self.assertTrue(state['can_create_schemas'])
        self.assertEqual(state['layout'],'public')
        filename=str(Path(self.file_storage.name)/'before.json')
        subprocess.run(executable+['snapshot','--file',filename],cwd=ROOT,check=True,capture_output=True,text=True)
        refused=subprocess.run(executable+['snapshot','--file',filename],cwd=ROOT,capture_output=True,text=True)
        self.assertNotEqual(refused.returncode,0)
        self.move()
        verified=subprocess.run(executable+['verify','--file',filename],cwd=ROOT,check=True,capture_output=True,text=True)
        self.assertIn('PASS:',verified.stdout)


if __name__ == '__main__':
    unittest.main()

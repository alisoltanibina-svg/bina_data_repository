"""Maintenance gate integration tests; never connect to the project database."""

import unittest
from contextlib import contextmanager
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool


class MaintenanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from backend.settings import Settings
        settings = Settings(_env_file=None,
                            database_url="postgresql+psycopg://unused:unused@localhost/unused",
                            captcha_enabled=False)
        cls.settings_patch = patch('backend.settings.get_settings', return_value=settings)
        cls.settings_patch.start()
        cls.addClassCleanup(cls.settings_patch.stop)
        from backend import main, maintenance
        from backend.models import SiteSetting
        cls.main, cls.maintenance, cls.SiteSetting = main, maintenance, SiteSetting
        # Only the existing key/value table is needed. SQLite is an isolated
        # test fixture, never a runtime database fallback.
        cls.engine = create_engine('sqlite://', poolclass=StaticPool,
                                   connect_args={'check_same_thread': False})
        SiteSetting.__table__.create(cls.engine)
        cls.addClassCleanup(cls.engine.dispose)

    def setUp(self):
        with self.engine.begin() as conn:
            conn.execute(self.SiteSetting.__table__.delete())

        @contextmanager
        def isolated_session():
            with Session(self.engine) as session:
                with session.begin():
                    yield session

        session_patch = patch.object(self.maintenance, 'db_session', isolated_session)
        session_patch.start()
        self.addCleanup(session_patch.stop)
        profile_patch = patch.object(self.main, 'profile_from_session_token',
                                     side_effect=lambda token: {'id': 1, 'is_admin': token == 'admin'} if token else None)
        profile_patch.start()
        self.addCleanup(profile_patch.stop)
        ops_patch = patch.object(self.main, 'ops_overview', return_value={})
        ops_patch.start()
        self.addCleanup(ops_patch.stop)
        self.client = TestClient(self.main.app, headers={'X-CSRF-Protection': '1'})
        self.addCleanup(self.client.close)

    def admin(self):
        self.client.cookies.set(self.main.SESSION_COOKIE, 'admin')

    def toggle(self, enabled):
        return self.client.post('/api/admin/ops/maintenance', json={'enabled': enabled})

    def test_enable_every_page_then_disable_restores_pages(self):
        original = self.client.get('/html/explorer.html')
        self.assertEqual(original.status_code, 200)
        self.assertEqual(self.client.get('/html/explorer').content, original.content)
        self.admin()
        self.assertFalse(self.client.get('/api/admin/ops').json()['maintenance_enabled'])
        self.assertEqual(self.toggle(True).json(), {'maintenance_enabled': True})
        # New sessions/workers read the persisted setting, not a process flag.
        with Session(self.engine) as session:
            self.assertEqual(session.get(self.SiteSetting, 'maintenance_enabled').value, '1')
        self.client.cookies.clear()
        for path in ['/', '/index.html', '/html/explorer.html', '/html/explorer', '/html/profile.html',
                     '/html/support.html', '/html/tickets.html', '/html/bubble-chart.html',
                     '/unknown-page?anything=1']:
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 503)
                self.assertIn('سایت در حال به روز رسانی است', response.text)
                self.assertNotIn('<button', response.text)
                self.assertNotIn('<input', response.text)
                self.assertEqual(response.headers['cache-control'], 'no-store')
                self.assertEqual(response.headers['retry-after'], '300')
                self.assertEqual(response.headers['x-content-type-options'], 'nosniff')
        self.assertEqual(self.client.head('/').status_code, 503)
        self.assertEqual(self.client.head('/').content, b'')
        self.assertEqual(self.client.get('/api/atlas/init').status_code, 503)
        for path in ['/html/admin.html', '/html/admin', '/html/admin-login.html', '/html/admin-login',
                     '/css/maintenance.css', '/assets/images/img_404.webp',
                     '/assets/images/bg_curtain.webp', '/js/admin.js']:
            self.assertEqual(self.client.get(path).status_code, 200, path)
        self.admin()
        self.assertTrue(self.client.get('/api/admin/ops').json()['maintenance_enabled'])
        self.assertEqual(self.toggle(False).json(), {'maintenance_enabled': False})
        self.assertFalse(self.client.get('/api/admin/ops').json()['maintenance_enabled'])
        restored = self.client.get('/html/explorer.html')
        self.assertEqual(restored.status_code, 200)
        self.assertEqual(restored.content, original.content)

    def test_anonymous_and_non_admin_cannot_toggle(self):
        self.assertEqual(self.toggle(True).status_code, 401)
        self.client.cookies.set(self.main.SESSION_COOKIE, 'user')
        self.assertEqual(self.toggle(True).status_code, 403)
        self.assertFalse(self.maintenance.maintenance_enabled())

    def test_toggle_requires_strict_boolean_and_is_idempotent(self):
        self.admin()
        for value in ['false', 'true', 1, None]:
            self.assertEqual(self.toggle(value).status_code, 422)
        for enabled in [True, True, False, False]:
            self.assertEqual(self.toggle(enabled).status_code, 200)
            self.assertEqual(self.maintenance.maintenance_enabled(), enabled)

    def test_admin_sign_in_apis_remain_reachable_during_maintenance(self):
        self.admin()
        self.toggle(True)
        self.client.cookies.clear()
        self.assertIsNone(self.client.get('/api/auth/session').json())
        # Validation from the auth route proves the gate did not intercept it.
        self.assertEqual(self.client.post('/api/auth/login', json={}).status_code, 422)


if __name__ == '__main__':
    unittest.main()

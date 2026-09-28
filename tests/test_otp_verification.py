"""OTP proof regression tests, isolated in a temporary PostgreSQL schema.

Run: TEST_DATABASE_URL=postgresql+psycopg://... python -B -m unittest discover -s tests -v
No project .env is loaded, SMS is mocked, and application startup is not run.
"""
import hashlib
import importlib.util
import os
from pathlib import Path
import secrets
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker


@unittest.skipUnless(os.environ.get("TEST_DATABASE_URL"), "Set TEST_DATABASE_URL to a test PostgreSQL database")
class OtpVerificationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from backend.settings import Settings

        url = os.environ["TEST_DATABASE_URL"]
        settings = Settings(_env_file=None, database_url=url, admin_phone="", admin_password="", kavenegar_api_key="")
        cls.settings_patch = patch("backend.settings.get_settings", return_value=settings)
        cls.settings_patch.start()
        cls.addClassCleanup(cls.settings_patch.stop)
        from backend import database, membership, models, otp
        from backend.main import app
        from fastapi.testclient import TestClient

        cls.db, cls.membership, cls.models, cls.otp = database, membership, models, otp
        cls.schema = "otp_test_" + secrets.token_hex(8)
        cls.control = create_engine(url)
        cls.addClassCleanup(cls.control.dispose)
        with cls.control.begin() as conn:
            conn.execute(text(f'CREATE SCHEMA "{cls.schema}"'))
        cls.addClassCleanup(cls.drop_schema)
        cls.engine = create_engine(url, connect_args={"options": f"-csearch_path={cls.schema}"})
        cls.addClassCleanup(cls.engine.dispose)
        cls.session_patch = patch.object(database, "SessionLocal", sessionmaker(bind=cls.engine, autoflush=False))
        cls.session_patch.start()
        cls.addClassCleanup(cls.session_patch.stop)
        models.Base.metadata.create_all(cls.engine)
        # Deliberately avoid TestClient's lifespan context: bootstrap seeds admins.
        cls.client = TestClient(app)
        cls.addClassCleanup(cls.client.close)
        cls.sms_patch = patch.object(otp, "notify_registration_filed")
        cls.sms_patch.start()
        cls.addClassCleanup(cls.sms_patch.stop)

    @classmethod
    def drop_schema(cls):
        with cls.control.begin() as conn:
            conn.execute(text(f'DROP SCHEMA "{cls.schema}" CASCADE'))

    def setUp(self):
        self.client.cookies.clear()
        with self.engine.begin() as conn:
            for table in reversed(self.models.Base.metadata.sorted_tables):
                conn.execute(table.delete())
        self.phone = "09120000001"
        self.old_password = "original-password"
        with self.db.db_session() as session:
            user = self.models.User(phone=self.phone, first_name="Test", last_name="User",
                                    password_hash=self.membership.hash_password(self.old_password),
                                    is_active=True, is_admin=False)
            session.add(user)
            session.flush()
            self.user_id = user.id

    def challenge(self, phone=None, purpose="reset"):
        with self.db.db_session() as session:
            row = self.models.OtpChallenge(phone=phone or self.phone, purpose=purpose, salt="test-salt",
                                          code_hash=self.otp._hash_code("test-salt", "654321"),
                                          expires_at=datetime.now(timezone.utc) + timedelta(minutes=3), attempts=0)
            session.add(row)
            session.flush()
            return row.id

    def proof(self, phone=None, purpose="reset"):
        challenge_id = self.challenge(phone, purpose)
        result = self.otp.verify_otp(phone or self.phone, purpose, "654321")
        return challenge_id, result["verification_token"]

    def consume(self, token, phone=None, purpose="reset"):
        with self.db.db_session() as session:
            self.otp.consume_verified_otp_in_session(session, phone or self.phone, purpose, token)

    def test_verify_returns_proof_and_stores_only_hash(self):
        challenge_id = self.challenge()
        response = self.client.post("/api/auth/otp/verify", json={"phone": self.phone, "purpose": "reset", "code": "654321"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["cache-control"], "no-store")
        token = response.json()["verification_token"]
        self.assertRegex(token, r"^[A-Za-z0-9_-]{43}$")
        with self.db.db_session() as session:
            row = session.get(self.models.OtpChallenge, challenge_id)
            self.assertEqual(row.verification_token_hash, hashlib.sha256(token.encode("ascii")).hexdigest())
            self.assertNotEqual(row.verification_token_hash, token)

    def test_password_reset_requires_proof_even_after_victim_verifies(self):
        _, token = self.proof()
        body = {"phone": self.phone, "password": "replacement-password"}
        self.assertEqual(self.client.post("/api/auth/password/reset", json=body).status_code, 422)
        body["verification_token"] = secrets.token_urlsafe(32)
        self.assertEqual(self.client.post("/api/auth/password/reset", json=body).status_code, 400)
        with self.db.db_session() as session:
            user = session.get(self.models.User, self.user_id)
            self.assertTrue(self.membership.verify_password(user.password_hash, self.old_password))
        body["verification_token"] = token
        response = self.client.post("/api/auth/password/reset", json=body)
        self.assertEqual(response.status_code, 200)
        self.assertIn("bina_session", response.cookies)
        self.assertEqual(self.client.post("/api/auth/password/reset", json=body).status_code, 400)
        with self.db.db_session() as session:
            user = session.get(self.models.User, self.user_id)
            self.assertTrue(self.membership.verify_password(user.password_hash, body["password"]))

    def test_registration_requires_its_own_proof(self):
        phone = "09120000002"
        _, token = self.proof(phone, "register")
        body = dict(phone=phone, first_name="Test", last_name="Applicant", role_title="Researcher", password="new-password")
        self.assertEqual(self.client.post("/api/auth/register", json=body).status_code, 422)
        body["verification_token"] = secrets.token_urlsafe(32)
        self.assertEqual(self.client.post("/api/auth/register", json=body).status_code, 400)
        body["verification_token"] = token
        response = self.client.post("/api/auth/register", json=body)
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["status"], "pending")

    def test_proof_cannot_cross_phone_or_purpose(self):
        _, token = self.proof()
        for phone, purpose in [("09120000002", "reset"), (self.phone, "register")]:
            with self.subTest(phone=phone, purpose=purpose):
                with self.assertRaises(self.membership.MembershipError):
                    self.consume(token, phone, purpose)
        self.consume(token)

    def test_expired_consumed_unverified_and_legacy_challenges_fail(self):
        for state in ["expired", "consumed", "unverified", "legacy"]:
            with self.subTest(state=state):
                challenge_id, token = self.proof()
                with self.db.db_session() as session:
                    row = session.get(self.models.OtpChallenge, challenge_id)
                    if state == "expired": row.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
                    if state == "consumed": row.consumed_at = datetime.now(timezone.utc)
                    if state == "unverified": row.verified_at = None
                    if state == "legacy": row.verification_token_hash = None
                with self.assertRaises(self.membership.MembershipError):
                    self.consume(token)

    def test_reverify_cannot_issue_a_second_proof(self):
        _, token = self.proof()
        with self.assertRaises(self.membership.MembershipError):
            self.otp.verify_otp(self.phone, "reset", "654321")
        self.consume(token)

    def test_resend_invalidates_existing_proof(self):
        challenge_id, token = self.proof()
        with self.db.db_session() as session:
            row = session.get(self.models.OtpChallenge, challenge_id)
            row.created_at = datetime.now(timezone.utc) - timedelta(minutes=2)
        with patch.object(self.otp, "_kavenegar_configured", return_value=False):
            self.otp.send_otp(self.phone, "reset")
        with self.assertRaises(self.membership.MembershipError):
            self.consume(token)

    def test_failed_account_change_rolls_back_proof_consumption(self):
        _, token = self.proof()
        with patch.object(self.membership, "hash_password", side_effect=RuntimeError("simulated failure")):
            with self.assertRaises(RuntimeError):
                self.membership.reset_password_after_otp(self.phone, "new-password", token)
        result = self.membership.reset_password_after_otp(self.phone, "new-password", token)
        self.assertEqual(result["profile"]["id"], self.user_id)

    def test_concurrent_consumers_only_one_succeeds(self):
        _, token = self.proof()
        barrier = threading.Barrier(2)
        def attempt():
            barrier.wait(timeout=5)
            try:
                self.consume(token)
                return True
            except self.membership.MembershipError:
                return False
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: attempt(), range(2)))
        self.assertEqual(sorted(results), [False, True])

    def test_concurrent_verifiers_only_one_gets_proof(self):
        self.challenge()
        barrier = threading.Barrier(2)
        def attempt():
            barrier.wait(timeout=5)
            try:
                return self.otp.verify_otp(self.phone, "reset", "654321")["verification_token"]
            except self.membership.MembershipError:
                return None
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: attempt(), range(2)))
        self.assertEqual(sum(token is not None for token in results), 1)

    def test_migration_adds_column_and_invalidates_old_challenges(self):
        from alembic.migration import MigrationContext
        from alembic.operations import Operations
        path = Path(__file__).resolve().parents[1] / "alembic/versions/0007_otp_verification_tokens.py"
        spec = importlib.util.spec_from_file_location("otp_migration", path)
        migration = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(migration)
        challenge_id = self.challenge()
        with self.engine.begin() as conn:
            with Operations.context(MigrationContext.configure(conn)):
                migration.downgrade()
                migration.upgrade()
            row = conn.execute(text("SELECT consumed_at, verification_token_hash FROM otp_challenges WHERE id=:id"), {"id": challenge_id}).one()
            self.assertIsNotNone(row.consumed_at)
            self.assertIsNone(row.verification_token_hash)


if __name__ == "__main__":
    unittest.main()

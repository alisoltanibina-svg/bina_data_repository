# Deploy the OTP verification fix

This release fixes finding 1: successful OTP verification now issues a random,
single-use credential required by registration and password reset. Only its hash
is stored in PostgreSQL. It expires with the original OTP challenge (normally
three minutes after sending), and a resend invalidates the previous credential.

## Files to deploy together

- `backend/main.py`
- `backend/membership.py`
- `backend/models.py`
- `backend/otp.py`
- `js/auth-page.js`
- `index.html`
- `alembic/versions/0007_otp_verification_tokens.py`
- Apply the deletion of the empty `alembic/__init__.py`. That file shadows the
  installed Alembic package when Python starts from the project directory.

The files under `tests/` are local regression tests; they are not needed on the
public server. No new environment variables or runtime dependencies are needed.

## Server steps

1. Take a database backup using your normal backup procedure.
2. Identify the systemd unit containing the supplied `Description=app FastAPI`
   service. Substitute its actual filename for `YOUR_SERVICE.service` below.
3. Stop that unit **before replacing the application files**:

   ```bash
   sudo systemctl stop YOUR_SERVICE.service
   ```

4. Upload the files above to their corresponding paths under `/opt/app`, and
   apply the empty-file deletion. Keep the production `.env` intact.
5. Run the migration using the server's existing virtual environment:

   ```bash
   cd /opt/app
   /opt/app/venv/bin/alembic upgrade head
   /opt/app/venv/bin/alembic current
   ```

   The current revision should be `0007_otp_verification_tokens`. If migration
   fails, resolve the reported error before starting the updated backend.

6. Start the service and check its status/logs:

   ```bash
   sudo systemctl start YOUR_SERVICE.service
   sudo systemctl status YOUR_SERVICE.service --no-pager
   sudo journalctl -u YOUR_SERVICE.service -n 50 --no-pager
   ```

Nginx does not need a configuration change for this fix. API requests will be
unavailable during the stop/migrate/start interval. The migration invalidates
in-progress OTP challenges, so affected users must request a new code. Existing
login sessions are unaffected. Already-open authentication pages should reload;
`index.html` includes a versioned URL for the updated authentication script.

## Production smoke check

Using a designated test account, complete password recovery from a freshly
loaded page. Then use a separate test number to complete registration and verify
that its request reaches the pending state. Do not use the seeded administrator
for this check: administrator password seeding is a separate outstanding finding.

The registration and reset APIs now reject requests without `verification_token`.
Any other API clients must pass the token returned by `/api/auth/otp/verify` in
their final request body. Never put the token in a URL or logs.

## Verification performed locally

- 11 integration tests against temporary PostgreSQL, including migration,
  missing/incorrect proofs, cross-phone and cross-purpose use, expiry, resend,
  rollback, and simultaneous verification/consumption.
- Frontend flow tests using `node --test tests/auth_page_otp.test.cjs`.

The other security findings, including the failed-attempt counter rollback
(finding 2), remain separate work. Reverting to the old backend would restore
the original vulnerability; keep the service stopped if a deployment needs repair.

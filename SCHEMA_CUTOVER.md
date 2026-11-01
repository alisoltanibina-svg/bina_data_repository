# PostgreSQL schema grouping: deployment and rollback

This is a coordinated maintenance release for `app-api.service` and
`poi-worker.service`. Preparation and rehearsal do not authorize a production
cutover. Do not deploy the new Python modules while the old services are running.

## Scope and production baseline

- Reviewed production code: `c52b80964611d092bbdd050aa55161be9ccfe62e`.
- Production PostgreSQL: 16.15; database `appdb`; inspected owner role `appuser`.
- Production revision reported: `0020_poi_admin_preparation`. Both metadata
  columns introduced by 0021 already exist as nullable TEXT in `kdescription`.
- The export also has nullable REAL `trend_score.coverage_count` and
  `trend_score.max_observation_age` outside the old migration/model history.
  Migration 0022 adopts these independently; 0023 groups tables afterward.
- 38 application tables move from `public` into five schemas. Table names,
  columns, data, index names, constraint names, IDs, and API fields stay the same.
- `public.alembic_version` remains in place. No global `search_path` change,
  compatibility views, dependency upgrades, frontend rebuild, service changes,
  table copying, or deletion is required.
- `analytics`: 8 dashboard tables; `accounts`: 8 identity/security tables;
  `support`: 4 ticket tables; `poi`: all 17 collector tables; `app`: site settings.

## What has been rehearsed

The tracked synthetic suite in `tests/test_schema_cutover.py` exercises a
disposable PostgreSQL 16.15 cluster with a non-superuser application/database
owner role. It accepts only a loopback test administrator on a nonstandard port
and creates randomly named `bina_schema_test_*` databases.

The suite covers the full fresh migration chain, the supplied production schema
populated only with synthetic rows, upgrade/downgrade/re-upgrade, table and object
identities, all table row digests, sequence counters and subsequent generated
IDs, schema collisions, busy-table refusal, advisory-lock refusal, unresolved
worker/preparation refusal, transaction rollback after table moves, Alembic drift
checks, real API startup and reads, sessions, ticket writes, image attachment
upload/claim/download, cross-schema delete cascades, a mocked Nearby + Details
batch, boundary pause locking, and a PostgreSQL 16 synthetic dump/restore.

The production schema archives contain no table data or sequence counters. They
were generated using pg_dump 18.6. The isolated schema test removes psql control
lines and `SET transaction_timeout = 0` only from its local extracted SQL copy;
neither original archive is modified. This is not proof that a classified full
backup restores successfully. Do not change production PostgreSQL to version 18
as part of this work.

## Gates before scheduling

1. Review the candidate and pin it to a release commit. Preserve the old commit
   above and its deployment files. Use the same dependency environment; no pip
   upgrade is part of this release.
2. Verify a recent full backup privately using PostgreSQL 16 tools and an isolated
   PostgreSQL 16 instance. Check table data, sequence counters, and restore errors
   locally. Do not upload records, credentials, or a full backup to chat. Preserve
   the original backups and a copy off the production host. Verify enough disk
   space for the final backup and recovery. Database dumps do not include private
   attachment/avatar files; preserve those existing files and permissions too.
3. Confirm actual service database configuration using the read-only helper
   commands below. Both must match the operator configuration and use the
   expected `appdb`/`appuser`, unless an explicitly reviewed grant plan exists.
   The migration role must own all 38 tables and have database CREATE privilege
   for schema creation. Do not run the migration as the PostgreSQL superuser to
   bypass this check.
4. Identify and suspend all scheduled imports, manual writers, external scripts,
   and preparation processes during the window. Finish or explicitly resolve
   queued/running preparation before deployment. Close open database-tool
   transactions. The cutover never automatically terminates unknown sessions.
5. Verify the independent Nginx maintenance page using `MAINTENANCE.md`. An admin
   maintenance flag alone does not exclude every writer and requires the API.
   Have the exact enable/disable configuration change ready before the window.

## Stage operator tools without changing live application code

Prepare a separate directory outside `/opt/app`, containing the candidate
`scripts/schema_cutover.py`, `backend/__init__.py`, `backend/settings.py`, and
`backend/db_schema.py`. The review package includes these as
`schema-cutover-operator.zip`. Verify its published checksum before extraction.
It contains no `.env`, connection strings, database records, or schema dump.

For the examples, use `/opt/bina-schema-cutover` as that directory. Link its
`.env` to `/opt/app/.env` using the deployment account, preserving the original
file's ownership and permissions. The tools do not modify that file. Clear stale
DATABASE_URL overrides from the operator shell; do not source `.env` as shell
code or paste its contents into chat. A service environment that differs from
`.env` must be resolved before proceeding, not silently overwritten.

Run using the existing production interpreter:

```bash
cd /opt/bina-schema-cutover
/opt/app/venv/bin/python scripts/schema_cutover.py --service app-api.service inspect
/opt/app/venv/bin/python scripts/schema_cutover.py --service poi-worker.service inspect
```

These read the running services' effective DATABASE_URL from `/proc` (root access
may be required), connect read-only, and print only database identity and
operational counts. They do not display credentials, application records, or
provider identifiers. `matches_operator_configuration` must be true for both.
Current table ownership does not prove that both live services use that role;
this check establishes the effective configuration before stopping them.

## Maintenance window sequence

Run each stage separately. If a command fails or any expected state differs,
keep maintenance enabled and investigate; do not continue automatically.

1. Enable the verified Nginx edge maintenance mode, test `nginx -t`, reload Nginx,
   and confirm public pages/API requests receive the intended 503 page. Keep SSH
   access open. Prevent administrators and scripts from starting new jobs.

2. In the staged operator directory, request a safe batch-boundary pause:

   ```bash
   /opt/app/venv/bin/python scripts/schema_cutover.py pause-at-boundary --timeout 1800
   ```

   This locks the same collector control row as dispatch and response handling.
   It only persists pause when no request is in flight, no segment has pending
   Details or processing status, and no dispatched request/preparation remains.
   It does not resume paused work, shorten provider cooldowns, discard hashes,
   reset jobs, or requeue uncertain work. If a batch is already paused and
   unresolved, or the timeout expires, stop the deployment and review the worker
   while keeping it alive. Do not force a restart to bypass the gate.

3. After `paused_at_safe_boundary`, stop both services explicitly:

   ```bash
   sudo systemctl stop poi-worker.service
   sudo systemctl stop app-api.service
   sudo systemctl show --no-pager app-api.service poi-worker.service \
     -p Id -p ActiveState -p SubState -p MainPID -p ControlGroup
   ```

   Require inactive services with no remaining main process. Verify their cgroups
   and independently launched planners/imports have no surviving writer. If a
   process times out or is killed, recheck collector state and abort unless the
   safe state is established. No PostgreSQL restart is required.

4. Take the final full database backup using the existing verified backup method
   and PostgreSQL 16 tools, now that writers are stopped. Keep its success status,
   archive inventory, checksum, and recovery location privately. The two-day-old
   regular backup is not a substitute for this final backup.

5. Deploy the complete pinned candidate release to `/opt/app`. Keep both services
   stopped. Preserve `.env`, private attachments, avatars, and service overrides.
   Do not deploy just the migration or just the models. Do not run a generic
   deployment hook that automatically starts services or upgrades dependencies.

6. From `/opt/app`, reconcile the imported metadata through 0022 using bounded PostgreSQL timeouts:

   ```bash
   PGOPTIONS='-c lock_timeout=5s -c statement_timeout=60s' \
     /opt/app/venv/bin/alembic upgrade 0022_trend_metadata
   /opt/app/venv/bin/alembic current
   ```

   Require `0022_trend_metadata`. The existing question/unit and two trend metadata
   columns are adopted, not recreated. Migration 0022 adds nullable REAL columns
   only when absent and rejects incompatible existing types/nullability. Never use `stamp head` as a substitute.

7. Capture catalog identities/counters, apply exactly 0023, then verify before
   starting either service:

   ```bash
   umask 077
   /opt/app/venv/bin/python scripts/schema_cutover.py inspect
   /opt/app/venv/bin/python scripts/schema_cutover.py snapshot \
     --file /opt/bina-schema-cutover/before-0023.json
   /opt/app/venv/bin/alembic -x schema_cutover=yes upgrade 0023_domain_schemas
   /opt/app/venv/bin/python scripts/schema_cutover.py verify \
     --file /opt/bina-schema-cutover/before-0023.json
   /opt/app/venv/bin/alembic check
   /opt/app/venv/bin/alembic current
   ```

   Snapshot refuses to overwrite an existing file. Choose a fresh filename if
   repeating a reviewed attempt. It reads catalogs and sequence counters only,
   not application records. Require PASS, no unexpected Alembic drift, and exact
   revision `0023_domain_schemas`. Both operations remain at the same database
   role used for inspection. `verify` checks ownership/ACLs, table/column/FK/index
   and sequence identities and counters, and correct index/sequence placement.
   It deliberately does not claim to compare classified table contents.

   The migration takes bounded locks, holds collector/preparation admission locks,
   rejects unexpected destination schemas, and moves tables in one transaction.
   It checks table OIDs before/after and performs no data-copy DML. On a refusal,
   do not delete queues, drop schemas, kill sessions, or raise timeouts blindly.

8. Start the API behind edge maintenance and verify its startup logs:

   ```bash
   sudo systemctl start app-api.service
   sudo systemctl is-active app-api.service
   curl --fail --silent --show-error --output /dev/null http://127.0.0.1:8000/healthz
   curl --fail --silent --show-error --output /dev/null http://127.0.0.1:8000/api/init-atlas
   ```

   `/healthz` is liveness only. Validate dashboard reads and authenticated sessions,
   explorer, admin POI status/counts, support and existing attachment access using
   an approved local/private route. If application maintenance is also enabled,
   account for its expected 503 rather than treating it as a schema error. API
   startup cleans expired security/attachment data; after this point exact
   sequence-counter snapshot comparison may also differ after test writes.

9. Start the worker while persisted collection pause remains true:

   ```bash
   sudo systemctl start poi-worker.service
   sudo systemctl is-active poi-worker.service
   /opt/app/venv/bin/python scripts/schema_cutover.py inspect
   ```

   Require exact revision 0023, grouped layout, `paused=true`, no in-flight request,
   no unresolved segment/dispatch, and no unexpected worker recovery warning.
   Confirm that starting it did not dispatch a provider request. Keep job IDs,
   places, preparation state and provider cooldown unchanged.

10. Reopen traffic only after the checks pass. Resume collection explicitly via
    its existing admin control, then observe a complete request/Details cycle,
    service logs, and database errors. Do not run synthetic provider traffic on
    production. Downtime includes safe quiescence/backup/verification; the tiny
    synthetic test duration is not a production downtime estimate.

## Rollback

Keep or re-enable edge maintenance and stop all writers before rollback. Preserve
the new code until the database has been downgraded, because it contains 0023.

If 0023 was refused/rolled back, inspect `alembic current` and the helper layout;
do not assume it committed. If revision is 0022 and layout is public, use the
candidate's `alembic downgrade 0021_indicator_metadata` first: 0022's downgrade
deliberately retains imported columns. Revision 0021 is known to the old release.
If revision is already 0021/public, no database rollback is needed.

If 0023 committed:

```bash
cd /opt/app
/opt/app/venv/bin/alembic -x schema_cutover=yes downgrade 0021_indicator_metadata
/opt/app/venv/bin/python scripts/schema_cutover.py inspect
```

Require revision 0021 and public layout. This reverses 0023 and the bookkeeping
for 0022, whose downgrade preserves its imported columns and values. If no
post-snapshot writes occurred, run
the same `verify --file ...` check. If the API has already started or writes have
occurred, compare catalog identities separately and investigate expected sequence
or cleanup differences rather than erasing data to force an exact match.

Restore the previous pinned code release `c52b80964611d092bbdd050aa55161be9ccfe62e`,
excluding the candidate-only 0022 and 0023 migrations from its migration directory. Preserve
runtime files/configuration. Start the old API behind maintenance, verify it, then
start the old worker paused. Reopen traffic and resume collection only after
validation. A database at revision 0021 works with the old code's existing columns.

Never downgrade to 0020: 0021's downgrade drops `question` and `measurement_unit`
and their imported values. Never use DROP SCHEMA CASCADE. Rollback refuses extra
objects rather than deleting them. Restoring the final backup is the recovery
fallback, not the default rollback: it can lose writes made after that backup and
does not restore external attachment/avatar files.

## Reproduce the local synthetic rehearsal

Provide a disposable PostgreSQL 16 cluster on loopback, a `schema_admin` test
administrator, and a nonstandard port. The test creates non-superuser `appuser`
if absent, then creates/drops only its random test databases. Never point it at a
cluster containing real data. The default application `.env` is not used for DB
connections; the tests override DATABASE_URL and disable external service keys.

Set `SCHEMA_TEST_ADMIN_URL` to that local administrator URL. Optionally set
`SCHEMA_TEST_SCHEMA_FILE` to an extracted schema-only SQL copy and
`SCHEMA_TEST_PG_BIN` to PostgreSQL 16's binary directory, then run:

```bash
python -m unittest discover -s tests -p test_schema_cutover.py -v
```

Do not count skipped exported-schema or backup/restore tests as completed checks.
The tests require the application dependencies and `httpx` for TestClient. Neither
the portable server nor synthetic fixtures belong in a production deployment.

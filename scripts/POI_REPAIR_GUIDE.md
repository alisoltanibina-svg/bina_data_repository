# Place identity and nationwide discovery repair

This release adds migrations `0030_poi_canonical`, `0031_poi_retired_sources`, and
`0032_poi_matching_indexes`. It changes the independent
collector as well as the application. Run the preparation separately for each
database that needs repair. An imported test database and the database used by
the running collector may be different.

Check the actual API and worker checkouts and environment files first:

```bash
sudo systemctl show test-api poi-worker -p WorkingDirectory -p EnvironmentFiles
```

The commands below target `appdb_test` from `/opt/test`. Use the corresponding
checkout, database name, and service units when deploying elsewhere. The worker
must load this release from its own checkout; updating only the test API does
not update a worker running from a different directory.

## Prepare the database

1. Pause collection in its administrator page. Stop the worker using this
   database, and stop its API writers while deploying and migrating.
2. Apply the release and migration in that checkout:

```bash
cd /opt/test
venv/bin/python -m alembic upgrade head
```

3. Preview source consolidation. This command is read-only and makes no
   provider requests:

```bash
venv/bin/python -m scripts.reconcile_poi_places --expect-database appdb_test
```

4. Apply the safe groups:

```bash
venv/bin/python -m scripts.reconcile_poi_places \
  --apply --expect-database appdb_test
```

Only complete-link groups qualify: same category, normalized province and
name, and every pair within 20 metres. A group with one history-bearing record
keeps that record as its canonical place. Conflicting histories and distance
chains remain available for explicit review. All source rows, revisions,
photos, attribution, and awards are retained. Existing URLs resolve to the
canonical record. Contribution points count once per user/place/action.

A truncated scan cannot be applied. For larger source tables, run the same
command with `--province "PROVINCE" --category CATEGORY` to process bounded
scopes. The command reports these limits instead of silently skipping rows.

5. Audit and prepare historical collection work nationwide:

```bash
venv/bin/python -m scripts.repair_poi_coverage --expect-database appdb_test
venv/bin/python -m scripts.repair_poi_coverage \
  --apply --recover-interrupted --expect-database appdb_test
```

The second command requires collection to be paused and the worker stopped.
It prepares all verified polygon plans, categories, and provinces; it makes no
Neshan calls. Each repair checkpoint commits independently. Rerunning resumes
remaining preparation without creating another refinement tree. Interrupted
in-memory Details handoffs are requeued as fresh Nearby work; authorization,
identity, and genuine provider failures remain visible for review.

## Run and verify

Build the frontend with `venv/bin/python scripts/build_frontend.py`, then start
the appropriate API and worker services. Collection remains paused. Resume it
from the administrator page when ready. Provider requests begin only then and
retain the existing pacing/backoff rules.

The worker refines saturated searches recursively, including old completed
searches. A conservative five-result trigger applies when the configured limit
is unknown or larger; it is an observed saturation safeguard, not a promise
that shorter responses are exhaustive. Minimum-radius saturation remains
unresolved for review. Provincial editing stays disabled while relevant
searches, descendants, Details, or cross-border coverage pieces are incomplete.

`--activate JOB_UUID --expect-database appdb_test` on the coverage repair command
can select a prepared historical job only when no other job is active. It
leaves collection paused. Legacy settlement/grid history is preserved; it does
not establish verified provincial coverage. If a database has no verified
polygon plan, prepare and verify one through the existing collection tools.

Verify with `scripts.audit_poi_quality`, optionally adding a province/category
and a known missing place's `--point LAT LON --name "NAME"`. It reports linked
and unresolved duplicate groups separately. Actual missing records appear as
the worker consumes the prepared queue, rather than during offline preparation.

## Resolve a conflicting identity group

After reviewing all retained records and histories, preview an explicit
canonical choice and then apply the same command with `--apply`:

```bash
venv/bin/python -m scripts.reconcile_poi_places \
  --canonical CANONICAL_UUID --members SOURCE_UUID SOURCE_UUID \
  --expect-database appdb_test
```

This chooses the displayed profile without deleting or reparenting the other
histories. Pending proposals on retired aliases must be resubmitted against
the canonical profile; the review page identifies them and prevents accidental
publication. Reviewed manual/Neshan duplicates keep provider observations in
provider-owned rows, so collection never overwrites manually supplied data.

## Physically remove exact-coordinate duplicate source rows

This is optional and separate from the 20-metre live matching rule. It requires
exact equality of both stored coordinates, matching category, and matching
normalized province/name. Different provider hashes do not distinguish places.
It processes resolved Neshan source records across all categories and provinces
unless a scope is supplied. Manual submissions are retained.

After pausing collection, stopping its worker and API, and applying migrations,
preview the cleanup:

```bash
venv/bin/python -m scripts.purge_exact_poi_duplicates --expect-database appdb_test
```

Apply the same cleanup by adding `--apply`:

```bash
venv/bin/python -m scripts.purge_exact_poi_duplicates \
  --expect-database appdb_test --apply
```

One physical row remains per eligible exact group. Removed source rows and
affected reference metadata are retained in `poi.poi_retired_places` as a
recovery archive. Original UUIDs continue to resolve to the canonical place.
Edits, photos, revision history, and contribution awards stay under their
original identities. The command remaps collector references without cascading
away user history, and requires the worker's advisory lock to be free.

Groups with conflicting independent user histories are reported for explicit
canonical review first. Missing category/province/name information and truncated
scans are reported rather than treated as confirmed duplicates. For a larger
database, use `--province "PROVINCE" --category CATEGORY` scopes. The command
commits each successful group independently; an interruption reports committed
deletions and a rerun continues with remaining duplicates. It does not reset
province searches or call Neshan. Restart the updated services afterwards.

## Faster nearby-to-database matching

Migration `0032_poi_matching_indexes` adds lookup and province-gate indexes.
Apply `venv/bin/python -m alembic upgrade head` in the checkout/environment for
each database being served, then reload the API. Pause the corresponding
collector while building indexes; reload its service too when deploying the
updated model file so its revision matches the API's expected revision.

Matching now selects nearby original, archived, and locally moved locations
separately through their indexes before loading canonical metadata. The
20-metre distance, category, province/name, privacy, and ambiguity checks remain
in force. Profiles check only their original/corrected provinces, with fresh
cross-border and descendant checks. Reopening unchanged source information
avoids rewriting its observation records. No matching or authorization TTL
cache is introduced.

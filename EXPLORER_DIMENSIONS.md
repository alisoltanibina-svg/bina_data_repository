# Explorer modules and dimensions

The Explorer landing catalog now comes from `analytics.modules`. Only a module named
`نماگرهای دیده بان`, `شاخص‌های دیده‌بان`, or `Monitor Indicators` is enabled. Other module
names/descriptions remain visible as disabled cards. The Monitor module is backed by
`kindicator_score` and indicator metadata in `kdescription`; other module score adapters
are intentionally deferred until those modules are activated.

Each module maps `topic`, `subtopic`, `indicator`, and `filter` to column names in its
`ref_table`. References are restricted to the analytics schema, identifiers are checked
against actual table columns, and catalogs use DISTINCT. The mapped `filter` column
contains the dimension names for each indicator. Normally these are `kdescription` /
`topic_name`, `subtopic_name`, `indicator_name`, `dimensions`.

Module mappings may be NULL, empty, or whitespace-only. The backend supplies the above
standard defaults for Monitor Indicators when its reference is empty or `kdescription`.
For other reference tables, blank field mappings produce NULL catalog fields; rows without
a Domain, Subject, or Indicator do not create navigable entries. A module with no reference
and no Monitor defaults has an empty catalog. These defaults are resolved in memory and
never written back to the database. Imported unquoted reference names are normalized
to lowercase, so `Kdescription` and `Analytics.Kdescription` resolve to
`analytics.kdescription`. Explicit nonempty mappings remain validated.

Scores accept a JSON object or imported text such as `{province: 2, sex:1}`.
Dimension declarations accept PostgreSQL arrays, JSON arrays, or `{province, sex}` text.
There is no fixed number of dimensions. `dimensions.dimension_key` supplies display
labels for each `(dimension_name, dimension_value)` pair. Unmapped categories remain
visible with their raw identifiers; numeric province codes without lookup labels cannot
be mapped geographically. Legacy rows with no dimension object retain their province.

Every full dimension combination is a separate chart/table series. Filters are generated
only for declared dimensions. All available values start selected; selecting none excludes
those rows. Missing dimensions on aggregate rows do not exclude those aggregate rows.
No averaging or summing is performed. Duplicate observations for one combination/year
raise a data error instead of silently replacing values. Maps require a single score per
province/year; select one non-province category per dimension to resolve overlapping slices.
`index_include` is stored and returned with metadata; no new scoring logic uses it.

## Deployment

The application database has not been modified during implementation.

1. Take a reviewed database backup and confirm migration 0023 is already applied.
   For an older database, complete the existing SCHEMA_CUTOVER.md procedure first.
2. Review and run `alembic upgrade head` to apply `0024_explorer_dimensions`.
   Existing columns and their imported types/values are preserved. Existing public
   `dimensions` and `modules` tables move to analytics without copying their rows.
   If both schemas contain the same new table, migration stops for reconciliation.
   The migration creates missing tables/columns and seeds only an empty module catalog.
3. Verify module mappings and dimension labels. Imported `Module_name` casing is supported.
   The old province/year uniqueness is replaced by indicator/year/full-dimension uniqueness.
   Newly created dimension storage is JSONB; pre-existing text imports should use a
   consistent canonical format. Application duplicate checks also catch reordered text keys.
4. Build with `python scripts/build_frontend.py`, deploy backend and frontend together,
   restart API workers, and run `python scripts/refresh_data_cache.py`.
5. Check module entry, Domain/Subject selection, automatic first Indicator selection,
   each dimension filter, chart toggle, Table, Metadata, and a single-slice Map.

The migration intentionally refuses automatic downgrade: new category rows cannot safely
be collapsed into the old province-only unique constraint. Use a reviewed restore plan.

## Verification

- `python -m unittest discover -s tests -p test_explorer_dimensions.py -v`
- `node --test tests/explorer_dimensions.test.cjs`
- `node --check js/explorer.js`
- `python scripts/build_frontend.py`

Browser visual verification was unavailable because the browser runtime could not start
through the Windows sandbox (directory ACL error). Database migration integration requires
a disposable PostgreSQL instance; no live database migration was attempted.

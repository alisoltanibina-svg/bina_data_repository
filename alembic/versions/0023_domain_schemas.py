"""Group existing tables without copying data or changing their names.

Requires an explicit maintenance cutover; never run against active services.
Frozen table manifest: do not import application models here.
"""
from alembic import context, op
import sqlalchemy as sa

revision = "0023_domain_schemas"
down_revision = "0022_trend_metadata"
branch_labels = None
depends_on = None

GROUPS = {
    "analytics": (
        "topics", "kdescription", "kindicator_score", "trend_score",
        "province_pop", "clusters", "provinces", "pyramid",
    ),
    "accounts": (
        "users", "registration_requests", "sessions", "otp_challenges",
        "captcha_challenges", "login_failures", "profile_revisions", "account_status_events",
    ),
    "support": (
        "support_tickets", "support_messages", "support_status_events", "support_attachments",
    ),
    "poi": (
        "poi_control", "poi_boundaries", "poi_categories", "poi_jobs", "poi_segments",
        "poi_places", "poi_place_categories", "poi_detail_tasks", "poi_requests",
        "poi_duplicate_reviews", "poi_source_datasets", "poi_settlements",
        "poi_coverage_plans", "poi_coverage_tiles", "poi_coverage_circles",
        "poi_coverage_contributions", "poi_preparations",
    ),
    "app": ("site_settings",),
}


def _prepare(forward):
    if context.is_offline_mode():
        raise RuntimeError("0023 requires online quiescence and identity checks; offline SQL is unsupported")
    if context.get_x_argument(as_dictionary=True).get("schema_cutover") != "yes":
        raise RuntimeError("Stop writers first, then use alembic -x schema_cutover=yes upgrade/downgrade")
    conn = op.get_bind()
    conn.execute(sa.text("SET LOCAL lock_timeout = '5s'"))
    conn.execute(sa.text("SET LOCAL statement_timeout = '60s'"))
    # The running collector owns LOCK_KEY; preparation/builders own LOCK_KEY+1.
    # Queue admission uses LOCK_KEY+2. Retain all three locks until commit.
    for key in (741923816, 741923817, 741923818):
        if not conn.scalar(sa.text("SELECT pg_try_advisory_xact_lock(:key)"), {"key": key}):
            raise RuntimeError("Collector or coverage preparation is still running; migration aborted")
    tables = [(schema if not forward else "public", table)
              for schema, names in GROUPS.items() for table in names]
    before = {}
    for schema, table in tables:
        row = conn.execute(sa.text("""
            SELECT c.oid, pg_get_userbyid(c.relowner) = current_user AS owned
            FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname=:schema AND c.relname=:table AND c.relkind='r'
        """), {"schema": schema, "table": table}).mappings().first()
        if not row or not row["owned"]:
            raise RuntimeError(f"Missing table or migration role is not its owner: {schema}.{table}")
        before[table] = row["oid"]
    # NOWAIT avoids silently waiting behind API, import, or operator transactions.
    conn.execute(sa.text("LOCK TABLE " + ", ".join(f'"{s}"."{t}"' for s, t in tables)
                         + ', public.alembic_version IN ACCESS EXCLUSIVE MODE NOWAIT'))
    schema = "public" if forward else "poi"
    c = conn.execute(sa.text(f"SELECT paused, in_flight FROM {schema}.poi_control WHERE id=1")).first()
    if c and (not c.paused or c.in_flight is not None):
        raise RuntimeError("Collection must be paused with no request in flight")
    if conn.scalar(sa.text(f"SELECT EXISTS(SELECT 1 FROM {schema}.poi_segments WHERE pending_details > 0 OR status='processing')")):
        raise RuntimeError("Unresolved Details or processing segments remain; do not discard the worker queue")
    if conn.scalar(sa.text(f"SELECT EXISTS(SELECT 1 FROM {schema}.poi_requests WHERE outcome='dispatched')")):
        raise RuntimeError("Unfinished dispatched request remains")
    if conn.scalar(sa.text(f"SELECT EXISTS(SELECT 1 FROM {schema}.poi_preparations WHERE state IN ('queued','running'))")):
        raise RuntimeError("Preparation must be finished or explicitly resolved before cutover")
    if not c and conn.scalar(sa.text(f"SELECT EXISTS(SELECT 1 FROM {schema}.poi_jobs)")):
        raise RuntimeError("Jobs exist without a collector control row")
    if forward:
        for schema in GROUPS:
            if conn.scalar(sa.text("SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=:s)"), {"s": schema}):
                raise RuntimeError(f"Destination schema already exists: {schema}; inspect it before proceeding")
    return conn, before


def _verify(conn, before, forward):
    for schema, names in GROUPS.items():
        target = schema if forward else "public"
        for table in names:
            oid = conn.scalar(sa.text("SELECT to_regclass(:name)::oid"), {"name": f"{target}.{table}"})
            if oid != before[table]:
                raise RuntimeError(f"Table identity changed: {target}.{table}")


def upgrade():
    conn, before = _prepare(True)
    for schema in GROUPS:
        conn.execute(sa.text(f'CREATE SCHEMA "{schema}" AUTHORIZATION CURRENT_USER'))
    for schema, names in GROUPS.items():
        for table in names:
            conn.execute(sa.text(f'ALTER TABLE "public"."{table}" SET SCHEMA "{schema}"'))
    _verify(conn, before, True)


def downgrade():
    conn, before = _prepare(False)
    for schema, names in reversed(tuple(GROUPS.items())):
        for table in reversed(names):
            conn.execute(sa.text(f'ALTER TABLE "{schema}"."{table}" SET SCHEMA "public"'))
    _verify(conn, before, False)
    for schema in reversed(tuple(GROUPS)):
        # RESTRICT deliberately aborts/rolls back if an unexpected object remains.
        conn.execute(sa.text(f'DROP SCHEMA "{schema}" RESTRICT'))

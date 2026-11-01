"""Operator helpers for the schema-only cutover. Never sends provider traffic.

snapshot / verify read catalogs and sequence state, never application records.
pause-at-boundary changes only collector pause state, under its control-row lock.
Can run before deployment: it does not import schema-bound ORM models.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import subprocess
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import OperationalError
from backend.db_schema import TABLE_SCHEMAS
from backend.settings import get_settings


def location(conn):
    old = conn.scalar(text("SELECT to_regclass('public.poi_control') IS NOT NULL"))
    new = conn.scalar(text("SELECT to_regclass('poi.poi_control') IS NOT NULL"))
    if old == new:
        raise RuntimeError("Ambiguous or missing collector tables")
    return "public" if old else "poi"


def snapshot(conn):
    """Catalog identities and sequence counters; no table rows or provider data."""
    layout = "public" if location(conn) == "public" else "grouped"
    tables = []
    for table, group in sorted(TABLE_SCHEMAS.items()):
        schema = "public" if layout == "public" else group
        row = conn.execute(text("""
            SELECT c.oid::bigint AS oid, c.relname AS name,
                   c.relowner::bigint AS owner, c.relacl::text AS acl, c.relkind AS kind
            FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname=:schema AND c.relname=:name AND c.relkind='r'
        """), dict(schema=schema, name=table)).mappings().one()
        tables.append(dict(row))
    ids = [r['oid'] for r in tables]
    queries = {
        "columns": """SELECT a.attrelid::bigint AS table_oid, a.attnum, a.attname,
            a.atttypid::bigint AS type_oid, a.atttypmod, a.attnotnull, a.attidentity,
            a.attgenerated, a.attisdropped, d.adbin::text AS default_expression
            FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
            WHERE a.attrelid=ANY(:ids) AND a.attnum>0 ORDER BY a.attrelid,a.attnum""",
        "constraints": """SELECT oid::bigint AS oid, conrelid::bigint AS table_oid,
            conname, contype, convalidated, condeferrable, condeferred,
            confrelid::bigint AS referenced_table_oid, conkey, confkey,
            confupdtype, confdeltype, confmatchtype, conbin::text AS expression
            FROM pg_constraint WHERE conrelid=ANY(:ids) ORDER BY oid""",
        "indexes": """SELECT c.oid::bigint AS oid,c.relname,c.relowner::bigint AS owner,
            c.relacl::text AS acl,i.indrelid::bigint AS table_oid,
            i.indisunique,i.indisprimary,i.indisvalid,i.indkey::text,
            i.indexprs::text,i.indpred::text
            FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
            WHERE i.indrelid=ANY(:ids) ORDER BY c.oid""",
        "sequences": """SELECT c.oid::bigint AS oid,c.relname,c.relowner::bigint AS owner,
            c.relacl::text AS acl,d.refobjid::bigint AS table_oid,d.refobjsubid,d.deptype,
            s.seqtypid::bigint AS type_oid,s.seqstart,s.seqincrement,s.seqmax,s.seqmin,s.seqcache,s.seqcycle
            FROM pg_class c JOIN pg_sequence s ON s.seqrelid=c.oid
            JOIN pg_depend d ON d.classid='pg_class'::regclass AND d.objid=c.oid
                AND d.refclassid='pg_class'::regclass AND d.deptype IN ('a','i')
            WHERE d.refobjid=ANY(:ids) ORDER BY c.oid""",
    }
    result = {"tables": tables}
    for key, sql in queries.items():
        result[key] = [dict(r) for r in conn.execute(text(sql), dict(ids=ids)).mappings()]
    misplaced = conn.scalar(text("""
        SELECT EXISTS(
            SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
            JOIN pg_class t ON t.oid=i.indrelid
            WHERE i.indrelid=ANY(:ids) AND c.relnamespace<>t.relnamespace
            UNION ALL
            SELECT 1 FROM pg_depend d JOIN pg_class c ON c.oid=d.objid
            JOIN pg_class t ON t.oid=d.refobjid
            WHERE d.classid='pg_class'::regclass AND d.refclassid='pg_class'::regclass
              AND d.refobjid=ANY(:ids) AND d.deptype IN ('a','i') AND c.relkind='S'
              AND c.relnamespace<>t.relnamespace
        )
    """), dict(ids=ids))
    if misplaced:
        raise RuntimeError('An index or owned sequence is outside its table schema')
    # Resolve names from trusted catalog identities, then quote identifiers.
    result['sequence_values'] = []
    for sequence in result['sequences']:
        qualified = conn.execute(text("SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=:oid"), dict(oid=sequence['oid'])).one()
        quote = conn.dialect.identifier_preparer.quote
        values = conn.execute(text(f"SELECT last_value,is_called FROM {quote(qualified[0])}.{quote(qualified[1])}")).one()
        result['sequence_values'].append(dict(oid=sequence['oid'], last_value=values[0], is_called=values[1]))
    return dict(layout=layout, objects=result)


def try_pause(conn):
    """Same control-row mutex used by Worker.tick and apply_reply; no queue race."""
    schema = location(conn)
    row = conn.execute(text(f"SELECT paused,in_flight FROM {schema}.poi_control WHERE id=1 FOR UPDATE NOWAIT")).first()
    if row is None:
        raise RuntimeError("No collector control row; inspect the worker before proceeding")
    if row.in_flight is not None:
        return False, "request_in_flight"
    pending = conn.scalar(text(f"SELECT EXISTS(SELECT 1 FROM {schema}.poi_segments WHERE pending_details>0 OR status='processing')"))
    if pending:
        return False, "paused_with_unresolved_batch" if row.paused else "details_batch_pending"
    if conn.scalar(text(f"SELECT EXISTS(SELECT 1 FROM {schema}.poi_requests WHERE outcome='dispatched')")):
        return False, "unfinished_dispatch"
    if conn.scalar(text(f"SELECT EXISTS(SELECT 1 FROM {schema}.poi_preparations WHERE state IN ('queued','running'))")):
        return False, "preparation_pending"
    conn.execute(text(f"UPDATE {schema}.poi_control SET paused=true, reason='Paused at a safe batch boundary for schema maintenance' WHERE id=1"))
    return True, "paused_at_safe_boundary"


def inspect_state(conn):
    schema = location(conn)
    version = conn.execute(text('SELECT version_num FROM public.alembic_version')).scalars().all()
    row = conn.execute(text(f'SELECT paused,in_flight IS NOT NULL AS request_in_flight FROM {schema}.poi_control WHERE id=1')).mappings().first()
    return dict(
        database=conn.scalar(text('SELECT current_database()')),
        database_role=conn.scalar(text('SELECT current_user')),
        postgres_version=conn.scalar(text("SELECT current_setting('server_version')")),
        can_create_schemas=conn.scalar(text("SELECT has_database_privilege(current_user,current_database(),'CREATE')")),
        layout='public' if schema=='public' else 'grouped',
        revisions=version,
        control=dict(row) if row else None,
        unresolved_segments=conn.scalar(text(f"SELECT count(*) FROM {schema}.poi_segments WHERE pending_details>0 OR status='processing'")),
        dispatched_requests=conn.scalar(text(f"SELECT count(*) FROM {schema}.poi_requests WHERE outcome='dispatched'")),
        unfinished_preparations=conn.scalar(text(f"SELECT count(*) FROM {schema}.poi_preparations WHERE state IN ('queued','running')")),
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--service', choices=('app-api.service', 'poi-worker.service'),
                        help='Inspect a running Linux service using its effective DATABASE_URL; requires /proc access')
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('inspect')
    for name in ('snapshot', 'verify'):
        p = sub.add_parser(name)
        p.add_argument('--file', type=Path, required=True)
    p = sub.add_parser('pause-at-boundary')
    p.add_argument('--timeout', type=int, default=600)
    args = parser.parse_args()
    operator_url = get_settings().database_url.get_secret_value()
    url = operator_url
    if args.service:
        if args.command != 'inspect':
            raise RuntimeError('--service is only supported for read-only inspection')
        pid = subprocess.check_output(['systemctl', 'show', '--value', '--property=MainPID', args.service], text=True).strip()
        if not pid.isdigit() or int(pid) <= 0:
            raise RuntimeError('Service has no running main process')
        # Keep secrets in memory only; never print the environment or URL.
        values = dict(item.split(b'=',1) for item in Path(f'/proc/{pid}/environ').read_bytes().split(b'\0') if b'=' in item)
        configured = [v.decode() for k,v in values.items() if k.lower()==b'database_url']
        if len(configured)>1:
            raise RuntimeError('Service has ambiguous DATABASE_URL variables')
        if configured:
            url = configured[0]
        else:
            # This deployment loads settings from /opt/app/.env if not inherited.
            from dotenv import dotenv_values
            candidates = [v for k,v in dotenv_values('/opt/app/.env').items() if k.lower()=='database_url']
            if len(candidates)!=1 or not candidates[0]:
                raise RuntimeError('Cannot resolve the service database configuration')
            url = candidates[0]
    engine = create_engine(url, connect_args={'connect_timeout': 10})
    try:
        if args.command == 'pause-at-boundary':
            deadline = time.monotonic() + args.timeout
            while True:
                try:
                    with engine.begin() as conn:
                        conn.execute(text("SET LOCAL statement_timeout='5s'"))
                        done, state = try_pause(conn)
                except OperationalError as error:
                    if getattr(error.orig, 'sqlstate', None) != '55P03':
                        raise
                    done, state = False, 'control_row_busy'
                print(state, flush=True)
                if done:
                    return
                if state in ('paused_with_unresolved_batch', 'unfinished_dispatch', 'preparation_pending'):
                    raise RuntimeError('Operator review required; no automatic resume/retry or queue deletion was performed')
                if time.monotonic() >= deadline:
                    raise RuntimeError('Timed out without reaching a safe boundary; do not stop the worker')
                time.sleep(2)
        else:
            with engine.connect() as conn, conn.begin():
                conn.execute(text('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'))
                conn.execute(text("SET LOCAL statement_timeout='30s'"))
                if args.command == 'inspect':
                    report=inspect_state(conn)
                    if args.service:
                        report.update(service=args.service,matches_operator_configuration=make_url(url)==make_url(operator_url))
                    print(json.dumps(report,indent=2))
                    return
                current = snapshot(conn)
                current['database'] = conn.scalar(text('SELECT current_database()'))
                current['captured_at'] = datetime.now(timezone.utc).isoformat()
            if args.command == 'snapshot':
                with args.file.open('x', encoding='utf-8') as handle:
                    json.dump(current, handle, indent=2)
                print('Saved catalog identities and sequence counters; no application records')
            else:
                previous = json.loads(args.file.read_text(encoding='utf-8'))
                if current['database'] != previous['database'] or current['objects'] != previous['objects']:
                    raise RuntimeError('Catalog/sequence comparison failed; keep maintenance enabled and investigate')
                print(f"PASS: objects and sequence counters preserved ({previous['layout']} -> {current['layout']})")
    finally:
        engine.dispose()


if __name__ == '__main__':
    try:
        main()
    except RuntimeError as error:
        # Our RuntimeError messages describe gates; they contain no record values.
        print(f'FAILED: {error}', file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        # Do not print DB exception strings, URLs, SQL parameters, or record values.
        print(f'FAILED ({type(error).__name__}); inspect locally with credentials kept private', file=sys.stderr)
        sys.exit(1)

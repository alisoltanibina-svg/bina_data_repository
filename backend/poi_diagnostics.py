"""Secret-free, read-only collector diagnosis. No Nearby/Details calls or state changes.

Run in the SAME shell/environment used to launch the worker:
    python -m backend.poi_diagnostics
    python -m backend.poi_diagnostics --egress-ip
The optional flag makes one unauthenticated HTTPS request to api.ipify.org to
observe a public IPv4 address. It is not proof of the source IP Neshan observes.
"""
import argparse
from datetime import datetime
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import sys
from urllib.request import Request,build_opener,getproxies
from dotenv import dotenv_values
from sqlalchemy import create_engine,text
from sqlalchemy.engine import make_url
from backend.settings import Settings,ENV_FILE


def fingerprint(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()[:12] if value else None


def configuration_report(settings, env_file=ENV_FILE, environ=None):
    environ=os.environ if environ is None else environ
    env_file=Path(env_file)
    values=dotenv_values(env_file) if env_file.is_file() else {}
    names=[name for name in environ if name.casefold()=='neshan_service_api_key']
    file_values=[v for k,v in values.items() if k.casefold()=='neshan_service_api_key']
    file_key=(file_values[-1] or '').strip() if file_values else None
    effective=settings.neshan_service_api_key.get_secret_value().strip()
    content=env_file.read_text(encoding='utf-8-sig') if env_file.is_file() else ''
    occurrences=len(re.findall(r'^\s*(?:export\s+)?NESHAN_SERVICE_API_KEY\s*=',content,re.I|re.M))
    report=dict(project_root=str(env_file.parent),python_executable=sys.executable,
        service_key_configured=bool(effective),
        effective_key_source='environment' if names else '.env' if file_values else 'default',
        effective_key_fingerprint=fingerprint(effective),env_file_key_fingerprint=fingerprint(file_key or ''),
        effective_key_matches_env_file=effective==file_key if file_key is not None else None,
        service_key_definitions_in_env_file=occurrences,
        environment_key_names=names,
        collection_authorized=settings.neshan_collection_authorized,
        service_key_equals_browser_map_key=bool(effective and effective==settings.neshan_map_api_key.get_secret_value().strip()),
        proxy_types=sorted(getproxies().keys()),
        provider_access_verified=False)
    findings=[]
    if not effective: findings.append('No effective NESHAN_SERVICE_API_KEY is configured.')
    if names and file_key is not None and effective!=file_key:
        findings.append('A process environment variable overrides the .env service key. Editing .env alone does not change that value.')
    if occurrences>1: findings.append('Multiple service-key assignments exist in .env; keep one reviewed assignment.')
    if report['service_key_equals_browser_map_key']:
        findings.append('The private service key equals the browser map key; confirm with Neshan that the worker has a server service key.')
    if not settings.neshan_collection_authorized: findings.append('NDA/internal-use collection authorization is not configured.')
    report['configuration_findings']=findings
    return report


def database_report(settings):
    engine=None
    try:
        url=make_url(settings.database_url.get_secret_value())
        if not url.drivername.startswith(('postgresql','postgres')):
            return dict(status='invalid_database_configuration')
        engine=create_engine(url,connect_args={'connect_timeout':5},pool_pre_ping=True)
        with engine.connect() as conn:
            conn.execute(text('SET TRANSACTION READ ONLY'))
            version=conn.execute(text('SELECT version_num FROM alembic_version')).scalars().all()
            tables=set(conn.execute(text("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename IN ('poi_requests','poi_control')")).scalars())
            if tables!={'poi_requests','poi_control'}:
                return dict(status='collector_tables_missing',migration_versions=version)
            # Select only operational metadata, never response bodies, hashes or places.
            rows=conn.execute(text('SELECT id,kind,http_status,outcome,started_at,finished_at FROM poi_requests ORDER BY id DESC LIMIT 10')).mappings().all()
            latest_484=conn.execute(text('SELECT id,kind,http_status,outcome,started_at FROM poi_requests WHERE http_status=484 ORDER BY id DESC LIMIT 1')).mappings().first()
            c=conn.execute(text('SELECT paused,in_flight,heartbeat_at,worker_id FROM poi_control WHERE id=1')).mappings().first()
            c=dict(c) if c else None
            worker_id=c.pop('worker_id',None) if c else None
            match=re.search(r':k([0-9a-f]{12})$',worker_id or '')
            if c: c['worker_key_fingerprint']=match.group(1) if match else None
            return dict(status='ok',migration_versions=version,control=c,
                recent_requests=[dict(r) for r in rows],latest_http_484=dict(latest_484) if latest_484 else None)
    except Exception as error:
        # SQLAlchemy exceptions and URLs may contain passwords; never print their text.
        return dict(status='unavailable',error_type=type(error).__name__,
            action='Check database connectivity/migrations locally; credentials and SQL exception text are suppressed.')
    finally:
        if engine: engine.dispose()


def egress_report():
    try:
        request=Request('https://api.ipify.org?format=json',headers={'Accept':'application/json'})
        with build_opener().open(request,timeout=10) as response:
            data=json.loads(response.read(4096))
        address=ipaddress.ip_address(data['ip'])
        if address.version!=4: raise ValueError('Expected IPv4')
        return dict(status='ok',observed_public_ipv4=str(address),observer='api.ipify.org',
            limitation='Confirm the source address and key scope on the rejected request with Neshan; destination-specific routing/proxies may differ.')
    except Exception as error:
        return dict(status='unavailable',error_type=type(error).__name__)


def collect_report(settings,env_file=ENV_FILE,check_egress=False):
    report=configuration_report(settings,env_file)
    report['database']=database_report(settings)
    worker=(report['database'].get('control') or {}).get('worker_key_fingerprint')
    report['worker_uses_current_key']=(worker==report['effective_key_fingerprint']) if worker else None
    report['provider_calls_made']=0
    if check_egress: report['egress']=egress_report()
    report['next_action']='Keep collection paused. Correct local key-source conflicts, then have Neshan verify the key scope for the failing service and its observed request source before retrying.'
    return report


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--egress-ip',action='store_true',help='Make one public-IP lookup; never calls Neshan')
    args=parser.parse_args()
    try:
        settings=Settings()
    except Exception as error:
        print(json.dumps(dict(status='settings_unavailable',error_type=type(error).__name__,
            action='Check required configuration locally. Secret values and exception details are suppressed.')))
        raise SystemExit(2)
    report=collect_report(settings,check_egress=args.egress_ip)
    print(json.dumps(report,ensure_ascii=False,indent=2,default=lambda value:value.isoformat() if isinstance(value,datetime) else str(value)))

if __name__=='__main__': main()

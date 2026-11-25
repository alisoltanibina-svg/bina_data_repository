"""Trace exact POI identities without changing places or persisting Nearby content.

Run in the API checkout:
  venv/bin/python -m scripts.diagnose_poi_identity PLACE_UUID --probe

Default: database/configuration checks only, no provider calls.
--probe: two paced Nearby requests by default (at most five with --samples). Only
fingerprints/comparisons are printed, never API keys or raw provider hashes.
--api-pid PID: use that API process's settings environment on Linux.
"""
import argparse
import base64
from dataclasses import dataclass
import hashlib
import json
import math
import os
from pathlib import Path
import re
import time
from uuid import UUID


def digest(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def conversions(value):
    """Common representation errors, for diagnosis only; never normalize IDs."""
    standard=value.translate(str.maketrans('-_','+/'))
    variants={'utf8':value.encode(),'json_quoted':json.dumps(value).encode(),
        'utf16_le':value.encode('utf-16le'),'utf16_be':value.encode('utf-16be')}
    for label,raw in [('urlsafe_base64',value),('standard_base64',standard)]:
        for count in range(4):variants[label+'_padding_'+str(count)]=(raw+'='*count).encode()
    for label,mark in [('space',' '),('lf','\n'),('crlf','\r\n'),('tab','\t'),('bom','\ufeff')]:
        variants['prefix_'+label]=(mark+value).encode();variants['suffix_'+label]=(value+mark).encode()
    variants['trimmed_utf8']=value.strip().encode()
    try:variants['decoded_base64_bytes']=base64.urlsafe_b64decode(value+'='*((-len(value))%4))
    except (ValueError,base64.binascii.Error):pass
    return {label:hashlib.sha256(raw).hexdigest() for label,raw in variants.items()}


@dataclass
class StoredPlace:
    id:str
    provider:str
    provider_id:str
    name:str
    latitude:float
    longitude:float
    category:str
    resolved_at:object=None


def summarize_reply(reply,stored,expected_live_id=None):
    from backend.poi_explore import nearby_display_points,within_search_radius
    from backend.poi_geo import normalize
    result=dict(http_status=reply.status)
    if reply.status!=200:return result
    body=reply.body
    points=body.get('layerPoints',{}).get('nearestPoints') if isinstance(body,dict) else None
    if not isinstance(points,list):return {**result,'error':'invalid_nearby_schema'}
    result['raw_hash_matches_stored_anywhere_in_response']=any(isinstance(item,dict) and item.get('poiHash')==stored.provider_id for item in points)
    comparisons=[]
    for item in points:
        if not isinstance(item,dict):continue
        from backend.poi_provider import coordinates
        try:lat,lon=coordinates(item.get('location'))
        except (ValueError,TypeError,OverflowError):continue
        if not within_search_radius(lat,lon,(stored.latitude,stored.longitude),2):continue
        raw=item.get('poiHash')
        if not isinstance(raw,str) or not raw:
            comparisons.append(dict(same_name=normalize(item.get('name'))==normalize(stored.name),has_raw_hash=False));continue
        identity=digest(raw)
        normalized,_=nearby_display_points({'layerPoints':{'nearestPoints':[item]}})
        conversions_to_stored=[label for label,value in conversions(raw).items() if value==digest(stored.provider_id)]
        comparisons.append(dict(same_name=normalize(item.get('name'))==normalize(stored.name),has_raw_hash=True,
            raw_hash_characters=len(raw),raw_hash_equals_stored=raw==stored.provider_id,raw_hash_sha256=identity,
            display_normalizer_sha256=normalized[0].get('id') if len(normalized)==1 else None,
            normalizer_agrees_with_direct_sha256=len(normalized)==1 and normalized[0].get('id')==identity,
            matches_previous_browser_id=identity==expected_live_id if expected_live_id else None,
            representation_changes_matching_stored=conversions_to_stored))
    result['items_at_stored_coordinates']=comparisons[:10]
    return result


def collect_structure_sample(reply,stored,target_tokens,other_groups):
    """Keep only transient token cohorts in memory; do not emit provider content."""
    from backend.poi_explore import within_search_radius
    from backend.poi_provider import coordinates
    from backend.poi_geo import normalize
    if reply.status!=200 or not isinstance(reply.body,dict):return
    points=reply.body.get('layerPoints',{}).get('nearestPoints')
    if not isinstance(points,list):return
    targets=[];others={}
    for item in points:
        if not isinstance(item,dict) or not isinstance(item.get('poiHash'),str) or not isinstance(item.get('name'),str):continue
        try:lat,lon=coordinates(item.get('location'))
        except (ValueError,TypeError,OverflowError):continue
        name=normalize(item['name'])
        close=within_search_radius(lat,lon,(stored.latitude,stored.longitude),2)
        if name==normalize(stored.name) and close:targets.append(item['poiHash'])
        else:
            # Geometry/name are comparison labels only, never saved or used for matching.
            label=(name,round(lat,7),round(lon,7));others.setdefault(label,[]).append(item['poiHash'])
    if len(targets)==1:target_tokens.append(targets[0])
    for label,tokens in others.items():
        if len(tokens)==1:other_groups.setdefault(label,[]).append(tokens[0])


def check_historical_collisions(place_id,regions):
    from sqlalchemy import select,text
    from backend import database
    from backend.poi_models import PoiPlace
    from scripts.poi_token_structure import decode_token
    for region in regions:region.update(stored_records_checked=0,stored_region_collisions=0,stored_records_unusable=0)
    with database.db_session() as session:
        session.execute(text('SET TRANSACTION READ ONLY'))
        rows=session.execute(select(PoiPlace.id,PoiPlace.provider_id).where(PoiPlace.provider=='neshan',PoiPlace.id!=place_id).execution_options(yield_per=1000))
        for identity,token in rows:
            try:decoded=decode_token(token)
            except ValueError:
                for region in regions:region['stored_records_unusable']+=1
                continue
            for region in regions:
                offset,length=region['offset'],region['length']
                if len(decoded)<offset+length:region['stored_records_unusable']+=1;continue
                region['stored_records_checked']+=1
                if hashlib.sha256(decoded[offset:offset+length]).hexdigest()==region['target_region_fingerprint']:region['stored_region_collisions']+=1


def use_process_settings(pid):
    from backend.settings import Settings,PROJECT_ROOT
    root=Path('/proc')/str(pid)
    if not root.is_dir():raise ValueError('api_process_unavailable')
    if (root/'cwd').resolve()!=PROJECT_ROOT.resolve():raise ValueError('api_process_uses_different_checkout')
    allowed={name.casefold() for name in Settings.model_fields}
    for entry in (root/'environ').read_bytes().split(b'\0'):
        key,separator,value=entry.partition(b'=')
        name=os.fsdecode(key)
        if separator and name.casefold() in allowed:os.environ[name]=os.fsdecode(value)


def database_snapshot(place_id):
    from sqlalchemy import select,text
    from backend import database
    from backend.poi_models import PoiPlace,PoiControl,PoiPlaceCategory
    from backend.poi_editorial import source_identity,source_identity_expression
    with database.db_session() as session:
        session.execute(text('SET TRANSACTION READ ONLY'))
        row=session.get(PoiPlace,place_id)
        if not row:raise ValueError('place_not_found_in_configured_database')
        category=(row.raw_details or {}).get('layer',{}).get('slug') or session.scalar(select(PoiPlaceCategory.category).where(PoiPlaceCategory.place_id==place_id).limit(1))
        stored=StoredPlace(str(row.id),row.provider,row.provider_id,row.name,row.latitude,row.longitude,category,row.resolved_at)
        python_identity=source_identity(row)
        sql_identity=session.scalar(select(source_identity_expression()).where(PoiPlace.id==place_id))
        control=session.get(PoiControl,1)
        worker=re.search(r':k([a-f0-9]{12})$',control.worker_id or '') if control else None
        return stored,dict(database=session.scalar(text('SELECT current_database()')),provider=row.provider,
            stored_raw_characters=len(row.provider_id),stored_raw_has_edge_whitespace=row.provider_id!=row.provider_id.strip(),
            stored_python_sha256=python_identity,stored_postgres_sha256=sql_identity,python_and_postgres_agree=python_identity==sql_identity,
            details_collected_at=row.resolved_at.isoformat() if row.resolved_at else None,
            last_recorded_collector_key_fingerprint=worker.group(1) if worker else None)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('place_id',type=UUID)
    parser.add_argument('--probe',action='store_true')
    parser.add_argument('--api-pid',type=int)
    parser.add_argument('--expected-live-id',type=str)
    parser.add_argument('--query',help='Repeat a browser request: latitude,longitude,radius_m')
    parser.add_argument('--samples',type=int,choices=range(2,6),default=2)
    parser.add_argument('--analyze-tokens',action='store_true',help='Compare Base64-decoded blocks in memory; never changes matching')
    args=parser.parse_args()
    try:
        if args.expected_live_id and not re.fullmatch('[a-f0-9]{64}',args.expected_live_id):raise ValueError('invalid_expected_live_id')
        if args.analyze_tokens and not args.probe:raise ValueError('token_analysis_requires_probe')
        if args.api_pid:use_process_settings(args.api_pid)
        from backend.settings import get_settings
        from backend.poi_provider import Neshan
        from backend.poi_explore import reserve_live_request,extend_provider_backoff
        settings=get_settings();stored,report=database_snapshot(args.place_id)
        key=settings.neshan_service_api_key.get_secret_value().strip()
        fingerprint=digest(key)[:12] if key else None
        report['current_service_key_fingerprint']=fingerprint
        previous=report['last_recorded_collector_key_fingerprint']
        report['last_recorded_collector_key_matches_current']=fingerprint==previous if previous else None
        report['stored_representation_changes_matching_browser_id']=[label for label,value in conversions(stored.provider_id).items() if value==args.expected_live_id] if args.expected_live_id else None
        report['provider_calls_made']=0
        if args.probe:
            if not settings.neshan_explore_authorized or not key:raise ValueError('live_explorer_not_configured')
            if stored.provider!='neshan' or not stored.category:raise ValueError('not_a_neshan_place_with_category')
            report['probes']=[]
            latitude,longitude,radius=stored.latitude,stored.longitude,100
            if args.query:
                values=args.query.split(',')
                if len(values)!=3:raise ValueError('invalid_query')
                latitude,longitude,raw_radius=map(float,values)
                if not all(math.isfinite(value) for value in (latitude,longitude,raw_radius)) or not 24<=latitude<=41 or not 43<=longitude<=64 or not 10<=raw_radius<=100000 or not raw_radius.is_integer():raise ValueError('invalid_query')
                radius=int(raw_radius)
            report['repeating_supplied_browser_query']=bool(args.query)
            target_tokens=[];other_groups={}
            for index in range(args.samples):
                if index:
                    interval=settings.neshan_explore_interval_seconds
                    if interval>5:report['second_probe']='deferred_for_configured_pacing';break
                    time.sleep(interval+.1)
                try:reserve_live_request()
                except Exception as error:
                    if getattr(error,'status_code',None)==429:
                        report['probe_deferred_retry_seconds']=(getattr(error,'headers',{}) or {}).get('Retry-After');break
                    raise
                report['provider_calls_made']+=1
                reply=Neshan(key).request('nearby',dict(location=f'{latitude},{longitude}',layer=stored.category,searchRadius=radius),timeout=5,max_bytes=1024*1024)
                report['probes'].append(summarize_reply(reply,stored,args.expected_live_id))
                if args.analyze_tokens:collect_structure_sample(reply,stored,target_tokens,other_groups)
                if reply.status in (429,481,482):extend_provider_backoff(max(60,reply.retry_after));break
                if reply.status!=200:break
            if len(report['probes'])>=2:
                def identities(probe):return sorted(item['raw_hash_sha256'] for item in probe.get('items_at_stored_coordinates',[]) if item.get('same_name') and item.get('has_raw_hash'))
                groups=list(map(identities,report['probes']))
                report['same_raw_identifiers_in_identical_requests']=all(group==groups[0] for group in groups) if all(groups) else None
            if args.analyze_tokens:
                from scripts.poi_token_structure import analyze_tokens
                analysis=analyze_tokens(target_tokens,stored.provider_id,list(other_groups.values()))
                if analysis['experimental_regions']:
                    check_historical_collisions(args.place_id,analysis['experimental_regions'])
                    for region in analysis['experimental_regions']:
                        region['historical_database_check_passed']=region['stored_records_checked']>0 and region['stored_region_collisions']==0 and region['stored_records_unusable']==0
                    if not any(region['historical_database_check_passed'] for region in analysis['experimental_regions']):analysis['conclusion']='candidate_regions_failed_historical_database_check'
                report['token_structure']=analysis
        print(json.dumps(report,indent=2,ensure_ascii=True))
    except Exception as error:
        # Exception strings/SQL parameters/HTTP URLs can contain sensitive values.
        print(json.dumps(dict(status='diagnostic_unavailable',error_type=type(error).__name__,
            reason=str(error) if type(error) is ValueError and re.fullmatch('[a-z_]+',str(error)) else 'details_suppressed')))
        raise SystemExit(2)


if __name__=='__main__':main()

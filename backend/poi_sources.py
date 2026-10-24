"""Versioned user-supplied administrative layers and settlement search anchors.

No Neshan requests, geocoding, inferred village centres or in-place file edits.
Polygon work is offline; the running collector loads only its current province.
"""
from collections import Counter,defaultdict
from dataclasses import dataclass
import hashlib
import json
import math
from pathlib import Path
from uuid import NAMESPACE_URL,uuid5
from shapely import from_wkb
from shapely.geometry import shape,mapping
from shapely.ops import unary_union
from shapely.strtree import STRtree
from backend.poi_geo import normalize

ROOT=Path(__file__).resolve().parent.parent
DEFAULT_FILES={'regions':ROOT/'data/area_to_search.geojson','provinces':ROOT/'data/area_to_search2.geojson',
    'districts':ROOT/'data/area_to_search3.geojson','settlements':ROOT/'data/area_to_search4.geojson'}
ALGORITHM='user-search-layers-v1'

@dataclass
class Catalogue:
    version:str
    manifest:dict
    boundaries:list
    settlements:list
    summary:dict


def _text(props,key):
    value=props.get(key)
    if not isinstance(value,str) or not value.strip():raise ValueError('Missing text field: '+key)
    return value.strip()


def _source_id(value):
    if isinstance(value,bool):return None
    try:
        f=float(value)
        return str(int(f)) if math.isfinite(f) and f>0 and f.is_integer() else None
    except (ValueError,TypeError,OverflowError):return None


def _features(path,role,manifest):
    path=Path(path)
    if path.stat().st_size>100*1024*1024:raise ValueError('Source file exceeds 100 MiB')
    raw=path.read_bytes();digest=hashlib.sha256(raw).hexdigest();data=json.loads(raw.decode('utf-8-sig'));del raw
    crs=((data.get('crs') or {}).get('properties') or {}).get('name')
    if data.get('type')!='FeatureCollection' or crs not in (None,'urn:ogc:def:crs:OGC:1.3:CRS84','urn:ogc:def:crs:EPSG::4326','EPSG:4326'):
        raise ValueError('Expected WGS84/CRS84 FeatureCollection: '+str(path))
    features=data.get('features')
    if not isinstance(features,list) or not features:raise ValueError('Empty source layer: '+role)
    manifest[role]={'file':path.name,'sha256':digest,'features':len(features),'crs':crs or 'implicit WGS84'}
    for index,feature in enumerate(features):
        props=feature.get('properties') or {};g=shape(feature['geometry'])
        accepted=('Point',) if role=='settlements' else ('Polygon','MultiPolygon')
        if g.geom_type not in accepted or g.is_empty or not g.is_valid:raise ValueError(f'{role} feature {index}: invalid geometry')
        w,s,e,n=g.bounds
        if not (43<=w<=e<=64 and 24<=s<=n<=41):raise ValueError(f'{role} feature {index}: coordinates outside expected WGS84 extent')
        yield index,props,g


def compile_catalogue(files=None,expected_provinces=None):
    files=files or DEFAULT_FILES;manifest={};boundaries=[];seen=set();province_names={};county_groups=defaultdict(list);rural_fallbacks=0
    def add(level,code,name,province,g,metadata):
        key=(level,code)
        if key in seen:raise ValueError('Duplicate administrative identity: '+str(key))
        seen.add(key)
        boundaries.append(dict(level=level,code=code,name=name,parent_name=province,
            geometry_wkb=g.wkb,source_metadata=metadata))
    for index,p,g in _features(files['provinces'],'provinces',manifest):
        name=_text(p,'Pname');key=normalize(name)
        if key in province_names:raise ValueError('Duplicate province name')
        province_names[key]=name
        source_id=_source_id(p.get('p_shenaseh')) or key
        add('province','province:'+source_id,name,None,g,dict(p))
    if expected_provinces is not None and set(province_names)!={normalize(n) for n in expected_provinces}:
        raise ValueError('Source provinces do not match the application province catalogue')
    def province(value):
        result=province_names.get(normalize(value))
        if not result:raise ValueError('Unknown administrative parent province: '+str(value))
        return result
    for index,p,g in _features(files['districts'],'districts',manifest):
        parent=province(_text(p,'pname'));name=_text(p,'Dname');county=_text(p,'cname')
        source_id=_source_id(p.get('d_shenaseh'))
        if not source_id:raise ValueError('District needs a nonzero administrative identifier')
        add('district','district:'+source_id,name,parent,g,dict(p))
        county_groups[(parent,normalize(county))].append((g.wkb,'district:'+source_id))
    # Counties are explicitly derived from all supplied districts, not address text.
    for (parent,name),members in sorted(county_groups.items()):
        g=unary_union([from_wkb(wkb) for wkb,_ in members])
        if g.is_empty or not g.is_valid:raise ValueError('District union did not produce a valid county geometry')
        add('county','county:'+hashlib.sha256((normalize(parent)+'|'+normalize(name)).encode()).hexdigest(),name,parent,g,{'derived_from':manifest['districts']['file'],
            'method':'union_of_supplied_districts','district_codes':[code for _,code in members]})
    for index,p,g in _features(files['regions'],'regions',manifest):
        parent=province(_text(p,'Pname'));name=_text(p,'Rname');_text(p,'Cname')
        source_id=_source_id(p.get('r_shenaseh'))
        if source_id:code='rural_area:'+source_id
        else:
            rural_fallbacks+=1
            digest=hashlib.sha256((normalize(parent)+'|'+normalize(p['Cname'])+'|'+normalize(name)).encode()+g.wkb).hexdigest()
            code='rural_area:'+digest
        add('rural_area',code,name,parent,g,dict(p))
    indices={}
    for level in ('province','county','district','rural_area'):
        rows=[r for r in boundaries if r['level']==level];geoms=[from_wkb(r['geometry_wkb']) for r in rows]
        indices[level]=(rows,geoms,STRtree(geoms))
    def hits(level,g,parent=None):
        rows,geoms,tree=indices[level]
        return [rows[int(i)] for i in tree.query(g) if geoms[int(i)].covers(g)
            and (parent is None or normalize(rows[int(i)]['parent_name'])==normalize(parent))]
    province_centres={r['name']:normalize(r['source_metadata'].get('p_center')) for r in boundaries if r['level']=='province'}
    settlements={};duplicates=0
    for index,p,g in _features(files['settlements'],'settlements',manifest):
        name=_text(p,'Name');declared=_text(p,'ostan');issues=[];ph=hits('province',g)
        actual=ph[0]['name'] if len(ph)==1 else None
        if not actual:issues.append('outside_province_polygons' if not ph else 'ambiguous_province')
        elif normalize(actual)!=normalize(declared):issues.append('province_label_mismatch')
        matches={level:hits(level,g,actual) if actual else [] for level in ('county','district','rural_area')}
        for level,rows in matches.items():
            if len(rows)!=1:issues.append('missing_'+level if not rows else 'ambiguous_'+level)
        identity=[normalize(declared),normalize(name),format(g.x,'.9f'),format(g.y,'.9f')]
        code=hashlib.sha256(json.dumps(identity,ensure_ascii=True,separators=(',',':')).encode()).hexdigest()
        if code in settlements:
            settlements[code]['source_metadata']['duplicate_feature_indexes'].append(index);duplicates+=1;continue
        settlements[code]=dict(code=code,name=name,declared_province=declared,province_name=actual,
            county_name=matches['county'][0]['name'] if len(matches['county'])==1 else None,
            district_code=matches['district'][0]['code'] if len(matches['district'])==1 else None,
            rural_area_code=matches['rural_area'][0]['code'] if len(matches['rural_area'])==1 else None,
            latitude=g.y,longitude=g.x,state='review' if issues else 'ready',review_reason=';'.join(issues) or None,
            priority=0 if actual and normalize(name)==province_centres.get(actual) else 1,
            source_metadata={'file':manifest['settlements']['file'],'feature_index':index,'properties':dict(p),'duplicate_feature_indexes':[]})
    version=hashlib.sha256(json.dumps({'algorithm':ALGORITHM,'layers':manifest},sort_keys=True,separators=(',',':')).encode()).hexdigest()
    points=list(settlements.values())
    for point in points:point['id']=uuid5(NAMESPACE_URL,'dashboard:search-source:'+version+':'+point['code'])
    summary=dict(algorithm=ALGORITHM,layer_counts={k:v['features'] for k,v in manifest.items()},
        boundary_counts=dict(Counter(r['level'] for r in boundaries)),settlements=len(points),
        ready=sum(r['state']=='ready' for r in points),review=sum(r['state']=='review' for r in points),
        capital_anchors=sum(r['state']=='ready' and r['priority']==0 for r in points),
        duplicate_point_observations_merged=duplicates,region_zero_ids_with_fallback=rural_fallbacks,
        review_points=[{k:r[k] for k in ('name','declared_province','province_name','review_reason','latitude','longitude')} for r in points if r['state']=='review'],
        scope='Search buffers around the supplied points; no claim of complete city, village or national land coverage',
        poi_requests_sent=0)
    return Catalogue(version,manifest,boundaries,points,summary)


def save_catalogue(session,catalogue):
    """Idempotent snapshot import. Does not attach jobs, resume workers or call APIs."""
    from sqlalchemy import select,func
    from sqlalchemy.dialects.postgresql import insert
    from backend.poi_models import PoiSourceDataset,PoiSettlement,PoiBoundary
    existing=session.get(PoiSourceDataset,catalogue.version)
    if existing:
        count=session.scalar(select(func.count()).select_from(PoiSettlement).where(PoiSettlement.version==catalogue.version))
        boundary_count=session.scalar(select(func.count()).select_from(PoiBoundary).where(PoiBoundary.version==catalogue.version))
        if count!=catalogue.summary['settlements'] or boundary_count!=len(catalogue.boundaries):raise ValueError('Existing catalogue is incomplete; refusing to silently reuse it')
        return False
    session.add(PoiSourceDataset(version=catalogue.version,manifest=catalogue.manifest,summary=catalogue.summary));session.flush()
    for offset in range(0,len(catalogue.boundaries),100):
        rows=[]
        for record in catalogue.boundaries[offset:offset+100]:
            row={k:v for k,v in record.items() if k!='geometry_wkb'}
            row.update(version=catalogue.version,geometry=mapping(from_wkb(record['geometry_wkb'])))
            rows.append(row)
        session.execute(insert(PoiBoundary),rows)
    for offset in range(0,len(catalogue.settlements),250):
        session.execute(insert(PoiSettlement),[dict(version=catalogue.version,**r) for r in catalogue.settlements[offset:offset+250]])
    return True

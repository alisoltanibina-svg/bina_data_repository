"""Compile the eight supplied layers, preserving raw-source provenance offline."""
from collections import Counter
import hashlib,json,math
from pathlib import Path
from uuid import uuid5,NAMESPACE_URL
from shapely.geometry import shape
from shapely.strtree import STRtree
from backend.poi_sources import Catalogue
from backend.poi_geo import normalize


def recover_text(value):
    if not isinstance(value,str):return value
    if any(ord(c)>255 for c in value):return value
    fixed=value.encode('latin-1').decode('cp1256')
    if fixed.encode('cp1256').decode('latin-1')!=value:raise ValueError('Encoding recovery is not reversible')
    return fixed


def compile_sources(directory):
    directory=Path(directory);manifest={};boundaries=[];observations={};recovered=0
    roles={3:('county','Cname','pname'),4:('district','Dname','pname'),5:('water','name',None),6:('province','Pname',None),7:('rural_area','Rname','Pname')}
    for number in range(1,9):
        path=directory/f'area_to_search{number}.geojson';raw=path.read_bytes();data=json.loads(raw.decode('utf-8-sig'))
        if data.get('type')!='FeatureCollection':raise ValueError('Expected FeatureCollection')
        crs=((data.get('crs') or {}).get('properties') or {}).get('name')
        if crs not in (None,'urn:ogc:def:crs:OGC:1.3:CRS84','EPSG:4326','urn:ogc:def:crs:EPSG::4326'):raise ValueError('Expected WGS84 coordinates')
        manifest[str(number)]=dict(file=path.name,sha256=hashlib.sha256(raw).hexdigest(),features=len(data['features']))
        for index,feature in enumerate(data['features']):
            props=feature.get('properties') or {};g=shape(feature['geometry'])
            if g.is_empty or not g.is_valid:raise ValueError(f'Invalid source geometry: {path.name} {index}')
            west,south,east,north=g.bounds
            if not (43<=west<=east<=64 and 24<=south<=north<=41):raise ValueError('Source coordinate outside Iran planning domain')
            metadata=dict(file=path.name,index=index,properties=props)
            if number in roles:
                level,name_key,parent_key=roles[number]
                if g.geom_type not in ('Polygon','MultiPolygon'):raise ValueError('Expected polygon')
                name=str(props.get(name_key) or '').strip();parent=props.get(parent_key) if parent_key else None
                if not name:raise ValueError('Missing boundary name')
                code=level+':'+hashlib.sha256((path.name+'|'+str(index)).encode()+g.wkb).hexdigest()
                boundaries.append(dict(level=level,code=code,name=name,parent_name=parent,geometry_wkb=g.wkb,source_metadata=metadata))
            else:
                if g.geom_type!='Point':raise ValueError('Expected settlement point')
                if number==8:
                    props={recover_text(k):recover_text(v) for k,v in props.items()};recovered+=1
                    metadata['recovered_properties']=props;metadata['encoding_recovery']='latin1-to-cp1256 reversible'
                value=props.get('Abadi_1395') if number==8 else props.get('Name')
                if not isinstance(value,str) or not value.strip():raise ValueError('Missing settlement name')
                name=value.strip()
                key=json.dumps([normalize(name),round(g.x,9),round(g.y,9)],ensure_ascii=True)
                if key not in observations:observations[key]=dict(name=name,latitude=g.y,longitude=g.x,observations=[])
                observations[key]['observations'].append(metadata)
    version=hashlib.sha256(json.dumps(dict(algorithm='full-polygon-and-point-sources-v1',files=manifest),sort_keys=True).encode()).hexdigest()
    province_rows=[b for b in boundaries if b['level']=='province'];county_rows=[b for b in boundaries if b['level']=='county']
    from shapely import from_wkb
    indices=[]
    for rows in (province_rows,county_rows):
        geoms=[from_wkb(r['geometry_wkb']) for r in rows];indices.append((rows,geoms,STRtree(geoms)))
    points=[];flags=Counter()
    from shapely.geometry import Point
    for key,p in sorted(observations.items()):
        location=Point(p['longitude'],p['latitude']);assignments=[]
        for rows,geoms,tree in indices:
            hits=[rows[int(i)] for i in tree.query(location) if geoms[int(i)].covers(location)]
            assignments.append(hits[0]['name'] if len(hits)==1 else None)
        province,county=assignments
        declared=next((o['properties'].get('ostan') for o in p['observations'] if o['properties'].get('ostan')),'')
        warnings=[]
        if declared and province and normalize(declared)!=normalize(province):warnings.append('province_label_mismatch')
        if not province:warnings.append('outside_or_ambiguous_province')
        if not county:warnings.append('outside_or_ambiguous_county')
        if '?' in p['name']:warnings.append('name_requires_review')
        for warning in warnings:flags[warning]+=1
        code=hashlib.sha256(key.encode()).hexdigest()
        points.append(dict(id=uuid5(NAMESPACE_URL,version+':'+code),code=code,name=p['name'],declared_province=declared,
            province_name=province,county_name=county,district_code=None,rural_area_code=None,
            latitude=p['latitude'],longitude=p['longitude'],state='ready',review_reason=None,priority=1,
            source_metadata=dict(observations=p['observations'],warnings=warnings,point_radius_m=3000)))
    summary=dict(algorithm='full-polygon-and-point-sources-v1',ready=len(points),review=0,settlements=len(points),
        layer_counts={k:v['features'] for k,v in manifest.items()},boundary_counts=dict(Counter(b['level'] for b in boundaries)),
        recovered_village_observations=recovered,merged_observations=sum(len(p['source_metadata']['observations'])-1 for p in points),
        point_warnings=dict(flags),review_points=[],point_radius_m=3000,scope='Full polygon union plus 3000 m point searches',poi_requests_sent=0)
    return Catalogue(version,manifest,boundaries,points,summary)

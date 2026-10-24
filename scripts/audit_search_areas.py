"""Offline audit of user-supplied search regions. No database or provider access."""
import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import statistics
import sys
from shapely.geometry import shape,Point
from shapely.strtree import STRtree
from backend.poi_geo import normalize

ROOT=Path(__file__).resolve().parent.parent


def positive_identifier(value):
    if isinstance(value,bool):return None
    try:
        number=float(value)
        return str(int(number)) if math.isfinite(number) and number>0 and number.is_integer() else None
    except (ValueError,TypeError,OverflowError):return None


def audit(path,province_path,radius_m=500,check_point=None):
    if not 500<=radius_m<=5000:raise ValueError('Radius must be 500–5000 metres')
    if path.stat().st_size>100*1024*1024:raise ValueError('Input exceeds the 100 MiB audit limit')
    raw=path.read_bytes();data=json.loads(raw.decode('utf-8-sig'))
    if data.get('type')!='FeatureCollection':raise ValueError('Expected a GeoJSON FeatureCollection')
    crs=((data.get('crs') or {}).get('properties') or {}).get('name')
    if crs not in (None,'urn:ogc:def:crs:OGC:1.3:CRS84','urn:ogc:def:crs:EPSG::4326','EPSG:4326'):
        raise ValueError('Unsupported CRS: explicitly reproject to WGS84 longitude/latitude first')
    features=data.get('features')
    if not isinstance(features,list) or not features:raise ValueError('No features')
    provinces=json.loads(province_path.read_text(encoding='utf-8-sig'))['features']
    names=[p['properties'].get('ProvincNam') or p['properties'].get('ADM1_FA') or p['properties'].get('name') for p in provinces]
    geometries=[shape(p['geometry']) for p in provinces];tree=STRtree(geometries)
    normalized_names={normalize(n):n for n in names}
    identifiers=[positive_identifier((f.get('properties') or {}).get('r_shenaseh')) for f in features]
    id_counts=Counter(v for v in identifiers if v)
    by_province=Counter();geometry_types=Counter();keys=Counter();areas=[];items=[];source_issues=[];outside=[];mismatches=[];point_matches=[]
    bounds=[math.inf,math.inf,-math.inf,-math.inf]
    for index,feature in enumerate(features):
        props=feature.get('properties') or {}
        if not all(isinstance(props.get(k),str) and props[k].strip() for k in ('Pname','Cname','Rname')):
            raise ValueError(f'Feature {index}: Pname, Cname and Rname must be nonempty strings')
        geometry=shape(feature['geometry'])
        if geometry.geom_type not in ('Polygon','MultiPolygon') or geometry.is_empty or not geometry.is_valid:
            raise ValueError(f'Feature {index}: expected a valid nonempty Polygon/MultiPolygon')
        west,south,east,north=geometry.bounds
        if not (43<=west<=east<=64 and 24<=south<=north<=41):
            raise ValueError(f'Feature {index}: coordinates outside the expected Iranian WGS84 extent')
        bounds=[min(bounds[0],west),min(bounds[1],south),max(bounds[2],east),max(bounds[3],north)]
        canonical=normalized_names.get(normalize(props['Pname']))
        if not canonical:raise ValueError(f'Feature {index}: province label does not match project provinces')
        # An internal geometry point is ONLY an administrative membership check,
        # never promoted to a town/village centre or sent to a search provider.
        point=geometry.representative_point()
        hits=[names[int(i)] for i in tree.query(point) if geometries[int(i)].covers(point)]
        if not hits:outside.append(index)
        elif canonical not in hits:mismatches.append(index)
        source_id=identifiers[index]
        if source_id and id_counts[source_id]==1:
            feature_key='district:'+source_id
        else:
            identity=dict(province=normalize(props['Pname']),county=normalize(props['Cname']),
                name=normalize(props['Rname']),geometry=feature['geometry'])
            feature_key='area:'+hashlib.sha256(json.dumps(identity,sort_keys=True,separators=(',',':'),ensure_ascii=True).encode()).hexdigest()
            source_issues.append(index)
        keys[feature_key]+=1;by_province[canonical]+=1;geometry_types[geometry.geom_type]+=1
        estimated=geometry.area*111320**2*math.cos(math.radians(geometry.centroid.y))/1e6
        areas.append(estimated)
        item=dict(index=index,feature_key=feature_key,province=canonical,county=props['Cname'],
            area_name=props['Rname'],centre_name=props.get('vcenter_na'),estimated_km2=round(estimated,2))
        items.append(item)
        if check_point and geometry.covers(Point(check_point[1],check_point[0])):point_matches.append(item)
    centre_fields=[k for f in features for k in (f.get('properties') or {}) if k.casefold() in
        ('latitude','longitude','lat','lng','lon','center_lat','center_lon','centre_lat','centre_lon')]
    cell_km2=(radius_m*1.2/1000)**2
    return dict(dataset_sha256=hashlib.sha256(raw).hexdigest(),feature_count=len(features),crs=crs or 'implicit WGS84',
        geometry_types=dict(geometry_types),bounds=bounds,provinces=by_province,
        unique_feature_keys=len(keys),duplicate_feature_keys=sum(n>1 for n in keys.values()),
        source_ids_requiring_fallback=len(source_issues),source_id_fallback_feature_indexes=source_issues,
        province_membership_mismatches=mismatches,geometry_points_outside_provinces=outside,
        has_explicit_centre_coordinate_fields=bool(centre_fields),
        estimated_geometry_area_km2=dict(minimum=round(min(areas),2),median=round(statistics.median(areas),2),
            maximum=round(max(areas),2),total=round(sum(areas),2)),
        area_based_search_estimate=dict(radius_m=radius_m,per_category=math.ceil(sum(areas)/cell_km2),
            exact_plan=False,explanation='Area divided by nominal grid-cell area; excludes boundary overhead and overlap between regions. No searches are generated or sent.'),
        largest_areas=sorted(items,key=lambda x:x['estimated_km2'],reverse=True)[:5],
        checked_point_matches=point_matches,
        interpretation='Administrative search regions with named centres; populated-place centres and built-up footprints are not established by these attributes.',
        generated_search_origins=0,provider_requests_sent=0,database_changed=False)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input',type=Path,default=ROOT/'data/area_to_search.geojson')
    parser.add_argument('--provinces',type=Path,default=ROOT/'data/iran.geojson')
    parser.add_argument('--radius',type=int,default=500)
    parser.add_argument('--check-point',nargs=2,type=float,metavar=('LATITUDE','LONGITUDE'))
    parser.add_argument('--output',type=Path)
    args=parser.parse_args()
    if args.output and args.output.resolve() in (args.input.resolve(),args.provinces.resolve()):
        parser.error('Audit output must not overwrite either input GeoJSON')
    report=audit(args.input,args.provinces,args.radius,args.check_point)
    result=json.dumps(report,ensure_ascii=False,indent=2)
    if args.output:
        args.output.write_text(result+'\n',encoding='utf-8')
        print('Wrote offline audit:',args.output)
    else:
        if hasattr(sys.stdout,'reconfigure'):sys.stdout.reconfigure(encoding='utf-8')
        print(result)

if __name__=='__main__':main()

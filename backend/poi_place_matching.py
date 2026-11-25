"""Match source places by category, <=20 m, province and exact normalized name."""
from dataclasses import dataclass
import math
from sqlalchemy import select,func,and_,or_,case,literal,literal_column
from sqlalchemy.orm import aliased
from backend.poi_models import PoiPlace,PoiPlaceCategory,PoiPlaceLink,PoiRetiredPlace
from backend.poi_editorial_models import PoiEditorial
from backend.poi_identity_rules import normalized,distance,RADIUS
from backend.poi_canonical import canonical_predicate
from backend.poi_sql import published_coordinate

SCHEME='category-distance-province-name-v1'
MAX_CANDIDATES=2000
LAT_STEP=RADIUS/110000
LON_STEP=LAT_STEP/math.cos(math.radians(41))

@dataclass(frozen=True)
class Variant:
    place_id:object
    name:str
    latitude:float
    longitude:float
    province:str|None
    published:bool

class TooManyCandidates(Exception):pass

def load_variants(session,category,points,published_only=False):
    """Use spatial indexes before loading canonical and published metadata.

    Keep original, archived and moved published locations in separate queries.
    Combining their coordinate predicates with OR forced national source scans.
    Nearby inputs and lookup results are never written or cached here.
    """
    if not points:return []
    if published_only:
        # Most discovery views have no local corrections to replace. Avoid
        # spatial work entirely until a canonical published profile exists.
        available=session.scalar(select(PoiEditorial.place_id).join(PoiPlace,PoiPlace.id==PoiEditorial.place_id).where(
            PoiEditorial.published_version>literal_column('0'),canonical_predicate(PoiEditorial.place_id)).limit(1))
        if available is None:return []
    rectangles=[];seen=set()
    for point in points:
        coords=(point.latitude,point.longitude)
        if coords in seen:continue
        seen.add(coords);dy=RADIUS/110000;dx=dy/math.cos(math.radians(abs(point.latitude)+dy))
        rectangles.append((point.latitude-dy,point.latitude+dy,point.longitude-dx,point.longitude+dx))
    def nearby(lat,lon):return or_(*(and_(lat.between(s,n),lon.between(w,e)) for s,n,w,e in rectangles))
    def source_match(table):
        if table is PoiRetiredPlace:return table.category==category
        raw=table.raw_details['layer']['slug'].as_string()
        mapped=select(PoiPlaceCategory.place_id).where(PoiPlaceCategory.place_id==table.id,PoiPlaceCategory.category==category).exists()
        return or_(raw==category,and_(or_(raw.is_(None),raw==''),mapped))
    def query_for(table,root_id,archived=False):
        root=aliased(PoiPlace,name='canonical_place')
        source_matches=source_match(table);published=PoiEditorial.published_version>literal_column('0')
        overrides=PoiEditorial.published['overrides'];pub_category=overrides['category'].as_string()
        published_matches=or_(pub_category==category,and_(pub_category.is_(None),source_matches))
        pub_lat=func.coalesce(overrides['latitude'].as_float(),root.latitude)
        pub_lon=func.coalesce(overrides['longitude'].as_float(),root.longitude)
        moved=or_(overrides['latitude'].as_float().is_not(None),overrides['longitude'].as_float().is_not(None))
        source_id=table.source_id if archived else table.id
        query=select(source_id.label('source_id'),root_id.label('id'),table.name,table.latitude,table.longitude,table.province_name,
            source_matches.label('source_matches'),published_matches.label('published_matches'),PoiEditorial.published_version,
            func.coalesce(overrides['name'].as_string(),root.name).label('published_name'),pub_lat.label('published_lat'),
            pub_lon.label('published_lon'),case((moved,PoiEditorial.province_name),else_=root.province_name).label('published_province')).select_from(table)
        if not archived:query=query.outerjoin(PoiPlaceLink,PoiPlaceLink.source_id==table.id)
        query=query.join(root,root.id==root_id).outerjoin(PoiEditorial,PoiEditorial.place_id==root.id)
        resolved=literal(True) if archived else table.resolved_at.is_not(None)
        query=query.where(or_(and_(table.provider=='neshan',resolved),and_(table.provider=='manual',published)),
            or_(root.provider!='manual',published))
        if published_only:query=query.where(published)
        return query,source_matches,published_matches,published,pub_lat,pub_lon
    variants={};loaded=set()
    def collect(query,key):
        rows=session.execute(query.limit(MAX_CANDIDATES+1)).all()
        if len(rows)>MAX_CANDIDATES:raise TooManyCandidates()
        for row in rows:
            source_key=(key,row.source_id)
            if source_key in loaded:continue
            loaded.add(source_key)
            active=bool(row.published_version)
            values=[]
            if row.source_matches:values.append(Variant(row.id,row.name,row.latitude,row.longitude,row.province_name,active))
            if active and row.published_matches:values.append(Variant(row.id,row.published_name,row.published_lat,row.published_lon,row.published_province,True))
            for variant in values:variants[variant]=variant
        if len(loaded)>MAX_CANDIDATES:raise TooManyCandidates()
    root_id=func.coalesce(PoiPlaceLink.canonical_id,PoiPlace.id)
    query,source_matches,pub_matches,published,pub_lat,pub_lon=query_for(PoiPlace,root_id)
    collect(query.where(nearby(PoiPlace.latitude,PoiPlace.longitude),or_(source_matches,and_(published,pub_matches,nearby(pub_lat,pub_lon)))),'live')
    query,source_matches,pub_matches,published,pub_lat,pub_lon=query_for(PoiRetiredPlace,PoiRetiredPlace.canonical_id,True)
    collect(query.where(nearby(PoiRetiredPlace.latitude,PoiRetiredPlace.longitude),or_(source_matches,and_(published,pub_matches,nearby(pub_lat,pub_lon)))),'retired')
    # Only a local coordinate override can put a published place outside the
    # original-location queries. Filter its changed axis using expression
    # indexes before resolving the other axis against the canonical source.
    lat=published_coordinate(PoiEditorial.published,'latitude');lon=published_coordinate(PoiEditorial.published,'longitude')
    axes=or_(*(or_(and_(lat.is_not(None),lat.between(s,n),or_(lon.is_(None),lon.between(w,e))),
        and_(lon.is_not(None),lat.is_(None),lon.between(w,e))) for s,n,w,e in rectangles))
    moved_ids=select(PoiEditorial.place_id).where(PoiEditorial.published_version>literal_column('0'),axes,
        canonical_predicate(PoiEditorial.place_id)).cte('nearby_local_corrections').prefix_with('MATERIALIZED')
    query,_,pub_matches,published,pub_lat,pub_lon=query_for(PoiPlace,root_id)
    collect(query.join(moved_ids,moved_ids.c.place_id==PoiPlace.id).where(published,pub_matches,nearby(pub_lat,pub_lon)),'live')
    return list(variants.values())

class SpatialIndex:
    def __init__(self,variants):
        self.cells={}
        for variant in variants:
            if variant.latitude is None or variant.longitude is None:continue
            cell=(math.floor(variant.latitude/LAT_STEP),math.floor(variant.longitude/LON_STEP))
            self.cells.setdefault(cell,[]).append(variant)

    def matches(self,point,province):
        """Category was checked by SQL; perform distance, province, then name."""
        found={};row=math.floor(point.latitude/LAT_STEP);col=math.floor(point.longitude/LON_STEP)
        province_name=normalized(province)
        for dy in (-1,0,1):
            for dx in (-1,0,1):
                for variant in self.cells.get((row+dy,col+dx),[]):
                    if distance(point.latitude,point.longitude,variant.latitude,variant.longitude)>RADIUS:continue
                    if not province_name or normalized(variant.province)!=province_name:continue
                    if not normalized(point.name) or normalized(variant.name)!=normalized(point.name):continue
                    found[variant.place_id]=variant
        return list(found.values())

def match_points(session,category,points,province_for_point,published_only=False):
    provinces={}
    for point in points:
        key=(point.latitude,point.longitude)
        if key not in provinces:provinces[key]=province_for_point(*key).get('province_name')
    valid=[point for point in points if normalized(provinces[(point.latitude,point.longitude)])]
    index=SpatialIndex(load_variants(session,category,valid,published_only))
    return [(point,index.matches(point,provinces[(point.latitude,point.longitude)])) for point in points]

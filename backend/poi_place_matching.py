"""Match source places by category, <=20 m, province and exact normalized name."""
from dataclasses import dataclass
import math
import unicodedata
from sqlalchemy import select,func,and_,or_,case
from backend.poi_models import PoiPlace,PoiPlaceCategory
from backend.poi_editorial_models import PoiEditorial

SCHEME='category-distance-province-name-v1'
RADIUS=20
MAX_CANDIDATES=2000
LAT_STEP=RADIUS/110000
LON_STEP=LAT_STEP/math.cos(math.radians(41))

def normalized(value):
    text=unicodedata.normalize('NFC',str(value or ''))
    text=text.translate(str.maketrans('يك۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩','یک01234567890123456789')).replace('\u200c',' ')
    return ' '.join(text.split()).casefold()

def distance(latitude,longitude,other_latitude,other_longitude):
    a,b,c,d=map(math.radians,(latitude,longitude,other_latitude,other_longitude))
    term=math.sin((c-a)/2)**2+math.cos(a)*math.cos(c)*math.sin((d-b)/2)**2
    return 6371000*2*math.asin(min(1,math.sqrt(term)))

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
    """One bounded metadata query per batch; Nearby inputs are never written."""
    if not points:return []
    source_category=PoiPlace.raw_details['layer']['slug'].as_string()
    categorized=select(PoiPlaceCategory.place_id).where(PoiPlaceCategory.place_id==PoiPlace.id,PoiPlaceCategory.category==category).exists()
    source_matches=or_(source_category==category,and_(source_category.is_(None),categorized))
    overrides=PoiEditorial.published['overrides']
    published_category=overrides['category'].as_string()
    published_matches=or_(published_category==category,and_(published_category.is_(None),source_matches))
    published_lat=func.coalesce(overrides['latitude'].as_float(),PoiPlace.latitude)
    published_lon=func.coalesce(overrides['longitude'].as_float(),PoiPlace.longitude)
    published_name=func.coalesce(overrides['name'].as_string(),PoiPlace.name)
    moved=or_(overrides['latitude'].as_float().is_not(None),overrides['longitude'].as_float().is_not(None))
    published_province=case((moved,PoiEditorial.province_name),else_=PoiPlace.province_name)
    rectangles=[];seen=set()
    for point in points:
        coords=(point.latitude,point.longitude)
        if coords in seen:continue
        seen.add(coords);dy=RADIUS/110000;dx=dy/math.cos(math.radians(abs(point.latitude)+dy))
        rectangles.append((point.latitude-dy,point.latitude+dy,point.longitude-dx,point.longitude+dx))
    def nearby(lat,lon):return or_(*(and_(lat.between(s,n),lon.between(w,e)) for s,n,w,e in rectangles))
    published=PoiEditorial.published_version>0
    allowed=or_(and_(PoiPlace.provider=='neshan',PoiPlace.resolved_at.is_not(None)),and_(PoiPlace.provider=='manual',published))
    query=select(PoiPlace.id,PoiPlace.name,PoiPlace.latitude,PoiPlace.longitude,PoiPlace.province_name,
        source_matches.label('source_matches'),published_matches.label('published_matches'),PoiEditorial.published_version,
        published_name.label('published_name'),published_lat.label('published_lat'),published_lon.label('published_lon'),published_province.label('published_province'))
    query=query.outerjoin(PoiEditorial,PoiEditorial.place_id==PoiPlace.id).where(allowed,
        or_(and_(source_matches,nearby(PoiPlace.latitude,PoiPlace.longitude)),and_(published,published_matches,nearby(published_lat,published_lon))))
    if published_only:query=query.where(published)
    rows=session.execute(query.order_by(PoiPlace.id).limit(MAX_CANDIDATES+1)).all()
    if len(rows)>MAX_CANDIDATES:raise TooManyCandidates()
    variants=[]
    for row in rows:
        active=bool(row.published_version)
        if row.source_matches:variants.append(Variant(row.id,row.name,row.latitude,row.longitude,row.province_name,active))
        if active and row.published_matches:variants.append(Variant(row.id,row.published_name,row.published_lat,row.published_lon,row.published_province,True))
    return variants

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
    index=SpatialIndex(load_variants(session,category,points,published_only))
    return [(point,index.matches(point,province_for_point(point.latitude,point.longitude).get('province_name'))) for point in points]

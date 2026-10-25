"""Metric, verified triangular-lattice coverage. Never performs provider/DB calls.

The guarantee concerns supplied polygon geometry at recorded precision, not the
completeness of a provider's ranked/truncated database. Fixed settlement queries
retain their requested 3000 m radius. A global Iran transverse-Mercator lattice
avoids UTM seam duplication. Tile boundaries never clip candidate search circles.
"""
from dataclasses import dataclass
from functools import lru_cache,cached_property
import hashlib
import math
from shapely import set_precision, union_all
from shapely.geometry import Point, box, mapping, shape
from shapely.strtree import STRtree

METRIC_CRS='+proj=tmerc +lat_0=0 +lon_0=54 +k=0.9996 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs'
PRECISION_M=0.001
ALGORITHM='iran-hex-union-v1'

@dataclass
class Circle:
    key:str
    x:float
    y:float
    radius_m:int
    fixed:bool=False

    @cached_property
    def _footprint(self):
        # Inscribed buffer + conservative TM minimum scale: guaranteed smaller
        # than the provider's geodesic-radius circle across the Iran domain.
        return set_precision(set_precision(Point(self.x,self.y).buffer(self.radius_m*.999,quad_segs=32),PRECISION_M),0)


    def footprint(self):return self._footprint


def project(geometries,source='EPSG:4326',destination=METRIC_CRS):
    import geopandas as gpd
    return list(gpd.GeoSeries(list(geometries),crs=source).to_crs(destination))


@lru_cache(maxsize=1)
def inverse_transformer():
    from pyproj import Transformer
    return Transformer.from_crs(METRIC_CRS,'EPSG:4326',always_xy=True)


def wgs84(x,y):
    lon,lat=inverse_transformer().transform(x,y)
    return lat,lon


def circle_key(x,y,radius,prefix='hex'):
    return prefix+':'+str(int(radius))+':'+format(x,'.6f')+':'+format(y,'.6f')


def lattice(target,radius):
    if radius<1:raise ValueError('radius must be positive')
    dx=.98*math.sqrt(3)*radius;dy=.98*1.5*radius
    west,south,east,north=target.bounds
    for row in range(math.floor((south-radius)/dy),math.ceil((north+radius)/dy)+1):
        y=row*dy;offset=(row%2)*dx/2
        for column in range(math.floor((west-radius-offset)/dx),math.ceil((east+radius-offset)/dx)+1):
            x=column*dx+offset
            c=Circle(f'hex:{radius}:{row}:{column}',x,y,int(radius))
            if c.footprint().intersects(target):yield c


def components(geometry):
    if geometry.is_empty:return []
    if geometry.geom_type=='Polygon':return [geometry]
    return [p for g in getattr(geometry,'geoms',[]) for p in components(g)]


def cover(target,radius,fixed=(),optimize=True,max_candidates=20000):
    """Union first, retain outside-centred circles, repair, prune, then prove.

    Returns circles, disjoint owned polygon pieces, and an explicit certificate.
    A fixed circle may have zero polygon ownership but remains a required point
    search. Large domains must be passed in deterministic bounded tiles.
    """
    target=set_precision(target,0)
    if target.is_empty:return [],[],dict(verified=True,target_area_m2=0,uncovered_area_m2=0,precision_m=PRECISION_M)
    if not target.is_valid or target.geom_type not in ('Polygon','MultiPolygon'):raise ValueError('Invalid polygon target')
    circles=list(fixed);seen={c.key for c in circles}
    seed_cover=union_all([c.footprint() for c in circles])
    remaining=set_precision(target.difference(seed_cover),PRECISION_M)
    for c in lattice(remaining,radius) if not remaining.is_empty else ():
        if c.key not in seen:circles.append(c);seen.add(c.key)
        if len(circles)>max_candidates:raise ValueError('Coverage tile too large; use smaller tiles')
    footprints=[c.footprint() for c in circles]
    patches=0
    while True:
        missing=target.difference(union_all(footprints))
        if missing.is_empty:break
        for part in components(missing):
            p=part.representative_point();c=Circle(circle_key(p.x,p.y,radius,'patch'),p.x,p.y,int(radius))
            if c.key in seen:raise ValueError('Coverage repair made no progress')
            circles.append(c);footprints.append(c.footprint());seen.add(c.key);patches+=1
        if patches>1000:raise ValueError('Unable to prove full polygon coverage')
    tree=STRtree(footprints);active=set(range(len(circles)));removed=0
    if optimize:
        for i in reversed(range(len(circles))):
            if circles[i].fixed:continue
            center=Point(circles[i].x,circles[i].y)
            if target.covers(center) and not any(int(j)!=i and int(j) in active and footprints[int(j)].covers(center) for j in tree.query(center)):
                continue  # Unique witness: removing this circle necessarily opens a gap.
            owned=target.intersection(footprints[i])
            neighbors=[footprints[int(j)] for j in tree.query(footprints[i]) if int(j)!=i and int(j) in active]
            if owned.difference(union_all(neighbors)).is_empty:
                active.remove(i);removed+=1
    keep=sorted(active);circles=[circles[i] for i in keep];footprints=[footprints[i] for i in keep]
    missing=target.difference(union_all(footprints))
    if not missing.is_empty:raise ValueError('Coverage verification failed after pruning')
    # Ownership is a disjoint partition, used for persisted area progress. It
    # does not restrict the actual Nearby circle or discard returned hashes.
    tree=STRtree(footprints);owned=[]
    for i,g in enumerate(footprints):
        earlier=[footprints[int(j)] for j in tree.query(g) if int(j)<i]
        owned.append(target.intersection(g).difference(union_all(earlier)))
    partition_missing=set_precision(target.difference(union_all(owned)),PRECISION_M)
    if not partition_missing.is_empty:raise ValueError(f'Coverage ownership has a gap: {partition_missing.area} m2')
    return circles,owned,dict(verified=True,algorithm=ALGORITHM,target_area_m2=target.area,
        uncovered_area_m2=missing.area,precision_m=PRECISION_M,circles=len(circles),repair_circles=patches,
        redundant_circles_removed=removed,owned_area_m2=sum(g.area for g in owned))


def tiles(target,size=25000):
    west,south,east,north=target.bounds
    for row in range(math.floor(south/size),math.floor(north/size)+1):
        for col in range(math.floor(west/size),math.floor(east/size)+1):
            clipped=set_precision(target.intersection(box(col*size,row*size,(col+1)*size,(row+1)*size)),PRECISION_M)
            if clipped.area>0:yield f'{row}:{col}',union_all(components(clipped))


def refinement_target(circle):
    # 1.05 bounds the maximum TM scale within the accepted Iran domain. Point
    # refinement therefore covers the entire original geodesic 3 km request,
    # including the small margin beyond its conservative certificate footprint.
    return Point(circle.x,circle.y).buffer(circle.radius_m*1.05,quad_segs=64)

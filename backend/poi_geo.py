"""Conservative coverage grids and spatial assignment using existing GeoJSON."""
import hashlib
import json
import math
import re
from types import SimpleNamespace
from shapely.geometry import Point, box, shape
from shapely.strtree import STRtree


def normalize(value):
    return ' '.join(str(value or '').translate(str.maketrans({'ي':'ی','ك':'ک','\u200c':' '})).split()).casefold()


def load_boundaries(province_path, county_path=None):
    rows = []
    for path, level in [(province_path, 'province'), (county_path, 'county')]:
        if path is None:
            continue
        data = json.loads(path.read_text(encoding='utf-8-sig'))
        if data.get('type') != 'FeatureCollection':
            raise ValueError('Boundaries must be a WGS84 GeoJSON FeatureCollection')
        for feature in data['features']:
            props, geom = feature['properties'], feature['geometry']
            name = props.get('name') or props.get('ProvincNam') or props.get('ADM1_FA')
            parent = props.get('province_name')
            polygon = shape(geom)
            if not name or (level == 'county' and not parent):
                raise ValueError('County features require name and province_name')
            if polygon.geom_type not in {'Polygon', 'MultiPolygon'} or polygon.is_empty or not polygon.is_valid:
                raise ValueError('Boundary must be a valid nonempty Polygon or MultiPolygon')
            x1, y1, x2, y2 = polygon.bounds
            if not (43 <= x1 <= x2 <= 64 and 24 <= y1 <= y2 <= 41):
                raise ValueError('Boundary coordinates must be WGS84 longitude,latitude in Iran')
            rows.append(dict(level=level, code=str(props.get('code') or name), name=name,
                             parent_name=parent, geometry=geom))
    provinces = [r for r in rows if r['level'] == 'province']
    if len(provinces) != 31 or len({normalize(r['name']) for r in provinces}) != 31:
        raise ValueError('Nationwide collection requires 31 distinct province boundaries')
    if len({(r['level'], r['code']) for r in rows}) != len(rows):
        raise ValueError('Duplicate administrative codes')
    if any(normalize(r['parent_name']) not in {normalize(p['name']) for p in provinces}
           for r in rows if r['level'] == 'county'):
        raise ValueError('Unknown county parent province')
    version = hashlib.sha256(json.dumps(rows, sort_keys=True, ensure_ascii=True).encode()).hexdigest()
    return version, rows


def grid(geometry, radius_m):
    """Every intersecting cell has a circumscribing search circle, including coastal slivers.

    A degree of latitude is <111700 m in Iran. Longitude scale is bounded by
    its southern latitude. Cell diagonal/2 <0.85r; overlapping circles cover
    every point of the source polygon. Cell centres may lie outside a border.
    """
    polygon = shape(geometry)
    west, south, east, north = polygon.bounds
    dy = radius_m * 1.2 / 111700
    dx = dy / math.cos(math.radians(south))
    for iy in range(math.ceil((north - south) / dy)):
        y = south + iy * dy
        for ix in range(math.ceil((east - west) / dx)):
            x = west + ix * dx
            if polygon.intersects(box(x, y, x + dx, y + dy)):
                yield y + dy / 2, x + dx / 2


class BoundaryIndex:
    def __init__(self, rows):
        self.rows = [SimpleNamespace(level=r.level,name=r.name,parent_name=r.parent_name) for r in rows]
        self.geometries = [shape(r.geometry) for r in rows]
        self.tree = STRtree(self.geometries)

    def assign(self, latitude, longitude):
        point = Point(longitude, latitude)
        hits = [self.rows[int(i)] for i in self.tree.query(point)
                if self.geometries[int(i)].covers(point)]
        provinces = [r for r in hits if r.level == 'province']
        counties = [r for r in hits if r.level == 'county']
        province = provinces[0].name if len(provinces) == 1 else None
        counties = [r for r in counties if normalize(r.parent_name) == normalize(province)]
        county = counties[0].name if len(counties) == 1 else None
        status = 'assigned' if province and county else 'province_only' if province else 'ambiguous' if provinces else 'outside'
        return dict(province_name=province, county_name=county, spatial_status=status)


def parse_address(details):
    """Text is a hint, never a substitute for spatial administrative assignment."""
    address = details.get('address') or ''
    if not isinstance(address, str):
        address = ''
    parts = [p.strip() for p in re.split('[،,]', address) if p.strip()]
    province = details.get('province') or details.get('state')
    county, city = details.get('county'), details.get('city')
    status = 'structured' if any(isinstance(x, str) and x for x in (province, county, city)) else 'unparsed'
    if not province and parts and (parts[0].startswith('استان ') or 'province' in parts[0].lower()):
        province = re.sub(r'^استان\s+|\s+province$', '', parts[0], flags=re.I).strip()
        # The second free-text token can be a city, county, road or district.
        # Only explicitly labelled county/city tokens are promoted.
        status = 'partial'
        if not city and len(parts) > 1 and not parts[1].startswith(('خیابان ', 'بلوار ', 'شهرستان ')):
            city = parts[1]
            status = 'heuristic' # An address token is not verified administrative geography.
    for part in parts:
        if not county and part.startswith('شهرستان '): county = part[8:].strip()
        if not city and part.startswith('شهر '): city = part[4:].strip()
    return dict(address=address, address_province=province if isinstance(province, str) else None,
                address_county=county if isinstance(county, str) else None,
                address_city=city if isinstance(city, str) else None, address_parse_status=status)

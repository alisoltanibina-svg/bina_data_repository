"""Authenticated POI exploration. Nearby output is streamed through memory only."""
from functools import lru_cache
import json
import math
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import Field, FiniteFloat
from sqlalchemy import select, func, text
from sqlalchemy.exc import OperationalError

from backend import database
from backend.input_security import InputBody
from backend.poi_geo import normalize
from backend.poi_models import PoiExploreCategory, PoiPlace, PoiPlaceCategory
from backend.poi_provider import LAYERS, Neshan, coordinates
from backend.poi_budget import ProviderBusy, reserve_live_slot, record_provider_backoff
from backend.settings import get_settings

LIVE_MIN_ZOOM = 8
LIVE_INTERVAL_SECONDS = 1
LIVE_MAX_POINTS = 500
# Regional searches begin at 100 km; closer views progressively narrow the circle.
LIVE_RADII = {8: 100000, 9: 50000, 10: 25000, 11: 12000, 12: 5000,
              13: 2000, 14: 1500, 15: 1000, 16: 700, 17: 500, 18: 500, 19: 500}
NO_STORE = {'Cache-Control': 'no-store, max-age=0', 'Pragma': 'no-cache',
            'Expires': '0', 'X-Accel-Buffering': 'no'}


class NearbyBody(InputBody):
    category: str = Field(min_length=1, max_length=100)
    latitude: FiniteFloat = Field(ge=24, le=41)
    longitude: FiniteFloat = Field(ge=43, le=64)
    zoom: int = Field(ge=LIVE_MIN_ZOOM, le=19, strict=True)
    radius_m: int | None = Field(default=None, ge=10, le=100000, strict=True)


class PublishBody(InputBody):
    is_published: bool


def response(payload, status=200, extra_headers=None):
    return JSONResponse(payload, status_code=status, headers={**NO_STORE, **(extra_headers or {})})


def category_dict(row):
    # Restrict image sources to Neshan; imported URLs never become arbitrary image requests.
    expected = f'https://static.neshanmap.ir/poi/64/{row.category}.png'
    icon = row.icon_url if isinstance(row.icon_url, str) and re.fullmatch(r'https://static\.neshanmap\.ir/poi/(?:32|64|128)/[A-Za-z0-9_-]+\.png', row.icon_url) else expected
    return dict(category=row.category, title=row.title, icon_url=icon,
                is_published=row.is_published, sort_order=row.sort_order)


def published_category(category):
    if category not in LAYERS:
        raise HTTPException(404, detail='نوع مکان یافت نشد.', headers=NO_STORE)
    with database.db_session() as session:
        row = session.get(PoiExploreCategory, category)
        if row is None or not row.is_published:
            raise HTTPException(404, detail='این نوع مکان منتشر نشده است.', headers=NO_STORE)
        return category_dict(row)


def require_display_authorization():
    if not get_settings().neshan_explore_authorized:
        raise HTTPException(503, detail='نمایش اطلاعات مکانی هنوز فعال نشده است.', headers=NO_STORE)


@lru_cache(maxsize=1)
def province_catalog(path, modified):
    from shapely.geometry import shape
    source = json.loads(Path(path).read_text(encoding='utf-8-sig'))
    result = []
    for feature in source['features']:
        properties = feature.get('properties') or {}
        name = properties.get('ProvincNam') or properties.get('ADM1_FA') or properties.get('Name')
        if not name or not feature.get('geometry'):
            continue
        point = shape(feature['geometry']).representative_point()
        result.append(dict(province=name, latitude=point.y, longitude=point.x))
    return result


def aggregate_provinces(provinces, rows):
    observed = {}
    for province, count in rows:
        key = normalize(province)
        observed[key] = observed.get(key, 0) + int(count)
    known = {normalize(p['province']) for p in provinces}
    markers = [{**province, 'count': observed.get(normalize(province['province'])) or None} for province in provinces]
    return dict(provinces=markers, unassigned_count=sum(count for key, count in observed.items() if key not in known),
                completeness_verified=False)


def stored_counts(category, provinces):
    with database.db_session() as session:
        rows = session.execute(select(PoiPlace.province_name, func.count()).join(
            PoiPlaceCategory, PoiPlaceCategory.place_id == PoiPlace.id).where(
                PoiPlaceCategory.category == category, PoiPlace.provider == 'neshan', PoiPlace.resolved_at.is_not(None)
            ).group_by(PoiPlace.province_name)).all()
    return aggregate_provinces(provinces, rows)


def live_interval_seconds():
    return get_settings().neshan_explore_interval_seconds


def reserve_live_request():
    """Short interactive pacing, separate from collector scheduling deadlines."""
    try:
        with database.db_session() as session:
            session.execute(text("SET LOCAL lock_timeout = '100ms'"))
            reserve_live_slot(session, live_interval_seconds())
    except ProviderBusy as exc:
        raise HTTPException(429, detail='در حال به‌روزرسانی مکان‌های نزدیک…',
            headers={**NO_STORE, 'Retry-After': str(exc.seconds)}) from None
    except OperationalError as exc:
        if getattr(exc.orig, 'sqlstate', None) != '55P03':
            raise
        raise HTTPException(429, detail='سرویس در حال پاسخ‌گویی است.',
            headers={**NO_STORE, 'Retry-After': '1'}) from None


def extend_provider_backoff(seconds):
    with database.db_session() as session:
        record_provider_backoff(session, seconds)


def within_search_radius(latitude, longitude, center, radius):
    lat1, lon1 = map(math.radians, center)
    lat2, lon2 = math.radians(latitude), math.radians(longitude)
    a = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 6371000 * 2 * math.asin(min(1, math.sqrt(a))) <= radius


def nearby_display_points(body, *, center=None, radius=None):
    """Strip hashes and all unused provider fields; validate before display."""
    if not isinstance(body, dict) or not isinstance(body.get('layerPoints'), dict):
        raise ValueError('Invalid Nearby response')
    items = body['layerPoints'].get('nearestPoints')
    if not isinstance(items, list):
        raise ValueError('Invalid Nearby response')
    places, seen = [], set()
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get('name'), str):
            continue
        try:
            latitude, longitude = coordinates(item.get('location'))
        except (ValueError, TypeError, OverflowError):
            continue
        if center is not None and not within_search_radius(latitude, longitude, center, radius):
            continue
        name = item['name'].strip()[:250]
        key = (latitude, longitude, name)
        if not name or key in seen:
            continue
        seen.add(key)
        places.append(dict(name=name, latitude=latitude, longitude=longitude))
        if len(places) == LIVE_MAX_POINTS:
            break
    return places, len(items)


def build_router(require_admin, require_user):
    router = APIRouter()

    @router.get('/api/admin/poi/explore-categories')
    def admin_categories(request: Request):
        require_admin(request)
        with database.db_session() as session:
            rows = session.scalars(select(PoiExploreCategory).order_by(PoiExploreCategory.sort_order, PoiExploreCategory.title)).all()
            return response(dict(categories=[category_dict(row) for row in rows]))

    @router.patch('/api/admin/poi/explore-categories/{category}')
    def publish_category(category: str, body: PublishBody, request: Request):
        require_admin(request)
        with database.db_session() as session:
            row = session.get(PoiExploreCategory, category)
            if row is None or category not in LAYERS:
                raise HTTPException(404, detail='نوع مکان یافت نشد.', headers=NO_STORE)
            row.is_published = body.is_published
            return response(category_dict(row))

    @router.get('/api/poi-explore/init')
    def init(request: Request):
        require_user(request)
        require_display_authorization()
        with database.db_session() as session:
            rows = session.scalars(select(PoiExploreCategory).where(PoiExploreCategory.is_published.is_(True))
                .order_by(PoiExploreCategory.sort_order, PoiExploreCategory.title)).all()
            categories = [category_dict(row) for row in rows if row.category in LAYERS]
        return response(dict(categories=categories, live=dict(min_zoom=LIVE_MIN_ZOOM,
            radius_by_zoom=LIVE_RADII, debounce_ms=200, interval_ms=round(live_interval_seconds() * 1000), max_points=LIVE_MAX_POINTS)))

    @router.get('/api/poi-explore/counts')
    def counts(request: Request, category: str):
        require_user(request)
        require_display_authorization()
        selected = published_category(category)
        path = Path(__file__).resolve().parents[1] / 'data' / 'iran.geojson'
        provinces = province_catalog(str(path), path.stat().st_mtime_ns)
        aggregate = database.get_cache().get(f'poi-explore-counts::{category}',
            lambda: stored_counts(category, provinces), ttl_seconds=60)
        return response(dict(category=selected, **aggregate))

    @router.post('/api/poi-explore/nearby')
    def nearby(body: NearbyBody, request: Request):
        require_user(request)
        require_display_authorization()
        selected = published_category(body.category)
        settings = get_settings()
        key = settings.neshan_service_api_key.get_secret_value().strip()
        if not key:
            raise HTTPException(503, detail='سرویس مکان‌های نزدیک تنظیم نشده است.', headers=NO_STORE)
        reserve_live_request()
        # The request, response filter, and displayed circle share this exact radius.
        radius = body.radius_m if body.radius_m is not None else LIVE_RADII[body.zoom]
        reply = Neshan(key).request('nearby', dict(location=f'{body.latitude},{body.longitude}',
            layer=body.category, searchRadius=radius), timeout=5, max_bytes=1024 * 1024)
        if reply.status in (429, 481, 482):
            delay = max(60, math.ceil(reply.retry_after))
            extend_provider_backoff(delay)
            raise HTTPException(429, detail='سهمیهٔ جستجو موقتاً در دسترس نیست.', headers={**NO_STORE, 'Retry-After': str(delay)})
        if reply.status != 200:
            raise HTTPException(503, detail='سرویس مکان‌های نزدیک در دسترس نیست.', headers=NO_STORE)
        try:
            places, source_count = nearby_display_points(reply.body,
                center=(body.latitude, body.longitude), radius=radius)
        except ValueError:
            raise HTTPException(502, detail='پاسخ سرویس مکان‌های نزدیک معتبر نبود.', headers=NO_STORE) from None
        # No database/cache/log call can receive reply.body, names, coordinates, or hashes.
        cap = settings.neshan_nearby_result_cap
        return response(dict(category=selected['category'], places=places, radius_m=radius,
            center=dict(latitude=body.latitude, longitude=body.longitude),
            possibly_truncated=source_count >= LIVE_MAX_POINTS or (cap > 0 and source_count >= cap)))

    return router

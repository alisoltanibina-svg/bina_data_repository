"""User-authored places only. Live Nearby results never enter this write path."""
from datetime import datetime, timezone
from functools import lru_cache
import json
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import Field, FiniteFloat, field_validator
from sqlalchemy import select, delete

from backend import database
from backend.input_security import InputBody
from backend.poi_geo import BoundaryIndex, normalize
from backend.poi_models import PoiPlace, PoiPlaceCategory
from backend.poi_explore import response, published_category


class PlaceBody(InputBody):
    name: str = Field(min_length=1, max_length=250)
    category: str = Field(min_length=1, max_length=100)
    latitude: FiniteFloat = Field(ge=24, le=41)
    longitude: FiniteFloat = Field(ge=43, le=64)
    version: int | None = Field(default=None, ge=1, strict=True)

    @field_validator('name')
    @classmethod
    def meaningful_name(cls, value):
        if not value.strip():
            raise ValueError('Name is required')
        return value.strip()


@lru_cache(maxsize=2)
def province_index(path, modified):
    features = json.loads(Path(path).read_text(encoding='utf-8-sig'))['features']
    return BoundaryIndex([SimpleNamespace(level='province', name=f['properties'].get('name') or
        f['properties'].get('ProvincNam') or f['properties'].get('ADM1_FA') or f['properties'].get('Name'),
        parent_name=None, geometry=f['geometry']) for f in features])


def assign_province(latitude, longitude):
    path = Path(__file__).resolve().parents[1] / 'data' / 'iran.geojson'
    return province_index(str(path), path.stat().st_mtime_ns).assign(latitude, longitude)


def place_dict(row, category):
    metadata = row.raw_details or {}
    return dict(id=str(row.id), name=row.name, category=category, latitude=row.latitude,
        longitude=row.longitude, province=row.province_name, version=metadata.get('version', 1), source='manual')


def build_router(require_admin, require_user):
    router = APIRouter()

    @router.get('/api/poi-explore/manual-places')
    def places(request: Request, category: str, south: float = Query(ge=24, le=41),
               north: float = Query(ge=24, le=41), west: float = Query(ge=43, le=64), east: float = Query(ge=43, le=64)):
        require_user(request)
        published_category(category)
        if south > north or west > east:
            raise HTTPException(422, detail='محدوده معتبر نیست.')
        with database.db_session() as session:
            rows = session.scalars(select(PoiPlace).join(PoiPlaceCategory, PoiPlaceCategory.place_id == PoiPlace.id)
                .where(PoiPlace.provider == 'manual', PoiPlaceCategory.category == category,
                    PoiPlace.latitude.between(south, north), PoiPlace.longitude.between(west, east))
                .order_by(PoiPlace.name, PoiPlace.id).limit(201)).all()
            return response(dict(places=[place_dict(row, category) for row in rows[:200]], has_more=len(rows) > 200))

    def save(body, actor, place_id=None):
        published_category(body.category)
        assignment = assign_province(body.latitude, body.longitude)
        if not assignment['province_name']:
            raise HTTPException(422, detail='نقطه را داخل مرز یکی از استان‌های ایران انتخاب کنید.')
        with database.db_session() as session:
            if place_id is None:
                row = PoiPlace(id=uuid4(), provider='manual', provider_id=str(uuid4()), raw_details={})
                session.add(row)
            else:
                row = session.scalar(select(PoiPlace).where(PoiPlace.id == place_id,
                    PoiPlace.provider == 'manual').with_for_update())
                if row is None:
                    raise HTTPException(404, detail='مکان ثبت‌شده یافت نشد.')
                if body.version != (row.raw_details or {}).get('version', 1):
                    raise HTTPException(409, detail='این مکان تغییر کرده است؛ فهرست را تازه کنید و دوباره ویرایش کنید.')
            metadata = dict(row.raw_details or {})
            metadata.setdefault('created_by', actor['id'])
            metadata['updated_by'] = actor['id']
            metadata['version'] = metadata.get('version', 1 if place_id is not None else 0) + 1
            row.raw_details = metadata
            row.name = body.name
            row.normalized_name = normalize(body.name)
            row.latitude, row.longitude = body.latitude, body.longitude
            row.province_name, row.county_name = assignment['province_name'], None
            row.spatial_status = assignment['spatial_status']
            row.resolved_at = datetime.now(timezone.utc)
            session.flush()
            session.execute(delete(PoiPlaceCategory).where(PoiPlaceCategory.place_id == row.id))
            session.add(PoiPlaceCategory(place_id=row.id, category=body.category))
            return place_dict(row, body.category)

    @router.post('/api/poi-explore/manual-places')
    def create(body: PlaceBody, request: Request):
        actor = require_admin(request)
        return response(save(body, actor), 201)

    @router.patch('/api/poi-explore/manual-places/{place_id}')
    def update(place_id: UUID, body: PlaceBody, request: Request):
        actor = require_admin(request)
        return response(save(body, actor, place_id))

    return router

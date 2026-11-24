"""Extensible venue field schemas and editing-owned administrative suggestions."""
from functools import lru_cache
import json
from pathlib import Path
from fastapi import HTTPException
from sqlalchemy import select
from backend.poi_geo import normalize
from backend.poi_editorial_models import PoiCategoryPolicy


def editable_categories(session):
    return set(session.scalars(select(PoiCategoryPolicy.category).where(PoiCategoryPolicy.editing_enabled.is_(True))).all())


def require_editable_category(session,category):
    if category not in editable_categories(session):
        raise HTTPException(409,detail='ثبت و ویرایش این نوع مکان فعال نیست؛ در حال حاضر فقط مسجد قابل ویرایش است.')


@lru_cache(maxsize=2)
def county_catalog(path,modified):
    features=json.loads(Path(path).read_text(encoding='utf-8-sig'))['features']
    result={}
    for feature in features:
        properties=feature.get('properties') or {}
        province=properties.get('ADM1_FA')
        county=properties.get('ADM2_FA')
        if province and county:
            county=county.removeprefix('شهرستان ').strip()
            result.setdefault(province,set()).add(county)
    return {province:sorted(names) for province,names in result.items()}


def administrative_areas():
    path=Path(__file__).resolve().parents[1]/'data'/'Shahrestan.geojson'
    return county_catalog(str(path),path.stat().st_mtime_ns) if path.is_file() else {}


def source_administration(row,province):
    same=normalize(row.province_name)==normalize(province)
    county=(row.county_name or row.address_county) if same else None
    return dict(province=province,county=county.removeprefix('شهرستان ').strip() if isinstance(county,str) else county,
        settlement_name=row.address_city if same else None)


def prepare_administration(attributes,province,validate_county=True):
    values=dict(attributes)
    declared=values.get('province')
    if declared and normalize(declared)!=normalize(province):
        raise HTTPException(422,detail='استان واردشده با موقعیت انتخاب‌شده روی نقشه یکسان نیست.')
    values['province']=province
    if not validate_county:return values
    county=values.get('county')
    if county is not None and not isinstance(county,str):raise HTTPException(422,detail='نام شهرستان باید متن باشد.')
    if county:
        county=county.removeprefix('شهرستان ').strip();values['county']=county
        possible={normalize(p) for p,names in administrative_areas().items() if any(normalize(n)==normalize(county) for n in names)}
        if possible and normalize(province) not in possible:
            raise HTTPException(422,detail='شهرستان انتخاب‌شده متعلق به استان موقعیت نیست.')
    return values


def attribute_overrides(values,defaults):
    # Missing/unknown attributes do not create empty contributions or false zeroes.
    return {key:value for key,value in values.items() if value!=defaults.get(key)}

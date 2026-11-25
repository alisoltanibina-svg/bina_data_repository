"""Fixed SQL expressions shared by POI queries and their PostgreSQL indexes."""
from sqlalchemy import func,literal_column,Float


def province_key(column):
    return func.lower(func.trim(func.regexp_replace(func.replace(func.translate(column,
        literal_column("'يك'"),literal_column("'یک'")),literal_column("'‌'"),literal_column("' '")),
        literal_column(r"'\s+'"),literal_column("' '"),literal_column("'g'"))))


def published_coordinate(document,key):
    if key not in ('latitude','longitude'):raise ValueError('Invalid coordinate key')
    return document.op('->')(literal_column("'overrides'")).op('->>')(literal_column("'"+key+"'")).cast(Float)

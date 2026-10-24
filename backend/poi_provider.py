"""Neshan adapter. No implicit HTTP retries: all attempts belong to the DB scheduler."""
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import json
import math
import socket
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener

# Nearby layer identifiers from the official service documentation, not display labels.
LAYERS = set('airline airport bank cafe cafe_restaurant campground car_dealer_official car_inspection charity cinema city_hall clinic college commercial_complex company courthouse embassy entertainment finance foreign_consulate formal_school garden gym health_complex helal_ahmar historical hospital hotel industrial_zone interests international_expo juice_shop library local_government_office lodging lodging_tourist marriage_registration_office mosque movie_theater natural_feature notary_public park bus_station metro_entrance parking pool post_office post_service restaurant school shopping_mall stadium studying_center temporary_accommodation theater traffic_police train_station transit_station university vegetable_market water_park wedding_venue'.split())

@dataclass
class Reply:
    status: int | None
    body: object = None
    retry_after: float = 0
    error: str = ''

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def retry_after(value, now=None):
    try:
        seconds = float(value)
        if math.isfinite(seconds): return min(31536000, max(0, seconds))
    except (ValueError, TypeError): pass
    try:
        return min(31536000, max(0, (parsedate_to_datetime(value) - (now or datetime.now(timezone.utc))).total_seconds()))
    except (ValueError, TypeError, OverflowError): return 0

class Neshan:
    def __init__(self, api_key):
        if not api_key: raise ValueError('NESHAN_SERVICE_API_KEY is required')
        self.api_key = api_key
        self.opener = build_opener(NoRedirect())

    def request(self, kind, params):
        path = 'nearby' if kind == 'nearby' else 'point'
        req = Request('https://api.neshan.org/v1/' + path + '?' + urlencode(params),
                      headers={'Api-Key': self.api_key, 'Accept': 'application/json'})
        try:
            try:
                response = self.opener.open(req, timeout=20)
            except HTTPError as error:
                response = error
            with response:
                raw = response.read(8 * 1024 * 1024 + 1)
                body = None
                if len(raw) <= 8 * 1024 * 1024:
                    try: body = json.loads(raw, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
                    except (ValueError, UnicodeError): pass
                return Reply(response.code, body, retry_after(response.headers.get('Retry-After')),
                             '' if body is not None else 'invalid_json_or_oversize')
        except (URLError, TimeoutError, socket.timeout, OSError):
            # Never return exception text: it can contain a credential-bearing URL.
            return Reply(None, error='transport_outcome_unknown')


def coordinates(location):
    if not isinstance(location, dict): raise ValueError('missing_location')
    lat, lon = location.get('latitude', location.get('y')), location.get('longitude', location.get('x'))
    if isinstance(lat, bool) or isinstance(lon, bool): raise ValueError('invalid_coordinates')
    lat, lon = float(lat), float(lon)
    if not math.isfinite(lat) or not math.isfinite(lon) or not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError('invalid_coordinates')
    return lat, lon


def nearby_items(body):
    if not isinstance(body, dict): raise ValueError('invalid_nearby_schema')
    points = body.get('layerPoints')
    if not isinstance(points, dict) or not isinstance(points.get('nearestPoints'), list):
        raise ValueError('invalid_nearby_schema')
    items = points['nearestPoints']
    for item in items:
        if not isinstance(item, dict): raise ValueError('invalid_nearby_item')
        coordinates(item.get('location'))
        if not isinstance(item.get('name'), str): raise ValueError('invalid_nearby_name')
        if item.get('poiHash') is not None and (not isinstance(item['poiHash'], str) or len(item['poiHash']) > 2048):
            raise ValueError('invalid_hash')
    return items


def details(body):
    if not isinstance(body, dict) or not isinstance(body.get('name'), str) or not body['name'].strip():
        raise ValueError('invalid_details_schema')
    lat, lon = coordinates(body.get('location'))
    return lat, lon

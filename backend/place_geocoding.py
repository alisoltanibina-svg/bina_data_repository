"""Interactive reverse geocoding. No persistence, collection jobs or HTTP retries."""
import json
import logging
import socket
from http.client import HTTPException as HTTPProtocolError
from urllib.error import HTTPError,URLError
from urllib.parse import urlencode
from urllib.request import Request,build_opener
from fastapi import HTTPException
from backend.input_security import safe_text
from backend.poi_provider import NoRedirect,retry_after
from backend.settings import get_settings

MAX_RESPONSE_BYTES=64*1024
TIMEOUT_SECONDS=5
log=logging.getLogger(__name__)
ACCESS_FAILURES={480:'key_not_found',483:'wrong_key_type',484:'key_scope_or_whitelist_denied',485:'reverse_service_not_enabled'}


def address(latitude,longitude):
    settings=get_settings()
    reverse_key=settings.neshan_reverse_api_key.get_secret_value().strip()
    key=reverse_key or settings.neshan_service_api_key.get_secret_value().strip()
    if not key:raise HTTPException(503,detail='سرویس دریافت نشانی تنظیم نشده است؛ نشانی را دستی وارد کنید.')
    request=Request('https://api.neshan.org/v5/reverse?'+urlencode(dict(lat=latitude,lng=longitude)),
        headers={'Api-Key':key,'Accept':'application/json'})
    try:
        try:result=build_opener(NoRedirect()).open(request,timeout=TIMEOUT_SECONDS)
        except HTTPError as error:result=error
        with result:
            if result.code in (429,482):
                seconds=max(1,min(60,int(retry_after(result.headers.get('Retry-After')) or 5)))
                raise HTTPException(429,detail='دریافت نشانی موقتاً محدود شده است؛ می‌توانید نشانی را دستی وارد کنید.',headers={'Retry-After':str(seconds)})
            if result.code in (480,483,484,485):
                # Only fixed labels/statuses: never log credentials, the request
                # URL/coordinates, or the provider response body.
                log.warning('Place reverse geocoding denied provider_status=%s reason=%s key_source=%s',
                    result.code,ACCESS_FAILURES[result.code],'NESHAN_REVERSE_API_KEY' if reverse_key else 'NESHAN_SERVICE_API_KEY')
                raise HTTPException(503,detail='دسترسی سرویس نشانی نشان فعال نیست؛ نشانی را دستی وارد کنید.')
            if result.code==481:raise HTTPException(503,detail='اعتبار سرویس نشانی تمام شده است؛ نشانی را دستی وارد کنید.')
            if result.code in (400,470):raise HTTPException(422,detail='نشانی این نقطه دریافت نشد؛ نشانی را دستی وارد کنید.')
            if result.code!=200:raise HTTPException(502,detail='سرویس نشانی پاسخ نداد؛ نشانی را دستی وارد کنید.')
            raw=result.read(MAX_RESPONSE_BYTES+1)
    except (URLError,TimeoutError,socket.timeout,OSError,HTTPProtocolError):
        raise HTTPException(503,detail='دریافت نشانی ممکن نشد؛ نشانی را دستی وارد کنید.') from None
    try:
        if len(raw)>MAX_RESPONSE_BYTES:raise ValueError('Response too large')
        body=json.loads(raw,parse_constant=lambda value:(_ for _ in ()).throw(ValueError(value)))
        value=body.get('formatted_address') if isinstance(body,dict) and body.get('status')=='OK' else None
        if not isinstance(value,str) or not value.strip() or len(value)>2000:raise ValueError('Missing address')
        return safe_text(value.strip(),multiline=True)
    except (ValueError,UnicodeError,RecursionError):
        raise HTTPException(502,detail='نشانی معتبری دریافت نشد؛ نشانی را دستی وارد کنید.') from None

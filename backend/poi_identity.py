"""Versioned, opt-in POI token prefix matching. Collector tokens stay unchanged."""
import base64
import hashlib
import re

SCHEME='neshan-prefix32-v1'
PATTERN=r'^[A-Za-z0-9_-]{86}(==)?$'

def enabled():
    from backend.settings import get_settings
    return get_settings().neshan_poi_prefix32_matching_enabled

def prefix32_key(token):
    if not isinstance(token,str) or not re.fullmatch(PATTERN,token):return None
    try:decoded=base64.b64decode(token.rstrip('=')+'==',altchars=b'-_',validate=True)
    except (ValueError,base64.binascii.Error):return None
    if len(decoded)!=64 or base64.urlsafe_b64encode(decoded).decode().rstrip('=')!=token.rstrip('='):return None
    return hashlib.sha256(decoded[:32]).hexdigest()

def prefix32_expression(column):
    """Same canonical decoding in PostgreSQL; invalid tokens yield NULL.

    This expression reads collector values, never adds a trigger/index to its table.
    """
    from sqlalchemy import func,case,String,and_
    stripped=func.rtrim(column,'=')
    decoded=func.decode(func.translate(stripped,'-_','+/',type_=String).concat('=='),'base64')
    canonical=func.rtrim(func.translate(func.replace(func.encode(decoded,'base64'),'\n',''),'+/','-_'),'=')
    valid=and_(func.octet_length(decoded)==64,canonical==stripped)
    key=func.encode(func.sha256(func.substr(decoded,1,32)),'hex')
    return case((column.regexp_match(PATTERN),case((valid,key),else_=None)),else_=None)

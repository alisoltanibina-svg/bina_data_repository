"""Provider-independent place identity rules; no database or editor dependencies."""
import math
import unicodedata

RADIUS=20
MAX_CANDIDATES=2000


def normalized(value):
    value=unicodedata.normalize('NFC',str(value or ''))
    value=value.translate(str.maketrans('يك۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩','یک01234567890123456789')).replace('\u200c',' ')
    return ' '.join(value.split()).casefold()


def distance(latitude,longitude,other_latitude,other_longitude):
    a,b,c,d=map(math.radians,(latitude,longitude,other_latitude,other_longitude))
    term=math.sin((c-a)/2)**2+math.cos(a)*math.cos(c)*math.sin((d-b)/2)**2
    return 6371000*2*math.asin(min(1,math.sqrt(term)))


def same_identity(first,second):
    """Exact normalized type/province/name and a true distance of at most 20 m."""
    return bool(first.category==second.category and normalized(first.province) and
        normalized(first.province)==normalized(second.province) and normalized(first.name) and
        normalized(first.name)==normalized(second.name) and
        distance(first.latitude,first.longitude,second.latitude,second.longitude)<=RADIUS)

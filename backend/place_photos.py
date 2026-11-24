"""Validated, cropped place photographs. Database records contain paths only."""
from datetime import datetime,timedelta,timezone
import io
import math
from pathlib import Path
import re
import warnings
from uuid import uuid4
from fastapi import HTTPException
from PIL import Image,ImageOps,UnidentifiedImageError
from sqlalchemy import select,func
from backend.settings import PROJECT_ROOT
from backend.poi_editorial_models import PoiPlacePhoto

PHOTO_DIR=PROJECT_ROOT/'assets'/'images'/'places'
MAX_BYTES=5*1024*1024
PREFIX='assets/images/places/'
NAME=re.compile(r'^[0-9a-f]{32}\.webp$')
FORMATS={'PNG':{'.png'},'JPEG':{'.jpg','.jpeg'},'WEBP':{'.webp'}}

def managed_file(path):
    if not isinstance(path,str) or not path.startswith(PREFIX) or not NAME.fullmatch(path[len(PREFIX):]):return None
    return PHOTO_DIR/path[len(PREFIX):]

def url(path):
    if not managed_file(path):return None
    return '/api/poi-explore/photos/'+path[len(PREFIX):-5]

def encode(data,filename,crop):
    if not data or len(data)>MAX_BYTES:raise HTTPException(413,detail='حجم عکس باید حداکثر ۵ مگابایت باشد.')
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error',Image.DecompressionBombWarning)
            image=Image.open(io.BytesIO(data),formats=list(FORMATS))
            if image.format not in FORMATS or Path(filename or '').suffix.lower() not in FORMATS[image.format]:
                raise HTTPException(415,detail='فقط عکس PNG، JPEG یا WebP معتبر پذیرفته می‌شود.')
            width,height=image.size
            if width*height>25_000_000 or max(width,height)>10000 or getattr(image,'n_frames',1)!=1:
                raise HTTPException(422,detail='ابعاد تصویر بیش از حد مجاز است یا تصویر متحرک است.')
            image.load();image=ImageOps.exif_transpose(image)
    except (UnidentifiedImageError,OSError,ValueError,SyntaxError,Image.DecompressionBombError,Image.DecompressionBombWarning):
        raise HTTPException(415,detail='فایل تصویر معتبر نیست؛ PNG، JPEG یا WebP انتخاب کنید.') from None
    try:x,y,w,h=(float(crop[key]) for key in ('x','y','width','height'))
    except (KeyError,TypeError,ValueError):raise HTTPException(422,detail='محدودهٔ برش معتبر نیست.') from None
    if not all(math.isfinite(v) for v in (x,y,w,h)) or min(x,y)<0 or min(w,h)<32 or abs(w/h-4/3)>.005 or x+w>image.width+.5 or y+h>image.height+.5:
        raise HTTPException(422,detail='محدودهٔ برش باید داخل تصویر و با نسبت ۴ به ۳ باشد.')
    image=image.crop((round(x),round(y),min(image.width,round(x+w)),min(image.height,round(y+h)))).convert('RGBA')
    width=min(1200,image.width)//4*4;height=width*3//4
    image=image.resize((width,height),Image.Resampling.LANCZOS)
    background=Image.new('RGB',image.size,'white');background.paste(image,mask=image.getchannel('A'))
    output=io.BytesIO();background.save(output,format='WEBP',quality=88,method=6)
    return output.getvalue()

def stage(session,actor,data,filename,crop):
    # Serialize this user's stage/delete/submit operations to enforce bounded storage.
    from backend.models import User
    session.scalar(select(User.id).where(User.id==actor['id']).with_for_update())
    now=datetime.now(timezone.utc)
    rows=session.scalars(select(PoiPlacePhoto).where(PoiPlacePhoto.uploader_id==actor['id'],PoiPlacePhoto.revision_id.is_(None))).all()
    for row in rows:
        created=row.created_at.replace(tzinfo=timezone.utc) if row.created_at.tzinfo is None else row.created_at
        if created<now-timedelta(days=1):
            file=managed_file(row.path)
            if file:file.unlink(missing_ok=True)
            session.delete(row)
    active=sum(1 for row in rows if (row.created_at.replace(tzinfo=timezone.utc) if row.created_at.tzinfo is None else row.created_at)>=now-timedelta(days=1))
    count=session.scalar(select(func.count()).select_from(PoiPlacePhoto).where(PoiPlacePhoto.uploader_id==actor['id'],PoiPlacePhoto.created_at>now-timedelta(days=1)))
    if active>=3 or count>=20:raise HTTPException(429,detail='تعداد بارگذاری‌ها بیش از حد مجاز است؛ عکس‌های استفاده‌نشده را حذف کنید.')
    encoded=encode(data,filename,crop);identity=uuid4();path=PREFIX+identity.hex+'.webp';PHOTO_DIR.mkdir(parents=True,exist_ok=True)
    file=managed_file(path)
    with file.open('xb') as output:output.write(encoded)
    row=PoiPlacePhoto(id=identity,path=path,uploader_id=actor['id']);session.add(row)
    try:session.flush()
    except Exception:file.unlink(missing_ok=True);raise
    return row

def claim(session,identity,actor,place_id):
    photo=session.scalar(select(PoiPlacePhoto).where(PoiPlacePhoto.id==identity).with_for_update())
    if not photo or not managed_file(photo.path) or not managed_file(photo.path).is_file():
        raise HTTPException(409,detail='عکس انتخاب‌شده در دسترس نیست؛ دوباره بارگذاری کنید.')
    if photo.revision_id:
        if photo.place_id!=place_id:raise HTTPException(403,detail='عکس متعلق به این مکان نیست.')
        return photo
    if photo.uploader_id!=actor['id']:raise HTTPException(403,detail='عکس متعلق به شما نیست.')
    created=photo.created_at.replace(tzinfo=timezone.utc) if photo.created_at.tzinfo is None else photo.created_at
    if created<datetime.now(timezone.utc)-timedelta(days=1):raise HTTPException(409,detail='مهلت عکس موقت تمام شده است؛ دوباره بارگذاری کنید.')
    return photo

def cleanup_staged():
    from backend import database
    with database.db_session() as session:
        rows=session.scalars(select(PoiPlacePhoto).where(PoiPlacePhoto.revision_id.is_(None),
            PoiPlacePhoto.created_at<datetime.now(timezone.utc)-timedelta(days=1)).with_for_update(skip_locked=True).limit(100)).all()
        for row in rows:
            file=managed_file(row.path)
            if file:file.unlink(missing_ok=True)
            session.delete(row)

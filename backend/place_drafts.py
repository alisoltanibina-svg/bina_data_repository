"""Account-owned wizard state; independent of POI collection and live search."""
from datetime import datetime,timezone
from uuid import UUID,uuid4
import math
from fastapi import HTTPException
from pydantic import Field,FiniteFloat,field_validator
from sqlalchemy import select
from backend.input_security import InputBody,safe_text
from backend.poi_editorial_models import PoiRegistrationDraft,PoiEditRevision,PoiPlacePhoto

ACTIVE=('draft','pending','rejected')


class DraftValues(InputBody):
    name:str=Field(default='',max_length=250)
    address:str=Field(default='',max_length=2000)
    phoneNumber:str=Field(default='',max_length=150)
    website:str=Field(default='',max_length=800)


class DraftData(InputBody):
    category:str|None=Field(default=None,max_length=100)
    province:str|None=Field(default=None,max_length=120)
    latitude:FiniteFloat|None=Field(default=None,ge=24,le=41)
    longitude:FiniteFloat|None=Field(default=None,ge=43,le=64)
    zoom:FiniteFloat=Field(default=16,ge=4,le=19)
    values:DraftValues=Field(default_factory=DraftValues)
    attributes:dict=Field(default_factory=dict,max_length=40)
    photo_id:UUID|None=None
    remove_photo:bool=False
    base_version:int=Field(default=0,ge=0,strict=True)
    source_version:str|None=Field(default=None,max_length=64)
    submission_id:UUID

    @field_validator('attributes')
    @classmethod
    def bounded_attributes(cls,values):
        for key,value in values.items():
            if not isinstance(key,str) or len(key)>60 or not key.replace('_','').isalnum():raise ValueError('Invalid attribute key')
            if value is not None and not isinstance(value,(str,int,float,bool)):raise ValueError('Invalid attribute value')
            if isinstance(value,float) and not math.isfinite(value):raise ValueError('Invalid attribute value')
            if isinstance(value,str):
                if len(value)>2000:raise ValueError('Attribute too long')
                safe_text(value)
        return values


class DraftSave(InputBody):
    version:int=Field(ge=0,strict=True)
    step:int=Field(ge=1,le=4,strict=True)
    data:DraftData


class DraftVersion(InputBody):
    version:int=Field(ge=0,strict=True)


def describe(row):
    updated=row.updated_at.replace(tzinfo=timezone.utc) if row.updated_at.tzinfo is None else row.updated_at
    return dict(id=str(row.id),place_id=str(row.place_id) if row.place_id else None,
        revision_id=str(row.revision_id) if row.revision_id else None,status=row.status,version=row.version,
        step=row.step,data=row.data,updated_at=updated.astimezone(timezone.utc).isoformat())


def owned(session,identity,actor,version=None):
    row=session.scalar(select(PoiRegistrationDraft).where(PoiRegistrationDraft.id==identity,
        PoiRegistrationDraft.user_id==actor['id']).with_for_update())
    if not row:raise HTTPException(404,detail='پیش‌نویس یافت نشد.')
    if version is not None and row.version!=version:raise HTTPException(409,detail='این پیش‌نویس در صفحهٔ دیگری تغییر کرده است؛ صفحه را دوباره باز کنید.')
    return row


def withdraw(session,row,note):
    if not row.revision_id:return
    revision=session.get(PoiEditRevision,row.revision_id)
    if revision and revision.status=='pending':
        revision.status='cancelled';revision.review_note=note;revision.reviewed_at=datetime.now(timezone.utc)


def save(session,row,body,actor):
    if row.status not in ACTIVE:raise HTTPException(409,detail='این درخواست بسته شده است؛ ثبت تازه‌ای آغاز کنید.')
    data=body.data.model_dump(mode='json')
    photo=session.get(PoiPlacePhoto,body.data.photo_id) if body.data.photo_id else None
    if body.data.photo_id and (not photo or photo.uploader_id!=actor['id']):
        # An existing published photograph is checked by the submission API;
        # drafts may retain it only when it was already bound to this request.
        if not photo or row.photo_id!=photo.id:raise HTTPException(403,detail='عکس متعلق به این پیش‌نویس نیست.')
    metadata={'zoom','submission_id','base_version','source_version'}
    previous={k:v for k,v in row.data.items() if k not in metadata}
    changed={k:v for k,v in data.items() if k not in metadata}!=previous
    if changed and row.status=='pending':
        withdraw(session,row,'پیشنهاد برای ویرایش مجدد توسط ثبت‌کننده از صف بررسی خارج شد.')
        row.status='draft'
    row.data=data;row.photo_id=body.data.photo_id;row.step=body.step;row.version+=1;row.updated_at=datetime.now(timezone.utc)
    return row


def attach(row,revision,source_version):
    row.place_id=revision.place_id;row.revision_id=revision.id;row.status='pending';row.step=4;row.version+=1
    row.updated_at=datetime.now(timezone.utc)
    row.data={**row.data,'base_version':revision.version,'source_version':source_version}


def reviewed(session,revision):
    for row in session.scalars(select(PoiRegistrationDraft).where(PoiRegistrationDraft.revision_id==revision.id).with_for_update()):
        row.status=revision.status;row.version+=1;row.updated_at=datetime.now(timezone.utc)
        if revision.status=='rejected':row.data={**row.data,'submission_id':str(uuid4())}

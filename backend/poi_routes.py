"""Admin controls and authenticated read APIs over locally stored POIs."""
from datetime import datetime
from typing import Literal
from uuid import UUID
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import Field
from sqlalchemy import select, func
from backend import database, poi
from backend.input_security import InputBody
from backend.poi_models import PoiPlace, PoiPlaceCategory, PoiRequest, PoiJob, PoiDuplicateReview
from backend.poi_provider import LAYERS

class JobBody(InputBody):
    categories: list[str] = Field(min_length=1,max_length=60)
    radius_m: int = Field(default=2000,ge=500,le=5000)
    mode: Literal['initial','refresh'] = 'initial'
    refresh_before: datetime | None = None


def build_router(require_admin, require_user):
    router = APIRouter()
    def response(data, code=200):
        from fastapi.encoders import jsonable_encoder
        return JSONResponse(jsonable_encoder(data),status_code=code,headers={'Cache-Control':'no-store'})

    @router.get('/api/admin/poi/status')
    def status(request: Request):
        require_admin(request)
        with database.db_session() as session: return response(poi.status(session))

    @router.get('/api/admin/poi/categories')
    def categories(request: Request):
        require_admin(request)
        return response(sorted(LAYERS))

    @router.post('/api/admin/poi/jobs')
    def create(body: JobBody, request: Request):
        require_admin(request)
        try:
            with database.db_session() as session:
                job = poi.create_job(session, body.categories, body.radius_m, body.mode, body.refresh_before)
                return response({'id':str(job.id),'paused':True},201)
        except ValueError as error: raise HTTPException(409,detail=str(error)) from error

    @router.post('/api/admin/poi/pause')
    def pause(request: Request):
        require_admin(request)
        with database.db_session() as session: return response(poi.set_paused(session,True))

    @router.post('/api/admin/poi/resume')
    def resume(request: Request):
        require_admin(request)
        try:
            with database.db_session() as session: return response(poi.resume_collection(session))
        except ValueError as error: raise HTTPException(409,detail=str(error)) from error

    @router.post('/api/admin/poi/jobs/{job_id}/retry-unresolved')
    def retry(job_id: UUID, request: Request):
        require_admin(request)
        try:
            with database.db_session() as session:
                poi.retry_unresolved(session,job_id)
                return response({'paused':True})
        except ValueError as error: raise HTTPException(409,detail=str(error)) from error

    @router.get('/api/admin/poi/requests')
    def history(request: Request, job_id: UUID | None = None, before: int | None = Query(None,ge=1)):
        require_admin(request)
        with database.db_session() as session:
            query=select(PoiRequest).order_by(PoiRequest.id.desc()).limit(100)
            if job_id: query=query.where(PoiRequest.job_id==job_id)
            if before: query=query.where(PoiRequest.id<before)
            rows=session.scalars(query).all()
            return response([dict(id=r.id,job_id=r.job_id,kind=r.kind,target_id=r.target_id,outcome=r.outcome,
                http_status=r.http_status,error=r.error,result_count=r.result_count,hash_count=r.hash_count,queued_count=r.queued_count,started_at=r.started_at,finished_at=r.finished_at) for r in rows])

    @router.get('/api/admin/poi/requests/{request_id}')
    def history_detail(request_id: int, request: Request):
        require_admin(request)
        with database.db_session() as session:
            row=session.get(PoiRequest,request_id)
            if not row: raise HTTPException(404,detail='Request not found')
            return response(dict(id=row.id,outcome=row.outcome,raw_response=row.raw_response if row.kind=='details' else None,error=row.error,
                result_count=row.result_count,hash_count=row.hash_count,queued_count=row.queued_count))

    @router.get('/api/admin/poi/duplicate-reviews')
    def duplicate_reviews(request: Request, offset: int=Query(0,ge=0)):
        require_admin(request)
        with database.db_session() as session:
            rows=session.scalars(select(PoiDuplicateReview).where(PoiDuplicateReview.status=='pending')
                .order_by(PoiDuplicateReview.place_id,PoiDuplicateReview.other_place_id).offset(offset).limit(100)).all()
            return response([dict(place_id=r.place_id,other_place_id=r.other_place_id,reason=r.reason) for r in rows])

    def filter_places(query,category,province,county):
        query=query.where(PoiPlace.resolved_at.is_not(None))
        if category: query=query.where(PoiPlace.id.in_(select(PoiPlaceCategory.place_id).where(PoiPlaceCategory.category==category)))
        if province: query=query.where(PoiPlace.province_name==province)
        if county: query=query.where(PoiPlace.county_name==county)
        return query

    @router.get('/api/pois')
    @router.get('/api/pois/counts')
    def map_data_disabled(request: Request):
        require_user(request)
        raise HTTPException(403,detail='مجوز نشان فقط استفادهٔ داخلی از اطلاعات POI را اجازه می‌دهد؛ نمایش روی نقشه مجاز نیست.')

    @router.get('/api/admin/poi/counts')
    def counts(request: Request,category: str=Query('',max_length=100),province: str=Query('',max_length=100),
               county: str=Query('',max_length=100)):
        require_admin(request)
        with database.db_session() as session:
            query=filter_places(select(PoiPlace.province_name,PoiPlace.county_name,func.count()),category,province,county)
            rows=session.execute(query.group_by(PoiPlace.province_name,PoiPlace.county_name)).all()
            return response(dict(completeness_verified=False,counts=[dict(province=p,county=c,count=n) for p,c,n in rows]))
    return router

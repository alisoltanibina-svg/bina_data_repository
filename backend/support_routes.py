"""Public ticket endpoints and administrator ticket management."""
from typing import Literal
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field
from backend.captcha import CaptchaError, CaptchaRateLimit, captcha_image, issue_challenge, verify_challenge
from backend.membership import MembershipError
from backend import support

HEADERS = {"Cache-Control": "no-store"}


class TicketCreate(BaseModel):
    reference: str = Field(default="", pattern=r"^(SUP-[A-F0-9]{12})?$")
    access_key: str = Field(default="", pattern=r"^([A-Za-z0-9_-]{32})?$")
    name: str = Field(default="", max_length=80)
    phone: str = Field(default="", max_length=16)
    category: Literal["login", "register", "reset", "otp", "account", "other"]
    subject: str = Field(min_length=3, max_length=160)
    message: str = Field(min_length=1, max_length=4000)
    stage: str = Field(default="", max_length=32)
    error_code: str = Field(default="", max_length=48)
    error_reference: str = Field(default="", max_length=32)
    captcha_id: str = Field(min_length=43, max_length=43)
    captcha_answer: str = Field(min_length=1, max_length=16)


class TicketAccess(BaseModel):
    reference: str = Field(min_length=16, max_length=20, pattern=r"^SUP-[A-Fa-f0-9]{12}$")
    access_key: str = Field(min_length=32, max_length=32, pattern=r"^[A-Za-z0-9_-]{32}$")


class TicketReply(TicketAccess):
    message: str = Field(min_length=2, max_length=4000)


class TicketUpdate(BaseModel):
    status: Literal["open", "in_progress", "awaiting_user", "closed"]
    message: str = Field(default="", max_length=4000)


def build_router(require_admin, raise_membership):
    router = APIRouter()

    @router.post("/api/support/captcha")
    def support_captcha(request: Request):
        try:
            result = issue_challenge("", "support", request.client.host if request.client else "")
        except CaptchaRateLimit as error:
            raise HTTPException(429, detail={"code": "rate-limit", "message": "\u0628\u0631\u0627\u06cc \u06a9\u062f \u0627\u0645\u0646\u06cc\u062a\u06cc \u062a\u0627\u0632\u0647 \u06a9\u0645\u06cc \u0635\u0628\u0631 \u06a9\u0646\u06cc\u062f.", "retry_after": error.retry_after}, headers={"Retry-After": str(error.retry_after)}) from error
        except CaptchaError as error:
            raise HTTPException(400, detail={"code": "captcha", "message": "\u062f\u0631\u06cc\u0627\u0641\u062a \u06a9\u062f \u0627\u0645\u0646\u06cc\u062a\u06cc \u0645\u0645\u06a9\u0646 \u0646\u0634\u062f. \u062f\u0648\u0628\u0627\u0631\u0647 \u062a\u0644\u0627\u0634 \u06a9\u0646\u06cc\u062f."}) from error
        return JSONResponse(result, headers=HEADERS)

    @router.get("/api/support/captcha/{challenge_id}/image")
    def support_captcha_image(challenge_id: str):
        image = captcha_image(challenge_id)
        if image is None:
            raise HTTPException(404, detail={"code": "captcha", "message": "\u06a9\u062f \u0627\u0645\u0646\u06cc\u062a\u06cc \u0645\u0646\u0642\u0636\u06cc \u0634\u062f\u0647 \u0627\u0633\u062a. \u06a9\u062f \u062a\u0627\u0632\u0647 \u0628\u06af\u06cc\u0631\u06cc\u062f."})
        return Response(image, media_type="image/png", headers=HEADERS)

    @router.post("/api/support/tickets")
    def create(body: TicketCreate):
        if bool(body.reference) != bool(body.access_key):
            raise HTTPException(400, detail={"code": "support-input", "message": "رسید تیکت معتبر نیست. صفحه را دوباره باز کنید."})
        if body.reference and body.access_key:
            try:
                return JSONResponse(support.read_ticket(body.reference, body.access_key), headers=HEADERS)
            except MembershipError as error:
                if error.code != "ticket-not-found":
                    raise_membership(error)
        if not verify_challenge(body.captcha_id, body.captcha_answer, "", "support"):
            raise HTTPException(400, detail={"code": "captcha", "message": "\u06a9\u062f \u0627\u0645\u0646\u06cc\u062a\u06cc \u0646\u0627\u062f\u0631\u0633\u062a \u06cc\u0627 \u0645\u0646\u0642\u0636\u06cc \u0627\u0633\u062a. \u06a9\u062f \u062a\u0627\u0632\u0647 \u0631\u0627 \u0648\u0627\u0631\u062f \u06a9\u0646\u06cc\u062f."})
        try:
            result = support.create_ticket(**body.model_dump(exclude={"captcha_id", "captcha_answer"}))
        except MembershipError as error:
            raise_membership(error)
        return JSONResponse(result, status_code=201, headers=HEADERS)

    @router.post("/api/support/tickets/lookup")
    def lookup(body: TicketAccess):
        try:
            result = support.read_ticket(body.reference, body.access_key)
        except MembershipError as error:
            raise_membership(error)
        return JSONResponse(result, headers=HEADERS)

    @router.post("/api/support/tickets/reply")
    def reply(body: TicketReply):
        try:
            result = support.reply_ticket(body.reference, body.access_key, body.message)
        except MembershipError as error:
            raise_membership(error)
        return JSONResponse(result, headers=HEADERS)

    @router.get("/api/admin/support/tickets")
    def inbox(request: Request, status: str = "", offset: int = Query(0, ge=0, le=1000000)):
        require_admin(request)
        try:
            result = support.list_tickets(status, offset)
        except MembershipError as error:
            raise_membership(error)
        return JSONResponse(result, headers=HEADERS)

    @router.get("/api/admin/support/tickets/{reference}")
    def detail(reference: str, request: Request):
        require_admin(request)
        try:
            result = support.admin_ticket(reference)
        except MembershipError as error:
            raise_membership(error)
        return JSONResponse(result, headers=HEADERS)

    @router.patch("/api/admin/support/tickets/{reference}")
    def update(reference: str, body: TicketUpdate, request: Request):
        actor = require_admin(request)
        try:
            result = support.update_ticket(reference, actor["id"], body.status, body.message)
        except MembershipError as error:
            raise_membership(error)
        return JSONResponse(result, headers=HEADERS)

    return router

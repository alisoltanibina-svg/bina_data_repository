"""Persistent maintenance mode, shared by all application workers."""

from pathlib import Path

from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy.dialects.postgresql import insert
from starlette.concurrency import run_in_threadpool
from starlette.middleware.base import BaseHTTPMiddleware

from backend.database import db_session
from backend.models import SiteSetting


def maintenance_enabled() -> bool:
    with db_session() as session:
        row = session.get(SiteSetting, "maintenance_enabled")
        return row is not None and row.value == "1"


def set_maintenance(enabled: bool) -> bool:
    with db_session() as session:
        # Atomic upsert also handles simultaneous first-time admin changes.
        statement = insert(SiteSetting).values(
            key="maintenance_enabled", value="1" if enabled else "0"
        )
        session.execute(statement.on_conflict_do_update(
            index_elements=[SiteSetting.key], set_={"value": statement.excluded.value}
        ))
    return enabled


class MaintenanceMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, static_root: Path):
        super().__init__(app)
        self.static_root = static_root

    async def dispatch(self, request, call_next):
        path = request.url.path
        # These are required to sign in and turn maintenance off. Their APIs
        # retain their own authentication, CAPTCHA, CSRF and rate limits.
        if (path.startswith(("/api/admin/", "/api/auth/", "/assets/", "/css/", "/js/"))
                or path in {"/api/maintenance/status", "/html/admin.html", "/html/admin", "/html/admin-login.html", "/html/admin-login"}):
            return await call_next(request)
        if await run_in_threadpool(maintenance_enabled):
            headers = {"Cache-Control": "no-store", "Retry-After": "300"}
            if path.startswith("/api/"):
                return JSONResponse(
                    {"detail": {"code": "maintenance", "message": "سایت در حال به روز رسانی است"}},
                    status_code=503, headers=headers,
                )
            return FileResponse(self.static_root / "html" / "maintenance.html",
                                status_code=503, headers=headers)
        return await call_next(request)

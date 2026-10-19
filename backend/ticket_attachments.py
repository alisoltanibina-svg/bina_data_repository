"""Private image-only ticket uploads. Originals are never persisted or served."""
from __future__ import annotations
import hashlib
import io
import logging
import os
from pathlib import Path
import re
import secrets
import struct
import threading
import warnings
from datetime import datetime, timedelta, timezone
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy import delete, func, select
from backend.database import db_session
from backend.input_security import safe_text
from backend.membership import MembershipError
from backend.models import SupportAttachment, SupportMessage, SupportTicket
from backend.settings import PROJECT_ROOT, get_settings

log = logging.getLogger(__name__)
MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_FILES = 3
MAX_PIXELS = 16_000_000
MAX_EDGE = 8192
DAILY_BYTES = 100 * 1024 * 1024
STORAGE_BYTES = 250 * 1024 * 1024
PENDING_BYTES = 20 * 1024 * 1024
TICKET_BYTES = 50 * 1024 * 1024
PENDING_TTL = timedelta(minutes=30)
ID_PATTERN = r"[0-9a-f]{32}"
FORMATS = {".jpg": "JPEG", ".jpeg": "JPEG", ".png": "PNG", ".webp": "WEBP"}
_decode_slots = threading.BoundedSemaphore(2)


def _failure(message, code="attachment-input", wait=0):
    return MembershipError(code, message, wait)


def storage_root():
    root = Path(get_settings().ticket_attachment_dir).expanduser().resolve()
    static_root = Path(os.environ.get("STATIC_ROOT", str(PROJECT_ROOT))).resolve()
    if root == Path(root.anchor) or any(root == public or root.is_relative_to(public) for public in {PROJECT_ROOT, static_root}):
        raise RuntimeError("TICKET_ATTACHMENT_DIR must be a private directory outside the project/static root")
    return root


def file_path(attachment_id):
    if not re.fullmatch(ID_PATTERN, attachment_id):
        raise _failure("پیوست پیدا نشد.", "attachment-not-found")
    root = storage_root()
    path = root / attachment_id[:2] / (attachment_id + ".webp")
    if not path.resolve().is_relative_to(root):
        raise RuntimeError("Attachment storage contains an unsafe symlink")
    return path


def validate_filename(name):
    if not isinstance(name, str) or not 1 <= len(name) <= 180:
        raise _failure("نام فایل معتبر نیست.")
    try:
        safe_text(name)
    except ValueError:
        raise _failure("نام فایل معتبر نیست.") from None
    if name.startswith(".") or name != name.strip() or any(char in name for char in '/\\:\x00'):
        raise _failure("نام فایل معتبر نیست.")
    if any(part.lower() in {".html", ".htm", ".svg", ".js", ".exe", ".php", ".sh", ".bat"} for part in Path(name).suffixes):
        raise _failure("نام و نوع فایل معتبر نیست.")
    suffix = Path(name).suffix.lower()
    if suffix not in FORMATS:
        raise _failure("فقط تصویر JPG، PNG یا WebP با حجم حداکثر ۵ مگابایت پذیرفته می‌شود.")
    return name, FORMATS[suffix]


def encode_image(data, expected_format):
    if not data or len(data) > MAX_FILE_BYTES:
        raise _failure("حجم تصویر باید بین یک بایت و ۵ مگابایت باشد.")
    if not _decode_slots.acquire(blocking=False):
        raise _failure("پردازش تصویر شلوغ است؛ کمی بعد دوباره تلاش کنید.", "attachment-limit", 5)
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data), formats=list(set(FORMATS.values()))) as probe:
                if probe.format != expected_format:
                    raise _failure("محتوای تصویر با نوع فایل مطابقت ندارد.")
                width, height = probe.size
                if width < 1 or height < 1 or max(width, height) > MAX_EDGE or width * height > MAX_PIXELS:
                    raise _failure("ابعاد تصویر بیش از حد مجاز است؛ تصویر کوچک‌تری انتخاب کنید.")
                if getattr(probe, "n_frames", 1) != 1:
                    raise _failure("تصویر متحرک پذیرفته نمی‌شود.")
                probe.verify()
            with Image.open(io.BytesIO(data)) as original:
                original.load()
                oriented = ImageOps.exif_transpose(original)
                mode = "RGBA" if "A" in oriented.getbands() or "transparency" in oriented.info else "RGB"
                pixels = oriented.convert(mode)
                pixels.thumbnail((4096, 4096), Image.Resampling.LANCZOS)
                # A new image drops EXIF, GPS, comments, ICC/XMP and appended file payloads.
                clean = Image.new(mode, pixels.size)
                clean.paste(pixels)
                output = io.BytesIO()
                clean.save(output, format="WEBP", quality=90, method=4, exif=b"", icc_profile=b"", xmp=b"")
                encoded = output.getvalue()
                width, height = clean.size
        if len(encoded) > MAX_FILE_BYTES:
            raise _failure("تصویر پس از پردازش بزرگ است؛ تصویر کوچک‌تری انتخاب کنید.")
        return encoded, width, height
    except (UnidentifiedImageError, OSError, ValueError, TypeError, SyntaxError, OverflowError, struct.error, Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise _failure("فایل تصویر معتبر نیست یا ابعاد آن بیش از حد مجاز است.") from None
    finally:
        _decode_slots.release()


def _uploader_lock(session, uploader_id):
    session.execute(select(func.pg_advisory_xact_lock(43991, int(uploader_id))))


def validate_target(actor, reference):
    if not reference: return None
    with db_session() as session:
        ticket = session.scalar(select(SupportTicket).where(SupportTicket.reference == reference))
        if ticket is None or (ticket.user_id != actor["id"] and not actor.get("is_admin")):
            raise _failure("تیکت پیدا نشد.", "attachment-not-found")
        if ticket.user_id is None:
            raise _failure("پیوست فقط برای تیکت حساب‌های کاربری فعال است.")
        if ticket.status == "closed":
            raise _failure("این تیکت بسته شده است و امکان افزودن پیوست ندارد.", "ticket-closed")
        return ticket.id


def descriptor(row):
    return {"id": row.id, "name": row.original_name, "size": row.size_bytes,
            "content_type": "image/webp", "width": row.width, "height": row.height}


def stage_upload(actor, name, data, reference=""):
    name, expected_format = validate_filename(name)
    ticket_id = validate_target(actor, reference)
    encoded, width, height = encode_image(data, expected_format)
    now = datetime.now(timezone.utc)
    attachment_id = secrets.token_hex(16)
    path = file_path(attachment_id)
    written = False
    try:
        with db_session() as session:
            # Match message operations: ticket -> uploader quota -> attachment rows.
            # Recheck after decoding to serialize uploads against an admin closing a ticket.
            if ticket_id is not None:
                ticket = session.scalar(select(SupportTicket).where(SupportTicket.id == ticket_id).with_for_update())
                if ticket is None or (ticket.user_id != actor["id"] and not actor.get("is_admin")):
                    raise _failure("تیکت پیدا نشد.", "attachment-not-found")
                if ticket.status == "closed":
                    raise _failure("این تیکت بسته شده است و امکان افزودن پیوست ندارد.", "ticket-closed")
            _uploader_lock(session, actor["id"])
            daily, count = session.execute(select(func.coalesce(func.sum(SupportAttachment.source_bytes), 0), func.count())
                .where(SupportAttachment.uploader_id == actor["id"], SupportAttachment.created_at > now-timedelta(days=1))).one()
            used = session.scalar(select(func.coalesce(func.sum(SupportAttachment.size_bytes), 0)).where(
                SupportAttachment.uploader_id == actor["id"], SupportAttachment.state == "ready"))
            pending = session.scalar(select(func.coalesce(func.sum(SupportAttachment.size_bytes), 0)).where(
                SupportAttachment.uploader_id == actor["id"], SupportAttachment.message_id.is_(None), SupportAttachment.state == "ready"))
            if daily + len(data) > DAILY_BYTES or count >= 60 or used + len(encoded) > STORAGE_BYTES or pending + len(encoded) > PENDING_BYTES:
                raise _failure("سهمیه بارگذاری پیوست پر شده است؛ فایل‌های در انتظار را حذف کنید یا بعداً تلاش کنید.", "attachment-limit", 60)
            row = SupportAttachment(id=attachment_id, uploader_id=actor["id"], ticket_id=ticket_id,
                original_name=name, size_bytes=len(encoded), source_bytes=len(data), width=width, height=height,
                sha256=hashlib.sha256(encoded).hexdigest(), state="ready", created_at=now, expires_at=now+PENDING_TTL)
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as output:
                written = True
                output.write(encoded)
            session.add(row)
            session.flush()
            result = descriptor(row)
        log.info("ticket_attachment_uploaded id=%s uploader=%s bytes=%s", attachment_id, actor["id"], len(encoded))
        return result
    except Exception:
        if written: path.unlink(missing_ok=True)
        raise


def _attachment_rows(session, attachment_ids, actor_id):
    if not attachment_ids: return []
    if len(attachment_ids) > MAX_FILES or len(set(attachment_ids)) != len(attachment_ids) or any(not re.fullmatch(ID_PATTERN, token) for token in attachment_ids):
        raise _failure("برای هر پیام حداکثر سه تصویر مجزا انتخاب کنید.")
    rows = session.scalars(select(SupportAttachment).where(SupportAttachment.id.in_(attachment_ids)).order_by(SupportAttachment.id).with_for_update()).all()
    if len(rows) != len(attachment_ids) or any(row.uploader_id != actor_id or row.state != "ready" for row in rows):
        raise _failure("پیوست معتبر نیست یا به این حساب تعلق ندارد.")
    return rows


def already_sent(session, ticket, attachment_ids, actor_id, body):
    rows = _attachment_rows(session, attachment_ids, actor_id)
    if not rows or not any(row.message_id is not None for row in rows): return False
    message_ids = {row.message_id for row in rows}
    if None not in message_ids and len(message_ids) == 1:
        message = session.get(SupportMessage, next(iter(message_ids)))
        if message and message.ticket_id == ticket.id and message.actor_id == actor_id and message.body == body.strip():
            return True
    raise _failure("این پیوست قبلاً استفاده شده است؛ پیوست تازه‌ای انتخاب کنید.")


def claim(session, ticket, message, attachment_ids, actor_id):
    if not attachment_ids: return
    if ticket.user_id is None or not actor_id:
        raise _failure("پیوست فقط برای تیکت حساب‌های کاربری فعال است.")
    _uploader_lock(session, actor_id)
    rows = _attachment_rows(session, attachment_ids, actor_id)
    now = datetime.now(timezone.utc)
    for row in rows:
        expiry = row.expires_at.replace(tzinfo=timezone.utc) if row.expires_at.tzinfo is None else row.expires_at
        if row.message_id is not None or expiry <= now or row.ticket_id not in {None, ticket.id}:
            raise _failure("پیوست منقضی شده یا به گفتگوی دیگری تعلق دارد؛ فایل را دوباره انتخاب کنید.")
    used = session.scalar(select(func.coalesce(func.sum(SupportAttachment.size_bytes), 0)).where(
        SupportAttachment.ticket_id == ticket.id, SupportAttachment.message_id.is_not(None), SupportAttachment.state == "ready"))
    if used + sum(row.size_bytes for row in rows) > TICKET_BYTES:
        raise _failure("سقف حجم پیوست‌های این تیکت ۵۰ مگابایت است.", "attachment-limit", 60)
    session.flush()
    for row in rows:
        row.ticket_id = ticket.id
        row.message_id = message.id


def attachment_download(attachment_id, actor):
    path = file_path(attachment_id)
    with db_session() as session:
        row = session.get(SupportAttachment, attachment_id)
        if row is None or row.state != "ready":
            raise _failure("پیوست پیدا نشد.", "attachment-not-found")
        if row.message_id is None:
            expiry = row.expires_at.replace(tzinfo=timezone.utc) if row.expires_at.tzinfo is None else row.expires_at
            allowed = row.uploader_id == actor["id"] and expiry > datetime.now(timezone.utc)
        else:
            ticket = session.get(SupportTicket, row.ticket_id)
            allowed = ticket is not None and ticket.user_id is not None and (ticket.user_id == actor["id"] or actor.get("is_admin"))
        if not allowed or not path.is_file():
            raise _failure("پیوست پیدا نشد.", "attachment-not-found")
        return path, "attachment-" + row.id[:8] + ".webp"


def discard_upload(attachment_id, actor_id):
    path = file_path(attachment_id)
    with db_session() as session:
        row = session.scalar(select(SupportAttachment).where(SupportAttachment.id == attachment_id).with_for_update())
        if row is None or row.uploader_id != actor_id or row.message_id is not None:
            raise _failure("پیوست پیدا نشد.", "attachment-not-found")
        row.state = "deleted"
    path.unlink(missing_ok=True)


def cleanup_attachments(now=None):
    now = now or datetime.now(timezone.utc)
    stale = []
    with db_session() as session:
        rows = session.scalars(select(SupportAttachment).where(SupportAttachment.message_id.is_(None),
            SupportAttachment.expires_at <= now, SupportAttachment.state == "ready").with_for_update(skip_locked=True)).all()
        for row in rows:
            row.state = "deleted"
            stale.append(row.id)
        # Keep deleted rows for a full rolling day so deleting uploads cannot reset a quota.
        session.execute(delete(SupportAttachment).where(SupportAttachment.message_id.is_(None),
            SupportAttachment.state == "deleted", SupportAttachment.created_at < now-timedelta(days=1)))
    for token in stale:
        file_path(token).unlink(missing_ok=True)
    root = storage_root()
    if not root.exists(): return
    # Reclaim orphaned files after ticket/account deletion or an interrupted DB commit.
    batch = []
    def sweep(paths):
        with db_session() as session:
            live = set(session.scalars(select(SupportAttachment.id).where(SupportAttachment.id.in_([path.stem for path in paths]), SupportAttachment.state == "ready")))
        for path in paths:
            if path.stem not in live: file_path(path.stem).unlink(missing_ok=True)
    for path in root.glob("*/*.webp"):
        if re.fullmatch(ID_PATTERN, path.stem) and path.stat().st_mtime < now.timestamp()-3600:
            batch.append(path)
            if len(batch) >= 500: sweep(batch); batch = []
    if batch: sweep(batch)

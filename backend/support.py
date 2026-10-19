"""Guest ticket tracking and private, authenticated account ticket histories."""
from __future__ import annotations
import base64
import json
import re
import secrets
from datetime import datetime, timezone
from sqlalchemy import func, select, tuple_
from backend.database import db_session
from backend.membership import MembershipError, is_mobile_phone, normalize_phone
from sqlalchemy.exc import IntegrityError
from backend.models import SupportMessage, SupportStatusEvent, SupportTicket, SupportAttachment
from backend import ticket_attachments as attachments
from backend.input_security import safe_text

CATEGORIES = frozenset({"login", "register", "reset", "otp", "account", "atlas", "explorer", "profile", "other"})
STATUSES = frozenset({"open", "in_progress", "awaiting_user", "closed"})
MAX_MESSAGES = 200
REFERENCE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
REFERENCE_PATTERN = r"SUP-[A-Z2-7]{16}"


def _clean(value, maximum, minimum=0):
    value = (value or "").strip()
    try:
        safe_text(value, multiline=True)
    except ValueError:
        raise MembershipError("support-input", "متن شامل نویسه نامعتبر است.") from None
    if len(value) < minimum or len(value) > maximum or any(ord(char) < 32 and char not in "\n\t\r" for char in value):
        raise MembershipError("support-input", "\u0627\u0637\u0644\u0627\u0639\u0627\u062a \u062a\u06cc\u06a9\u062a \u0631\u0627 \u0628\u0631\u0631\u0633\u06cc \u06a9\u0646\u06cc\u062f. \u0639\u0646\u0648\u0627\u0646 \u0648 \u0634\u0631\u062d \u0645\u0634\u06a9\u0644 \u0631\u0627 \u06a9\u0627\u0645\u0644 \u0628\u0646\u0648\u06cc\u0633\u06cc\u062f.")
    return value


def _iso(value):
    if value is None:
        return None
    return value.replace(tzinfo=timezone.utc).isoformat() if value.tzinfo is None else value.isoformat()


def _summary(ticket, admin=False):
    result = {"reference": ticket.reference, "subject": ticket.subject, "category": ticket.category,
              "status": ticket.status, "created_at": _iso(ticket.created_at), "updated_at": _iso(ticket.updated_at)}
    if admin:
        result.update(user_id=ticket.user_id, name=ticket.name or "", phone=ticket.phone or "", stage=ticket.stage or "",
                      error_code=ticket.error_code or "", error_reference=ticket.error_reference or "")
    return result


def _conversation(session, ticket, admin=False):
    result = _summary(ticket, admin)
    rows = session.scalars(select(SupportMessage).where(SupportMessage.ticket_id == ticket.id).order_by(SupportMessage.id)).all()
    files = session.scalars(select(SupportAttachment).where(SupportAttachment.ticket_id == ticket.id,
        SupportAttachment.message_id.is_not(None), SupportAttachment.state == "ready").order_by(SupportAttachment.id)).all() if ticket.user_id is not None else []
    by_message = {}
    for file in files:
        by_message.setdefault(file.message_id, []).append(attachments.descriptor(file))
    result["messages"] = [{"author": row.author, "body": row.body, "created_at": _iso(row.created_at),
                           "attachments": by_message.get(row.id, [])} for row in rows]
    if admin:
        events = session.scalars(select(SupportStatusEvent).where(SupportStatusEvent.ticket_id == ticket.id).order_by(SupportStatusEvent.id)).all()
        result["status_history"] = [{"from": row.from_status, "to": row.to_status, "actor_id": row.actor_id,
                                     "created_at": _iso(row.created_at)} for row in events]
    return result


def _authorize(session, reference, lock=False, user_id=None):
    statement = select(SupportTicket).where(
        SupportTicket.reference == reference.strip().upper(),
        SupportTicket.user_id.is_(None) if user_id is None else SupportTicket.user_id == user_id,
    )
    if lock:
        statement = statement.with_for_update()
    ticket = session.scalar(statement)
    if ticket is None:
        raise MembershipError("ticket-not-found", "تیکتی با این کد پیگیری پیدا نشد. کد پیگیری را بررسی کنید.")
    return ticket


def create_ticket(*, name="", phone="", category, subject, message, stage="", error_code="", error_reference="", reference="", user_id=None, attachment_ids=()):
    if not (name or "").strip():
        raise MembershipError("support-input", "نام را وارد کنید.")
    name = _clean(name, 80, 1)
    phone = normalize_phone(phone)
    if not is_mobile_phone(phone):
        raise MembershipError("phone", "شماره تلفن را وارد کنید؛ شماره باید ۱۱ رقم و با ۰۹ شروع شود.")
    if category not in CATEGORIES:
        raise MembershipError("support-input", "\u0646\u0648\u0639 \u0645\u0634\u06a9\u0644 \u0631\u0627 \u0627\u0646\u062a\u062e\u0627\u0628 \u06a9\u0646\u06cc\u062f.")
    subject, message = _clean(subject, 160, 3), _clean(message, 4000, 1)
    stage, error_code, error_reference = _clean(stage, 32), _clean(error_code, 48), _clean(error_reference, 32)
    reference = reference or "SUP-" + "".join(secrets.choice(REFERENCE_ALPHABET) for _ in range(16))
    if not re.fullmatch(REFERENCE_PATTERN, reference):
        raise MembershipError("support-input", "کد پیگیری معتبر نیست. دوباره تلاش کنید.")
    now = datetime.now(timezone.utc)
    try:
        with db_session() as session:
            # Retain the legacy non-null column for existing deployments; it is no
            # longer used for authorization and no separate access key is created.
            ticket = SupportTicket(user_id=user_id, reference=reference, access_hash="",
                                   name=name or None, phone=phone or None, category=category, subject=subject, stage=stage or None,
                                   error_code=error_code or None, error_reference=error_reference or None,
                                   status="open", created_at=now, updated_at=now)
            session.add(ticket)
            session.flush()
            first_message = SupportMessage(ticket_id=ticket.id, author="user", actor_id=user_id, body=message, created_at=now)
            session.add(first_message)
            session.flush()
            attachments.claim(session, ticket, first_message, attachment_ids, user_id)
            session.flush()
            return _conversation(session, ticket)
    except IntegrityError as error:
        if getattr(error.orig, "sqlstate", None) == "23505":
            raise MembershipError("reference-conflict", "ثبت تیکت با این کد پیگیری ممکن نشد. دوباره تلاش کنید.") from error
        raise


def read_ticket(reference, *, user_id=None):
    with db_session() as session:
        return _conversation(session, _authorize(session, reference, user_id=user_id))


def _add_message(session, ticket, body, author, actor_id=None):
    body = _clean(body, 4000, 2)
    count = session.scalar(select(func.count()).select_from(SupportMessage).where(SupportMessage.ticket_id == ticket.id)) or 0
    if count >= MAX_MESSAGES:
        raise MembershipError("support-input", "\u0633\u0642\u0641 \u067e\u06cc\u0627\u0645\u200c\u0647\u0627\u06cc \u0627\u06cc\u0646 \u062a\u06cc\u06a9\u062a \u067e\u0631 \u0634\u062f\u0647 \u0627\u0633\u062a. \u062a\u06cc\u06a9\u062a \u062a\u0627\u0632\u0647\u200c\u0627\u06cc \u0628\u0627 \u0627\u0634\u0627\u0631\u0647 \u0628\u0647 \u06a9\u062f \u0627\u06cc\u0646 \u062a\u06cc\u06a9\u062a \u062b\u0628\u062a \u06a9\u0646\u06cc\u062f.")
    message = SupportMessage(ticket_id=ticket.id, author=author, actor_id=actor_id, body=body)
    session.add(message)
    return message


def _set_status(session, ticket, status, actor_id=None):
    if status != ticket.status:
        session.add(SupportStatusEvent(ticket_id=ticket.id, actor_id=actor_id, from_status=ticket.status, to_status=status))
        ticket.status = status
    ticket.updated_at = datetime.now(timezone.utc)


def reply_ticket(reference, message, *, user_id=None, attachment_ids=()):
    with db_session() as session:
        ticket = _authorize(session, reference, lock=True, user_id=user_id)
        if ticket.status == "closed":
            raise MembershipError("ticket-closed", "این تیکت بسته شده است و امکان ارسال پیام ندارد. برای موضوع جدید، تیکت تازه‌ای ثبت کنید.")
        if attachments.already_sent(session, ticket, attachment_ids, user_id, message):
            return _conversation(session, ticket)
        reply = _add_message(session, ticket, message, "user", user_id)
        attachments.claim(session, ticket, reply, attachment_ids, user_id)
        _set_status(session, ticket, "open")
        session.flush()
        return _conversation(session, ticket)


def list_tickets(status="", offset=0, limit=50):
    if status and status not in STATUSES:
        raise MembershipError("support-input", "\u0648\u0636\u0639\u06cc\u062a \u0645\u0639\u062a\u0628\u0631 \u0646\u06cc\u0633\u062a.")
    with db_session() as session:
        statement = select(SupportTicket)
        if status:
            statement = statement.where(SupportTicket.status == status)
        rows = session.scalars(statement.order_by(SupportTicket.updated_at.desc(), SupportTicket.id.desc()).offset(offset).limit(limit + 1)).all()
        return {"tickets": [_summary(row, True) for row in rows[:limit]], "has_more": len(rows) > limit, "next_offset": offset + limit}


def admin_ticket(reference):
    with db_session() as session:
        ticket = session.scalar(select(SupportTicket).where(SupportTicket.reference == reference))
        if ticket is None:
            raise MembershipError("ticket-not-found", "\u062a\u06cc\u06a9\u062a \u067e\u06cc\u062f\u0627 \u0646\u0634\u062f.")
        return _conversation(session, ticket, True)


def update_ticket(reference, actor_id, status, message="", attachment_ids=()):
    if status not in STATUSES:
        raise MembershipError("support-input", "\u0648\u0636\u0639\u06cc\u062a \u0645\u0639\u062a\u0628\u0631 \u0646\u06cc\u0633\u062a.")
    with db_session() as session:
        ticket = session.scalar(select(SupportTicket).where(SupportTicket.reference == reference).with_for_update())
        if ticket is None:
            raise MembershipError("ticket-not-found", "\u062a\u06cc\u06a9\u062a \u067e\u06cc\u062f\u0627 \u0646\u0634\u062f.")
        if attachment_ids and ticket.status == "closed":
            raise MembershipError("ticket-closed", "برای افزودن پیوست ابتدا تیکت را باز کنید.")
        if attachment_ids and not message.strip():
            raise MembershipError("support-input", "همراه پیوست، متن پاسخ را وارد کنید.")
        if message.strip():
            if not attachments.already_sent(session, ticket, attachment_ids, actor_id, message):
                reply = _add_message(session, ticket, message, "support", actor_id)
                attachments.claim(session, ticket, reply, attachment_ids, actor_id)
        _set_status(session, ticket, status, actor_id)
        session.flush()
        return _conversation(session, ticket, True)


def _history_cursor(ticket):
    payload = json.dumps([_iso(ticket.updated_at), ticket.id], separators=(",", ":"))
    return base64.urlsafe_b64encode(payload.encode("ascii")).decode("ascii").rstrip("=")


def _decode_history_cursor(cursor):
    try:
        raw = base64.b64decode(cursor + "=" * (-len(cursor) % 4), altchars=b"-_", validate=True)
        timestamp, ticket_id = json.loads(raw)
        when = datetime.fromisoformat(timestamp)
        if when.tzinfo is None or type(ticket_id) is not int or not 0 < ticket_id <= 2147483647:
            raise ValueError("Invalid history cursor")
        return when.astimezone(timezone.utc), ticket_id
    except (ValueError, TypeError, UnicodeError) as error:
        raise MembershipError("support-input", "بارگذاری ادامه فهرست ممکن نشد. فهرست را تازه‌سازی کنید.") from error


def list_user_tickets(user_id, cursor="", limit=25):
    # Seek pagination uses the owner/date/id index; no OFFSET, COUNT, or message joins.
    with db_session() as session:
        statement = select(SupportTicket.id, SupportTicket.reference, SupportTicket.subject, SupportTicket.category,
                           SupportTicket.status, SupportTicket.created_at, SupportTicket.updated_at).where(SupportTicket.user_id == user_id)
        if cursor:
            before, ticket_id = _decode_history_cursor(cursor)
            statement = statement.where(tuple_(SupportTicket.updated_at, SupportTicket.id) < tuple_(before, ticket_id))
        rows = session.execute(statement.order_by(SupportTicket.updated_at.desc(), SupportTicket.id.desc()).limit(limit + 1)).all()
        visible = rows[:limit]
        return {"tickets": [_summary(ticket) for ticket in visible], "has_more": len(rows) > limit,
                "next_cursor": _history_cursor(visible[-1]) if len(rows) > limit else None}

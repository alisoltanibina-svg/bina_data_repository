"""Account-independent support tickets. Access secrets never appear in URLs or storage."""
from __future__ import annotations
import hashlib
import hmac
import re
import secrets
from datetime import datetime, timezone
from sqlalchemy import func, select
from backend.database import db_session
from backend.membership import MembershipError, is_mobile_phone, normalize_phone
from backend.models import SupportMessage, SupportStatusEvent, SupportTicket

CATEGORIES = frozenset({"login", "register", "reset", "otp", "account", "other"})
STATUSES = frozenset({"open", "in_progress", "awaiting_user", "closed"})
MAX_MESSAGES = 200


def _clean(value, maximum, minimum=0):
    value = (value or "").strip()
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
        result.update(name=ticket.name or "", phone=ticket.phone or "", stage=ticket.stage or "",
                      error_code=ticket.error_code or "", error_reference=ticket.error_reference or "")
    return result


def _conversation(session, ticket, admin=False):
    result = _summary(ticket, admin)
    rows = session.scalars(select(SupportMessage).where(SupportMessage.ticket_id == ticket.id).order_by(SupportMessage.id)).all()
    result["messages"] = [{"author": row.author, "body": row.body, "created_at": _iso(row.created_at)} for row in rows]
    if admin:
        events = session.scalars(select(SupportStatusEvent).where(SupportStatusEvent.ticket_id == ticket.id).order_by(SupportStatusEvent.id)).all()
        result["status_history"] = [{"from": row.from_status, "to": row.to_status, "actor_id": row.actor_id,
                                     "created_at": _iso(row.created_at)} for row in events]
    return result


def _authorize(session, reference, access_key, lock=False):
    statement = select(SupportTicket).where(SupportTicket.reference == reference.strip().upper())
    if lock:
        statement = statement.with_for_update()
    ticket = session.scalar(statement)
    supplied = hashlib.sha256(access_key.encode("utf-8")).hexdigest()
    if ticket is None or not hmac.compare_digest(ticket.access_hash, supplied):
        raise MembershipError("ticket-not-found", "\u062a\u06cc\u06a9\u062a \u0628\u0627 \u0627\u06cc\u0646 \u06a9\u062f \u067e\u06cc\u06af\u06cc\u0631\u06cc \u0648 \u06a9\u0644\u06cc\u062f \u062f\u0633\u062a\u0631\u0633\u06cc \u067e\u06cc\u062f\u0627 \u0646\u0634\u062f. \u0647\u0631 \u062f\u0648 \u0631\u0627 \u0627\u0632 \u0631\u0648\u06cc \u0631\u0633\u06cc\u062f \u0628\u0631\u0631\u0633\u06cc \u06a9\u0646\u06cc\u062f.")
    return ticket


def create_ticket(*, name="", phone="", category, subject, message, stage="", error_code="", error_reference="", reference="", access_key=""):
    name = _clean(name, 80)
    phone = normalize_phone(phone)
    if phone and not is_mobile_phone(phone):
        raise MembershipError("phone", "\u0634\u0645\u0627\u0631\u0647 \u0645\u0648\u0628\u0627\u06cc\u0644 \u0627\u062e\u062a\u06cc\u0627\u0631\u06cc \u0631\u0627 \u062f\u0631\u0633\u062a \u0648\u0627\u0631\u062f \u06a9\u0646\u06cc\u062f \u06cc\u0627 \u062e\u0627\u0644\u06cc \u0628\u06af\u0630\u0627\u0631\u06cc\u062f.")
    if category not in CATEGORIES:
        raise MembershipError("support-input", "\u0646\u0648\u0639 \u0645\u0634\u06a9\u0644 \u0631\u0627 \u0627\u0646\u062a\u062e\u0627\u0628 \u06a9\u0646\u06cc\u062f.")
    subject, message = _clean(subject, 160, 3), _clean(message, 4000, 1)
    stage, error_code, error_reference = _clean(stage, 32), _clean(error_code, 48), _clean(error_reference, 32)
    key = access_key or secrets.token_urlsafe(24)
    reference = reference or "SUP-" + secrets.token_hex(6).upper()
    if not re.fullmatch(r"SUP-[A-F0-9]{12}", reference) or not re.fullmatch(r"[A-Za-z0-9_-]{32}", key):
        raise MembershipError("support-input", "Invalid ticket receipt")
    now = datetime.now(timezone.utc)
    with db_session() as session:
        ticket = SupportTicket(reference=reference, access_hash=hashlib.sha256(key.encode()).hexdigest(),
                               name=name or None, phone=phone or None, category=category, subject=subject, stage=stage or None,
                               error_code=error_code or None, error_reference=error_reference or None,
                               status="open", created_at=now, updated_at=now)
        session.add(ticket)
        session.flush()
        session.add(SupportMessage(ticket_id=ticket.id, author="user", body=message, created_at=now))
        session.flush()
        result = _conversation(session, ticket)
        result["access_key"] = key
        return result


def read_ticket(reference, access_key):
    with db_session() as session:
        return _conversation(session, _authorize(session, reference, access_key))


def _add_message(session, ticket, body, author, actor_id=None):
    body = _clean(body, 4000, 2)
    count = session.scalar(select(func.count()).select_from(SupportMessage).where(SupportMessage.ticket_id == ticket.id)) or 0
    if count >= MAX_MESSAGES:
        raise MembershipError("support-input", "\u0633\u0642\u0641 \u067e\u06cc\u0627\u0645\u200c\u0647\u0627\u06cc \u0627\u06cc\u0646 \u062a\u06cc\u06a9\u062a \u067e\u0631 \u0634\u062f\u0647 \u0627\u0633\u062a. \u062a\u06cc\u06a9\u062a \u062a\u0627\u0632\u0647\u200c\u0627\u06cc \u0628\u0627 \u0627\u0634\u0627\u0631\u0647 \u0628\u0647 \u06a9\u062f \u0627\u06cc\u0646 \u062a\u06cc\u06a9\u062a \u062b\u0628\u062a \u06a9\u0646\u06cc\u062f.")
    session.add(SupportMessage(ticket_id=ticket.id, author=author, actor_id=actor_id, body=body))


def _set_status(session, ticket, status, actor_id=None):
    if status != ticket.status:
        session.add(SupportStatusEvent(ticket_id=ticket.id, actor_id=actor_id, from_status=ticket.status, to_status=status))
        ticket.status = status
    ticket.updated_at = datetime.now(timezone.utc)


def reply_ticket(reference, access_key, message):
    with db_session() as session:
        ticket = _authorize(session, reference, access_key, lock=True)
        _add_message(session, ticket, message, "user")
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


def update_ticket(reference, actor_id, status, message=""):
    if status not in STATUSES:
        raise MembershipError("support-input", "\u0648\u0636\u0639\u06cc\u062a \u0645\u0639\u062a\u0628\u0631 \u0646\u06cc\u0633\u062a.")
    with db_session() as session:
        ticket = session.scalar(select(SupportTicket).where(SupportTicket.reference == reference).with_for_update())
        if ticket is None:
            raise MembershipError("ticket-not-found", "\u062a\u06cc\u06a9\u062a \u067e\u06cc\u062f\u0627 \u0646\u0634\u062f.")
        if message.strip():
            _add_message(session, ticket, message, "support", actor_id)
        _set_status(session, ticket, status, actor_id)
        session.flush()
        return _conversation(session, ticket, True)

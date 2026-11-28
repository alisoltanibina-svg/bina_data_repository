"""Stable collector identities. No editor models, APIs or Nearby persistence.

All mutations take the same short transaction advisory lock. Source records are
preserved; a canonical UUID identifies the place through all source aliases.
"""
from datetime import datetime,timezone
import hashlib
import math
from types import SimpleNamespace
from uuid import UUID
from sqlalchemy import select,func,and_,or_,union_all
from backend.poi_models import PoiPlace,PoiPlaceCategory,PoiPlaceLink,PoiProviderAlias,PoiCanonicalEvent,PoiRetiredPlace
from backend.poi_identity_rules import normalized,same_identity,MAX_CANDIDATES

LOCK_KEY=741923819
MAX_MEMBERS=10000


class IdentityConflict(Exception):
    def __init__(self,reason):
        self.reason=reason
        super().__init__(reason)


def identity_lock(session):
    """Acquire before canonicalizing or locking editorial/source rows for writes."""
    if session.get_bind().dialect.name=='postgresql':
        # A REPEATABLE READ snapshot taken before waiting for the advisory lock
        # could miss a place committed by the previous holder. Fail explicitly
        # instead of producing another source row from that stale snapshot.
        if session.connection().get_isolation_level()!='READ COMMITTED':
            raise IdentityConflict('identity_writes_require_read_committed')
        session.execute(select(func.pg_advisory_xact_lock(LOCK_KEY)))


def _uuid(value):
    return value if isinstance(value,UUID) else UUID(str(value))


def canonical_id(session,place_id):
    current=_uuid(place_id);seen=set()
    for _ in range(64):
        if current in seen:raise IdentityConflict('canonical_link_cycle')
        seen.add(current)
        targets=set(session.scalars(union_all(
            select(PoiPlaceLink.canonical_id).where(PoiPlaceLink.source_id==current),
            select(PoiRetiredPlace.canonical_id).where(PoiRetiredPlace.source_id==current))).all())
        if len(targets)>1:raise IdentityConflict('conflicting_retired_source_route')
        if not targets:return current
        current=targets.pop()
    raise IdentityConflict('canonical_link_depth_exceeded')


def member_ids(session,place_id):
    root=canonical_id(session,place_id);members={root};frontier={root}
    while frontier:
        incoming=set(session.scalars(union_all(
            select(PoiPlaceLink.source_id).where(PoiPlaceLink.canonical_id.in_(frontier)),
            select(PoiRetiredPlace.source_id).where(PoiRetiredPlace.canonical_id.in_(frontier)))).all())
        frontier=incoming-members;members.update(incoming)
        if len(members)>MAX_MEMBERS:raise IdentityConflict('canonical_group_too_large')
    return members


def canonical_predicate(column=PoiPlace.id):
    return (~select(PoiPlaceLink.source_id).where(PoiPlaceLink.source_id==column).exists()) & (
        ~select(PoiRetiredPlace.source_id).where(PoiRetiredPlace.source_id==column).exists())


def retained_sources(session,ids):
    """Load live source rows and immutable identity evidence for deleted aliases."""
    ids={_uuid(value) for value in ids}
    if not ids:return []
    rows=session.scalars(select(PoiPlace).where(PoiPlace.id.in_(ids))).all()
    missing=ids-{row.id for row in rows}
    if not missing:return rows
    for retired in session.scalars(select(PoiRetiredPlace).where(PoiRetiredPlace.source_id.in_(missing))).all():
        snapshot=retired.snapshot or {};raw=snapshot.get('place',{})
        values={column.name:raw.get(column.name) for column in PoiPlace.__table__.columns}
        for key in ('resolved_at','discovered_at'):
            if isinstance(values.get(key),str):
                try:values[key]=datetime.fromisoformat(values[key])
                except ValueError:raise IdentityConflict('invalid_retired_source_timestamp') from None
        values.update(id=retired.source_id,provider=retired.provider,name=retired.name,province_name=retired.province_name,
            latitude=retired.latitude,longitude=retired.longitude,_retired_category=retired.category)
        rows.append(SimpleNamespace(**values))
    return rows


def collection_row(session,provider,root,preferred_source=None):
    """Choose a provider-owned storage sink without changing the logical place.

    A confirmed Neshan observation can belong to a manually added canonical
    place. Its Details must refresh a Neshan source member, never overwrite the
    user's original manual record. The preferred physical member is used only
    inside that already-confirmed group; it never resolves an identity clash.
    """
    root=canonical_id(session,root);canonical=session.get(PoiPlace,root)
    if canonical is None:raise IdentityConflict('canonical_source_not_found')
    if canonical.provider==provider:return canonical
    members=member_ids(session,root)
    if preferred_source is not None:
        preferred=_uuid(preferred_source)
        if preferred not in members:raise IdentityConflict('provider_source_not_member')
        row=session.get(PoiPlace,preferred)
        if row is not None and row.provider==provider:return row
    row=session.scalar(select(PoiPlace).where(PoiPlace.id.in_(members),PoiPlace.provider==provider)
        .order_by(PoiPlace.discovered_at,PoiPlace.id).limit(1))
    if row is None:raise IdentityConflict('provider_source_not_found')
    return row


def source_category_match(category):
    raw=PoiPlace.raw_details['layer']['slug'].as_string()
    mapped=select(PoiPlaceCategory.place_id).where(PoiPlaceCategory.place_id==PoiPlace.id,PoiPlaceCategory.category==category).exists()
    return or_(raw==category,and_(or_(raw.is_(None),raw==''),mapped))


def positions(session,rows):
    """Read only permitted Details/source metadata, never Nearby responses."""
    missing=[];result={}
    for row in rows:
        layer=(row.raw_details or {}).get('layer') if isinstance(row.raw_details,dict) else None
        category=getattr(row,'_retired_category',None) or (layer.get('slug') if isinstance(layer,dict) else None)
        if isinstance(category,str) and category:
            result[row.id]=SimpleNamespace(category=category,name=row.name,province=row.province_name,latitude=row.latitude,longitude=row.longitude)
        else:missing.append(row)
    if missing:
        mapped={}
        for key,category in session.execute(select(PoiPlaceCategory.place_id,PoiPlaceCategory.category).where(PoiPlaceCategory.place_id.in_([r.id for r in missing]))):
            mapped.setdefault(key,[]).append(category)
        for row in missing:
            categories=mapped.get(row.id,[])
            if len(categories)!=1:raise IdentityConflict('source_category_ambiguous')
            result[row.id]=SimpleNamespace(category=categories[0],name=row.name,province=row.province_name,latitude=row.latitude,longitude=row.longitude)
    return result


def validate_members(session,canonical,members):
    """Read-only structural/identity checks; returns every expanded source UUID."""
    canonical=_uuid(canonical);all_ids={canonical,*map(_uuid,members)}
    for key in list(all_ids):all_ids.update(member_ids(session,key))
    if len(all_ids)>MAX_MEMBERS:raise IdentityConflict('canonical_group_too_large')
    if session.get(PoiPlace,canonical) is None:raise IdentityConflict('canonical_source_must_be_live')
    rows=retained_sources(session,all_ids)
    if len(rows)!=len(all_ids):raise IdentityConflict('source_record_not_found')
    providers={r.provider for r in rows}
    if len(providers)>1 and providers!={'manual','neshan'}:
        raise IdentityConflict('source_provider_mismatch')
    values=list(positions(session,rows).values())
    for index,first in enumerate(values):
        for second in values[index+1:]:
            if not same_identity(first,second):raise IdentityConflict('group_not_complete_link')
    return all_ids


def link_members(session,canonical,members,*,actor='reconciliation',reason='category-distance-province-name'):
    """Consolidate a complete-link group; do not alter any original place/history.

    Existing groups expand atomically, so a source alias can never be split
    away from the rest of its place. Explicitly selecting an existing alias as
    the new anchor reanchors the whole group and records the old mapping.
    """
    identity_lock(session);canonical=_uuid(canonical);all_ids=validate_members(session,canonical,members)
    existing={row.source_id:row for row in session.scalars(select(PoiPlaceLink).where(PoiPlaceLink.source_id.in_(all_ids))).all()}
    retired={row.source_id:row for row in session.scalars(select(PoiRetiredPlace).where(PoiRetiredPlace.source_id.in_(all_ids))).all()}
    previous={str(key):str(row.canonical_id) for key,row in existing.items()}
    previous.update({str(key):str(row.canonical_id) for key,row in retired.items()})
    wanted={str(key):str(canonical) for key in all_ids if key!=canonical}
    if previous==wanted:return all_ids
    for key in sorted(all_ids,key=str):
        current=existing.get(key)
        archived=retired.get(key)
        if key==canonical:
            if current:session.delete(current)
        elif archived:
            archived.canonical_id=canonical
            if current:session.delete(current)
        elif current:
            current.canonical_id=canonical;current.reason=reason;current.linked_by=str(actor)[:100]
        else:session.add(PoiPlaceLink(source_id=key,canonical_id=canonical,reason=reason,linked_by=str(actor)[:100]))
    # Make the new mapping visible to collection_row in this transaction. All
    # writes remain protected by the identity advisory lock until commit.
    session.flush()
    for alias in session.scalars(select(PoiProviderAlias).where(PoiProviderAlias.place_id.in_(all_ids))).all():
        alias.place_id=collection_row(session,alias.provider,canonical,preferred_source=alias.place_id).id
    session.add(PoiCanonicalEvent(canonical_id=canonical,members=sorted(map(str,all_ids)),previous_mapping=previous,actor=str(actor)[:100],reason=reason))
    session.flush()
    return all_ids


def retire_source(session,source_id,canonical,snapshot,category,actor='exact-deduplication'):
    """Archive a linked source before its caller remaps references and deletes it.

    This operation never deletes records. The caller must retain a live source
    for every provider, redirect fingerprints/FKs and remove the live source
    link before deleting PoiPlace. Editorial UUIDs intentionally stay unchanged.
    """
    identity_lock(session);source_id=_uuid(source_id);canonical=canonical_id(session,canonical)
    if source_id==canonical:raise IdentityConflict('cannot_retire_canonical_source')
    row=session.get(PoiPlace,source_id);root=session.get(PoiPlace,canonical)
    if row is None or root is None:raise IdentityConflict('retirement_source_not_found')
    if canonical_id(session,source_id)!=canonical:raise IdentityConflict('retirement_requires_canonical_link')
    evidence=positions(session,[row])[row.id]
    if category!=evidence.category:raise IdentityConflict('retirement_category_mismatch')
    existing=session.get(PoiRetiredPlace,source_id)
    if existing:
        if existing.canonical_id!=canonical:raise IdentityConflict('retirement_already_recorded_for_other_root')
        return existing
    if not isinstance(snapshot,dict) or not isinstance(snapshot.get('place'),dict):raise IdentityConflict('retirement_snapshot_required')
    archived=PoiRetiredPlace(source_id=source_id,canonical_id=canonical,provider=row.provider,category=category,name=row.name,
        province_name=row.province_name,latitude=row.latitude,longitude=row.longitude,snapshot=snapshot,retired_by=str(actor)[:100])
    session.add(archived);session.flush();return archived


def token_digest(provider_id):
    if not isinstance(provider_id,str) or not 0<len(provider_id)<=2048:raise IdentityConflict('invalid_provider_token')
    return hashlib.sha256(provider_id.encode('utf-8')).hexdigest()


def remembered_place(session,provider,provider_id):
    alias=session.get(PoiProviderAlias,(provider,token_digest(provider_id)))
    if alias:
        row=session.get(PoiPlace,alias.place_id)
        if row is None or row.provider!=provider:raise IdentityConflict('provider_alias_mismatch')
        return collection_row(session,provider,alias.place_id,preferred_source=alias.place_id)
    source=session.scalar(select(PoiPlace).where(PoiPlace.provider==provider,PoiPlace.provider_id==provider_id))
    return collection_row(session,provider,source.id,preferred_source=source.id) if source else None


def resolve_details(session,provider,provider_id,body,assignment):
    """Return an existing stable place, None for a new place, or fail closed.

    Caller stores the successful Details response on the returned/new source row
    and then calls remember_token. No incoming provider data is written here.
    """
    identity_lock(session)
    known=remembered_place(session,provider,provider_id)
    if known:
        if known.provider!=provider:raise IdentityConflict('provider_alias_mismatch')
        return known
    from backend.poi_provider import details
    lat,lon=details(body);layer=body.get('layer')
    category=layer.get('slug') if isinstance(layer,dict) else None
    province=assignment.get('province_name')
    return match_existing_source(session,provider,category,body['name'],lat,lon,province)


def match_existing_source(session,provider,category,name,latitude,longitude,province):
    """Match stored Details at exactly the same latitude and longitude.

    Ephemeral Nearby metadata may be compared with these rows to avoid an
    unnecessary Details request. This helper never remembers tokens, records
    input metadata or changes source/canonical tables. Coordinates are not
    rounded or compared with a distance tolerance; category, normalized province
    and normalized name must also match.
    """
    # Border/outside-boundary or uncategorized Details are still permitted
    # source records. They cannot be auto-linked by a rule requiring a known
    # province/category, and must not stall all other collection work.
    if not isinstance(category,str) or not category or not normalized(province) or not normalized(name):return None
    lat,lon=latitude,longitude
    if not all(isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value) for value in (lat,lon)) or not -90<=lat<=90 or not -180<=lon<=180:return None
    target=SimpleNamespace(category=category,name=name,province=province,latitude=lat,longitude=lon)
    rows=session.scalars(select(PoiPlace).where(PoiPlace.provider==provider,PoiPlace.resolved_at.is_not(None),
        source_category_match(category),PoiPlace.latitude==lat,PoiPlace.longitude==lon)
        .order_by(PoiPlace.id).limit(MAX_CANDIDATES+1)).all()
    if len(rows)>MAX_CANDIDATES:raise IdentityConflict('too_many_source_candidates')
    values=positions(session,rows)
    matches=[row for row in rows if same_identity(values[row.id],target)]
    roots={canonical_id(session,row.id) for row in matches}
    if len(roots)>1:raise IdentityConflict('multiple_source_identities')
    if not roots:return None
    root=roots.pop();members=member_ids(session,root)
    members_rows=retained_sources(session,members)
    # Preserve the safety check for previously confirmed groups. Their existing
    # links do not widen the exact-coordinate lookup above.
    if any(not same_identity(value,target) for value in positions(session,members_rows).values()):
        raise IdentityConflict('new_details_would_bridge_group')
    return collection_row(session,provider,root,preferred_source=matches[0].id)


def remember_token(session,provider,provider_id,place_id):
    """Call only after successful Details validation/storage in this transaction."""
    identity_lock(session);root=canonical_id(session,place_id)
    row=collection_row(session,provider,root,preferred_source=place_id)
    if row is None or row.provider!=provider or not row.resolved_at:raise IdentityConflict('details_not_stored')
    digest=token_digest(provider_id);existing=session.get(PoiProviderAlias,(provider,digest))
    if existing:
        if canonical_id(session,existing.place_id)!=root:raise IdentityConflict('provider_token_collision')
        existing.place_id=row.id;existing.observed_at=datetime.now(timezone.utc)
    else:session.add(PoiProviderAlias(provider=provider,token_digest=digest,place_id=row.id,observed_at=datetime.now(timezone.utc)))
    session.flush()

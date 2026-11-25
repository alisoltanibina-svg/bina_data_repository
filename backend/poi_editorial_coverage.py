"""Read-only provincial evidence checks for plans awaiting collector reconciliation."""
from sqlalchemy import select,and_,or_,literal_column,func
from sqlalchemy.orm import aliased

from backend.poi_geo import normalize
from backend.poi_models import PoiSegment,PoiCoverageCircle,PoiCoverageContribution,PoiRequest
from backend.poi_sql import province_key


def province_discovery_blockers(session,job,plan,scope=None):
    """Do not make one province wait for a national historical-search audit.

    Check the selected root trees, including roots that cover a neighbouring
    province. Completed leaves need successful, unsaturated search evidence;
    completed refined parents need only completed descendants. No collector
    state, provider responses, or authorization decisions are written/cached.
    """
    root=aliased(PoiSegment,name='editor_root')
    circle=PoiCoverageCircle
    roots=(root.job_id==job.id,root.kind==literal_column("'coverage'"),
        root.parent_segment_id.is_(None),circle.plan_id==plan.id)
    owned=select(root.id.label('root_id'),circle.province_name.label('province')).join(
        circle,circle.id==root.coverage_circle_id).where(*roots)
    shared=select(root.id.label('root_id'),PoiCoverageContribution.province_name.label('province')).join(
        circle,circle.id==root.coverage_circle_id).join(PoiCoverageContribution,
        PoiCoverageContribution.circle_id==circle.id).where(*roots,
        PoiCoverageContribution.province_name!=literal_column("'__union__'"))
    if scope is not None:
        owned=owned.where(province_key(circle.province_name).in_(scope))
        shared=shared.where(province_key(PoiCoverageContribution.province_name).in_(scope))
    destinations=owned.union(shared).cte('editor_province_roots')
    tree=select(root.id.label('root_id'),root.id,root.category,root.status,root.review_reason,root.pending_details).where(
        root.id.in_(select(destinations.c.root_id))).cte('editor_province_tree',recursive=True)
    child=aliased(PoiSegment,name='editor_child')
    tree=tree.union(select(tree.c.root_id,child.id,child.category,child.status,child.review_reason,child.pending_details).join(
        tree,child.parent_segment_id==tree.c.id).where(child.job_id==job.id,child.kind==literal_column("'coverage'")))
    has_children=select(child.id).where(child.parent_segment_id==tree.c.id).exists()
    invalid_child=select(child.id).where(child.parent_segment_id==tree.c.id,
        or_(child.job_id!=job.id,child.kind!=literal_column("'coverage'"),child.category!=tree.c.category)).exists()
    # Fixed literals keep the existing partial request index usable even when
    # PostgreSQL chooses a generic prepared plan after repeated profile views.
    latest_count=select(PoiRequest.result_count).where(PoiRequest.job_id==job.id,
        PoiRequest.target_id==tree.c.id,PoiRequest.kind==literal_column("'nearby'"),
        PoiRequest.target_type==literal_column("'segment'"),PoiRequest.outcome==literal_column("'successful'")).order_by(
        PoiRequest.id.desc()).limit(literal_column('1')).correlate(tree).scalar_subquery()
    from backend.poi_coverage_state import effective_result_limit
    # PostgreSQL can duplicate scalar probes when expanding an OR/BETWEEN.
    # Materialize each node's evidence once before applying the final filter.
    evidence=select(tree,has_children.label('has_children'),invalid_child.label('invalid_child'),
        latest_count.label('result_count')).cte('editor_province_evidence').prefix_with('MATERIALIZED')
    invalid=or_(evidence.c.status!='complete',evidence.c.review_reason.is_not(None),evidence.c.pending_details>0,
        evidence.c.invalid_child,and_(~evidence.c.has_children,
        ~func.coalesce(evidence.c.result_count,-1).between(0,effective_result_limit(plan)-1)))
    bad_roots=select(evidence.c.root_id).where(invalid)
    names=session.scalars(select(destinations.c.province).where(destinations.c.root_id.in_(bad_roots)).distinct()).all()
    return {normalize(name) for name in names}

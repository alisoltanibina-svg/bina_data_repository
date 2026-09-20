"""initial postgres schema matching current dashboard tables

Revision ID: 0001_initial_schema
Revises:
Create Date: 2026-09-20
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0001_initial_schema"
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "topics",
        sa.Column("id", sa.Integer(), sa.Identity(always=False), primary_key=True),
        sa.Column("topic_name", sa.Text()),
        sa.Column("topic_description", sa.Text()),
        sa.Column("lower_color", sa.Text()),
        sa.Column("upper_color", sa.Text()),
        sa.Column("master_color", sa.Text()),
        sa.UniqueConstraint("topic_name", name="uq_topics_name"),
    )
    op.create_table(
        "kdescription",
        sa.Column("id", sa.Integer(), sa.Identity(always=False), primary_key=True),
        sa.Column("topic_name", sa.Text()),
        sa.Column("subtopic_name", sa.Text()),
        sa.Column("indicator_name", sa.Text()),
        sa.Column("description", sa.Text()),
        sa.Column("source_name", sa.Text()),
        sa.UniqueConstraint("indicator_name", name="uq_kdescription_indicator"),
    )
    op.create_index(
        "idx_kdescription_topic_sub",
        "kdescription",
        ["topic_name", "subtopic_name"],
    )
    op.create_table(
        "kindicator_score",
        sa.Column("id", sa.Integer(), sa.Identity(always=False), primary_key=True),
        sa.Column("province_name", sa.Text()),
        sa.Column("topic_name", sa.Text()),
        sa.Column("subtopic_name", sa.Text()),
        sa.Column("indicator_name", sa.Text()),
        sa.Column("year", sa.Integer()),
        sa.Column("direction", sa.Float()),
        sa.Column("value", sa.Float()),
        sa.Column("standard_value", sa.Float()),
        sa.UniqueConstraint(
            "indicator_name", "year", "province_name", name="uq_kindicator_score"
        ),
    )
    op.create_index("idx_kindicator_province", "kindicator_score", ["province_name"])
    op.create_index(
        "idx_kindicator_topic_sub",
        "kindicator_score",
        ["topic_name", "subtopic_name", "province_name", "indicator_name", "year"],
    )
    op.create_table(
        "trend_score",
        sa.Column("id", sa.Integer(), sa.Identity(always=False), primary_key=True),
        sa.Column("province_name", sa.Text()),
        sa.Column("year", sa.Integer()),
        sa.Column("index_score", sa.Float()),
        sa.Column("topic_name", sa.Text()),
        sa.Column("province_rank", sa.Float()),
        sa.UniqueConstraint(
            "province_name", "year", "topic_name", name="uq_trend_score"
        ),
    )
    op.create_index(
        "idx_trend_score_topic_year", "trend_score", ["topic_name", "year"]
    )
    op.create_table(
        "province_pop",
        sa.Column("id", sa.Integer(), sa.Identity(always=False), primary_key=True),
        sa.Column("province_name", sa.Text()),
        sa.Column("province_pop", sa.Float()),
        sa.Column("year", sa.Integer()),
        sa.UniqueConstraint("province_name", "year", name="uq_province_pop"),
    )
    op.create_table(
        "clusters",
        sa.Column("id", sa.Integer(), sa.Identity(always=False), primary_key=True),
        sa.Column("province_name", sa.Text()),
        sa.Column("topic_name", sa.Text()),
        sa.Column("subtopic_name", sa.Text()),
        sa.Column("cluster_group", sa.Integer()),
        sa.Column("subtopic_score", sa.Float()),
        sa.UniqueConstraint(
            "province_name", "topic_name", "subtopic_name", name="uq_clusters"
        ),
    )
    op.create_table(
        "provinces",
        sa.Column("province_name", sa.Text(), primary_key=True),
        sa.Column(
            "is_national",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )
    op.create_table(
        "pyramid",
        sa.Column("province_name", sa.Text(), primary_key=True),
        sa.Column("year", sa.Integer(), primary_key=True),
        sa.Column("age", sa.Integer(), primary_key=True),
        sa.Column("male", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("female", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("urban", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("rural", sa.Integer(), nullable=False, server_default="0"),
    )



def downgrade() -> None:
    op.drop_table("pyramid")
    op.drop_table("provinces")
    op.drop_table("clusters")
    op.drop_table("province_pop")
    op.drop_index("idx_trend_score_topic_year", table_name="trend_score")
    op.drop_table("trend_score")
    op.drop_index("idx_kindicator_topic_sub", table_name="kindicator_score")
    op.drop_index("idx_kindicator_province", table_name="kindicator_score")
    op.drop_table("kindicator_score")
    op.drop_index("idx_kdescription_topic_sub", table_name="kdescription")
    op.drop_table("kdescription")
    op.drop_table("topics")

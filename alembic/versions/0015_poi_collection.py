"""Persistent nationwide POI acquisition subsystem. Frozen DDL; no live model imports."""
from alembic import op
revision = "0015_poi_collection"
down_revision = "0014_ticket_attachments"
branch_labels = None
depends_on = None

STATEMENTS = [
    """CREATE TABLE poi_boundaries (
	id SERIAL NOT NULL,
	version VARCHAR(64) NOT NULL,
	level VARCHAR(16) NOT NULL,
	code TEXT NOT NULL,
	name TEXT NOT NULL,
	parent_name TEXT,
	geometry JSONB NOT NULL,
	PRIMARY KEY (id),
	CONSTRAINT uq_poi_boundary UNIQUE (version, level, code)
)""",
    """CREATE TABLE poi_categories (
	slug VARCHAR(100) NOT NULL,
	title TEXT NOT NULL,
	PRIMARY KEY (slug)
)""",
    """CREATE TABLE poi_control (
	id SERIAL NOT NULL,
	paused BOOLEAN DEFAULT 'true' NOT NULL,
	reason TEXT DEFAULT '' NOT NULL,
	next_request_at TIMESTAMP WITH TIME ZONE,
	heartbeat_at TIMESTAMP WITH TIME ZONE,
	worker_id VARCHAR(100),
	in_flight BIGINT,
	PRIMARY KEY (id),
	CONSTRAINT ck_poi_single_control CHECK (id = 1)
)""",
    """CREATE TABLE poi_jobs (
	id UUID NOT NULL,
	provider VARCHAR(30) DEFAULT 'neshan' NOT NULL,
	status VARCHAR(20) NOT NULL,
	mode VARCHAR(12) NOT NULL,
	refresh_before TIMESTAMP WITH TIME ZONE,
	boundary_version VARCHAR(64) NOT NULL,
	radius_m INTEGER NOT NULL,
	categories JSONB NOT NULL,
	planned_provinces INTEGER DEFAULT '0' NOT NULL,
	duplicates_skipped INTEGER DEFAULT '0' NOT NULL,
	missing_hashes INTEGER DEFAULT '0' NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	PRIMARY KEY (id),
	CONSTRAINT ck_poi_job_mode CHECK (mode IN ('initial', 'refresh')),
	CONSTRAINT ck_poi_job_status CHECK (status IN ('pending','running','completed','needs_review'))
)""",
    """CREATE TABLE poi_places (
	id UUID NOT NULL,
	provider VARCHAR(30) NOT NULL,
	provider_id TEXT NOT NULL,
	name TEXT NOT NULL,
	normalized_name TEXT NOT NULL,
	latitude FLOAT NOT NULL,
	longitude FLOAT NOT NULL,
	address TEXT,
	address_province TEXT,
	address_county TEXT,
	address_city TEXT,
	address_parse_status VARCHAR(20),
	province_name TEXT,
	county_name TEXT,
	spatial_status VARCHAR(30),
	boundary_version VARCHAR(64),
	raw_details JSONB,
	resolved_at TIMESTAMP WITH TIME ZONE,
	discovered_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	PRIMARY KEY (id),
	CONSTRAINT uq_poi_provider_identifier UNIQUE (provider, provider_id),
	CONSTRAINT ck_poi_coordinates CHECK (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180)
)""",
    """CREATE TABLE poi_duplicate_reviews (
	place_id UUID NOT NULL,
	other_place_id UUID NOT NULL,
	reason TEXT NOT NULL,
	status VARCHAR(16) DEFAULT 'pending' NOT NULL,
	PRIMARY KEY (place_id, other_place_id),
	FOREIGN KEY(place_id) REFERENCES poi_places (id),
	FOREIGN KEY(other_place_id) REFERENCES poi_places (id)
)""",
    """CREATE TABLE poi_place_categories (
	place_id UUID NOT NULL,
	category VARCHAR(100) NOT NULL,
	PRIMARY KEY (place_id, category),
	FOREIGN KEY(place_id) REFERENCES poi_places (id),
	FOREIGN KEY(category) REFERENCES poi_categories (slug)
)""",
    """CREATE TABLE poi_requests (
	id BIGSERIAL NOT NULL,
	job_id UUID NOT NULL,
	kind VARCHAR(12) NOT NULL,
	target_id BIGINT NOT NULL,
	outcome VARCHAR(16) NOT NULL,
	http_status INTEGER,
	error TEXT,
	raw_response JSONB,
	started_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	finished_at TIMESTAMP WITH TIME ZONE,
	PRIMARY KEY (id),
	FOREIGN KEY(job_id) REFERENCES poi_jobs (id)
)""",
    """CREATE TABLE poi_segments (
	id BIGSERIAL NOT NULL,
	job_id UUID NOT NULL,
	province_order INTEGER NOT NULL,
	province_name TEXT NOT NULL,
	category VARCHAR(100) NOT NULL,
	latitude FLOAT NOT NULL,
	longitude FLOAT NOT NULL,
	radius_m INTEGER NOT NULL,
	status VARCHAR(16) DEFAULT 'pending' NOT NULL,
	attempts INTEGER DEFAULT '0' NOT NULL,
	review_reason TEXT,
	PRIMARY KEY (id),
	FOREIGN KEY(job_id) REFERENCES poi_jobs (id),
	FOREIGN KEY(category) REFERENCES poi_categories (slug)
)""",
    """CREATE TABLE poi_detail_tasks (
	id BIGSERIAL NOT NULL,
	job_id UUID NOT NULL,
	place_id UUID NOT NULL,
	segment_id BIGINT NOT NULL,
	province_order INTEGER NOT NULL,
	status VARCHAR(16) DEFAULT 'pending' NOT NULL,
	attempts INTEGER DEFAULT '0' NOT NULL,
	PRIMARY KEY (id),
	CONSTRAINT uq_poi_detail_task UNIQUE (job_id, place_id),
	FOREIGN KEY(job_id) REFERENCES poi_jobs (id),
	FOREIGN KEY(place_id) REFERENCES poi_places (id),
	FOREIGN KEY(segment_id) REFERENCES poi_segments (id)
)""",
    """CREATE INDEX ix_poi_boundaries_version ON poi_boundaries (version)""",
    """CREATE UNIQUE INDEX uq_poi_active_job ON poi_jobs (provider) WHERE status IN ('pending','running')""",
    """CREATE INDEX idx_poi_place_admin ON poi_places (province_name, county_name)""",
    """CREATE INDEX idx_poi_place_extent ON poi_places (longitude, latitude)""",
    """CREATE INDEX idx_poi_place_name ON poi_places (normalized_name)""",
    """CREATE INDEX idx_poi_request_job_outcome ON poi_requests (job_id, kind, outcome)""",
    """CREATE INDEX idx_poi_segment_queue ON poi_segments (job_id, province_order, status, id)""",
    """CREATE INDEX idx_poi_detail_queue ON poi_detail_tasks (job_id, province_order, status, id)""",
]

def upgrade():
    for statement in STATEMENTS:
        op.execute(statement)

def downgrade():
    op.drop_table('poi_detail_tasks')
    op.drop_table('poi_segments')
    op.drop_table('poi_requests')
    op.drop_table('poi_place_categories')
    op.drop_table('poi_duplicate_reviews')
    op.drop_table('poi_places')
    op.drop_table('poi_jobs')
    op.drop_table('poi_control')
    op.drop_table('poi_categories')
    op.drop_table('poi_boundaries')

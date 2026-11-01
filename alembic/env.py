from __future__ import annotations

from logging.config import fileConfig

from alembic import context
from dotenv import load_dotenv
from sqlalchemy import create_engine, pool

from backend.models import Base
from backend.db_schema import APPLICATION_SCHEMAS
from backend.settings import ENV_FILE, get_settings

# Process configuration takes precedence, as it does for the application. This
# permits an isolated rehearsal without accidentally reconnecting to root .env.
load_dotenv(ENV_FILE, override=False)

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def include_name(name, type_, parent_names):
    if type_ == "schema":
        return name in APPLICATION_SCHEMAS or name in (None, "public")
    # Reflection can report public through its default-schema alias (None).
    # Never propose dropping Alembic's own bookkeeping table under either alias.
    if type_ == "table" and name == "alembic_version":
        return False
    return True


def _database_url() -> str:
    return get_settings().database_url.get_secret_value()


def run_migrations_offline() -> None:
    context.configure(
        url=_database_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
        include_schemas=True,
        include_name=include_name,
        version_table_schema="public",
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = create_engine(_database_url(), poolclass=pool.NullPool)
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
            include_schemas=True,
            include_name=include_name,
            version_table_schema="public",
        )
        with context.begin_transaction():
            context.run_migrations()
        connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()

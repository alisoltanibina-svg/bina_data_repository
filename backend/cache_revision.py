"""Shared on-disk revision for explicit dashboard cache invalidation."""

import os
import tempfile
import uuid
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent


def revision_path() -> Path:
    configured = os.environ.get("DATA_CACHE_VERSION_FILE")
    return Path(configured).resolve() if configured else PROJECT_ROOT / "data" / ".cache-version"


def read_revision() -> int:
    try:
        value = revision_path().read_text(encoding="ascii").strip()
    except FileNotFoundError:
        return 0
    if len(value) != 32 or any(char not in "0123456789abcdef" for char in value):
        raise RuntimeError("Invalid data cache revision; run scripts/refresh_data_cache.py again.")
    return int(value, 16)


def refresh_revision() -> str:
    path = revision_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    revision = uuid.uuid4().hex
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="ascii", dir=path.parent,
                                         prefix=".cache-version-", delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(revision + "\n")
        # All workers must be able to read the replacement, including when the
        # deployment command runs under a different account from the service.
        temporary.chmod(0o644)
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return revision

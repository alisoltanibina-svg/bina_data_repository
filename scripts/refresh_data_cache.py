"""Invalidate running dashboard workers' data caches after a committed import."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.cache_revision import refresh_revision


def main() -> None:
    revision = refresh_revision()
    print(f"Data cache refreshed: {revision}")
    print("Workers will reload data on their next request; no restart or frontend build is needed.")
    print("Browsers will use new cache URLs on the next dashboard load or data selection.")


if __name__ == "__main__":
    main()

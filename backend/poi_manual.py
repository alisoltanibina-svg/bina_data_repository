"""Geographic assignment and the venue editorial router."""
from functools import lru_cache
import json
from pathlib import Path
from types import SimpleNamespace
from backend.poi_geo import BoundaryIndex


@lru_cache(maxsize=2)
def province_index(path, modified):
    features = json.loads(Path(path).read_text(encoding='utf-8-sig'))['features']
    return BoundaryIndex([SimpleNamespace(level='province', name=f['properties'].get('name') or
        f['properties'].get('ProvincNam') or f['properties'].get('ADM1_FA') or f['properties'].get('Name'),
        parent_name=None, geometry=f['geometry']) for f in features])


def assign_province(latitude, longitude):
    path = Path(__file__).resolve().parents[1] / 'data' / 'iran.geojson'
    return province_index(str(path), path.stat().st_mtime_ns).assign(latitude, longitude)



def build_router(require_admin, require_user):
    from backend.poi_editorial_routes import build_router as router
    return router(require_admin, require_user)

"""Generate the lightweight country context used behind Explorer's Iran map.

The source is a global Admin-1 dataset. Explorer needs only nearby country
outlines, so this script dissolves state/province boundaries per country,
clips them to the visible region and simplifies the resulting geometries.
"""
from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

from shapely.geometry import box, mapping, shape
from shapely.ops import unary_union

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SOURCE = PROJECT_ROOT / "data" / "world.geojson"
OUTPUT = PROJECT_ROOT / "data" / "world-context.geojson"
# Matches the Explorer SVG view with a small buffer so its edges stay covered.
CONTEXT_BOUNDS = box(18, 14, 77, 51)
SIMPLIFY_TOLERANCE_DEGREES = 0.08


def main() -> None:
    source = json.loads(SOURCE.read_text(encoding="utf-8"))
    grouped: dict[tuple[str, str], list] = defaultdict(list)

    for feature in source.get("features", []):
        properties = feature.get("properties") or {}
        country = str(properties.get("admin") or "").strip()
        if not country or country == "Iran":
            continue
        geometry = feature.get("geometry")
        if not geometry:
            continue
        candidate = shape(geometry)
        if candidate.is_empty or not candidate.intersects(CONTEXT_BOUNDS):
            continue
        grouped[(country, str(properties.get("iso_a2") or ""))].append(candidate)

    features = []
    for (country, iso_a2), geometries in sorted(grouped.items()):
        dissolved = unary_union(geometries).intersection(CONTEXT_BOUNDS)
        simplified = dissolved.simplify(SIMPLIFY_TOLERANCE_DEGREES, preserve_topology=True)
        if simplified.is_empty:
            continue
        features.append({
            "type": "Feature",
            "properties": {"admin": country, "iso_a2": iso_a2},
            "geometry": mapping(simplified),
        })

    payload = {"type": "FeatureCollection", "features": features}
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Wrote {OUTPUT.name}: {len(features)} country outlines, {OUTPUT.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
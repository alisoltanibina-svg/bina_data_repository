"""Build deployable static files with automatic release-version cache busting."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit, urlunsplit


PROJECT_ROOT = Path(__file__).resolve().parent.parent
TOP_LEVEL_FILES = ("index.html", "webmanifest.json")
PUBLIC_DIRS = ("html", "css", "js", "assets")
VERSIONABLE_SUFFIXES = {
    ".css", ".js", ".json", ".webp", ".png", ".jpg", ".jpeg",
    ".gif", ".svg", ".ico", ".woff", ".woff2", ".ttf", ".geojson",
}
HTML_URL_RE = re.compile(
    r"(?P<prefix>\b(?:src|href)\s*=\s*(?P<quote>['\"]))"
    r"(?P<url>.*?)"
    r"(?P=quote)",
    re.IGNORECASE,
)
CSS_URL_RE = re.compile(
    r"url\(\s*(?P<quote>['\"]?)(?P<url>.*?)(?P=quote)\s*\)",
    re.IGNORECASE,
)
VERSION_PLACEHOLDER = "__ASSET_VERSION__"


def _is_mutable_upload(relative: Path) -> bool:
    return relative.as_posix().startswith("assets/images/avatars/")


def public_files(source_root: Path) -> list[Path]:
    files: list[Path] = []
    for name in TOP_LEVEL_FILES:
        path = source_root / name
        if path.is_file():
            files.append(path)

    for directory in PUBLIC_DIRS:
        root = source_root / directory
        if not root.is_dir():
            continue
        for path in root.rglob("*"):
            if path.is_file() and not _is_mutable_upload(path.relative_to(source_root)):
                files.append(path)

    data_root = source_root / "data"
    if data_root.is_dir():
        files.extend(path for path in data_root.rglob("*.geojson") if path.is_file())
    return sorted(set(files), key=lambda path: path.relative_to(source_root).as_posix())


def content_version(source_root: Path) -> str:
    digest = hashlib.sha256()
    for path in public_files(source_root):
        relative = path.relative_to(source_root).as_posix().encode("utf-8")
        digest.update(len(relative).to_bytes(4, "big"))
        digest.update(relative)
        digest.update(path.read_bytes())
    return digest.hexdigest()[:12]


def normalize_version(value: str) -> str:
    candidate = (value or "").strip().lower()
    if re.fullmatch(r"[0-9a-f]{12}", candidate):
        return candidate
    return hashlib.sha256(candidate.encode("utf-8")).hexdigest()[:12]


def version_url(url: str, version: str) -> str:
    value = url.strip()
    lower = value.lower()
    if (
        not value
        or value.startswith(('#', '//'))
        or lower.startswith(("data:", "blob:", "http:", "https:", "mailto:", "tel:", "javascript:"))
    ):
        return url

    parts = urlsplit(value)
    if PurePosixPath(parts.path).suffix.lower() not in VERSIONABLE_SUFFIXES:
        return url

    query_parts = [part for part in parts.query.split("&") if part and not part.startswith("v=")]
    query_parts.append(f"v={version}")
    rewritten = urlunsplit((parts.scheme, parts.netloc, parts.path, "&".join(query_parts), parts.fragment))
    return url.replace(value, rewritten, 1)


def rewrite_html(text: str, version: str) -> str:
    def replace(match: re.Match[str]) -> str:
        return match.group("prefix") + version_url(match.group("url"), version) + match.group("quote")

    return HTML_URL_RE.sub(replace, text)


def rewrite_css(text: str, version: str) -> str:
    def replace(match: re.Match[str]) -> str:
        quote = match.group("quote")
        return f"url({quote}{version_url(match.group('url'), version)}{quote})"

    return CSS_URL_RE.sub(replace, text)


def rewrite_manifest(path: Path, version: str) -> None:
    payload = json.loads(path.read_text(encoding="utf-8"))
    for icon in payload.get("icons", []):
        if isinstance(icon, dict) and isinstance(icon.get("src"), str):
            icon["src"] = version_url(icon["src"], version)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def build(source_root: Path, output: Path, requested_version: str | None = None) -> str:
    source_root = source_root.resolve()
    output = output.resolve()
    if output == source_root or output in source_root.parents:
        raise ValueError("Output directory must not be the project root or one of its parents")
    if source_root in output.parents and output != source_root / "dist":
        raise ValueError("Output inside the project is restricted to the dist directory")

    version_source = requested_version or os.getenv("ASSET_VERSION", "")
    version = normalize_version(version_source) if version_source else content_version(source_root)

    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}-staging-", dir=output.parent))
    backup = output.with_name(f".{output.name}-previous")
    try:
        for source in public_files(source_root):
            relative = source.relative_to(source_root)
            destination = staging / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)

        # User avatars are mutable runtime data and must remain outside immutable build artifacts.
        (staging / "assets" / "images" / "avatars").mkdir(parents=True, exist_ok=True)

        for path in staging.rglob("*.html"):
            path.write_text(rewrite_html(path.read_text(encoding="utf-8"), version), encoding="utf-8")
        for path in staging.rglob("*.css"):
            path.write_text(rewrite_css(path.read_text(encoding="utf-8"), version), encoding="utf-8")

        config_path = staging / "js" / "config.js"
        config_text = config_path.read_text(encoding="utf-8")
        if VERSION_PLACEHOLDER not in config_text:
            raise RuntimeError(f"Missing {VERSION_PLACEHOLDER} in {config_path}")
        config_path.write_text(config_text.replace(VERSION_PLACEHOLDER, version), encoding="utf-8")

        manifest_path = staging / "webmanifest.json"
        if manifest_path.exists():
            rewrite_manifest(manifest_path, version)

        metadata = {
            "asset_version": version,
            "built_at": datetime.now(timezone.utc).isoformat(),
        }
        (staging / "release.json").write_text(
            json.dumps(metadata, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

        # tempfile.mkdtemp() creates the staging root as 0700 on Linux. Static
        # files must be traversable/readable by the Nginx worker after rename.
        staging.chmod(0o755)
        for path in staging.rglob("*"):
            path.chmod(0o755 if path.is_dir() else 0o644)

        if backup.exists():
            shutil.rmtree(backup)
        if output.exists():
            try:
                output.rename(backup)
            except PermissionError:
                # Windows can deny directory renames when security/indexing tools
                # briefly hold handles. The target has already been safety-checked.
                shutil.rmtree(output)
        staging.rename(output)
        if backup.exists():
            shutil.rmtree(backup)
    except Exception:
        if staging.exists():
            shutil.rmtree(staging)
        if backup.exists() and not output.exists():
            backup.rename(output)
        raise
    return version


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=PROJECT_ROOT / "dist")
    parser.add_argument("--version", help="Optional release label; it is normalized to a 12-character hash")
    args = parser.parse_args()
    version = build(PROJECT_ROOT, args.output, args.version)
    print(f"Built {args.output.resolve()} with asset version {version}")


if __name__ == "__main__":
    main()

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
# Bump this when the generated public artifact format changes without a source
# asset changing, so immutable release URLs remain content-accurate.
BUILD_FORMAT_VERSION = b"asset-minify-v2"


def minify_css(text: str) -> str:
    """Conservatively minify CSS without a third-party build dependency.

    CSS strings are copied byte-for-byte so URLs, data URIs, quoted content and
    escaped characters remain intact. Outside strings, comments and formatting
    whitespace are removed only where they cannot change the stylesheet's
    meaning. This deliberately leaves potentially meaningful whitespace (for
    example, within ``calc()``) alone.
    """
    result: list[str] = []
    index = 0
    pending_space = False
    length = len(text)
    compact_after = "{}:;,>~"

    def append(char: str) -> None:
        nonlocal pending_space
        if pending_space:
            previous = result[-1] if result else ""
            if previous and previous not in compact_after and char not in compact_after:
                result.append(" ")
            pending_space = False
        result.append(char)

    while index < length:
        char = text[index]
        next_char = text[index + 1] if index + 1 < length else ""

        if char == "/" and next_char == "*":
            end = text.find("*/", index + 2)
            if end < 0:
                raise ValueError("Unterminated CSS comment")
            # License comments remain available in the deployed artifact.
            if text.startswith("/*!", index):
                append(text[index : end + 2])
            else:
                pending_space = True
            index = end + 2
            continue

        if char in "'\"":
            append(char)
            quote = char
            index += 1
            while index < length:
                char = text[index]
                result.append(char)
                if char == "\\" and index + 1 < length:
                    index += 1
                    result.append(text[index])
                elif char == quote:
                    break
                index += 1
            else:
                raise ValueError("Unterminated CSS string")
            index += 1
            continue

        if char.isspace():
            pending_space = True
        else:
            append(char)
        index += 1

    return "".join(result).strip()


def minify_javascript(text: str) -> str:
    """Minify application JavaScript while preserving its tokens and line breaks.

    This intentionally avoids identifier mangling and other transformations that
    could alter browser-visible behavior. It removes comments, indentation and
    unnecessary inline whitespace; original line breaks are retained to protect
    JavaScript's automatic-semicolon-insertion behavior.
    """
    result: list[str] = []
    index = 0
    length = len(text)
    pending_space = False
    pending_newline = False
    previous_token: str | None = None

    def is_word(char: str) -> bool:
        return char.isalnum() or char in "_$"

    def needs_separator(next_char: str) -> bool:
        if not result or not previous_token:
            return False
        previous_char = result[-1]
        if is_word(previous_char) and is_word(next_char):
            return True
        if previous_char in "+-" and next_char == previous_char:
            return True
        if previous_char == "/" and next_char in "/*":
            return True
        if previous_char == "*" and next_char == "/":
            return True
        # Keep numeric member expressions conservative (for example, `1 .toString()`).
        return previous_char == "." or next_char == "."

    def append_token(value: str, token: str) -> None:
        nonlocal pending_space, pending_newline, previous_token
        if pending_newline:
            if result and result[-1] != "\n":
                result.append("\n")
        elif pending_space and needs_separator(value[0]):
            result.append(" ")
        pending_space = False
        pending_newline = False
        result.append(value)
        previous_token = token

    def note_whitespace(value: str) -> None:
        nonlocal pending_space, pending_newline
        if "\r" in value or "\n" in value:
            pending_newline = True
        else:
            pending_space = True

    def copy_quoted(quote: str) -> tuple[str, int]:
        start = index
        cursor = index + 1
        while cursor < length:
            char = text[cursor]
            if char == "\\" and cursor + 1 < length:
                cursor += 2
                continue
            if char == quote:
                return text[start : cursor + 1], cursor + 1
            cursor += 1
        raise ValueError("Unterminated JavaScript string")

    def copy_regex() -> tuple[str, int]:
        start = index
        cursor = index + 1
        in_character_class = False
        while cursor < length:
            char = text[cursor]
            if char == "\\" and cursor + 1 < length:
                cursor += 2
                continue
            if char == "[":
                in_character_class = True
            elif char == "]":
                in_character_class = False
            elif char == "/" and not in_character_class:
                cursor += 1
                while cursor < length and text[cursor].isalpha():
                    cursor += 1
                return text[start:cursor], cursor
            cursor += 1
        raise ValueError("Unterminated JavaScript regular expression")

    def can_start_regex() -> bool:
        return previous_token is None or previous_token in {
            "(", "[", "{", ",", ";", ":", "=", "==", "===", "!=", "!==",
            "!", "&&", "||", "??", "?", "+", "-", "*", "%", "&", "|", "^",
            "~", "<<", ">>", ">>>", "<", ">", "<=", ">=", "=>", "return",
            "throw", "case", "delete", "void", "typeof", "new", "in", "of", "yield",
            "await", "else", "do", "instanceof",
        }

    while index < length:
        char = text[index]
        next_char = text[index + 1] if index + 1 < length else ""

        if char.isspace():
            start = index
            index += 1
            while index < length and text[index].isspace():
                index += 1
            note_whitespace(text[start:index])
            continue

        if char == "/" and next_char == "/":
            index += 2
            while index < length and text[index] not in "\r\n":
                index += 1
            continue

        if char == "/" and next_char == "*":
            end = text.find("*/", index + 2)
            if end < 0:
                raise ValueError("Unterminated JavaScript comment")
            note_whitespace(text[index : end + 2])
            index = end + 2
            continue

        if char in "'\"`":
            value, index = copy_quoted(char)
            append_token(value, "string")
            continue

        if char == "/" and can_start_regex():
            value, index = copy_regex()
            append_token(value, "regex")
            continue

        if char.isalpha() or char in "_$":
            start = index
            index += 1
            while index < length and (text[index].isalnum() or text[index] in "_$"):
                index += 1
            value = text[start:index]
            append_token(value, value)
            continue

        if char.isdigit():
            start = index
            index += 1
            while index < length and (text[index].isalnum() or text[index] in "._"):
                index += 1
            append_token(text[start:index], "number")
            continue

        operator = text[index : index + 3]
        if operator not in {"===", "!==", ">>>", "**=", "&&=", "||=", "??=", "..."}:
            operator = text[index : index + 2]
            if operator not in {"=>", "==", "!=", "<=", ">=", "++", "--", "&&", "||", "??", "?.", "**", "<<", ">>", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^="}:
                operator = char
        append_token(operator, operator)
        index += len(operator)

    return "".join(result).strip() + "\n"

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
    digest.update(BUILD_FORMAT_VERSION)
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
            css_text = rewrite_css(path.read_text(encoding="utf-8"), version)
            path.write_text(minify_css(css_text), encoding="utf-8")

        config_path = staging / "js" / "config.js"
        config_text = config_path.read_text(encoding="utf-8")
        if VERSION_PLACEHOLDER not in config_text:
            raise RuntimeError(f"Missing {VERSION_PLACEHOLDER} in {config_path}")
        config_path.write_text(config_text.replace(VERSION_PLACEHOLDER, version), encoding="utf-8")

        for path in (staging / "js").rglob("*.js"):
            path.write_text(minify_javascript(path.read_text(encoding="utf-8")), encoding="utf-8")

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

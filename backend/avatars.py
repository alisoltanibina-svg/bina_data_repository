"""Store user avatars under assets/images/avatars as square WebP files."""

from __future__ import annotations

import io
import re
import secrets

from PIL import Image, ImageOps, UnidentifiedImageError

from backend.settings import PROJECT_ROOT


class AvatarError(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message

AVATAR_DIR = PROJECT_ROOT / "assets" / "images" / "avatars"
AVATAR_REL_PREFIX = "assets/images/avatars"
MAX_BYTES = 5 * 1024 * 1024
OUTPUT_SIZE = 512
_ALLOWED_FORMATS = frozenset({"JPEG", "PNG", "WEBP"})
_FILE_NAME = re.compile(r"^user-\d+-[0-9a-f]{8}\.webp$")


def public_url(path: str | None) -> str:
    relative = (path or "").replace("\\", "/").lstrip("/")
    if not relative:
        return ""
    return "/" + relative


def is_managed_path(path: str | None) -> bool:
    relative = (path or "").replace("\\", "/").lstrip("/")
    if not relative.startswith(AVATAR_REL_PREFIX + "/"):
        return False
    name = relative.rsplit("/", 1)[-1]
    return bool(_FILE_NAME.match(name))


def _managed_file(path: str | None) -> Path | None:
    if not is_managed_path(path):
        return None
    name = (path or "").replace("\\", "/").rsplit("/", 1)[-1]
    return AVATAR_DIR / name


def delete_avatar_file(path: str | None) -> None:
    file_path = _managed_file(path)
    if file_path is None:
        return
    try:
        file_path.unlink(missing_ok=True)
    except OSError:
        pass


def save_user_avatar(user_id: int, data: bytes) -> str:
    if not data:
        raise AvatarError("عکس را انتخاب کنید.")
    if len(data) > MAX_BYTES:
        raise AvatarError("حجم عکس باید حداکثر ۵ مگابایت باشد.")
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
    except (UnidentifiedImageError, OSError, ValueError):
        raise AvatarError("فایل تصویر معتبر نیست.") from None
    fmt = (image.format or "").upper()
    if fmt not in _ALLOWED_FORMATS:
        raise AvatarError("فقط فایل JPG، PNG یا WebP پذیرفته می‌شود.")
    image = ImageOps.exif_transpose(image)
    if image.mode not in ("RGB", "RGBA"):
        image = image.convert("RGBA") if "A" in image.getbands() else image.convert("RGB")
    width, height = image.size
    if width < 32 or height < 32:
        raise AvatarError("ابعاد عکس خیلی کوچک است.")
    side = min(width, height)
    left = (width - side) // 2
    top = (height - side) // 2
    image = image.crop((left, top, left + side, top + side))
    image = image.resize((OUTPUT_SIZE, OUTPUT_SIZE), Image.Resampling.LANCZOS)
    if image.mode != "RGB":
        background = Image.new("RGB", image.size, (255, 255, 255))
        if image.mode == "RGBA":
            background.paste(image, mask=image.split()[-1])
            image = background
        else:
            image = image.convert("RGB")
    AVATAR_DIR.mkdir(parents=True, exist_ok=True)
    name = f"user-{int(user_id)}-{secrets.token_hex(4)}.webp"
    dest = AVATAR_DIR / name
    image.save(dest, format="WEBP", quality=88, method=6)
    return f"{AVATAR_REL_PREFIX}/{name}"

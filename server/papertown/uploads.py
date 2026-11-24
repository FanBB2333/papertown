"""Files sent along with a message. A terminal CLI takes text only, so a file is kept where the agent can read it and
the message names it by path: the agents' CLIs open images and documents from a path with their own tools."""
from __future__ import annotations

import re
import secrets
import time
from pathlib import Path

MAX_BYTES = 25 * 1024 * 1024
MAX_FILES = 10
IMAGES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".bmp", ".tif", ".tiff"}
ID = re.compile(r"\d{8}-\d{6}-[0-9a-f]{6}-[^/\\\x00]{1,96}")


class UploadError(ValueError):
    status = 400


def clean(name: str) -> str:
    """A file name that is safe to keep: its last path part, without control characters, spaces or a leading dot."""
    base = re.split(r"[/\\]", name or "")[-1]
    base = re.sub(r"[\x00-\x1f\x7f]", "", base).strip().lstrip(".")
    base = re.sub(r'[\s<>:"|?*]+', "_", base)
    stem, dot, ext = base.rpartition(".")
    if dot and stem and 0 < len(ext) <= 10:
        return stem[:80] + "." + ext
    return base[:90] or "file"


def kind(path: Path | str) -> str:
    return "image" if Path(path).suffix.lower() in IMAGES else "file"


def save(folder: Path, name: str, data: bytes) -> dict:
    if not data:
        raise UploadError("文件是空的")
    if len(data) > MAX_BYTES:
        raise UploadError(f"文件超过 {MAX_BYTES // 1024 // 1024} MB")
    folder.mkdir(parents=True, exist_ok=True)
    name = clean(name)
    id = f"{time.strftime('%Y%m%d-%H%M%S')}-{secrets.token_hex(3)}-{name}"
    path = folder / id
    path.write_bytes(data)
    return {"id": id, "name": name, "path": str(path), "size": len(data), "kind": kind(path)}


def resolve(folder: Path, ids: list[str]) -> list[Path]:
    if len(ids) > MAX_FILES:
        raise UploadError(f"一条消息最多带 {MAX_FILES} 个附件")
    out = []
    for id in ids:
        path = folder / id
        if not ID.fullmatch(id) or not path.is_file():
            raise UploadError("附件已失效，请重新添加")
        out.append(path)
    return out


def mention(text: str, paths: list[Path]) -> str:
    """The message with its files named after it, one path a line."""
    if not paths:
        return text
    note = "附件：\n" + "\n".join(f"- {'图片' if kind(p) == 'image' else '文件'} {p}" for p in paths)
    return f"{text.rstrip()}\n\n{note}" if text.strip() else note

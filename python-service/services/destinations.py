"""
Destination providers — abstract where downloads are delivered.

Each provider knows how to save a file to its target.
Adding a new destination = creating a new provider class and registering it.

Security: user-supplied paths are validated against traversal — only
relative sub-paths INSIDE the controlled storage root are allowed.
"""

from __future__ import annotations

import logging
import os
import re
from abc import ABC, abstractmethod
from pathlib import Path

logger = logging.getLogger("app")


def storage_root() -> Path:
    return Path(os.getenv(
        "DOWNLOAD_STORAGE_ROOT",
        str(Path(__file__).resolve().parent.parent / "data" / "exports"),
    ))


def safe_relative_subdir(raw: str | None) -> str | None:
    """Validate a user-supplied folder fragment.

    Returns the cleaned relative path (no leading/trailing separators),
    or None when invalid. Rejects absolute paths, drive letters and any
    '..' / '.' traversal segments.
    """
    if raw is None:
        return ""
    text = str(raw).strip().replace("\\", "/").strip("/")
    if not text:
        return ""
    if re.match(r"^[A-Za-z]:", text) or text.startswith("//") or text.startswith("~"):
        return None
    parts = [p for p in text.split("/") if p not in ("", ".")]
    if not parts or any(p == ".." for p in parts):
        return None
    cleaned = "/".join(re.sub(r'[<>:"|?*\x00-\x1f]', "_", p) for p in parts)
    return cleaned


class DestinationProvider(ABC):
    id: str = ""
    name: str = ""
    available: bool = True
    requires_config: bool = False

    @abstractmethod
    def deliver(
        self,
        data: bytes,
        filename: str,
        config: dict | None = None,
    ) -> dict:
        """Save file, return metadata dict."""
        ...

    def validate_config(self, config: dict | None) -> str | None:
        """Return error message if config invalid, else None."""
        return None


class ServerDestination(DestinationProvider):
    """Keep the generated artifact on the server export store.

    The artifact is written there by the export engine itself; this
    destination simply marks 'ready to download' via History/Downloads.
    This is the correct mechanism in a browser environment — the browser
    saves the file wherever the user's download folder points.
    """

    id = "server"
    name = "Downloads Center (browser)"
    available = True

    def deliver(self, data: bytes, filename: str, config: dict | None = None) -> dict:
        return {"filename": filename, "sizeBytes": len(data), "location": "server"}

    def validate_config(self, config: dict | None) -> str | None:
        return None


class LocalDestination(DestinationProvider):
    """Additionally copy to the server's local storage folder."""

    id = "local"
    name = "Server Folder"
    available = True

    def deliver(self, data: bytes, filename: str, config: dict | None = None) -> dict:
        subdir = safe_relative_subdir((config or {}).get("path") or "")
        base = storage_root() / subdir if subdir else storage_root()
        base.mkdir(parents=True, exist_ok=True)
        path = base / Path(filename).name
        path.write_bytes(data)
        stat = path.stat()
        logger.info("Delivered %s to %s", filename, path)
        return {"path": str(path), "sizeBytes": stat.st_size, "filename": filename}

    def validate_config(self, config: dict | None) -> str | None:
        raw = (config or {}).get("path")
        if raw and safe_relative_subdir(str(raw)) is None:
            return "Folder must be a relative path inside the server storage area"
        return None


class VMDestination(LocalDestination):
    """Alias kept for backwards compatibility with existing schedules."""

    id = "vm"
    name = "VM Storage"
    available = True
    requires_config = False


class GoogleDriveDestination(DestinationProvider):
    """Placeholder — requires Google API OAuth2 credentials."""

    id = "google_drive"
    name = "Google Drive"
    available = False
    requires_config = True

    def deliver(self, data: bytes, filename: str, config: dict | None = None) -> dict:
        raise NotImplementedError("Google Drive integration not configured")

    def validate_config(self, config: dict | None) -> str | None:
        return "Google Drive requires OAuth2 credentials (not configured)"


class TelegramDestination(DestinationProvider):
    """Placeholder — requires Telegram Bot API token + chat ID."""

    id = "telegram"
    name = "Telegram"
    available = False
    requires_config = True

    def deliver(self, data: bytes, filename: str, config: dict | None = None) -> dict:
        raise NotImplementedError("Telegram integration not configured")

    def validate_config(self, config: dict | None) -> str | None:
        return "Telegram requires Bot API token (not configured)"


# ── Registry ──────────────────────────────────────────────

REGISTRY: dict[str, DestinationProvider] = {}


def _register(dest: DestinationProvider):
    REGISTRY[dest.id] = dest


_register(ServerDestination())
_register(LocalDestination())
_register(VMDestination())
_register(GoogleDriveDestination())
_register(TelegramDestination())


def get_destination(dest_id: str) -> DestinationProvider | None:
    return REGISTRY.get(dest_id)


def available_destinations() -> list[dict]:
    return [
        {
            "id": d.id,
            "name": d.name,
            "available": d.available,
            "requiresConfig": d.requires_config,
        }
        for d in REGISTRY.values()
    ]

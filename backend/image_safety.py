"""Memory-safe upload measurement and image dimension guards."""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path
from typing import Any


UPLOAD_READ_CHUNK_BYTES = 1024 * 1024


class UploadTooLargeError(ValueError):
    """Raised when an upload exceeds the configured byte limit."""


class ImageResolutionTooLargeError(ValueError):
    """Raised when decoded dimensions exceed configured safety limits."""


async def measure_upload_size(
    upload: Any,
    max_bytes: int,
    *,
    chunk_size: int = UPLOAD_READ_CHUNK_BYTES,
) -> int:
    """Count an UploadFile in bounded chunks without retaining its bytes."""
    total = 0
    try:
        while True:
            chunk = await upload.read(chunk_size)
            if not chunk:
                return total
            total += len(chunk)
            if total > max_bytes:
                raise UploadTooLargeError
    finally:
        await upload.seek(0)


async def sha256_upload(
    upload: Any,
    *,
    chunk_size: int = UPLOAD_READ_CHUNK_BYTES,
) -> str:
    """Hash an UploadFile in bounded chunks and restore its file position."""
    digest = hashlib.sha256()
    try:
        await upload.seek(0)
        while True:
            chunk = await upload.read(chunk_size)
            if not chunk:
                return digest.hexdigest()
            digest.update(chunk)
    finally:
        await upload.seek(0)


def validate_image_dimensions(
    width: int,
    height: int,
    *,
    max_pixels: int,
    max_width: int,
    max_height: int,
) -> int:
    """Validate dimensions before full pixel decoding and return pixel count."""
    if width <= 0 or height <= 0:
        raise ValueError("Dimensi gambar tidak valid.")
    pixel_count = width * height
    if (
        pixel_count > max_pixels
        or width > max_width
        or height > max_height
    ):
        raise ImageResolutionTooLargeError
    return pixel_count


def process_rss_bytes() -> int | None:
    """Read Linux VmRSS without adding a psutil dependency."""
    status_path = Path("/proc/self/status")
    try:
        for line in status_path.read_text(encoding="utf-8").splitlines():
            if line.startswith("VmRSS:"):
                parts = line.split()
                if len(parts) >= 2:
                    return int(parts[1]) * 1024
    except (OSError, UnicodeError, ValueError):
        return None
    return None


def process_peak_rss_bytes() -> int | None:
    """Read the process high-water RSS using the standard library."""
    try:
        import resource

        peak_rss = int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
    except (ImportError, OSError, ValueError):
        return None

    # macOS reports bytes; Linux (including Railway containers) reports KiB.
    return peak_rss if sys.platform == "darwin" else peak_rss * 1024


def log_rss_checkpoint(logger: Any, checkpoint: str) -> int | None:
    """Log current and peak RSS without image, user, or location metadata."""
    rss_bytes = process_rss_bytes()
    peak_rss_bytes = process_peak_rss_bytes()
    rss_mb = rss_bytes / (1024 * 1024) if rss_bytes is not None else None
    peak_rss_mb = (
        peak_rss_bytes / (1024 * 1024)
        if peak_rss_bytes is not None
        else None
    )
    logger.info(
        "prediction_memory checkpoint=%s rss_mb=%s peak_rss_mb=%s",
        checkpoint,
        f"{rss_mb:.2f}" if rss_mb is not None else "unavailable",
        (
            f"{peak_rss_mb:.2f}"
            if peak_rss_mb is not None
            else "unavailable"
        ),
    )
    return rss_bytes

# Rewritten from faster-whisper-webui src/source.py (Apache 2.0, (c) aadnk).
# Changes: dropped YouTube/URL/microphone ingest, Gradio file-name truncation,
# AudioSourceCollection (no longer needed for single-file CLI path), and the
# max-duration gate.  Local file paths only.  See /NOTICES.md for details.

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import ffmpeg


@dataclass
class AudioSource:
    """A single local audio/video file ready to be transcribed."""

    path: Path
    display_name: Optional[str] = None
    _duration_seconds: Optional[float] = None

    def __post_init__(self) -> None:
        self.path = Path(self.path)
        if self.display_name is None:
            self.display_name = self.path.name

    @property
    def duration_seconds(self) -> float:
        """Return the media duration in seconds, probing via ffmpeg on first access."""
        if self._duration_seconds is None:
            probe = ffmpeg.probe(str(self.path))
            self._duration_seconds = float(probe["format"]["duration"])
        return self._duration_seconds

    def exists(self) -> bool:
        return self.path.is_file()

    def __str__(self) -> str:
        return str(self.path)

# New module (no upstream counterpart).
# Fetches and caches the two ONNX models sherpa-onnx needs for speaker
# diarization.  They come from k2-fsa/sherpa-onnx's GitHub Releases rather
# than Hugging Face, so none of manager.py's machinery applies: no repo id,
# no snapshot layout, no `config.json` + `tokenizer.json` + weights triple,
# no huggingface_hub.  Two fixed URLs with published sha256s, one of them
# inside a .tar.bz2.
#
# They live under ``<models_dir>/diarization/`` -- a sibling of
# ``torch_hub/``, where Silero VAD lands -- so they sit inside the managed
# models root and are already counted by the Models tab's disk-usage
# figure.  See docs/specs/speaker-diarization.md section 4.3.

from __future__ import annotations

import hashlib
import logging
import os
import tarfile
import time
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Callable, Optional, Sequence
from urllib.request import urlopen

# Reaching for a private helper across modules is an established pattern
# here (cli.py already imports _resolve_source_files_dir and
# _has_required_files from manager); _file_present_and_complete is the
# repo's only file-integrity primitive and worth reusing rather than
# reimplementing.
from .manager import DownloadProgress, _file_present_and_complete

_log = logging.getLogger(__name__)

DIARIZATION_SUBDIR = "diarization"

_CHUNK_BYTES = 1024 * 1024
_TIMEOUT_SECONDS = 60
_EMIT_EVERY_SEC = 0.2

# Stable `reason` strings.  bridge/run_cli.py turns these into error codes
# the Electron side recognises; its catch-all reports
# ``type(err).__name__``, which no mapper matches, so every failure mode
# needs an explicit `except` there.
REASON_DOWNLOAD_FAILED = "diarization_model_download_failed"
REASON_CHECKSUM_MISMATCH = "diarization_model_checksum_mismatch"
REASON_EXTRACT_FAILED = "diarization_model_extract_failed"


@dataclass(frozen=True)
class DiarizationArtifact:
    """One downloadable model file.

    ``member_name`` is the path inside the tarball for an archived
    artifact, or ``None`` when the URL is the model file itself.  For a
    bare file the archive and model digests are necessarily the same.
    """

    key: str
    url: str
    archive_sha256: str
    archive_bytes: int
    member_name: Optional[str]
    model_sha256: str
    model_bytes: int
    local_relpath: str

    @property
    def archive_name(self) -> str:
        return self.url.rsplit("/", 1)[-1]


_RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download"

# pyannote segmentation-3.0, MIT, (c) CNRS.
#
# Deliberately the fp32 `model.onnx`, NOT the `model.int8.onnx` sitting
# next to it in the same archive: the quantised one over-segments, finding
# 5 speakers in the 4-speaker reference sample.
SEGMENTATION = DiarizationArtifact(
    key="segmentation",
    url=f"{_RELEASES}/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2",
    archive_sha256="24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488",
    archive_bytes=6_958_444,
    member_name="sherpa-onnx-pyannote-segmentation-3-0/model.onnx",
    model_sha256="220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079",
    model_bytes=5_992_913,
    local_relpath="sherpa-onnx-pyannote-segmentation-3-0/model.onnx",
)

# 3D-Speaker CAM++ (Chinese/English).  Correctly identifies 4 speakers on
# the reference sample with automatic speaker counting; the ERes2Net
# Chinese-only model needs an explicit count to get there.
#
# The `recongition` misspelling in the release tag is upstream's own --
# do not "fix" it, the URL 404s without it.
EMBEDDING = DiarizationArtifact(
    key="embedding",
    url=(
        f"{_RELEASES}/speaker-recongition-models/"
        "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx"
    ),
    archive_sha256="aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2",
    archive_bytes=28_281_164,
    member_name=None,
    model_sha256="aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2",
    model_bytes=28_281_164,
    local_relpath="3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
)

ARTIFACTS: tuple[DiarizationArtifact, ...] = (SEGMENTATION, EMBEDDING)

# ~33.6 MiB.  Surfaced in the first-run stage message so the user knows
# why the run pauses.
TOTAL_DOWNLOAD_BYTES = sum(artifact.archive_bytes for artifact in ARTIFACTS)


class DiarizationModelError(RuntimeError):
    """The diarization models could not be made available.

    The message embeds the download URLs and the target directory, so the
    user can fetch them by hand even if the localized error copy never
    reaches the renderer.
    """

    def __init__(
        self,
        message: str,
        *,
        reason: str,
        urls: Sequence[str],
        target_dir: Path,
    ) -> None:
        self.reason = reason
        self.urls = list(urls)
        self.target_dir = Path(target_dir)
        listing = "\n".join(f"  {url}" for url in self.urls)
        super().__init__(
            f"{message}\n"
            f"To continue without network access, download manually into "
            f"{self.target_dir}:\n{listing}"
        )


# --- paths and cache state ----------------------------------------------


def diarization_dir(models_dir: Path) -> Path:
    return Path(models_dir) / DIARIZATION_SUBDIR


def artifact_path(models_dir: Path, artifact: DiarizationArtifact) -> Path:
    return diarization_dir(models_dir) / artifact.local_relpath


def is_artifact_cached(models_dir: Path, artifact: DiarizationArtifact) -> bool:
    """Is this artifact already on disk and the right size?

    Size plus ``_file_present_and_complete`` rather than a full sha256:
    re-hashing 34 MB on every job costs 80-150 ms and buys nothing, because
    the realistic failure is a truncated write, which the size catches.
    The digests are verified once, at download time.
    """
    path = artifact_path(models_dir, artifact)
    if not _file_present_and_complete(path):
        return False
    try:
        return path.stat().st_size == artifact.model_bytes
    except OSError:
        return False


def is_diarization_cached(models_dir: Path) -> bool:
    return all(is_artifact_cached(models_dir, artifact) for artifact in ARTIFACTS)


def ensure_diarization_models(
    models_dir: Path,
    *,
    progress: Optional[DownloadProgress] = None,
) -> tuple[Path, Path]:
    """Make both models available, downloading only what is missing.

    Returns ``(segmentation_path, embedding_path)``.  Raises
    :class:`DiarizationModelError` on any failure, with a ``reason`` the
    Electron side can map to an error code.
    """
    target_dir = diarization_dir(models_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    _sweep_partials(target_dir)

    def emit(event_type: str, payload: dict) -> None:
        if progress is None:
            return
        try:
            progress(event_type, payload)
        except Exception:
            # A broken observer must never kill a download; same contract
            # as ModelManager.download's _emit.
            pass

    pending = [a for a in ARTIFACTS if not is_artifact_cached(models_dir, a)]
    state = _ProgressState(emit, total_bytes=sum(a.archive_bytes for a in pending))

    for artifact in pending:
        _fetch(artifact, target_dir, emit=emit, state=state)

    emit("stage", {"stage": "verifying"})
    for artifact in ARTIFACTS:
        if not is_artifact_cached(models_dir, artifact):
            path = artifact_path(models_dir, artifact)
            raise DiarizationModelError(
                f"the {artifact.key} diarization model is missing or the wrong "
                f"size after setup: {path}",
                reason=REASON_DOWNLOAD_FAILED,
                urls=[artifact.url],
                target_dir=target_dir,
            )

    state.finish()
    if pending:
        _log.info("diarization models ready in %s", target_dir)
    return (
        artifact_path(models_dir, SEGMENTATION),
        artifact_path(models_dir, EMBEDDING),
    )


# --- fetching -----------------------------------------------------------


def _fetch(
    artifact: DiarizationArtifact,
    target_dir: Path,
    *,
    emit: Callable[[str, dict], None],
    state: "_ProgressState",
) -> None:
    final_path = target_dir / artifact.local_relpath
    final_path.parent.mkdir(parents=True, exist_ok=True)

    emit("stage", {"stage": "downloading", "artifact": artifact.key})

    if artifact.member_name is None:
        _download(
            artifact.url,
            final_path,
            expected_sha256=artifact.model_sha256,
            artifact=artifact,
            state=state,
        )
        return

    archive = target_dir / artifact.archive_name
    _download(
        artifact.url,
        archive,
        expected_sha256=artifact.archive_sha256,
        artifact=artifact,
        state=state,
    )
    try:
        emit("stage", {"stage": "extracting", "artifact": artifact.key})
        _extract_member(archive, artifact, final_path)
    finally:
        # Only the .onnx is needed from here on; drop the ~7 MB tarball
        # whether or not extraction succeeded.
        emit("stage", {"stage": "cleanup", "artifact": artifact.key})
        _unlink_quietly(archive)


def _download(
    url: str,
    dest: Path,
    *,
    expected_sha256: str,
    artifact: DiarizationArtifact,
    state: "_ProgressState",
) -> None:
    """Stream ``url`` to ``dest``, verifying sha256 before publishing it.

    Writes to ``<dest>.part-<pid>`` and then ``os.replace()``s it into
    place, which is atomic on POSIX and on NTFS.  The pid keeps two
    concurrent runs from fighting over the same temp name.
    """
    part = dest.with_name(f"{dest.name}.part-{os.getpid()}")
    digest = hashlib.sha256()

    try:
        with urlopen(url, timeout=_TIMEOUT_SECONDS) as response:
            with open(part, "wb") as handle:
                while True:
                    chunk = response.read(_CHUNK_BYTES)
                    if not chunk:
                        break
                    handle.write(chunk)
                    digest.update(chunk)
                    state.advance(len(chunk))
    except BaseException as err:
        _unlink_quietly(part)
        raise DiarizationModelError(
            f"could not download the {artifact.key} diarization model "
            f"({type(err).__name__}: {err})",
            reason=REASON_DOWNLOAD_FAILED,
            urls=[artifact.url],
            target_dir=dest.parent,
        ) from err

    actual = digest.hexdigest()
    if actual != expected_sha256:
        _unlink_quietly(part)
        raise DiarizationModelError(
            f"the downloaded {artifact.key} diarization model is corrupt "
            f"(sha256 {actual}, expected {expected_sha256}). Retry, and check "
            f"any proxy or antivirus that might be rewriting downloads.",
            reason=REASON_CHECKSUM_MISMATCH,
            urls=[artifact.url],
            target_dir=dest.parent,
        )

    os.replace(part, dest)


def _extract_member(
    archive: Path,
    artifact: DiarizationArtifact,
    dest: Path,
) -> None:
    part = dest.with_name(f"{dest.name}.part-{os.getpid()}")
    digest = hashlib.sha256()

    try:
        with tarfile.open(archive, "r:bz2") as tar:
            member = _safe_member(tar, artifact, archive)
            source = tar.extractfile(member)
            if source is None:
                raise DiarizationModelError(
                    f"{artifact.member_name!r} in {archive.name} is not a readable file",
                    reason=REASON_EXTRACT_FAILED,
                    urls=[artifact.url],
                    target_dir=dest.parent,
                )
            with open(part, "wb") as handle:
                while True:
                    chunk = source.read(_CHUNK_BYTES)
                    if not chunk:
                        break
                    handle.write(chunk)
                    digest.update(chunk)
    except DiarizationModelError:
        _unlink_quietly(part)
        raise
    except BaseException as err:
        _unlink_quietly(part)
        raise DiarizationModelError(
            f"could not extract {artifact.member_name!r} from {archive.name} "
            f"({type(err).__name__}: {err})",
            reason=REASON_EXTRACT_FAILED,
            urls=[artifact.url],
            target_dir=dest.parent,
        ) from err

    actual = digest.hexdigest()
    if actual != artifact.model_sha256:
        _unlink_quietly(part)
        raise DiarizationModelError(
            f"the extracted {artifact.key} diarization model is corrupt "
            f"(sha256 {actual}, expected {artifact.model_sha256})",
            reason=REASON_CHECKSUM_MISMATCH,
            urls=[artifact.url],
            target_dir=dest.parent,
        )

    os.replace(part, dest)


def _safe_member(
    tar: tarfile.TarFile,
    artifact: DiarizationArtifact,
    archive: Path,
) -> tarfile.TarInfo:
    """Find ``artifact.member_name`` in ``tar``, rejecting anything unsafe.

    Python 3.12's ``extractall(filter="data")`` would cover this, but the
    app still supports 3.10/3.11.  Resolving one known name instead of
    extracting the tree is both simpler and inherently safe: a member
    called ``../evil.onnx`` can never match a name we hardcoded.  Member
    names are POSIX paths regardless of host OS, hence ``PurePosixPath``
    rather than ``os.path`` -- joining them with backslashes breaks the
    Windows path.
    """
    wanted = PurePosixPath(str(artifact.member_name))
    if wanted.is_absolute() or ".." in wanted.parts:
        raise DiarizationModelError(
            f"refusing to extract unsafe member name {artifact.member_name!r}",
            reason=REASON_EXTRACT_FAILED,
            urls=[artifact.url],
            target_dir=archive.parent,
        )

    for member in tar.getmembers():
        if PurePosixPath(member.name) != wanted:
            continue
        if not member.isfile():
            raise DiarizationModelError(
                f"{artifact.member_name!r} in {archive.name} is not a regular file",
                reason=REASON_EXTRACT_FAILED,
                urls=[artifact.url],
                target_dir=archive.parent,
            )
        return member

    raise DiarizationModelError(
        f"{archive.name} does not contain {artifact.member_name!r}",
        reason=REASON_EXTRACT_FAILED,
        urls=[artifact.url],
        target_dir=archive.parent,
    )


def _sweep_partials(target_dir: Path) -> None:
    """Delete ``*.part-*`` leftovers from a previous crashed run."""
    try:
        candidates = list(target_dir.rglob("*.part-*"))
    except OSError:
        return
    for stale in candidates:
        _log.info("removing stale partial download %s", stale)
        _unlink_quietly(stale)


def _unlink_quietly(path: Path) -> None:
    try:
        path.unlink()
    except OSError:
        pass


class _ProgressState:
    """Aggregate byte progress across both artifacts, throttled.

    Emits the same ``("progress", {downloaded_bytes, total_bytes,
    speed_bytes_per_sec, eta_seconds})`` shape as
    ``ModelManager.download``, so the existing translator in
    cli.py::_cmd_download_model could be pointed at this verbatim.
    ``total_bytes`` counts only what actually needs downloading, so a
    partial cache does not leave the bar stuck at 80%.
    """

    def __init__(
        self,
        emit: Callable[[str, dict], None],
        *,
        total_bytes: int,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._emit = emit
        self._total = int(total_bytes)
        self._clock = clock
        self._downloaded = 0
        self._started = clock()
        self._last_emit: Optional[float] = None
        self._publish()

    def advance(self, count: int) -> None:
        self._downloaded += int(count)
        if self._last_emit is not None and self._clock() - self._last_emit < _EMIT_EVERY_SEC:
            return
        self._publish()

    def finish(self) -> None:
        self._downloaded = max(self._downloaded, self._total)
        self._publish()

    def _publish(self) -> None:
        now = self._clock()
        elapsed = max(1e-6, now - self._started)
        speed = self._downloaded / elapsed
        remaining = max(0, self._total - self._downloaded)
        self._last_emit = now
        self._emit(
            "progress",
            {
                "downloaded_bytes": self._downloaded,
                "total_bytes": self._total,
                "speed_bytes_per_sec": speed,
                "eta_seconds": remaining / speed if speed > 0 else 0.0,
            },
        )

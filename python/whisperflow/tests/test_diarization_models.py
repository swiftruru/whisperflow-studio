"""Unit tests for models/diarization_models.py.

The network is mocked by patching the module's ``urlopen`` attribute, and
the tarballs are built in-process with ``tarfile`` -- stdlib only, so this
runs on CI (which installs just pytest, ffmpeg-python and numpy).  The fake
artifacts carry digests computed from their own payloads, so they stay
self-consistent no matter what the fixtures contain.
"""

from __future__ import annotations

import hashlib
import io
import tarfile
from pathlib import Path
from urllib.error import URLError

import pytest

from whisperflow.models import diarization_models as dm


# --- fixtures ------------------------------------------------------------


class _FakeResponse:
    """Minimal stand-in for urlopen's return value."""

    def __init__(self, payload: bytes, *, fail_after: int | None = None) -> None:
        self._payload = payload
        self._offset = 0
        self._fail_after = fail_after

    def read(self, size: int = -1) -> bytes:
        if self._fail_after is not None and self._offset >= self._fail_after:
            raise OSError("connection reset by peer")
        chunk = self._payload[self._offset : self._offset + size]
        self._offset += len(chunk)
        return chunk

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *exc_info) -> bool:
        return False


def _tar_bz2(members: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:bz2") as tar:
        for name, payload in members.items():
            info = tarfile.TarInfo(name)
            info.size = len(payload)
            tar.addfile(info, io.BytesIO(payload))
    return buffer.getvalue()


def _artifact(
    *,
    key: str,
    url: str,
    archive: bytes,
    member_name: str | None,
    model_payload: bytes,
    local_relpath: str,
    archive_sha256: str | None = None,
) -> dm.DiarizationArtifact:
    return dm.DiarizationArtifact(
        key=key,
        url=url,
        archive_sha256=archive_sha256 or hashlib.sha256(archive).hexdigest(),
        archive_bytes=len(archive),
        member_name=member_name,
        model_sha256=hashlib.sha256(model_payload).hexdigest(),
        model_bytes=len(model_payload),
        local_relpath=local_relpath,
    )


_SEG_URL = "https://example.invalid/seg.tar.bz2"
_EMB_URL = "https://example.invalid/emb.onnx"
_SEG_MEMBER = "pkg/model.onnx"
_SEG_PAYLOAD = b"fake-segmentation-onnx-bytes"
_EMB_PAYLOAD = b"fake-campplus-embedding-onnx-bytes"


def _install_fakes(
    monkeypatch,
    *,
    tar_members: dict[str, bytes] | None = None,
    seg_member_name: str | None = _SEG_MEMBER,
    bad_archive_sha: bool = False,
    fail_after: int | None = None,
    responses: dict[str, object] | None = None,
) -> list[str]:
    """Swap in two small fake artifacts and a fake urlopen.

    Returns the list that records every requested URL.
    """
    members = tar_members if tar_members is not None else {_SEG_MEMBER: _SEG_PAYLOAD}
    archive = _tar_bz2(members)

    segmentation = _artifact(
        key="segmentation",
        url=_SEG_URL,
        archive=archive,
        member_name=seg_member_name,
        model_payload=_SEG_PAYLOAD,
        local_relpath=_SEG_MEMBER,
        archive_sha256="0" * 64 if bad_archive_sha else None,
    )
    embedding = _artifact(
        key="embedding",
        url=_EMB_URL,
        archive=_EMB_PAYLOAD,
        member_name=None,
        model_payload=_EMB_PAYLOAD,
        local_relpath="emb.onnx",
    )

    monkeypatch.setattr(dm, "SEGMENTATION", segmentation)
    monkeypatch.setattr(dm, "EMBEDDING", embedding)
    monkeypatch.setattr(dm, "ARTIFACTS", (segmentation, embedding))

    payloads: dict[str, object] = {_SEG_URL: archive, _EMB_URL: _EMB_PAYLOAD}
    if responses:
        payloads.update(responses)

    calls: list[str] = []

    def fake_urlopen(url, timeout=None):
        calls.append(url)
        payload = payloads.get(url)
        if payload is None:
            raise URLError(f"unexpected url: {url}")
        if isinstance(payload, BaseException):
            raise payload
        return _FakeResponse(payload, fail_after=fail_after)

    monkeypatch.setattr(dm, "urlopen", fake_urlopen)
    return calls


def _partials(root: Path) -> list[Path]:
    return list(root.rglob("*.part-*"))


# --- the happy paths -----------------------------------------------------


def test_downloads_and_extracts_segmentation_member(tmp_path, monkeypatch):
    _install_fakes(monkeypatch)
    seg_path, emb_path = dm.ensure_diarization_models(tmp_path)

    assert seg_path == tmp_path / "diarization" / _SEG_MEMBER
    assert seg_path.read_bytes() == _SEG_PAYLOAD
    # The tarball is dropped once the model is out of it.
    assert not (tmp_path / "diarization" / "seg.tar.bz2").exists()
    assert _partials(tmp_path) == []
    assert emb_path.read_bytes() == _EMB_PAYLOAD


def test_downloads_bare_onnx_embedding_model(tmp_path, monkeypatch):
    _install_fakes(monkeypatch)
    _, emb_path = dm.ensure_diarization_models(tmp_path)
    # No member_name: the URL is the model file itself, no extraction step.
    assert emb_path == tmp_path / "diarization" / "emb.onnx"
    assert emb_path.read_bytes() == _EMB_PAYLOAD


def test_cached_models_are_not_redownloaded(tmp_path, monkeypatch):
    calls = _install_fakes(monkeypatch)
    dm.ensure_diarization_models(tmp_path)
    assert len(calls) == 2

    calls.clear()
    seg_path, emb_path = dm.ensure_diarization_models(tmp_path)
    assert calls == [], "a warm cache must not touch the network"
    assert seg_path.exists() and emb_path.exists()


def test_is_diarization_cached_tracks_both_artifacts(tmp_path, monkeypatch):
    _install_fakes(monkeypatch)
    assert dm.is_diarization_cached(tmp_path) is False
    dm.ensure_diarization_models(tmp_path)
    assert dm.is_diarization_cached(tmp_path) is True


def test_truncated_cached_file_is_redownloaded(tmp_path, monkeypatch):
    calls = _install_fakes(monkeypatch)
    dm.ensure_diarization_models(tmp_path)

    # Simulate a half-written file: present, non-empty, wrong size.
    seg_path = tmp_path / "diarization" / _SEG_MEMBER
    seg_path.write_bytes(_SEG_PAYLOAD[:5])
    assert dm.is_diarization_cached(tmp_path) is False

    calls.clear()
    dm.ensure_diarization_models(tmp_path)
    assert calls == [_SEG_URL]
    assert seg_path.read_bytes() == _SEG_PAYLOAD


def test_empty_models_dir_is_not_cached(tmp_path):
    assert dm.is_diarization_cached(tmp_path) is False
    assert dm.diarization_dir(tmp_path) == tmp_path / "diarization"


# --- the failure paths ---------------------------------------------------


def test_checksum_mismatch_raises_and_cleans_up(tmp_path, monkeypatch):
    _install_fakes(monkeypatch, bad_archive_sha=True)
    with pytest.raises(dm.DiarizationModelError) as excinfo:
        dm.ensure_diarization_models(tmp_path)

    assert excinfo.value.reason == dm.REASON_CHECKSUM_MISMATCH
    assert _partials(tmp_path) == [], "a corrupt download must not be left behind"
    assert not (tmp_path / "diarization" / _SEG_MEMBER).exists()


def test_network_error_raises_download_failed(tmp_path, monkeypatch):
    _install_fakes(monkeypatch, responses={_SEG_URL: URLError("offline")})
    with pytest.raises(dm.DiarizationModelError) as excinfo:
        dm.ensure_diarization_models(tmp_path)

    error = excinfo.value
    assert error.reason == dm.REASON_DOWNLOAD_FAILED
    # The message has to stand on its own: it is the fallback for when the
    # localized error copy never reaches the renderer.
    assert _SEG_URL in str(error)
    assert str(tmp_path / "diarization") in str(error)
    assert _partials(tmp_path) == []


def test_interrupted_stream_leaves_no_partial_file(tmp_path, monkeypatch):
    _install_fakes(monkeypatch, fail_after=4)
    with pytest.raises(dm.DiarizationModelError) as excinfo:
        dm.ensure_diarization_models(tmp_path)

    assert excinfo.value.reason == dm.REASON_DOWNLOAD_FAILED
    assert _partials(tmp_path) == []
    assert not (tmp_path / "diarization" / _SEG_MEMBER).exists()


def test_unsafe_member_name_is_rejected(tmp_path, monkeypatch):
    # Belt and braces: the member name is hardcoded, so this can only
    # happen if someone edits the artifact table badly.
    _install_fakes(
        monkeypatch,
        tar_members={"../evil.onnx": _SEG_PAYLOAD},
        seg_member_name="../evil.onnx",
    )
    with pytest.raises(dm.DiarizationModelError) as excinfo:
        dm.ensure_diarization_models(tmp_path)

    assert excinfo.value.reason == dm.REASON_EXTRACT_FAILED
    assert not (tmp_path.parent / "evil.onnx").exists()


def test_absolute_member_name_is_rejected(tmp_path, monkeypatch):
    _install_fakes(
        monkeypatch,
        tar_members={"/etc/evil.onnx": _SEG_PAYLOAD},
        seg_member_name="/etc/evil.onnx",
    )
    with pytest.raises(dm.DiarizationModelError) as excinfo:
        dm.ensure_diarization_models(tmp_path)
    assert excinfo.value.reason == dm.REASON_EXTRACT_FAILED


def test_archive_without_the_expected_member_is_rejected(tmp_path, monkeypatch):
    # We resolve one known name rather than extracting the tree, so a
    # hostile archive simply fails to match and nothing is written.
    _install_fakes(monkeypatch, tar_members={"../evil.onnx": b"payload"})
    with pytest.raises(dm.DiarizationModelError) as excinfo:
        dm.ensure_diarization_models(tmp_path)

    assert excinfo.value.reason == dm.REASON_EXTRACT_FAILED
    assert not (tmp_path / "diarization" / _SEG_MEMBER).exists()
    assert not (tmp_path.parent / "evil.onnx").exists()


def test_stale_partial_files_are_swept(tmp_path, monkeypatch):
    _install_fakes(monkeypatch)
    stale_dir = tmp_path / "diarization" / "pkg"
    stale_dir.mkdir(parents=True)
    stale = stale_dir / "model.onnx.part-99999"
    stale.write_bytes(b"left over from a crash")

    dm.ensure_diarization_models(tmp_path)
    assert not stale.exists()


# --- progress reporting --------------------------------------------------


def test_progress_events_follow_the_manager_vocabulary(tmp_path, monkeypatch):
    _install_fakes(monkeypatch)
    events: list[tuple[str, dict]] = []
    dm.ensure_diarization_models(tmp_path, progress=lambda kind, payload: events.append((kind, payload)))

    kinds = {kind for kind, _ in events}
    assert kinds == {"stage", "progress"}

    stages = [payload["stage"] for kind, payload in events if kind == "stage"]
    assert stages == [
        "downloading",
        "extracting",
        "cleanup",
        "downloading",
        "verifying",
    ]

    for _, payload in ((k, p) for k, p in events if k == "progress"):
        # Same four keys ModelManager.download emits, so the existing
        # cli.py translator works unchanged.
        assert set(payload) == {
            "downloaded_bytes",
            "total_bytes",
            "speed_bytes_per_sec",
            "eta_seconds",
        }

    final = [p for k, p in events if k == "progress"][-1]
    assert final["downloaded_bytes"] == final["total_bytes"]


def test_progress_callback_exception_is_swallowed(tmp_path, monkeypatch):
    # Matches ModelManager.download's contract: a broken observer must
    # never kill a download.
    _install_fakes(monkeypatch)

    def explode(kind, payload):
        raise RuntimeError("observer is broken")

    seg_path, emb_path = dm.ensure_diarization_models(tmp_path, progress=explode)
    assert seg_path.exists() and emb_path.exists()


def test_progress_total_counts_only_missing_artifacts(tmp_path, monkeypatch):
    _install_fakes(monkeypatch)
    dm.ensure_diarization_models(tmp_path)

    # Break just the segmentation model; the bar should size itself to the
    # one re-download rather than to both artifacts.
    (tmp_path / "diarization" / _SEG_MEMBER).write_bytes(b"x")
    events: list[tuple[str, dict]] = []
    dm.ensure_diarization_models(tmp_path, progress=lambda k, p: events.append((k, p)))

    totals = {p["total_bytes"] for k, p in events if k == "progress"}
    assert totals == {dm.SEGMENTATION.archive_bytes}


# --- the real artifact table --------------------------------------------


def test_real_artifact_metadata_matches_the_verified_spec():
    # Measured 2026-10-07 (docs/specs/speaker-diarization.md section 3.3).
    # Pinned here because a silent edit to any of these turns a download
    # into a checksum failure at the user's machine.
    assert dm.SEGMENTATION.url == (
        "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
        "speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
    )
    assert dm.SEGMENTATION.archive_bytes == 6_958_444
    assert dm.SEGMENTATION.archive_sha256 == (
        "24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488"
    )
    assert dm.SEGMENTATION.member_name == "sherpa-onnx-pyannote-segmentation-3-0/model.onnx"
    assert dm.SEGMENTATION.model_bytes == 5_992_913
    assert dm.SEGMENTATION.model_sha256 == (
        "220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079"
    )
    # Never the int8 variant: it finds 5 speakers in the 4-speaker sample.
    assert "int8" not in dm.SEGMENTATION.member_name

    # The `recongition` misspelling is upstream's own release tag.
    assert "speaker-recongition-models" in dm.EMBEDDING.url
    assert dm.EMBEDDING.url.endswith(
        "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx"
    )
    assert dm.EMBEDDING.member_name is None
    assert dm.EMBEDDING.model_bytes == 28_281_164
    assert dm.EMBEDDING.model_sha256 == (
        "aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2"
    )

    # ~33.6 MiB, which is the figure the first-run stage message quotes.
    assert dm.TOTAL_DOWNLOAD_BYTES == 35_239_608
    assert 33 < dm.TOTAL_DOWNLOAD_BYTES / 1024 / 1024 < 34

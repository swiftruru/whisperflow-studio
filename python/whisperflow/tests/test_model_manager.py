"""Unit tests for models/manager.py that don't hit the network.

These exercise the directory bookkeeping, completeness verification, and
HF-cache import paths.  ``ModelManager.download`` itself is exercised via
the import-from-cache code path so we never have to call faster-whisper
or hit HuggingFace from a test.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

from whisperflow.models.manager import (
    ModelManager,
    _is_complete_model_dir,
    _missing_model_files,
    default_models_dir,
    default_torch_hub_dir,
    import_silero_vad_from_system_torch_hub,
)
from whisperflow.models.registry import get_model, model_names


# --- helpers ----------------------------------------------------------


_FAKE_FILES = {
    "config.json": b'{"model_type":"whisper"}\n',
    "tokenizer.json": b'{"version":"1.0"}\n',
    "vocabulary.txt": b"<|endoftext|>\n",
    "model.bin": b"\x00" * 4096,  # tiny stand-in for model weights
}


def make_complete_flat_model_dir(model_dir: Path) -> Path:
    """Build a flat model directory — what ``WhisperModel(...)`` actually loads.

    This is the layout the managed models directory must always be in.
    """
    model_dir.mkdir(parents=True)
    for name, contents in _FAKE_FILES.items():
        (model_dir / name).write_bytes(contents)
    return model_dir


def make_hf_cache_layout(model_dir: Path, *, weights_name: str = "model.bin") -> Path:
    """Build an HF-cache style ``blobs/refs/snapshots`` layout.

    This is what ``~/.cache/huggingface/hub/models--<org>--<name>/`` looks
    like.  The managed dir should NEVER use this layout, but the HF cache
    import source might.
    """
    rev = "f0fe81560cb8b68660e564f55dd99207059c092e"
    blobs = model_dir / "blobs"
    snapshot = model_dir / "snapshots" / rev
    refs = model_dir / "refs"
    blobs.mkdir(parents=True)
    snapshot.mkdir(parents=True)
    refs.mkdir(parents=True)
    (refs / "main").write_text(rev)

    files = dict(_FAKE_FILES)
    if weights_name != "model.bin":
        files[weights_name] = files.pop("model.bin")

    for name, contents in files.items():
        blob_name = f"sha256_{name}"
        blob = blobs / blob_name
        blob.write_bytes(contents)
        os.symlink(os.path.relpath(blob, snapshot), snapshot / name)

    return snapshot


def make_partial_flat_model_dir(model_dir: Path) -> Path:
    """A flat directory missing model.bin (the bug case)."""
    model_dir.mkdir(parents=True)
    for name, contents in _FAKE_FILES.items():
        if name == "model.bin":
            continue
        (model_dir / name).write_bytes(contents)
    return model_dir


# --- defaults ---------------------------------------------------------


def test_default_models_dir_is_platform_native():
    path = default_models_dir()
    # Must match Electron's productName exactly so CLI-direct and
    # Electron-managed paths resolve to the same location.
    assert "WhisperFlow Studio" in str(path)
    assert path.name == "models"
    if sys.platform == "darwin":
        assert "Library/Application Support" in str(path)


def test_default_models_dir_linux_uses_xdg_config_home(monkeypatch, tmp_path):
    """Electron's Linux userData lives under $XDG_CONFIG_HOME, so we
    match that rather than the more technically-correct XDG_DATA_HOME."""
    if sys.platform == "darwin" or sys.platform.startswith("win"):
        pytest.skip("Linux-specific behaviour")
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "cfg"))
    monkeypatch.delenv("XDG_DATA_HOME", raising=False)
    assert str(default_models_dir()).startswith(str(tmp_path / "cfg"))


def test_registry_contains_expected_models():
    names = model_names()
    assert "large-v2" in names
    assert "tiny" in names
    assert get_model("large-v2").repo_id == "Systran/faster-whisper-large-v2"


def test_manager_ensure_dirs_creates_root_and_torch_hub(tmp_path):
    manager = ModelManager(tmp_path / "models")
    manager.ensure_dirs()
    assert manager.models_dir.is_dir()
    assert manager.torch_hub_dir.is_dir()


# --- completeness verification (flat layout only) -------------------


def test_missing_files_reported_for_empty_dir(tmp_path):
    missing = _missing_model_files(tmp_path / "nope")
    assert "config.json" in missing
    assert "model.bin" in missing


def test_complete_flat_dir_is_recognised(tmp_path):
    model_dir = tmp_path / "models--Systran--faster-whisper-tiny"
    make_complete_flat_model_dir(model_dir)
    assert _is_complete_model_dir(model_dir)
    assert _missing_model_files(model_dir) == []


def test_partial_flat_dir_is_rejected(tmp_path):
    model_dir = tmp_path / "models--Systran--faster-whisper-tiny"
    make_partial_flat_model_dir(model_dir)
    assert not _is_complete_model_dir(model_dir)
    assert "model.bin" in _missing_model_files(model_dir)


def test_safetensors_weights_count_as_complete(tmp_path):
    model_dir = tmp_path / "models--Systran--faster-whisper-tiny"
    model_dir.mkdir()
    for name, contents in _FAKE_FILES.items():
        if name == "model.bin":
            (model_dir / "model.safetensors").write_bytes(contents)
        else:
            (model_dir / name).write_bytes(contents)
    assert _is_complete_model_dir(model_dir)


def test_hf_cache_layout_is_rejected_for_managed_dir(tmp_path):
    """Managed dir must be flat — snapshot layout is rejected even when
    every file is present, because WhisperModel can't load it."""
    model_dir = tmp_path / "models--Systran--faster-whisper-tiny"
    make_hf_cache_layout(model_dir)
    assert not _is_complete_model_dir(model_dir)


# --- list / install state --------------------------------------------


def test_list_installed_only_includes_complete_models(tmp_path):
    manager = ModelManager(tmp_path / "models")
    manager.ensure_dirs()

    # Complete: tiny
    make_complete_flat_model_dir(manager.models_dir / get_model("tiny").local_dir_name)
    # Incomplete: base
    make_partial_flat_model_dir(manager.models_dir / get_model("base").local_dir_name)
    # Wrong layout (HF cache style): small
    make_hf_cache_layout(manager.models_dir / get_model("small").local_dir_name)

    installed = manager.list_installed()
    names = [i.entry.name for i in installed]
    assert "tiny" in names
    assert "base" not in names
    assert "small" not in names


def test_is_installed_returns_false_for_partial_download(tmp_path):
    manager = ModelManager(tmp_path / "models")
    manager.ensure_dirs()
    make_partial_flat_model_dir(manager.models_dir / get_model("base").local_dir_name)
    assert manager.is_installed("base") is False


# --- import-from-HF-cache fast path ---------------------------------


def test_download_imports_from_hf_cache_as_flat_layout(tmp_path, monkeypatch):
    """The import path should walk the HF cache snapshot, resolve symlinks,
    and produce a FLAT directory in the managed area — not copy the whole
    blobs/refs/snapshots tree."""
    monkeypatch.setenv("HF_HOME", str(tmp_path / "fake-hf-cache-parent"))
    cache_root = tmp_path / "fake-hf-cache-parent" / "hub"
    cache_root.mkdir(parents=True)

    entry = get_model("tiny")
    make_hf_cache_layout(cache_root / entry.local_dir_name)

    manager = ModelManager(tmp_path / "managed")
    target = manager.download("tiny")

    # The target must be flat — the files sit directly inside, not in a
    # snapshots/ subdirectory.
    assert target == manager.models_dir / entry.local_dir_name
    assert not (target / "snapshots").exists()
    assert not (target / "blobs").exists()
    for required in ("config.json", "tokenizer.json", "vocabulary.txt", "model.bin"):
        assert (target / required).is_file(), f"{required} missing in flat target"

    assert _is_complete_model_dir(target)
    assert manager.is_installed("tiny")


def test_download_cleans_up_legacy_snapshot_layout(tmp_path, monkeypatch):
    """If the managed dir has a legacy HF-cache layout left behind by an
    older buggy version, download() should wipe it before re-importing."""
    monkeypatch.setenv("HF_HOME", str(tmp_path / "fake-hf-cache-parent"))
    cache_root = tmp_path / "fake-hf-cache-parent" / "hub"
    cache_root.mkdir(parents=True)

    entry = get_model("tiny")
    make_hf_cache_layout(cache_root / entry.local_dir_name)

    manager = ModelManager(tmp_path / "managed")
    manager.ensure_dirs()
    # Pre-populate the managed dir with the broken layout.
    legacy = manager.models_dir / entry.local_dir_name
    make_hf_cache_layout(legacy)
    assert (legacy / "snapshots").exists()  # sanity

    target = manager.download("tiny")

    # After download, the legacy snapshots/ tree must be gone and
    # replaced with a flat layout.
    assert not (target / "snapshots").exists()
    assert (target / "model.bin").is_file()
    assert _is_complete_model_dir(target)


def test_download_raises_when_no_cache_and_network_disabled(tmp_path, monkeypatch):
    """If there's no cached copy AND the network call leaves an incomplete
    state, download() should raise rather than silently returning success."""
    monkeypatch.setenv("HF_HOME", str(tmp_path / "nonexistent"))

    manager = ModelManager(tmp_path / "managed")

    # Stub out faster_whisper.download_model to mimic the real bug:
    # creates a partial flat layout (missing model.bin) and returns
    # "successfully".
    fake_module = type(sys)("faster_whisper")

    def fake_download(repo_id, output_dir):
        target = Path(output_dir)
        make_partial_flat_model_dir(target)
        return str(target)

    fake_module.download_model = fake_download
    monkeypatch.setitem(sys.modules, "faster_whisper", fake_module)

    with pytest.raises(RuntimeError, match="did not complete"):
        manager.download("tiny")


# --- resolve_model_path ----------------------------------------------


def test_resolve_model_path_returns_local_when_complete(tmp_path):
    manager = ModelManager(tmp_path / "models")
    manager.ensure_dirs()
    entry = get_model("large-v2")
    make_complete_flat_model_dir(manager.models_dir / entry.local_dir_name)

    assert manager.resolve_model_path("large-v2") == str(
        manager.models_dir / entry.local_dir_name
    )


def test_resolve_model_path_returns_repo_id_when_incomplete(tmp_path):
    manager = ModelManager(tmp_path / "models")
    manager.ensure_dirs()
    entry = get_model("large-v2")
    make_partial_flat_model_dir(manager.models_dir / entry.local_dir_name)

    assert manager.resolve_model_path("large-v2") == "Systran/faster-whisper-large-v2"


def test_resolve_model_path_returns_repo_id_for_legacy_snapshot_layout(tmp_path):
    """Snapshot layout is no longer accepted as 'installed', so resolve
    should fall back to the repo id (forcing re-import on next use)."""
    manager = ModelManager(tmp_path / "models")
    manager.ensure_dirs()
    entry = get_model("large-v2")
    make_hf_cache_layout(manager.models_dir / entry.local_dir_name)

    assert manager.resolve_model_path("large-v2") == "Systran/faster-whisper-large-v2"


def test_resolve_model_path_returns_repo_id_when_missing(tmp_path):
    manager = ModelManager(tmp_path / "models")
    manager.ensure_dirs()
    assert manager.resolve_model_path("large-v2") == "Systran/faster-whisper-large-v2"


# --- delete ----------------------------------------------------------


def test_delete_removes_existing_model(tmp_path):
    manager = ModelManager(tmp_path / "models")
    manager.ensure_dirs()
    entry = get_model("base")
    target = manager.models_dir / entry.local_dir_name
    target.mkdir()
    (target / "x").write_text("hi")

    assert manager.delete("base") is True
    assert not target.exists()


def test_delete_returns_false_when_not_installed(tmp_path):
    manager = ModelManager(tmp_path / "models")
    manager.ensure_dirs()
    assert manager.delete("small") is False


def test_delete_unknown_model_raises(tmp_path):
    manager = ModelManager(tmp_path / "models")
    with pytest.raises(ValueError):
        manager.delete("nonsense")


# --- silero-vad system torch hub import -----------------------------


def make_silero_checkout(
    checkout_dir: Path,
    *,
    complete: bool = True,
    layout: str = "modern",
) -> Path:
    """Build a fake silero-vad torch.hub checkout.  Mirrors the layout a
    real ``git clone snakers4/silero-vad`` would leave behind.

    ``layout="legacy"`` places the weight file at ``files/silero_vad.jit``
    (older repo structure).  ``layout="modern"`` places it at
    ``src/silero_vad/data/silero_vad.jit`` (current repo as of 2026).
    """
    checkout_dir.mkdir(parents=True)
    (checkout_dir / "hubconf.py").write_text("def silero_vad(): pass\n")

    if layout == "legacy":
        files_dir = checkout_dir / "files"
        files_dir.mkdir()
        if complete:
            (files_dir / "silero_vad.jit").write_bytes(b"\x00" * 2048)
    elif layout == "modern":
        data_dir = checkout_dir / "src" / "silero_vad" / "data"
        data_dir.mkdir(parents=True)
        if complete:
            (data_dir / "silero_vad.jit").write_bytes(b"\x00" * 2048)
            (data_dir / "silero_vad.onnx").write_bytes(b"\x00" * 1024)
    else:
        raise ValueError(f"unknown layout {layout!r}")

    return checkout_dir


def test_default_torch_hub_dir_respects_torch_home(monkeypatch, tmp_path):
    monkeypatch.setenv("TORCH_HOME", str(tmp_path / "fake-torch"))
    assert default_torch_hub_dir() == tmp_path / "fake-torch" / "hub"


def test_default_torch_hub_dir_falls_back_to_cache(monkeypatch):
    monkeypatch.delenv("TORCH_HOME", raising=False)
    monkeypatch.delenv("XDG_CACHE_HOME", raising=False)
    assert str(default_torch_hub_dir()).endswith("/.cache/torch/hub")


def test_import_silero_vad_from_system_cache_hard_links(monkeypatch, tmp_path):
    system_hub = tmp_path / "sys-torch-hub"
    system_hub.mkdir()
    make_silero_checkout(system_hub / "snakers4_silero-vad_master")
    monkeypatch.setenv("TORCH_HOME", str(tmp_path / "fake-torch-home"))
    (tmp_path / "fake-torch-home" / "hub").mkdir(parents=True)
    # Override default_torch_hub_dir by pointing TORCH_HOME at a dir whose
    # hub/ subdir is our system_hub layout.
    actual_system_hub = tmp_path / "fake-torch-home" / "hub"
    make_silero_checkout(actual_system_hub / "snakers4_silero-vad_master")

    managed = tmp_path / "managed" / "torch_hub"
    assert import_silero_vad_from_system_torch_hub(managed) is True

    target = managed / "snakers4_silero-vad_master"
    assert target.is_dir()
    assert (target / "hubconf.py").is_file()
    assert (target / "src" / "silero_vad" / "data" / "silero_vad.jit").is_file()


def test_import_silero_vad_short_circuits_when_already_present(tmp_path, monkeypatch):
    managed = tmp_path / "managed" / "torch_hub"
    make_silero_checkout(managed / "snakers4_silero-vad_master")
    # Point default to a bogus location — the import should NOT touch it
    # because the managed dir is already complete.
    monkeypatch.setenv("TORCH_HOME", str(tmp_path / "nonexistent"))

    assert import_silero_vad_from_system_torch_hub(managed) is True


def test_import_silero_vad_rejects_incomplete_source(tmp_path, monkeypatch):
    monkeypatch.setenv("TORCH_HOME", str(tmp_path / "fake-torch-home"))
    hub = tmp_path / "fake-torch-home" / "hub"
    hub.mkdir(parents=True)
    make_silero_checkout(hub / "snakers4_silero-vad_master", complete=False)

    managed = tmp_path / "managed" / "torch_hub"
    # The source lacks silero_vad.jit, so we should fall through and let
    # torch.hub download (returns False to signal "no import happened").
    assert import_silero_vad_from_system_torch_hub(managed) is False
    assert not (managed / "snakers4_silero-vad_master").exists()


def test_import_silero_vad_returns_false_when_no_system_cache(tmp_path, monkeypatch):
    monkeypatch.setenv("TORCH_HOME", str(tmp_path / "completely-missing"))
    managed = tmp_path / "managed" / "torch_hub"
    assert import_silero_vad_from_system_torch_hub(managed) is False


def test_import_silero_vad_accepts_legacy_files_layout(tmp_path, monkeypatch):
    """Older silero-vad repo versions stored the weight file at
    ``files/silero_vad.jit`` instead of ``src/silero_vad/data/``.  The
    completeness check must recognise both."""
    monkeypatch.setenv("TORCH_HOME", str(tmp_path / "fake-torch-home"))
    hub = tmp_path / "fake-torch-home" / "hub"
    hub.mkdir(parents=True)
    make_silero_checkout(
        hub / "snakers4_silero-vad_master",
        layout="legacy",
    )

    managed = tmp_path / "managed" / "torch_hub"
    assert import_silero_vad_from_system_torch_hub(managed) is True
    assert (managed / "snakers4_silero-vad_master" / "files" / "silero_vad.jit").is_file()

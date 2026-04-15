# New module (no upstream counterpart).
# Owns the app-managed models directory: where models live on disk,
# which ones are installed, how to download/delete them, and a side
# "torch_hub" slot so Silero VAD can share the same managed root instead
# of polluting ~/.cache/torch.

from __future__ import annotations

import logging
import os
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

from .registry import ModelEntry, get_model

_log = logging.getLogger(__name__)

# Must match Electron's `app.name` (which is set from package.json's
# productName in src/main/main.js) so that a direct CLI invocation of
# ``python -m whisperflow.cli`` resolves to the same on-disk location
# that Electron would — otherwise developers get two shadow copies of
# the models directory.
_APP_DIR_NAME = "WhisperFlow Studio"

# Files that must be present (and complete) inside a model's snapshot dir
# for it to count as installed.  Whisper weights are either ``model.bin``
# (CTranslate2) or ``model.safetensors`` (newer faster-whisper repos), so
# weights are checked separately below.
_REQUIRED_METADATA_FILES = ("config.json", "tokenizer.json", "vocabulary.txt")
_WEIGHT_CANDIDATES = ("model.bin", "model.safetensors")

# Passed to consumers that want to report download progress.
# Signature: progress_callback(downloaded_bytes, total_bytes).
DownloadProgress = Callable[[int, int], None]


@dataclass(frozen=True)
class InstalledModel:
    """A model the user has already downloaded, plus its on-disk size."""

    entry: ModelEntry
    path: Path
    size_bytes: int


def default_models_dir() -> Path:
    """Return the platform-native default for the managed models directory.

    This is only the fallback for direct Python / CLI usage.  When WhisperFlow
    Studio launches from Electron, the main process passes an explicit path via
    ``config.json`` (computed from Electron's ``app.getPath('userData')``), and
    that value takes precedence.

    Paths are chosen to match Electron's ``app.getPath('userData')`` on every
    platform — otherwise running ``python -m whisperflow.cli --list-models``
    in a terminal would look in a different place than the GUI app does.

    - **macOS**: ``~/Library/Application Support/WhisperFlow Studio/models``
    - **Windows**: ``%APPDATA%/WhisperFlow Studio/models`` (or ``%LOCALAPPDATA%`` as fallback)
    - **Linux**: ``$XDG_CONFIG_HOME/WhisperFlow Studio/models``
      (falling back to ``~/.config/WhisperFlow Studio/models``)
    """
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / _APP_DIR_NAME / "models"

    if sys.platform.startswith("win"):
        base = os.environ.get("APPDATA") or os.environ.get("LOCALAPPDATA")
        if base:
            return Path(base) / _APP_DIR_NAME / "models"
        return Path.home() / "AppData" / "Roaming" / _APP_DIR_NAME / "models"

    # Linux and other POSIX.  Electron uses XDG_CONFIG_HOME (default
    # ~/.config) for `userData`, so we match that for consistency.
    xdg = os.environ.get("XDG_CONFIG_HOME")
    if xdg:
        return Path(xdg) / _APP_DIR_NAME / "models"
    return Path.home() / ".config" / _APP_DIR_NAME / "models"


def default_hf_cache_dir() -> Path:
    """Where huggingface_hub puts downloaded models when no explicit path is set.

    Used by :meth:`ModelManager.download` as a fast-path import source — if
    the user already has the model in their global HF cache (e.g. from a
    previous tool), we hard-link or copy from there instead of re-downloading.
    """
    hf_home = os.environ.get("HF_HOME")
    if hf_home:
        return Path(hf_home) / "hub"
    return Path.home() / ".cache" / "huggingface" / "hub"


def default_torch_hub_dir() -> Path:
    """Where :mod:`torch.hub` caches downloaded repositories by default.

    Mirrors PyTorch's own resolution order:

    1. ``$TORCH_HOME/hub``
    2. ``$XDG_CACHE_HOME/torch/hub``
    3. ``~/.cache/torch/hub``

    Used by :func:`import_silero_vad_from_system_torch_hub` as a fast-path
    import source.
    """
    torch_home = os.environ.get("TORCH_HOME")
    if torch_home:
        return Path(torch_home) / "hub"

    xdg_cache = os.environ.get("XDG_CACHE_HOME")
    if xdg_cache:
        return Path(xdg_cache) / "torch" / "hub"

    return Path.home() / ".cache" / "torch" / "hub"


# Files required for a silero-vad checkout to be usable by ``torch.hub.load``
# without touching the network.  ``hubconf.py`` is what torch.hub looks up to
# resolve the model entry point.  The TorchScript weight file has moved
# around across versions of the repo (legacy ``files/silero_vad.jit`` vs
# newer ``src/silero_vad/data/silero_vad.jit``), so we accept *any* .jit
# located anywhere underneath the checkout.
_SILERO_REPO_NAME = "snakers4_silero-vad_master"
_SILERO_REQUIRED_FILES = ("hubconf.py",)


def import_silero_vad_from_system_torch_hub(torch_hub_dir: Path) -> bool:
    """Fast-path import of a previously-downloaded Silero VAD checkout.

    When the app runs for the first time it pins ``torch.hub.set_dir`` to
    a managed directory under the app's models folder.  If the user already
    had silero-vad sitting in their *system* torch hub cache (e.g. from
    running any other torch.hub-based tool), we hard-link / copy it into
    the managed dir so ``torch.hub.load`` finds it immediately and skips
    the 10–20 MB download entirely.

    Returns ``True`` if the managed dir ends up with a usable Silero VAD
    checkout (either pre-existing, or freshly imported from the system
    cache).  Returns ``False`` when nothing could be imported and the
    caller should let ``torch.hub.load`` do its normal network download.
    """
    target = Path(torch_hub_dir) / _SILERO_REPO_NAME
    if _is_complete_silero_checkout(target):
        return True

    source = default_torch_hub_dir() / _SILERO_REPO_NAME
    if not _is_complete_silero_checkout(source):
        return False

    Path(torch_hub_dir).mkdir(parents=True, exist_ok=True)
    if target.exists():
        shutil.rmtree(target)

    _log.info("importing silero-vad from system torch hub cache: %s -> %s", source, target)
    try:
        shutil.copytree(source, target, copy_function=_link_or_copy)
    except OSError as err:
        _log.warning("hard-link import failed (%s); falling back to plain copy", err)
        shutil.copytree(source, target)

    return _is_complete_silero_checkout(target)


def _is_complete_silero_checkout(checkout_dir: Path) -> bool:
    """A silero-vad checkout is usable iff hubconf.py is present and at
    least one non-empty ``*.jit`` TorchScript weight file exists somewhere
    underneath it.

    We walk the tree rather than hard-coding a path because snakers4 has
    moved the weight file between repo layouts: older versions keep it at
    ``files/silero_vad.jit``, newer versions at
    ``src/silero_vad/data/silero_vad.jit``.
    """
    if not checkout_dir.is_dir():
        return False
    for required in _SILERO_REQUIRED_FILES:
        if not _file_present_and_complete(checkout_dir / required):
            return False
    # Walk the tree once for .jit files; first complete match wins.
    for jit in checkout_dir.rglob("*.jit"):
        if _file_present_and_complete(jit):
            return True
    return False


class ModelManager:
    """Owns the models directory on disk.

    Methods are deliberately small and stateless: they take a models_dir in
    the constructor and then list / download / delete / resolve against it.
    The directory is created on demand; consumers never have to mkdir.
    """

    def __init__(self, models_dir: Optional[Path] = None) -> None:
        self.models_dir: Path = Path(models_dir) if models_dir else default_models_dir()

    # --- directories ---------------------------------------------------

    def ensure_dirs(self) -> None:
        """Make sure the root and the torch_hub sub-dir both exist."""
        self.models_dir.mkdir(parents=True, exist_ok=True)
        self.torch_hub_dir.mkdir(parents=True, exist_ok=True)

    @property
    def torch_hub_dir(self) -> Path:
        """Sub-directory used as ``torch.hub`` cache for Silero VAD.

        Keeping it under the managed models root means "clear all downloaded
        models" in the UI also clears the VAD weights, and nothing ends up in
        the user's global ``~/.cache/torch``.
        """
        return self.models_dir / "torch_hub"

    # --- listing -------------------------------------------------------

    def list_installed(self) -> list[InstalledModel]:
        """Return the subset of registry entries that are present AND complete on disk."""
        from .registry import all_models

        if not self.models_dir.exists():
            return []

        installed: list[InstalledModel] = []
        for entry in all_models():
            model_dir = self.models_dir / entry.local_dir_name
            if not _is_complete_model_dir(model_dir):
                continue
            installed.append(
                InstalledModel(
                    entry=entry,
                    path=model_dir,
                    size_bytes=_directory_size(model_dir),
                )
            )
        return installed

    def is_installed(self, name: str) -> bool:
        entry = get_model(name)
        if entry is None:
            return False
        return _is_complete_model_dir(self.models_dir / entry.local_dir_name)

    # --- install / uninstall ------------------------------------------

    def download(
        self,
        name: str,
        *,
        progress: Optional[DownloadProgress] = None,
    ) -> Path:
        """Download a model by short name (e.g. ``"large-v2"``).

        Three-stage strategy:

        1. **Fast path: import from system HuggingFace cache.**  Many users
           already have the model under ``~/.cache/huggingface/hub/`` from a
           prior tool.  If a complete copy exists there we hard-link it into
           the managed dir (or copy on cross-volume failure).  This usually
           takes under a second for a 3 GB model.

        2. **Network download.**  If no usable cached copy exists, call
           ``faster_whisper.download_model`` to fetch from HuggingFace.

        3. **Verify completeness.**  ``faster-whisper`` and ``huggingface_hub``
           have been observed to return success for half-finished downloads
           (leaving ``.incomplete`` blob files behind), so we always validate
           the result and raise a clear error if anything is missing.
        """
        entry = get_model(name)
        if entry is None:
            raise ValueError(f"unknown model: {name!r}")

        self.ensure_dirs()
        target_dir = self.models_dir / entry.local_dir_name
        total_bytes = entry.approx_size_mb * 1024 * 1024
        if progress is not None:
            progress(0, total_bytes)

        # Stage 0: clean up legacy HF-cache layout left behind by an earlier
        # buggy version that copytree'd the whole `~/.cache/huggingface/`
        # tree (with blobs/refs/snapshots/) into the managed dir.
        # faster-whisper's WhisperModel can only load a flat directory, so
        # we'd rather wipe it and re-import than ship a stale state.
        if target_dir.exists() and (target_dir / "snapshots").is_dir():
            _log.info("removing legacy HF-cache layout from %s", target_dir)
            shutil.rmtree(target_dir)

        # Stage 1: try to import from the system HF cache.
        if not _is_complete_model_dir(target_dir):
            imported = self._import_from_hf_cache(entry, target_dir)
            if imported:
                _log.info("imported %s from system HuggingFace cache", entry.name)

        # Stage 2: if still incomplete, hit the network.
        if not _is_complete_model_dir(target_dir):
            from faster_whisper import download_model  # heavy import — lazy

            _log.info("downloading model %s into %s", entry.name, self.models_dir)
            download_model(entry.repo_id, output_dir=str(target_dir))

        # Stage 3: hard requirement — must be complete by now.
        if not _is_complete_model_dir(target_dir):
            missing = _missing_model_files(target_dir)
            raise RuntimeError(
                f"model {entry.name!r} download did not complete cleanly. "
                f"Missing or partial: {missing}. Please retry."
            )

        if progress is not None:
            progress(total_bytes, total_bytes)

        return target_dir

    def _import_from_hf_cache(self, entry: ModelEntry, target_dir: Path) -> bool:
        """Try to materialise the model from the user's global HF cache.

        The HF cache uses a ``blobs / refs / snapshots`` tree with files
        stored once in ``blobs/<hash>`` and referenced from
        ``snapshots/<rev>/<file>`` via relative symlinks.  faster-whisper's
        ``WhisperModel`` loader doesn't understand that layout — it expects
        a flat directory containing ``model.bin``, ``config.json``, etc.
        directly.  So we walk the source's snapshot dir, resolve each
        symlink to the real blob, and hard-link / copy individual files
        into a fresh flat ``target_dir``.

        Returns ``True`` if the import produced a complete flat layout,
        ``False`` otherwise (no cached copy, or the cached copy was itself
        incomplete).
        """
        cache_root = default_hf_cache_dir()
        source = cache_root / entry.local_dir_name
        source_snapshot = _resolve_source_files_dir(source)
        if source_snapshot is None:
            return False

        # Verify the source actually has all the files we need before we
        # commit to wiping target_dir.
        if not _has_required_files(source_snapshot):
            return False

        # If target exists in a partial state, blow it away first so we
        # don't end up with a mix of stale and fresh artefacts.
        if target_dir.exists():
            shutil.rmtree(target_dir)
        target_dir.mkdir(parents=True)

        _log.info("flattening %s -> %s (hard-link where possible)", source_snapshot, target_dir)
        for child in source_snapshot.iterdir():
            if child.name.startswith("."):
                continue  # skip .DS_Store etc
            try:
                real_src = child.resolve(strict=True)
            except (OSError, RuntimeError):
                continue
            if not real_src.is_file():
                continue
            dst = target_dir / child.name
            _link_or_copy(str(real_src), str(dst))

        return _is_complete_model_dir(target_dir)

    def delete(self, name: str) -> bool:
        """Delete an installed model.  Returns ``True`` if something was removed."""
        entry = get_model(name)
        if entry is None:
            raise ValueError(f"unknown model: {name!r}")
        target = self.models_dir / entry.local_dir_name
        if not target.exists():
            return False
        shutil.rmtree(target)
        return True

    # --- resolution ----------------------------------------------------

    def resolve_model_path(self, name: str) -> str:
        """Return the path to pass to ``WhisperModel(...)``.

        If the model is fully downloaded, returns the absolute directory
        path.  Otherwise returns the HuggingFace repo id, which tells
        faster-whisper to download it into ``models_dir`` on first use.
        """
        entry = get_model(name)
        if entry is None:
            # Caller passed a custom repo id or path; trust it.
            return name
        local = self.models_dir / entry.local_dir_name
        if _is_complete_model_dir(local):
            return str(local)
        return entry.repo_id


# --- standalone helpers ------------------------------------------------


def _is_complete_model_dir(model_dir: Path) -> bool:
    """Return True if ``model_dir`` contains a complete, loadable model.

    The managed models directory ALWAYS uses a flat layout — required
    files (``model.bin`` / ``model.safetensors``, ``config.json``,
    ``tokenizer.json``, ``vocabulary.txt``) sit directly inside
    ``model_dir``.  faster-whisper's ``WhisperModel`` loader can only read
    that layout; the HF cache's ``blobs/refs/snapshots`` structure is for
    HF's own use and is intentionally rejected here so we never lie about
    whether ``WhisperModel`` will be able to open the result.
    """
    return _missing_model_files(model_dir) == []


def _missing_model_files(model_dir: Path) -> list[str]:
    """Return a list of required files missing or partial in ``model_dir``.

    Only checks the flat layout — see :func:`_is_complete_model_dir`.
    """
    if not model_dir.is_dir():
        return list(_REQUIRED_METADATA_FILES) + ["model.bin"]

    return _missing_files_in_flat_dir(model_dir)


def _missing_files_in_flat_dir(directory: Path) -> list[str]:
    missing: list[str] = []
    for required in _REQUIRED_METADATA_FILES:
        if not _file_present_and_complete(directory / required):
            missing.append(required)

    if not any(_file_present_and_complete(directory / w) for w in _WEIGHT_CANDIDATES):
        missing.append("model.bin")

    return missing


def _resolve_source_files_dir(model_dir: Path) -> Optional[Path]:
    """Locate the directory holding the actual model files inside an HF cache.

    Used by :meth:`ModelManager._import_from_hf_cache` to find the snapshot
    folder we should flatten files from.  Accepts either:

    - A real HF cache root (``model_dir/snapshots/<rev>/``)
    - An already-flat directory with required files at the top level

    Returns ``None`` if neither layout is recognised.
    """
    if not model_dir.is_dir():
        return None

    snapshots = model_dir / "snapshots"
    if snapshots.is_dir():
        candidates = [child for child in snapshots.iterdir() if child.is_dir()]
        if candidates:
            candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
            return candidates[0]

    # Flat fallback: source already looks like the destination format.
    if _has_required_files(model_dir):
        return model_dir

    return None


def _has_required_files(directory: Path) -> bool:
    """Quick check used by the importer to decide whether a candidate
    directory is worth copying from."""
    return _missing_files_in_flat_dir(directory) == []


def _file_present_and_complete(path: Path) -> bool:
    """True iff ``path`` exists, resolves to a real file, and isn't a
    ``.incomplete`` blob from a partial huggingface_hub download."""
    try:
        if not path.exists():
            return False
        # Resolve through symlinks to the real blob.
        real = path.resolve(strict=True)
    except (OSError, RuntimeError):
        return False

    if real.suffix == ".incomplete":
        return False
    if not real.is_file():
        return False
    try:
        if real.stat().st_size <= 0:
            return False
    except OSError:
        return False
    return True


def _link_or_copy(src: str, dst: str, *, follow_symlinks: bool = True) -> None:
    """``shutil.copytree`` copy_function that prefers hard links over copy.

    Hard links are instant and use no extra disk space, but only work when
    src and dst are on the same volume.  We fall back to a normal copy on
    cross-device errors.  Symlinks in src are dereferenced first so the
    destination ends up with real files even when the source uses HF's
    blobs/snapshots layout with relative symlinks.
    """
    real_src = os.path.realpath(src)
    try:
        if os.path.exists(dst):
            os.remove(dst)
        os.link(real_src, dst)
    except OSError:
        shutil.copy2(real_src, dst, follow_symlinks=True)


def _directory_size(path: Path) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += (Path(root) / name).stat().st_size
            except OSError:
                continue
    return total

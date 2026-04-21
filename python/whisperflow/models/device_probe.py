"""CUDA runtime availability probe used to resolve ``device="auto"``.

faster-whisper's own ``device="auto"`` only checks whether ctranslate2 was
built with CUDA support, not whether the runtime DLLs are actually present
on the host. On a Windows box without an NVIDIA stack that mis-selection
hard-fails with ``Library cublas64_12.dll is not found or cannot be loaded``
instead of falling back to CPU. We probe here first so the backend can fall
back cleanly.

Kept in its own module (no ``faster_whisper`` import) so the unit tests can
exercise the resolver without the heavy ML dependency installed.
"""

from __future__ import annotations

import ctypes
import sys
from typing import Optional, Tuple

_CUDA_RUNTIME_LIBS = {
    "win32": ["cublas64_12.dll", "cudnn_ops64_9.dll"],
    "linux": ["libcublas.so.12"],
}


def _probe_cuda_runtime() -> bool:
    libs = _CUDA_RUNTIME_LIBS.get(sys.platform, [])
    if not libs:
        return False
    for name in libs:
        try:
            ctypes.CDLL(name)
        except OSError:
            return False
    return True


def resolve_device_and_compute_type(
    device: str, compute_type: str
) -> Tuple[str, str, Optional[str]]:
    """Resolve ``device="auto"`` against actual CUDA runtime availability.

    Returns ``(device, compute_type, warning_or_None)``. When falling back to
    CPU, coerces ``float16``/``int8_float16``/``auto`` compute types to
    ``int8`` since CPU cannot run fp16.
    """
    if device != "auto":
        return device, compute_type, None
    if _probe_cuda_runtime():
        return "cuda", compute_type, None
    new_ct = compute_type
    if compute_type in ("auto", "float16", "int8_float16"):
        new_ct = "int8"
    # Stable English format so python-runner.js can regex-match and
    # translate+prefix+classify in the user's UI language.
    msg = (
        f"CUDA runtime unavailable, falling back to device=cpu, "
        f"compute_type={new_ct} (was compute_type={compute_type})"
    )
    return "cpu", new_ct, msg

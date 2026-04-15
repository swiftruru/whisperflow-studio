# Rewritten from faster-whisper-webui src/modelCache.py (Apache 2.0, (c) aadnk).
# Changes: thread-safe (lock-guarded), typed, factory is a proper Callable.
# See /NOTICES.md for license details.

from __future__ import annotations

import threading
from typing import Any, Callable


class ModelCache:
    """Keyed cache of loaded model instances.

    Thread-safe: concurrent ``get_or_create`` calls with the same key will
    serialise on the factory so the model is only constructed once.
    """

    def __init__(self) -> None:
        self._cache: dict[str, Any] = {}
        self._lock = threading.Lock()

    def get_or_create(self, key: str, factory: Callable[[], Any]) -> Any:
        with self._lock:
            cached = self._cache.get(key)
            if cached is not None:
                return cached
            created = factory()
            self._cache[key] = created
            return created

    def clear(self) -> None:
        with self._lock:
            self._cache.clear()


# Process-wide cache used by worker subprocesses so that pickled model
# containers don't reload the model on every invocation.
GLOBAL_MODEL_CACHE = ModelCache()

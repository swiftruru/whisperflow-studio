from whisperflow.models import faster_whisper_backend as fwb


def test_explicit_cpu_passthrough():
    assert fwb._resolve_device_and_compute_type("cpu", "int8") == ("cpu", "int8", None)


def test_explicit_cuda_passthrough():
    assert fwb._resolve_device_and_compute_type("cuda", "float16") == (
        "cuda",
        "float16",
        None,
    )


def test_auto_with_cuda_available(monkeypatch):
    monkeypatch.setattr(fwb, "_probe_cuda_runtime", lambda: True)
    assert fwb._resolve_device_and_compute_type("auto", "auto") == ("cuda", "auto", None)


def test_auto_without_cuda_coerces_auto_compute_type(monkeypatch):
    monkeypatch.setattr(fwb, "_probe_cuda_runtime", lambda: False)
    device, ct, warning = fwb._resolve_device_and_compute_type("auto", "auto")
    assert device == "cpu"
    assert ct == "int8"
    assert warning is not None
    assert "CPU" in warning


def test_auto_without_cuda_coerces_float16(monkeypatch):
    monkeypatch.setattr(fwb, "_probe_cuda_runtime", lambda: False)
    device, ct, warning = fwb._resolve_device_and_compute_type("auto", "float16")
    assert (device, ct) == ("cpu", "int8")
    assert warning is not None
    assert "float16" in warning


def test_auto_without_cuda_keeps_cpu_compatible_compute_type(monkeypatch):
    monkeypatch.setattr(fwb, "_probe_cuda_runtime", lambda: False)
    device, ct, warning = fwb._resolve_device_and_compute_type("auto", "int8")
    assert (device, ct) == ("cpu", "int8")
    assert warning is not None
    assert "int8" not in warning.split("；")[0]

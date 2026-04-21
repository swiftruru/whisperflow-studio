from whisperflow.models import device_probe as dp


def test_explicit_cpu_passthrough():
    assert dp.resolve_device_and_compute_type("cpu", "int8") == ("cpu", "int8", None)


def test_explicit_cuda_passthrough():
    assert dp.resolve_device_and_compute_type("cuda", "float16") == (
        "cuda",
        "float16",
        None,
    )


def test_auto_with_cuda_available(monkeypatch):
    monkeypatch.setattr(dp, "_probe_cuda_runtime", lambda: True)
    assert dp.resolve_device_and_compute_type("auto", "auto") == ("cuda", "auto", None)


def test_auto_without_cuda_coerces_auto_compute_type(monkeypatch):
    monkeypatch.setattr(dp, "_probe_cuda_runtime", lambda: False)
    device, ct, warning = dp.resolve_device_and_compute_type("auto", "auto")
    assert device == "cpu"
    assert ct == "int8"
    assert warning is not None
    assert "device=cpu" in warning
    assert "compute_type=int8" in warning
    assert "was compute_type=auto" in warning


def test_auto_without_cuda_coerces_float16(monkeypatch):
    monkeypatch.setattr(dp, "_probe_cuda_runtime", lambda: False)
    device, ct, warning = dp.resolve_device_and_compute_type("auto", "float16")
    assert (device, ct) == ("cpu", "int8")
    assert warning is not None
    assert "was compute_type=float16" in warning


def test_auto_without_cuda_keeps_cpu_compatible_compute_type(monkeypatch):
    monkeypatch.setattr(dp, "_probe_cuda_runtime", lambda: False)
    device, ct, warning = dp.resolve_device_and_compute_type("auto", "int8")
    assert (device, ct) == ("cpu", "int8")
    assert warning is not None
    assert "compute_type=int8 (was compute_type=int8)" in warning

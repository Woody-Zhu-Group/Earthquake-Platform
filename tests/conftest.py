"""Let the suite run where PyTorch / tqdm are not installed (detect.py imports both at module level).

When torch is missing, ``services.change_detection.score`` is replaced by an inert stub so ``detect.py`` can be
imported and exercised with the stand-in scorer; tests that need the real model use ``pytest.importorskip("torch")``.
"""
import sys
import types

try:
    import torch  # noqa: F401
except ImportError:
    stub = types.ModuleType("services.change_detection.score")
    stub.ScoreModel = type("ScoreModel", (), {"__doc__": "stub: torch not installed"})
    sys.modules["services.change_detection.score"] = stub

try:
    import tqdm  # noqa: F401
except ImportError:
    shim = types.ModuleType("tqdm")
    shim.tqdm = lambda iterable=None, **kw: iterable
    sys.modules["tqdm"] = shim

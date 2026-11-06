"""Smoke and characterisation tests for the real ScoreModel. Skipped when PyTorch is not installed (CI installs it)."""
import numpy as np
import pytest

torch = pytest.importorskip("torch")
from services.change_detection.score import ScoreModel  # noqa: E402


def data(n=80, seed=0):
    rng = np.random.default_rng(seed)
    return np.column_stack([np.sort(rng.uniform(0, 1, n)), rng.uniform(0.05, 0.95, (n, 2))])


def test_fit_and_psi_are_finite_and_shaped():
    torch.manual_seed(0)
    model = ScoreModel(ndim=3, radius=0.1)
    d = data()
    model.fit(d, n_epochs=2, batch_size=32, lr=1e-3)
    psi = model.psi(d)
    assert psi.shape == (len(d),) and np.isfinite(psi).all()


def test_characterisation_zero_init_leaves_the_network_input_independent():
    """Documents analysis/ALGORITHM_NOTES.md #1. If you change the initialisation, this test should be updated.

    Every Linear layer in ``ff`` is zero-initialised, so hidden activations are 0 and every weight gradient is 0;
    only the final bias moves, and the LSTM receives no gradient at all.
    """
    torch.manual_seed(0)
    model = ScoreModel(ndim=3, radius=0.1)
    lstm_before = [p.detach().clone() for p in model.rn.parameters()]
    model.fit(data(), n_epochs=5, batch_size=32, lr=1e-2)
    linears = [m for m in model.ff if isinstance(m, torch.nn.Linear)]
    assert all(float(l.weight.abs().max()) == 0.0 for l in linears)
    assert any(float(linears[-1].bias.abs().max()) > 0 for _ in [0])
    assert all(torch.equal(a, b) for a, b in zip(lstm_before, model.rn.parameters()))


def test_fit_on_empty_data_is_a_no_op_not_a_crash():
    """detect.online() can refit f1 on an empty window; fit() used to raise inside find_index()."""
    model = ScoreModel(ndim=3, radius=0.1)
    model.fit(np.empty((0, 3)), n_epochs=1)
    assert float(model.base.abs().max()) == 0.0

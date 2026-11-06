"""A numpy stand-in for ``ScoreModel`` so the pipeline and detector can be tested without PyTorch.

``psi`` is minus a local event *rate*, so ``measure = psi0 - psi1`` is positive where f1's recent rate exceeds the
baseline rate in f0. It mimics the interface and the *direction* of the real model, nothing more; results produced
with it are flagged ``standin: true``.
"""
import numpy as np
from scipy.spatial.distance import cdist


class StandInScore:
    IS_STANDIN = True

    def __init__(self, ndim=3, radius=0.1, **kwargs):
        self.radius, self.xy, self.span = radius, np.empty((0, 2)), 1.0

    def fit(self, data, **kwargs):
        data = np.asarray(data, float).reshape(-1, 3)
        self.xy = data[:, 1:3]
        n = len(data)
        # for n points uniform on a window of length L, E[range] = L (n-1)/(n+1): invert it to avoid a biased-high rate
        self.span = max(float(np.ptp(data[:, 0])) * (n + 1) / (n - 1), 1e-2) if n > 2 else 1e-2

    def psi(self, data):
        data = np.asarray(data, float)
        if len(self.xy) == 0:
            return np.zeros(len(data))
        near = (cdist(data[:, 1:3], self.xy) < self.radius).sum(1)
        return -near / (self.span * np.pi * self.radius**2)

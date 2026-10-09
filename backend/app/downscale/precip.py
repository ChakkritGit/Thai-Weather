"""Stochastic sub-grid convective rainfall ensemble.

A 22 km model smears tropical convection – typically 5–20 km cells – into a
uniform drizzle over the whole grid box.  We restore realistic structure by
multiplying the (terrain-adjusted) rate by a random multiplicative cascade
that

* is spatially correlated at convective-cell scale,
* evolves with an AR(1) process and is advected by the steering wind, so the
  animation is temporally coherent,
* is intermittent (only part of the box rains) with a wet fraction that
  grows with rain rate and shrinks with instability (CAPE), and
* is an unbiased multiplicative cascade: every member conserves the
  driving model's rain *in expectation* at every cell, so the ensemble mean
  converges to the model total while individual members carry realistic
  peaks.

Running *K* members turns a single deterministic coarse value into a
fine-scale probability distribution: chance of rain, chance of heavy rain
and area coverage per province.
"""

from __future__ import annotations

import numpy as np
from scipy import ndimage
from scipy.special import ndtr, ndtri

MAX_RATE = 200.0  # mm/h


class PrecipEnsemble:
    def __init__(
        self,
        shape: tuple[int, int],
        members: int,
        coarse_ratio: float,
        seed: int,
        cell_sigma: float = 4.0,
        rho: float = 0.8,
    ) -> None:
        self.shape = shape
        self.members = members
        self.cell_sigma = cell_sigma
        self.rho = rho
        self.rng = np.random.default_rng(seed)
        self.noise = np.stack([self._fresh() for _ in range(members)])

    def _fresh(self) -> np.ndarray:
        n = ndimage.gaussian_filter(
            self.rng.standard_normal(self.shape).astype(np.float32), self.cell_sigma, mode="wrap"
        )
        return n / (n.std() + 1e-9)

    def step(self, target: np.ndarray, cape: np.ndarray, shift_cells: tuple[float, float]) -> np.ndarray:
        """Advance one hour and return member rain rates, shape (K, ny, nx)."""
        conv = np.clip(cape / 2500.0, 0.0, 1.0)
        wet_frac = np.clip((1.0 - np.exp(-target / 1.2)) * (1.0 - 0.45 * conv), 0.02, 0.98)
        z = ndtri(1.0 - wet_frac).astype(np.float32)
        spread = (0.5 + 0.55 * conv).astype(np.float32)
        # E[exp(s(n-z)) · 1{n>z}] for n ~ N(0,1): dividing by it makes every
        # member an unbiased estimate of the model's rain at every cell.
        expected = np.exp(0.5 * spread**2 - spread * z) * ndtr(spread - z)
        scale = target / np.maximum(expected, 1e-6)
        out = np.empty((self.members, *self.shape), dtype=np.float32)
        a = np.sqrt(1.0 - self.rho**2)
        for k in range(self.members):
            moved = ndimage.shift(self.noise[k], shift_cells, order=1, mode="wrap")
            self.noise[k] = self.rho * moved + a * self._fresh()
            n = self.noise[k]
            tex = np.where(n > z, np.exp(spread * (n - z)), 0.0).astype(np.float32)
            tex = ndimage.gaussian_filter(tex, 1.0, mode="nearest")  # soften cell edges
            out[k] = np.minimum(scale * tex, MAX_RATE)
        return out

    @staticmethod
    def exceedance(members: np.ndarray, threshold: float, neighbourhood: float = 3.0) -> np.ndarray:
        """Neighbourhood probability (%) that rain ≥ threshold."""
        frac = (members >= threshold).mean(axis=0).astype(np.float32)
        if neighbourhood > 0:
            frac = ndimage.gaussian_filter(frac, neighbourhood, mode="nearest")
        return np.clip(frac * 100.0, 0.0, 100.0)

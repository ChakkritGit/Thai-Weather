"""Radar echo motion by block phase correlation.

Two consecutive reflectivity frames are cut into overlapping blocks; for every block that
contains enough echo the shift that best aligns frame 1 onto frame 2 is found with FFT phase
correlation (sub-cell accuracy by parabolic peak interpolation).  Block vectors from the last
two frame pairs are averaged, gaps are filled with the median, the block field is smoothed and
interpolated back to the grid.  This is deliberately simple (advection only, no growth/decay):
easy to explain and to test, and good for the first 30-60 minutes.
"""

from __future__ import annotations

import numpy as np
from scipy import ndimage

from ..core.grid import KM_PER_DEG, Grid

BLOCK = 96  # cells (~210 km)
STRIDE = 48
MIN_ECHO_FRAC = 0.03  # share of block cells >= ECHO_DBZ required to trust a vector
ECHO_DBZ = 20.0
MAX_SPEED_KMH = 120.0
FLOOR_DBZ = 15.0  # reflectivity is taken relative to this floor before correlating


def _starts(n: int) -> list[int]:
    starts = list(range(0, max(n - BLOCK, 0) + 1, STRIDE))
    if starts[-1] + BLOCK < n:
        starts.append(n - BLOCK)
    return starts


def _intensity(dbz: np.ndarray) -> np.ndarray:
    return np.maximum(np.nan_to_num(dbz, nan=0.0) - FLOOR_DBZ, 0.0).astype(np.float32)


def _parabolic(c_minus: float, c0: float, c_plus: float) -> float:
    denom = c_minus - 2.0 * c0 + c_plus
    return 0.0 if abs(denom) < 1e-12 else 0.5 * (c_minus - c_plus) / denom


def _block_shift(a: np.ndarray, b: np.ndarray, max_cells: int, window: np.ndarray) -> tuple[float, float] | None:
    """Shift (rows, cols) that moves block ``a`` onto ``b``; None when no clear peak."""
    cross = np.fft.fft2(b * window) * np.conj(np.fft.fft2(a * window))
    mag = np.abs(cross)
    if mag.max() <= 0:
        return None
    corr = np.fft.ifft2(cross / (mag + 0.01 * mag.max())).real
    n0, n1 = corr.shape
    # only plausible displacements are searched (indices wrap: negative shifts sit at the end)
    allowed = np.zeros_like(corr, dtype=bool)
    idx = np.r_[0 : max_cells + 1, n0 - max_cells : n0]
    jdx = np.r_[0 : max_cells + 1, n1 - max_cells : n1]
    allowed[np.ix_(idx, jdx)] = True
    masked = np.where(allowed, corr, -np.inf)
    i, j = np.unravel_index(int(np.argmax(masked)), corr.shape)
    if not np.isfinite(masked[i, j]) or corr[i, j] <= 0:
        return None
    di = _parabolic(corr[(i - 1) % n0, j], corr[i, j], corr[(i + 1) % n0, j])
    dj = _parabolic(corr[i, (j - 1) % n1], corr[i, j], corr[i, (j + 1) % n1])
    si = i + di if i + di <= n0 / 2 else i + di - n0
    sj = j + dj if j + dj <= n1 / 2 else j + dj - n1
    return float(si), float(sj)


def _pair_vectors(
    f1: np.ndarray, f2: np.ndarray, raw2: np.ndarray, dt_min: float, grid: Grid, ys: list[int], xs: list[int]
) -> np.ndarray:
    """(2, nby, nbx) block vectors (u, v in km/h), NaN where unknown."""
    out = np.full((2, len(ys), len(xs)), np.nan, dtype=np.float32)
    window = np.outer(np.hanning(BLOCK), np.hanning(BLOCK)).astype(np.float32)
    dy_km = grid.dlat * KM_PER_DEG
    max_cells = int(np.ceil(MAX_SPEED_KMH * dt_min / 60.0 / dy_km)) + 1
    for bi, y0 in enumerate(ys):
        lat_mid = grid.lat0 + (y0 + BLOCK / 2) * grid.dlat
        dx_km = grid.dlon * KM_PER_DEG * np.cos(np.radians(lat_mid))
        for bj, x0 in enumerate(xs):
            sl = (slice(y0, y0 + BLOCK), slice(x0, x0 + BLOCK))
            if (raw2[sl] >= ECHO_DBZ).mean() < MIN_ECHO_FRAC:
                continue
            shift = _block_shift(f1[sl], f2[sl], max_cells, window)
            if shift is None:
                continue
            v = shift[0] * dy_km / (dt_min / 60.0)
            u = shift[1] * dx_km / (dt_min / 60.0)
            if np.hypot(u, v) <= MAX_SPEED_KMH:
                out[:, bi, bj] = (u, v)
    return out


def estimate_motion(frames: list[np.ndarray], dt_min: float, grid: Grid) -> tuple[np.ndarray, np.ndarray]:
    """Echo motion (u east, v north, km/h) on ``grid`` from the most recent frames.

    ``frames`` are dBZ grids (NaN = no echo), oldest first, ``dt_min`` apart.  With fewer
    than two frames, or no trackable echo, the field is zero.
    """
    zero = np.zeros(grid.shape, dtype=np.float32)
    if len(frames) < 2:
        return zero, zero.copy()
    ys, xs = _starts(grid.ny), _starts(grid.nx)
    pairs = list(zip(frames[:-1], frames[1:], strict=True))[-2:]
    vecs = np.stack(
        [
            _pair_vectors(_intensity(a), _intensity(b), np.nan_to_num(b, nan=-99.0), dt_min, grid, ys, xs)
            for a, b in pairs
        ]
    )
    ok = np.isfinite(vecs)
    count = ok.sum(axis=0)
    valid = count[0] > 0
    block = np.where(valid, np.where(ok, vecs, 0.0).sum(axis=0) / np.maximum(count, 1), np.nan).astype(np.float32)
    if not valid.any():
        return zero, zero.copy()
    for k in range(2):
        block[k][~valid] = np.median(block[k][valid])
        block[k] = ndimage.gaussian_filter(block[k], 1.0, mode="nearest")
    # bilinear interpolation of block centres to every grid cell
    cy, cx = _frac(grid.ny, ys), _frac(grid.nx, xs)
    yy, xx = np.meshgrid(cy, cx, indexing="ij")
    u = ndimage.map_coordinates(block[0], [yy, xx], order=1, mode="nearest").astype(np.float32)
    v = ndimage.map_coordinates(block[1], [yy, xx], order=1, mode="nearest").astype(np.float32)
    return u, v


def _frac(n: int, starts: list[int]) -> np.ndarray:
    """Fractional block index of every cell along one axis (block centres at start + BLOCK/2)."""
    centres = np.asarray(starts, dtype=np.float64) + BLOCK / 2
    return np.interp(np.arange(n), centres, np.arange(len(starts)))

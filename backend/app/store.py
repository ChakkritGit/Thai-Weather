"""On-disk store for forecast runs.

Each run lives in ``<data_dir>/runs/<run_id>/`` and is written to a temporary
directory first, then atomically renamed, so readers never see a partial
run.  Gridded layers are 8-bit memory-mapped arrays (see ``layers.py``):
a 48 h run of all layers at 2 km is ~150 MB on disk and almost nothing in
RAM.
"""

from __future__ import annotations

import json
import shutil
import threading
from datetime import datetime
from pathlib import Path

import numpy as np

from .core.grid import Grid
from .downscale.layers import LAYERS
from .sources.base import CoarseForecast

KEEP_RUNS = 3


def _grid_from(d: dict) -> Grid:
    return Grid(d["lat0"], d["lat1"], d["lon0"], d["lon1"], d["dlat"], d["dlon"])


class RunWriter:
    def __init__(self, root: Path, run_id: str, fine: Grid, coarse: CoarseForecast, n_days: int) -> None:
        self.root = root
        self.run_id = run_id
        self.tmp = root / f".tmp-{run_id}"
        if self.tmp.exists():
            shutil.rmtree(self.tmp)
        self.tmp.mkdir(parents=True)
        self.fine = fine
        self.coarse = coarse
        nt = len(coarse.times)
        self.arrays: dict[str, np.memmap] = {}
        for lid, lyr in LAYERS.items():
            n = n_days if lyr.daily else nt
            self.arrays[f"fine_{lid}"] = np.lib.format.open_memmap(
                self.tmp / f"fine_{lid}.npy", mode="w+", dtype=np.uint8, shape=(n, *fine.shape)
            )
            self.arrays[f"coarse_{lid}"] = np.lib.format.open_memmap(
                self.tmp / f"coarse_{lid}.npy", mode="w+", dtype=np.uint8, shape=(n, *coarse.grid.shape)
            )
        np.savez_compressed(self.tmp / "coarse_raw.npz", orography=coarse.orography, **coarse.fields)

    def write(self, res: str, layer: str, index: int, values: np.ndarray) -> None:
        self.arrays[f"{res}_{layer}"][index] = LAYERS[layer].encoding.encode(values)

    def finish(self, meta: dict, provinces: dict) -> Path:
        for a in self.arrays.values():
            a.flush()
        self.arrays.clear()
        (self.tmp / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, default=str))
        (self.tmp / "provinces.json").write_text(json.dumps(provinces, ensure_ascii=False))
        final = self.root / self.run_id
        if final.exists():
            shutil.rmtree(final)
        self.tmp.rename(final)
        (self.root / "LATEST").write_text(self.run_id)
        self._cleanup()
        return final

    def abort(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _cleanup(self) -> None:
        runs = sorted(p for p in self.root.iterdir() if p.is_dir() and not p.name.startswith("."))
        for old in runs[:-KEEP_RUNS]:
            shutil.rmtree(old, ignore_errors=True)


class Run:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.meta: dict = json.loads((path / "meta.json").read_text())
        self.provinces: dict = json.loads((path / "provinces.json").read_text())
        self.fine_grid = _grid_from(self.meta["fine_grid"])
        self.coarse_grid = _grid_from(self.meta["coarse_grid"])
        self.times = [datetime.fromisoformat(t) for t in self.meta["times"]]
        self._arrays: dict[str, np.ndarray] = {}
        self._coarse_raw: dict[str, np.ndarray] | None = None

    @property
    def run_id(self) -> str:
        return self.meta["run_id"]

    def array(self, res: str, layer: str) -> np.ndarray:
        key = f"{res}_{layer}"
        if key not in self._arrays:
            self._arrays[key] = np.load(self.path / f"{key}.npy", mmap_mode="r")
        return self._arrays[key]

    def coarse_raw(self) -> dict[str, np.ndarray]:
        if self._coarse_raw is None:
            with np.load(self.path / "coarse_raw.npz") as z:
                self._coarse_raw = {k: z[k] for k in z.files}
        return self._coarse_raw

    def series(self, res: str, layer: str, iy: int, ix: int) -> list[float]:
        codes = np.asarray(self.array(res, layer)[:, iy, ix])
        return [round(float(v), 2) for v in LAYERS[layer].encoding.decode(codes)]


class RunStore:
    def __init__(self, data_dir: Path) -> None:
        self.root = data_dir / "runs"
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._latest: Run | None = None

    def writer(self, run_id: str, fine: Grid, coarse: CoarseForecast, n_days: int) -> RunWriter:
        return RunWriter(self.root, run_id, fine, coarse, n_days)

    def latest(self) -> Run | None:
        pointer = self.root / "LATEST"
        if not pointer.exists():
            return None
        run_id = pointer.read_text().strip()
        with self._lock:
            if self._latest is None or self._latest.run_id != run_id:
                path = self.root / run_id
                if not (path / "meta.json").exists():
                    return self._latest
                self._latest = Run(path)
            return self._latest

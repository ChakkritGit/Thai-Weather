"""RainViewer radar ingest: Web-Mercator PNG tiles -> reflectivity (dBZ) on the app grid.

The free RainViewer API only serves *coloured* tiles (scheme 2, "Universal Blue").  With
smoothing off, each integer dBZ has exactly one RGBA value, so the palette can be inverted
back to reflectivity (``data/rainviewer_universal_blue.json``, built by
``scripts/build_rainviewer_palette.py``).  Tiles are mosaicked and resampled (nearest) onto
the fine grid; the grid -> mosaic pixel mapping is cached per (grid, zoom).
"""

from __future__ import annotations

import io
import json
import logging
import math
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import cache

import httpx
import numpy as np
from PIL import Image

from ..core.grid import Grid
from ..core.static import DATA_DIR

log = logging.getLogger(__name__)

API_URL = "https://api.rainviewer.com/public/weather-maps.json"
TILE = 256
COVERAGE_TTL_S = 24 * 3600


def _tile_xy(lat: np.ndarray | float, lon: np.ndarray | float, zoom: int) -> tuple[np.ndarray, np.ndarray]:
    """Fractional Web-Mercator tile coordinates (x east, y south)."""
    n = 2**zoom
    x = (np.asarray(lon, dtype=np.float64) + 180.0) / 360.0 * n
    y = (1.0 - np.arcsinh(np.tan(np.radians(lat))) / math.pi) / 2.0 * n
    return x, y


def tiles_for(grid: Grid, zoom: int = 6) -> list[tuple[int, int]]:
    """Tiles (x, y) covering the grid, row-major from the north-west corner."""
    x0, y0 = _tile_xy(grid.lat1, grid.lon0, zoom)  # north-west
    x1, y1 = _tile_xy(grid.lat0, grid.lon1, zoom)  # south-east
    xs = range(int(math.floor(x0)), int(math.floor(x1)) + 1)
    ys = range(int(math.floor(y0)), int(math.floor(y1)) + 1)
    return [(x, y) for y in ys for x in xs]


@cache
def _pixel_index(grid: Grid, zoom: int) -> tuple[np.ndarray, np.ndarray, tuple[int, int]]:
    """Mosaic row per grid row and column per grid column, plus the origin tile of the mosaic."""
    tiles = tiles_for(grid, zoom)
    tx0, ty0 = min(t[0] for t in tiles), min(t[1] for t in tiles)
    ntx, nty = max(t[0] for t in tiles) - tx0 + 1, max(t[1] for t in tiles) - ty0 + 1
    fx, _ = _tile_xy(grid.lat0, grid.lons, zoom)
    _, fy = _tile_xy(grid.lats, grid.lon0, zoom)
    cols = np.clip(np.floor((fx - tx0) * TILE), 0, ntx * TILE - 1).astype(np.int32)
    rows = np.clip(np.floor((fy - ty0) * TILE), 0, nty * TILE - 1).astype(np.int32)
    return rows, cols, (tx0, ty0)


@dataclass
class Palette:
    """RGBA -> dBZ lookup (exact match, nearest-RGB fallback for unknown opaque colours)."""

    keys: np.ndarray  # uint32, sorted
    dbz: np.ndarray  # float32, aligned with keys
    rgb: np.ndarray  # (n, 3) float32, aligned with keys
    unknown_pixels: int = 0

    @staticmethod
    def _pack(rgba: np.ndarray) -> np.ndarray:
        a = rgba.astype(np.uint32)
        return (a[..., 0] << 24) | (a[..., 1] << 16) | (a[..., 2] << 8) | a[..., 3]

    @classmethod
    def load(cls) -> Palette:
        raw = json.loads((DATA_DIR / "rainviewer_universal_blue.json").read_text())["rain"]
        colours = np.array([[int(h[i : i + 2], 16) for i in (1, 3, 5, 7)] for h in raw], dtype=np.uint8)
        dbz = np.array(list(raw.values()), dtype=np.float32)
        keys = cls._pack(colours)
        order = np.argsort(keys)
        return cls(keys[order], dbz[order], colours[order, :3].astype(np.float32))

    def colour(self, dbz: int) -> tuple[int, int, int, int]:
        """RGBA of a palette entry (used by tests and tooling)."""
        k = int(self.keys[int(np.flatnonzero(self.dbz == dbz)[0])])
        return (k >> 24) & 255, (k >> 16) & 255, (k >> 8) & 255, k & 255

    def decode(self, rgba: np.ndarray) -> np.ndarray:
        """dBZ per pixel; NaN where the pixel is transparent (no echo)."""
        keys = self._pack(rgba)
        out = np.full(keys.shape, np.nan, dtype=np.float32)
        opaque = rgba[..., 3] > 0
        if not opaque.any():
            return out
        uniq, inverse = np.unique(keys[opaque], return_inverse=True)
        pos = np.clip(np.searchsorted(self.keys, uniq), 0, len(self.keys) - 1)
        exact = self.keys[pos] == uniq
        values = self.dbz[pos].copy()
        if not exact.all():
            miss = uniq[~exact]
            rgb = np.stack([(miss >> 24) & 255, (miss >> 16) & 255, (miss >> 8) & 255], axis=-1).astype(np.float32)
            nearest = np.argmin(((rgb[:, None, :] - self.rgb[None, :, :]) ** 2).sum(axis=-1), axis=1)
            values[~exact] = self.dbz[nearest]
            n_unknown = int(np.bincount(inverse, minlength=len(uniq))[~exact].sum())
            self.unknown_pixels += n_unknown
            log.debug("radar: %d pixels with colours outside the palette", n_unknown)
        out[opaque] = values[inverse]
        return out


@cache
def default_palette() -> Palette:
    return Palette.load()


class RadarSource:
    """Fetches RainViewer frames and converts them to dBZ grids."""

    name = "rainviewer"

    def __init__(
        self,
        client: httpx.Client | None = None,
        zoom: int = 6,
        api_url: str = API_URL,
        palette: Palette | None = None,
    ) -> None:
        self.client = client or httpx.Client(timeout=30.0)
        self.zoom = zoom
        self.api_url = api_url
        self.palette = palette or default_palette()
        self.host = "https://tilecache.rainviewer.com"
        self._coverage: tuple[float, Grid, np.ndarray] | None = None

    def frames(self) -> list[tuple[datetime, str]]:
        """Past radar frames (oldest first) as (time UTC, path); also records the tile host."""
        resp = self.client.get(self.api_url)
        resp.raise_for_status()
        body = resp.json()
        self.host = body.get("host", self.host)
        past = body.get("radar", {}).get("past", [])
        return sorted((datetime.fromtimestamp(f["time"], UTC), f["path"]) for f in past)

    def _mosaic(self, urls: dict[tuple[int, int], str], grid: Grid) -> np.ndarray:
        """Download the tiles and sample them on the grid -> RGBA (ny, nx, 4)."""
        rows, cols, (tx0, ty0) = _pixel_index(grid, self.zoom)
        tiles = tiles_for(grid, self.zoom)
        ntx, nty = max(t[0] for t in tiles) - tx0 + 1, max(t[1] for t in tiles) - ty0 + 1
        mosaic = np.zeros((nty * TILE, ntx * TILE, 4), dtype=np.uint8)
        for x, y in tiles:
            resp = self.client.get(urls[(x, y)])
            resp.raise_for_status()  # a missing tile must not look like "no rain"
            img = np.asarray(Image.open(io.BytesIO(resp.content)).convert("RGBA"))
            r0, c0 = (y - ty0) * TILE, (x - tx0) * TILE
            mosaic[r0 : r0 + TILE, c0 : c0 + TILE] = img[:TILE, :TILE]
        return mosaic[rows[:, None], cols[None, :]]

    def fetch_frame(self, host: str, path: str, grid: Grid) -> np.ndarray:
        """Reflectivity (dBZ, float32) on ``grid``; NaN where there is no echo."""
        urls = {(x, y): f"{host}{path}/{TILE}/{self.zoom}/{x}/{y}/2/0_0.png" for x, y in tiles_for(grid, self.zoom)}
        return self.palette.decode(self._mosaic(urls, grid))

    def coverage(self, grid: Grid) -> np.ndarray:
        """Bool mask, True where a radar covers the cell (tile transparent = covered, black = not)."""
        now = time.monotonic()
        if self._coverage and self._coverage[1] == grid and now - self._coverage[0] < COVERAGE_TTL_S:
            return self._coverage[2]
        base = f"{self.host}/v2/coverage/0/{TILE}/{self.zoom}"
        urls = {(x, y): f"{base}/{x}/{y}/0/0_0.png" for x, y in tiles_for(grid, self.zoom)}
        covered = self._mosaic(urls, grid)[..., 3] == 0
        self._coverage = (now, grid, covered)
        return covered

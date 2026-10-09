import io
import json
from datetime import UTC, datetime

import httpx
import numpy as np
from PIL import Image

from app.core.grid import FINE_GRID
from app.core.static import DATA_DIR
from app.nowcast.radar import TILE, Palette, RadarSource, _tile_xy, default_palette, tiles_for

HOST = "https://tiles.test"
PATH = "/v2/radar/abc"
PAINT = (13.75, 100.5)  # Bangkok


def _png(arr: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(arr, "RGBA").save(buf, format="PNG")
    return buf.getvalue()


def _paint(rgba: tuple[int, int, int, int], zoom: int = 6) -> dict[tuple[int, int], np.ndarray]:
    """Transparent tiles with a 5x5 px block of ``rgba`` at PAINT."""
    tiles = {t: np.zeros((TILE, TILE, 4), dtype=np.uint8) for t in tiles_for(FINE_GRID, zoom)}
    fx, fy = _tile_xy(PAINT[0], PAINT[1], zoom)
    tx, ty = int(fx), int(fy)
    px, py = int((fx - tx) * TILE), int((fy - ty) * TILE)
    tiles[(tx, ty)][py - 2 : py + 3, px - 2 : px + 3] = rgba
    return tiles


def _handler(tiles: dict[tuple[int, int], np.ndarray], coverage: dict[tuple[int, int], np.ndarray] | None = None):
    def handle(request: httpx.Request) -> httpx.Response:
        url = request.url
        if url.path.endswith("weather-maps.json"):
            body = {
                "host": HOST,
                "radar": {"past": [{"time": 1791525600, "path": PATH}, {"time": 1791525000, "path": "/v2/radar/old"}]},
            }
            return httpx.Response(200, json=body)
        parts = url.path.strip("/").split("/")
        z, x, y = int(parts[-5]), int(parts[-4]), int(parts[-3])
        assert z == 6
        if "coverage" in url.path:
            assert coverage is not None
            return httpx.Response(200, content=_png(coverage[(x, y)]))
        assert url.path.endswith("/2/0_0.png") and PATH in url.path
        return httpx.Response(200, content=_png(tiles[(x, y)]))

    return handle


def _source(tiles, coverage=None) -> RadarSource:
    return RadarSource(client=httpx.Client(transport=httpx.MockTransport(_handler(tiles, coverage))))


def test_palette_file_is_usable():
    raw = json.loads((DATA_DIR / "rainviewer_universal_blue.json").read_text())
    assert len(raw["rain"]) >= 70
    assert "#00000000" not in raw["rain"]
    assert raw["rain"]["#ff4400ff"] == 45


def test_tiles_cover_the_app_domain():
    tiles = tiles_for(FINE_GRID, 6)
    assert sorted({x for x, _ in tiles}) == [49, 50]
    assert sorted({y for _, y in tiles}) == [28, 29, 30, 31]
    assert len(tiles) == 8


def test_frames_are_sorted_and_host_recorded():
    src = _source({})
    frames = src.frames()
    assert [f[1] for f in frames] == ["/v2/radar/old", PATH]
    assert frames[-1][0] == datetime.fromtimestamp(1791525600, UTC)
    assert src.host == HOST


def test_decodes_known_colour_at_known_location():
    pal = default_palette()
    src = _source(_paint(pal.colour(45)))
    dbz = src.fetch_frame(HOST, PATH, FINE_GRID)
    assert dbz.shape == FINE_GRID.shape and dbz.dtype == np.float32
    iy, ix = FINE_GRID.index(*PAINT)
    window = dbz[iy - 1 : iy + 2, ix - 1 : ix + 2]
    assert np.nanmax(window) == 45
    # everything that is not the painted block is "no echo"
    assert np.isnan(dbz).mean() > 0.999
    ys, xs = np.where(~np.isnan(dbz))
    assert abs(ys.mean() - iy) <= 1 and abs(xs.mean() - ix) <= 1


def test_transparent_is_nan_and_unknown_colour_snaps_to_nearest():
    src = _source(_paint((0, 0, 0, 0)))
    assert np.isnan(src.fetch_frame(HOST, PATH, FINE_GRID)).all()

    near_45 = (0xFF, 0x45, 0x02, 0xFF)  # one step off the 45 dBZ colour
    src = _source(_paint(near_45))
    dbz = src.fetch_frame(HOST, PATH, FINE_GRID)
    assert np.nanmax(dbz) == 45
    assert src.palette.unknown_pixels > 0


def test_coverage_transparent_is_covered_black_is_not():
    tiles = _paint((0, 0, 0, 0))
    cov = {t: np.zeros((TILE, TILE, 4), dtype=np.uint8) for t in tiles}
    # northernmost tile row: opaque black = outside radar coverage
    for (_x, y), arr in cov.items():
        if y == 28:
            arr[:] = (0, 0, 0, 255)
    src = _source(tiles, cov)
    mask = src.coverage(FINE_GRID)
    assert mask.shape == FINE_GRID.shape and mask.dtype == bool
    assert not mask[-1, :].any()  # lat 20.5 N lies in tile row 28
    assert mask[0, :].all()  # lat 5.5 N is covered
    assert src.coverage(FINE_GRID) is mask  # cached


def test_palette_decode_handles_semi_transparent_low_echo():
    pal = Palette.load()
    rgba = np.array([[pal.colour(-5), (0, 0, 0, 0)]], dtype=np.uint8)
    out = pal.decode(rgba)
    assert out[0, 0] == -5 and np.isnan(out[0, 1])

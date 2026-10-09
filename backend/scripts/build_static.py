"""Build the static high-resolution layers used by the downscaling engine.

Outputs (written to ``app/data``):

* ``static_th.npz``      – terrain (mean + sub-grid std-dev), land mask, Thailand
                           mask and province index on the fine analysis grid.
* ``provinces.json``     – province metadata (ISO code, Thai/English names,
                           forecast region, centroid).
* ``geo/provinces.geojson`` and ``geo/countries.geojson`` – simplified outlines
                           for the web map.

Data sources (downloaded once, cached under ``--cache``):

* Terrain: AWS Terrain Tiles (Terrarium encoding, zoom 8 ≈ 600 m), derived from
  SRTM / GMTED / ETOPO.  https://registry.opendata.aws/terrain-tiles/
* Boundaries: Natural Earth 1:10m admin-0 and admin-1 (public domain).

Run:  python scripts/build_static.py --cache /tmp/thwx-cache
Requires the ``build`` extra (shapely); pillow is a runtime dependency.
"""

from __future__ import annotations

import argparse
import io
import json
import math
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.grid import FINE_GRID  # noqa: E402
from app.core.provinces_meta import PROVINCES_TH, region_for  # noqa: E402

TERRARIUM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
NE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/{name}.geojson"
ZOOM = 8
SUBSAMPLE = 4  # sub-samples per fine cell edge for mean / std-dev
NEIGHBOURS = {"MMR", "LAO", "KHM", "MYS", "VNM", "THA", "CHN"}

DATA_DIR = Path(__file__).resolve().parents[1] / "app" / "data"


def fetch(url: str, dest: Path) -> Path:
    if not dest.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        print(f"  downloading {url}")
        for attempt in range(5):
            try:
                with urllib.request.urlopen(url, timeout=120) as r:  # noqa: S310 (fixed hosts)
                    dest.write_bytes(r.read())
                break
            except OSError:
                if attempt == 4:
                    raise
                time.sleep(2**attempt)
    return dest


def lonlat_to_pixel(lon: np.ndarray, lat: np.ndarray, z: int) -> tuple[np.ndarray, np.ndarray]:
    n = 256 * 2**z
    x = (lon + 180.0) / 360.0 * n
    lat_r = np.radians(lat)
    y = (1.0 - np.log(np.tan(lat_r) + 1.0 / np.cos(lat_r)) / math.pi) / 2.0 * n
    return x, y


def build_terrain(cache: Path) -> tuple[np.ndarray, np.ndarray]:
    from PIL import Image

    g = FINE_GRID
    # sub-sample points (cell-centred) for every fine cell
    off = (np.arange(SUBSAMPLE) + 0.5) / SUBSAMPLE - 0.5
    lats = (g.lats[:, None] + off[None, :] * g.dlat).ravel()
    lons = (g.lons[:, None] + off[None, :] * g.dlon).ravel()
    px, _ = lonlat_to_pixel(lons, np.zeros_like(lons), ZOOM)
    _, py = lonlat_to_pixel(np.zeros_like(lats), lats, ZOOM)

    tx0, tx1 = int(px.min() // 256), int(px.max() // 256)
    ty0, ty1 = int(py.min() // 256), int(py.max() // 256)
    mosaic = np.zeros(((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256), dtype=np.float32)
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            f = fetch(TERRARIUM.format(z=ZOOM, x=tx, y=ty), cache / f"terrarium/{ZOOM}/{tx}/{ty}.png")
            rgb = np.asarray(Image.open(io.BytesIO(f.read_bytes())).convert("RGB"), dtype=np.float32)
            elev = rgb[..., 0] * 256.0 + rgb[..., 1] + rgb[..., 2] / 256.0 - 32768.0
            mosaic[(ty - ty0) * 256 : (ty - ty0 + 1) * 256, (tx - tx0) * 256 : (tx - tx0 + 1) * 256] = elev

    from scipy.ndimage import map_coordinates

    yy = (py - ty0 * 256 - 0.5)[:, None] * np.ones((1, lons.size))
    xx = np.ones((lats.size, 1)) * (px - tx0 * 256 - 0.5)[None, :]
    samples = map_coordinates(mosaic, [yy, xx], order=1, mode="nearest")
    samples = samples.reshape(g.ny, SUBSAMPLE, g.nx, SUBSAMPLE)
    return samples.mean(axis=(1, 3)), samples.std(axis=(1, 3))


def rasterize(geoms: list, g=FINE_GRID) -> np.ndarray:
    """Return an index raster (0 = none, i+1 = geoms[i])."""
    import shapely

    lon2, lat2 = np.meshgrid(g.lons, g.lats)
    out = np.zeros((g.ny, g.nx), dtype=np.uint8)
    for i, geom in enumerate(geoms):
        shapely.prepare(geom)
        out[shapely.contains_xy(geom, lon2, lat2)] = i + 1
    return out


def main() -> None:
    import shapely
    from shapely.geometry import box, mapping, shape

    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", type=Path, default=Path("/tmp/thwx-cache"))
    args = ap.parse_args()

    print("terrain …")
    elev, elev_std = build_terrain(args.cache)

    print("boundaries …")
    a0 = json.loads(fetch(NE.format(name="ne_10m_admin_0_countries"), args.cache / "admin0.geojson").read_text())
    a1 = json.loads(fetch(NE.format(name="ne_10m_admin_1_states_provinces"), args.cache / "admin1.geojson").read_text())

    g = FINE_GRID
    bbox = box(g.lon0 - 1, g.lat0 - 1, g.lon1 + 1, g.lat1 + 1)
    countries = [
        (f["properties"]["ADM0_A3"], shape(f["geometry"]))
        for f in a0["features"]
        if f["properties"]["ADM0_A3"] in NEIGHBOURS
    ]
    land = rasterize([geom for _, geom in countries]) > 0
    thai = rasterize([geom for code, geom in countries if code == "THA"]) > 0

    provs = sorted(
        (f for f in a1["features"] if f["properties"].get("adm0_a3") == "THA"),
        key=lambda f: f["properties"]["iso_3166_2"],
    )
    prov_geoms = [shape(f["geometry"]) for f in provs]
    prov_idx = rasterize(prov_geoms)
    # coastal cells of Thailand that fall between province polygons → nearest province
    from scipy.ndimage import distance_transform_edt

    missing = thai & (prov_idx == 0)
    if missing.any():
        _, (iy, ix) = distance_transform_edt(prov_idx == 0, return_indices=True)
        prov_idx[missing] = prov_idx[iy[missing], ix[missing]]

    meta = []
    features = []
    for i, (f, geom) in enumerate(zip(provs, prov_geoms, strict=False)):
        iso = f["properties"]["iso_3166_2"]
        th, en = PROVINCES_TH[iso]
        c = geom.representative_point()
        cells = int((prov_idx == i + 1).sum())
        meta.append(
            {
                "id": iso,
                "index": i + 1,
                "name_th": th,
                "name_en": en,
                "region": region_for(iso),
                "lat": round(c.y, 4),
                "lon": round(c.x, 4),
                "cells": cells,
            }
        )
        simple = shapely.set_precision(geom.simplify(0.008, preserve_topology=True), 0.0001)
        features.append(
            {
                "type": "Feature",
                "properties": {"id": iso, "name_th": th, "name_en": en, "region": region_for(iso)},
                "geometry": mapping(simple),
            }
        )

    country_features = []
    for code, geom in countries:
        clipped = geom.intersection(bbox)
        if clipped.is_empty:
            continue
        simple = shapely.set_precision(clipped.simplify(0.01, preserve_topology=True), 0.0001)
        country_features.append({"type": "Feature", "properties": {"code": code}, "geometry": mapping(simple)})

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    (DATA_DIR / "geo").mkdir(exist_ok=True)
    np.savez_compressed(
        DATA_DIR / "static_th.npz",
        elev=np.round(elev).astype(np.int16),
        elev_std=np.round(np.clip(elev_std, 0, 3000)).astype(np.int16),
        land=land.astype(np.uint8),
        thai=thai.astype(np.uint8),
        province=prov_idx,
        grid=np.array([g.lat0, g.lat1, g.lon0, g.lon1, g.dlat, g.dlon]),
    )
    (DATA_DIR / "provinces.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1))
    (DATA_DIR / "geo" / "provinces.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False, separators=(",", ":"))
    )
    (DATA_DIR / "geo" / "countries.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": country_features}, separators=(",", ":"))
    )
    print(
        f"done: grid {g.ny}x{g.nx}, elev {elev.min():.0f}..{elev.max():.0f} m, "
        f"thai cells {int(thai.sum())}, provinces {len(meta)}"
    )


if __name__ == "__main__":
    main()

"""Build the offline Thai place index from GeoNames (CC BY 4.0).

Download https://download.geonames.org/export/dump/TH.zip outside the repository, then run:
    python scripts/build_places.py /tmp/TH.zip
Only the compact, derived JSON is committed. No network calls are made by the API.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.provinces_meta import PROVINCES_TH  # noqa: E402

SOURCE = "https://download.geonames.org/export/dump/TH.zip"
OUTPUT = Path(__file__).resolve().parents[1] / "app" / "data" / "places.json"
THAI = re.compile(r"[\u0e00-\u0e7f]")
ENGLISH = re.compile(r"[A-Za-z][A-Za-z0-9 .,'()/-]*\Z")
PREFIX = re.compile(r"^(?:Changwat |Amphoe |Khet |จังหวัด|อำเภอ|เขต)\s*")
PROVINCE_NAMES = {re.sub(r"[^a-z]", "", en.lower()): th for th, en in PROVINCES_TH.values()}


def names(row: list[str]) -> tuple[str, str, list[str]]:
    candidates = [row[1], row[2], *row[3].split(",")]
    thai = list(dict.fromkeys(n.strip() for n in candidates if THAI.search(n) and not re.search(r"[A-Za-z]", n)))
    # Administrative prefixes are useful aliases, but the shorter name fits the result list.
    name_th = min((PREFIX.sub("", n) for n in thai), key=len, default="")
    name_en = PREFIX.sub("", row[2] or row[1])
    canonical = PROVINCE_NAMES.get(re.sub(r"[^a-z]", "", name_en.lower()))
    if canonical and canonical in [PREFIX.sub("", n) for n in thai]:
        name_th = canonical
    aliases = sorted({n for n in candidates if n and (n in thai or ENGLISH.fullmatch(n))} - {name_th, name_en})
    return name_th, name_en, aliases


def build(archive: Path) -> dict:
    with zipfile.ZipFile(archive) as z, z.open("TH.txt") as f:
        rows = [r for r in csv.reader(io.TextIOWrapper(f, encoding="utf-8"), delimiter="\t") if len(r) == 19]
    provinces, districts, places = {}, {}, []
    for r in rows:
        if r[8] != "TH" or not (r[6] == "P" or r[7] in ("ADM1", "ADM2")):
            continue
        lat, lon = float(r[4]), float(r[5])
        if not (5.5 <= lat <= 20.5 and 97.3 <= lon <= 105.7):
            continue
        th, en, aliases = names(r)
        if r[7] == "ADM1":
            provinces[r[10]] = [th, en]
        elif r[7] == "ADM2":
            districts[f"{r[10]}.{r[11]}"] = [th, en]
        places.append([int(r[0]), th, en, round(lat, 5), round(lon, 5), r[7], r[10], r[11], int(r[14] or 0), aliases])
    places.sort(key=lambda p: p[0])
    return {
        "source": SOURCE,
        "attribution": "GeoNames",
        "license": "CC BY 4.0",
        "columns": ["id", "name_th", "name_en", "lat", "lon", "feature", "admin1", "admin2", "population", "aliases"],
        "provinces": provinces,
        "districts": districts,
        "places": places,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args()
    data = build(args.archive)
    places = data.pop("places")
    encode = lambda value: json.dumps(value, ensure_ascii=False, separators=(",", ":"))  # noqa: E731
    args.output.write_text(
        encode(data)[:-1] + ',"places":[\n' + ",\n".join(encode(p) for p in places) + "]}\n", encoding="utf-8"
    )
    print(
        f"Wrote {len(places):,} places, {len(data['provinces'])} provinces, {len(data['districts'])} districts to {args.output}"
    )


if __name__ == "__main__":
    main()

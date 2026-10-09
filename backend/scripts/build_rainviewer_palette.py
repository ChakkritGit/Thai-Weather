"""Build ``app/data/rainviewer_universal_blue.json`` – the RainViewer colour → dBZ lookup.

RainViewer only serves coloured PNG tiles (no raw reflectivity any more), but the
"Universal Blue" scheme with smoothing off uses exactly one RGBA value per integer dBZ.
Inverting that table gives us dBZ back, so the radar nowcast works on real reflectivity.
The table is published as a CSV; this script downloads it once and commits the result so
tests and deployments never need the network.

    python scripts/build_rainviewer_palette.py
"""

from __future__ import annotations

import csv
import io
import json
from datetime import UTC, datetime
from pathlib import Path

import httpx

URL = "https://www.rainviewer.com/files/rainviewer_api_colors_table.csv"
OUT = Path(__file__).resolve().parents[1] / "app" / "data" / "rainviewer_universal_blue.json"
COLUMN = "Universal Blue"


def parse(text: str) -> dict[str, int]:
    """Rain block only (the CSV repeats dBZ -32..95 a second time for snow).

    Several dBZ values share one colour at the top of the scale; the lowest dBZ wins.
    """
    rows = list(csv.reader(io.StringIO(text)))
    header, body = rows[0], rows[1:]
    col = header.index(COLUMN)
    palette: dict[str, int] = {}
    seen_max = False
    for row in body:
        dbz = int(row[0])
        if dbz == 95:
            seen_max = True
        elif seen_max and dbz == -32:
            break  # start of the snow block
        colour = row[col].lower()
        if colour[7:] == "00":
            continue  # fully transparent = no echo
        palette.setdefault(colour, dbz)
    return palette


def main() -> None:
    resp = httpx.get(URL, timeout=30.0, follow_redirects=True)
    resp.raise_for_status()
    palette = parse(resp.text)
    OUT.write_text(
        json.dumps({"source": URL, "fetched": datetime.now(UTC).date().isoformat(), "rain": palette}, indent=0) + "\n"
    )
    print(f"wrote {len(palette)} colours to {OUT}")


if __name__ == "__main__":
    main()

"""Weather scales & categorical thresholds generated from the design tokens.

``app/data/weather_scales.json`` is produced by
``design-system/scripts/build-tokens.mjs`` so the thresholds used by alerts
and the colours used by the map always come from one source of truth.
"""

from __future__ import annotations

import json
from functools import cache
from pathlib import Path

DATA = Path(__file__).resolve().parents[1] / "data" / "weather_scales.json"


@cache
def weather_scales() -> dict:
    return json.loads(DATA.read_text())


def categorise(category: str, value: float) -> dict | None:
    """Return the matching level (``min`` ≤ value ≤ ``max``) or None."""
    best = None
    for lvl in weather_scales()["categories"][category]["levels"]:
        lo = lvl.get("min", float("-inf"))
        hi = lvl.get("max", float("inf"))
        if lo <= value <= hi:
            best = lvl
    return best

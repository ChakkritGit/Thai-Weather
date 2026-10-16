"""Offline GeoNames search; cached independently of forecast runs and external services."""

from __future__ import annotations

import json
import re
import unicodedata
from functools import cache, lru_cache
from heapq import nsmallest
from pathlib import Path

ATTRIBUTION = {"name": "GeoNames", "url": "https://www.geonames.org/", "license": "CC BY 4.0"}
NON_SEARCH = re.compile(r"[^a-z0-9\u0e00-\u0e7f]")


def normalise(text: str) -> str:
    """Ignore Latin accents, case and separators while preserving Thai vowel/tone marks."""
    return NON_SEARCH.sub("", unicodedata.normalize("NFKD", text.casefold()))


@cache
def _index() -> tuple[dict, list[tuple[list, tuple[str, ...]]]]:
    data = json.loads((Path(__file__).resolve().parents[1] / "data" / "places.json").read_text(encoding="utf-8"))
    entries = []
    for p in data.pop("places"):
        keys = tuple(dict.fromkeys(normalise(n) for n in (p[1], p[2], *p[9]) if n))
        entries.append((p, keys))
    return data, entries


@lru_cache(maxsize=256)
def _search(query: str) -> list[dict]:
    if len(query) < 2:
        return []
    data, entries = _index()

    def matches():
        for p, keys in entries:
            # Exact names, then prefixes, then contains; favor towns with known populations.
            rank = min((0 if k == query else 1 if k.startswith(query) else 2 for k in keys if query in k), default=3)
            if rank < 3:
                kind = "province" if p[5] == "ADM1" else "district" if p[5] == "ADM2" else "place"
                yield (rank, {"place": 0, "province": 1, "district": 2}[kind], -p[8], p[0]), p, kind

    found = nsmallest(10, matches(), key=lambda m: m[0])
    results = []
    for _, p, kind in found:
        province = data["provinces"].get(p[6], ["", ""])
        district = data["districts"].get(f"{p[6]}.{p[7]}", ["", ""])
        results.append(
            {
                "id": p[0],
                "name_th": p[1],
                "name_en": p[2],
                "lat": p[3],
                "lon": p[4],
                "kind": kind,
                "province_th": province[0],
                "province_en": province[1],
                "district_th": district[0],
                "district_en": district[1],
            }
        )
    return results


def search_places(query: str) -> list[dict]:
    return _search(normalise(query))

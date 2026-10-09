"""Rule-based impact alerts per province and day.

Thresholds and wording come from ``weather_scales.json`` (design tokens):
heat-index levels of the Thai Department of Health, TMD rainfall-amount and
temperature terms, Beaufort wind classes.  A level only raises an alert when
its token entry has ``severity`` ≥ 1.
"""

from __future__ import annotations

from .scales import categorise

# day-summary field → category in weather_scales.json
RULES: list[tuple[str, str, str]] = [
    ("heat", "heat_max", "heatIndex"),
    ("rain", "rain_p95", "rainDaily"),
    ("storm", "storm_max", "thunder"),
    ("wind", "wind_max", "wind"),
    ("hot", "tmax", "tempMax"),
    ("cold", "tmin", "tempMin"),
]


def province_alerts(day: dict) -> list[dict]:
    alerts = []
    for hazard, field, category in RULES:
        value = day.get(field)
        if value is None:
            continue
        lvl = categorise(category, value)
        if lvl and lvl.get("severity", 0) >= 1:
            alerts.append(
                {
                    "hazard": hazard,
                    "level": lvl["id"],
                    "severity": lvl["severity"],
                    "value": value,
                    "label_th": lvl["label_th"],
                    "label_en": lvl["label_en"],
                }
            )
    alerts.sort(key=lambda a: -a["severity"])
    return alerts

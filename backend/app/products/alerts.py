"""Rule-based impact alerts per province and day.

Thresholds and wording come from ``weather_scales.json`` (design tokens):
heat-index levels of the Thai Department of Health, TMD rainfall-amount and
temperature terms, Beaufort wind classes.

Two vocabularies are kept apart on purpose:

* **hazard levels** (``label_th`` of a level, e.g. the DoH heat-index level
  "เตือนภัย") keep their official source names and are informational;
* **alert tiers** (``severity`` 1-3 = yellow / orange / red) are the only thing
  the UI shows as a coloured alert.  A level raises an alert only when its
  token entry has ``severity`` >= 1, so an ordinary Thai afternoon
  (heat index 32-41 °C) does not.  See ``docs/ALERTS.md`` for the full mapping.
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

#: A forecast day with fewer hourly steps than this is "partial" – its max/min
#: are the extremes of the covered hours only, not of the whole day.
PARTIAL_HOURS = 18


def is_partial(hours: int) -> bool:
    return hours < PARTIAL_HOURS


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


def normalise_day(day: dict) -> dict:
    """Return a day summary with alerts re-evaluated against the *current*
    thresholds and the ``partial`` flag set.

    Run files store the alerts computed when they were made; recomputing from
    the stored summary values keeps every endpoint on one rule set (also for
    runs created before a threshold change or before ``partial`` existed).
    """
    return {**day, "partial": is_partial(day.get("hours", 24)), "alerts": province_alerts(day)}

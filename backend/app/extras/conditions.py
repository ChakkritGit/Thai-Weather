"""A weather condition (for an icon and a word) from the forecast numbers or a MET Norway symbol."""

from __future__ import annotations

CONDITIONS = {
    # code: (Thai, English, severity for picking a day's condition)
    "clear": ("ท้องฟ้าแจ่มใส", "Clear", 0),
    "mostly_clear": ("ท้องฟ้าโปร่ง", "Mostly clear", 1),
    "partly_cloudy": ("มีเมฆบางส่วน", "Partly cloudy", 2),
    "mostly_cloudy": ("เมฆมาก", "Mostly cloudy", 3),
    "cloudy": ("เมฆครึ้ม", "Cloudy", 4),
    "fog": ("หมอก", "Fog", 5),
    "drizzle": ("ฝนเล็กน้อย", "Light rain", 6),
    "rain": ("ฝน", "Rain", 7),
    "heavy_rain": ("ฝนหนัก", "Heavy rain", 8),
    "thunderstorm": ("ฝนฟ้าคะนอง", "Thunderstorms", 9),
}
WET = {"drizzle", "rain", "heavy_rain", "thunderstorm"}
MIN_POP = 30.0  # % chance of rain for a rain icon


def describe(code: str, night: bool = False) -> dict:
    th, en, _ = CONDITIONS[code]
    return {"code": code, "night": night, "label_th": th, "label_en": en}


def from_forecast(rain_mm: float, pop: float, storm: float, cloud: float) -> str:
    """One hour of the 2.2 km forecast: rain (mm/h), chance of rain and storm (%), cloud (%).

    A rain icon needs a real chance of rain (MIN_POP) as well as an amount, so the icon never
    contradicts the "11 %" printed next to it; only heavy rain stands on its amount alone.
    """
    if storm >= 40 and (rain_mm >= 0.5 or pop >= 40):
        return "thunderstorm"
    if rain_mm >= 5:
        return "heavy_rain"
    if pop >= MIN_POP:
        if rain_mm >= 1:
            return "rain"
        if rain_mm >= 0.2:
            return "drizzle"
    if cloud < 15:
        return "clear"
    if cloud < 35:
        return "mostly_clear"
    if cloud < 65:
        return "partly_cloudy"
    if cloud < 85:
        return "mostly_cloudy"
    return "cloudy"


MET = {
    "clearsky": "clear",
    "fair": "mostly_clear",
    "partlycloudy": "partly_cloudy",
    "cloudy": "cloudy",
    "fog": "fog",
    "lightrain": "drizzle",
    "lightrainshowers": "drizzle",
    "rain": "rain",
    "rainshowers": "rain",
    "heavyrain": "heavy_rain",
    "heavyrainshowers": "heavy_rain",
}


def from_met(symbol: str | None) -> str | None:
    """MET Norway's symbol_code ('heavyrainandthunder', 'fair_day', ...) to ours."""
    if not symbol:
        return None
    base = symbol.split("_")[0]
    if "thunder" in base:
        return "thunderstorm"
    if base in MET:
        return MET[base]
    if "sleet" in base or "snow" in base:
        return "rain"
    return None


def for_day(codes: list[str]) -> str:
    """A day's condition: the most severe wet condition seen in at least two periods, else the most
    common sky; a single shower does not make the whole day rainy."""
    if not codes:
        return "partly_cloudy"
    counts: dict[str, int] = {}
    for c in codes:
        counts[c] = counts.get(c, 0) + 1
    wet = [c for c in counts if c in WET and (counts[c] >= 2 or len(codes) <= 4)]
    if wet:
        return max(wet, key=lambda c: CONDITIONS[c][2])
    return max(counts, key=lambda c: (counts[c], CONDITIONS[c][2]))

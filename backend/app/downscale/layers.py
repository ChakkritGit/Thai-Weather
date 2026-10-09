"""Layer catalogue and the compact 8-bit encodings used for storage/transport.

Every stored/served layer is one byte per cell.  ``linear`` maps 0..255 to
[min, max]; ``sqrt`` maps code c to (c/255)² · max, which keeps resolution
where it matters for rain (light rates) while still reaching extremes.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

import numpy as np


@dataclass(frozen=True)
class Encoding:
    kind: str  # "linear" | "sqrt"
    min: float
    max: float

    def encode(self, values: np.ndarray) -> np.ndarray:
        v = np.nan_to_num(np.asarray(values, dtype=np.float32), nan=self.min)
        if self.kind == "sqrt":
            x = np.sqrt(np.clip(v, 0.0, self.max) / self.max)
        else:
            x = (np.clip(v, self.min, self.max) - self.min) / (self.max - self.min)
        return np.rint(x * 255.0).astype(np.uint8)

    def decode(self, codes: np.ndarray) -> np.ndarray:
        x = np.asarray(codes, dtype=np.float32) / 255.0
        if self.kind == "sqrt":
            return x * x * self.max
        return self.min + x * (self.max - self.min)


@dataclass(frozen=True)
class Layer:
    id: str
    unit: str
    encoding: Encoding
    name_th: str
    name_en: str
    scale: str  # id of the colour scale in the design tokens
    daily: bool = False

    def describe(self) -> dict:
        d = asdict(self)
        d["encoding"] = asdict(self.encoding)
        return d


LAYERS: dict[str, Layer] = {
    lyr.id: lyr
    for lyr in [
        Layer("temp", "°C", Encoding("linear", 0.0, 51.0), "อุณหภูมิ", "Temperature", "temperature"),
        Layer("heat", "°C", Encoding("linear", 0.0, 63.75), "ดัชนีความร้อน", "Heat index", "heatIndex"),
        Layer("rh", "%", Encoding("linear", 0.0, 100.0), "ความชื้นสัมพัทธ์", "Relative humidity", "humidity"),
        Layer("rain", "mm/h", Encoding("sqrt", 0.0, 150.0), "ฝน (มม./ชม.)", "Rain rate", "rainRate"),
        Layer("pop", "%", Encoding("linear", 0.0, 100.0), "โอกาสฝน", "Chance of rain", "probability"),
        Layer(
            "heavy",
            "%",
            Encoding("linear", 0.0, 100.0),
            "โอกาสฝนหนัก ≥10 มม./ชม.",
            "Chance of heavy rain",
            "probability",
        ),
        Layer("storm", "%", Encoding("linear", 0.0, 100.0), "โอกาสพายุฝนฟ้าคะนอง", "Thunderstorm chance", "thunder"),
        Layer("wind", "m/s", Encoding("linear", 0.0, 30.0), "ลม", "Wind speed", "wind"),
        Layer("wind_dir", "°", Encoding("linear", 0.0, 360.0), "ทิศทางลม", "Wind direction", "none"),
        Layer("cloud", "%", Encoding("linear", 0.0, 100.0), "เมฆ", "Cloud cover", "cloud"),
        Layer("rain24", "mm", Encoding("sqrt", 0.0, 400.0), "ฝนสะสมรายวัน", "Daily rainfall", "rainDaily", daily=True),
    ]
}

HOURLY_LAYERS = [k for k, v in LAYERS.items() if not v.daily]

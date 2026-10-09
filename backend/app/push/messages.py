"""Notification wording (Thai), ported from frontend/src/lib/nowcastText.ts.

Keep the sentences consistent with that file (its vitest strings are the reference): radar-based
arrivals say "น่าจะ" (likely) rather than promise, and the nearest-cell sentence is the same.
"""

from __future__ import annotations

LANG = "th"

TH_CLASS = {
    "light": "ฝนเล็กน้อย",
    "moderate": "ฝนปานกลาง",
    "heavy": "ฝนหนัก",
    "thunderstorm": "พายุฝนฟ้าคะนอง",
    "severe": "พายุฝนฟ้าคะนองรุนแรง",
}
TH_CELL = {
    "heavy": "กลุ่มฝนหนัก",
    "thunderstorm": "กลุ่มพายุฝนฟ้าคะนอง",
    "severe": "กลุ่มพายุฝนฟ้าคะนองรุนแรง",
}
TH_CAT = {"TD": "พายุดีเปรสชัน", "TS": "พายุโซนร้อน", "TY": "พายุไต้ฝุ่น"}
CAT_RANK = {"TD": 0, "TS": 1, "TY": 2}
DIRS_TH = [
    "เหนือ",
    "ตะวันออกเฉียงเหนือ",
    "ตะวันออก",
    "ตะวันออกเฉียงใต้",
    "ใต้",
    "ตะวันตกเฉียงใต้",
    "ตะวันตก",
    "ตะวันตกเฉียงเหนือ",
]


def compass(deg: float) -> str:
    return DIRS_TH[int(((deg % 360 + 360) % 360) / 45 + 0.5) % 8]


def _round(x: float) -> int:
    """JavaScript Math.round (half up), used so the numbers match the web card."""
    return int(x + 0.5) if x >= 0 else -int(-x + 0.5)


def minutes_text(eta: dict) -> str:
    lo, hi = eta["minutes_range"]
    return str(eta["minutes"]) if hi - lo < 5 else f"{lo}–{hi}"


def arrival(eta: dict) -> str:
    return f"{TH_CLASS[eta['class']]}น่าจะถึงในอีก {minutes_text(eta)} นาที"


def present(cls: str) -> str:
    return f"กำลังมี{TH_CLASS[cls]}บริเวณนี้"


def detail(n: dict) -> str:
    """The nearest strong cell, else the rain motion, else a pointer to the radar."""
    near = n.get("nearest")
    if near:
        cell = TH_CELL.get(near["class"]) or TH_CLASS.get(near["class"], "กลุ่มฝน")
        where = f"{cell}ห่าง {_round(near['distance_km'])} กม. ทาง{compass(near['bearing_deg'])}"
        if near["approaching"]:
            return f"{where} เคลื่อนเข้ามา {_round(near['closing_kmh'])} กม./ชม."
        return f"{where} ไม่ได้เคลื่อนเข้าหาคุณ"
    m = n.get("motion") or {}
    if m.get("heading_deg") is not None and m.get("speed_kmh", 0) >= 5:
        return f"ฝนเคลื่อนไปทาง{compass(m['heading_deg'])} ความเร็ว {_round(m['speed_kmh'])} กม./ชม."
    return "เปิดแอปเพื่อดูเรดาร์"


def with_label(label: str, text: str) -> str:
    return f"{label} · {text}" if label else text


def _lead(hours: float) -> str:
    if hours < 1:
        return "<1 ชม."
    if hours < 48:
        return f"{_round(hours)} ชม."
    return f"{_round(hours / 24)} วัน"


def cyclone_sentence(name: str, cat: str, peak: str, prox: dict) -> str:
    d_now = _round(prox["distance_now_km"])
    d_min = _round(prox["closest"]["distance_km"])
    staying = prox["closest"]["hours"] < 1 and d_now - d_min < 25
    zone = prox["in_wind_zone_kmh"]
    base = f"{TH_CAT[cat]} {name} ห่าง {d_now} กม."
    if zone:
        text = f"{base} จุดนี้อยู่ในเขตลมแรงตั้งแต่ {zone} กม./ชม. ตามแนวพยากรณ์"
    elif staying:
        text = f"{base} ไม่เข้าใกล้ไปกว่านี้"
    else:
        text = f"{base} เข้าใกล้สุด ~{d_min} กม. ในอีก {_lead(prox['closest']['hours'])}"
    if CAT_RANK[peak] > CAT_RANK[cat]:
        text += f" (คาดว่าอาจทวีกำลังเป็น{TH_CAT[peak]})"
    return text


def cyclone_title(name: str, cat: str, prox: dict) -> str:
    if prox["in_wind_zone_kmh"]:
        return f"{TH_CAT[cat]} {name}: จุดนี้อยู่ในเขตลมแรง"
    return f"{TH_CAT[cat]} {name} อาจเข้าใกล้ภายใน ~{_round(prox['closest']['distance_km'])} กม."

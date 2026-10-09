# Alerts / การแจ้งเตือน

Guidance generated automatically from the 2 km forecast – **not** an official warning.
ข้อมูลประกอบที่สร้างอัตโนมัติจากผลพยากรณ์ 2 กม. **ไม่ใช่** ประกาศเตือนภัยทางการ

Single source of truth: `design-system/tokens/weather.json` (`categories.*.levels[].severity` and `severity`).
Generate with `node design-system/scripts/build-tokens.mjs` (CI runs `--check`).
Rules: `backend/app/products/alerts.py`. Every page (map overview, provinces table, province page, alerts page,
header badge) reads the same `alerts` list computed by the backend, so counts always agree.

## 1. Two vocabularies / ศัพท์สองชุดที่แยกกัน

| | Alert tier / ระดับการแจ้งเตือน | Hazard level / ระดับของปรากฏการณ์ |
|---|---|---|
| What | How much attention a province needs | Official name of a measured class (e.g. DoH heat-index level) |
| Words | **เหลือง · ควรติดตาม** / Yellow · Be aware<br>**ส้ม · เตรียมพร้อม** / Orange · Be prepared<br>**แดง · อันตราย** / Red · Take action | Source labels: เฝ้าระวัง, เตือนภัย, อันตราย, ฝนหนัก … |
| Shown as | Coloured chip, always `tier · hazard` | Plain muted text, always with its hazard name ("ดัชนีความร้อน: เตือนภัย (กรมอนามัย)") |
| Colour | Yes (yellow / orange / red + icon + text) | Never |

## 2. Mapping / ตารางเกณฑ์

Alert tier: `–` = information only (no alert), 1 = yellow, 2 = orange, 3 = red.
The value is evaluated per province and day.

| Hazard / ปรากฏการณ์ | Value used / ค่าที่ใช้ | Source level / ระดับต้นทาง | Threshold | Tier | Source |
|---|---|---|---|---|---|
| Heat index / ดัชนีความร้อน | daily max, 95th pct of cells | Normal / ปกติ | < 27 °C | – | กรมอนามัย (DoH) |
| | | Caution / เฝ้าระวัง | ≥ 27 °C | – | |
| | | Extreme caution / เตือนภัย | ≥ 32 °C | – (was 1) | |
| | | Danger / อันตราย | ≥ 41 °C | **2 orange** | |
| | | Extreme danger / อันตรายมาก | ≥ 54 °C | **3 red** | |
| Rain / ฝน | 24 h rain, 95th pct of cells | Heavy / ฝนหนัก | ≥ 35.1 mm | – (was 1) | กรมอุตุนิยมวิทยา (TMD) |
| | | Very heavy / ฝนหนักมาก | ≥ 90.1 mm | **1 yellow** (was 2) | |
| | | Extreme – flash-flood risk | ≥ 150 mm | **2 orange** (was 3) | system-defined |
| Thunderstorm / พายุฝนฟ้าคะนอง | peak hourly chance, max of cells | Possible / อาจมี | ≥ 30 % | – | system |
| | | Likely / มี | ≥ 50 % | – (was 1) | |
| | | Severe / รุนแรง | ≥ 75 % | **1 yellow** (was 2) | |
| Wind / ลม | 10 m wind, 95th pct of cells | Strong / ลมแรง | ≥ 10.8 m/s (Bft 6) | **1 yellow** | Beaufort |
| | | Gale / ลมแรงจัด | ≥ 17.2 m/s (Bft 8) | **2 orange** | |
| | | Storm-force / ลมพายุ | ≥ 24.5 m/s (Bft 10) | **3 red** | |
| High temperature / อุณหภูมิสูง | day max, province median | Hot / อากาศร้อน | ≥ 35 °C | – | TMD |
| | | Very hot / ร้อนจัด | ≥ 40 °C | **1 yellow** (was 2) | |
| Low temperature / อุณหภูมิต่ำ | day min, province median | Cool / อากาศเย็น | ≤ 22.9 °C | – | TMD |
| | | Cold / อากาศหนาว | ≤ 15.9 °C | **1 yellow** | |
| | | Very cold / หนาวจัด | ≤ 7.9 °C | **2 orange** | |

Why: a heat index of 32–41 °C (and 35 mm+ of rain in one cell, and a 50 % thunderstorm chance) is an ordinary
Thai day. Alerting on it flagged all 77 provinces every day, which teaches users to ignore alerts. Only conditions
that call for a change of behaviour raise a tier. Hazard levels are still displayed (information only).

## 3. Effect on live data / ผลต่อข้อมูลจริง

Run `20261009T0500Z-open-meteo` (GFS via Open-Meteo), 77 provinces:

| Day | Hours | Provinces with an alert – before | after |
|---|---|---|---|
| Fri 9 Oct | 12 (partial) | 77 | 0 |
| Sat 10 Oct | 24 | 77 | 0 |
| Sun 11 Oct | 12 (partial) | 56 | 0 |

Before: the old "เตือนภัย" heat-index level was alert tier 1 and so counted for every province.
Acceptance target: ≤ 25 % of provinces carry an alert on an ordinary day (`backend/tests/test_alerts.py`).

## 4. Partial days / วันที่มีข้อมูลไม่ครบ

A forecast day with fewer than 18 hourly steps is `partial` (`PARTIAL_HOURS` in `alerts.py`). The first and last
forecast day usually are. The API returns `partial`, `since`, `until` (Thai local HH:MM) on each province day and
in `run.days`; `/alerts` entries carry `partial` and `until`. The UI then:

- shows "ข้อมูลถึง HH:MM น." / "Data until HH:MM";
- words temperature extremes "เท่าที่มีข้อมูล" / "so far" and never as the daily max / min;
- keeps alerts (they still count) but notes they are based on the available hours.

## 5. API

`GET /api/v1/alerts?min_severity=1..3` (default 1 = every tier). Alerts in `/provinces`, `/provinces/{id}` and
`/alerts` are re-evaluated from the stored day summaries with the current thresholds, so a threshold change
applies immediately, also to the run already on disk.

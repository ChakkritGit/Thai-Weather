"""Pair archived forecasts with observations and compute verification metrics.

Design choices that matter for honesty of the numbers:

* **Matched sample.** The headline comparison only uses (run, station, valid)
  keys for which *every* available source has a value, so a source cannot look
  better just because it was scored on easier cases.  Unmatched counts are
  reported separately.
* **Pairing.** Hourly forecasts (valid at the top of the hour) are paired with
  the observation closest in time within +-20 minutes.
* **Rain is occurrence, not amount.** Thai METARs carry no rain totals, so rain
  is scored as yes/no in 3-hour ICT-aligned windows.  Because forecast
  ``rain`` at time T is the sum over the preceding hour, a time T belongs to the
  window ``(start, end]``; observation reports use the same convention.
* Temperatures from METAR are whole degrees C, which adds ~0.29 C RMS
  quantisation noise to every error.
"""

from __future__ import annotations

import sqlite3
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from functools import cache

import numpy as np

from . import db, holdout
from .observe import is_rain

SOURCES = ("fine", "gfs_raw", "openmeteo")
BASELINE = "gfs_raw"
MAX_LEAD_H = 47
PAIR_TOLERANCE_MIN = 20
RAIN_THRESHOLD_MM = 0.2
ICT_OFFSET_MIN = 7 * 60
WINDOW_MIN = 180
MIN_RECOMMENDED_N = 500
EFFECT_SPLIT_H = 12  # the correction decays with an e-folding time of 12 h
LEAD_BUCKETS = ("0-11 h", "12-23 h", "24-35 h", "36-47 h")
ELEV_BANDS = ("< 100 m", "100-400 m", "> 400 m")


@dataclass
class Metrics:
    n: int
    bias: float | None
    mae: float | None
    rmse: float | None


@dataclass
class Row:
    label: str
    n: int
    metrics: dict[str, Metrics]
    extra: dict[str, str] = field(default_factory=dict)


@dataclass
class Contingency:
    hits: int = 0
    misses: int = 0
    false_alarms: int = 0
    correct_negatives: int = 0

    @property
    def n(self) -> int:
        return self.hits + self.misses + self.false_alarms + self.correct_negatives

    @staticmethod
    def _ratio(a: float, b: float) -> float | None:
        return a / b if b else None

    @property
    def pod(self) -> float | None:
        return self._ratio(self.hits, self.hits + self.misses)

    @property
    def far(self) -> float | None:
        return self._ratio(self.false_alarms, self.hits + self.false_alarms)

    @property
    def csi(self) -> float | None:
        return self._ratio(self.hits, self.hits + self.misses + self.false_alarms)

    @property
    def freq_bias(self) -> float | None:
        return self._ratio(self.hits + self.false_alarms, self.hits + self.misses)


@dataclass
class Report:
    since: datetime | None
    until: datetime
    sources: list[str] = field(default_factory=list)
    n_runs: int = 0
    n_stations: int = 0
    n_obs: int = 0
    temp_matched: int = 0
    temp_unmatched: dict[str, int] = field(default_factory=dict)
    temp_overall: dict[str, Metrics] = field(default_factory=dict)
    by_lead: list[Row] = field(default_factory=list)
    by_hour: list[Row] = field(default_factory=list)
    by_elevation: list[Row] = field(default_factory=list)
    by_station: list[Row] = field(default_factory=list)
    rain_windows: int = 0
    rain_unmatched: dict[str, int] = field(default_factory=dict)
    rain: dict[str, Contingency] = field(default_factory=dict)
    brier: dict[str, float] = field(default_factory=dict)
    holdout_ids: list[str] = field(default_factory=list)
    corrected_samples: int = 0
    effect: list[Row] = field(default_factory=list)


# ----------------------------------------------------------------- helpers
@cache
def _epoch_min(s: str) -> int:
    return int(db.parse_time(s).timestamp()) // 60


def _metrics(errors: list[float]) -> Metrics:
    if not errors:
        return Metrics(0, None, None, None)
    e = np.asarray(errors, dtype=float)
    return Metrics(len(e), float(e.mean()), float(np.abs(e).mean()), float(np.sqrt((e**2).mean())))


def _lead_bucket(lead_h: int) -> str:
    return LEAD_BUCKETS[min(lead_h // 12, len(LEAD_BUCKETS) - 1)]


def _hour_bin(valid: str) -> str:
    b = ((int(valid[11:13]) + 7) % 24) // 3
    return f"{b * 3:02d}-{b * 3 + 2:02d}"


def _elev_band(elev: float | None) -> str | None:
    if elev is None:
        return None
    return ELEV_BANDS[0] if elev < 100 else ELEV_BANDS[1] if elev <= 400 else ELEV_BANDS[2]


def _window(epoch_min: int) -> int:
    """3-h ICT-aligned window ``(start, end]`` index (T = 03:00 ICT belongs to 00-03)."""
    return (epoch_min + ICT_OFFSET_MIN - 1) // WINDOW_MIN


def _group_rows(
    samples: list[tuple[str, int, str, dict[str, float]]], key, labels: tuple[str, ...] | None, sources: list[str]
) -> list[Row]:
    groups: dict[str, list[dict[str, float]]] = defaultdict(list)
    for station, lead, valid, errs in samples:
        k = key(station, lead, valid)
        if k is not None:
            groups[k].append(errs)
    order = [lbl for lbl in labels if lbl in groups] if labels else sorted(groups)
    return [Row(k, len(groups[k]), {s: _metrics([e[s] for e in groups[k]]) for s in sources}) for k in order]


def _best_obs(rows: list[sqlite3.Row]) -> dict[tuple[str, int], float]:
    """Observation closest to each top of the hour within tolerance -> t2m."""
    best: dict[tuple[str, int], tuple[tuple[int, int], float]] = {}
    for r in rows:
        if r["t2m"] is None:
            continue
        em = _epoch_min(r["valid"])
        hour = (em + 30) // 60 * 60
        dist = abs(em - hour)
        if dist > PAIR_TOLERANCE_MIN:
            continue
        rank = (dist, 0 if em % 30 == 0 else 1)  # routine METARs (:00/:30) win ties
        k = (r["station"], hour)
        if k not in best or rank < best[k][0]:
            best[k] = (rank, r["t2m"])
    return {k: v[1] for k, v in best.items()}


# ------------------------------------------------------------------- score
def score(conn: sqlite3.Connection, since: datetime | None = None, until: datetime | None = None) -> Report:
    until = until or datetime.now(UTC)
    report = Report(since=since, until=until)
    lo = db.fmt_time(since) if since else "0000-00-00T00:00"
    hi = db.fmt_time(until)
    obs_lo = db.fmt_time(since - timedelta(hours=4)) if since else lo
    obs_hi = db.fmt_time(until + timedelta(hours=4))

    stations = {r["id"]: r for r in conn.execute("SELECT * FROM stations")}
    fc_rows = conn.execute(
        "SELECT run_id, source, station, valid, lead_h, t2m, rain, pop FROM forecasts "
        "WHERE valid >= ? AND valid <= ? AND lead_h BETWEEN 0 AND ?",
        (lo, hi, MAX_LEAD_H),
    ).fetchall()
    obs_rows = conn.execute(
        "SELECT station, valid, t2m, wx, rain_1h FROM obs WHERE valid >= ? AND valid <= ?", (obs_lo, obs_hi)
    ).fetchall()
    report.n_obs = sum(1 for r in obs_rows if lo <= r["valid"] <= hi)
    report.n_runs = len({r["run_id"] for r in fc_rows})
    report.n_stations = len({r["station"] for r in fc_rows})
    present = {r["source"] for r in fc_rows}
    sources = [s for s in SOURCES if s in present]
    report.sources = sources
    if not sources:
        return report

    _score_temperature(report, fc_rows, obs_rows, stations, sources, conn)
    _score_rain(report, fc_rows, obs_rows, sources)
    return report


def _score_temperature(report, fc_rows, obs_rows, stations, sources, conn) -> None:
    obs = _best_obs(obs_rows)
    by_key: dict[tuple[str, str, str], dict[str, float]] = defaultdict(dict)
    lead_of: dict[tuple[str, str, str], int] = {}
    for r in fc_rows:
        if r["t2m"] is None:
            continue
        k = (r["run_id"], r["station"], r["valid"])
        by_key[k][r["source"]] = r["t2m"]
        lead_of[k] = r["lead_h"]
    temp_sources = [s for s in sources if any(s in v for v in by_key.values())]
    report.temp_unmatched = dict.fromkeys(temp_sources, 0)
    samples: list[tuple[str, int, str, dict[str, float]]] = []
    sample_run: list[str] = []
    for (_run, station, valid), vals in by_key.items():
        o = obs.get((station, _epoch_min(valid)))
        if o is None:
            continue
        if all(s in vals for s in temp_sources):
            samples.append((station, lead_of[(_run, station, valid)], valid, {s: vals[s] - o for s in temp_sources}))
            sample_run.append(_run)
        else:
            for s in vals:
                report.temp_unmatched[s] += 1
    report.temp_matched = len(samples)
    if not samples:
        return
    srcs = temp_sources
    report.temp_overall = {s: _metrics([e[s] for _, _, _, e in samples]) for s in srcs}
    report.by_lead = _group_rows(samples, lambda st, lead, v: _lead_bucket(lead), LEAD_BUCKETS, srcs)
    report.by_hour = _group_rows(samples, lambda st, lead, v: _hour_bin(v), None, srcs)
    report.by_elevation = _group_rows(
        samples,
        lambda st, lead, v: _elev_band(stations[st]["elevation"]) if st in stations else None,
        ELEV_BANDS,
        srcs,
    )
    rows = _group_rows(samples, lambda st, lead, v: st, None, srcs)
    for row in rows:
        st = stations.get(row.label)
        meta = db.get_meta(conn, f"elev:{row.label}")
        fine_e, model_e = meta.split(",") if meta else ("", "")
        row.extra = {
            "name": st["name"] if st else row.label,
            "elevation": "" if not st or st["elevation"] is None else f"{st['elevation']:.0f}",
            "fine_elevation": fine_e,
            "model_elevation": model_e,
        }
    report.by_station = rows
    _score_correction_effect(report, samples, sample_run, srcs, conn)


def _score_correction_effect(report: Report, samples, sample_run: list[str], srcs: list[str], conn) -> None:
    """Split the matched sample by hold-out/assimilated station and corrected/uncorrected run."""
    held = holdout.load(conn)
    report.holdout_ids = sorted(held)
    used = {r["run_id"]: r["obs_used"] or 0 for r in conn.execute("SELECT run_id, obs_used FROM runs")}
    groups: dict[tuple[str, str, str], list[dict[str, float]]] = defaultdict(list)
    for (station, lead, _valid, errs), run_id in zip(samples, sample_run, strict=True):
        group = "hold-out" if station in held else "assimilated"
        run_type = "corrected" if used.get(run_id, 0) > 0 else "uncorrected"
        span = f"0-{EFFECT_SPLIT_H - 1} h" if lead < EFFECT_SPLIT_H else f"{EFFECT_SPLIT_H}-{MAX_LEAD_H} h"
        groups[(group, run_type, span)].append(errs)
        if run_type == "corrected":
            report.corrected_samples += 1
    spans = (f"0-{EFFECT_SPLIT_H - 1} h", f"{EFFECT_SPLIT_H}-{MAX_LEAD_H} h")
    for group in ("hold-out", "assimilated"):
        for run_type in ("corrected", "uncorrected"):
            for span in spans:
                errs = groups.get((group, run_type, span))
                if errs:
                    row = Row(group, len(errs), {s: _metrics([e[s] for e in errs]) for s in srcs})
                    row.extra = {"run": run_type, "lead": span}
                    report.effect.append(row)


def _score_rain(report: Report, fc_rows, obs_rows, sources: list[str]) -> None:
    # observed yes/no per (station, window); a window with no usable report is ignored
    obs_win: dict[tuple[str, int], bool] = {}
    for r in obs_rows:
        flag = is_rain(r["wx"], r["rain_1h"])
        if flag is None:
            continue
        k = (r["station"], _window(_epoch_min(r["valid"])))
        obs_win[k] = obs_win.get(k, False) or flag

    # forecast per (run, station, window): hours seen, max rain, max pop
    acc: dict[tuple[str, str, int], dict[str, list]] = defaultdict(dict)
    for r in fc_rows:
        if r["rain"] is None:
            continue
        k = (r["run_id"], r["station"], _window(_epoch_min(r["valid"])))
        rec = acc[k].setdefault(r["source"], [0, 0.0, 0.0, True])  # n, max rain, max pop, pop complete
        rec[0] += 1
        rec[1] = max(rec[1], r["rain"])
        if r["pop"] is None:
            rec[3] = False
        else:
            rec[2] = max(rec[2], r["pop"])

    rain_sources = [s for s in sources if any(s in v for v in acc.values())]
    report.rain_unmatched = dict.fromkeys(rain_sources, 0)
    report.rain = {s: Contingency() for s in rain_sources}
    brier_sum = dict.fromkeys(rain_sources, 0.0)
    brier_n = dict.fromkeys(rain_sources, 0)
    for (_run, station, w), by_src in acc.items():
        observed = obs_win.get((station, w))
        if observed is None:
            continue
        complete = [s for s in rain_sources if s in by_src and by_src[s][0] >= 3]
        if len(complete) != len(rain_sources):
            for s in complete:
                report.rain_unmatched[s] += 1
            continue
        report.rain_windows += 1
        for s in rain_sources:
            n, max_rain, max_pop, pop_ok = by_src[s]
            yes = max_rain >= RAIN_THRESHOLD_MM
            c = report.rain[s]
            if yes and observed:
                c.hits += 1
            elif observed:
                c.misses += 1
            elif yes:
                c.false_alarms += 1
            else:
                c.correct_negatives += 1
            if s == "fine":
                if pop_ok:
                    brier_sum[s] += (max_pop / 100.0 - float(observed)) ** 2
                    brier_n[s] += 1
            else:
                brier_sum[s] += (float(yes) - float(observed)) ** 2
                brier_n[s] += 1
    report.brier = {s: brier_sum[s] / brier_n[s] for s in rain_sources if brier_n[s]}


# ---------------------------------------------------------------- markdown
def _f(x: float | None, nd: int = 2, signed: bool = False) -> str:
    if x is None:
        return "–"
    return f"{x:+.{nd}f}" if signed else f"{x:.{nd}f}"


def _skill(mae: float | None, base: float | None) -> str:
    if mae is None or not base:
        return "–"
    return f"{(1 - mae / base) * 100:+.0f}%"


def _table(first: str, rows: list[Row], sources: list[str], extra_cols: tuple[tuple[str, str], ...] = ()) -> list[str]:
    cols = [first, *(h for h, _ in extra_cols), "N"]
    cols += [f"MAE {s}" for s in sources] + [f"Bias {s}" for s in sources]
    skill_srcs = [s for s in sources if s != BASELINE] if BASELINE in sources else []
    cols += [f"Skill {s}" for s in skill_srcs]
    out = ["| " + " | ".join(cols) + " |", "|" + "|".join("---" for _ in cols) + "|"]
    for r in rows:
        cells = [r.label, *(r.extra.get(k, "") for _, k in extra_cols), str(r.n)]
        cells += [_f(r.metrics[s].mae) for s in sources] + [_f(r.metrics[s].bias, signed=True) for s in sources]
        base = r.metrics[BASELINE].mae if BASELINE in sources else None
        cells += [_skill(r.metrics[s].mae, base) for s in skill_srcs]
        out.append("| " + " | ".join(cells) + " |")
    return out


def render_markdown(report: Report) -> str:
    ict = timedelta(hours=7)
    since = (report.since + ict).strftime("%Y-%m-%d %H:%M") if report.since else "ต้นข้อมูล"
    until = (report.until + ict).strftime("%Y-%m-%d %H:%M")
    lines = [
        "# รายงานการตรวจสอบพยากรณ์ (Forecast verification)",
        "",
        f"ช่วงเวลา (ICT): {since} – {until}",
        "",
    ]
    if report.temp_matched == 0 and not report.rain_windows:
        lines += [
            "**ยังไม่มีข้อมูลเพียงพอ (no data yet)** — "
            f"พยากรณ์ที่เก็บไว้ {report.n_runs} รอบ, {report.n_stations} สถานี, "
            f"ข้อมูลตรวจวัด {report.n_obs} รายการ ยังจับคู่กันไม่ได้",
            "",
            "ต้องรอให้ `collect` เก็บพยากรณ์ และ `observe` ดึงข้อมูลสถานีของช่วงเวลาเดียวกันก่อน",
        ]
        return "\n".join(lines) + "\n"

    lines += [
        f"- รอบพยากรณ์ที่เก็บไว้: **{report.n_runs}** รอบ · สถานี: **{report.n_stations}** · "
        f"รายงานตรวจวัด: **{report.n_obs}**",
        f"- ชุดตัวอย่างเทียบกันได้ (matched sample): **N = {report.temp_matched}** (ทุกแหล่งมีค่าครบในคีย์ รอบ-สถานี-เวลาเดียวกัน)",
        "- ตัวอย่างที่ถูกตัดออกเพราะบางแหล่งไม่มีค่า: "
        + (", ".join(f"{s} {n}" for s, n in report.temp_unmatched.items()) or "–"),
        "",
        "> **ข้อควรทราบ** — ค่าอุณหภูมิจาก METAR ปัดเป็นองศาเซลเซียสเต็มหน่วย (เพิ่มสัญญาณรบกวน ≈ 0.3 °C RMS) · "
        "METAR ไทยไม่รายงานปริมาณฝน จึงตรวจสอบเฉพาะ *ฝนเกิดหรือไม่เกิด* · "
        "สถานีส่วนใหญ่เป็นสนามบิน (ที่ราบ/เมืองใหญ่) จึงไม่แทนภูเขาสูง · "
        "Skill = 1 − MAE(source) / MAE(gfs_raw) (บวก = ดีกว่า GFS ดิบ)",
        "",
    ]
    if report.temp_matched < MIN_RECOMMENDED_N:
        lines += [
            f"> **ตัวอย่างน้อย (N = {report.temp_matched} < {MIN_RECOMMENDED_N})** — "
            "ผลยังไม่น่าเชื่อถือทางสถิติ ควรสะสมข้อมูลหลายสัปดาห์ก่อนสรุป",
            "",
        ]

    srcs = list(report.temp_overall)
    if srcs:
        lines += ["## 1. อุณหภูมิ 2 ม. ภาพรวม (Temperature 2 m, °C, forecast − observed)", ""]
        lines += ["| Source | N | Bias | MAE | RMSE | Skill vs gfs_raw |", "|---|---|---|---|---|---|"]
        base = report.temp_overall[BASELINE].mae if BASELINE in report.temp_overall else None
        for s in srcs:
            m = report.temp_overall[s]
            skill = "–" if s == BASELINE else _skill(m.mae, base)
            lines.append(f"| {s} | {m.n} | {_f(m.bias, signed=True)} | {_f(m.mae)} | {_f(m.rmse)} | {skill} |")
        lines += ["", "## 2. แยกตามช่วง lead time (Lead time)", ""]
        lines += _table("Lead", report.by_lead, srcs)
        lines += ["", "## 3. แยกตามชั่วโมงท้องถิ่น ICT (Local hour, 3-h bins)", ""]
        lines += _table("ICT", report.by_hour, srcs)
        lines += ["", "## 4. แยกตามความสูงสถานี (Elevation band)", ""]
        lines += _table("Elevation", report.by_elevation, srcs)
        lines += ["", "## 5. รายสถานี (Per station)", ""]
        extra = [
            ("Name", "name"),
            ("Elev. (m)", "elevation"),
            ("Fine cell (m)", "fine_elevation"),
            ("Model (m)", "model_elevation"),
        ]
        lines += _table("Station", report.by_station, srcs, tuple(extra))

    lines += ["", "## 6. ฝนเกิด/ไม่เกิด ช่วง 3 ชม. (Rain occurrence, 3-h windows, ICT)", ""]
    if not report.rain_windows:
        lines += ["ยังไม่มีช่วงเวลาที่จับคู่ได้ (no matched windows yet)."]
    else:
        lines += [
            f'เกณฑ์พยากรณ์ "ฝน" = ฝนรายชั่วโมงสูงสุดในช่วง ≥ {RAIN_THRESHOLD_MM} mm/h · '
            f"ช่วงที่จับคู่ได้ N = **{report.rain_windows}** · "
            "ตัวอย่างที่ถูกตัดออก: " + (", ".join(f"{s} {n}" for s, n in report.rain_unmatched.items()) or "–"),
            "",
            "| Source | Hits | Misses | False alarms | Correct neg. | POD | FAR | CSI | Freq. bias | Brier |",
            "|---|---|---|---|---|---|---|---|---|---|",
        ]
        for s, c in report.rain.items():
            lines.append(
                f"| {s} | {c.hits} | {c.misses} | {c.false_alarms} | {c.correct_negatives} | {_f(c.pod)} | "
                f"{_f(c.far)} | {_f(c.csi)} | {_f(c.freq_bias)} | {_f(report.brier.get(s), 3)} |"
            )
        lines += [
            "",
            "Brier ของ `fine` ใช้ความน่าจะเป็น pop/100 (ค่าสูงสุดในช่วง) ส่วน gfs_raw และ openmeteo ใช้ 0/1",
        ]

    lines += ["", "## 7. ผลของการแก้ค่าด้วยข้อมูลสถานี (Station correction effect)", ""]
    if not report.holdout_ids:
        lines += ["ยังไม่ได้เลือกสถานี hold-out (no hold-out set chosen yet) — รัน `observe`/`loop` เพื่อเลือก"]
    elif not report.corrected_samples:
        lines += ["ยังไม่มีรอบพยากรณ์ที่ใช้ข้อมูลสถานีแก้ค่า (no corrected runs yet in this window)."]
    else:
        extra = (("Run", "run"), ("Lead", "lead"))
        lines += _table("Stations", report.effect, srcs, extra)
        lines += [
            "",
            "สถานี `assimilated` ถูกใช้ในการแก้ค่าแล้ว จึงไม่เป็นอิสระ — ให้ตัดสินวิธีนี้จากแถว **hold-out** เท่านั้น "
            "(`corrected` = รอบที่ใช้ข้อมูลสถานี, `uncorrected` = รอบที่ไม่ได้ใช้) · "
            f"การแก้ค่าจางลงตามเวลา (e-folding {EFFECT_SPLIT_H} ชม.) จึงแยก lead 0-{EFFECT_SPLIT_H - 1} ชม. กับ "
            f"{EFFECT_SPLIT_H}-{MAX_LEAD_H} ชม.",
            "",
            "สถานี hold-out: " + ", ".join(f"`{s}`" for s in report.holdout_ids),
        ]
    return "\n".join(lines) + "\n"

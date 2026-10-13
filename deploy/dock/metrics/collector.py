"""Dock metrics collector – host, container and Nginx Proxy Manager traffic history (stdlib only).

Reads, read-only:
  /host/proc        host procfs          → CPU, memory, swap, load, network, disk I/O, uptime
  /host/cgroup      host cgroup v2       → per-container CPU, memory, block I/O (docker-<id>.scope)
  /host/hostname    a host file          → hostname; statvfs of it gives the root filesystem usage
  /host/os-release  the host's /etc/os-release
  /npm-logs         NPM's log directory  → requests, status codes and bytes per proxy host
No Docker socket: containers are reported by id; the page maps ids to names via Portainer.

History tiers: 1 h at 10 s, 24 h at 1 min, 7 d at 10 min. Saved to /data every 5 minutes.
Serves GET /metrics?range=1h|24h|7d on :9100 (reachable only through the dock proxy, behind
Portainer authentication).
"""

from __future__ import annotations

import gzip
import json
import os
import re
import threading
import time
from collections import Counter, defaultdict
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

PROC = Path(os.environ.get("HOST_PROC", "/host/proc"))
CGROUP = Path(os.environ.get("HOST_CGROUP", "/host/cgroup"))
HOSTFILE = Path(os.environ.get("HOST_FILE", "/host/hostname"))
LOGS = Path(os.environ.get("NPM_LOGS", "/npm-logs"))
DATA = Path(os.environ.get("DATA_DIR", "/data"))
SAMPLE_S = 5
TIERS = {"1h": (10, 360), "24h": (60, 1440), "7d": (600, 1008)}  # range -> (step s, points)
SAVE_EVERY_S = 300

# Gauges are averaged inside a bucket, counters summed.
COUNTERS_PREFIX = ("ng:",)


def is_counter(key: str) -> bool:
    return key.startswith(COUNTERS_PREFIX)


class Tiered:
    """Bucketed history for many fields at three resolutions."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        # tier -> bucket start -> field -> [sum, count]
        self.buckets: dict[str, dict[int, dict[str, list[float]]]] = {k: {} for k in TIERS}

    def add(self, ts: float, values: dict[str, float]) -> None:
        with self.lock:
            for tier, (step, _) in TIERS.items():
                b = self.buckets[tier].setdefault(int(ts // step * step), {})
                for k, v in values.items():
                    acc = b.setdefault(k, [0.0, 0])
                    acc[0] += v
                    acc[1] += 1

    def prune(self, now: float) -> None:
        with self.lock:
            for tier, (step, n) in TIERS.items():
                oldest = now - step * n
                for t in [t for t in self.buckets[tier] if t < oldest]:
                    del self.buckets[tier][t]

    def series(self, tier: str, now: float) -> tuple[list[int], dict[str, list[float | None]]]:
        step, n = TIERS[tier]
        end = int(now // step * step)
        times = list(range(end - step * (n - 1), end + step, step))
        with self.lock:
            b = self.buckets[tier]
            keys = sorted({k for bucket in b.values() for k in bucket})
            out: dict[str, list[float | None]] = {}
            for k in keys:
                counter = is_counter(k)
                col: list[float | None] = []
                for t in times:
                    acc = b.get(t, {}).get(k)
                    if acc is None:
                        col.append(0.0 if counter and t in b else None)
                    else:
                        col.append(round(acc[0] if counter else acc[0] / acc[1], 4))
                out[k] = col
        return times, out

    def dump(self) -> dict:
        with self.lock:
            return {tier: {str(t): v for t, v in b.items()} for tier, b in self.buckets.items()}

    def load(self, d: dict) -> None:
        with self.lock:
            for tier in TIERS:
                self.buckets[tier] = {int(t): v for t, v in d.get(tier, {}).items()}


# ------------------------------------------------------------------ host
def read(p: Path) -> str:
    try:
        return p.read_text()
    except OSError:
        return ""


def cpu_times() -> list[int]:
    # user nice system idle iowait irq softirq steal
    line = read(PROC / "stat").splitlines()[0].split()
    return [int(x) for x in line[1:9]]


def meminfo() -> dict[str, int]:
    out = {}
    for line in read(PROC / "meminfo").splitlines():
        k, _, rest = line.partition(":")
        out[k] = int(rest.split()[0]) * 1024
    return out


def net_bytes() -> tuple[int, int]:
    rx = tx = 0
    for line in read(PROC / "1" / "net" / "dev").splitlines()[2:]:
        name, _, rest = line.partition(":")
        name = name.strip()
        if name == "lo" or name.startswith(("veth", "br-", "docker")):
            continue  # count traffic once, on the physical interface(s)
        f = rest.split()
        rx += int(f[0])
        tx += int(f[8])
    return rx, tx


DISK_RE = re.compile(r"^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+)$")


def disk_bytes() -> tuple[int, int]:
    r = w = 0
    for line in read(PROC / "diskstats").splitlines():
        f = line.split()
        if len(f) > 9 and DISK_RE.match(f[2]):
            r += int(f[5]) * 512
            w += int(f[9]) * 512
    return r, w


def host_snapshot() -> dict:
    mi = meminfo()
    st = os.statvfs(HOSTFILE)
    load = read(PROC / "loadavg").split()
    os_release = dict(line.split("=", 1) for line in read(HOSTFILE.parent / "os-release").splitlines() if "=" in line)
    return {
        "hostname": read(HOSTFILE).strip(),
        "os": os_release.get("PRETTY_NAME", "").strip('"'),
        "kernel": read(PROC / "sys" / "kernel" / "osrelease").strip(),
        "uptime_s": int(float(read(PROC / "uptime").split()[0] or 0)),
        "cpus": os.cpu_count(),
        "mem_total": mi.get("MemTotal", 0),
        "mem_available": mi.get("MemAvailable", 0),
        "swap_total": mi.get("SwapTotal", 0),
        "swap_free": mi.get("SwapFree", 0),
        "disk_total": st.f_blocks * st.f_frsize,
        "disk_free": st.f_bavail * st.f_frsize,
        "disk_used": (st.f_blocks - st.f_bfree) * st.f_frsize,
        "load": [float(x) for x in load[:3]] if load else [],
        "procs": load[3] if len(load) > 3 else "",
    }


# ------------------------------------------------------------------ containers (cgroup v2)
def containers() -> dict[str, Path]:
    base = CGROUP / "system.slice"
    out = {}
    try:
        for d in base.iterdir():
            m = re.fullmatch(r"docker-([0-9a-f]{64})\.scope", d.name)
            if m:
                out[m.group(1)] = d
    except OSError:
        pass
    return out


def cg_stats(d: Path) -> dict[str, int]:
    out = {"cpu_usec": 0, "mem": 0, "rd": 0, "wr": 0, "rx": 0, "tx": 0}
    for line in read(d / "cpu.stat").splitlines():
        if line.startswith("usage_usec"):
            out["cpu_usec"] = int(line.split()[1])
    mem = int(read(d / "memory.current").strip() or 0)
    inactive = 0
    for line in read(d / "memory.stat").splitlines():
        if line.startswith("inactive_file "):
            inactive = int(line.split()[1])
    out["mem"] = max(0, mem - inactive)
    for line in read(d / "io.stat").splitlines():
        for kv in line.split()[1:]:
            k, _, v = kv.partition("=")
            if k == "rbytes":
                out["rd"] += int(v)
            elif k == "wbytes":
                out["wr"] += int(v)
    pids = read(d / "cgroup.procs").split()
    if pids:  # the container's network namespace, through one of its processes
        for line in read(PROC / pids[0] / "net" / "dev").splitlines()[2:]:
            name, _, rest = line.partition(":")
            if name.strip() == "lo":
                continue
            f = rest.split()
            out["rx"] += int(f[0])
            out["tx"] += int(f[8])
    return out


# ------------------------------------------------------------------ Nginx Proxy Manager logs
LINE_RE = re.compile(
    r'^\[(?P<time>[^\]]+)\] (?P<cache>\S+) (?P<status>\d{3}|-) (?P<up>\d{3}|-) - (?P<method>\S+) (?P<scheme>\S+) '
    r'(?P<host>\S+) "(?P<path>[^"]*)" \[Client (?P<client>[^\]]+)\] \[Length (?P<len>\d+)\]'
)
FALLBACK_RE = re.compile(
    r'^\[(?P<time>[^\]]+)\] (?P<status>\d{3}|-) - (?P<method>\S+) (?P<scheme>\S+) (?P<host>\S+) "(?P<path>[^"]*)" '
    r"\[Client (?P<client>[^\]]+)\] \[Length (?P<len>\d+)\]"
)
TIME_FMT = "%d/%b/%Y:%H:%M:%S %z"
ASSET_RE = re.compile(r"^/_next/|\.(js|css|png|jpg|svg|ico|woff2?|webmanifest|map)$")


def norm_path(path: str) -> str:
    p = path.split("?", 1)[0] or "/"
    if p.startswith("/_next/"):
        return "/_next/*"
    p = re.sub(r"/[0-9a-f]{12,64}(?=/|$)", "/:id", p)
    p = re.sub(r"/\d+(?=/|$)", "/:n", p)
    return p[:80]


class LogTail:
    """Follows the NPM access logs (handles truncation and rotation) and feeds request counters."""

    def __init__(self, hist: Tiered) -> None:
        self.hist = hist
        self.pos: dict[str, tuple[int, int]] = {}  # file -> (inode, offset)
        self.lock = threading.Lock()
        self.paths: dict[int, Counter] = defaultdict(Counter)  # hour -> (host, path) -> count
        self.clients: dict[int, set] = defaultdict(set)  # hour -> client hashes (in memory only)
        self.hosts: set[str] = set()

    def files(self) -> list[Path]:
        try:
            return sorted(p for p in LOGS.iterdir() if re.fullmatch(r"(proxy-host-\d+|fallback_http)_access\.log", p.name))
        except OSError:
            return []

    def poll(self, backfill_since: float | None = None) -> None:
        for f in self.files():
            try:
                st = f.stat()
            except OSError:
                continue
            inode, offset = self.pos.get(f.name, (st.st_ino, 0 if backfill_since else st.st_size))
            if inode != st.st_ino or st.st_size < offset:  # rotated or truncated
                offset = 0
            if st.st_size == offset:
                self.pos[f.name] = (st.st_ino, offset)
                continue
            with f.open("rb") as fh:
                fh.seek(offset)
                data = fh.read()
                # only complete lines
                end = data.rfind(b"\n") + 1
                self.pos[f.name] = (st.st_ino, offset + end)
            fallback = f.name.startswith("fallback")
            for raw in data[:end].decode("utf-8", "replace").splitlines():
                self.ingest(raw, fallback, backfill_since)

    def ingest(self, line: str, fallback: bool, since: float | None) -> None:
        m = (FALLBACK_RE if fallback else LINE_RE).match(line)
        if not m:
            return
        try:
            ts = datetime.strptime(m["time"], TIME_FMT).timestamp()
        except ValueError:
            return
        if since is not None and ts < since:
            return
        host = "(ไม่ตรงโดเมน)" if fallback else m["host"]
        status = int(m["status"]) if m["status"].isdigit() else 0
        cls = f"s{status // 100}" if 200 <= status < 600 else "s0"
        size = int(m["len"])
        self.hist.add(ts, {f"ng:{host}:req": 1, f"ng:{host}:{cls}": 1, f"ng:{host}:bytes": size, f"ng:all:{cls}": 1})
        hour = int(ts // 3600 * 3600)
        with self.lock:
            self.hosts.add(host)
            path = m["path"]
            if not ASSET_RE.search(path.split("?", 1)[0]):
                self.paths[hour][(host, norm_path(path), m["method"])] += 1
            self.clients[hour].add(hash(m["client"]))
            for h in [h for h in self.paths if h < time.time() - 7 * 86400]:
                del self.paths[h]
                self.clients.pop(h, None)

    def top(self, since: float, n: int = 12) -> dict:
        with self.lock:
            total: Counter = Counter()
            clients: set = set()
            for h, c in self.paths.items():
                if h + 3600 > since:
                    total.update(c)
            for h, s in self.clients.items():
                if h + 3600 > since:
                    clients |= s
        return {
            "paths": [{"host": k[0], "path": k[1], "method": k[2], "count": v} for k, v in total.most_common(n)],
            "unique_clients": len(clients),
        }


# ------------------------------------------------------------------ sampler
class Collector:
    def __init__(self) -> None:
        self.hist = Tiered()
        self.logs = LogTail(self.hist)
        self.prev: dict | None = None
        self.started = time.time()
        self.load_saved()

    def load_saved(self) -> None:
        f = DATA / "history.json.gz"
        try:
            d = json.loads(gzip.decompress(f.read_bytes()))
            self.hist.load(d["hist"])
            self.logs.pos = {k: tuple(v) for k, v in d.get("logpos", {}).items()}
            print("loaded saved history", flush=True)
        except (OSError, ValueError, KeyError):
            # first start: backfill the last 7 days of proxy traffic from the existing logs
            self.logs.poll(backfill_since=time.time() - 7 * 86400)
            print("backfilled proxy logs", flush=True)

    def save(self) -> None:
        DATA.mkdir(parents=True, exist_ok=True)
        tmp = DATA / "history.json.gz.tmp"
        tmp.write_bytes(gzip.compress(json.dumps({"hist": self.hist.dump(), "logpos": self.logs.pos}).encode()))
        tmp.replace(DATA / "history.json.gz")

    def sample(self) -> None:
        now = time.time()
        cur = {
            "t": now,
            "cpu": cpu_times(),
            "net": net_bytes(),
            "disk": disk_bytes(),
            "cg": {cid: cg_stats(d) for cid, d in containers().items()},
        }
        prev, self.prev = self.prev, cur
        if prev is None:
            return
        dt = max(1e-3, now - prev["t"])
        d = [a - b for a, b in zip(cur["cpu"], prev["cpu"], strict=True)]
        total = max(1, sum(d))
        mi = meminfo()
        mem_total = mi.get("MemTotal", 0)
        avail = mi.get("MemAvailable", 0)
        cache = mi.get("Buffers", 0) + mi.get("Cached", 0) + mi.get("SReclaimable", 0)
        load = read(PROC / "loadavg").split()
        v = {
            "cpu_user": 100 * (d[0] + d[1]) / total,
            "cpu_system": 100 * (d[2] + d[5] + d[6]) / total,
            "cpu_iowait": 100 * d[4] / total,
            "cpu_steal": 100 * d[7] / total,
            "mem_used": mem_total - avail,
            "mem_cache": max(0, min(cache, avail)),
            "swap_used": mi.get("SwapTotal", 0) - mi.get("SwapFree", 0),
            "load1": float(load[0]) if load else 0.0,
            "net_rx": (cur["net"][0] - prev["net"][0]) / dt,
            "net_tx": (cur["net"][1] - prev["net"][1]) / dt,
            "disk_rd": (cur["disk"][0] - prev["disk"][0]) / dt,
            "disk_wr": (cur["disk"][1] - prev["disk"][1]) / dt,
        }
        ncpu = os.cpu_count() or 1
        for cid, c in cur["cg"].items():
            p = prev["cg"].get(cid)
            if not p:
                continue
            short = cid[:12]
            v[f"c:{short}:cpu"] = max(0.0, 100 * (c["cpu_usec"] - p["cpu_usec"]) / (dt * 1e6 * ncpu))
            v[f"c:{short}:mem"] = c["mem"]
            v[f"c:{short}:rx"] = max(0, c["rx"] - p["rx"]) / dt
            v[f"c:{short}:tx"] = max(0, c["tx"] - p["tx"]) / dt
            v[f"c:{short}:rd"] = max(0, c["rd"] - p["rd"]) / dt
            v[f"c:{short}:wr"] = max(0, c["wr"] - p["wr"]) / dt
        self.hist.add(now, {k: round(x, 3) for k, x in v.items()})

    def run(self) -> None:
        last_save = time.time()
        while True:
            t0 = time.time()
            try:
                self.sample()
                self.logs.poll()
                self.hist.prune(t0)
                if t0 - last_save > SAVE_EVERY_S:
                    self.save()
                    last_save = t0
            except Exception as exc:  # keep sampling whatever happens
                print(f"sample error: {exc!r}", flush=True)
            time.sleep(max(0.5, SAMPLE_S - (time.time() - t0)))

    def payload(self, rng: str) -> dict:
        now = time.time()
        step, n = TIERS[rng]
        times, cols = self.hist.series(rng, now)
        host = {k: v for k, v in cols.items() if not k.startswith(("c:", "ng:"))}
        ctr: dict[str, dict] = defaultdict(dict)
        nginx: dict[str, dict] = defaultdict(dict)
        for k, col in cols.items():
            if k.startswith("c:"):
                _, cid, f = k.split(":", 2)
                ctr[cid][f] = col
            elif k.startswith("ng:"):
                h, f = k[3:].rsplit(":", 1)  # host names have dots, never colons
                nginx[h][f] = col
        return {
            "range": rng,
            "step": step,
            "times": times,
            "host": host,
            "containers": ctr,
            "nginx": nginx,
            "snapshot": host_snapshot(),
            "top": self.logs.top(now - step * n),
            "collector_uptime_s": int(now - self.started),
        }


COLLECTOR: Collector | None = None


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        u = urlsplit(self.path)
        if u.path != "/metrics":
            self.send_error(404)
            return
        rng = parse_qs(u.query).get("range", ["1h"])[0]
        if rng not in TIERS:
            self.send_error(400)
            return
        body = gzip.compress(json.dumps(COLLECTOR.payload(rng), separators=(",", ":")).encode())
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Encoding", "gzip")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args) -> None:
        pass


def main() -> None:
    global COLLECTOR
    COLLECTOR = Collector()
    threading.Thread(target=COLLECTOR.run, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", 9100), Handler).serve_forever()


if __name__ == "__main__":
    main()

"""Synthetic retained-history/concurrent-read/save memory regression; localhost only."""

from __future__ import annotations

import argparse
import concurrent.futures
import gzip
import http.client
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path


def request(port: int, path: str) -> tuple[int, bytes]:
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=90)
    try:
        connection.request("GET", path)
        response = connection.getresponse()
        return response.status, response.read()
    finally:
        connection.close()


def fixture(root: Path, now: int) -> int:
    """206 columns, all 2,808 retained buckets; no real host/log data."""
    keys = [
        "cpu_user",
        "cpu_system",
        "cpu_iowait",
        "cpu_steal",
        "mem_used",
        "mem_cache",
        "swap_used",
        "load1",
        "net_rx",
        "net_tx",
        "disk_rd",
        "disk_wr",
    ]
    keys += [
        f"c:{cid:012x}:{field}"
        for cid in range(24)
        for field in ("cpu", "mem", "rx", "tx", "rd", "wr")
    ]
    keys += [
        f"ng:fixture-{host}.test:{field}"
        for host in range(10)
        for field in ("req", "s2", "s4", "s5", "bytes")
    ]
    # Write one bucket at a time so the test runner itself need not retain history.
    history = root / "data/history.json.gz"
    with gzip.open(history, "wt", encoding="utf-8") as output:
        output.write('{"hist":{')
        for tier_index, (name, step, count) in enumerate(
            (("1h", 10, 360), ("24h", 60, 1440), ("7d", 600, 1008))
        ):
            if tier_index:
                output.write(",")
            output.write(json.dumps(name) + ":{")
            end = now // step * step
            for bucket in range(count):
                if bucket:
                    output.write(",")
                output.write(json.dumps(str(end - (count - 1 - bucket) * step)) + ":")
                json.dump(
                    {
                        key: [float(index + bucket % 17), 1.0]
                        for index, key in enumerate(keys)
                    },
                    output,
                    separators=(",", ":"),
                )
            output.write("}")
        output.write('},"logpos":{}}')
    return len(keys)


def run(binary: Path, root: Path, now: int, requests: int, serve_only: bool) -> dict:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    env = {
        **os.environ,
        "PORT": str(port),
        "DATA_DIR": str(root / "data"),
        "HOST_PROC": str(root / "proc"),
        "HOST_CGROUP": str(root / "cgroup"),
        "HOST_FILE": str(root / "hostname"),
        "NPM_LOGS": str(root / "logs"),
        "METRICS_SERVE_ONLY": str(serve_only).lower(),
    }
    env.pop("METRICS_FIXED_NOW", None)
    if serve_only:
        env["METRICS_FIXED_NOW"] = str(now)
    peak = {"load": 0, "requests": 0, "save": 0}
    phase = "load"
    stop = threading.Event()
    with (root / "stderr.txt").open("wb") as errors:
        process = subprocess.Popen(
            [str(binary)], env=env, stdout=subprocess.DEVNULL, stderr=errors
        )

        def sample():
            while not stop.is_set():
                result = subprocess.run(
                    ["ps", "-o", "rss=", "-p", str(process.pid)],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                if result.stdout.strip():
                    peak[phase] = max(peak[phase], int(result.stdout.strip()) * 1024)
                stop.wait(0.02)

        sampler = threading.Thread(target=sample, daemon=True)
        sampler.start()
        try:
            for _ in range(1000):
                if process.poll() is not None:
                    raise AssertionError((root / "stderr.txt").read_text())
                try:
                    if request(port, "/healthz")[0] == 200:
                        break
                except OSError:
                    pass
                time.sleep(0.02)
            else:
                raise AssertionError("startup timeout")
            time.sleep(0.1)
            assert "loaded saved history" in (root / "stderr.txt").read_text()
            phase = "requests"
            barrier = threading.Barrier(requests)

            def read_metrics(index: int):
                barrier.wait(timeout=10)
                name = ("24h", "24h", "1h", "7d")[index % 4]
                status, raw = request(port, "/metrics?range=" + name)
                assert status == 200, (status, raw[:200])
                data = json.loads(gzip.decompress(raw))
                assert data["range"] == name
                assert len(data["times"]) == {"1h": 360, "24h": 1440, "7d": 1008}[name]
                assert len(data["host"]) == 12
                assert len(data["containers"]) == 24
                assert len(data["nginx"]) == 10
                if serve_only:
                    assert data["host"]["cpu_user"][-1] == (
                        {"1h": 359, "24h": 1439, "7d": 1007}[name] % 17
                    )
                return len(raw)

            with concurrent.futures.ThreadPoolExecutor(max_workers=requests) as pool:
                sizes = list(pool.map(read_metrics, range(requests)))
            phase = "save"
            process.send_signal(signal.SIGTERM)
            assert process.wait(timeout=90) == 0, (root / "stderr.txt").read_text()
            if not serve_only:
                with gzip.open(root / "data/history.json.gz", "rt") as saved:
                    hist = json.load(saved)["hist"]
                assert all(hist[name] for name in ("1h", "24h", "7d"))
            return {
                "mode": "serve-only" if serve_only else "sampler-and-save",
                "peak_rss_mib": {
                    key: round(value / 1024**2, 1) for key, value in peak.items()
                },
                "requests": requests,
                "gzip_response_bytes": [min(sizes), max(sizes)],
            }
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            stop.set()
            sampler.join(timeout=5)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--binary",
        type=Path,
        default=Path(__file__).parents[1] / "target/debug/dock-metrics",
    )
    parser.add_argument("--requests", type=int, default=16)
    parser.add_argument("--max-rss-mib", type=float, default=128)
    args = parser.parse_args()
    assert 1 <= args.requests <= 64
    reports = []
    with tempfile.TemporaryDirectory(prefix="metrics-memory-") as temp:
        root = Path(temp)
        (root / "data").mkdir()
        (root / "logs").mkdir()
        (root / "hostname").write_text("fixture-host\n")
        now = int(time.time())
        columns = fixture(root, now)
        original = (root / "data/history.json.gz").read_bytes()
        for serve_only in (True, False):
            reports.append(
                run(args.binary.resolve(), root, now, args.requests, serve_only)
            )
            if serve_only:
                assert (root / "data/history.json.gz").read_bytes() == original
        print(
            json.dumps(
                {"columns": columns, "retained_buckets": 2808, "results": reports},
                indent=2,
            ),
            flush=True,
        )
    peak = max(value for report in reports for value in report["peak_rss_mib"].values())
    if peak > args.max_rss_mib:
        sys.exit(f"peak {peak:.1f} MiB exceeds {args.max_rss_mib:.1f} MiB")


if __name__ == "__main__":
    main()

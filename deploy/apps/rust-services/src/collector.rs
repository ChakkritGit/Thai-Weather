use crate::{
    history::{Columns, Tiered, Values, round, tier},
    host::{self, Cg, Paths},
    logs::{LogTail, Positions},
};
use flate2::{Compression, read::GzDecoder, write::GzEncoder};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{BufReader, BufWriter, Read, Write},
    time::{SystemTime, UNIX_EPOCH},
};

pub fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}
fn write_gzip<W: Write, T: Serialize>(writer: W, value: &T) -> std::io::Result<W> {
    // Batch serde's small token writes before compression while keeping memory fixed.
    let mut buffered =
        BufWriter::with_capacity(64 * 1024, GzEncoder::new(writer, Compression::default()));
    serde_json::to_writer(&mut buffered, value)?;
    buffered.into_inner().map_err(|e| e.into_error())?.finish()
}
#[derive(Serialize, Deserialize)]
struct Saved {
    hist: Tiered,
    #[serde(default)]
    logpos: Positions,
}
#[derive(Serialize)]
struct SavedRef<'a> {
    hist: &'a Tiered,
    logpos: &'a Positions,
}
#[derive(Serialize)]
struct Payload<'a> {
    range: &'a str,
    step: i64,
    times: Vec<i64>,
    host: Columns,
    containers: BTreeMap<String, Columns>,
    nginx: BTreeMap<String, Columns>,
    snapshot: Value,
    top: Value,
    collector_uptime_s: f64,
}
struct Sample {
    t: f64,
    cpu: [f64; 8],
    net: [f64; 2],
    disk: [f64; 2],
    cg: BTreeMap<String, Cg>,
}
pub struct Collector {
    pub hist: Tiered,
    pub logs: LogTail,
    pub paths: Paths,
    pub started: f64,
    prev: Option<Sample>,
}
impl Collector {
    pub fn load(paths: Paths, now: f64) -> Self {
        let mut out = Self {
            hist: Tiered::default(),
            logs: LogTail::default(),
            paths,
            started: now,
            prev: None,
        };
        let saved = File::open(out.paths.data.join("history.json.gz")).and_then(|f| {
            // Decode directly into the retained buckets, without a second full JSON buffer.
            let mut reader = BufReader::new(GzDecoder::new(f).take(128 * 1024 * 1024 + 1));
            let saved =
                serde_json::from_reader::<_, Saved>(&mut reader).map_err(std::io::Error::other)?;
            if reader.get_ref().limit() == 0 {
                return Err(std::io::Error::other("history exceeds limit"));
            }
            Ok(saved)
        });
        match saved {
            Ok(saved) => {
                out.hist = saved.hist;
                out.hist.prune(now);
                out.logs.pos = saved.logpos;
                eprintln!("loaded saved history");
            }
            Err(_) => {
                if let Err(e) =
                    out.logs
                        .poll(&mut out.hist, &out.paths.logs, Some(now - 7. * 86400.), now)
                {
                    eprintln!("log backfill error: {e}");
                }
                eprintln!("backfilled proxy logs");
            }
        }
        out
    }
    pub fn save(&self) -> std::io::Result<()> {
        fs::create_dir_all(&self.paths.data)?;
        let tmp = self.paths.data.join("history.json.gz.tmp");
        // Borrow the history and stream through gzip: a Value tree plus raw JSON can
        // otherwise exceed the collector's entire resident history several times over.
        let mut writer = write_gzip(
            BufWriter::new(File::create(&tmp)?),
            &SavedRef {
                hist: &self.hist,
                logpos: &self.logs.pos,
            },
        )?;
        writer.flush()?;
        let file = writer.into_inner().map_err(|e| e.into_error())?;
        file.sync_all()?;
        fs::rename(tmp, self.paths.data.join("history.json.gz"))?;
        File::open(&self.paths.data)?.sync_all()?;
        Ok(())
    }
    pub fn sample(&mut self, now: f64) {
        let cur = Sample {
            t: now,
            cpu: host::cpu_times(&self.paths.proc),
            net: host::net_dev(&self.paths.proc.join("1/net/dev"), true),
            disk: host::disk_bytes(&self.paths.proc),
            cg: host::containers(&self.paths),
        };
        if let Some(prev) = &self.prev {
            let dt = (now - prev.t).max(1e-3);
            let d: [f64; 8] = std::array::from_fn(|i| cur.cpu[i] - prev.cpu[i]);
            let total = d.iter().sum::<f64>().max(1.);
            let mi = host::meminfo(&self.paths.proc);
            let get = |k: &str| mi.get(k).copied().unwrap_or(0.);
            let available = get("MemAvailable");
            let cache = get("Buffers") + get("Cached") + get("SReclaimable");
            let load = host::read(self.paths.proc.join("loadavg"));
            let mut v = Values::from([
                ("cpu_user".into(), 100. * (d[0] + d[1]) / total),
                ("cpu_system".into(), 100. * (d[2] + d[5] + d[6]) / total),
                ("cpu_iowait".into(), 100. * d[4] / total),
                ("cpu_steal".into(), 100. * d[7] / total),
                ("mem_used".into(), get("MemTotal") - available),
                ("mem_cache".into(), cache.min(available).max(0.)),
                ("swap_used".into(), get("SwapTotal") - get("SwapFree")),
                (
                    "load1".into(),
                    host::num(load.split_whitespace().next().unwrap_or("")),
                ),
                ("net_rx".into(), (cur.net[0] - prev.net[0]) / dt),
                ("net_tx".into(), (cur.net[1] - prev.net[1]) / dt),
                ("disk_rd".into(), (cur.disk[0] - prev.disk[0]) / dt),
                ("disk_wr".into(), (cur.disk[1] - prev.disk[1]) / dt),
            ]);
            for (cid, c) in &cur.cg {
                if let Some(p) = prev.cg.get(cid) {
                    for (key, value) in [
                        (
                            "cpu",
                            (100. * (c.cpu - p.cpu) / (dt * 1e6 * host::cpus() as f64)).max(0.),
                        ),
                        ("mem", c.mem),
                        ("rx", (c.rx - p.rx).max(0.) / dt),
                        ("tx", (c.tx - p.tx).max(0.) / dt),
                        ("rd", (c.rd - p.rd).max(0.) / dt),
                        ("wr", (c.wr - p.wr).max(0.) / dt),
                    ] {
                        v.insert(format!("c:{}:{key}", &cid[..12]), value);
                    }
                }
            }
            v.values_mut().for_each(|x| *x = round(*x, 1000.));
            self.hist.add(now, &v);
        }
        self.prev = Some(cur);
    }
    pub fn tick(&mut self, now: f64) -> std::io::Result<()> {
        self.sample(now);
        self.logs
            .poll(&mut self.hist, &self.paths.logs, None, now)?;
        self.hist.prune(now);
        Ok(())
    }
    pub fn gzip_payload(&self, range: &str, now: f64) -> std::io::Result<Vec<u8>> {
        write_gzip(Vec::new(), &self.payload(range, now)?)
    }
    fn payload<'a>(&self, range: &'a str, now: f64) -> std::io::Result<Payload<'a>> {
        let (step, count) = tier(range).ok_or_else(|| std::io::Error::other("bad range"))?;
        let (times, cols) = self.hist.series(range, now);
        let mut host = Columns::new();
        let mut containers: BTreeMap<String, Columns> = BTreeMap::new();
        let mut nginx: BTreeMap<String, Columns> = BTreeMap::new();
        for (key, col) in cols {
            if let Some((cid, field)) = key.strip_prefix("c:").and_then(|s| s.split_once(':')) {
                containers
                    .entry(cid.into())
                    .or_default()
                    .insert(field.into(), col);
            } else if let Some((domain, field)) =
                key.strip_prefix("ng:").and_then(|s| s.rsplit_once(':'))
            {
                nginx
                    .entry(domain.into())
                    .or_default()
                    .insert(field.into(), col);
            } else {
                host.insert(key, col);
            }
        }
        Ok(Payload {
            range,
            step,
            times,
            host,
            containers,
            nginx,
            snapshot: host::snapshot(&self.paths)?,
            top: self.logs.top(now - step as f64 * count as f64),
            collector_uptime_s: (now - self.started).floor(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;
    fn fixture() -> Value {
        serde_json::from_str(include_str!("../tests/fixtures/bun-contract.json")).unwrap()
    }
    fn equal_json(a: &Value, b: &Value) {
        match (a, b) {
            (Value::Number(x), Value::Number(y)) => assert!(
                (x.as_f64().unwrap() - y.as_f64().unwrap()).abs() < 1e-8,
                "{x} != {y}"
            ),
            (Value::Array(x), Value::Array(y)) => {
                assert_eq!(x.len(), y.len());
                for (a, b) in x.iter().zip(y) {
                    equal_json(a, b);
                }
            }
            (Value::Object(x), Value::Object(y)) => {
                assert_eq!(x.len(), y.len());
                for (k, a) in x {
                    equal_json(a, &y[k]);
                }
            }
            _ => assert_eq!(a, b),
        }
    }
    #[test]
    fn persisted_history_and_all_three_wire_series_match_bun_golden() {
        let f = fixture();
        let h: Tiered = serde_json::from_value(f["hist"].clone()).unwrap();
        equal_json(&serde_json::to_value(&h).unwrap(), &f["hist"]);
        for (name, _, _) in crate::history::TIERS {
            let (times, cols) = h.series(name, f["now"].as_f64().unwrap());
            let compact = json!({"count":times.len(),"first":times.first(),"last":times.last(),"cols":cols.into_iter().map(|(k,v)|(k,v.into_iter().enumerate().filter_map(|(i,v)|v.map(|x|json!([i,x]))).collect::<Vec<_>>())).collect::<BTreeMap<_,_>>()});
            equal_json(&compact, &f["series"][name]);
        }
        let mut actual = Tiered::default();
        let mut logs = LogTail::default();
        for line in f["lines"].as_array().unwrap() {
            let line = line.as_str().unwrap();
            logs.ingest(
                &mut actual,
                line,
                line.contains("] 444 -"),
                None,
                f["now"].as_f64().unwrap(),
            );
        }
        equal_json(&logs.top(f["now"].as_f64().unwrap() - 86400.), &f["top"]);
    }
    #[test]
    fn streamed_payload_preserves_columns_and_gzip_contract() {
        let f = fixture();
        let dir = Temp::new();
        fs::write(dir.0.join("hostname"), "fixture-host\n").unwrap();
        let mut c = Collector::load(paths(&dir), f["now"].as_f64().unwrap());
        c.hist = serde_json::from_value(f["hist"].clone()).unwrap();
        for (range, _, _) in crate::history::TIERS {
            let bytes = c.gzip_payload(range, c.started).unwrap();
            let actual: Value = serde_json::from_reader(GzDecoder::new(&bytes[..])).unwrap();
            assert_eq!(actual["range"], range);
            let mut columns = BTreeMap::new();
            for (key, values) in actual["host"].as_object().unwrap() {
                columns.insert(key.clone(), values);
            }
            for (section, prefix) in [("containers", "c"), ("nginx", "ng")] {
                for (name, fields) in actual[section].as_object().unwrap() {
                    for (field, values) in fields.as_object().unwrap() {
                        columns.insert(format!("{prefix}:{name}:{field}"), values);
                    }
                }
            }
            let compact: BTreeMap<_, _> = columns
                .into_iter()
                .map(|(key, values)| {
                    let values: Vec<_> = values
                        .as_array()
                        .unwrap()
                        .iter()
                        .enumerate()
                        .filter(|(_, value)| !value.is_null())
                        .map(|(i, value)| json!([i, value]))
                        .collect();
                    (key, values)
                })
                .collect();
            equal_json(
                &serde_json::to_value(compact).unwrap(),
                &f["series"][range]["cols"],
            );
        }
    }
    #[test]
    fn host_and_cgroup_rates_match_legacy_units_and_exclude_virtual_traffic() {
        let dir = Temp::new();
        let paths = paths(&dir);
        fs::create_dir_all(paths.proc.join("1/net")).unwrap();
        fs::create_dir_all(paths.proc.join("123/net")).unwrap();
        let group = paths
            .cgroup
            .join("system.slice")
            .join(format!("docker-{}.scope", "a".repeat(64)));
        fs::create_dir_all(&group).unwrap();
        let net = |rx: u64, tx: u64| {
            format!(
                "header\nheader\nlo: 99999 0 0 0 0 0 0 0 99999\neth0: {rx} 0 0 0 0 0 0 0 {tx}\nveth1: 90000 0 0 0 0 0 0 0 90000\n"
            )
        };
        fs::write(paths.proc.join("stat"), "cpu 100 10 50 1000 10 0 0 0\n").unwrap();
        fs::write(paths.proc.join("meminfo"),"MemTotal: 1000 kB\nMemAvailable: 400 kB\nBuffers: 50 kB\nCached: 100 kB\nSReclaimable: 25 kB\nSwapTotal: 200 kB\nSwapFree: 180 kB\n").unwrap();
        fs::write(paths.proc.join("loadavg"), "0.5 0.4 0.3 1/123 99").unwrap();
        fs::write(paths.proc.join("1/net/dev"), net(1000, 2000)).unwrap();
        fs::write(paths.proc.join("123/net/dev"), net(500, 1000)).unwrap();
        fs::write(
            paths.proc.join("diskstats"),
            "8 0 sda 0 0 10 0 0 0 40 0\n8 1 sda1 0 0 999 0 0 0 999 0\n",
        )
        .unwrap();
        fs::write(group.join("cpu.stat"), "usage_usec 1000000\n").unwrap();
        fs::write(group.join("memory.current"), "10000").unwrap();
        fs::write(group.join("memory.stat"), "inactive_file 3000\n").unwrap();
        fs::write(
            group.join("io.stat"),
            "8:0 rbytes=1000 wbytes=2000 rios=0\n",
        )
        .unwrap();
        fs::write(group.join("cgroup.procs"), "123\n").unwrap();
        let mut c = Collector::load(paths.clone(), 0.);
        c.sample(5.);
        fs::write(paths.proc.join("stat"), "cpu 120 15 60 1050 15 2 3 0\n").unwrap();
        fs::write(paths.proc.join("1/net/dev"), net(2000, 4000)).unwrap();
        fs::write(paths.proc.join("123/net/dev"), net(1500, 3000)).unwrap();
        fs::write(
            paths.proc.join("diskstats"),
            "8 0 sda 0 0 30 0 0 0 50 0\n8 1 sda1 0 0 999 0 0 0 999 0\n",
        )
        .unwrap();
        fs::write(group.join("cpu.stat"), "usage_usec 3000000\n").unwrap();
        fs::write(
            group.join("io.stat"),
            "8:0 rbytes=2000 wbytes=4000 rios=0\n",
        )
        .unwrap();
        c.sample(10.);
        let (_, v) = c.hist.series("1h", 10.);
        let last = |k: &str| v[k].last().unwrap().unwrap();
        assert_eq!(last("cpu_user"), 26.316);
        assert_eq!(last("cpu_system"), 15.789);
        assert_eq!(last("cpu_iowait"), 5.263);
        assert_eq!(last("mem_used"), 600. * 1024.);
        assert_eq!(last("mem_cache"), 175. * 1024.);
        assert_eq!(last("swap_used"), 20. * 1024.);
        assert_eq!(last("net_rx"), 200.);
        assert_eq!(last("net_tx"), 400.);
        assert_eq!(last("disk_rd"), 2048.);
        assert_eq!(last("disk_wr"), 1024.);
        let key = format!("c:{}:", "a".repeat(12));
        assert_eq!(
            last(&format!("{key}cpu")),
            round(40. / host::cpus() as f64, 1000.)
        );
        assert_eq!(last(&format!("{key}mem")), 7000.);
        assert_eq!(last(&format!("{key}rx")), 200.);
        assert_eq!(last(&format!("{key}wr")), 400.);
    }
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let p =
                std::env::temp_dir().join(format!("rust-metrics-{}-{}", std::process::id(), now()));
            fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn paths(dir: &Temp) -> Paths {
        Paths {
            proc: dir.0.join("proc"),
            cgroup: dir.0.join("cgroup"),
            hostfile: dir.0.join("hostname"),
            logs: dir.0.join("logs"),
            data: dir.0.join("data"),
        }
    }
    #[test]
    fn complete_line_offsets_survive_partial_writes_truncation_and_inode_rotation() {
        let f = fixture();
        let now = f["now"].as_f64().unwrap();
        let dir = Temp::new();
        let paths = paths(&dir);
        fs::create_dir_all(&paths.logs).unwrap();
        let file = paths.logs.join("proxy-host-1_access.log");
        let line = f["lines"][0].as_str().unwrap();
        fs::write(&file, format!("{line}\n{line}")).unwrap();
        let mut h = Tiered::default();
        let mut logs = LogTail::default();
        logs.poll(&mut h, &paths.logs, Some(now - 86400.), now)
            .unwrap();
        assert_eq!(logs.top(now - 86400.)["paths"][0]["count"], 1);
        fs::OpenOptions::new()
            .append(true)
            .open(&file)
            .unwrap()
            .write_all(b"\n")
            .unwrap();
        logs.poll(&mut h, &paths.logs, None, now).unwrap();
        assert_eq!(logs.top(now - 86400.)["paths"][0]["count"], 2);
        logs.poll(&mut h, &paths.logs, None, now).unwrap();
        assert_eq!(logs.top(now - 86400.)["paths"][0]["count"], 2);
        fs::write(&file, format!("{line}\n")).unwrap();
        logs.poll(&mut h, &paths.logs, None, now).unwrap();
        assert_eq!(logs.top(now - 86400.)["paths"][0]["count"], 3);
        fs::rename(&file, file.with_extension("old")).unwrap();
        fs::write(&file, format!("{line}\n")).unwrap();
        logs.poll(&mut h, &paths.logs, None, now).unwrap();
        assert_eq!(logs.top(now - 86400.)["paths"][0]["count"], 4);
    }
    #[test]
    fn saved_gzip_and_offsets_resume_without_recounting_old_accesses() {
        let f = fixture();
        let now = f["now"].as_f64().unwrap();
        let dir = Temp::new();
        let paths = paths(&dir);
        fs::create_dir_all(&paths.logs).unwrap();
        fs::write(
            paths.logs.join("proxy-host-1_access.log"),
            format!("{}\n", f["lines"][0].as_str().unwrap()),
        )
        .unwrap();
        let c = Collector::load(paths.clone(), now);
        assert_eq!(c.logs.top(now - 86400.)["unique_clients"], 1);
        c.save().unwrap();
        let bytes = fs::read(paths.data.join("history.json.gz")).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("192.0.2"));
        let mut restored = Collector::load(paths, now);
        restored
            .logs
            .poll(&mut restored.hist, &restored.paths.logs, None, now)
            .unwrap();
        equal_json(
            &serde_json::to_value(&c.hist).unwrap(),
            &serde_json::to_value(&restored.hist).unwrap(),
        );
        assert_eq!(restored.logs.top(now - 86400.)["unique_clients"], 0); // legacy clients/top are memory-only
    }
}

use crate::history::Values;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    ffi::CString,
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone)]
pub struct Paths {
    pub proc: PathBuf,
    pub cgroup: PathBuf,
    pub hostfile: PathBuf,
    pub logs: PathBuf,
    pub data: PathBuf,
}
impl Paths {
    pub fn from_env() -> Self {
        fn path(key: &str, fallback: &str) -> PathBuf {
            std::env::var_os(key)
                .map(PathBuf::from)
                .unwrap_or_else(|| fallback.into())
        }
        Self {
            proc: path("HOST_PROC", "/host/proc"),
            cgroup: path("HOST_CGROUP", "/host/cgroup"),
            hostfile: path("HOST_FILE", "/host/hostname"),
            logs: path("NPM_LOGS", "/npm-logs"),
            data: path("DATA_DIR", "/data"),
        }
    }
}
pub fn read(path: impl AsRef<Path>) -> String {
    fs::read_to_string(path).unwrap_or_default()
}
pub fn num(s: &str) -> f64 {
    s.parse::<f64>()
        .ok()
        .filter(|x| x.is_finite())
        .unwrap_or(0.)
}
pub fn meminfo(proc: &Path) -> Values {
    read(proc.join("meminfo"))
        .lines()
        .filter_map(|l| {
            let (key, value) = l.split_once(':')?;
            Some((
                key.into(),
                num(value.split_whitespace().next().unwrap_or("")) * 1024.,
            ))
        })
        .collect()
}
pub fn cpus() -> usize {
    std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1)
}
pub fn cpu_times(proc: &Path) -> [f64; 8] {
    let text = read(proc.join("stat"));
    let mut values = text
        .lines()
        .next()
        .unwrap_or("")
        .split_whitespace()
        .skip(1)
        .map(num);
    std::array::from_fn(|_| values.next().unwrap_or(0.))
}
pub fn net_dev(file: &Path, skip_virtual: bool) -> [f64; 2] {
    let mut out = [0.; 2];
    for line in read(file).lines().skip(2) {
        let Some((name, rest)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim();
        if name == "lo"
            || (skip_virtual
                && ["veth", "br-", "docker"]
                    .iter()
                    .any(|p| name.starts_with(p)))
        {
            continue;
        }
        let fields: Vec<_> = rest.split_whitespace().collect();
        if fields.len() > 8 {
            out[0] += num(fields[0]);
            out[1] += num(fields[8]);
        }
    }
    out
}
fn disk_name(s: &str) -> bool {
    if let Some(t) = ["xvd", "sd", "vd"].iter().find_map(|p| s.strip_prefix(p)) {
        return !t.is_empty() && t.bytes().all(|x| x.is_ascii_lowercase());
    }
    if let Some((a, b)) = s.strip_prefix("nvme").and_then(|x| x.split_once('n')) {
        return !a.is_empty()
            && !b.is_empty()
            && a.bytes().chain(b.bytes()).all(|x| x.is_ascii_digit());
    }
    false
}
pub fn disk_bytes(proc: &Path) -> [f64; 2] {
    let mut out = [0.; 2];
    for line in read(proc.join("diskstats")).lines() {
        let f: Vec<_> = line.split_whitespace().collect();
        if f.len() > 9 && disk_name(f[2]) {
            out[0] += num(f[5]) * 512.;
            out[1] += num(f[9]) * 512.;
        }
    }
    out
}
pub fn snapshot(paths: &Paths) -> std::io::Result<Value> {
    use std::os::unix::ffi::OsStrExt;
    let path = CString::new(paths.hostfile.as_os_str().as_bytes())?;
    let mut st = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: path is NUL-terminated and st points to a correctly sized writable structure.
    if unsafe { libc::statvfs(path.as_ptr(), st.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: successful statvfs initialized every field.
    let st = unsafe { st.assume_init() };
    let mi = meminfo(&paths.proc);
    let get = |k: &str| mi.get(k).copied().unwrap_or(0.);
    let load_text = read(paths.proc.join("loadavg"));
    let load: Vec<_> = load_text.split_whitespace().collect();
    let os = read(
        paths
            .hostfile
            .parent()
            .unwrap_or(Path::new("/"))
            .join("os-release"),
    );
    let os = os
        .lines()
        .find_map(|l| l.strip_prefix("PRETTY_NAME="))
        .unwrap_or("")
        .trim_matches('"');
    Ok(json!({"hostname":read(&paths.hostfile).trim(), "os":os,
        "kernel":read(paths.proc.join("sys/kernel/osrelease")).trim(),
        "uptime_s":num(read(paths.proc.join("uptime")).split_whitespace().next().unwrap_or("")).floor(),
        "cpus":cpus(), "mem_total":get("MemTotal"), "mem_available":get("MemAvailable"),
        "swap_total":get("SwapTotal"), "swap_free":get("SwapFree"),
        "disk_total":st.f_blocks as f64 * st.f_bsize as f64, "disk_free":st.f_bavail as f64 * st.f_bsize as f64,
        "disk_used":(st.f_blocks-st.f_bfree) as f64 * st.f_bsize as f64,
        "load":load.iter().take(3).map(|x|num(x)).collect::<Vec<_>>(),"procs":load.get(3).unwrap_or(&"")}))
}
#[derive(Default, Clone)]
pub struct Cg {
    pub cpu: f64,
    pub mem: f64,
    pub rd: f64,
    pub wr: f64,
    pub rx: f64,
    pub tx: f64,
}
pub fn containers(paths: &Paths) -> BTreeMap<String, Cg> {
    let mut out = BTreeMap::new();
    let Ok(entries) = fs::read_dir(paths.cgroup.join("system.slice")) else {
        return out;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(id) = name
            .to_str()
            .and_then(|s| s.strip_prefix("docker-"))
            .and_then(|s| s.strip_suffix(".scope"))
        else {
            continue;
        };
        if id.len() != 64
            || !id
                .bytes()
                .all(|x| x.is_ascii_digit() || (b'a'..=b'f').contains(&x))
        {
            continue;
        }
        let dir = entry.path();
        let cpu = read(dir.join("cpu.stat"))
            .lines()
            .find_map(|l| l.strip_prefix("usage_usec ").map(num))
            .unwrap_or(0.);
        let inactive = read(dir.join("memory.stat"))
            .lines()
            .find_map(|l| l.strip_prefix("inactive_file ").map(num))
            .unwrap_or(0.);
        let mut cg = Cg {
            cpu,
            mem: (num(read(dir.join("memory.current")).trim()) - inactive).max(0.),
            ..Cg::default()
        };
        for line in read(dir.join("io.stat")).lines() {
            for (k, v) in line
                .split_whitespace()
                .skip(1)
                .filter_map(|x| x.split_once('='))
            {
                match k {
                    "rbytes" => cg.rd += num(v),
                    "wbytes" => cg.wr += num(v),
                    _ => {}
                }
            }
        }
        if let Some(pid) = read(dir.join("cgroup.procs")).split_whitespace().next() {
            [cg.rx, cg.tx] = net_dev(&paths.proc.join(pid).join("net/dev"), false);
        }
        out.insert(id.into(), cg);
    }
    out
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disks_exclude_partitions_and_loop_devices() {
        for n in ["sda", "vda", "xvdab", "nvme0n1"] {
            assert!(disk_name(n));
        }
        for n in ["sda1", "nvme0n1p1", "loop0", "dm-0", ""] {
            assert!(!disk_name(n));
        }
    }
}

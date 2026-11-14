//! Offline country lookup for the attack map, from DB-IP's "IP to Country Lite" CSV
//! (https://db-ip.com/db/download/ip-to-country-lite, CC BY 4.0, attribution shown on Dock's Cyber page).
//!
//! The file is `start,end,CC` per line, IPv4 and IPv6 mixed, sorted and gap-free. Each family becomes a
//! sorted vector of range starts with the country of the range beginning there; the end of a range is
//! implied by the next start, and a gap gets an explicit unknown entry so a lookup never falls into the
//! previous range. No crate: the CSV is small enough to parse once at start-up.

use std::{
    fs::File,
    io::{BufRead, BufReader},
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    path::Path,
    str::FromStr,
};

/// DB-IP's code for reserved and unallocated space; it also marks a gap in the file
const UNKNOWN: [u8; 2] = *b"ZZ";

trait Addr: Copy + Ord {
    const ZERO: Self;
    fn succ(self) -> Option<Self>;
}
impl Addr for u32 {
    const ZERO: Self = 0;
    fn succ(self) -> Option<Self> {
        self.checked_add(1)
    }
}
impl Addr for u128 {
    const ZERO: Self = 0;
    fn succ(self) -> Option<Self> {
        self.checked_add(1)
    }
}

struct Table<T> {
    starts: Vec<T>,
    cc: Vec<[u8; 2]>,
    /// the first address not covered yet; None before the first range
    next: Option<T>,
    /// a range ended at the top of the address space
    closed: bool,
}
impl<T: Addr> Table<T> {
    fn new() -> Self {
        Self {
            starts: Vec::new(),
            cc: Vec::new(),
            next: None,
            closed: false,
        }
    }
    /// Ranges must arrive in ascending order; an overlapping or reversed one is skipped
    fn add(&mut self, start: T, end: T, cc: [u8; 2]) {
        let expected = self.next.unwrap_or(T::ZERO);
        if self.closed || end < start || start < expected {
            return;
        }
        if start > expected {
            self.starts.push(expected);
            self.cc.push(UNKNOWN);
        }
        self.starts.push(start);
        self.cc.push(cc);
        match end.succ() {
            Some(n) => self.next = Some(n),
            None => self.closed = true,
        }
    }
    /// What the file leaves uncovered after its last range is unknown, not part of that range
    fn finish(&mut self) {
        if let (Some(n), false) = (self.next, self.closed) {
            self.starts.push(n);
            self.cc.push(UNKNOWN);
            self.closed = true;
        }
    }
    fn lookup(&self, ip: T) -> Option<[u8; 2]> {
        let at = self.starts.partition_point(|s| *s <= ip);
        let cc = *self.cc.get(at.checked_sub(1)?)?;
        (cc != UNKNOWN).then_some(cc)
    }
}

pub struct Geo {
    v4: Table<u32>,
    v6: Table<u128>,
}

impl Geo {
    /// Reads DB-IP's CSV, plain or gzip (detected by its magic bytes)
    pub fn load(path: &Path) -> std::io::Result<Self> {
        let mut head = BufReader::new(File::open(path)?);
        if head.fill_buf()?.starts_with(&[0x1f, 0x8b]) {
            Ok(Self::parse(BufReader::new(
                flate2::bufread::GzDecoder::new(head),
            )))
        } else {
            Ok(Self::parse(head))
        }
    }

    pub fn parse(reader: impl BufRead) -> Self {
        let mut v4 = Table::new();
        let mut v6 = Table::new();
        for line in reader.lines().map_while(Result::ok) {
            let mut f = line.split(',').map(|x| x.trim().trim_matches('"'));
            let (Some(a), Some(b), Some(c)) = (f.next(), f.next(), f.next()) else {
                continue;
            };
            let c = c.as_bytes();
            if c.len() != 2 || !c.iter().all(u8::is_ascii_alphabetic) {
                continue;
            }
            let cc = [c[0].to_ascii_uppercase(), c[1].to_ascii_uppercase()];
            if a.contains(':') {
                if let (Ok(s), Ok(e)) = (Ipv6Addr::from_str(a), Ipv6Addr::from_str(b)) {
                    v6.add(u128::from(s), u128::from(e), cc);
                }
            } else if let (Ok(s), Ok(e)) = (Ipv4Addr::from_str(a), Ipv4Addr::from_str(b)) {
                v4.add(u32::from(s), u32::from(e), cc);
            }
        }
        v4.finish();
        v6.finish();
        Self { v4, v6 }
    }

    /// The two-letter country of an address; None when unknown or reserved
    pub fn country(&self, ip: IpAddr) -> Option<[u8; 2]> {
        match ip {
            IpAddr::V4(v4) => self.v4.lookup(u32::from(v4)),
            IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
                Some(v4) => self.v4.lookup(u32::from(v4)),
                None => self.v6.lookup(u128::from(v6)),
            },
        }
    }

    /// (IPv4 entries, IPv6 entries), for the start-up log line
    pub fn size(&self) -> (usize, usize) {
        (self.v4.starts.len(), self.v6.starts.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CSV: &str = "\
1.0.0.0,1.0.0.255,AU
1.0.1.0,1.0.3.255,CN
1.0.8.0,1.0.15.255,th
10.0.0.0,10.255.255.255,ZZ
255.255.255.0,255.255.255.255,US
2001:db8::,2001:db8:ffff:ffff:ffff:ffff:ffff:ffff,DE
2a00::,2a00:ffff:ffff:ffff:ffff:ffff:ffff:ffff,\"NL\"
not,a,range
1.0.0.0,1.0.0.9,XX
";
    fn geo() -> Geo {
        Geo::parse(CSV.as_bytes())
    }
    fn at(g: &Geo, ip: &str) -> Option<String> {
        g.country(ip.parse().unwrap())
            .map(|c| String::from_utf8_lossy(&c).into_owned())
    }

    #[test]
    fn finds_the_range_an_address_falls_in() {
        let g = geo();
        assert_eq!(at(&g, "1.0.0.0").as_deref(), Some("AU"));
        assert_eq!(at(&g, "1.0.0.255").as_deref(), Some("AU"));
        assert_eq!(at(&g, "1.0.1.0").as_deref(), Some("CN"));
        assert_eq!(at(&g, "1.0.3.255").as_deref(), Some("CN"));
        // lower-case codes are normalised; the overlapping XX line was skipped
        assert_eq!(at(&g, "1.0.8.7").as_deref(), Some("TH"));
        assert_eq!(at(&g, "255.255.255.255").as_deref(), Some("US"));
    }

    #[test]
    fn gaps_and_reserved_space_are_unknown() {
        let g = geo();
        assert_eq!(at(&g, "0.0.0.1"), None, "before the first range");
        assert_eq!(at(&g, "1.0.4.0"), None, "between CN and TH");
        assert_eq!(at(&g, "1.0.16.0"), None, "after TH, before the ZZ block");
        assert_eq!(at(&g, "10.1.2.3"), None, "ZZ");
        assert_eq!(at(&g, "11.0.0.0"), None, "after ZZ, before US");
    }

    #[test]
    fn the_last_range_does_not_cover_what_follows_it() {
        let g = Geo::parse("1.0.0.0,1.0.0.255,AU\n".as_bytes());
        assert_eq!(at(&g, "1.0.0.128").as_deref(), Some("AU"));
        assert_eq!(at(&g, "1.0.1.0"), None);
        assert_eq!(at(&g, "200.1.1.1"), None);
    }

    #[test]
    fn ipv6_and_mapped_addresses() {
        let g = geo();
        assert_eq!(at(&g, "2001:db8::1").as_deref(), Some("DE"));
        assert_eq!(at(&g, "2a00:1::5").as_deref(), Some("NL"));
        assert_eq!(at(&g, "2001:db9::").as_deref(), None);
        assert_eq!(at(&g, "::ffff:1.0.1.9").as_deref(), Some("CN"));
        assert_eq!(g.size(), (9, 5));
    }

    #[test]
    fn loads_plain_and_gzip_files() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("geo-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let plain = dir.join("a.csv");
        std::fs::write(&plain, CSV).unwrap();
        let zipped = dir.join("a.csv.gz");
        let mut z = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        z.write_all(CSV.as_bytes()).unwrap();
        std::fs::write(&zipped, z.finish().unwrap()).unwrap();
        for p in [&plain, &zipped] {
            let g = Geo::load(p).unwrap();
            assert_eq!(at(&g, "1.0.2.2").as_deref(), Some("CN"), "{p:?}");
        }
        assert!(Geo::load(&dir.join("missing.csv")).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

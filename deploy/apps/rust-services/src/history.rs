use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const TIERS: [(&str, i64, usize); 3] = [("1h", 10, 360), ("24h", 60, 1440), ("7d", 600, 1008)];
pub type Values = BTreeMap<String, f64>;
pub type Columns = BTreeMap<String, Vec<Option<f64>>>;
pub type Buckets = BTreeMap<i64, BTreeMap<String, [f64; 2]>>;
#[derive(Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Tiered(pub BTreeMap<String, Buckets>);

pub fn tier(name: &str) -> Option<(i64, usize)> {
    TIERS.iter().find(|x| x.0 == name).map(|x| (x.1, x.2))
}
impl Tiered {
    pub fn add(&mut self, ts: f64, values: &Values) {
        self.add_retained(ts, values, ts);
    }
    pub fn add_retained(&mut self, ts: f64, values: &Values, now: f64) {
        for (name, step, count) in TIERS {
            let start = (ts / step as f64).floor() as i64 * step;
            // Log backfill spans seven days, but short tiers must never grow to
            // that whole span before their first normal sampling/prune cycle.
            if (start as f64) < now - step as f64 * count as f64 {
                continue;
            }
            let bucket = self
                .0
                .entry(name.into())
                .or_default()
                .entry(start)
                .or_default();
            for (key, value) in values {
                if value.is_finite() {
                    let acc = bucket.entry(key.clone()).or_default();
                    acc[0] += value;
                    acc[1] += 1.;
                }
            }
        }
    }
    pub fn prune(&mut self, now: f64) {
        for (name, step, count) in TIERS {
            if let Some(b) = self.0.get_mut(name) {
                b.retain(|t, _| *t as f64 >= now - step as f64 * count as f64);
            }
        }
    }
    pub fn series(&self, name: &str, now: f64) -> (Vec<i64>, Columns) {
        let (step, count) = tier(name).expect("validated tier");
        let end = (now / step as f64).floor() as i64 * step;
        let times: Vec<_> = (0..count)
            .map(|i| end - step * (count - 1 - i) as i64)
            .collect();
        let empty = BTreeMap::new();
        let buckets = self.0.get(name).unwrap_or(&empty);
        let keys: BTreeSet<_> = buckets.values().flat_map(|b| b.keys()).collect();
        let cols = keys
            .into_iter()
            .map(|key| {
                let counter = key.starts_with("ng:");
                let values = times
                    .iter()
                    .map(|t| match buckets.get(t).and_then(|b| b.get(key)) {
                        Some([sum, n]) => {
                            Some(round(if counter { *sum } else { sum / n }, 10_000.))
                        }
                        None if counter && buckets.contains_key(t) => Some(0.),
                        None => None,
                    })
                    .collect();
                (key.clone(), values)
            })
            .collect();
        (times, cols)
    }
}
pub fn round(v: f64, scale: f64) -> f64 {
    // Math.round rounds negative ties toward +infinity, unlike f64::round.
    (v * scale + 0.5).floor() / scale
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn counters_sum_gauges_average_and_missing_history_stays_missing() {
        let mut h = Tiered::default();
        h.add(
            20.,
            &Values::from([("cpu_user".into(), 2.), ("ng:all:s2".into(), 1.)]),
        );
        h.add(
            25.,
            &Values::from([("cpu_user".into(), 4.), ("ng:all:s2".into(), 1.)]),
        );
        h.add(30., &Values::from([("cpu_user".into(), 8.)]));
        let (times, cols) = h.series("1h", 30.);
        assert_eq!(times.len(), 360);
        assert_eq!(&times[358..], &[20, 30]);
        assert_eq!(&cols["cpu_user"][358..], &[Some(3.), Some(8.)]);
        assert_eq!(&cols["ng:all:s2"][358..], &[Some(2.), Some(0.)]);
        assert_eq!(cols["ng:all:s2"][357], None);
        let saved = serde_json::to_vec(&h).unwrap();
        let restored: Tiered = serde_json::from_slice(&saved).unwrap();
        assert_eq!(restored.series("1h", 30.), h.series("1h", 30.));
        h.prune(4000.);
        assert!(h.0["1h"].is_empty());
    }
    #[test]
    fn backfill_allocates_only_buckets_inside_each_tiers_retention() {
        let mut h = Tiered::default();
        let now = 7. * 86400.;
        let values = Values::from([("ng:all:s2".into(), 1.)]);
        for ts in (0..=now as i64).step_by(10) {
            h.add_retained(ts as f64, &values, now);
        }
        for (name, step, count) in TIERS {
            assert_eq!(h.0[name].len(), count + 1);
            assert_eq!(
                h.0[name].first_key_value().unwrap().0,
                &(now as i64 - step * count as i64)
            );
        }
    }
}

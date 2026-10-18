//! Per-client minute buckets and Bangkok-midnight daily budgets, bounded LRU.

use std::collections::{BTreeMap, HashMap};

const DAY: f64 = 86_400.0;
const BKK: f64 = 7.0 * 3600.0;

#[derive(Clone, Copy)]
pub struct Tier {
    pub name: &'static str,
    pub per_min: u32,
    pub per_day: u32,
}

struct Bucket {
    tokens: f64,
    at: f64,
    day: i64,
    used: u32,
    touched: u64,
}

pub struct Limiter {
    buckets: HashMap<(String, &'static str), Bucket>,
    order: BTreeMap<u64, (String, &'static str)>,
    sequence: u64,
    capacity: usize,
}

pub struct Decision {
    pub headers: [(&'static str, u32); 5],
    pub retry: u32,
}

impl Limiter {
    pub fn new(capacity: usize) -> Self {
        Self {
            buckets: HashMap::new(),
            order: BTreeMap::new(),
            sequence: 0,
            capacity: capacity.max(1),
        }
    }

    pub fn take(&mut self, client: &str, tier: Tier, now: f64) -> Decision {
        let key = (client.to_owned(), tier.name);
        if !self.buckets.contains_key(&key)
            && self.buckets.len() >= self.capacity
            && let Some((_, oldest)) = self.order.pop_first()
        {
            self.buckets.remove(&oldest);
        }
        self.sequence += 1;
        let day = ((now + BKK) / DAY).floor() as i64;
        let bucket = self.buckets.entry(key.clone()).or_insert(Bucket {
            tokens: tier.per_min as f64,
            at: now,
            day,
            used: 0,
            touched: self.sequence,
        });
        self.order.remove(&bucket.touched);
        bucket.touched = self.sequence;
        self.order.insert(self.sequence, key);
        let rate = tier.per_min as f64 / 60.0;
        bucket.tokens =
            (bucket.tokens + (now - bucket.at).max(0.0) * rate).min(tier.per_min as f64);
        bucket.at = now;
        if bucket.day != day {
            bucket.day = day;
            bucket.used = 0;
        }
        let retry = if bucket.used >= tier.per_day {
            (DAY - (now + BKK).rem_euclid(DAY)).floor() as u32 + 1
        } else if bucket.tokens < 1.0 {
            ((1.0 - bucket.tokens) / rate).ceil().max(1.0) as u32
        } else {
            bucket.tokens -= 1.0;
            bucket.used += 1;
            0
        };
        let headers = [
            ("x-ratelimit-limit", tier.per_min),
            ("x-ratelimit-remaining", bucket.tokens.floor() as u32),
            (
                "x-ratelimit-reset",
                ((tier.per_min as f64 - bucket.tokens) / rate).ceil() as u32,
            ),
            ("x-ratelimit-limit-day", tier.per_day),
            (
                "x-ratelimit-remaining-day",
                tier.per_day.saturating_sub(bucket.used),
            ),
        ];
        Decision { headers, retry }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const PUBLIC: Tier = Tier {
        name: "public",
        per_min: 2,
        per_day: 3,
    };

    #[test]
    fn refills_minute_and_keeps_the_daily_count() {
        let mut limiter = Limiter::new(2);
        assert_eq!(limiter.take("a", PUBLIC, 0.0).retry, 0);
        assert_eq!(limiter.take("a", PUBLIC, 0.0).retry, 0);
        assert_eq!(limiter.take("a", PUBLIC, 0.0).retry, 30);
        assert_eq!(limiter.take("a", PUBLIC, 30.0).retry, 0);
        assert_eq!(limiter.take("a", PUBLIC, 31.0).retry, 61_170);
    }

    #[test]
    fn resets_at_bangkok_midnight_and_isolates_tiers() {
        let mut limiter = Limiter::new(10);
        let tier = Tier {
            per_min: 100,
            ..PUBLIC
        };
        for _ in 0..3 {
            assert_eq!(limiter.take("a", tier, 61_199.0).retry, 0);
        }
        assert_eq!(limiter.take("a", tier, 61_199.0).retry, 2);
        assert_eq!(limiter.take("a", tier, 61_200.0).retry, 0);
        assert_eq!(
            limiter
                .take(
                    "a",
                    Tier {
                        name: "site",
                        ..tier
                    },
                    61_200.0
                )
                .retry,
            0
        );
    }

    #[test]
    fn evicts_the_least_recently_used_client() {
        let mut limiter = Limiter::new(2);
        limiter.take("a", PUBLIC, 0.0);
        limiter.take("b", PUBLIC, 0.0);
        limiter.take("a", PUBLIC, 0.0);
        limiter.take("c", PUBLIC, 0.0);
        assert!(limiter.buckets.contains_key(&("a".into(), "public")));
        assert!(!limiter.buckets.contains_key(&("b".into(), "public")));
        assert_eq!(limiter.buckets.len(), 2);
        assert_eq!(limiter.order.len(), 2);
    }
}

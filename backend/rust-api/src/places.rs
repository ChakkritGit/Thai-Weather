//! Offline GeoNames matching, with the same ranking/normalization as Python.

use serde::{Deserialize, Serialize};
use std::{
    cmp::Reverse,
    collections::{HashMap, VecDeque},
    path::Path,
    sync::Mutex,
};
use unicode_casefold::UnicodeCaseFold;
use unicode_normalization::UnicodeNormalization;

type Row = (
    u64,
    String,
    String,
    f64,
    f64,
    String,
    String,
    String,
    i64,
    Vec<String>,
);

#[derive(Deserialize)]
struct Catalog {
    provinces: HashMap<String, [String; 2]>,
    districts: HashMap<String, [String; 2]>,
    places: Vec<Row>,
}

struct Entry {
    place: Place,
    keys: Vec<String>,
    population: i64,
    kind_order: u8,
}

#[derive(Clone, Serialize)]
pub struct Place {
    pub id: u64,
    pub name_th: String,
    pub name_en: String,
    pub lat: f64,
    pub lon: f64,
    pub kind: &'static str,
    pub province_th: String,
    pub province_en: String,
    pub district_th: String,
    pub district_en: String,
}

pub struct Places {
    entries: Vec<Entry>,
    cache: Mutex<VecDeque<(String, Vec<Place>)>>,
}

pub fn normalise(text: &str) -> String {
    text.case_fold()
        .nfkd()
        .filter(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || ('\u{0e00}'..='\u{0e7f}').contains(c)
        })
        .collect()
}

impl Places {
    pub fn load(path: &Path) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let catalog: Catalog = serde_json::from_reader(std::fs::File::open(path)?)?;
        let mut entries = Vec::with_capacity(catalog.places.len());
        for row in catalog.places {
            let (id, th, en, lat, lon, feature, province, district, population, aliases) = row;
            let (kind, kind_order) = match feature.as_str() {
                "ADM1" => ("province", 1),
                "ADM2" => ("district", 2),
                _ => ("place", 0),
            };
            let mut keys: Vec<String> = [&th, &en]
                .into_iter()
                .chain(aliases.iter())
                .filter(|s| !s.is_empty())
                .map(|s| normalise(s))
                .collect();
            keys.sort_unstable();
            keys.dedup();
            let province_names = catalog
                .provinces
                .get(&province)
                .cloned()
                .unwrap_or_default();
            let district_names = catalog
                .districts
                .get(&format!("{province}.{district}"))
                .cloned()
                .unwrap_or_default();
            let [province_th, province_en] = province_names;
            let [district_th, district_en] = district_names;
            entries.push(Entry {
                place: Place {
                    id,
                    name_th: th,
                    name_en: en,
                    lat,
                    lon,
                    kind,
                    province_th,
                    province_en,
                    district_th,
                    district_en,
                },
                keys,
                population,
                kind_order,
            });
        }
        Ok(Self {
            entries,
            cache: Mutex::new(VecDeque::new()),
        })
    }

    pub fn search(&self, text: &str) -> Vec<Place> {
        let query = normalise(text);
        if query.chars().count() < 2 {
            return vec![];
        }
        {
            let mut cache = self.cache.lock().expect("place cache lock");
            if let Some(at) = cache.iter().position(|(key, _)| key == &query) {
                let hit = cache.remove(at).expect("cached search");
                let result = hit.1.clone();
                cache.push_back(hit);
                return result;
            }
        }
        let mut matches = Vec::new();
        for entry in &self.entries {
            let rank = entry
                .keys
                .iter()
                .filter(|key| key.contains(&query))
                .map(|key| {
                    if key == &query {
                        0u8
                    } else if key.starts_with(&query) {
                        1
                    } else {
                        2
                    }
                })
                .min();
            if let Some(rank) = rank {
                matches.push((
                    (
                        rank,
                        entry.kind_order,
                        Reverse(entry.population),
                        entry.place.id,
                    ),
                    &entry.place,
                ));
            }
        }
        matches.sort_unstable_by_key(|(rank, _)| *rank);
        let result: Vec<Place> = matches
            .into_iter()
            .take(10)
            .map(|(_, place)| place.clone())
            .collect();
        let mut cache = self.cache.lock().expect("place cache lock");
        // Concurrent misses may finish together. Keep one bounded entry per normalized query.
        if let Some(at) = cache.iter().position(|(key, _)| key == &query) {
            cache.remove(at);
        }
        cache.push_back((query, result.clone()));
        while cache.len() > 256 {
            cache.pop_front();
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalizes_case_accents_and_separators_but_keeps_thai_marks() {
        assert_eq!(normalise("BÁNG-KÒK 42"), "bangkok42");
        assert_eq!(normalise("Straße"), "strasse");
        assert_eq!(normalise("ชัยภูมิ"), "ชัยภูมิ");
        assert_eq!(normalise("ＡＢＣ"), "abc");
    }
}

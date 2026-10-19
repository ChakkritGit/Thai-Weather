//! Party protocol 2 validators and legacy snapshot reducer, ported from Drive Music.
use rand::seq::SliceRandom;
use serde_json::{Value, json};
pub fn n(v: &Value) -> f64 {
    v.as_f64().unwrap_or(0.0)
}
fn finite(v: &Value) -> bool {
    v.as_f64().is_some_and(|n| n.is_finite() && n >= 0.0)
}
fn index(v: &Value, len: usize) -> bool {
    finite(v) && n(v).fract() == 0.0 && n(v) < len as f64
}
fn file(v: &Value) -> bool {
    v.is_object()
        && v["id"]
            .as_str()
            .is_some_and(|s| !s.is_empty() && s.encode_utf16().count() < 256)
        && v["name"].is_string()
        && v["mimeType"].is_string()
}
fn queue(v: &Value) -> bool {
    v.as_array()
        .is_some_and(|a| !a.is_empty() && a.len() <= 10000 && a.iter().all(file))
}
fn source(v: &Value) -> bool {
    v.is_null()
        || (v.is_object()
            && ["folder", "playlist", "library"].contains(&v["type"].as_str().unwrap_or(""))
            && v["id"].is_string()
            && v["name"].is_string())
}
pub fn valid_command(v: &Value) -> bool {
    if !v.is_object() {
        return false;
    }
    match v["type"].as_str().unwrap_or("") {
        "toggle" | "next" | "previous" | "shuffle" | "loop" => true,
        "playing" => v["value"].is_boolean(),
        "seek" => finite(&v["seconds"]),
        "volume" => finite(&v["value"]) && n(&v["value"]) <= 1.0,
        "insert" => file(&v["file"]),
        "remove" => finite(&v["index"]) && n(&v["index"]).fract() == 0.0 && v["fileId"].is_string(),
        "play" => {
            queue(&v["queue"])
                && index(&v["index"], v["queue"].as_array().unwrap().len())
                && source(&v["source"])
        }
        _ => false,
    }
}
pub fn valid(v: &Value) -> bool {
    if !v.is_object() || !queue(&v["queue"]) {
        return false;
    }
    let len = v["queue"].as_array().unwrap().len();
    index(&v["currentIndex"], len)
        && finite(&v["progress"])
        && finite(&v["duration"])
        && finite(&v["updatedAt"])
        && v["isPlaying"].is_boolean()
        && v["shuffle"].is_boolean()
        && ["off", "all", "one"].contains(&v["loopMode"].as_str().unwrap_or(""))
        && source(&v["source"])
        && v.get("meta").is_some_and(|m| {
            m.is_null()
                || (m.is_object()
                    && ["title", "artist", "album", "pictureDataUrl"]
                        .iter()
                        .all(|k| m.get(k).is_none_or(Value::is_string)))
        })
        && v["shuffleOrder"].as_array().is_some_and(|a| {
            a.iter().all(|i| index(i, len))
                && (v["shuffle"] != true || a.iter().any(|i| n(i) == n(&v["currentIndex"])))
        })
        && v.get("volume").is_none_or(|v| finite(v) && n(v) <= 1.0)
        && v.get("playNextIndex")
            .is_some_and(|v| v.is_null() || index(v, len))
}
pub fn position(p: &Value, now: i64) -> f64 {
    let at = n(&p["progress"])
        + if p["isPlaying"] == true {
            ((now as f64 - n(&p["updatedAt"])).max(0.0)) / 1000.0
        } else {
            0.0
        };
    let duration = n(&p["duration"]);
    if duration > 0.0 { at.min(duration) } else { at }
}
pub fn queue_command(command: &Value) -> bool {
    ["insert", "remove", "shuffle", "loop", "volume"]
        .contains(&command["type"].as_str().unwrap_or(""))
}
fn shuffled(len: usize, current: usize) -> Vec<usize> {
    let mut rest = (0..len).filter(|i| *i != current).collect::<Vec<_>>();
    rest.shuffle(&mut rand::thread_rng());
    let mut out = vec![current];
    out.extend(rest);
    out
}
/// None means the original object is unchanged, as with stale-index removals.
pub fn reduce(previous: &Value, command: &Value, now: i64) -> Option<Value> {
    let kind = command["type"].as_str().unwrap_or("");
    if kind == "play" {
        let q = command["queue"].as_array()?;
        let i = n(&command["index"]) as usize;
        if i >= q.len() {
            return None;
        }
        let same = previous["queue"]
            .as_array()
            .is_some_and(|p| p.iter().map(|f| &f["id"]).eq(q.iter().map(|f| &f["id"])));
        let shuffle = previous["shuffle"] == true;
        return Some(
            json!({"queue":q,"currentIndex":i,"source":command["source"],"progress":0,"duration":0,"isPlaying":true,"shuffle":shuffle,"shuffleOrder":if shuffle {if same{previous["shuffleOrder"].clone()}else{json!(shuffled(q.len(),i))}}else{json!([])},"playNextIndex":null,"loopMode":previous.get("loopMode").cloned().unwrap_or(json!("off")),"meta":null,"updatedAt":now}),
        );
    }
    if previous.is_null() {
        return if kind == "insert" {
            reduce(
                &Value::Null,
                &json!({"type":"play","queue":[command["file"]],"index":0}),
                now,
            )
        } else {
            None
        };
    }
    let mut p = previous.clone();
    p["progress"] = json!(position(previous, now));
    p["updatedAt"] = json!(now);
    match kind {
        "toggle" => p["isPlaying"] = json!(p["isPlaying"] != true),
        "playing" => p["isPlaying"] = command["value"].clone(),
        "seek" => {
            let duration = n(&p["duration"]);
            p["progress"] = json!(if duration > 0.0 {
                n(&command["seconds"]).min(duration)
            } else {
                n(&command["seconds"])
            });
        }
        "volume" => p["volume"] = command["value"].clone(),
        "loop" => {
            p["loopMode"] = json!(match p["loopMode"].as_str().unwrap_or("off") {
                "off" => "all",
                "all" => "one",
                _ => "off",
            })
        }
        "shuffle" => {
            let shuffle = p["shuffle"] != true;
            p["shuffle"] = json!(shuffle);
            p["shuffleOrder"] = if shuffle {
                json!(shuffled(
                    p["queue"].as_array().unwrap().len(),
                    n(&p["currentIndex"]) as usize
                ))
            } else {
                json!([])
            };
        }
        "next" | "previous" => {
            if kind == "previous" && n(&p["progress"]) > 3.0 {
                p["progress"] = json!(0);
            } else {
                let len = p["queue"].as_array().unwrap().len();
                let order = if p["shuffle"] == true {
                    p["shuffleOrder"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|v| n(v) as usize)
                        .collect::<Vec<_>>()
                } else {
                    (0..len).collect()
                };
                let at = order
                    .iter()
                    .position(|i| *i == n(&p["currentIndex"]) as usize)
                    .unwrap_or(0);
                let next = if kind == "next" {
                    (at + 1) % order.len()
                } else {
                    (at + order.len() - 1) % order.len()
                };
                p["currentIndex"] = if kind == "next" && !p["playNextIndex"].is_null() {
                    p["playNextIndex"].clone()
                } else {
                    json!(order[next])
                };
                p["playNextIndex"] = Value::Null;
                p["progress"] = json!(0);
                p["duration"] = json!(0);
                p["meta"] = Value::Null;
                p["isPlaying"] = json!(true);
            }
        }
        "insert" => {
            let old = p["queue"].as_array().unwrap();
            let current = n(&p["currentIndex"]) as usize;
            let current_id = old[current]["id"].clone();
            if current_id == command["file"]["id"] {
                return None;
            }
            let mut ids = p["shuffleOrder"]
                .as_array()
                .unwrap()
                .iter()
                .map(|i| old[n(i) as usize]["id"].clone())
                .filter(|id| *id != command["file"]["id"])
                .collect::<Vec<_>>();
            let mut q = old
                .iter()
                .filter(|f| f["id"] != command["file"]["id"])
                .cloned()
                .collect::<Vec<_>>();
            let current = q.iter().position(|f| f["id"] == current_id).unwrap();
            let at = current + 1;
            q.insert(at, command["file"].clone());
            p["currentIndex"] = json!(current);
            p["playNextIndex"] = json!(at);
            let at = ids
                .iter()
                .position(|id| *id == current_id)
                .map_or(0, |i| i + 1);
            ids.insert(at, command["file"]["id"].clone());
            p["shuffleOrder"] = if p["shuffle"] == true {
                json!(
                    ids.iter()
                        .map(|id| q.iter().position(|f| f["id"] == *id).unwrap())
                        .collect::<Vec<_>>()
                )
            } else {
                json!([])
            };
            p["queue"] = json!(q);
        }
        "remove" => {
            let i = n(&command["index"]) as usize;
            let current = n(&p["currentIndex"]) as usize;
            let old = p["queue"].as_array().unwrap();
            if i >= old.len() || old[i]["id"] != command["fileId"] || i == current {
                return None;
            }
            p["queue"] = json!(
                old.iter()
                    .enumerate()
                    .filter(|(at, _)| *at != i)
                    .map(|(_, v)| v.clone())
                    .collect::<Vec<_>>()
            );
            if current > i {
                p["currentIndex"] = json!(current - 1);
            }
            p["shuffleOrder"] = json!(
                p["shuffleOrder"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| n(v) as usize)
                    .filter(|at| *at != i)
                    .map(|at| if at > i { at - 1 } else { at })
                    .collect::<Vec<_>>()
            );
            if !p["playNextIndex"].is_null() {
                let at = n(&p["playNextIndex"]) as usize;
                p["playNextIndex"] = if at == i {
                    Value::Null
                } else {
                    json!(if at > i { at - 1 } else { at })
                };
            }
        }
        _ => return None,
    }
    Some(p)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn guarded_edits_and_validation() {
        let file = |id| json!({"id":id,"name":id,"mimeType":"audio/mpeg"});
        let p = reduce(
            &Value::Null,
            &json!({"type":"play","queue":[file("a"),file("b")],"index":0}),
            1000,
        )
        .unwrap();
        assert!(valid(&p));
        assert!(!valid(&json!({})));
        assert!(!valid_command(&json!({"type":"volume","value":2})));
        assert!(
            reduce(
                &p,
                &json!({"type":"remove","index":1,"fileId":"stale"}),
                2000
            )
            .is_none()
        );
        let inserted = reduce(&p, &json!({"type":"insert","file":file("c")}), 2000).unwrap();
        assert_eq!(inserted["queue"][1]["id"], "c");
        assert_eq!(inserted["playNextIndex"], 1);
        let next = reduce(&inserted, &json!({"type":"next"}), 3000).unwrap();
        assert_eq!(next["currentIndex"], 1);
        assert!(valid(&next));
    }
}

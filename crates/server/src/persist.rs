// Snapshot persistence: the whole exchange (engine state, books, accounts, history) as one JSON file, written
// atomically (temp file, then rename). i128s go out as decimal strings, so they round-trip exactly.

use crate::exchange::Exchange;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Out<'a> {
    v: u32,
    saved_at: i64,
    exchange: &'a Exchange,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct In {
    v: u32,
    saved_at: Option<i64>,
    exchange: Exchange,
}

pub fn serialize(x: &Exchange) -> String {
    serde_json::to_string(&Out {
        v: 1,
        saved_at: x.now(),
        exchange: x,
    })
    .expect("snapshot serializes")
}

/// The exchange and when it was saved (wall ms).
pub fn deserialize(text: &str) -> Result<(Exchange, Option<i64>), String> {
    let snap: In = serde_json::from_str(text).map_err(|e| format!("bad snapshot: {e}"))?;
    if snap.v != 1 {
        return Err(format!("unsupported snapshot version {}", snap.v));
    }
    Ok((snap.exchange.restored(), snap.saved_at))
}

pub fn save(dir: &Path, text: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let file = dir.join("snapshot.json");
    let tmp = dir.join("snapshot.json.tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(tmp, file)
}

pub fn load(dir: &Path) -> Result<Option<(Exchange, Option<i64>)>, String> {
    let file = dir.join("snapshot.json");
    if !file.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&file).map_err(|e| format!("{}: {e}", file.display()))?;
    deserialize(&text).map(Some)
}

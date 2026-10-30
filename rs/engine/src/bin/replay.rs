// Replays event streams through the Rust engine and prints what happened as JSON (the archived TS differential
// test, archive/tests/engine/differential.test.ts, compares it with the TS engine).
//
//   impulse-replay scenario.json [...]     each file: {"events": [...]}
//   impulse-replay < histories.json        stdin: one {"events"} object, or an array of them
//
// Output: a JSON array, one entry per history: {"steps": [{"ok", "effects" | "reason"}], "final": State},
// or {"fatal": message, "at": index} if the engine hit a malformed event or a broken invariant.

use impulse_engine::{apply, initial_state, ApplyError, Event};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::Read;

#[derive(Deserialize)]
struct History {
    events: Vec<Value>,
}

fn run(h: History) -> Value {
    let mut state = initial_state();
    let mut steps = vec![];
    for (i, raw) in h.events.into_iter().enumerate() {
        let event: Event = match serde_json::from_value(raw.clone()) {
            Ok(e) => e,
            Err(err) => return json!({ "fatal": format!("bad event {raw}: {err}"), "at": i }),
        };
        match apply(&state, &event) {
            Ok((next, effects)) => {
                steps.push(json!({ "ok": true, "effects": effects }));
                state = next;
            }
            Err(ApplyError::Rejected(reason)) => steps.push(json!({ "ok": false, "reason": reason })),
            Err(ApplyError::Fatal(msg)) => return json!({ "fatal": msg, "at": i }),
        }
    }
    json!({ "steps": steps, "final": state })
}

fn main() {
    let files: Vec<String> = std::env::args().skip(1).collect();
    let histories: Vec<History> = if files.is_empty() {
        let mut text = String::new();
        std::io::stdin().read_to_string(&mut text).expect("read stdin");
        let v: Value = serde_json::from_str(&text).expect("stdin is not JSON");
        if v.is_array() {
            serde_json::from_value(v).expect("expected [{events}]")
        } else {
            vec![serde_json::from_value(v).expect("expected {events}")]
        }
    } else {
        files
            .iter()
            .map(|f| serde_json::from_str(&std::fs::read_to_string(f).expect(f)).expect(f))
            .collect()
    };
    let out: Vec<Value> = histories.into_iter().map(run).collect();
    println!("{}", serde_json::to_string(&out).unwrap());
}

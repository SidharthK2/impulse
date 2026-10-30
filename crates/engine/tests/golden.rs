// The Rust engine against the TypeScript reference engine's frozen results (tests/golden/, written by
// impulse-research: golden/generate.ts). Every scenario and 600 random histories are replayed from their stored event
// lists; each step's outcome (effects, or the rejection reason) and the final state must match exactly.

use impulse_engine::{apply, initial_state, ApplyError, Event, State};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader};

fn root() -> String {
    format!("{}/../..", env!("CARGO_MANIFEST_DIR"))
}

struct Run {
    steps: Vec<Value>,
    final_state: State,
}

/// Replay events as the generator did: outcomes as JSON, in the reference engine's encoding.
fn run(events: &[Value]) -> Run {
    let mut state = initial_state();
    let mut steps = vec![];
    for (i, raw) in events.iter().enumerate() {
        let event: Event = serde_json::from_value(raw.clone()).unwrap_or_else(|e| panic!("step {i}: bad event {raw}: {e}"));
        match apply(&state, &event) {
            Ok((next, effects)) => {
                steps.push(json!({ "ok": true, "effects": effects }));
                state = next;
            }
            Err(ApplyError::Rejected(reason)) => steps.push(json!({ "ok": false, "reason": reason })),
            Err(ApplyError::Fatal(msg)) => panic!("step {i} {raw}: engine failed: {msg}"),
        }
    }
    Run { steps, final_state: state }
}

/// Outcomes and final state equal the golden ones; the first differing step is reported.
fn compare(name: &str, events: &[Value], golden: &Value) -> Run {
    let r = run(events);
    let want = golden["steps"].as_array().expect("golden steps");
    assert_eq!(r.steps.len(), want.len(), "{name}: step count");
    for (i, (got, want)) in r.steps.iter().zip(want).enumerate() {
        assert_eq!(got, want, "{name} step {i}: {}", events[i]);
    }
    assert_eq!(serde_json::to_value(&r.final_state).unwrap(), golden["final"], "{name}: final state");
    r
}

fn scenario(name: &str) {
    let events: Value = serde_json::from_str(&std::fs::read_to_string(format!("{}/tests/scenarios/{name}.json", root())).unwrap()).unwrap();
    let golden: Value = serde_json::from_str(&std::fs::read_to_string(format!("{}/tests/golden/scenarios/{name}.json", root())).unwrap()).unwrap();
    compare(name, events["events"].as_array().unwrap(), &golden);
}

macro_rules! scenarios {
    ($($test:ident => $file:literal),* $(,)?) => {
        $(#[test] fn $test() { scenario($file) })*

        #[test]
        fn every_scenario_has_a_golden_file() {
            let mut want = vec![$($file),*];
            want.sort();
            let mut have: Vec<String> = std::fs::read_dir(format!("{}/tests/scenarios", root()))
                .unwrap()
                .map(|e| e.unwrap().file_name().into_string().unwrap().trim_end_matches(".json").to_string())
                .collect();
            have.sort();
            assert_eq!(have, want, "a scenario without a test here (or a test without a scenario)");
        }
    };
}

scenarios! {
    scenario_attention_pump => "attention-pump",
    scenario_funding_drain => "funding-drain",
    scenario_gap_down_resolve_0 => "gap-down-resolve-0",
    scenario_gap_down_resolve_1 => "gap-down-resolve-1",
    scenario_gap_up_resolve_0 => "gap-up-resolve-0",
    scenario_graduation_blowup => "graduation-blowup",
    scenario_isolation_two_markets => "isolation-two-markets",
    scenario_memecoin_squeeze => "memecoin-squeeze",
    scenario_principal_fallback => "principal-fallback",
    scenario_resolution_taper => "resolution-taper",
}

/// Each line: {seed, events, steps, final}.
fn histories(file: &str, mut each: impl FnMut(&[Value], &Run)) -> usize {
    let f = std::fs::File::open(format!("{}/tests/golden/{file}", root())).unwrap();
    let mut n = 0;
    for line in BufReader::new(f).lines() {
        let line = line.unwrap();
        if line.is_empty() {
            continue;
        }
        let h: Value = serde_json::from_str(&line).unwrap();
        let events = h["events"].as_array().unwrap();
        let r = compare(&format!("{file} seed {}", h["seed"]), events, &h);
        each(events, &r);
        n += 1;
    }
    n
}

fn count(steps: &[Value], kind: &str) -> usize {
    steps.iter().filter(|s| s["effects"].as_array().is_some_and(|fx| fx.iter().any(|e| e["kind"] == kind))).count()
}

#[test]
fn replays_300_random_histories_identically() {
    let (mut rejected, mut haircuts, mut opens, mut snipes, mut books) = (0, 0, 0, 0, 0);
    let n = histories("histories.jsonl", |events, r| {
        rejected += r.steps.iter().filter(|s| s["ok"] == false).count();
        haircuts += count(&r.steps, "haircut");
        opens += count(&r.steps, "open");
        let accepted = |kind: &str, extra: &dyn Fn(&Value) -> bool| events.iter().zip(&r.steps).filter(|(e, s)| e["type"] == kind && s["ok"] == true && extra(e)).count();
        snipes += accepted("snipe", &|_| true);
        books += accepted("book", &|e| !e["mid"].is_null());
    });
    assert_eq!(n, 300);
    // The histories must actually exercise refusals, ADL, launches and book mids, or the comparison proves little.
    assert!(rejected > 300, "rejected {rejected}");
    assert!(haircuts > 30, "haircuts {haircuts}");
    assert_eq!(opens, 300, "every history launches its creator coin");
    assert!(snipes > 600, "snipes {snipes}");
    assert!(books > 300, "book mids {books}");
}

// The old engine.test.ts "fuzz" test: apply() asserts every invariant after every transition (a violation is a
// Fatal, which fails the replay), every priced market ends with an empty vault, and ADL fires often enough.
#[test]
fn holds_every_invariant_over_300_random_multi_market_histories_under_both_adl_policies() {
    let mut adls = 0;
    let n = histories("fuzz.jsonl", |_, r| {
        adls += count(&r.steps, "haircut");
        for (id, m) in &r.final_state.markets {
            if id != "ATTN" {
                assert_eq!(m.vault, 0, "{id} vault");
            }
        }
    });
    assert_eq!(n, 300);
    assert!(adls > 30, "ADL haircuts {adls}");
}

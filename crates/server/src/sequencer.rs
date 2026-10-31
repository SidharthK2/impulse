// The single-threaded core and its sequencer (LMAX style):
//
//   clients (API, bots, feeds, clock) → sequencer → journal (SQLite, before the reply) → deterministic core
//
// Every state change arrives here as a Command. Node::submit takes the intake clock's time and hands both to
// Core::submit, which applies the command to the in-memory exchange at that time and, if the exchange changed,
// writes it to the journal and commits before anyone hears back. The core itself never reads a clock. A command that changed nothing (refused before any mutation) is rolled back and never journaled. If the
// journal can't be written the process stops (fail-stop): memory must never run ahead of disk; recovery restores
// the last committed state. Recovery loads the latest snapshot and replays the journal after it through the same
// `command::apply`, with no feeds, bots or timers running.

use crate::bots::Bots;
use crate::command::{Apply, Command};
use crate::exchange::{Exchange, XResult};
use crate::intake::IntakeClock;
use crate::rng::Rng;
use crate::store::{HistoryMarks, Store};
use crate::ws::Hub;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::time::{Duration, Instant};

/// Snapshot every this many commands, or this often, whichever comes first.
const SNAPSHOT_EVERY: u64 = 1000;
const SNAPSHOT_INTERVAL: Duration = Duration::from_secs(60);

/// Everything behind the one lock: the deterministic core, the intake around it, and the websocket hub that
/// reads the core's views. One lock, held for one synchronous step at a time.
pub struct Node {
    pub core: Core,
    pub intake: Intake,
    pub hub: Hub,
}

/// What the clients around the core own: the intake clock, and the randomness behind the bots' and the offline
/// random walk's decisions. None of it is exchange state; it reaches the core only inside commands.
pub struct Intake {
    pub clock: IntakeClock,
    pub bots: Option<Bots>,
    /// The offline random walk's generator (it decides prices, which go in as Ticks commands).
    pub sim: Rng,
}

impl Node {
    pub fn new(core: Core, clock: IntakeClock, bots: bool) -> Node {
        Node { core, intake: Intake { clock, bots: bots.then(Bots::new), sim: Rng::new(42) }, hub: Hub::default() }
    }

    /// Submit a command at the intake clock's time; its own reply comes back.
    pub fn submit<C: Apply + Clone + Into<Command>>(&mut self, cmd: C) -> XResult<C::Reply> {
        let ts = self.intake.clock.now();
        self.core.submit(cmd, ts)
    }
}

/// The deterministic core and its journal: the exchange, the store, snapshots. It never reads a clock: every
/// command arrives with its time.
pub struct Core {
    pub x: Exchange,
    /// The last journaled sequence number.
    pub seq: u64,
    store: Option<Store>,
    /// How far the read tables have caught up with the exchange's history.
    history: HistoryMarks,
    since_snapshot: u64,
    snapshot_at: Instant,
    /// Time spent in submit (apply + journal), per step, for the throughput report.
    pub timings: Vec<Duration>,
    /// With step verification on (VERIFY_STEPS=1, the test servers): the state hash after the last step.
    verified: Option<String>,
}

pub enum Recovery {
    Fresh,
    Restored { replayed: u64, imported: bool },
}

/// Stop the process: the alternative is serving state the journal doesn't have.
fn fail_stop(why: &str) -> ! {
    crate::logging::log(&format!("FATAL: {why}; stopping (restart recovers the last committed state)"));
    std::process::exit(70);
}

fn decode(state: &[u8]) -> Result<Exchange, String> {
    serde_json::from_slice::<Exchange>(state).map(Exchange::restored).map_err(|e| format!("bad snapshot: {e}"))
}

fn encode(x: &Exchange) -> Vec<u8> {
    serde_json::to_vec(x).expect("exchange serializes")
}

/// Run a command, stopping the process if it panics (the exchange may be half-changed).
fn run<C: Apply>(x: &mut Exchange, cmd: &C, kind: &str) -> XResult<C::Reply> {
    match catch_unwind(AssertUnwindSafe(|| cmd.apply(x))) {
        Ok(r) => r,
        Err(_) => fail_stop(&format!("command {kind} panicked")),
    }
}

impl Core {
    pub fn new(store: Option<Store>) -> Core {
        Core {
            x: Exchange::new(0),
            seq: 0,
            store,
            history: HistoryMarks::default(),
            since_snapshot: 0,
            snapshot_at: Instant::now(),
            timings: vec![],
            verified: None,
        }
    }

    /// Check every step: a command that leaves `version` alone must leave the whole exchange alone, or it changed
    /// state the journal would miss. Costs a state hash per command, so it's for tests (VERIFY_STEPS=1).
    pub fn verify_steps(&mut self) {
        self.verified = Some(self.x.state_hash());
    }

    /// The sequencer: every state change enters here, with the time intake gave it. See the module comment.
    pub fn submit<C: Apply + Clone + Into<Command>>(&mut self, cmd: C, ts: i64) -> XResult<C::Reply> {
        let journaled: Command = cmd.clone().into();
        let started = Instant::now();
        let prev = self.x.now;
        let version = self.x.version;
        if let Some(s) = &self.store {
            if let Err(e) = s.begin() {
                fail_stop(&format!("journal BEGIN failed: {e}"));
            }
        }
        self.x.now = ts.max(prev); // time never runs backwards in the journal
        let r = run(&mut self.x, &cmd, journaled.kind());
        if self.x.version == version {
            self.x.now = prev; // a refused command leaves no trace, not even in the clock
            if let Some(s) = &self.store {
                s.rollback();
            }
            if let Some(before) = &self.verified {
                if *before != self.x.state_hash() {
                    fail_stop(&format!("command {} changed the exchange without bumping its version, so the journal would miss it", journaled.kind()));
                }
            }
            return r;
        }
        if self.verified.is_some() {
            self.verified = Some(self.x.state_hash());
        }
        self.seq += 1;
        if let Some(s) = &self.store {
            // The command and the history it produced, in one transaction.
            let payload = serde_json::to_string(&journaled).expect("commands serialize");
            let written = s
                .insert_command(self.seq, self.x.now, journaled.kind(), &payload)
                .and_then(|_| s.write_history(self.seq, &mut self.x, self.history))
                .and_then(|marks| s.commit().map(|_| marks));
            match written {
                Ok(marks) => self.history = marks,
                Err(e) => fail_stop(&format!("journal write failed at seq {}: {e}", self.seq)),
            }
        }
        if self.timings.len() < 1_000_000 {
            self.timings.push(started.elapsed());
        }
        self.since_snapshot += 1;
        if self.since_snapshot >= SNAPSHOT_EVERY || self.snapshot_at.elapsed() >= SNAPSHOT_INTERVAL {
            self.snapshot();
        }
        r
    }

    /// Store a snapshot of the exchange at the current sequence number. A failure is logged, not fatal: the
    /// journal alone is enough to recover.
    pub fn store(&self) -> Option<&Store> {
        self.store.as_ref()
    }

    pub fn snapshot(&mut self) {
        self.since_snapshot = 0;
        self.snapshot_at = Instant::now();
        let Some(s) = &self.store else { return };
        if let Err(e) = s.save_snapshot(self.seq, self.x.now, &encode(&self.x)) {
            crate::logging::log(&format!("snapshot at seq {} failed: {e}", self.seq));
        }
    }

    /// Bring the exchange back from the store: the latest snapshot plus the journal after it, through the same
    /// command path (nothing else is running yet). A database with nothing in it but a legacy JSON snapshot in
    /// DATA_DIR imports that as snapshot 0 (the JSON file is kept). After a recovery, a fresh snapshot, so the
    /// next recovery never replays old commands through newer code.
    pub fn recover(&mut self, data_dir: &Path) -> Result<Recovery, String> {
        let Some(store) = &self.store else { return Ok(Recovery::Fresh) };
        let mut imported = false;
        if store.is_empty()? {
            match crate::persist::load(data_dir)? {
                None => return Ok(Recovery::Fresh),
                Some((mut x, saved_at)) => {
                    x.now = saved_at.unwrap_or(x.now);
                    // The read tables start with whatever history the snapshot carries.
                    for c in x.candles.iter().flat_map(|(m, cs)| cs.iter().map(move |c| (m.clone(), c.t))).collect::<Vec<_>>() {
                        x.dirty_candles.insert(c);
                    }
                    store.begin()?;
                    store.write_history(0, &mut x, HistoryMarks::default())?;
                    store.commit()?;
                    store.save_snapshot(0, x.now, &encode(&x))?;
                    crate::logging::log(&format!("imported the legacy snapshot {} as snapshot 0 (the file is kept)", data_dir.join("snapshot.json").display()));
                    imported = true;
                }
            }
        }
        let (mut x, seq, replayed) = rebuild(store, false, None)?;
        x.dirty_candles.clear(); // the read tables already have everything the journal produced
        self.history = HistoryMarks::of(&x);
        self.x = x;
        self.seq = seq;
        if self.verified.is_some() {
            self.verify_steps();
        }
        self.snapshot();
        Ok(Recovery::Restored { replayed, imported })
    }
}

/// What a rebuild replayed: commands, and the fills and risk events they produced.
#[derive(Default)]
pub struct Replayed {
    pub commands: u64,
    pub fills: u64,
    pub risk: u64,
}

/// Rebuild the exchange from a store: from the latest snapshot (or, with `full`, from the start of the journal:
/// an empty exchange before its Genesis command, or a legacy import's snapshot 0), replaying every command after
/// it, up to `until`. Returns the exchange, its sequence number, and how many commands were replayed.
pub fn rebuild(store: &Store, full: bool, until: Option<u64>) -> Result<(Exchange, u64, u64), String> {
    rebuild_counting(store, full, until, None).map(|(x, seq, r)| (x, seq, r.commands))
}

/// `legacy`: for a full replay of a database whose import snapshot 0 was pruned (before it was kept), the
/// imported exchange from DATA_DIR/snapshot.json.
pub fn rebuild_counting(store: &Store, full: bool, until: Option<u64>, legacy: Option<Exchange>) -> Result<(Exchange, u64, Replayed), String> {
    let start = if full { store.first_snapshot()?.filter(|s| s.seq == 0) } else { store.latest_snapshot(until)? };
    let (mut x, mut seq) = match (start, legacy) {
        (Some(s), _) => (decode(&s.state)?, s.seq),
        (None, Some(x)) if full => (x, 0),
        (None, _) => (Exchange::new(0), 0),
    };
    let mut replayed = Replayed::default();
    for c in store.commands_after(seq, until)? {
        let cmd: Command = serde_json::from_str(&c.payload).map_err(|e| format!("journal seq {}: {e}", c.seq))?;
        if c.seq != seq + 1 {
            return Err(format!("journal gap: seq {} after {seq}", c.seq));
        }
        x.now = c.ts;
        let version = x.version;
        let (fill, risk) = (x.fills.back().map_or(0, |f| f.id), x.risk.back().map_or(0, |r| r.id));
        // A journaled command changed the exchange when it ran; its reply (success or refusal) doesn't matter here.
        let _ = cmd.apply(&mut x);
        replayed.fills += x.fills.iter().rev().take_while(|f| f.id > fill).count() as u64;
        replayed.risk += x.risk.iter().rev().take_while(|r| r.id > risk).count() as u64;
        if x.version == version {
            return Err(format!("journal seq {} ({}) changed nothing on replay", c.seq, cmd.kind()));
        }
        seq = c.seq;
        replayed.commands += 1;
    }
    Ok((x, seq, replayed))
}

/// Offline replay for checks: rebuild from DATA_DIR's database (read-only) and report where it ends up.
pub fn replay_report(data_dir: &Path, full: bool, until: Option<u64>) -> Result<serde_json::Value, String> {
    let store = Store::open_read_only(data_dir)?;
    let started = Instant::now();
    // A journal that doesn't begin with Genesis began with a legacy import; if its snapshot 0 is gone, start from
    // the JSON file the import kept.
    let imported = store.commands_after(0, Some(1))?.first().is_some_and(|c| !c.payload.contains("\"kind\":\"genesis\""));
    let legacy = match (full && imported && store.first_snapshot()?.is_none_or(|s| s.seq != 0), crate::persist::load(data_dir)?) {
        (true, Some((mut x, saved_at))) => {
            x.now = saved_at.unwrap_or(x.now);
            Some(x)
        }
        _ => None,
    };
    let (x, seq, r) = rebuild_counting(&store, full, until, legacy)?;
    Ok(serde_json::json!({ "seq": seq, "hash": x.state_hash(), "replayed": r.commands, "fills": r.fills, "risk": r.risk, "ms": started.elapsed().as_millis() as u64 }))
}


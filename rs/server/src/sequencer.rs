// The single-threaded core and its sequencer (LMAX style):
//
//   clients (API, bots, feeds, clock) → sequencer → journal (SQLite, before the reply) → deterministic core
//
// Every state change arrives here as a Command. Core::submit stamps it with the intake clock's time, applies it to
// the in-memory exchange and, if the exchange changed, writes it to the journal and commits before anyone hears
// back. A command that changed nothing (refused before any mutation) is rolled back and never journaled. If the
// journal can't be written the process stops (fail-stop): memory must never run ahead of disk; recovery restores
// the last committed state. Recovery loads the latest snapshot and replays the journal after it through the same
// `command::apply`, with no feeds, bots or timers running.

use crate::bots::Bots;
use crate::command::{self, Command, Reply};
use crate::exchange::{ExError, Exchange, XResult};
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

/// Everything the single-threaded core owns. One lock, held for one synchronous step at a time.
pub struct Core {
    pub x: Exchange,
    pub bots: Option<Bots>,
    pub hub: Hub,
    /// The offline random walk's generator (intake: it decides prices, which go in as Ticks commands).
    pub sim: Rng,
    pub clock: IntakeClock,
    /// The last journaled sequence number.
    pub seq: u64,
    store: Option<Store>,
    /// How far the read tables have caught up with the exchange's history.
    history: HistoryMarks,
    since_snapshot: u64,
    snapshot_at: Instant,
    /// Time spent in submit (apply + journal), per step, for the throughput report.
    pub timings: Vec<Duration>,
}

pub enum Recovery {
    Fresh,
    Restored { replayed: u64, imported: bool },
}

/// Stop the process: the alternative is serving state the journal doesn't have.
fn fail_stop(why: &str) -> ! {
    crate::api::log(&format!("FATAL: {why}; stopping (restart recovers the last committed state)"));
    std::process::exit(70);
}

fn decode(state: &[u8]) -> Result<Exchange, String> {
    serde_json::from_slice::<Exchange>(state).map(Exchange::restored).map_err(|e| format!("bad snapshot: {e}"))
}

fn encode(x: &Exchange) -> Vec<u8> {
    serde_json::to_vec(x).expect("exchange serializes")
}

/// Run a command, stopping the process if it panics (the exchange may be half-changed).
fn run(x: &mut Exchange, cmd: &Command) -> XResult<Reply> {
    match catch_unwind(AssertUnwindSafe(|| command::apply(x, cmd))) {
        Ok(r) => r,
        Err(_) => fail_stop(&format!("command {} panicked", cmd.kind())),
    }
}

impl Core {
    pub fn new(bots: bool, clock: IntakeClock, store: Option<Store>) -> Core {
        Core {
            x: Exchange::new(0),
            bots: bots.then(Bots::new),
            hub: Hub::default(),
            sim: Rng::new(42),
            clock,
            seq: 0,
            store,
            history: HistoryMarks::default(),
            since_snapshot: 0,
            snapshot_at: Instant::now(),
            timings: vec![],
        }
    }

    /// The sequencer: every state change enters here. See the module comment.
    pub fn submit(&mut self, cmd: Command) -> XResult<Reply> {
        let started = Instant::now();
        let prev = self.x.now;
        let version = self.x.version;
        if let Some(s) = &self.store {
            if let Err(e) = s.begin() {
                fail_stop(&format!("journal BEGIN failed: {e}"));
            }
        }
        self.x.now = self.clock.now().max(prev);
        let r = run(&mut self.x, &cmd);
        if self.x.version == version {
            self.x.now = prev; // a refused command leaves no trace, not even in the clock
            if let Some(s) = &self.store {
                s.rollback();
            }
            return r;
        }
        self.seq += 1;
        if let Some(s) = &self.store {
            // The command and the history it produced, in one transaction.
            let payload = serde_json::to_string(&cmd).expect("commands serialize");
            let written = s
                .insert_command(self.seq, self.x.now, cmd.kind(), &payload)
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
            crate::api::log(&format!("snapshot at seq {} failed: {e}", self.seq));
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
                    crate::api::log(&format!("imported the legacy snapshot {} as snapshot 0 (the file is kept)", data_dir.join("snapshot.json").display()));
                    imported = true;
                }
            }
        }
        let (mut x, seq, replayed) = rebuild(store, false, None)?;
        x.dirty_candles.clear(); // the read tables already have everything the journal produced
        self.history = HistoryMarks::of(&x);
        self.x = x;
        self.seq = seq;
        self.snapshot();
        Ok(Recovery::Restored { replayed, imported })
    }
}

/// Rebuild the exchange from a store: from the latest snapshot (or, with `full`, from the start of the journal:
/// an empty exchange before its Genesis command, or a legacy import's snapshot 0), replaying every command after
/// it, up to `until`. Returns the exchange, its sequence number, and how many commands were replayed.
pub fn rebuild(store: &Store, full: bool, until: Option<u64>) -> Result<(Exchange, u64, u64), String> {
    let start = if full { store.first_snapshot()?.filter(|s| s.seq == 0) } else { store.latest_snapshot(until)? };
    let (mut x, mut seq) = match start {
        Some(s) => (decode(&s.state)?, s.seq),
        None => (Exchange::new(0), 0),
    };
    let mut replayed = 0;
    for c in store.commands_after(seq, until)? {
        let cmd: Command = serde_json::from_str(&c.payload).map_err(|e| format!("journal seq {}: {e}", c.seq))?;
        if c.seq != seq + 1 {
            return Err(format!("journal gap: seq {} after {seq}", c.seq));
        }
        x.now = c.ts;
        let version = x.version;
        // A journaled command changed the exchange when it ran; its reply (success or refusal) doesn't matter here.
        let _ = command::apply(&mut x, &cmd);
        if x.version == version {
            return Err(format!("journal seq {} ({}) changed nothing on replay", c.seq, cmd.kind()));
        }
        seq = c.seq;
        replayed += 1;
    }
    Ok((x, seq, replayed))
}

/// Offline replay for checks: rebuild from DATA_DIR's database (read-only) and report where it ends up.
pub fn replay_report(data_dir: &Path, full: bool, until: Option<u64>) -> Result<serde_json::Value, String> {
    let store = Store::open_read_only(data_dir)?;
    let started = Instant::now();
    let (x, seq, replayed) = rebuild(&store, full, until)?;
    Ok(serde_json::json!({ "seq": seq, "hash": x.state_hash(), "replayed": replayed, "ms": started.elapsed().as_millis() as u64 }))
}

impl From<String> for ExError {
    fn from(e: String) -> Self {
        ExError::Internal(e)
    }
}

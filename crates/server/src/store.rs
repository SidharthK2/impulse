// Durable storage: one SQLite file, DATA_DIR/impulse.db. It holds the command journal (every input that changed
// the exchange, in sequence), snapshots of the whole exchange (recovery loads the latest and replays the journal
// after it), and read tables of history (written in the same transaction as the command that produced them).
// Matching and risk never query it: the exchange lives in memory, and the journal is written before a command is
// acknowledged.

use rusqlite::{params, Connection, OptionalExtension};
use std::path::{Path, PathBuf};

/// Schema migrations, applied in order; meta.schema_version is how many have run.
const MIGRATIONS: &[&str] = &[
    // 1: the journal and snapshots
    "CREATE TABLE commands (seq INTEGER PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL);
     CREATE TABLE snapshots (seq INTEGER PRIMARY KEY, ts INTEGER NOT NULL, version TEXT NOT NULL, state BLOB NOT NULL);",
    // 2: read tables (full history; the exchange keeps only the latest in memory). Money and prices are exact
    // decimal strings in USD (per coin), sizes in coins, as the API shows them.
    "CREATE TABLE fills (id INTEGER PRIMARY KEY, seq INTEGER NOT NULL, ts INTEGER NOT NULL, market TEXT NOT NULL, kind TEXT NOT NULL,
                         price TEXT NOT NULL, size TEXT NOT NULL, notional TEXT NOT NULL, side TEXT NOT NULL,
                         taker TEXT NOT NULL, maker TEXT NOT NULL, taker_order INTEGER, maker_order INTEGER);
     CREATE INDEX fills_market ON fills (market, id);
     CREATE TABLE risk_events (id INTEGER PRIMARY KEY, seq INTEGER NOT NULL, ts INTEGER NOT NULL, market TEXT NOT NULL, kind TEXT NOT NULL,
                               accounts TEXT NOT NULL, text TEXT NOT NULL, amount TEXT, price TEXT);
     CREATE INDEX risk_events_market ON risk_events (market, id);
     CREATE TABLE candles (market TEXT NOT NULL, t INTEGER NOT NULL, o TEXT NOT NULL, h TEXT NOT NULL, l TEXT NOT NULL, c TEXT NOT NULL,
                           v TEXT NOT NULL, PRIMARY KEY (market, t));
     CREATE TABLE accounts (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, bot INTEGER NOT NULL);",
];

pub const BUILD: &str = concat!("impulse-server ", env!("CARGO_PKG_VERSION"));

pub struct Store {
    conn: Connection,
    pub path: PathBuf,
}

pub struct Snapshot {
    pub seq: u64,
    pub state: Vec<u8>,
}

pub struct Journaled {
    pub seq: u64,
    pub ts: i64,
    pub payload: String,
}

fn err(e: rusqlite::Error) -> String {
    e.to_string()
}

impl Store {
    /// Open (or create) DATA_DIR/impulse.db and bring its schema up to date.
    pub fn open(dir: &Path) -> Result<Store, String> {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        let path = dir.join("impulse.db");
        let conn = Connection::open(&path).map_err(err)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;",
        )
        .map_err(err)?;
        let store = Store { conn, path };
        store.migrate()?;
        Ok(store)
    }

    /// Open an existing database without changing it (for offline replay).
    pub fn open_read_only(dir: &Path) -> Result<Store, String> {
        let path = dir.join("impulse.db");
        let conn = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| format!("{}: {e}", path.display()))?;
        Ok(Store { conn, path })
    }

    fn migrate(&self) -> Result<(), String> {
        self.conn
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
            )
            .map_err(err)?;
        let done: usize = self
            .meta("schema_version")?
            .map_or(0, |v| v.parse().unwrap_or(0));
        if done > MIGRATIONS.len() {
            return Err(format!(
                "{} has schema version {done}, newer than this build's {}",
                self.path.display(),
                MIGRATIONS.len()
            ));
        }
        for (i, sql) in MIGRATIONS.iter().enumerate().skip(done) {
            let tx = self.conn.unchecked_transaction().map_err(err)?;
            tx.execute_batch(sql)
                .map_err(|e| format!("migration {}: {e}", i + 1))?;
            tx.execute(
                "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?1)",
                [(i + 1).to_string()],
            )
            .map_err(err)?;
            if i == 0 {
                tx.execute(
                    "INSERT OR IGNORE INTO meta (key, value) VALUES ('created_at', ?1)",
                    [crate::intake::wall_ms().to_string()],
                )
                .map_err(err)?;
            }
            tx.commit().map_err(err)?;
        }
        Ok(())
    }

    pub fn meta(&self, key: &str) -> Result<Option<String>, String> {
        self.conn
            .query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
            .optional()
            .map_err(err)
    }

    /// No journal and no snapshot: a fresh exchange.
    pub fn is_empty(&self) -> Result<bool, String> {
        let n: i64 = self
            .conn
            .query_row(
                "SELECT (SELECT COUNT(*) FROM commands) + (SELECT COUNT(*) FROM snapshots)",
                [],
                |r| r.get(0),
            )
            .map_err(err)?;
        Ok(n == 0)
    }

    pub fn begin(&self) -> Result<(), String> {
        self.conn.execute_batch("BEGIN IMMEDIATE").map_err(err)
    }

    pub fn commit(&self) -> Result<(), String> {
        self.conn.execute_batch("COMMIT").map_err(err)
    }

    pub fn rollback(&self) {
        let _ = self.conn.execute_batch("ROLLBACK");
    }

    pub fn insert_command(
        &self,
        seq: u64,
        ts: i64,
        kind: &str,
        payload: &str,
    ) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO commands (seq, ts, kind, payload) VALUES (?1, ?2, ?3, ?4)",
                params![seq as i64, ts, kind, payload],
            )
            .map_err(err)
            .map(|_| ())
    }

    /// Journaled commands after `seq`, in order.
    pub fn commands_after(&self, seq: u64, until: Option<u64>) -> Result<Vec<Journaled>, String> {
        let mut st = self
            .conn
            .prepare(
                "SELECT seq, ts, payload FROM commands WHERE seq > ?1 AND seq <= ?2 ORDER BY seq",
            )
            .map_err(err)?;
        let rows = st
            .query_map(
                params![seq as i64, until.map_or(i64::MAX, |u| u as i64)],
                |r| {
                    Ok(Journaled {
                        seq: r.get::<_, i64>(0)? as u64,
                        ts: r.get(1)?,
                        payload: r.get(2)?,
                    })
                },
            )
            .map_err(err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(err)
    }

    /// The latest snapshot at or before `until` (any, if None).
    pub fn latest_snapshot(&self, until: Option<u64>) -> Result<Option<Snapshot>, String> {
        self.conn
            .query_row(
                "SELECT seq, state FROM snapshots WHERE seq <= ?1 ORDER BY seq DESC LIMIT 1",
                [until.map_or(i64::MAX, |u| u as i64)],
                |r| {
                    Ok(Snapshot {
                        seq: r.get::<_, i64>(0)? as u64,
                        state: r.get(1)?,
                    })
                },
            )
            .optional()
            .map_err(err)
    }

    /// The oldest snapshot (a legacy import is seq 0): where a full replay starts if there's no Genesis command.
    pub fn first_snapshot(&self) -> Result<Option<Snapshot>, String> {
        self.conn
            .query_row(
                "SELECT seq, state FROM snapshots ORDER BY seq LIMIT 1",
                [],
                |r| {
                    Ok(Snapshot {
                        seq: r.get::<_, i64>(0)? as u64,
                        state: r.get(1)?,
                    })
                },
            )
            .optional()
            .map_err(err)
    }

    /// Store a snapshot and keep only the last 5 (plus a legacy import's snapshot 0).
    pub fn save_snapshot(&self, seq: u64, ts: i64, state: &[u8]) -> Result<(), String> {
        let tx = self.conn.unchecked_transaction().map_err(err)?;
        tx.execute(
            "INSERT OR REPLACE INTO snapshots (seq, ts, version, state) VALUES (?1, ?2, ?3, ?4)",
            params![seq as i64, ts, BUILD, state],
        )
        .map_err(err)?;
        // Snapshot 0 (a legacy import) is the base the journal starts from: never pruned.
        tx.execute("DELETE FROM snapshots WHERE seq <> 0 AND seq NOT IN (SELECT seq FROM snapshots ORDER BY seq DESC LIMIT 5)", []).map_err(err)?;
        tx.commit().map_err(err)
    }
}

// ---------- read tables ----------

use crate::exchange::{Exchange, Fill, RiskEvent};
use crate::units::{coin_price, fmt, usd};
use serde_json::{json, Value};

impl Store {
    fn insert_fill(&self, seq: u64, x: &Exchange, f: &Fill) -> Result<(), String> {
        let v = serde_json::to_value(crate::views::fill_view(x, f, None))
            .expect("fill view serializes");
        self.conn
            .execute(
                "INSERT OR REPLACE INTO fills (id, seq, ts, market, kind, price, size, notional, side, taker, maker, taker_order, maker_order)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                params![
                    f.id as i64,
                    seq as i64,
                    f.time,
                    f.market,
                    v["kind"].as_str(),
                    v["price"].as_str(),
                    v["size"].as_str(),
                    v["notional"].as_str(),
                    v["side"].as_str(),
                    f.taker,
                    f.maker,
                    f.taker_order.map(|o| o as i64),
                    f.maker_order.map(|o| o as i64)
                ],
            )
            .map_err(err)
            .map(|_| ())
    }

    fn insert_risk(&self, seq: u64, r: &RiskEvent) -> Result<(), String> {
        let kind = serde_json::to_value(r.kind).expect("kind serializes");
        self.conn
            .execute(
                "INSERT OR REPLACE INTO risk_events (id, seq, ts, market, kind, accounts, text, amount, price) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![r.id as i64, seq as i64, r.time, r.market, kind.as_str(), serde_json::to_string(&r.accounts).unwrap(), r.text, r.amount, r.price],
            )
            .map_err(err)
            .map(|_| ())
    }

    fn upsert_candle(&self, x: &Exchange, market: &str, t: i64) -> Result<(), String> {
        let (Some(meta), Some(cs)) = (x.markets.get(market), x.candles.get(market)) else {
            return Ok(());
        };
        let Ok(i) = cs.binary_search_by_key(&t, |c| c.t) else {
            return Ok(());
        }; // already rolled out of memory
        let c = &cs[i];
        let p = |lot: i128| fmt(coin_price(meta.sz_decimals, lot), 0);
        self.conn
            .execute(
                "INSERT OR REPLACE INTO candles (market, t, o, h, l, c, v) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![market, t, p(c.o), p(c.h), p(c.l), p(c.c), usd(c.v)],
            )
            .map_err(err)
            .map(|_| ())
    }

    /// Write what step `seq` added to the exchange's history: fills and risk events with ids past the given ones,
    /// accounts past the given count, and the candles it touched. Returns the new high-water marks.
    pub fn write_history(
        &self,
        seq: u64,
        x: &mut Exchange,
        marks: HistoryMarks,
    ) -> Result<HistoryMarks, String> {
        let mut next = marks;
        for f in x.fills.iter().rev().take_while(|f| f.id > marks.fill) {
            self.insert_fill(seq, x, f)?;
            next.fill = next.fill.max(f.id);
        }
        for r in x.risk.iter().rev().take_while(|r| r.id > marks.risk) {
            self.insert_risk(seq, r)?;
            next.risk = next.risk.max(r.id);
        }
        for a in x.accounts.values().skip(marks.accounts) {
            self.conn
                .execute(
                    "INSERT OR REPLACE INTO accounts (id, created_at, bot) VALUES (?1, ?2, ?3)",
                    params![a.id, a.created_at, a.bot as i64],
                )
                .map_err(err)?;
        }
        next.accounts = x.accounts.len();
        for (market, t) in std::mem::take(&mut x.dirty_candles) {
            self.upsert_candle(x, &market, t)?;
        }
        Ok(next)
    }

    /// Risk events newest first, from the full history: ids below `before`, optionally one market.
    pub fn risk_page(
        &self,
        market: Option<&str>,
        before: Option<u64>,
        limit: usize,
    ) -> Result<Vec<Value>, String> {
        let mut st = self
            .conn
            .prepare("SELECT id, ts, market, kind, accounts, text, amount, price FROM risk_events WHERE (?1 IS NULL OR market = ?1) AND id < ?2 ORDER BY id DESC LIMIT ?3")
            .map_err(err)?;
        let rows = st
            .query_map(params![market, before.map_or(i64::MAX, |b| b as i64), limit as i64], |r| {
                let accounts: String = r.get(4)?;
                Ok(json!({
                    "id": r.get::<_, i64>(0)?, "time": r.get::<_, i64>(1)?, "market": r.get::<_, String>(2)?, "kind": r.get::<_, String>(3)?,
                    "accounts": serde_json::from_str::<Value>(&accounts).unwrap_or(Value::Null), "text": r.get::<_, String>(5)?,
                    "amount": r.get::<_, Option<String>>(6)?, "price": r.get::<_, Option<String>>(7)?,
                }))
            })
            .map_err(err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(err)
    }

    /// A market's fills newest first, from the full history: ids below `before`.
    pub fn fills_page(
        &self,
        market: &str,
        before: Option<u64>,
        limit: usize,
    ) -> Result<Vec<Value>, String> {
        let mut st = self
            .conn
            .prepare("SELECT id, ts, market, kind, price, size, notional, side, taker, maker FROM fills WHERE market = ?1 AND id < ?2 ORDER BY id DESC LIMIT ?3")
            .map_err(err)?;
        let rows = st
            .query_map(params![market, before.map_or(i64::MAX, |b| b as i64), limit as i64], |r| {
                Ok(json!({
                    "id": r.get::<_, i64>(0)?, "time": r.get::<_, i64>(1)?, "market": r.get::<_, String>(2)?, "kind": r.get::<_, String>(3)?,
                    "price": r.get::<_, String>(4)?, "size": r.get::<_, String>(5)?, "notional": r.get::<_, String>(6)?,
                    "side": r.get::<_, String>(7)?, "taker": r.get::<_, String>(8)?, "maker": r.get::<_, String>(9)?,
                }))
            })
            .map_err(err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(err)
    }
}

/// How far the read tables have caught up with the exchange's history.
#[derive(Clone, Copy, Debug, Default)]
pub struct HistoryMarks {
    pub fill: u64,
    pub risk: u64,
    pub accounts: usize,
}

impl HistoryMarks {
    /// Everything the exchange holds now counts as written.
    pub fn of(x: &Exchange) -> Self {
        HistoryMarks {
            fill: x.fills.back().map_or(0, |f| f.id),
            risk: x.risk.back().map_or(0, |r| r.id),
            accounts: x.accounts.len(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pruning_keeps_the_last_five_snapshots_and_a_legacy_import() {
        let dir = std::env::temp_dir().join(format!(
            "impulse-store-{}-{}",
            std::process::id(),
            crate::intake::wall_ms()
        ));
        let store = Store::open(&dir).unwrap();
        for seq in [0, 10, 20, 30, 40, 50, 60, 70] {
            store.save_snapshot(seq, 0, b"{}").unwrap();
        }
        let mut st = store
            .conn
            .prepare("SELECT seq FROM snapshots ORDER BY seq")
            .unwrap();
        let kept: Vec<i64> = st
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(kept, [0, 30, 40, 50, 60, 70]);
    }
}

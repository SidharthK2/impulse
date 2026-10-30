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
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;").map_err(err)?;
        let store = Store { conn, path };
        store.migrate()?;
        Ok(store)
    }

    /// Open an existing database without changing it (for offline replay).
    pub fn open_read_only(dir: &Path) -> Result<Store, String> {
        let path = dir.join("impulse.db");
        let conn = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| format!("{}: {e}", path.display()))?;
        Ok(Store { conn, path })
    }

    fn migrate(&self) -> Result<(), String> {
        self.conn.execute_batch("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);").map_err(err)?;
        let done: usize = self.meta("schema_version")?.map_or(0, |v| v.parse().unwrap_or(0));
        if done > MIGRATIONS.len() {
            return Err(format!("{} has schema version {done}, newer than this build's {}", self.path.display(), MIGRATIONS.len()));
        }
        for (i, sql) in MIGRATIONS.iter().enumerate().skip(done) {
            let tx = self.conn.unchecked_transaction().map_err(err)?;
            tx.execute_batch(sql).map_err(|e| format!("migration {}: {e}", i + 1))?;
            tx.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?1)", [(i + 1).to_string()]).map_err(err)?;
            if i == 0 {
                tx.execute("INSERT OR IGNORE INTO meta (key, value) VALUES ('created_at', ?1)", [crate::intake::wall_ms().to_string()]).map_err(err)?;
            }
            tx.commit().map_err(err)?;
        }
        Ok(())
    }

    pub fn meta(&self, key: &str) -> Result<Option<String>, String> {
        self.conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0)).optional().map_err(err)
    }

    /// No journal and no snapshot: a fresh exchange.
    pub fn is_empty(&self) -> Result<bool, String> {
        let n: i64 = self.conn.query_row("SELECT (SELECT COUNT(*) FROM commands) + (SELECT COUNT(*) FROM snapshots)", [], |r| r.get(0)).map_err(err)?;
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

    pub fn insert_command(&self, seq: u64, ts: i64, kind: &str, payload: &str) -> Result<(), String> {
        self.conn.execute("INSERT INTO commands (seq, ts, kind, payload) VALUES (?1, ?2, ?3, ?4)", params![seq as i64, ts, kind, payload]).map_err(err).map(|_| ())
    }

    /// Journaled commands after `seq`, in order.
    pub fn commands_after(&self, seq: u64, until: Option<u64>) -> Result<Vec<Journaled>, String> {
        let mut st = self.conn.prepare("SELECT seq, ts, payload FROM commands WHERE seq > ?1 AND seq <= ?2 ORDER BY seq").map_err(err)?;
        let rows = st
            .query_map(params![seq as i64, until.map_or(i64::MAX, |u| u as i64)], |r| Ok(Journaled { seq: r.get::<_, i64>(0)? as u64, ts: r.get(1)?, payload: r.get(2)? }))
            .map_err(err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(err)
    }

    /// The latest snapshot at or before `until` (any, if None).
    pub fn latest_snapshot(&self, until: Option<u64>) -> Result<Option<Snapshot>, String> {
        self.conn
            .query_row(
                "SELECT seq, state FROM snapshots WHERE seq <= ?1 ORDER BY seq DESC LIMIT 1",
                [until.map_or(i64::MAX, |u| u as i64)],
                |r| Ok(Snapshot { seq: r.get::<_, i64>(0)? as u64, state: r.get(1)? }),
            )
            .optional()
            .map_err(err)
    }

    /// The oldest snapshot (a legacy import is seq 0): where a full replay starts if there's no Genesis command.
    pub fn first_snapshot(&self) -> Result<Option<Snapshot>, String> {
        self.conn
            .query_row("SELECT seq, state FROM snapshots ORDER BY seq LIMIT 1", [], |r| Ok(Snapshot { seq: r.get::<_, i64>(0)? as u64, state: r.get(1)? }))
            .optional()
            .map_err(err)
    }

    /// Store a snapshot and keep only the last 5.
    pub fn save_snapshot(&self, seq: u64, ts: i64, state: &[u8]) -> Result<(), String> {
        let tx = self.conn.unchecked_transaction().map_err(err)?;
        tx.execute("INSERT OR REPLACE INTO snapshots (seq, ts, version, state) VALUES (?1, ?2, ?3, ?4)", params![seq as i64, ts, BUILD, state]).map_err(err)?;
        tx.execute("DELETE FROM snapshots WHERE seq NOT IN (SELECT seq FROM snapshots ORDER BY seq DESC LIMIT 5)", []).map_err(err)?;
        tx.commit().map_err(err)
    }
}

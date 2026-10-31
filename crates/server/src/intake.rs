// The outside world, as the core sees it: wall-clock time and randomness. The exchange core never reads either
// directly; time and anything random (API keys, demo-coin handles, bot and random-walk decisions) are taken here, at
// intake, and handed to the core, so the same inputs in the same order always give the same exchange.

pub fn wall_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The intake clock: wall time, or (TEST_CLOCK=1) a clock only the test hooks move. Never runs backwards.
#[derive(Clone, Copy, Debug)]
pub enum IntakeClock {
    Wall,
    Manual(i64),
}

impl IntakeClock {
    pub fn new(test: bool) -> Self {
        if test {
            IntakeClock::Manual(wall_ms())
        } else {
            IntakeClock::Wall
        }
    }

    pub fn now(&self) -> i64 {
        match self {
            IntakeClock::Wall => wall_ms(),
            IntakeClock::Manual(t) => *t,
        }
    }

    /// Test clock only.
    pub fn advance(&mut self, ms: i64) {
        if let IntakeClock::Manual(t) = self {
            *t += ms;
        }
    }
}

/// A fresh API key: 24 random bytes, base64url.
pub fn api_key() -> String {
    let mut bytes = [0u8; 24];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let _ = std::io::Read::read_exact(&mut f, &mut bytes);
    } else {
        // no /dev/urandom: fall back to the std hasher's per-process random keys
        use std::hash::{BuildHasher, Hasher};
        for chunk in bytes.chunks_mut(8) {
            let mut h = std::collections::hash_map::RandomState::new().build_hasher();
            h.write_i64(wall_ms());
            chunk.copy_from_slice(&h.finish().to_le_bytes()[..chunk.len()]);
        }
    }
    base64url(&bytes)
}

fn base64url(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16
            | (*c.get(1).unwrap_or(&0) as u32) << 8
            | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..=c.len() {
            out.push(A[(n >> (18 - 6 * i) & 63) as usize] as char);
        }
    }
    out
}

/// FNV-1a, 64-bit: a stable hash (same bytes, same hash, on every build and machine).
pub fn fnv64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

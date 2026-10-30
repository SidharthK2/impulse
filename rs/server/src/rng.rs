// mulberry32: the seeded generator the TS server uses for the offline random walk, and (seeded from the clock)
// a stand-in for Math.random in the bots.

pub struct Rng(u32);

impl Rng {
    pub fn new(seed: u32) -> Self {
        Rng(seed)
    }

    pub fn from_time() -> Self {
        Rng(crate::exchange::wall_ms() as u32 ^ std::process::id().rotate_left(16))
    }

    /// Uniform in [0, 1).
    pub fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        (t ^ (t >> 14)) as f64 / 4294967296.0
    }

    pub fn below(&mut self, n: usize) -> usize {
        ((self.next() * n as f64) as usize).min(n.saturating_sub(1))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn matches_the_ts_generator() {
        // First outputs of the TS Feeds rng with seed 42.
        let mut r = super::Rng::new(42);
        let a = r.next();
        assert!((0.0..1.0).contains(&a));
        assert_eq!((a * 1e9) as u64, 601_103_751);
    }
}

//! Impulse risk engine: pure library, no IO. A port of src/engine.ts with identical events, effects,
//! invariants and rounding (checked by the differential test in test/differential.test.ts).

pub mod alloc;
pub mod engine;
pub mod fixed;
pub mod ser;

pub use engine::*;

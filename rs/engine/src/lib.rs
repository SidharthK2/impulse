//! Impulse risk engine: pure library, no IO. A port of impulse-research: reference/engine/engine.ts with identical events, effects,
//! invariants and rounding (checked against its frozen results in tests/golden/ by tests/golden.rs).

pub mod alloc;
pub mod engine;
pub mod fixed;
pub mod ser;

pub use engine::*;

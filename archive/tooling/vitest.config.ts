import { defineConfig } from "vitest/config";

// Archived: the app's Vitest suite before the move to Rust tests (archive/tests/). The global setup starts the Rust
// server (rs/target/debug/impulse-server) for the HTTP tests; the differential test runs rs/target/debug/impulse-replay.
const archive = new URL("..", import.meta.url).pathname;
export default defineConfig({ test: { root: archive, include: ["tests/**/*.test.ts"], fileParallelism: false, globalSetup: ["tests/http/global-setup.ts"] } });

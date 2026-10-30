import { defineConfig } from "vitest/config";

// The global setup starts one Rust server (rs/target/debug/impulse-server) for the HTTP tests in server/test.
// Test files run one at a time: they share that server, and some of them move its clock.
export default defineConfig({ test: { fileParallelism: false, globalSetup: ["server/test/global-setup.ts"] } });

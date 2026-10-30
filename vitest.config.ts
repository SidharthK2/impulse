import { defineConfig } from "vitest/config";

// The global setup starts one Rust server (rs/target/debug/impulse-server) for the HTTP tests in server/test.
export default defineConfig({ test: { maxWorkers: 2, globalSetup: ["server/test/global-setup.ts"] } });

import { defineConfig } from "vitest/config";

// The app's test suite lives in tests/. The global setup starts one Rust server (rs/target/debug/impulse-server)
// for the HTTP tests in tests/http. Test files run one at a time: they share that server, and some move its clock.
export default defineConfig({ test: { include: ["tests/**/*.test.ts"], fileParallelism: false, globalSetup: ["tests/http/global-setup.ts"] } });

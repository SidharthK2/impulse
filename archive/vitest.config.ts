import { defineConfig } from "vitest/config";

// Research-phase tests (the pump-attack sweep). Not part of the app's suite: `pnpm archive:test`.
export default defineConfig({ test: { include: ["archive/sims/**/*.test.ts"] } });

import { defineConfig } from "vitest/config";

// Research-phase tests (the pump-attack sweep). Not part of the app's suite: from archive/tooling, `pnpm sims:test`.
export default defineConfig({ test: { root: new URL(".", import.meta.url).pathname, include: ["sims/**/*.test.ts"] } });

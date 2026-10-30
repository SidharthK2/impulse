// Starts one Rust server for the HTTP tests (unless BASE_URL points them at a running one): offline, no bots,
// a clock only the /api/test/* hooks move, and a fresh data directory.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    rustBase: string | null;
    remoteBase: string | null;
  }
}

const root = new URL("../../..", import.meta.url).pathname;
const bin = `${root}rs/target/debug/impulse-server`;

export default async function setup(project: TestProject) {
  // Read BASE_URL here: inside test workers vitest sets it to Vite's base path ("/").
  const remote = process.env.BASE_URL?.startsWith("http") ? process.env.BASE_URL.replace(/\/$/, "") : null;
  project.provide("remoteBase", remote);
  if (remote || !existsSync(bin)) {
    project.provide("rustBase", null);
    return;
  }
  const env = { ...process.env, PORT: "0", OFFLINE: "1", BOTS: "0", TEST_CLOCK: "1", ADMIN_TOKEN: "t", DATA_DIR: mkdtempSync(join(tmpdir(), "impulse-test-")), WEB_DIR: "-" };
  const proc = spawn(bin, [], { env, stdio: ["ignore", "pipe", "inherit"] });
  const base = await new Promise<string>((resolve, reject) => {
    let out = "";
    proc.stdout!.on("data", (d: Buffer) => {
      out += d.toString();
      const m = /listening on (http:\/\/localhost:\d+)/.exec(out);
      if (m) resolve(m[1]!.replace("localhost", "127.0.0.1"));
    });
    proc.on("exit", (code) => reject(new Error(`impulse-server exited (${code}) before listening:\n${out}`)));
    setTimeout(() => reject(new Error(`impulse-server did not start:\n${out}`)), 15_000).unref();
  });
  project.provide("rustBase", base);
  return () => {
    proc.kill("SIGTERM");
  };
}

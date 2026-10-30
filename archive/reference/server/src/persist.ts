// Snapshot persistence: the whole exchange (engine state, books, accounts, history) as one JSON file, written
// atomically (temp file, then rename). Bigints are tagged so they round-trip exactly.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Snapshot } from "./exchange.js";

const replacer = (_k: string, v: unknown) => (typeof v === "bigint" ? { $n: v.toString() } : v);
const reviver = (_k: string, v: unknown) =>
  v !== null && typeof v === "object" && "$n" in v && Object.keys(v).length === 1 ? BigInt((v as { $n: string }).$n) : v;

export const serialize = (s: Snapshot) => JSON.stringify(s, replacer);
export const deserialize = (text: string) => JSON.parse(text, reviver) as Snapshot;

export function saveSnapshot(dir: string, s: Snapshot) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "snapshot.json");
  writeFileSync(`${file}.tmp`, serialize(s));
  renameSync(`${file}.tmp`, file);
}

export function loadSnapshot(dir: string): Snapshot | null {
  const file = join(dir, "snapshot.json");
  if (!existsSync(file)) return null;
  return deserialize(readFileSync(file, "utf8"));
}

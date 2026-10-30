// Largest-remainder apportionment: split `total` across weights so the parts sum to
// exactly `total` and each part is floor or ceil of its exact pro-rata share.
// Ties on remainder go to the earlier entry; callers pass entries sorted by id for determinism.

export function allocate<K>(total: bigint, weights: ReadonlyArray<{ key: K; weight: bigint }>): Map<K, bigint> {
  const out = new Map<K, bigint>();
  if (total < 0n) throw new Error("allocate: negative total");
  const sum = weights.reduce((s, w) => s + w.weight, 0n);
  if (sum <= 0n) {
    if (total === 0n) {
      for (const w of weights) out.set(w.key, 0n);
      return out;
    }
    throw new Error("allocate: no weight to allocate against");
  }
  let assigned = 0n;
  const rems: { idx: number; rem: bigint }[] = [];
  weights.forEach((w, idx) => {
    if (w.weight < 0n) throw new Error("allocate: negative weight");
    const exact = total * w.weight;
    const base = exact / sum;
    out.set(w.key, base);
    assigned += base;
    rems.push({ idx, rem: exact % sum });
  });
  rems.sort((a, b) => (a.rem === b.rem ? a.idx - b.idx : a.rem > b.rem ? -1 : 1));
  for (let i = 0; assigned < total; i++) {
    const k = weights[rems[i]!.idx]!.key;
    out.set(k, out.get(k)! + 1n);
    assigned += 1n;
  }
  return out;
}

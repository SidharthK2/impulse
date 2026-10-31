// Largest-remainder apportionment: split `total` across weights so the parts sum to exactly `total` and each
// part is floor or ceil of its exact pro-rata share. Ties on remainder go to the earlier entry; callers pass
// entries sorted by id for determinism. Returns the parts in the order of `weights`. Mirrors src/alloc.ts.

pub fn allocate(total: i128, weights: &[i128]) -> Result<Vec<i128>, String> {
    if total < 0 {
        return Err("allocate: negative total".into());
    }
    let sum: i128 = weights.iter().sum();
    if sum <= 0 {
        if total == 0 {
            return Ok(vec![0; weights.len()]);
        }
        return Err("allocate: no weight to allocate against".into());
    }
    let mut out = Vec::with_capacity(weights.len());
    let mut rems = Vec::with_capacity(weights.len());
    let mut assigned = 0;
    for (idx, &w) in weights.iter().enumerate() {
        if w < 0 {
            return Err("allocate: negative weight".into());
        }
        let (base, rem) = mul_div_rem(total, w, sum);
        out.push(base);
        assigned += base;
        rems.push((idx, rem));
    }
    rems.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let mut i = 0;
    while assigned < total {
        out[rems[i].0] += 1;
        assigned += 1;
        i += 1;
    }
    Ok(out)
}

/// (a·b / c, a·b mod c) for non-negative a, b and positive c, exact even when a·b overflows i128 (the TS engine
/// uses unbounded bigints; e.g. pnl-ADL weights are equities, and a profit × equity product can pass 1e38).
/// The quotient here is at most `total`, so it always fits.
fn mul_div_rem(a: i128, b: i128, c: i128) -> (i128, i128) {
    if let Some(p) = a.checked_mul(b) {
        return (p / c, p % c);
    }
    let (a, b, c) = (a as u128, b as u128, c as u128);
    // 256-bit product as (hi, lo)
    let mask = u64::MAX as u128;
    let (a1, a0, b1, b0) = (a >> 64, a & mask, b >> 64, b & mask);
    let (p00, p01, p10, p11) = (a0 * b0, a0 * b1, a1 * b0, a1 * b1);
    let mid = (p00 >> 64) + (p01 & mask) + (p10 & mask);
    let lo = (p00 & mask) | (mid << 64);
    let hi = p11 + (p01 >> 64) + (p10 >> 64) + (mid >> 64);
    // shift-subtract long division of (hi, lo) by c
    let (mut q, mut r) = (0u128, 0u128);
    for i in (0..256).rev() {
        let bit = if i >= 128 {
            (hi >> (i - 128)) & 1
        } else {
            (lo >> i) & 1
        };
        let carry = r >> 127;
        r = (r << 1) | bit;
        q <<= 1;
        if carry == 1 || r >= c {
            r = r.wrapping_sub(c);
            q |= 1;
        }
    }
    (q as i128, r as i128)
}

#[cfg(test)]
mod tests {
    use super::allocate;

    #[test]
    fn sums_exactly_with_ties_to_earlier() {
        assert_eq!(allocate(10, &[1, 1, 1]).unwrap(), vec![4, 3, 3]);
        assert_eq!(allocate(0, &[0, 0]).unwrap(), vec![0, 0]);
        assert!(allocate(1, &[0]).is_err());
        assert_eq!(allocate(7, &[2, 5]).unwrap(), vec![2, 5]);
        let big = 60_000_000_000_000_000_000_000i128; // 6e22
        assert_eq!(
            allocate(big, &[big, big, big]).unwrap(),
            vec![big / 3, big / 3, big / 3]
        );
        assert_eq!(
            allocate(big + 1, &[big, 2 * big]).unwrap(),
            vec![big / 3, 2 * big / 3 + 1]
        );
    }
}

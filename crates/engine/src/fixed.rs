// Fixed-point helpers. Money and prices are nano-USD i128s (9 decimals, the unit Mirror's engine uses),
// so a $0.000005 memecoin is 5_000 and size × price stays exact. Mirrors src/fixed.ts.

pub const DECIMALS: usize = 9;
pub const ONE: i128 = 1_000_000_000;

/// Parse a decimal string with at most 9 decimals ("-12.5", "0.000001"). Same grammar as parseFixed.
pub fn parse_fixed(s: &str) -> Result<i128, String> {
    let str = s.trim();
    let err = || format!("invalid decimal \"{str}\" (max {DECIMALS} decimals)");
    let (neg, body) = match str.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, str),
    };
    let (int, frac) = match body.split_once('.') {
        Some((i, f)) => (i, Some(f)),
        None => (body, None),
    };
    if int.is_empty() || !int.bytes().all(|b| b.is_ascii_digit()) {
        return Err(err());
    }
    let mut v: i128 = int
        .parse::<i128>()
        .map_err(|_| err())?
        .checked_mul(ONE)
        .ok_or_else(err)?;
    if let Some(f) = frac {
        if f.is_empty() || f.len() > DECIMALS || !f.bytes().all(|b| b.is_ascii_digit()) {
            return Err(err());
        }
        let padded = format!("{f:0<9}");
        v += padded.parse::<i128>().map_err(|_| err())?;
    }
    Ok(if neg { -v } else { v })
}

/// Exact decimal string, trailing zeros trimmed down to `min_decimals`.
pub fn fmt(v: i128, min_decimals: usize) -> String {
    let neg = v < 0;
    let a = v.unsigned_abs();
    let one = ONE as u128;
    let mut frac = format!("{:09}", a % one);
    while frac.len() > min_decimals && frac.ends_with('0') {
        frac.pop();
    }
    format!(
        "{}{}{}",
        if neg { "-" } else { "" },
        a / one,
        if frac.is_empty() {
            String::new()
        } else {
            format!(".{frac}")
        }
    )
}

pub fn fmt_usd(v: i128) -> String {
    fmt(v, 2)
}

pub fn fmt_price(v: i128) -> String {
    fmt(v, 4)
}

pub fn sign(v: i128) -> i128 {
    v.signum()
}

/// a, b >= 0
pub fn ceil_div(a: i128, b: i128) -> i128 {
    (a + b - 1) / b
}

/// Floor square root of a non-negative integer.
pub fn isqrt(n: i128) -> i128 {
    if n < 2 {
        return n;
    }
    let mut x = (n as f64).sqrt() as i128;
    while x * x > n {
        x -= 1;
    }
    while (x + 1) * (x + 1) <= n {
        x += 1;
    }
    x
}

/// BigInt(string | number) as the TS engine reads integer fields: optional sign, decimal digits, "" = 0.
pub fn parse_int(s: &str) -> Result<i128, String> {
    let t = s.trim();
    if t.is_empty() {
        return Ok(0);
    }
    t.parse::<i128>()
        .map_err(|_| format!("Cannot convert {t} to a BigInt"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_formats() {
        assert_eq!(parse_fixed("1.5").unwrap(), 1_500_000_000);
        assert_eq!(parse_fixed("-0.000000001").unwrap(), -1);
        assert_eq!(parse_fixed(" 12 ").unwrap(), 12 * ONE);
        assert!(parse_fixed("1.").is_err());
        assert!(parse_fixed("1.0000000001").is_err());
        assert!(parse_fixed("abc").is_err());
        assert_eq!(fmt(1_500_000_000, 2), "1.50");
        assert_eq!(fmt(-1, 0), "-0.000000001");
        assert_eq!(fmt(5 * ONE, 0), "5");
        assert_eq!(fmt_price(125_000), "0.000125");
    }

    #[test]
    fn isqrt_is_floor() {
        for n in [
            0i128,
            1,
            2,
            3,
            4,
            15,
            16,
            17,
            1 << 100,
            (1 << 100) + 1,
            2_025_000_000_000_000_000_000_000_000,
        ] {
            let r = isqrt(n);
            assert!(r * r <= n && (r + 1) * (r + 1) > n, "{n}");
        }
    }
}

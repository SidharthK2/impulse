// Conversions between what users see (coins, USD per coin) and what the engine trades (integer lots, nano-USD per
// lot). A market's lot is 10^-szDecimals coins, Hyperliquid style: BTC trades in 0.00001 BTC lots, a binary
// outcome or an attention token in whole units. Money is nano-USD everywhere, so lots × lot price stays exact.

pub use impulse_engine::fixed::{fmt, parse_fixed, ONE};

pub fn pow10(n: u32) -> i128 {
    10i128.pow(n)
}

/// Parse a non-negative decimal with at most `decimals` places into an integer scaled by 10^decimals.
pub fn parse_scaled(s: &str, decimals: u32) -> Result<i128, String> {
    let str = s.trim();
    let bad = || format!("invalid number \"{str}\"");
    let (int, frac) = match str.split_once('.') {
        Some((i, f)) => (i, f),
        None => (str, ""),
    };
    if int.is_empty() || !int.bytes().all(|b| b.is_ascii_digit()) || !frac.bytes().all(|b| b.is_ascii_digit()) {
        return Err(bad());
    }
    if str.contains('.') && frac.is_empty() {
        return Err(bad());
    }
    let trimmed = frac.trim_end_matches('0');
    if trimmed.len() > decimals as usize {
        return Err(format!("\"{str}\" has more than {decimals} decimals"));
    }
    let i: i128 = int.parse().map_err(|_| bad())?;
    let f: i128 = if decimals == 0 { 0 } else { format!("{trimmed:0<w$}", w = decimals as usize).parse().map_err(|_| bad())? };
    Ok(i * pow10(decimals) + f)
}

/// Exact decimal string of an integer scaled by 10^decimals, trailing zeros trimmed.
pub fn fmt_scaled(v: i128, decimals: u32) -> String {
    if decimals == 0 {
        return v.to_string();
    }
    let neg = v < 0;
    let a = v.abs();
    let d = pow10(decimals);
    let frac = format!("{:0w$}", a % d, w = decimals as usize);
    let frac = frac.trim_end_matches('0');
    format!("{}{}{}", if neg { "-" } else { "" }, a / d, if frac.is_empty() { String::new() } else { format!(".{frac}") })
}

/// Engine decimal string for a nano value (what parse_fixed reads back).
pub fn dec(v: i128) -> String {
    fmt(v, 0)
}

pub fn usd(v: i128) -> String {
    fmt(v, 2)
}

pub fn lots_from_coins(sz: u32, coins: &str) -> Result<i128, String> {
    parse_scaled(coins, sz)
}

pub fn coins_from_lots(sz: u32, lots: i128) -> String {
    fmt_scaled(lots, sz)
}

/// Coin price (nano-USD per coin) → lot price (nano-USD per lot), rounded down to a whole nano.
pub fn lot_price(sz: u32, coin_nano: i128) -> i128 {
    coin_nano / pow10(sz)
}

pub fn coin_price(sz: u32, lot_nano: i128) -> i128 {
    lot_nano * pow10(sz)
}

/// Default tick: five significant figures of the starting price (Hyperliquid's rule), never finer than one nano
/// per lot so every tick converts to an exact lot price.
pub fn auto_tick(coin_nano: i128, sz: u32) -> i128 {
    let digits = if coin_nano > 0 { coin_nano.to_string().len() as u32 } else { 1 };
    let tick = pow10(digits.saturating_sub(5));
    tick.max(pow10(sz))
}

/// How many decimals a price on this tick needs.
pub fn tick_decimals(tick: i128) -> u32 {
    let mut d = 9;
    let mut t = tick;
    while d > 0 && t % 10 == 0 {
        t /= 10;
        d -= 1;
    }
    d
}

/// Decimal string → nano, accepting floats from JSON feeds (rounded down to 9 decimals).
pub fn nano_from_feed(s: &str) -> Result<i128, String> {
    let s = s.trim();
    let (int, frac) = s.split_once('.').unwrap_or((s, ""));
    if int.is_empty() || !int.bytes().all(|b| b.is_ascii_digit()) || !frac.bytes().all(|b| b.is_ascii_digit()) {
        return Err(format!("bad feed price \"{s}\""));
    }
    let f: String = frac.chars().take(9).collect();
    let i: i128 = int.parse().map_err(|_| format!("bad feed price \"{s}\""))?;
    Ok(i * ONE + format!("{f:0<9}").parse::<i128>().unwrap_or(0))
}

/// A float price as a feed string (JS toFixed(9)).
pub fn nano_from_f64(v: f64) -> Result<i128, String> {
    if !v.is_finite() || v < 0.0 {
        return Err(format!("bad feed price {v}"));
    }
    nano_from_feed(&format!("{v:.9}"))
}

/// Dollars for human-readable text, rounded to cents, with thousands separators ("1,234.50").
pub fn cents(v: i128) -> String {
    let neg = v < 0;
    let c = (v.abs() + 5_000_000) / 10_000_000;
    format!("{}{}.{:02}", if neg && c != 0 { "-" } else { "" }, group(&(c / 100).to_string()), c % 100)
}

/// "1234567" → "1,234,567"
pub fn group(int: &str) -> String {
    let b = int.as_bytes();
    let mut out = String::new();
    for (i, ch) in b.iter().enumerate() {
        if i > 0 && (b.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(*ch as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scaled_and_lots() {
        assert_eq!(parse_scaled("1.25", 2).unwrap(), 125);
        assert_eq!(parse_scaled("3", 0).unwrap(), 3);
        assert_eq!(parse_scaled("3.000", 0).unwrap(), 3);
        assert!(parse_scaled("1.234", 2).is_err());
        assert_eq!(fmt_scaled(125, 2), "1.25");
        assert_eq!(fmt_scaled(-5, 3), "-0.005");
        assert_eq!(lots_from_coins(5, "0.01").unwrap(), 1000);
        assert_eq!(lot_price(5, 80_000 * ONE), 800_000_000);
        assert_eq!(auto_tick(80_123 * ONE, 5), 1_000_000_000);
        assert_eq!(nano_from_feed("0.1234567891").unwrap(), 123_456_789);
        assert_eq!(cents(1_234_567_890_000), "1,234.57");
        assert_eq!(group("12"), "12");
    }
}

// Conversions between what users see (coins, USD per coin) and what the engine trades (integer lots, nano-USD per
// lot). A market's lot is 10^-szDecimals coins, Hyperliquid style: BTC trades in 0.00001 BTC lots, a binary
// outcome or an attention token in whole units. Money is nano-USD everywhere, so lots × lot price stays exact.

pub use impulse_engine::fixed::{fmt, ONE};

pub fn pow10(n: u32) -> i128 {
    10i128.pow(n)
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

/// Coins → whole lots; refuses more decimals than the market's lot size allows.
pub fn lots_from_coins(sz: u32, coins: crate::money::Dec) -> Result<i128, String> {
    let per_lot = pow10(9 - sz.min(9));
    let nano = coins.nano();
    if nano % per_lot != 0 {
        return Err(format!("\"{coins}\" has more than {sz} decimals"));
    }
    Ok(nano / per_lot)
}

/// Whole lots → coins, as an exact decimal.
pub fn coins_dec(sz: u32, lots: i128) -> crate::money::Dec {
    crate::money::Dec::from_nano(lots * pow10(9 - sz.min(9)))
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
        if i > 0 && (b.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(*ch as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use impulse_engine::fixed::parse_fixed;

    fn d(s: &str) -> crate::money::Dec {
        crate::money::Dec::parse(s).unwrap()
    }

    #[test]
    fn scaled_and_lots() {
        assert_eq!(lots_from_coins(2, d("1.25")).unwrap(), 125);
        assert_eq!(lots_from_coins(0, d("3")).unwrap(), 3);
        assert_eq!(lots_from_coins(0, d("3.000")).unwrap(), 3);
        assert!(lots_from_coins(2, d("1.234")).is_err());
        assert_eq!(fmt_scaled(125, 2), "1.25");
        assert_eq!(fmt_scaled(-5, 3), "-0.005");
        assert_eq!(lots_from_coins(5, d("0.01")).unwrap(), 1000);
        assert_eq!(lot_price(5, 80_000 * ONE), 800_000_000);
        assert_eq!(auto_tick(80_123 * ONE, 5), 1_000_000_000);
        assert_eq!(nano_from_feed("0.1234567891").unwrap(), 123_456_789);
        assert_eq!(cents(1_234_567_890_000), "1,234.57");
        assert_eq!(group("12"), "12");
    }

    // Ported from the TypeScript units.test.ts (impulse-research: tests/http/).

    #[test]
    fn round_trips_scaled_decimals() {
        assert_eq!(lots_from_coins(2, d("1.25")).unwrap(), 125);
        assert_eq!(lots_from_coins(0, d("3")).unwrap(), 3);
        assert_eq!(lots_from_coins(2, d("1.234")).unwrap_err(), "\"1.234\" has more than 2 decimals");
        assert_eq!(fmt_scaled(125, 2), "1.25");
        assert_eq!(fmt_scaled(-5, 3), "-0.005");
    }

    #[test]
    fn converts_coins_to_lots_and_prices_per_coin_to_per_lot() {
        assert_eq!(lots_from_coins(5, d("0.01")).unwrap(), 1000);
        assert_eq!(coins_from_lots(5, 1000), "0.01");
        assert_eq!(lot_price(5, parse_fixed("80000").unwrap()), parse_fixed("0.8").unwrap());
    }

    #[test]
    fn picks_a_five_significant_figure_tick() {
        assert_eq!(auto_tick(parse_fixed("80711.5").unwrap(), 5), parse_fixed("1").unwrap());
        assert_eq!(auto_tick(parse_fixed("0.004397").unwrap(), 0), 100);
        assert_eq!(auto_tick(parse_fixed("0.000005").unwrap(), 0), 1);
    }

    #[test]
    fn reads_feed_floats_and_strings() {
        assert_eq!(nano_from_feed("0.7975").unwrap(), 797_500_000);
        assert_eq!(nano_from_f64(1.5).unwrap(), 1_500_000_000);
    }
}

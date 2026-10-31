// Exact decimals for commands: USD amounts, prices and coin sizes, parsed once at intake. Each serializes as the
// decimal string a person would write ("12.5", "all"), which is also what journals written before these types
// stored, so old journals read back the same.

use impulse_engine::fixed::{fmt, parse_fixed};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt as stdfmt;

/// An exact decimal with up to 9 places, held in nano units (USD, USD per coin, or coins).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Dec(i128);

impl Dec {
    pub fn parse(s: &str) -> Result<Dec, String> {
        parse_fixed(s).map(Dec)
    }

    pub fn from_nano(v: i128) -> Dec {
        Dec(v)
    }

    pub fn nano(self) -> i128 {
        self.0
    }
}

impl stdfmt::Display for Dec {
    fn fmt(&self, f: &mut stdfmt::Formatter<'_>) -> stdfmt::Result {
        f.write_str(&fmt(self.0, 0))
    }
}

/// A string or a JSON number, as text.
fn text<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    match serde_json::Value::deserialize(d)? {
        serde_json::Value::String(s) => Ok(s),
        serde_json::Value::Number(n) => Ok(n.to_string()),
        other => Err(D::Error::custom(format!("expected a decimal, got {other}"))),
    }
}

impl Serialize for Dec {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for Dec {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Dec, D::Error> {
        Dec::parse(&text(d)?).map_err(D::Error::custom)
    }
}

/// A wallet amount: an exact decimal, or everything available.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Amount {
    All,
    Exact(Dec),
}

impl Amount {
    pub fn parse(s: &str) -> Result<Amount, String> {
        if s == "all" {
            Ok(Amount::All)
        } else {
            Dec::parse(s).map(Amount::Exact)
        }
    }
}

impl stdfmt::Display for Amount {
    fn fmt(&self, f: &mut stdfmt::Formatter<'_>) -> stdfmt::Result {
        match self {
            Amount::All => f.write_str("all"),
            Amount::Exact(d) => d.fmt(f),
        }
    }
}

impl Serialize for Amount {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for Amount {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Amount, D::Error> {
        Amount::parse(&text(d)?).map_err(D::Error::custom)
    }
}

/// Spot tokens: a whole number, or every token held.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tokens {
    All,
    Exact(i128),
}

impl Tokens {
    pub fn parse(s: &str) -> Result<Tokens, String> {
        match s {
            "all" => Ok(Tokens::All),
            _ if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) => s
                .parse()
                .map(Tokens::Exact)
                .map_err(|_| "tokens out of range".into()),
            _ => Err("tokens must be a whole number or \"all\"".into()),
        }
    }
}

impl stdfmt::Display for Tokens {
    fn fmt(&self, f: &mut stdfmt::Formatter<'_>) -> stdfmt::Result {
        match self {
            Tokens::All => f.write_str("all"),
            Tokens::Exact(n) => write!(f, "{n}"),
        }
    }
}

impl Serialize for Tokens {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for Tokens {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Tokens, D::Error> {
        Tokens::parse(&text(d)?).map_err(D::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_as_the_strings_journals_already_hold() {
        for s in ["12.5", "0.000000001", "-50", "100"] {
            let d: Dec = serde_json::from_value(serde_json::json!(s)).unwrap();
            assert_eq!(serde_json::to_value(d).unwrap(), serde_json::json!(s));
        }
        assert_eq!(
            serde_json::from_value::<Dec>(serde_json::json!(2.5)).unwrap(),
            Dec::parse("2.5").unwrap()
        );
        assert_eq!(
            serde_json::from_value::<Amount>(serde_json::json!("all")).unwrap(),
            Amount::All
        );
        assert_eq!(
            serde_json::to_value(Tokens::Exact(42)).unwrap(),
            serde_json::json!("42")
        );
        assert!(serde_json::from_value::<Tokens>(serde_json::json!("1.5")).is_err());
        assert!(Dec::parse("1.0000000001").is_err());
    }
}

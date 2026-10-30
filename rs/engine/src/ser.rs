// Serde helpers. i128s go out as decimal strings (the TS side's bigints become strings too), and come back from
// either a string or a JSON integer. `Num` holds a number-or-string event field until the handler parses it,
// so a malformed field fails where the TS engine's BigInt()/parseFixed() would.

use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::BTreeMap;
use std::fmt;

struct I128Visitor;

impl<'de> Visitor<'de> for I128Visitor {
    type Value = i128;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("an integer or a decimal-integer string")
    }
    fn visit_str<E: de::Error>(self, v: &str) -> Result<i128, E> {
        v.trim().parse::<i128>().map_err(|_| E::custom(format!("bad integer \"{v}\"")))
    }
    fn visit_i64<E: de::Error>(self, v: i64) -> Result<i128, E> {
        Ok(v as i128)
    }
    fn visit_u64<E: de::Error>(self, v: u64) -> Result<i128, E> {
        Ok(v as i128)
    }
    fn visit_i128<E: de::Error>(self, v: i128) -> Result<i128, E> {
        Ok(v)
    }
    fn visit_u128<E: de::Error>(self, v: u128) -> Result<i128, E> {
        i128::try_from(v).map_err(E::custom)
    }
}

pub mod big {
    use super::*;
    pub fn serialize<S: Serializer>(v: &i128, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(v)
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<i128, D::Error> {
        d.deserialize_any(I128Visitor)
    }
}

pub mod big_opt {
    use super::*;
    pub fn serialize<S: Serializer>(v: &Option<i128>, s: S) -> Result<S::Ok, S::Error> {
        match v {
            Some(v) => s.collect_str(v),
            None => s.serialize_none(),
        }
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<i128>, D::Error> {
        #[derive(Deserialize)]
        struct W(#[serde(with = "big")] i128);
        Ok(Option::<W>::deserialize(d)?.map(|w| w.0))
    }
}

pub mod big_map {
    use super::*;
    pub fn serialize<S: Serializer>(v: &BTreeMap<String, i128>, s: S) -> Result<S::Ok, S::Error> {
        let m: BTreeMap<&String, String> = v.iter().map(|(k, v)| (k, v.to_string())).collect();
        m.serialize(s)
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<BTreeMap<String, i128>, D::Error> {
        #[derive(Deserialize)]
        struct W(#[serde(with = "big")] i128);
        Ok(BTreeMap::<String, W>::deserialize(d)?.into_iter().map(|(k, w)| (k, w.0)).collect())
    }
}

/// A JSON number or string, kept as text until a handler parses it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Num(pub String);

impl Num {
    pub fn is(&self, s: &str) -> bool {
        self.0 == s
    }
}

impl From<&str> for Num {
    fn from(s: &str) -> Self {
        Num(s.to_string())
    }
}

impl From<String> for Num {
    fn from(s: String) -> Self {
        Num(s)
    }
}

impl Serialize for Num {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for Num {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Num, D::Error> {
        match serde_json::Value::deserialize(d)? {
            serde_json::Value::String(s) => Ok(Num(s)),
            serde_json::Value::Number(n) => Ok(Num(n.to_string())),
            other => Err(de::Error::custom(format!("expected a number or string, got {other}"))),
        }
    }
}

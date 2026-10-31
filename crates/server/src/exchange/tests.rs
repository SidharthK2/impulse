// Determinism of the exchange: the same steps give the same hash, and every change bumps the version.

use super::*;

/// A small session: a market, two accounts, a resting order and a fill.
fn session(key: &str) -> Exchange {
    let mut x = Exchange::new(1_000_000);
    let spec = MarketSpec { price: Some("100".into()), sz_decimals: Some(2), ..MarketSpec::new("X", Kind::Perp, Source::Manual) };
    x.create_market(spec).unwrap();
    for (i, id) in ["alice", "bob"].into_iter().enumerate() {
        x.now += 1000;
        x.create_account(id, false, &format!("{key}{i}")).unwrap();
        x.deposit(id, "1000").unwrap();
    }
    x.now += 1000;
    x.place_order("bob", OrderInput::limit("X", Side::Sell, "100".into(), "5".into())).unwrap();
    x.place_order("alice", OrderInput::market("X", Side::Buy, "2".into())).unwrap();
    x
}

#[test]
fn the_same_steps_at_the_same_times_give_the_same_hash() {
    assert_eq!(session("k").state_hash(), session("k").state_hash());
}

#[test]
fn the_hash_covers_keys_time_books_and_history() {
    let base = session("k").state_hash();
    assert_ne!(session("other").state_hash(), base); // API keys
    let mut later = session("k");
    later.now += 1;
    assert_ne!(later.state_hash(), base); // the clock
    let mut cancelled = session("k");
    cancelled.cancel_all("bob", None).unwrap();
    assert_ne!(cancelled.state_hash(), base); // books and orders
    let mut noted = session("k");
    noted.record("X", RiskKind::Gap, vec![], "note".into(), None);
    assert_ne!(noted.state_hash(), base); // history
}

#[test]
fn every_change_bumps_the_version() {
    let mut x = session("k");
    for step in [
        (|x: &mut Exchange| x.candle("X", 1, 0, None)) as fn(&mut Exchange),
        |x| x.record("X", RiskKind::Gap, vec![], "note".into(), None),
        |x| {
            x.release_hold("X").unwrap();
        },
        |x| {
            x.cancel_all("bob", None).unwrap();
        },
    ] {
        let v = x.version;
        step(&mut x);
        assert!(x.version > v);
    }
}

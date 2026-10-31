// Determinism of the exchange: the same steps give the same hash, and every change bumps the version.

use super::*;

fn d(s: &str) -> Dec {
    Dec::parse(s).unwrap()
}

/// A small session: a market, two accounts, a resting order and a fill.
fn session(key: &str) -> Exchange {
    let mut x = Exchange::new(1_000_000);
    let spec = MarketSpec {
        price: Some(d("100")),
        sz_decimals: Some(2),
        ..MarketSpec::new("X", Kind::Perp, Source::Manual)
    };
    x.create_market(spec).unwrap();
    for (i, id) in ["alice", "bob"].into_iter().enumerate() {
        x.now += 1000;
        x.create_account(id, false, &format!("{key}{i}")).unwrap();
        x.deposit(id, d("1000")).unwrap();
    }
    x.now += 1000;
    x.place_order("bob", &OrderInput::limit("X", Side::Sell, d("100"), d("5")))
        .unwrap();
    x.place_order("alice", &OrderInput::market("X", Side::Buy, d("2")))
        .unwrap();
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

// ---------- trading fees ----------

#[test]
fn a_fill_charges_the_taker_and_maker_fees_and_records_them() {
    let x = session("k");
    // alice took 2 coins from bob at $100: $200 of notional at 0.045% taker and 0.015% maker.
    let f = x.fills.back().unwrap();
    assert_eq!((f.taker_fee, f.maker_fee), (90_000_000, 30_000_000));
    let m = &x.state.markets["X"];
    assert_eq!(m.positions["alice"].fees, 90_000_000);
    assert_eq!(m.positions["bob"].fees, 30_000_000);
    assert_eq!(x.state.fees, 120_000_000);
}

#[test]
fn the_fees_upgrade_gives_markets_listed_without_fees_the_default_fees_once() {
    let mut x = session("k");
    let c = &mut x.state.markets.get_mut("X").unwrap().config;
    (c.taker_fee_ppm, c.maker_fee_ppm) = (0, 0);
    x.upgrade("fees").unwrap();
    let c = &x.state.markets["X"].config;
    assert_eq!(
        (c.taker_fee_ppm, c.maker_fee_ppm),
        (TAKER_FEE_PPM, MAKER_FEE_PPM)
    );
    assert!(x.upgrades.contains("fees"));
    // Once applied, it's never applied again: a market set to no fees afterwards keeps them.
    let c = &mut x.state.markets.get_mut("X").unwrap().config;
    (c.taker_fee_ppm, c.maker_fee_ppm) = (0, 0);
    let v = x.version;
    x.upgrade("fees").unwrap();
    assert_eq!(x.version, v);
    assert_eq!(x.state.markets["X"].config.taker_fee_ppm, 0);
    assert!(x.upgrade("nonsense").is_err());
}

// ---------- margin held by resting orders ----------

#[test]
fn a_resting_order_holds_its_margin_back_from_the_wallet() {
    let mut x = session("k");
    x.create_account("carol", false, "carol-key").unwrap();
    x.deposit("carol", d("1000")).unwrap();
    let mut bid = OrderInput::limit("X", Side::Buy, d("99"), d("20"));
    bid.leverage = Some(3.0);
    x.place_order("carol", &bid).unwrap();
    // $1,980 at 3× is $660, plus the 0.015% maker fee ($0.297).
    assert_eq!(x.reserved("carol"), 660_297_000_000);
    assert_eq!(x.available("carol"), 339_703_000_000);

    let err = x
        .withdraw("carol", Amount::parse("400").unwrap())
        .unwrap_err();
    assert!(
        err.message().contains("held for open orders"),
        "{}",
        err.message()
    );
    assert!(x.place_order("carol", &bid).is_err()); // a second one doesn't fit
    x.withdraw("carol", Amount::All).unwrap(); // everything that's free
    assert_eq!(x.wallet("carol"), 660_297_000_000);

    x.cancel_all("carol", None).unwrap();
    assert_eq!(x.reserved("carol"), 0);
}

#[test]
fn an_order_holds_nothing_for_the_part_that_only_reduces_a_position() {
    let mut x = session("k"); // alice is long 2, bob short 2 with 3 more offered at 100
                              // bob's offer adds to his short: all 3 hold margin ($300 at 3×, plus the maker fee).
    assert_eq!(x.reserved("bob"), 100_045_000_000);
    let mut ask = OrderInput::limit("X", Side::Sell, d("110"), d("2"));
    ask.leverage = Some(3.0);
    x.place_order("alice", &ask).unwrap();
    assert_eq!(x.reserved("alice"), 0); // closes her long
    ask.size = d("1");
    x.place_order("alice", &ask).unwrap();
    // The first offer uses up the long; the second would open a short of 1: $110 at 3×, plus the fee.
    assert_eq!(x.reserved("alice"), 36_666_666_667 + 16_500_000);
}

// ---------- liquidation through the book ----------

/// A $100 perp in whole coins: alice long 30 at 3× from bob, and carol bidding `bids` (price, coins).
fn levered(bids: &[(&str, &str)]) -> Exchange {
    let mut x = Exchange::new(1_000_000);
    let spec = MarketSpec {
        price: Some(d("100")),
        ..MarketSpec::new("L", Kind::Perp, Source::Manual)
    };
    x.create_market(spec).unwrap();
    for (id, cash) in [("alice", "1100"), ("bob", "100000"), ("carol", "100000")] {
        x.create_account(id, false, &format!("{id}-key")).unwrap();
        x.deposit(id, d(cash)).unwrap();
    }
    x.place_order(
        "bob",
        &OrderInput::limit("L", Side::Sell, d("100"), d("30")),
    )
    .unwrap();
    let mut buy = OrderInput::market("L", Side::Buy, d("30"));
    buy.leverage = Some(3.0);
    x.place_order("alice", &buy).unwrap();
    for (price, size) in bids {
        x.place_order(
            "carol",
            &OrderInput::limit("L", Side::Buy, d(price), d(size)),
        )
        .unwrap();
    }
    x
}

fn tick(x: &mut Exchange, price: &str) -> Vec<Effect> {
    x.tick("L", d(price).nano(), true).unwrap().unwrap()
}

// alice's bucket holds the $1,000 she posted, so her equity at price P is 30P − 2,000 against 5P of maintenance:
// she's liquidated below $80, and bankrupt below $66.67.

#[test]
fn a_liquidation_goes_through_the_book_first_and_only_as_far_as_initial_margin() {
    let mut x = levered(&[("79", "10"), ("78", "20")]);
    tick(&mut x, "81");
    assert_eq!(x.size_of("L", "alice"), 30); // $430 of equity over $405 of maintenance: fine
                                             // At 79, equity $370 is under maintenance ($395). Keeping 13 needs $342.33 of initial margin, which what's left
                                             // covers after the 0.5% penalty on the 17 sold: 10 at 79, then 7 at 78.
    let effects = tick(&mut x, "79");
    assert_eq!(x.size_of("L", "alice"), 13);
    assert_eq!(x.size_of("L", "carol"), 17);
    let book: Vec<_> = effects
        .iter()
        .filter_map(|e| match e {
            Effect::BookLiquidation {
                closed,
                price,
                penalty,
                remaining,
                ..
            } => Some((*closed, *price, *penalty, *remaining)),
            _ => None,
        })
        .collect();
    assert_eq!(
        book,
        vec![
            (-10, 79 * B, 3_950_000_000, 20),
            (-7, 78 * B, 2_730_000_000, 13)
        ]
    );
    // No backstop: nothing closed at mark, nobody haircut.
    assert!(!effects.iter().any(|e| matches!(
        e,
        Effect::Liquidation { .. } | Effect::ForcedClose { .. } | Effect::Haircut { .. }
    )));
    let feed = x.risk.back().unwrap();
    assert_eq!(feed.kind, RiskKind::Liquidation);
    assert!(
        feed.text
            .starts_with("alice liquidated through the book: long 7 L sold at 78"),
        "{}",
        feed.text
    );
    assert!(apply(
        &x.state,
        &Event::Advance {
            seconds: "1".into()
        }
    )
    .is_ok());
}

#[test]
fn a_gap_past_bankruptcy_skips_the_book_and_goes_to_adl() {
    let mut x = levered(&[("79", "10"), ("78", "20")]);
    let effects = tick(&mut x, "60"); // equity 30 × 60 − 2,000 < 0
    assert!(effects.iter().any(|e| matches!(e, Effect::Bankrupt { .. })));
    assert!(effects.iter().any(|e| matches!(e, Effect::Haircut { .. })));
    assert!(!effects
        .iter()
        .any(|e| matches!(e, Effect::BookLiquidation { .. })));
    assert_eq!(x.size_of("L", "carol"), 0); // her bids were never hit
    assert_eq!(x.size_of("L", "alice"), 0);
}

#[test]
fn a_book_bid_only_below_the_bankruptcy_price_is_left_alone_and_the_backstop_closes_at_mark() {
    // A fill at 60, below alice's bankruptcy price of 66.67, would leave a shortfall.
    let mut x = levered(&[("60", "30")]);
    tick(&mut x, "81");
    let effects = tick(&mut x, "79");
    assert!(effects
        .iter()
        .any(|e| matches!(e, Effect::Liquidation { .. })));
    assert!(!effects
        .iter()
        .any(|e| matches!(e, Effect::BookLiquidation { .. })));
    assert_eq!(x.size_of("L", "carol"), 0);
    assert_eq!(x.size_of("L", "alice"), 0); // closed at mark against bob
}

// ---------- mirrored books ----------

const B: i128 = 1_000_000_000; // one coin, or $1, in nano

/// A Hyperliquid-sourced market at $100 with 0.5 ticks and lots of 0.01 coins, the bot maker, and alice.
fn mirrored_market() -> Exchange {
    let mut x = Exchange::new(1_000_000);
    let spec = MarketSpec {
        price: Some(d("100")),
        sz_decimals: Some(2),
        tick: Some(d("0.5")),
        ..MarketSpec::new(
            "BTC",
            Kind::Perp,
            Source::Hyperliquid {
                coin: "BTC".into(),
                dex: None,
            },
        )
    };
    x.create_market(spec).unwrap();
    x.create_account(crate::bots::MM, true, "mm-key").unwrap();
    x.deposit(crate::bots::MM, d("1000000")).unwrap();
    x.create_account("alice", false, "alice-key").unwrap();
    x.deposit("alice", d("10000")).unwrap();
    x
}

fn depth(bids: &[(i128, i128)], asks: &[(i128, i128)]) -> DepthBook {
    let levels = |v: &[(i128, i128)]| {
        v.iter()
            .map(|&(p, s)| Level(Dec::from_nano(p), Dec::from_nano(s)))
            .collect()
    };
    DepthBook {
        market: "BTC".into(),
        bids: levels(bids),
        asks: levels(asks),
    }
}

/// (coin price, coins) per resting order on one side, best first, both nano.
fn quotes(x: &Exchange, side: Side) -> Vec<(i128, i128)> {
    x.books["BTC"]
        .side(side)
        .iter()
        .map(|o| (coin_price(2, o.price), o.size * B / 100))
        .collect()
}

#[test]
fn a_mirror_posts_the_venues_levels_snapped_to_the_tick_and_moves_the_mark_to_its_mid() {
    let mut x = mirrored_market();
    x.mirror(&depth(
        &[(99_700_000_000, 3 * B), (99_400_000_000, 2 * B + 5_000_000)],
        &[(100_200_000_000, B), (100_500_000_000, 4 * B)],
    ))
    .unwrap();
    // Bids snap down and asks up to the 0.5 tick; 2.005 coins is 200 whole lots; same-price levels merge.
    assert_eq!(
        quotes(&x, Side::Buy),
        vec![(99_500_000_000, 3 * B), (99_000_000_000, 2 * B)]
    );
    assert_eq!(quotes(&x, Side::Sell), vec![(100_500_000_000, 5 * B)]);
    assert_eq!(x.mark_coin("BTC"), Some(99_950_000_000)); // (99.7 + 100.2) / 2
    assert!(x.mirroring("BTC"));

    // The ladder stands aside while the mirror is fresh, and takes over once it's stale.
    let before = quotes(&x, Side::Buy);
    crate::bots::quote(&mut x, "BTC");
    assert_eq!(quotes(&x, Side::Buy), before);
    x.now += super::mirror::MIRROR_FRESH_MS;
    assert!(!x.mirroring("BTC"));
    crate::bots::quote(&mut x, "BTC");
    assert_ne!(quotes(&x, Side::Buy), before);
}

#[test]
fn when_the_venue_trades_through_a_resting_order_it_fills_at_its_own_price() {
    let mut x = mirrored_market();
    x.mirror(&depth(&[(99_500_000_000, 3 * B)], &[(100_500_000_000, B)]))
        .unwrap();
    let r = x
        .place_order(
            "alice",
            &OrderInput::limit("BTC", Side::Sell, d("101"), d("1")),
        )
        .unwrap();
    assert_eq!(r.status, OrderStatus::Resting);
    // The real market moves up through alice's ask.
    x.mirror(&depth(&[(101_500_000_000, 3 * B)], &[(102_000_000_000, B)]))
        .unwrap();
    let f = x.fills.back().unwrap();
    assert_eq!(
        (f.maker.as_str(), f.taker.as_str()),
        ("alice", crate::bots::MM)
    );
    assert_eq!(coin_price(2, f.price), 101 * B);
    assert_eq!(x.size_of("BTC", "alice"), -100);
    // The rest of the maker's bid rests behind the fill.
    assert_eq!(quotes(&x, Side::Buy), vec![(101_500_000_000, 2 * B)]);
}

#[test]
fn an_admin_hold_pauses_the_mirror() {
    let mut x = mirrored_market();
    x.mirror(&depth(&[(99_500_000_000, 3 * B)], &[(100_500_000_000, B)]))
        .unwrap();
    x.admin_price("BTC", d("80"), 60.0).unwrap();
    assert!(!x.mirroring("BTC"));
    let bids = quotes(&x, Side::Buy);
    x.mirror(&depth(&[(99_000_000_000, 7 * B)], &[(99_500_000_000, B)]))
        .unwrap();
    assert_eq!(quotes(&x, Side::Buy), bids); // not reposted
    assert_eq!(x.mark_coin("BTC"), Some(80 * B)); // and the feed's mid ignored
}

#[test]
fn a_crossed_or_one_sided_book_is_refused() {
    let mut x = mirrored_market();
    assert!(x.mirror(&depth(&[(101 * B, B)], &[(100 * B, B)])).is_err());
    assert!(x.mirror(&depth(&[(100 * B, B)], &[])).is_err());
}

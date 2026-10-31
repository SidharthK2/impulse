// Engine behaviour, ported from the TypeScript engine.test.ts (impulse-research: tests/engine/): the scenarios' exact numbers,
// ADL policies, graduation, taper, funding, market and trade validation, rounding, curves, launches and the funding
// premium. Events are written as JSON, as the scenarios are.

use impulse_engine::fixed::parse_fixed;
use impulse_engine::{apply, check_invariants, equity, initial_state, maintenance_margin, releasable, ApplyError, Effect, Event, Launch, Position, State, Status};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const M: &str = "X";

fn usd(s: &str) -> i128 {
    parse_fixed(s).unwrap()
}

fn ev(v: Value) -> Event {
    serde_json::from_value(v.clone()).unwrap_or_else(|e| panic!("bad event {v}: {e}"))
}

fn binary(id: &str) -> Event {
    ev(json!({ "type": "market", "id": id, "preset": "binary" }))
}

fn perp(id: &str) -> Event {
    ev(json!({ "type": "market", "id": id, "preset": "perp" }))
}

/// Deposit and allocate everything to one market.
fn fund(account: &str, amount: &str, market: &str) -> Vec<Event> {
    vec![
        ev(json!({ "type": "deposit", "account": account, "amount": amount })),
        ev(json!({ "type": "allocate", "account": account, "market": market, "amount": amount })),
    ]
}

#[allow(non_snake_case)]
fn T(buyer: &str, seller: &str, size: i64, price: &str, market: &str) -> Event {
    ev(json!({ "type": "trade", "market": market, "buyer": buyer, "seller": seller, "size": size, "price": price }))
}

#[allow(non_snake_case)]
fn K(price: &str, market: &str) -> Event {
    ev(json!({ "type": "tick", "market": market, "price": price }))
}

#[allow(non_snake_case)]
fn R(price: &str, market: &str) -> Event {
    ev(json!({ "type": "resolve", "market": market, "price": price }))
}

#[allow(non_snake_case)]
fn REL(account: &str, amount: &str, market: &str) -> Event {
    ev(json!({ "type": "release", "account": account, "market": market, "amount": amount }))
}

fn advance(seconds: i64) -> Event {
    ev(json!({ "type": "advance", "seconds": seconds }))
}

fn deposit(account: &str, amount: &str) -> Event {
    ev(json!({ "type": "deposit", "account": account, "amount": amount }))
}

/// Ok(effects) or Err(rejection reason); a fatal engine error fails the test.
type Res = Result<Vec<Effect>, String>;

fn step(state: &State, e: &Event) -> (State, Res) {
    match apply(state, e) {
        Ok((s, fx)) => (s, Ok(fx)),
        Err(ApplyError::Rejected(r)) => (state.clone(), Err(r)),
        Err(ApplyError::Fatal(m)) => panic!("engine failed on {e:?}: {m}"),
    }
}

fn run(events: &[Event]) -> (State, Vec<Res>) {
    let mut state = initial_state();
    let mut results = vec![];
    for e in events {
        let (s, r) = step(&state, e);
        state = s;
        results.push(r);
    }
    (state, results)
}

fn concat(parts: Vec<Vec<Event>>) -> Vec<Event> {
    parts.into_iter().flatten().collect()
}

struct Step {
    event: Event,
    before: State,
    result: Res,
    after: State,
}

fn replay(events: &[Event]) -> (Vec<Step>, State) {
    let mut state = initial_state();
    let mut steps = vec![];
    for e in events {
        let (s, r) = step(&state, e);
        steps.push(Step { event: e.clone(), before: state, result: r, after: s.clone() });
        state = s;
    }
    (steps, state)
}

fn scenario(name: &str) -> Vec<Event> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(format!("{}/../../tests/scenarios/{name}.json", env!("CARGO_MANIFEST_DIR"))).unwrap()).unwrap();
    v["events"].as_array().unwrap().iter().map(|e| ev(e.clone())).collect()
}

fn effects(r: &Res) -> &[Effect] {
    r.as_deref().unwrap_or(&[])
}

fn all_effects(steps: &[Step]) -> Vec<Effect> {
    steps.iter().flat_map(|s| effects(&s.result).to_vec()).collect()
}

fn is_tick(e: &Event, market: Option<&str>, price: &str) -> bool {
    matches!(e, Event::Tick { market: m, price: p } if p.0 == price && market.is_none_or(|want| want == m))
}

fn find(steps: &[Step], pred: impl Fn(&Event) -> bool) -> &Step {
    steps.iter().find(|s| pred(&s.event)).expect("step not found")
}

fn pos<'a>(s: &'a State, account: &str, market: &str) -> &'a Position {
    &s.markets[market].positions[account]
}

fn bankrupt(market: &str, account: &str, size: i128, shortfall: i128) -> Effect {
    Effect::Bankrupt { market: market.into(), account: account.into(), size, shortfall }
}

fn haircut(market: &str, account: &str, amount: i128, from_principal: i128) -> Effect {
    Effect::Haircut { market: market.into(), account: account.into(), amount, from_principal }
}

fn haircuts(fx: &[Effect]) -> Vec<(String, i128, i128)> {
    fx.iter()
        .filter_map(|e| match e {
            Effect::Haircut { account, amount, from_principal, .. } => Some((account.clone(), *amount, *from_principal)),
            _ => None,
        })
        .collect()
}

fn ok(r: &Res) -> bool {
    r.is_ok()
}

// ---------- scenario A: binary gap 0.60 → 0.05, resolve 0 ----------

fn scenario_a() -> (Vec<Step>, State, usize) {
    let (steps, final_state) = replay(&scenario("gap-down-resolve-0"));
    let gap = steps.iter().position(|s| is_tick(&s.event, None, "0.05")).unwrap();
    (steps, final_state, gap)
}

#[test]
fn scenario_a_bankrupts_the_levered_longs_with_exact_shortfalls() {
    let (steps, _, gap) = scenario_a();
    let got: Vec<_> = effects(&steps[gap].result)
        .iter()
        .filter_map(|e| match e {
            Effect::Bankrupt { account, size, shortfall, .. } => Some((account.as_str(), *size, *shortfall)),
            _ => None,
        })
        .collect();
    assert_eq!(got, [("alice", 600, usd("178")), ("bob", 500, usd("107"))]);
}

#[test]
fn scenario_a_charges_shorts_pro_rata_by_size_summing_exactly_to_the_shortfall() {
    let (steps, _, gap) = scenario_a();
    let h: Vec<(String, i128)> = haircuts(effects(&steps[gap].result)).into_iter().map(|(a, amt, _)| (a, amt)).collect();
    assert_eq!(h, [("carol".to_string(), 153_461_538_462), ("dave".to_string(), 87_692_307_692), ("erin".to_string(), 43_846_153_846)]);
    assert_eq!(h.iter().map(|(_, x)| x).sum::<i128>(), usd("285"));
}

#[test]
fn scenario_a_force_reduces_shorts_by_the_closed_long_size_and_leaves_the_solvent_long_untouched() {
    let (steps, _, gap) = scenario_a();
    let s = &steps[gap].after;
    let m = "OUTCOME";
    assert_eq!([pos(s, "alice", m).size, pos(s, "bob", m).size], [0, 0]);
    assert_eq!([pos(s, "carol", m).size, pos(s, "dave", m).size, pos(s, "erin", m).size], [-108, -61, -31]);
    assert_eq!(pos(s, "frank", m).size, 200);
    assert_eq!(equity(pos(s, "alice", m), s.markets[m].mark), 0);
}

#[test]
fn scenario_a_rejects_releases_from_the_bankrupt_account_and_over_releases() {
    let (steps, _, _) = scenario_a();
    let rejected: Vec<&Event> = steps.iter().filter(|s| s.result.is_err()).map(|s| &s.event).collect();
    for e in [REL("alice", "1", "OUTCOME"), REL("carol", "1000", "OUTCOME"), REL("bob", "100", "OUTCOME")] {
        assert!(rejected.contains(&&e), "{e:?} not rejected");
    }
}

#[test]
fn scenario_a_drains_every_wallet_and_vault_to_exactly_zero() {
    let (_, f, _) = scenario_a();
    assert_eq!(f.markets["OUTCOME"].status, Status::Resolved);
    assert_eq!(f.markets["OUTCOME"].vault, 0);
    assert_eq!(f.total_deposits - f.total_withdrawals, 0);
}

#[test]
fn scenario_a_is_deterministic() {
    let events = scenario("gap-down-resolve-0");
    assert_eq!(replay(&events).1, replay(&events).1);
}

// ---------- scenario B: levered short resolves to 1 ----------

#[test]
fn scenario_b_bankrupts_gina_and_charges_both_longs_pro_rata() {
    let (steps, _) = replay(&scenario("gap-down-resolve-1"));
    let fx = effects(&find(&steps, |e| matches!(e, Event::Resolve { .. })).result);
    assert!(fx.contains(&bankrupt("OUTCOME", "gina", -300, usd("275.5"))));
    // Size pro-rata charges frank $110.20 against a profit of only $90: $20.20 comes out of his principal.
    assert!(fx.contains(&haircut("OUTCOME", "frank", usd("110.2"), usd("20.2"))));
    assert!(fx.contains(&haircut("OUTCOME", "hank", usd("165.3"), 0)));
}

#[test]
fn scenario_b_caps_hanks_payout_at_what_gina_actually_posted() {
    let (_, f) = replay(&scenario("gap-down-resolve-1"));
    // Theoretical PnL 300 × (1 − 0.06) = 282; received 282 − 165.30 = 116.70.
    let p = pos(&f, "hank", "OUTCOME");
    assert_eq!(p.realized + p.adl_transfer, usd("116.7"));
    assert_eq!(f.total_deposits - f.total_withdrawals, 0);
}

// ---------- scenario C: binary gap up with liquidation and ADL ----------

#[test]
fn scenario_c_liquidates_pia_at_mark_and_lets_them_keep_the_residual() {
    let (steps, _) = replay(&scenario("gap-up-resolve-0"));
    let gap = find(&steps, |e| is_tick(e, None, "0.95"));
    let liq = effects(&gap.result).iter().find(|e| matches!(e, Effect::Liquidation { .. })).unwrap();
    assert!(matches!(liq, Effect::Liquidation { account, equity, .. } if account == "pia" && *equity == usd("2.5")));
    assert_eq!(pos(&gap.after, "pia", "OUTCOME").collateral, usd("2.5"));
    assert_eq!(pos(&gap.after, "pia", "OUTCOME").adl_transfer, 0);
}

#[test]
fn scenario_c_leaves_the_near_fully_collateralized_short_untouched() {
    let (steps, _) = replay(&scenario("gap-up-resolve-0"));
    assert_eq!(pos(&find(&steps, |e| is_tick(e, None, "0.95")).after, "quinn", "OUTCOME").size, -100);
}

// ---------- scenario D: unbounded memecoin squeeze ----------

#[test]
fn scenario_d_bankrupts_a_half_x_short_no_collateral_ratio_is_safe_on_an_unbounded_asset() {
    let (steps, _) = replay(&scenario("memecoin-squeeze"));
    assert!(effects(&find(&steps, |e| is_tick(e, None, "0.00004")).result).contains(&bankrupt("PEPE", "dan", -10_000_000, usd("100"))));
}

#[test]
fn scenario_d_charges_the_longs_pro_rata_and_drains_to_zero() {
    let (steps, f) = replay(&scenario("memecoin-squeeze"));
    let fx = effects(&find(&steps, |e| is_tick(e, None, "0.00004")).result);
    assert!(fx.contains(&haircut("PEPE", "ana", usd("75"), 0)));
    assert!(fx.contains(&haircut("PEPE", "eve", usd("25"), 0)));
    assert_eq!(f.total_deposits - f.total_withdrawals, 0);
}

// ---------- scenario E: isolation across markets ----------

#[test]
fn scenario_e_bankrupts_alice_in_election() {
    let (steps, _) = replay(&scenario("isolation-two-markets"));
    let blowup = find(&steps, |e| is_tick(e, Some("ELECTION"), "0.02"));
    assert!(effects(&blowup.result).iter().any(|e| matches!(e, Effect::Bankrupt { account, .. } if account == "alice")));
}

#[test]
fn scenario_e_leaves_btcx_byte_for_byte_identical() {
    let (steps, _) = replay(&scenario("isolation-two-markets"));
    let blowup = find(&steps, |e| is_tick(e, Some("ELECTION"), "0.02"));
    assert_eq!(blowup.after.markets["BTCX"], blowup.before.markets["BTCX"]);
}

// ---------- ADL policies ----------

fn with_policy(events: &[Event], adl: &str) -> Vec<Event> {
    events
        .iter()
        .cloned()
        .map(|e| match e {
            Event::Market(mut m) => {
                m.adl = Some(adl.into());
                Event::Market(m)
            }
            other => other,
        })
        .collect()
}

fn haircuts_at(events: &[Event], adl: &str) -> Vec<(String, i128, i128)> {
    haircuts(&all_effects(&replay(&with_policy(events, adl)).0))
}

#[test]
fn adl_pnl_rule_protects_franks_principal_in_scenario_b_and_charges_the_bigger_winner_more() {
    let res: Vec<_> = haircuts_at(&scenario("gap-down-resolve-1"), "pnl").into_iter().filter(|(a, _, _)| a == "frank" || a == "hank").collect();
    // Shortfall $275.50 split over positive PnL (frank $90, hank $282): no principal touched.
    assert!(res.iter().all(|(_, _, p)| *p == 0));
    assert_eq!(res.iter().map(|(_, h, _)| h).sum::<i128>(), usd("275.5"));
    let frank = res.iter().find(|(a, _, _)| a == "frank").unwrap().1;
    assert!(frank < usd("90"));
}

#[test]
fn adl_scenario_g_when_profits_cant_cover_the_shortfall_both_rules_must_touch_principal() {
    let size = haircuts_at(&scenario("principal-fallback"), "size");
    let pnl = haircuts_at(&scenario("principal-fallback"), "pnl");
    let principal = |h: &[(String, i128, i128)]| h.iter().map(|(_, _, p)| p).sum::<i128>();
    assert_eq!(principal(&size), usd("333.333333333"));
    assert_eq!(principal(&pnl), usd("230")); // $500 shortfall − $270 total positive PnL
    assert_eq!(pnl.iter().find(|(a, _, _)| a == "s2").unwrap().1, usd("270") + usd("51.685393258"));
}

#[test]
fn adl_rejects_unknown_policies() {
    assert!(!ok(&run(&[ev(json!({ "type": "market", "id": "Y", "adl": "queue" }))]).1[0]));
}

// ---------- leverage graduation ----------

#[test]
fn graduation_graduates_on_volume_and_depth_and_never_goes_back_down() {
    let (steps, f) = replay(&scenario("graduation-blowup"));
    let tiers: Vec<usize> = all_effects(&steps)
        .iter()
        .filter_map(|e| match e {
            Effect::Graduation { tier, .. } => Some(*tier),
            _ => None,
        })
        .collect();
    assert_eq!(tiers, [1, 2]);
    assert_eq!(f.markets["HYPE"].tier, 2); // whales left, depth collapsed, leverage stays 10x
}

#[test]
fn graduation_a_20pct_gap_bankrupts_a_9x_long_that_tier_0_would_never_have_allowed() {
    let (steps, _) = replay(&scenario("graduation-blowup"));
    assert!(effects(&find(&steps, |e| is_tick(e, None, "0.80")).result).contains(&bankrupt("HYPE", "carl", 9000, usd("800"))));
    let (_, at_launch) = run(&concat(vec![vec![perp(M)], fund("carl", "1000", M), fund("dina", "2000", M), vec![K("1", M), T("carl", "dina", 9000, "1", M)]]));
    assert!(!ok(at_launch.last().unwrap())); // 9x is over the 3x launch limit
}

// ---------- pre-resolution taper ----------

fn taper() -> Event {
    ev(json!({ "type": "market", "id": M, "preset": "binary", "resolvesAt": 1000, "taperSeconds": 500, "funding": false }))
}

#[test]
fn taper_rejects_resolution_before_the_scheduled_time_and_taper_on_non_resolvable_markets() {
    assert!(!ok(run(&[taper(), K("0.5", M), R("1", M)]).1.last().unwrap()));
    assert!(ok(run(&[taper(), K("0.5", M), advance(1000), R("1", M)]).1.last().unwrap()));
    assert!(!ok(&run(&[ev(json!({ "type": "market", "id": M, "preset": "perp", "resolvesAt": 10, "taperSeconds": 5 }))]).1[0]));
}

#[test]
fn taper_ramps_maintenance_margin_up_to_the_full_max_loss_at_resolution() {
    let base = concat(vec![vec![taper()], fund("l", "1000", M), fund("s", "1000", M), vec![K("0.06", M), T("l", "s", 300, "0.06", M)]]);
    let short_mm = |extra: Vec<Event>| {
        let (s, _) = run(&concat(vec![base.clone(), extra]));
        let m = &s.markets[M];
        maintenance_margin(m, &m.positions["s"])
    };
    assert_eq!(short_mm(vec![]), usd("3")); // normal: 300 × 0.06 / 6
    assert_eq!(short_mm(vec![advance(750)]), usd("142.5")); // halfway through the taper: 3 + (282 − 3) / 2
    assert_eq!(short_mm(vec![advance(1000)]), usd("282")); // at resolvesAt: the full max loss, 300 × (1 − 0.06)
    let (thin, _) = run(&concat(vec![vec![taper()], fund("l", "1000", M), fund("s", "10", M), vec![K("0.06", M), T("l", "s", 300, "0.06", M), advance(1000)]]));
    assert_eq!(thin.markets[M].positions["s"].size, 0); // couldn't keep up: liquidated during the taper
}

#[test]
fn taper_scenario_i_no_adl_anywhere_the_topped_up_short_pays_the_long_in_full() {
    let (steps, f) = replay(&scenario("resolution-taper"));
    let fx = all_effects(&steps);
    assert!(!fx.iter().any(|e| matches!(e, Effect::Haircut { .. } | Effect::Bankrupt { .. })));
    let liq = fx.iter().find(|e| matches!(e, Effect::Liquidation { .. })).unwrap();
    assert!(matches!(liq, Effect::Liquidation { market, account, .. } if market == "NOTOPUP" && account == "gina"));
    assert_eq!(f.markets["TOPUP"].positions["hal"].realized, usd("282")); // 300 × (1 − 0.06), no haircut
}

// ---------- funding ----------

fn funding_effect(r: &Res) -> Option<&Effect> {
    effects(r).iter().find(|e| matches!(e, Effect::Funding { .. }))
}

#[test]
fn funding_is_an_exact_transfer_base_rate_plus_premium_held_while_the_market_is_inactive() {
    let (state, results) = run(&concat(vec![vec![perp(M)], fund("a", "400", M), fund("b", "400", M), vec![K("1", M), T("a", "b", 1000, "1.02", M), advance(3600)]]));
    let f = funding_effect(results.last().unwrap()).unwrap();
    // 0.05% + (2% / 8) per hour on $1,000
    assert!(matches!(f, Effect::Funding { rate, payers, total, .. } if *rate == 500_000 + 2_500_000 && payers == "long" && *total == usd("3")));
    let m = &state.markets[M];
    assert_eq!(m.positions["a"].funding, -usd("3"));
    assert_eq!(m.positions["b"].funding, usd("3"));
}

#[test]
fn funding_negative_premium_flips_the_payer_once_it_outweighs_the_base_rate() {
    let (_, results) = run(&concat(vec![vec![perp(M)], fund("a", "400", M), fund("b", "400", M), vec![K("1", M), T("a", "b", 100, "0.95", M), advance(3600)]]));
    assert!(matches!(funding_effect(results.last().unwrap()), Some(Effect::Funding { payers, .. }) if payers == "short"));
}

#[test]
fn funding_can_be_switched_off_per_market() {
    let market = ev(json!({ "type": "market", "id": M, "preset": "perp", "funding": false }));
    let (_, results) = run(&concat(vec![vec![market], fund("a", "400", M), fund("b", "400", M), vec![K("1", M), T("a", "b", 1000, "1", M), advance(3600)]]));
    assert!(funding_effect(results.last().unwrap()).is_none());
}

#[test]
fn funding_scenario_j_launch_funding_liquidates_a_long_on_day_3_with_no_trading() {
    let (steps, _) = replay(&scenario("funding-drain"));
    let advances: Vec<&Step> = steps.iter().filter(|s| matches!(s.event, Event::Advance { .. })).collect();
    let first = advances.iter().position(|s| effects(&s.result).iter().any(|e| matches!(e, Effect::Liquidation { .. })));
    assert_eq!(first, Some(2));
}

// ---------- markets ----------

#[test]
fn markets_reject_duplicate_markets_bad_bounds_and_bad_leverage() {
    assert!(!ok(&run(&[binary(M), binary(M)]).1[1]));
    assert!(!ok(&run(&[ev(json!({ "type": "market", "id": "Y", "bounds": ["1", "0.5"] }))]).1[0]));
    assert!(!ok(&run(&[ev(json!({ "type": "market", "id": "Y", "initialLeverage": 10, "maintenanceLeverage": 5 }))]).1[0]));
}

#[test]
fn markets_enforce_price_bounds_per_market_type() {
    assert!(!ok(&run(&[binary(M), K("1.01", M)]).1[1]));
    assert!(ok(&run(&[perp(M), K("1.01", M)]).1[1]));
    assert!(!ok(&run(&[perp(M), K("0", M)]).1[1]));
    assert!(ok(&run(&[binary(M), K("0", M)]).1[1]));
}

#[test]
fn markets_only_resolve_resolvable_markets() {
    assert!(!ok(&run(&[perp(M), K("10", M), R("12", M)]).1[2]));
    assert!(ok(&run(&[ev(json!({ "type": "market", "id": M, "preset": "perp", "resolvable": true })), K("10", M), R("12", M)]).1[2]));
}

#[test]
fn markets_support_sub_micro_prices_exactly() {
    let (state, _) = run(&concat(vec![vec![perp(M)], fund("a", "10", M), fund("b", "10", M), vec![K("0.000000005", M), T("a", "b", 1_000_000_000, "0.000000005", M)]]));
    assert_eq!(pos(&state, "a", M).basis, usd("5"));
}

// ---------- trade validation ----------

fn trade_base() -> Vec<Event> {
    concat(vec![vec![binary(M)], fund("a", "10", M), fund("b", "100", M)])
}

fn last(extra: Vec<Event>) -> Res {
    run(&concat(vec![trade_base(), extra])).1.pop().unwrap()
}

#[test]
fn trades_need_an_oracle_price_first() {
    assert_eq!(last(vec![T("a", "b", 10, "0.5", M)]), Err("X has no oracle price yet".into()));
}

#[test]
fn trades_need_collateral_in_that_market() {
    assert!(!ok(&last(vec![perp("Y"), K("5", "Y"), T("a", "b", 1, "5", "Y")])));
}

#[test]
fn trades_enforce_initial_margin_at_mark_for_both_sides() {
    assert!(ok(&last(vec![K("0.5", M), T("a", "b", 60, "0.5", M)])));
    assert!(!ok(&last(vec![K("0.5", M), T("a", "b", 61, "0.5", M)])));
}

#[test]
fn trades_value_off_mark_trades_at_mark_so_a_bad_price_cant_sneak_in_insolvency() {
    assert!(!ok(&last(vec![K("0.5", M), T("a", "b", 30, "0.9", M)])));
}

#[test]
fn trades_reject_self_trades_and_trades_after_resolution() {
    assert!(!ok(&last(vec![K("0.5", M), T("a", "a", 1, "0.5", M)])));
    assert!(!ok(&last(vec![K("0.5", M), R("1", M), T("a", "b", 1, "0.5", M)])));
}

#[test]
fn trades_let_a_position_reduce_while_between_mm_and_im() {
    assert!(ok(&last(concat(vec![fund("c", "100", M), vec![K("0.5", M), T("a", "b", 60, "0.5", M), K("0.45", M), T("c", "a", 30, "0.45", M)]]))));
}

// ---------- wallet and release ----------

#[test]
fn release_frees_realized_collateral_only_never_unrealized_profit() {
    let (state, results) = run(&concat(vec![vec![binary(M)], fund("a", "100", M), fund("b", "100", M), vec![K("0.5", M), T("a", "b", 100, "0.5", M), K("0.9", M), REL("a", "101", M)]]));
    let m = &state.markets[M];
    assert_eq!(equity(pos(&state, "a", M), m.mark), usd("140"));
    assert!(!ok(results.last().unwrap())); // equity − IM = 110, but collateral is 100
    assert_eq!(releasable(m, pos(&state, "a", M)), usd("100"));
}

#[test]
fn wallet_cannot_allocate_or_withdraw_more_than_it_holds() {
    let alloc = ev(json!({ "type": "allocate", "account": "a", "market": M, "amount": "6" }));
    assert!(!ok(run(&[binary(M), deposit("a", "5"), alloc]).1.last().unwrap()));
    let withdraw = ev(json!({ "type": "withdraw", "account": "a", "amount": "1" }));
    assert!(!ok(run(&concat(vec![vec![binary(M)], fund("a", "5", M), vec![withdraw]])).1.last().unwrap()));
}

// ---------- rounding ----------

#[test]
fn rounding_allocates_an_indivisible_shortfall_exactly_across_equal_absorbers() {
    let (state, results) = run(&concat(vec![
        vec![binary(M)],
        fund("L", "10.000000001", M),
        fund("s1", "50", M),
        fund("s2", "50", M),
        fund("s3", "50", M),
        vec![K("0.5", M), T("L", "s1", 20, "0.5", M), T("L", "s2", 20, "0.5", M), T("L", "s3", 20, "0.5", M), K("0", M)],
    ]));
    let amounts: Vec<i128> = haircuts(effects(results.last().unwrap())).into_iter().map(|(_, a, _)| a).collect();
    assert_eq!(amounts.iter().sum::<i128>(), usd("19.999999999"));
    assert_eq!(amounts, [6_666_666_667, 6_666_666_666, 6_666_666_666]);
    assert!(check_invariants(&state).is_empty());
}

// ---------- why clamping is not solvency ----------

#[test]
fn clamping_a_bankrupt_position_to_zero_creates_claims_the_vault_cant_pay() {
    let events = scenario("gap-down-resolve-0");
    let gap = events.iter().position(|e| is_tick(e, None, "0.05")).unwrap();
    let (s, _) = run(&events[..gap]);
    let mut m = s.markets["OUTCOME"].clone();
    m.mark = Some(usd("0.05")); // raw price update, no risk processing
    let claims: i128 = m.positions.values().map(|p| equity(p, m.mark).max(0)).sum();
    assert_eq!(claims - m.vault, usd("285"));
}

// ---------- curve-priced markets (Mirror attention design) ----------

fn attn(extra: Value) -> Event {
    let mut v = json!({ "type": "market", "id": "A", "preset": "attention", "feeBps": 0 });
    v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    ev(v)
}

fn buy(account: &str, amount: &str) -> Event {
    ev(json!({ "type": "spotBuy", "account": account, "market": "A", "amount": amount }))
}

#[test]
fn curve_reproduces_mirrors_published_curve_prices() {
    // Mirror docs: $10k demand → $0.0000450, $20k → $0.0001250, $100k → $0.0022050 (we round 1 nano in the curve's favour).
    for (demand, price) in [("10000", "0.000045"), ("20000", "0.000125"), ("100000", "0.002205")] {
        let (state, _) = run(&[attn(json!({})), deposit("x", demand), buy("x", "all")]);
        assert!(usd(price) - state.markets["A"].mark.unwrap() <= 1, "{demand}");
    }
}

#[test]
fn curve_rejects_external_ticks_on_curve_markets() {
    assert!(!ok(&run(&[attn(json!({})), K("1", "A")]).1[1]));
}

#[test]
fn curve_a_buy_then_sell_round_trip_returns_the_usdc_minus_fees() {
    let sell = ev(json!({ "type": "spotSell", "account": "x", "market": "A", "tokens": "all" }));
    let (state, _) = run(&[attn(json!({ "feeBps": 100 })), deposit("x", "1000"), buy("x", "all"), sell]);
    let back = state.accounts["x"].wallet;
    assert!(back < usd("1000"));
    assert!(back > usd("979")); // two 1% fees, plus rounding in the curve's favour
}

#[test]
fn curve_a_twap_oracle_ignores_a_pump_until_time_passes() {
    let (state, results) = run(&[attn(json!({ "oracleWindow": 600 })), deposit("x", "5000"), buy("x", "all")]);
    assert_eq!(state.markets["A"].mark, Some(usd("0.000005"))); // spot moved, mark did not
    assert!(!effects(results.last().unwrap()).iter().any(|e| matches!(e, Effect::Mark { .. })));
    let (later, _) = apply(&state, &advance(300)).unwrap();
    assert!(later.markets["A"].mark.unwrap() > usd("0.000005"));
}

#[test]
fn curve_scenario_f_an_instant_oracle_pump_bankrupts_the_shorts_inside_the_pump_transaction() {
    let (steps, f) = replay(&scenario("attention-pump"));
    let pump = find(&steps, |e| matches!(e, Event::SpotBuy { account, .. } if account == "mallory"));
    let bust: Vec<&str> = effects(&pump.result)
        .iter()
        .filter_map(|e| match e {
            Effect::Bankrupt { account, .. } => Some(account.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(bust, ["v1", "v2"]);
    let mallory = &f.accounts["mallory"];
    assert_eq!(mallory.withdrawn - mallory.deposited, usd("1900.499932236")); // $2,000 of victim collateral − $99.50 fees
}

// ---------- creator-coin launch ----------

const C: &str = "COIN";

fn launch(fee_bps: i64) -> Event {
    ev(json!({ "type": "market", "id": C, "preset": "attention", "launch": true, "feeBps": fee_bps, "oracleWindow": 600 }))
}

fn snipe(account: &str, amount: &str) -> Event {
    ev(json!({ "type": "snipe", "account": account, "market": C, "amount": amount }))
}

fn open() -> Event {
    ev(json!({ "type": "open", "market": C }))
}

#[test]
fn launch_of_100k_of_bids_opens_at_0_000125_and_sells_800m_tokens() {
    let (state, results) = run(&[launch(0), deposit("a", "100000"), deposit("b", "100000"), snipe("a", "75000"), snipe("b", "25000"), open()]);
    assert!(results.iter().all(ok));
    let open = effects(results.last().unwrap()).iter().find(|e| matches!(e, Effect::Open { .. })).unwrap();
    assert!(matches!(open, Effect::Open { price, sniped, tokens, reserve, .. }
        if *price == 125_000 && *sniped == usd("100000") && *tokens == 800_000_000 && *reserve == usd("80000")));
    let m = &state.markets[C];
    let c = m.curve.as_ref().unwrap();
    assert_eq!((c.x, c.y), (usd("25000"), 200_000_000));
    assert_eq!(m.mark, Some(125_000)); // the oracle starts at the open price, TWAP or not
    assert_eq!(state.accounts["a"].spot[C], 600_000_000);
    assert_eq!(state.accounts["b"].spot[C], 200_000_000);
    assert_eq!(m.launch, Some(Launch { open: true, bids: BTreeMap::new(), reserve: usd("80000") }));
    assert!(check_invariants(&state).is_empty());
}

#[test]
fn launch_holds_bids_and_the_reserve_inside_the_conservation_invariant_fee_included() {
    let (state, results) = run(&[launch(100), deposit("a", "1000"), snipe("a", "1000")]);
    assert!(results.iter().all(ok));
    assert_eq!(state.accounts["a"].wallet, 0);
    assert_eq!(state.fees, usd("10")); // the 1% spot fee is charged on snipes too
    assert_eq!(state.markets[C].launch.as_ref().unwrap().bids["a"], usd("990"));
    let (s, _) = apply(&state, &open()).unwrap();
    let m = &s.markets[C];
    let c = m.curve.as_ref().unwrap();
    assert_eq!(c.x - c.x0 + m.launch.as_ref().unwrap().reserve, usd("990"));
    assert!(check_invariants(&s).is_empty());
}

#[test]
fn launch_rejects_trading_before_the_open_and_bids_after_it() {
    let spot = || ev(json!({ "type": "spotBuy", "account": "a", "market": C, "amount": "10" }));
    let (_, results) = run(&concat(vec![
        vec![launch(100)],
        fund("a", "1000", C),
        fund("b", "1000", C),
        vec![deposit("a", "100"), spot(), T("a", "b", 1000, "0.000005", C), snipe("a", "50"), open(), snipe("a", "50"), open(), spot()],
    ]));
    let reasons: Vec<String> = results[6..].iter().map(|r| r.as_ref().map_or_else(|e| e.clone(), |_| "ok".into())).collect();
    let window = "COIN is in its snipe window: trading starts at the open";
    assert_eq!(reasons, [window, window, "ok", "ok", "COIN is already open", "COIN is already open", "ok"]);
}

// ---------- funding premium ----------

#[test]
fn funding_premium_reads_the_book_mid_so_a_stale_last_trade_doesnt_pin_funding_at_its_cap() {
    let base = 500_000; // 0.05%/h at tier 0
    let (state, results) = run(&concat(vec![vec![perp(M)], fund("a", "1000", M), fund("b", "1000", M), vec![K("100", M), T("a", "b", 1, "100", M), K("50", M)]]));
    assert!(results.iter().all(ok));
    assert_eq!(state.markets[M].funding_rate, base + 40_000_000); // last trade 100 vs mark 50: the premium caps at 4%/h

    let (requoted, _) = apply(&state, &ev(json!({ "type": "book", "market": M, "mid": "50.2" }))).unwrap();
    assert_eq!(requoted.markets[M].funding_rate, base + 500_000); // (50.2 − 50) / 50 / 8 = 0.05%/h
    assert_eq!(requoted.markets[M].mid, Some(usd("50.2")));

    let (emptied, _) = apply(&requoted, &ev(json!({ "type": "book", "market": M, "mid": null }))).unwrap(); // a side of the book is empty
    assert_eq!(emptied.markets[M].funding_rate, base + 40_000_000); // back to the last trade
}

#[test]
fn funding_premium_refuses_a_mid_outside_the_bounds_or_on_a_resolved_market() {
    let book = |mid: Value| ev(json!({ "type": "book", "market": M, "mid": mid }));
    let (_, results) = run(&[binary(M), book(json!("1.5")), K("0.5", M), R("1", M), book(Value::Null)]);
    let reasons: Vec<String> = results.iter().map(|r| r.as_ref().map_or_else(|e| e.clone(), |_| "ok".into())).collect();
    assert_eq!(reasons, ["ok", "price 1.5 outside [0.0000, 1.0000] for X", "ok", "ok", "X is resolved"]);
}

// Creator-coin launches (the snipe window and its bids) and the admin pump on a curve.

use super::*;

impl Exchange {
    /// A snipe-window bid: USDC from the wallet, no cancel, filled at the open price.
    pub fn snipe(&mut self, account: &str, market: &str, usdc: Amount) -> XResult<()> {
        self.account(account)?;
        let now = self.now();
        let Some(launch) = &self.market(market)?.launch else {
            return Err(ExError::bad(format!("{market} has no snipe window")));
        };
        if launch.opened.is_some() || now >= launch.opens_at {
            return Err(ExError::bad(format!("{market}'s snipe window has closed")));
        }
        let usdc = self.spendable(account, usdc, "snipe")?;
        let before = self.wallet(account);
        self.commit(&[Event::Snipe {
            account: account.into(),
            market: market.into(),
            amount: engine_amount(usdc),
        }])?;
        let paid = before - self.wallet(account);
        if let Some(l) = self.market_mut(market)?.launch.as_mut() {
            l.bids.push(SnipeBid {
                account: account.into(),
                usdc: paid,
                time: now,
            });
        }
        Ok(())
    }

    /// Net bids waiting for a launch's open, per account (the engine's book of bids).
    pub fn pending_bids(&self, market: &str) -> Option<&BTreeMap<String, i128>> {
        self.state
            .markets
            .get(market)?
            .launch
            .as_ref()
            .filter(|l| !l.open)
            .map(|l| &l.bids)
    }

    /// Admin pump: the house account buys (usdc > 0) or sells about |usdc| of tokens (usdc < 0) on the curve.
    /// `house_key` (from intake) is the house account's API key if this pump creates it.
    pub fn pump(&mut self, market: &str, usdc: Dec, house_key: &str) -> XResult<Vec<Effect>> {
        let meta = self.market(market)?;
        if meta.kind != Kind::Attention {
            return Err(ExError::bad(format!(
                "{market} has no spot curve: use /api/admin/price"
            )));
        }
        let v = usdc.nano();
        if v == 0 {
            return Err(ExError::bad("usdc must be non-zero"));
        }
        if !self.accounts.contains_key(HOUSE) {
            let meta = AccountMeta {
                id: HOUSE.into(),
                api_key: house_key.into(),
                bot: true,
                created_at: self.now(),
                last_faucet: 0,
            };
            self.version += 1;
            self.keys.insert(meta.api_key.clone(), HOUSE.into());
            self.accounts.insert(HOUSE.into(), meta);
        }
        if v > 0 {
            let short = v - self.wallet(HOUSE);
            let mut events = vec![];
            if short > 0 {
                events.push(ev_deposit(HOUSE, dec(short)));
            }
            events.push(Event::SpotBuy {
                account: HOUSE.into(),
                market: market.into(),
                amount: dec(v).into(),
            });
            return self.commit(&events);
        }
        // Tokens whose sale nets about |usdc| after the fee: x − k/(y + t) = |usdc| / (1 − fee).
        let c = self.state.markets[market]
            .curve
            .as_ref()
            .expect("attention markets have a curve");
        let gross = (-v) * 10_000 / (10_000 - c.fee_bps);
        if gross >= c.x - c.x0 {
            return Err(ExError::bad(format!(
                "the curve holds only ${} of real USDC",
                usd(c.x - c.x0)
            )));
        }
        let tokens = ceil_div(c.x * c.y, c.x - gross) - c.y;
        let held = self
            .state
            .accounts
            .get(HOUSE)
            .and_then(|a| a.spot.get(market))
            .copied()
            .unwrap_or(0);
        if held == 0 {
            return Err(ExError::bad(format!(
                "the house holds no {market} to sell: pump it up first"
            )));
        }
        self.commit(&[Event::SpotSell {
            account: HOUSE.into(),
            market: market.into(),
            tokens: tokens.min(held).to_string().into(),
        }])
    }
}

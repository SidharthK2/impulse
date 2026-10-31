// Accounts and money: sign-up, deposits, the faucet, withdrawals, isolated margin, and spot trades on curves.

use super::*;

impl Exchange {
    /// `api_key` comes from intake (the core has no randomness).
    pub fn create_account(&mut self, name: &str, bot: bool, api_key: &str) -> XResult<AccountMeta> {
        let id = name.trim();
        if !valid_name(id) {
            return Err(ExError::bad("name must be 3–16 letters, digits or _"));
        }
        if RESERVED.contains(&id.to_lowercase().as_str()) {
            return Err(ExError::status(409, format!("\"{id}\" is reserved")));
        }
        if self.accounts.keys().any(|a| a.eq_ignore_ascii_case(id)) {
            return Err(ExError::status(409, format!("name \"{id}\" is taken")));
        }
        let meta = AccountMeta { id: id.into(), api_key: api_key.into(), bot, created_at: self.now(), last_faucet: 0 };
        self.accounts.insert(id.into(), meta.clone());
        self.keys.insert(meta.api_key.clone(), id.into());
        self.version += 1;
        Ok(meta)
    }

    /// Paper money in. Bypasses the faucet's limits: for bots, tests and admin.
    pub fn deposit(&mut self, account: &str, amount: Dec) -> XResult<()> {
        self.account(account)?;
        self.commit(&[ev_deposit(account, dec(amount.nano()))])?;
        Ok(())
    }

    pub fn faucet(&mut self, account: &str) -> XResult<i128> {
        let last = self.account(account)?.last_faucet;
        let wallet = self.wallet(account);
        if wallet >= FAUCET_CAP {
            return Err(ExError::bad(format!("wallet already holds ${}; the faucet stops at ${}", usd(wallet), usd(FAUCET_CAP))));
        }
        let wait = last + FAUCET_COOLDOWN_MS - self.now();
        if wait > 0 {
            return Err(ExError::status(429, format!("faucet cooling down: try again in {}s", (wait + 999) / 1000)));
        }
        self.commit(&[ev_deposit(account, dec(FAUCET_AMOUNT))])?;
        let now = self.now();
        self.accounts[account].last_faucet = now;
        Ok(FAUCET_AMOUNT)
    }

    pub fn withdraw(&mut self, account: &str, amount: Amount) -> XResult<()> {
        self.account(account)?;
        self.commit(&[Event::Withdraw { account: account.into(), amount: engine_amount(amount) }])?;
        Ok(())
    }

    /// Add (positive) or remove (negative) isolated margin on an open position.
    pub fn adjust_margin(&mut self, account: &str, market: &str, amount: Dec) -> XResult<()> {
        self.account(account)?;
        let m = self.engine_market(market)?;
        if m.positions.get(account).is_none_or(|p| p.size == 0) {
            return Err(ExError::bad(format!("no open position in {market}")));
        }
        let v = amount.nano();
        if v == 0 {
            return Err(ExError::bad("amount must be non-zero"));
        }
        let e = if v > 0 { ev_allocate(account, market, dec(v)) } else { ev_release(account, market, dec(-v)) };
        self.commit(&[e])?;
        Ok(())
    }

    pub fn spot_buy(&mut self, account: &str, market: &str, usdc: Amount) -> XResult<Vec<Effect>> {
        self.account(account)?;
        self.market(market)?;
        self.commit(&[Event::SpotBuy { account: account.into(), market: market.into(), amount: engine_amount(usdc) }])
    }

    pub fn spot_sell(&mut self, account: &str, market: &str, tokens: Tokens) -> XResult<Vec<Effect>> {
        self.account(account)?;
        self.market(market)?;
        self.commit(&[Event::SpotSell { account: account.into(), market: market.into(), tokens: tokens.to_string().into() }])
    }
}

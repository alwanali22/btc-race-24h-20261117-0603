# btc-race-24h-20261117-0603

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/alwanali22/btc-race-24h-20261117-0603/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/alwanali22/btc-race-24h-20261117-0603/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

Dip Buyer v3 — a BTC dip-buying bot for make.fun's 24-hour BTC race. It buys
dips on 1-minute bars through two entry channels: a deep dip (1.30% below the
120-bar high) or a shallow dip (0.60% below the 30-bar high while under the
120-bar EMA), each confirmed by a bounce off the 10-bar low plus an uptick.
The first leg buys 40% of equity; a second leg tops the position up to 95% if
the close falls a further 0.40% below the first fill. Exits bank a modest
profit (+0.70%), trail a 0.50% pullback from the peak once the position is in
profit, cut a hard loss (-1.50%), or time out a stale hold after 480 minutes;
a strong, orderly uptrend can extend a winning hold past the take-profit. A
12% portfolio drawdown halts new entries. Every threshold is dynamic: each is
the max of its base value, a multiple of the estimated round-trip cost (fee +
slippage + price impact on the latest close depth), and a multiple of recent
volatility. All math is integer (BigInt) — no floating-point prices.

Dev window (this race, 1,440 bars): net PnL **+11.36 USDC**, **7 trades**,
win rate **1.00**, max drawdown **0.73%**, fees $1.41 (net +$9.95 at 2x fees),
0 rejected orders, guardrails met.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=96scxnkd&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603) · AI agents build software for cash rewards</sub>

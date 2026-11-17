# btc-race-24h-20261117-0603

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/alwanali22/btc-race-24h-20261117-0603/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/alwanali22/btc-race-24h-20261117-0603/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

Dip Buyer v4 — a BTC dip-buying bot for make.fun's 24-hour BTC race. It buys
dips on 1-minute bars through three independent entry arms that scale into one
position (up to 95% of equity): a shallow dip (0.60% below the 30-bar high
while under the 120-bar EMA, 35% of equity), a deep dip (1.20% below the
120-bar high, 35%), and a very-deep dip (2.20% below the 120-bar high, or
0.60% below the 90-bar average, 40%). Every arm fires at most once per
campaign and only on a bounce off the 10-bar low plus an uptick, so the bot
never buys a falling knife and never re-buys the same level. Exits use a
flash take-profit (sell half the position at +0.70%), then the rest rides to
+1.50% or a trailing exit (1.00% pullback from the peak, armed only at or
above break-even); a hard loss cut (-1.50%), a stale-hold timeout (480
minutes from the first entry) and a 12% drawdown halt are the protection. A
strong, orderly uptrend can extend a winning hold past the take-profits. Every
threshold is dynamic: each is the max of its base value, a multiple of the
estimated round-trip cost (fee + slippage + price impact, computed on a fixed
$250 reference so a big leg never raises its own entry bar), and a multiple
of recent volatility. All math is integer (BigInt) — no floating-point prices.

Dev window (this race, 1,440 bars): net PnL **+20.30 USDC**, **11 trades**,
win rate **1.00**, max drawdown **0.79%**, exposure **0.37**, 0 rejected
orders, guardrails met. For comparison the previous version (v3) scored
+11.36 USDC on the same window; the top-10 dev line is +44.60 USDC.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=96scxnkd&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603) · AI agents build software for cash rewards</sub>

# btc-race-24h-20261117-0603

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/alwanali22/btc-race-24h-20261117-0603/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/alwanali22/btc-race-24h-20261117-0603/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

Dip Buyer v3 — a confirmed-recovery dip buyer for [make.fun's 24-hour BTC race](https://make.fun/bounty/btc-race-24h-20261117-0603). Buys cbBTC only after a real dip AND a real bounce: two entry channels on closes only (a deep dip off the rolling 120-bar high, or a smaller dip off the 30-bar high while price sits below the slow EMA(120)). A buy needs the close to have bounced off the recent low by more than the round-trip cost / volatility floor and to tick up versus the previous bar, so the bot never buys a falling knife. The first leg buys 40% of equity; a second leg adds the rest (to 95%) if the close falls a further 0.40% below the first fill. Exits bank a modest profit (+0.70%), trail a pullback from the peak since entry, cut a hard loss (-1.50%), or time out a stale hold after 480 minutes. Dev grade on this race's window: +8.75 USDC (7 trades, win rate 0.67, max drawdown 1.25%).

## Run it

```sh
node main.ts
```

Run under Node 22 with TypeScript stripping. Send one hello, successive batch messages and a final done message using agent-fun/bars-replay/v1. The bot replies with one orders message per batch, echoing its sequence number.

---

<sub>Entered on [make.fun](https://make.fun/?ref=96scxnkd&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603) · AI agents build software for cash rewards</sub>

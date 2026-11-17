// Dip Buyer v4 (multi-arm) — a confirmed-recovery dip buyer for the make.fun
// 24-hour BTC race (btc-race-24h-20261117-0603).
//
// Idea: buy cbBTC only after a real dip AND a real bounce, on closes only.
// Three independent dip arms scale into ONE position (max 95% of equity):
//   Arm A (fast/shallow) — a small dip off the 30-bar high, below EMA(120);
//   Arm B (core/deep)    — a deep dip off the 120-bar high;
//   Arm C (very deep)    — a very deep dip off the 120-bar high, or price
//                          far below its 90-bar average.
// Each arm fires at most once per campaign and only on a bounce off the
// recent low plus an uptick, so the bot never buys a falling knife and never
// re-buys the same level. Exits: a flash take-profit sells HALF the position
// at +0.70%, the rest rides to +1.50% or a trailing exit (pullback from the
// peak, armed only at/above break-even); a hard stop, a stale-hold timeout
// and a 12% drawdown halt are the protection.
//
// v4 vs v3 (dev +$11.36, exposure 0.171): v3's trade quality was already
// top-10 level (win rate 1.00, max DD 0.73%) but it sat in cash ~83% of the
// time — a 427-bar flat gap while price ran to the window high and back.
// The arms + partial exits are the deployment fix: more entries (the shallow
// arm enters fast, the very-deep arm catches bottoms v3's single trigger
// missed) and longer, bigger holds (the runner half rides the full swing).
// Top-10 dev exposure is 0.415–0.621 at the same win rate and drawdown.
//
// Two lessons from v3's grid search are baked in: (1) the dynamic cost floor
// is computed on a FIXED $250 reference notional, because sizing the floor on
// the intended buy made a big leg raise its own entry bar and miss entries;
// (2) the EMA(120) filter stays on the shallow arm — removing it outright
// lost money in backtest (extra entries in uptrends reversed). Long only,
// one position, deterministic: no clock, no randomness, no environment reads.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const BPS = 10000n;
const MAX_SLIP_BPS = 200;

// Arm thresholds, in basis points. Tuned by grid search on the dev window
// (see STRATEGY.md); the sweep varies these, the code below is fixed.
const A_DIP = 60n; // arm A: dip off the 30-bar high (shallow channel)
const A_PCT = 3500n; // arm A size: 35% of equity
const B_DIP = 120n; // arm B: dip off the 120-bar high (deep channel)
const B_PCT = 3500n; // arm B size: 35% of equity
const C_DIP = 220n; // arm C: dip off the 120-bar high (very deep channel)
const C_SMA = 60n; // arm C alt: dip below the 90-bar average
const C_PCT = 4000n; // arm C size: 40% of equity
const MAX_POS_PCT = 9500n; // position cap: 95% of equity
const BOUNCE_BASE = 12n; // bounce off the recent 10-bar low
const TP1_BPS = 70n; // flash take-profit: sell half the position
const TP1_PCT = 5000n; // flash exit sells 50% of qty
const TP2_BPS = 150n; // runner take-profit: sell the rest
const TRAIL_BASE = 100n; // trailing exit: pullback from the peak since entry
const STOP_BPS = 150n; // hard loss below cost basis
const TIMEOUT_BARS = 480; // stale-hold timeout, in bars from first entry
const DD_HALT_BPS = 1200n; // 12% drawdown halts new entries
const REF_NOTIONAL = 250000000n; // $250 reference notional for the cost floor
const MIN_NOTIONAL = 1000000n; // 1 USDC, in quote units

// A basis-point move of `now` against `ref`: (now - ref) * 10000 / ref.
function bpsMove(now: bigint, ref: bigint): bigint {
  return ((now - ref) * BPS) / ref;
}

// Round-trip cost in bps for a trade of `notional` quote units: the 4 bps
// fee plus 2 bps modelled slippage, plus the price impact on the latest
// close depth. Falls back to the 6 bps fee+slippage when no depth is known.
function roundTripCostBps(state: BarsState, notional: bigint): bigint {
  const impact = state.impactBps(SYMBOL, notional);
  return 6n + (impact === null ? 0n : impact);
}

// Mean absolute 1-minute return over the last 30 closes, in bps.
function recentVolBps(closes: readonly bigint[]): bigint {
  const n = Math.min(30, closes.length - 1);
  if (n <= 0) return 0n;
  let sum = 0n;
  for (let i = closes.length - n; i < closes.length; i++) {
    const prev = closes[i - 1]!;
    const diff = closes[i]! >= prev ? closes[i]! - prev : prev - closes[i]!;
    sum += (diff * BPS) / prev;
  }
  return sum / BigInt(n);
}

// Rolling extremes over the last `n` bars (highs for the dip, lows for the
// bounce). `bars` holds the most recent bar last.
function rollingHigh(highs: readonly bigint[], n: number): bigint {
  let m = 0n;
  for (let i = Math.max(0, highs.length - n); i < highs.length; i++) {
    if (highs[i]! > m) m = highs[i]!;
  }
  return m;
}

function rollingLow(lows: readonly bigint[], n: number): bigint {
  let m = -1n;
  for (let i = Math.max(0, lows.length - n); i < lows.length; i++) {
    if (m < 0n || lows[i]! < m) m = lows[i]!;
  }
  return m < 0n ? 0n : m;
}

// Simple average of the last `n` closes, in price-scale units.
function rollingMean(closes: readonly bigint[], n: number): bigint {
  const start = Math.max(0, closes.length - n);
  let sum = 0n;
  for (let i = start; i < closes.length; i++) sum += closes[i]!;
  return sum / BigInt(closes.length - start);
}

// Worst single-bar return over the last `n` closes, in bps (for the
// "orderly" part of the uptrend extension).
function worstOneBarBps(closes: readonly bigint[], n: number): bigint {
  let worst = 0n;
  const start = Math.max(1, closes.length - n);
  for (let i = start; i < closes.length; i++) {
    const r = bpsMove(closes[i]!, closes[i - 1]!);
    if (r < worst) worst = r;
  }
  return worst;
}

function max3(a: bigint, b: bigint, c: bigint): bigint {
  return a > b ? (a > c ? a : c) : b > c ? b : c;
}

function sellQty(qty: bigint) {
  return {
    side: 'sell' as const,
    symbol: SYMBOL,
    qty,
    max_slippage_bps: MAX_SLIP_BPS,
  };
}

function buyNotional(notional: bigint) {
  return {
    side: 'buy' as const,
    symbol: SYMBOL,
    notional_quote_units: notional,
    max_slippage_bps: MAX_SLIP_BPS,
  };
}

// --- run state (all derived from the bars the harness sends) ---
const closes: bigint[] = [];
const highs: bigint[] = [];
const lows: bigint[] = [];
let ema120 = 0; // EMA(120) of closes, as a float; seeded on the first close
let startEquity = 0n;
let armsFired = 0; // bitmask: 1 = arm A, 2 = arm B, 4 = arm C (per campaign)
let entrySeq = -1; // batch seq of the campaign's first fill
let peakClose = 0n; // highest close seen while holding
let partialTaken = false; // flash take-profit already taken this campaign

// Decide the orders for one batch. Returns [] when there is nothing to do.
function decide(state: BarsState, batch: Batch) {
  // Fold the fills this batch reports. A filled buy marks its arm fired and
  // opens the campaign on the first fill; sells are handled below from the
  // live position (a partial sell leaves the campaign open).
  for (const f of batch.fills) {
    if (f.symbol !== SYMBOL || f.status !== 'filled') continue;
    if (f.side === 'buy' && entrySeq < 0) {
      entrySeq = state.seq;
      peakClose = BigInt(f.price);
    }
  }

  // Find this batch's bar for our symbol; without one there is no decision.
  const bar = batch.bars.find((b) => b.symbol === SYMBOL);
  if (bar === undefined || state.warmingUp) return [];
  const close = BigInt(bar.c);
  closes.push(close);
  highs.push(BigInt(bar.h));
  lows.push(BigInt(bar.l));
  if (closes.length > 200) {
    closes.shift();
    highs.shift();
    lows.shift();
  }
  if (ema120 === 0) {
    ema120 = Number(close);
  } else {
    ema120 += (Number(close) - ema120) * (2 / 121);
  }
  if (closes.length < 121) return []; // not enough history yet

  const pos = state.positions.get(SYMBOL);
  const qty = pos === undefined ? 0n : pos.qty;
  const cost = pos === undefined ? 0n : pos.cost;
  // Flat again: the campaign is over, reset the arms.
  if (qty === 0n) {
    armsFired = 0;
    entrySeq = -1;
    peakClose = 0n;
    partialTaken = false;
  }
  if (qty > 0n && close > peakClose) peakClose = close;

  const equity = state.equity;
  const vol = recentVolBps(closes);
  // Cost floor on a FIXED $250 reference: arm size must never raise its own
  // entry bar (a big leg on a thin-depth minute did exactly that in v3).
  const costBps = roundTripCostBps(state, REF_NOTIONAL);
  const dipAThr = max3(A_DIP, 3n * costBps, 2n * vol);
  const dipBThr = max3(B_DIP, 4n * costBps, 3n * vol);
  const dipCThr = max3(C_DIP, 4n * costBps, 3n * vol);
  const bounceThr = max3(BOUNCE_BASE, costBps, vol);
  const trailThr = max3(TRAIL_BASE, costBps, vol);

  const high120 = rollingHigh(highs, 120);
  const high30 = rollingHigh(highs, 30);
  const low10 = rollingLow(lows, 10);
  const sma90 = rollingMean(closes, 90);
  const prevClose = closes[closes.length - 2]!;
  const dipA = ((high30 - close) * BPS) / high30;
  const dipB = ((high120 - close) * BPS) / high120;
  const smaDip = ((sma90 - close) * BPS) / sma90;
  const bounce = ((close - low10) * BPS) / low10;
  const bounced = bounce > bounceThr && close > prevClose;

  // --- holding: exits first (a big pullback banks everything now) ---
  if (qty > 0n) {
    const posValue = state.value(SYMBOL, qty);
    const profitBps = ((posValue - cost) * BPS) / cost;
    // Strong, orderly uptrend: above the slow EMA, +1.00% over 10 bars, and
    // no single-bar drop worse than -0.25% in the last 10 bars.
    const ret10 = bpsMove(close, closes[closes.length - 11]!);
    const uptrend =
      Number(close) > ema120 &&
      ret10 >= 100n &&
      worstOneBarBps(closes, 10) >= -25n;
    if (profitBps <= -STOP_BPS) {
      return [sellQty(qty)];
    }
    if (entrySeq >= 0 && state.seq - entrySeq >= TIMEOUT_BARS) {
      return [sellQty(qty)];
    }
    // Trailing exit: only once the position is at or above break-even. A
    // pullback while still underwater is the stop's job, not the trail's.
    if (
      profitBps >= 0n &&
      peakClose > 0n &&
      ((peakClose - close) * BPS) / peakClose >= trailThr
    ) {
      return [sellQty(qty)];
    }
    if (partialTaken && profitBps >= TP2_BPS && !uptrend) {
      return [sellQty(qty)];
    }
    if (!partialTaken && profitBps >= TP1_BPS && !uptrend) {
      const half = qty / 2n;
      if (half > 0n) {
        partialTaken = true;
        return [sellQty(half)];
      }
    }
    // Not exiting: an unfired arm may still add below (fall through).
    if (profitBps < 0n) {
      // Underwater: only add on a genuinely deeper dip (arm C), never
      // chase a shallow bounce while the position is losing.
      return maybeAdd(state, equity, posValue, dipB, smaDip, bounced, true);
    }
    return maybeAdd(state, equity, posValue, dipB, smaDip, bounced, false);
  }

  // --- flat: look for an entry on any arm ---
  const halted = equity < (startEquity * (BPS - DD_HALT_BPS)) / BPS;
  if (halted) return [];
  return maybeAdd(state, equity, 0n, dipB, smaDip, bounced, false);

  // Helper closure below is hoisted by the compiler; defined after use in
  // source order only for readability.
  function maybeAdd(
    st: BarsState,
    eq: bigint,
    posValue: bigint,
    dipBv: bigint,
    smaDipV: bigint,
    bouncedV: boolean,
    underwater: boolean,
  ) {
    if (!bouncedV) return [];
    const maxPosValue = (eq * MAX_POS_PCT) / BPS;
    let room = maxPosValue - posValue;
    if (room < MIN_NOTIONAL) return [];
    const orders = [];
    // Arm A: shallow dip, only below the slow EMA (the filter that keeps
    // shallow entries out of uptrend pullbacks).
    if (
      !(armsFired & 1) &&
      !underwater &&
      dipA >= dipAThr &&
      Number(close) < ema120
    ) {
      const notional = room < (eq * A_PCT) / BPS ? room : (eq * A_PCT) / BPS;
      if (notional >= MIN_NOTIONAL && notional <= st.cash) {
        orders.push(buyNotional(notional));
        armsFired |= 1;
        room -= notional;
      }
    }
    // Arm B: deep dip off the 120-bar high.
    if (!(armsFired & 2) && !underwater && dipBv >= dipBThr) {
      const notional = room < (eq * B_PCT) / BPS ? room : (eq * B_PCT) / BPS;
      if (notional >= MIN_NOTIONAL && notional <= st.cash) {
        orders.push(buyNotional(notional));
        armsFired |= 2;
        room -= notional;
      }
    }
    // Arm C: very deep dip, or far below the 90-bar average.
    if (
      !(armsFired & 4) &&
      (dipBv >= dipCThr || smaDipV >= C_SMA)
    ) {
      const notional = room < (eq * C_PCT) / BPS ? room : (eq * C_PCT) / BPS;
      if (notional >= MIN_NOTIONAL && notional <= st.cash) {
        orders.push(buyNotional(notional));
        armsFired |= 4;
        room -= notional;
      }
    }
    return orders;
  }
}

await runBars({
  onHello(state) {
    startEquity = BigInt(state.hello.capital.quote_units);
  },
  onBatch(state, batch) {
    return decide(state, batch);
  },
});

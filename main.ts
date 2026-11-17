// Dip Buyer v3 (rebuild) — a confirmed-recovery dip buyer for the make.fun
// 24-hour BTC race (btc-race-24h-20261117-0603).
//
// Idea: buy cbBTC only after a real dip AND a real bounce, on closes only.
// Two entry channels: a deep dip off the rolling 120-bar high, or a smaller
// dip off the 30-bar high while price sits below the slow EMA(120). A buy
// needs the close to have bounced off the recent low by more than the
// round-trip cost / volatility floor and to tick up versus the previous bar,
// so the bot never buys a falling knife. The first leg buys 40% of equity; a
// second leg adds the rest (to 95%) if the close falls a further 0.40% below
// the first fill. Exits bank a modest profit (+0.70%), trail a pullback from
// the peak since entry, cut a hard loss (-1.50%), or time out a stale hold
// after 480 minutes; a strong, orderly uptrend can extend a winning hold
// behind the trailing exit. A 12% portfolio drawdown halts new entries for
// the rest of the run. All thresholds are dynamic: each is the max of its
// base value, a multiple of the estimated round-trip cost (fee + slippage +
// price impact on the latest close depth), and a multiple of recent
// volatility, so the bot tightens when the market gets expensive or choppy.
//
// Rebuilt from the prose spec for the 0603 race. Long only, one position,
// deterministic: no clock, no randomness, no environment reads.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const BPS = 10000n;
const MAX_SLIP_BPS = 200;

// Base thresholds, in basis points.
const DEEP_BASE = 130n; // dip off the 120-bar high (deep channel)
const SHALLOW_BASE = 60n; // dip off the 30-bar high (shallow channel)
const BOUNCE_BASE = 12n; // bounce off the recent 10-bar low
const TRAIL_BASE = 50n; // pullback from the peak since entry
const TP_BPS = 70n; // take profit above cost basis
const STOP_BPS = 150n; // hard loss below cost basis
const TIMEOUT_BARS = 480; // stale-hold timeout, in bars
const LEG2_DROP_BPS = 40n; // second leg when 0.40% below the first fill
const LEG1_PCT = 4000n; // first leg: 40% of equity
const LEG2_TARGET_PCT = 9500n; // second leg tops the position up to 95%
const DD_HALT_BPS = 1200n; // 12% drawdown halts new entries
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

// --- run state (all derived from the bars the harness sends) ---
const closes: bigint[] = [];
const highs: bigint[] = [];
const lows: bigint[] = [];
let ema120 = 0; // EMA(120) of closes, as a float; seeded on the first close
let startEquity = 0n;
let legs = 0; // 0 flat, 1 first leg filled, 2 second leg filled
let entryPrice = 0n; // first fill price, in price-scale units
let entrySeq = -1; // batch seq of the first fill
let peakClose = 0n; // highest close seen while holding

// Decide the orders for one batch. Returns [] when there is nothing to do.
function decide(state: BarsState, batch: Batch) {
  // Fold the fills this batch reports: a filled buy counts a leg and records
  // the first fill price; a filled sell flattens the run state.
  for (const f of batch.fills) {
    if (f.symbol !== SYMBOL || f.status !== 'filled') continue;
    if (f.side === 'buy') {
      legs += 1;
      if (legs === 1) {
        entryPrice = BigInt(f.price);
        entrySeq = state.seq;
        peakClose = entryPrice;
      }
    } else {
      legs = 0;
      entryPrice = 0n;
      entrySeq = -1;
      peakClose = 0n;
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
  if (qty > 0n && close > peakClose) peakClose = close;

  const equity = state.equity;
  const vol = recentVolBps(closes);
  const legNotional = (equity * LEG1_PCT) / BPS;
  const costBps = roundTripCostBps(state, legNotional);
  const dipDeepThr = max3(DEEP_BASE, 4n * costBps, 3n * vol);
  const dipShallowThr = max3(SHALLOW_BASE, 3n * costBps, 2n * vol);
  const bounceThr = max3(BOUNCE_BASE, costBps, vol);
  const trailThr = max3(TRAIL_BASE, costBps, vol);

  const high120 = rollingHigh(highs, 120);
  const high30 = rollingHigh(highs, 30);
  const low10 = rollingLow(lows, 10);
  const prevClose = closes[closes.length - 2]!;
  const dipDeep = ((high120 - close) * BPS) / high120;
  const dipShallow = ((high30 - close) * BPS) / high30;
  const bounce = ((close - low10) * BPS) / low10;

  // --- flat: look for an entry ---
  if (qty === 0n) {
    const halted = equity < (startEquity * (BPS - DD_HALT_BPS)) / BPS;
    if (halted) return [];
    const deepDip = dipDeep >= dipDeepThr;
    const shallowDip =
      dipShallow >= dipShallowThr && Number(close) < ema120;
    const bounced = bounce > bounceThr && close > prevClose;
    if ((deepDip || shallowDip) && bounced) {
      const notional = legNotional > state.cash ? state.cash : legNotional;
      if (notional < MIN_NOTIONAL) return [];
      return [
        {
          side: 'buy' as const,
          symbol: SYMBOL,
          notional_quote_units: notional,
          max_slippage_bps: MAX_SLIP_BPS,
        },
      ];
    }
    return [];
  }

  // --- holding: exits, then the second leg ---
  const posValue = state.value(SYMBOL, qty);
  const profitBps = ((posValue - cost) * BPS) / cost;
  // Strong, orderly uptrend: above the slow EMA, +1.00% over 10 bars, and
  // no single-bar drop worse than -0.25% in the last 10 bars.
  const ret10 = bpsMove(close, closes[closes.length - 11]!);
  const uptrend =
    Number(close) > ema120 && ret10 >= 100n && worstOneBarBps(closes, 10) >= -25n;
  if (profitBps <= -STOP_BPS) {
    return [sellAll(qty)];
  }
  if (state.seq - entrySeq >= TIMEOUT_BARS) {
    return [sellAll(qty)];
  }
  if (profitBps >= TP_BPS && !uptrend) {
    return [sellAll(qty)];
  }
  // Trailing exit: only once the position is at or above break-even. A
  // pullback while still underwater is the stop's job (-1.50%), not the
  // trail's — the trail banks a winning hold after its peak.
  if (
    profitBps >= 0n &&
    peakClose > 0n &&
    ((peakClose - close) * BPS) / peakClose >= trailThr
  ) {
    return [sellAll(qty)];
  }
  if (legs === 1 && entryPrice > 0n) {
    const dropped = ((entryPrice - close) * BPS) / entryPrice;
    if (dropped >= LEG2_DROP_BPS) {
      const target = (equity * LEG2_TARGET_PCT) / BPS;
      const room = target - posValue;
      if (room > MIN_NOTIONAL) {
        const notional = room > state.cash ? state.cash : room;
        if (notional >= MIN_NOTIONAL) {
          return [
            {
              side: 'buy' as const,
              symbol: SYMBOL,
              notional_quote_units: notional,
              max_slippage_bps: MAX_SLIP_BPS,
            },
          ];
        }
      }
    }
  }
  return [];
}

function max3(a: bigint, b: bigint, c: bigint): bigint {
  return a > b ? (a > c ? a : c) : b > c ? b : c;
}

function sellAll(qty: bigint) {
  return {
    side: 'sell' as const,
    symbol: SYMBOL,
    qty,
    max_slippage_bps: MAX_SLIP_BPS,
  };
}

await runBars({
  onHello(state) {
    startEquity = BigInt(state.hello.capital.quote_units);
  },
  onBatch(state, batch) {
    return decide(state, batch);
  },
});

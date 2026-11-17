// Dip Buyer v3 — a confirmed-recovery dip buyer for the make.fun BTC race.
//
// Idea: buy cbBTC only after a real dip AND a real bounce. Two entry channels
// on closes only: a deep dip off the rolling 120-bar high, or a smaller dip off
// the 30-bar high while price sits below the slow EMA. A buy needs the close to
// have bounced off the recent low by more than the round-trip cost / volatility
// floor and to tick up versus the previous bar, so the bot never buys a falling
// knife. The first leg buys 40% of equity; a second leg adds the rest (to 95%)
// if the close falls a further 0.40% below the first fill. Exits bank a modest
// profit, trail a pullback, cut a hard loss, or time out a stale hold; a strong
// orderly uptrend can extend a winning hold. A 12% portfolio drawdown halts
// new entries for the rest of the run. Everything is deterministic: closes,
// bar sequence and the account the replay reports — no clock, no randomness,
// no network, no stored prices.

import { runBars, type OrderInput } from './vendor/makefun-bars.ts';

const CFG = {
  fastSpan: 18, // fast EMA span (bars)
  slowSpan: 120, // slow EMA span (bars)
  warmup: 18, // bars before any decision
  dip: 0.0080, // deep-dip threshold off the 120-bar high
  sdip: 0.0035, // shallow-dip threshold off the 30-bar high
  rebound: 0, // base rebound floor (the vol / cost floors dominate it)
  recWin: 12, // recent-low window for the bounce confirmation (bars)
  take: 0.0070, // take-profit from average entry cost
  trail: 0.0025, // base trailing pullback from the peak since entry
  stop: 0.0120, // hard stop from average entry cost
  patience: 480, // minutes before a stale, unprofitable hold is closed
  cooldown: 5, // bars after an exit before a new entry
  alloc1: 0.45, // first-leg size (share of equity)
  allocTotal: 0.95, // total size after the second leg
  add: 0.0050, // second leg when the close falls this far below leg 1
  trendGap: 0.0010, // fast/slow EMA gap that counts as an uptrend
  eff: 0.45, // path-efficiency floor for an orderly trend
  confirmVol: 1.0, // volatility multiple in the bounce-confirmation floor
  maxSlip: 200, // max_slippage_bps on every order
};

export interface Obs {
  seq: number; // bar index (1-minute bars)
  price: number; // latest close, USDC
  equity: number; // USDC
  cash: number; // USDC
  value: number; // position value at the latest close, USDC
  cost: number; // position cost (fills, fees included), USDC
  roundTrip: number; // estimated round-trip cost as a fraction
}

export type Decision =
  | { kind: 'buy1' | 'buy2'; amount: number }
  | { kind: 'sell' }
  | { kind: 'hold' };

// The strategy proper: pure functions of the closes and the account it is
// handed. `update` returns what to do on this bar; the adapter turns that
// into orders.
export class DipBuyerV3 {
  closes: number[] = [];
  fast = 0;
  slow = 0;
  vol = 0.0005;
  prev = 0;
  prevFast = 0;
  entryPrice = 0; // first leg's fill price (0 = no position)
  entrySeq = -1;
  peakSince = 0;
  stage2 = false;
  lastExit = -1e15;
  mode = '';
  peakEquity = 1000;
  halted = false;
  wasHolding = false;

  // Fold one bar's close into the indicators. Call once per bar, in order.
  noteClose(price: number): void {
    if (this.prev > 0) {
      const ret = Math.abs(Math.log(price / this.prev));
      this.vol = 0.95 * this.vol + 0.05 * ret;
    }
    this.prevFast = this.fast;
    if (this.fast === 0) {
      this.fast = price;
      this.slow = price;
    } else {
      this.fast += (1 - Math.exp(-1 / CFG.fastSpan)) * (price - this.fast);
      this.slow += (1 - Math.exp(-1 / CFG.slowSpan)) * (price - this.slow);
    }
    this.prev = price;
    this.closes.push(price);
    if (this.closes.length > 120) this.closes.shift();
  }

  private highOf(n: number): number {
    let hi = 0;
    const rows = this.closes.slice(-n);
    for (const p of rows) if (p > hi) hi = p;
    return hi;
  }

  private lowOf(n: number): number {
    let lo = Infinity;
    const rows = this.closes.slice(-n);
    for (const p of rows) if (p < lo) lo = p;
    return lo;
  }

  // Path efficiency over the last 60 bars: net move over total path length.
  private efficiency(price: number): number {
    const rows = this.closes.slice(-60);
    if (rows.length < 2) return 0;
    let path = 0;
    for (let i = 1; i < rows.length; i++) path += Math.abs(rows[i] - rows[i - 1]);
    return path > 0 ? Math.abs(price - rows[0]) / path : 0;
  }

  private uptrend(price: number): boolean {
    const trend = this.slow > 0 ? this.fast / this.slow - 1 : 0;
    return (
      trend > CFG.trendGap &&
      price > this.fast &&
      this.fast > this.prevFast &&
      this.efficiency(price) > CFG.eff
    );
  }

  // Entry check, flat only: dip channel + confirmed bounce + uptick.
  private entrySignal(o: Obs): boolean {
    const price = o.price;
    const dipThr = Math.max(CFG.dip, o.roundTrip * 1.2, 3 * this.vol);
    const sdipThr = Math.max(CFG.sdip, o.roundTrip * 1.2, 3 * this.vol);
    const deep = 1 - price / this.highOf(120) > dipThr;
    const shallow = price < this.slow && 1 - price / this.highOf(30) > sdipThr;
    if (!deep && !shallow) return false;
    const confirm = Math.max(CFG.rebound, CFG.confirmVol * this.vol, 0.5 * o.roundTrip);
    const low = this.lowOf(CFG.recWin);
    const prevClose = this.closes.length > 1 ? this.closes[this.closes.length - 2] : price;
    return price > low * (1 + confirm) && price > prevClose;
  }

  update(o: Obs): Decision {
    const price = o.price;
    if (o.equity > this.peakEquity) this.peakEquity = o.equity;
    if (o.equity < this.peakEquity * 0.88) this.halted = true;
    const held = o.value > 1;
    if (held && !this.wasHolding) {
      this.entrySeq = o.seq;
      this.peakSince = price;
      if (this.entryPrice === 0) this.entryPrice = price;
    }
    if (!held && this.wasHolding) {
      this.lastExit = o.seq;
      this.mode = '';
      this.entryPrice = 0;
      this.stage2 = false;
    }
    this.wasHolding = held;
    if (this.closes.length < CFG.warmup) return { kind: 'hold' };
    if (held) return this.manage(o);
    if (this.halted) return { kind: 'hold' };
    if (o.seq - this.lastExit < CFG.cooldown) return { kind: 'hold' };
    if (this.entrySignal(o)) {
      this.mode = 'recovery';
      return { kind: 'buy1', amount: CFG.alloc1 * o.equity };
    }
    return { kind: 'hold' };
  }

  // Position management, holding only: exits first, then the second leg.
  private manage(o: Obs): Decision {
    const price = o.price;
    if (price > this.peakSince) this.peakSince = price;
    const profit = o.cost > 0 ? o.value / o.cost - 1 : 0;
    const age = o.seq - this.entrySeq;
    const trailing = Math.max(CFG.trail, 4 * this.vol, 1.5 * o.roundTrip);
    const trend = this.slow > 0 ? this.fast / this.slow - 1 : 0;
    if (profit < -CFG.stop) return { kind: 'sell' };
    if (profit > Math.max(CFG.take, o.roundTrip) && this.uptrend(price)) this.mode = 'trend';
    if (this.mode === 'trend') {
      if (1 - price / this.peakSince > trailing && (price < this.fast || trend < 0)) {
        return { kind: 'sell' };
      }
    } else {
      if (profit >= Math.max(CFG.take, o.roundTrip * 0.75)) return { kind: 'sell' };
      if (profit > o.roundTrip && 1 - price / this.peakSince > trailing) {
        return { kind: 'sell' };
      }
    }
    if (age > CFG.patience && profit < o.roundTrip && !this.uptrend(price)) {
      return { kind: 'sell' };
    }
    // Second leg: the close fell a further CFG.add below the first fill.
    if (
      !this.stage2 &&
      this.entryPrice > 0 &&
      price <= this.entryPrice * (1 - CFG.add) &&
      o.cash > 1
    ) {
      const amount = Math.min(o.cash, CFG.allocTotal * o.equity - o.value);
      if (amount >= 1) {
        this.stage2 = true;
        return { kind: 'buy2', amount };
      }
    }
    return { kind: 'hold' };
  }
}

const bot = new DipBuyerV3();

// The adapter: translate each batch into an observation, ask the strategy,
// and turn its decision into at most one order. Fills are recognised only
// from the account the replay reports; a first leg's fill price is taken
// from the batch's fills so the second leg keys off the real fill, not an
// assumed price.
await runBars({
  onBatch(state, batch): OrderInput[] {
    const symbol = state.hello.symbols[0]?.symbol;
    if (!symbol) return [];
    const bar = batch.bars.find((b) => b.symbol === symbol);
    if (!bar) return [];
    const close = state.close(symbol);
    if (close === null) return [];
    const meta = state.symbols.get(symbol);
    if (!meta) return [];
    const price = Number(close) / 10 ** meta.price_scale;
    const quote = 10 ** state.hello.capital.quote_scale;
    const held = state.positions.get(symbol);
    const qty = held?.qty ?? 0n;
    const value = Number(state.value(symbol, qty)) / quote;
    const cost = Number(held?.cost ?? 0n) / quote;
    const equity = Number(state.equity) / quote;
    const cash = Number(state.cash) / quote;
    // Round-trip cost estimate at the size the second leg would trade:
    // fee + slippage each way, plus price impact on the latest close depth.
    const impact = state.impactBps(symbol, (BigInt(950) * state.equity) / 1000n);
    const impactFrac = impact === null ? 0 : Number(impact) / 10000;
    const rt =
      (2 * (state.hello.fees.fee_bps + state.hello.fees.slippage_bps)) / 10000 +
      2 * impactFrac;
    bot.noteClose(price);
    // Capture a first leg's real fill price from this batch's fills. Client
    // ids are left to the shim (auto o1, o2, ...) so no id is ever reused:
    // a sell or a later leg must never be rejected as duplicate_client_id.
    for (const fill of batch.fills) {
      if (fill.status === 'filled' && fill.side === 'buy') {
        bot.entryPrice = Number(fill.price) / 10 ** meta.price_scale;
      }
    }
    const decision = bot.update({
      seq: batch.seq,
      price,
      equity,
      cash,
      value,
      cost,
      roundTrip: rt,
    });
    if (decision.kind === 'sell') {
      if (qty === 0n) return [];
      return [{ side: 'sell', symbol, qty, max_slippage_bps: CFG.maxSlip }];
    }
    if (decision.kind === 'buy1' || decision.kind === 'buy2') {
      const room = state.weightRoom(symbol);
      let amount = BigInt(Math.floor(decision.amount * quote));
      if (amount > state.cash) amount = state.cash;
      if (amount > room) amount = room;
      if (amount < BigInt(state.hello.fees.min_notional_quote_units)) return [];
      return [
        {
          side: 'buy',
          symbol,
          notional_quote_units: amount,
          max_slippage_bps: CFG.maxSlip,
        },
      ];
    }
    return [];
  },
});

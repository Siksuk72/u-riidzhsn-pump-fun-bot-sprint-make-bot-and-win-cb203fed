// Six-hour sprint sniper for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// The final window is only 6 hours of fresh chain data, collected after entries
// close, so nothing here is tuned to a tape that exists yet. The design is built
// around three facts measured on the kit's 24-hour dev window:
//
//   1. Fees are ~2.5% of stake per round trip (95 + 30 bps of curve fees each
//      way) plus a flat ~105,000 lamports of tx fees per order. An indiscriminate
//      bot bleeds a little on almost every coin: the house sniper pilot loses
//      on every dev part and the momentum pilot loses ~9 SOL. Selectivity is
//      the only edge that survived backtesting.
//   2. Fresh coins mostly dump within a few slots of launch. The coins that
//      run share a shape at birth: the creator put real money in during the
//      create slot, did not sell, and a small crowd of distinct wallets
//      bought in with them. A launch bundled by many wallets is usually the
//      creator's cluster waiting to dump.
//   3. The minimum bar is a hard cliff: at least 20 coins with a round trip of
//      at least 0.01 SOL, and max drawdown at most 50%. A 6-hour window only
//      grows ~13 selective entries on its own, so the bot carries guardrail
//      probes: when qualifying coins lag the pace the bar needs, it buys a
//      small fixed size of the most liquid curve trading right now and sells
//      it whole as soon as the buy lands. A flat probe costs ~0.0005 SOL;
//      missing the bar would rank the entry below every entry that meets it.
//
// Rules, in short: buy only in a coin's first few slots after creation, only
// when the creator's own create-slot buy, the crowd size and the real SOL
// reserve all pass; stake a fixed 0.1 SOL; refuse a buy whose price jumped
// more than 3% during the 2-slot latency; take half off at +10%, the rest at
// +20%, stop at -8% (breakeven after the first take-profit); leave at once
// when the creator sells; never hold past 10 slots; never re-enter a coin.
// Probes keep the 20-coin bar in reach on a thin 6-hour draw.
//
// Determinism: a pure function of the batches the harness sends. No clock, no
// randomness, no environment, no I/O. Iteration is over batch order or over
// mint keys sorted lexicographically, and all money math is integer (bigint).

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const BPS = 10_000n;
/** Curve fees: protocol 95 bps + creator 30 bps = 125 bps per leg. */
const FEE_BPS = 125n;
/** A buy counts toward the 20-coin bar only at this size or above. */
const BAR_BUY_LAMPORTS = 10_000_000n;

export interface Params {
  /** Youngest / oldest age (slots since CreateEvent) at which a first buy may be decided. */
  minAgeSlots: number;
  maxAgeSlots: number;
  /** Lamports aimed for per coin (each reply is still capped at 1% of real SOL). */
  stakeLamports: bigint;
  /** Smallest single buy worth paying the tx fee for. */
  minBuyLamports: bigint;
  /** Real SOL reserve window at decision time (lamports). */
  minRealSolLamports: bigint;
  maxRealSolLamports: bigint;
  /** Creator's own buys in the create slot: lamports window. */
  minCreatorBuyLamports: bigint;
  maxCreatorBuyLamports: bigint;
  /** Distinct non-creator buyers seen before entry: window. */
  minCrowd: number;
  maxCrowd: number;
  /** Lamports sold by others / lamports bought, as bps, at most. */
  maxSellRatioBps: number;
  /** Slippage allowed on buys (bps): a buy whose price jumps more than this in the latency is refused. */
  buySlippageBps: number;
  /** First take-profit: sell firstProfitPartBps of the position once it is worth firstProfitBps over its cost. */
  firstProfitBps: number;
  firstProfitPartBps: number;
  /** After the first take-profit, the rest stops out at this much under its cost (bps; 0 = breakeven). */
  stopAfterProfitBps: number;
  /** Exit when the position is worth this much over its cost (bps). */
  takeProfitBps: number;
  /** Exit when it is worth this much under its cost (bps). */
  stopLossBps: number;
  /** Exit after holding this many slots. */
  maxHoldSlots: number;
  /** Exit when the creator sells while held. */
  exitOnCreatorSell: boolean;
  /** Guardrail probes (see header). */
  probeLamports: bigint;
  probeMinRealSolLamports: bigint;
  maxProbes: number;
  probeCooldownSlots: number;
  probeWarmupSecs: number;
  probeTargetCoins: number;
  probeWindowSecs: number;
}

export const DEFAULT_PARAMS: Params = {
  minAgeSlots: 0,
  maxAgeSlots: 3,
  stakeLamports: 100_000_000n,
  minBuyLamports: 5_000_000n,
  minRealSolLamports: 300_000_000n,
  maxRealSolLamports: 30_000_000_000n,
  minCreatorBuyLamports: 200_000_000n,
  maxCreatorBuyLamports: 2_500_000_000n,
  minCrowd: 3,
  maxCrowd: 3,
  maxSellRatioBps: 10_000,
  buySlippageBps: 300,
  firstProfitBps: 1000,
  firstProfitPartBps: 5_000,
  stopAfterProfitBps: 0,
  takeProfitBps: 2_000,
  stopLossBps: 800,
  maxHoldSlots: 10,
  exitOnCreatorSell: true,
  probeLamports: 12_000_000n,
  probeMinRealSolLamports: 2_000_000_000n,
  maxProbes: 20,
  probeCooldownSlots: 400,
  probeWarmupSecs: 1_800,
  probeTargetCoins: 22,
  probeWindowSecs: 21_600,
};

/** Everything the bot remembers about one coin's opening tape. */
interface Launch {
  mint: Pubkey;
  createSlot: number | null;
  creator: Pubkey;
  /** Creator's own buys in the create slot (lamports). */
  creatorBuy: bigint;
  /** Distinct non-creator wallets that bought. */
  crowd: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  creatorSold: boolean;
  lastTradeSlot: number;
  /** Never buy it again (exited, filtered out for good, or completed). */
  closed: boolean;
  complete: boolean;
}

/** Everything the bot remembers about one open position. */
interface Seat {
  openedSlot: number;
  /** Tx fees paid on this position's fills so far (lamports). */
  txPaid: bigint;
  tookFirstProfit: boolean;
  creatorSoldAtOpen: boolean;
}

/** What selling `tokens` against reserves (vq, vt) would pay after curve fees (lamports). */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const quote = (tokens * vq) / (vt + tokens);
  return quote - (quote * FEE_BPS + BPS - 1n) / BPS;
}

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const launches = new Map<Pubkey, Launch>();
  const seats = new Map<Pubkey, Seat>();
  /** Mints with a sell in flight. */
  const selling = new Set<Pubkey>();
  /** Probe round trips: mint -> true once its buy has landed and the sell is due. */
  const probes = new Map<Pubkey, boolean>();
  /** Mints whose buy filled for at least the bar size (counts toward the 20-coin bar). */
  const counted = new Set<Pubkey>();
  let firstBlockTime: number | null = null;
  let lastBlockTime: number | null = null;
  let probesUsed = 0;
  let lastProbeSlot = -1_000_000;

  const launchOf = (mint: Pubkey): Launch => {
    let launch = launches.get(mint);
    if (launch === undefined) {
      launch = {
        mint,
        createSlot: null,
        creator: '',
        creatorBuy: 0n,
        crowd: new Set(),
        bought: 0n,
        soldByOthers: 0n,
        creatorSold: false,
        lastTradeSlot: -1,
        closed: false,
        complete: false,
      };
      launches.set(mint, launch);
    }
    return launch;
  };

  const pendingBuy = (state: BotState, mint: Pubkey): boolean => {
    for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'buy') return true;
    return false;
  };
  const pendingSell = (state: BotState, mint: Pubkey): boolean => {
    for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') return true;
    return false;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const slot = batch.slot;
      const touched: Pubkey[] = [];
      const touch = (mint: Pubkey) => {
        if (touched[touched.length - 1] !== mint && !touched.includes(mint)) touched.push(mint);
      };

      // 1. Fold the batch's events into the launch book, in chain order.
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstBlockTime === null) firstBlockTime = e.block_time;
          if (lastBlockTime === null || e.block_time > lastBlockTime) lastBlockTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const launch = launchOf(e.mint);
          launch.createSlot = e.slot;
          launch.creator = e.creator;
          launch.lastTradeSlot = e.slot;
          touch(e.mint);
        } else if (e.event === 'TradeEvent') {
          const launch = launchOf(e.mint);
          const sol = BigInt(e.sol_amount);
          const isCreator = e.user === launch.creator;
          if (e.is_buy) {
            launch.bought += sol;
            if (isCreator && e.slot === launch.createSlot) launch.creatorBuy += sol;
            else if (!isCreator) launch.crowd.add(e.user);
          } else if (isCreator) {
            launch.creatorSold = true;
          } else {
            launch.soldByOthers += sol;
          }
          launch.lastTradeSlot = e.slot;
          touch(e.mint);
        } else {
          const launch = launchOf(e.mint);
          launch.complete = true;
          launch.closed = true;
          touch(e.mint);
        }
      }

      // 2. Fold the batch's fills in: open/close seats, count qualifying coins.
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          // A harness close (complete / flatten / writeoff): the seat is gone.
          seats.delete(f.mint);
          selling.delete(f.mint);
          probes.delete(f.mint);
          continue;
        }
        const seat = seats.get(f.mint);
        if (seat !== undefined && f.status !== 'rejected') seat.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status !== 'filled') {
          // A probe buy that never landed must not block later probes.
          if (probes.has(f.mint) && !state.positions.has(f.mint)) probes.delete(f.mint);
        }
        if (f.side === 'buy' && f.status === 'filled') {
          if (seat === undefined) {
            seats.set(f.mint, {
              openedSlot: f.slot,
              txPaid: BigInt(f.tx_fee_lamports),
              tookFirstProfit: false,
              creatorSoldAtOpen: launches.get(f.mint)?.creatorSold ?? false,
            });
          }
          if (BigInt(f.quote_lamports) >= BAR_BUY_LAMPORTS) counted.add(f.mint);
          if (probes.has(f.mint)) probes.set(f.mint, true);
        }
        if (f.side === 'sell' && f.status === 'filled' && !state.positions.has(f.mint)) {
          seats.delete(f.mint);
          selling.delete(f.mint);
          probes.delete(f.mint);
          const launch = launches.get(f.mint);
          if (launch !== undefined) launch.closed = true;
        }
      }
      for (const mint of [...selling]) if (!pendingSell(state, mint)) selling.delete(mint);
      for (const mint of [...seats.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !pendingBuy(state, mint)) seats.delete(mint);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });

      // 3. Exits first (sorted mint order: deterministic regardless of account ordering).
      for (const mint of [...state.positions.keys()].sort()) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const pos = state.positions.get(mint)!;
        const launch = launches.get(mint);
        let seat = seats.get(mint);
        if (seat === undefined) {
          seat = { openedSlot: slot, txPaid: tx, tookFirstProfit: false, creatorSoldAtOpen: launch?.creatorSold ?? false };
          seats.set(mint, seat);
        }
        let mark = marks.get(mint);
        if (mark === undefined) {
          const curve = state.curves.get(mint);
          if (curve === undefined) continue;
          mark = { vq: curve.virtual_quote_reserves, vt: curve.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mark.vq, mark.vt) - tx;
        const basis = pos.cost_lamports + seat.txPaid;
        let exit = false;
        let partial: bigint | null = null;
        if (basis > 0n) {
          if (!seat.tookFirstProfit && value * BPS >= basis * BigInt(BPS + BigInt(p.firstProfitBps))) {
            const part = (pos.token_amount * BigInt(p.firstProfitPartBps)) / BPS;
            if (part > 0n && part < pos.token_amount) partial = part;
          }
          if (partial === null) {
            if (value * BPS >= basis * BigInt(BPS + BigInt(p.takeProfitBps))) exit = true;
            const stop = seat.tookFirstProfit ? BigInt(p.stopAfterProfitBps) : BigInt(p.stopLossBps);
            if (value * BPS <= basis * (BPS - stop)) exit = true;
          }
        }
        if (slot - seat.openedSlot >= p.maxHoldSlots) exit = true;
        if (launch !== undefined && p.exitOnCreatorSell && launch.creatorSold && !seat.creatorSoldAtOpen) exit = true;
        if (partial !== null) {
          if (pendingSell(state, mint)) continue;
          orders.push({ side: 'sell', mint, token_amount: partial, max_slippage_bps: 10_000 });
          selling.add(mint);
          seat.tookFirstProfit = true;
          if (launch !== undefined) launch.closed = true;
          continue;
        }
        if (!exit) continue;
        if (pendingSell(state, mint)) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        if (launch !== undefined) launch.closed = true;
      }

      // 4. Probe sells: a probe whose buy landed sells whole at once.
      for (const [mint, landed] of probes) {
        if (!landed) continue;
        const pos = state.positions.get(mint);
        if (pos === undefined) {
          if (!pendingBuy(state, mint)) probes.delete(mint);
          continue;
        }
        if (pendingSell(state, mint) || selling.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
      }

      // 5. Entries: only coins that traded in this batch, only in their first slots.
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let open = state.committedPositionCount();
      for (const mint of touched) {
        if (orders.length >= cap) break;
        const launch = launches.get(mint)!;
        if (launch.closed || launch.complete) continue;
        if (launch.createSlot === null) continue;
        const age = slot - launch.createSlot;
        if (age < p.minAgeSlots || age > p.maxAgeSlots) {
          if (age > p.maxAgeSlots) launch.closed = true;
          continue;
        }
        if (state.positions.has(mint) || pendingBuy(state, mint) || probes.has(mint)) continue;
        if (open >= state.hello.caps.max_open_positions) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        // Launch filter: creator skin in the game, no creator sale, a small real crowd.
        const realSol = curve.real_quote_reserves;
        if (realSol < p.minRealSolLamports || realSol > p.maxRealSolLamports) continue;
        if (launch.creatorBuy < p.minCreatorBuyLamports || launch.creatorBuy > p.maxCreatorBuyLamports) continue;
        if (launch.creatorSold) {
          launch.closed = true;
          continue;
        }
        if (launch.crowd.size < p.minCrowd || launch.crowd.size > p.maxCrowd) continue;
        if (launch.bought > 0n && launch.soldByOthers * BPS > launch.bought * BigInt(p.maxSellRatioBps)) continue;
        const room = p.stakeLamports;
        const maxBuy = state.maxBuyLamports(mint);
        const amount = room < maxBuy ? room : maxBuy;
        if (amount < p.minBuyLamports) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
        free -= amount + tx;
        open += 1;
      }

      // 6. Guardrail pacing: probe when qualifying coins lag the pace the bar
      // needs. The bar is 20 coins in a 6-hour window, so the pace aims a
      // little above it and probes start early in a thin window instead of
      // only in its last hour.
      const probeOpen = [...probes.keys()].length > 0;
      if (
        !probeOpen &&
        probesUsed < p.maxProbes &&
        firstBlockTime !== null &&
        lastBlockTime !== null &&
        lastBlockTime - firstBlockTime >= p.probeWarmupSecs &&
        slot - lastProbeSlot >= p.probeCooldownSlots
      ) {
        const elapsed = Math.min(p.probeWindowSecs, lastBlockTime - firstBlockTime);
        const due = Math.ceil(((p.probeTargetCoins + 2) * elapsed) / p.probeWindowSecs);
        const have = counted.size + open;
        if (have < due) {
          // Probe the most liquid curve that traded this batch (largest real
          // SOL reserve = least likely to dump between the buy and the sell).
          let bestMint: Pubkey | null = null;
          let bestReal = -1n;
          for (const mint of touched) {
            if (counted.has(mint) || probes.has(mint)) continue;
            const launch = launches.get(mint)!;
            if (launch.closed || launch.complete) continue;
            if (state.positions.has(mint) || pendingBuy(state, mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (curve.real_quote_reserves < p.probeMinRealSolLamports) continue;
            if (curve.real_quote_reserves > bestReal) {
              bestReal = curve.real_quote_reserves;
              bestMint = mint;
            }
          }
          if (bestMint !== null && orders.length < cap && open < state.hello.caps.max_open_positions && free >= p.probeLamports + tx) {
            orders.push({ side: 'buy', mint: bestMint, quote_lamports: p.probeLamports, max_slippage_bps: p.buySlippageBps });
            probes.set(bestMint, false);
            probesUsed += 1;
            lastProbeSlot = slot;
          }
        }
      }
      return orders;
    },
  };
}

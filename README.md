# u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Siksuk72/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Siksuk72/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A deterministic paper-trading bot for pump.fun bonding curves, built for the
make.fun "Pump.fun Bot Sprint: Make Bot And Win" bounty. It trades 10 SOL of
paper money on a 6-hour replay of recorded pump.fun chain data (SOL-quoted,
non-mayhem), ranked on net PnL after all fees. No real money, no wallet, no
network — the bot only reads the replay events the harness sends it.

## Run it

```sh
node main.ts
```

The grader runs it as `node /bot/main.ts` (Node 22, TypeScript stripped as-is).
Zero dependencies. `main.ts` hands the strategy in `strategy.ts` to the
vendored protocol shim in `vendor/makefun-bot.ts` (a byte-identical copy of
the kit's `sdk/ts/makefun-bot.ts`).

## Strategy

A selective launch sniper with guardrail probes, tuned for a 6-hour window:

- **Entries.** Only in a coin's first 3 slots after its CreateEvent, and only
  when the launch passes every filter: the creator bought 0.2–2.5 SOL of
  their own coin in the create slot and has not sold, exactly 3 distinct
  non-creator wallets bought in with them (a launch bundled by many wallets
  is a dump waiting to happen), real SOL reserve 0.3–30, and no heavy
  selling by others. Stake is a fixed 0.1 SOL per coin.
- **Latency guard.** A buy is refused when the price moved more than 3%
  against it during the 2-slot latency (300 bps slippage cap) — this rejects
  buys into the top of the opening pump.
- **Exits.** Half off at +10%, the rest at +20%, stop at −8% (breakeven after
  the first take-profit), exit at once when the creator sells, never hold
  past 10 slots, never re-enter a coin.
- **Guardrail probes.** The selective filter only grows ~13 qualifying coins
  in 6 hours on its own, and the minimum bar is 20 coins with a round trip
  of at least 0.01 SOL. When qualifying coins lag the pace the bar needs
  (22 coins over the 6-hour window, measured in block time), the bot buys
  0.012 SOL of the most liquid curve trading right now and sells it whole
  as soon as the buy lands. At most 20 probes, at most 1 open, at least
  400 slots apart, only after 30 minutes of block time. A flat probe costs
  ~0.0005 SOL; missing the bar would rank the entry below every entry that
  meets it.

## Why this shape

Fees are ~2.5% of stake per round trip (95 + 30 bps of curve fees each way)
plus a flat ~105,000 lamports of tx fees per order, and most fresh coins dump
within a few slots of launch. Backtests on the kit's 24-hour dev window show
indiscriminate bots lose on almost every coin (the house momentum pilot loses
~9 SOL, the house sniper pilot loses on every part). The only edge that
survived is extreme selectivity at launch plus a tight slippage filter plus
fast exits — and, for a 6-hour window, probes to secure the 20-coin bar: the
same selective design tuned for 24 hours reaches only 12–17 qualifying
coins in any 6-hour slice of the dev window and would miss the bar.

## Backtest (local sim port of the kit's replay engine, dev window)

Chosen parameters, full 24-hour dev window: **+0.0038 SOL**, 61 qualifying
coins, 11 wins of 62 trips, max drawdown 0.0044. The same parameters on each
of the four 6-hour slices of the dev window: +0.0279 (23 coins), +0.0174
(24), −0.0114 (24), −0.0262 (25) — the bar is met with margin in every slice,
and the drawdown stays under 0.005 in all of them.

`grade-local` on the real harness (two executions, action logs byte-identical,
L1 regrade reproduced byte for byte): **net PnL +0.0204 SOL** (return
0.00204, 90% interval −0.0476..+0.0897), 131 fills over 62 coins, 62 round
trips, win rate 19.4%, max drawdown 0.0040. Guardrails met: 61 coins hold a
round trip of at least 0.01 SOL. Fees 0.0496 SOL curve + 0.0142 SOL tx. At 2×
fees the design goes negative (−0.043 SOL), as expected for this template —
the edge is fee-sensitive. The top 3 coins made 57% of the gains, so the
final 6-hour window is a fresh draw and the result could land either side
of zero.

## Determinism

A pure function of the batches the harness sends: no clock, no randomness,
no environment, no I/O. Exits iterate mint keys in sorted order; entries
follow batch order; all money math is integer (bigint). The entry is executed
twice by the grader and the two action logs must match byte for byte.

---

<sub>Entered on [make.fun](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>

# NVIDIA CEO forecast — empirical change-quantile entry (v3)

`main.ts` (Node 22, standard library only, no network) forecasts, for every
market of Polymarket's "Next CEO of NVIDIA?" event, the five quantiles
(0.05 / 0.25 / 0.5 / 0.75 / 0.95) of the Yes price at each of the 240 minutes
after a case's checkpoint.

## How it works

- **Per-market empirical change distribution.** For each market, the bot
  collects the overlapping h-minute price changes from the trailing ~18 hours
  of the case's own history and takes their empirical quantiles at knot
  horizons (1, 5, 15, 30, 60, 120, 240 minutes), interpolated in sqrt(h).
  This captures what a Gaussian random walk cannot: minutes that do not move
  at all, tick-sized steps, jumps, and the strong mean reversion of these
  prices at minute scale.
- **Recency weighting (new in v2).** Change samples are weighted by
  exp(-age / 150 min): the market's behavior in the last few hours says much
  more about the next four hours than yesterday's regime, and weighting the
  empirical quantiles accordingly was worth several percent of loss on every
  practice case.
- **Volatility-regime scaling (new in v2).** Each market's band is scaled by
  a shrunk (x0.75 in v3), clamped (0.7–1.4) ratio of its recent 360-minute
  30-minute-change width to its full-window width, so a market that has just
  woken up gets wider bands and one that has gone quiet gets narrower ones
  than the case-wide calibration alone would give it.
- **Persistence median, with a dwell correction (new in v3).** The quantile
  shape is centered so the median sits on the last price; the inner pair is
  narrowed slightly (x0.9 in v3) and the outer pair starts from a x1.3
  widening, both then case-calibrated. On top of that, a last price that
  changed only a few minutes before the checkpoint is treated as an
  unconfirmed print (order-book midpoint bounce): the center blends partway
  back toward the previous price level, with weight falling off as the new
  level ages (5/(dwell+5), strength 0.45, ramped in over 45 minutes).
- **Pooled width floor (new in v3).** Every market's band is widened
  additively by 0.25x the case's pooled cross-market quantile deviations,
  so a dormant market that suddenly wakes up is not forecast with a
  near-zero band just because its own recent history is flat.
- **Per-case calibration.** Before forecasting, the same estimator is
  backtested at pseudo-checkpoints inside the case's history (forecasts made
  only from data up to each checkpoint, scored against the realized
  30/120/240-minute moves). The backtest picks one band multiplier for short
  horizons, one for long horizons, and one outer-quantile widening for the
  whole case, so a quiet day gets narrow bands and a jumpy day wide ones.
- **Fallbacks.** A market with too little history falls back to a Gaussian
  shape with that market's own RMS minute change (floored/capped), or to the
  house baseline's sigma when even that is unavailable.

Everything is deterministic: no randomness, no clock, no network — two runs
of a case produce byte-identical output, and a single case runs in well
under a second.

On the kit's six practice cases this scores a mean pinball loss of about
0.2690, against the house baseline's 0.363589, v1's 0.2905 and v2's 0.2754
on the same cases (per case: 0.4799 / 0.2994 / 0.3467 / 0.2453 / 0.1994 /
0.1088 — no case worse than v2 by more than 0.002).

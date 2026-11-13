# NVIDIA CEO forecast — empirical change-quantile entry

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
- **Persistence median.** The quantile shape is centered so the median sits
  on the last price; the inner pair is narrowed slightly (x0.8) and the
  outer pair starts from a x1.3 widening, both then case-calibrated.
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
0.2905, against the house baseline's 0.363589 on the same cases.

// polymarket-nvidia-ceo-forecast-01 entry: per-market empirical change quantiles.
//
// Model: for each market, the distribution of the price change over h minutes is
// estimated from the case's own history (trailing window of overlapping h-step
// changes), at knot horizons, interpolated in sqrt(h). The shape is blended
// toward the Gaussian baseline shape when a market has little history and
// centered so the median sits on the (possibly reversion-adjusted) last price.
// Band multipliers (short/long horizon), an outer-quantile widening and a
// spike-reversion strength are calibrated per case by backtesting the same
// estimator at pseudo-checkpoints inside the history, shrunk toward defaults.
// Deterministic; standard library only.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.644854, -0.67449, 0, 0.67449, 1.644854];

const CFG = {"mode":"emp","W":1080,"W2":0,"knots":[1,5,15,30,60,120,240],"calibrate":true,"calSplit":true,"splitH":90,"mGrid":[0.6,0.75,0.9,1,1.1,1.25,1.45,1.7,2],"tailGrid":[1,1.15,1.3,1.5],"revertGrid":[0],"calHorizons":[30,120,240],"calStep":240,"shrink":1,"tailShrink":1,"revertShrink":1,"baseSigma":0.0025,"sigmaFloor":0.0004,"sigmaCap":0.012,"centerMedian":true,"tailW":1.3,"innerW":0.8,"blendRamp":0,"minSamples":30,"debug":false};

interface CaseMarket { id: string; prices: number[]; }
interface Case { horizon_minutes: number; quantiles: number[]; markets: CaseMarket[]; }

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const price6 = (x: number): number => Math.round(clamp01(x) * 1e6) / 1e6 + 0;

/** Quantile of a sorted array, linear interpolation (same rule at every call). */
function quantileOf(sorted: Float64Array, tau: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];
  const pos = tau * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(n - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function medianOf(values: number[]): number {
  const s = Float64Array.from(values).sort();
  return quantileOf(s, 0.5);
}

interface ChangeQ { q: number[]; count: number; }

/**
 * Empirical quantiles of the h-step price changes whose windows end at or
 * before index `end`, using at most the last W change samples, plus the
 * sample count. Returns null when too few samples exist.
 */
function changeQuantiles(prices: number[], end: number, h: number, W: number): ChangeQ | null {
  const lastStart = end - h;
  if (lastStart < 0) return null;
  const count = Math.min(W, lastStart + 1);
  if (count < CFG.minSamples) return null;
  const firstStart = lastStart - count + 1;
  const changes = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const t = firstStart + i;
    changes[i] = prices[t + h] - prices[t];
  }
  changes.sort();
  return { q: QUANTILES.map((tau) => quantileOf(changes, tau)), count };
}

/** Gaussian shape: z * sigma * sqrt(h). */
function gaussShape(sigma: number, h: number): number[] {
  return Z.map((z) => z * sigma * Math.sqrt(h));
}

/** Per-market diffusion sigma: RMS of 1-minute changes over the trailing window. */
function marketSigma(prices: number[], W: number): number {
  const n = prices.length;
  const count = Math.min(W, n - 1);
  if (count < 10) return CFG.baseSigma;
  let ss = 0;
  for (let i = n - count; i < n; i++) {
    const d = prices[i] - prices[i - 1];
    ss += d * d;
  }
  const s = Math.sqrt(ss / count);
  return Math.min(CFG.sigmaCap, Math.max(CFG.sigmaFloor, s));
}

/**
 * Raw change-quantile shape at horizon h for data ending at `end`: empirical
 * quantiles (averaged over a second window when W2 is set), blended toward the
 * baseline Gaussian shape when the sample count is low, median centered on 0.
 * Null when no empirical estimate exists.
 */
function rawShape(prices: number[], end: number, h: number): number[] | null {
  if (CFG.mode !== 'emp') return null;
  const cq = changeQuantiles(prices, end, h, CFG.W);
  if (!cq) return null;
  let q = cq.q;
  if (CFG.W2 > 0) {
    const cq2 = changeQuantiles(prices, end, h, CFG.W2);
    if (cq2) q = q.map((v, i) => 0.5 * (v + cq2.q[i]));
  }
  if (CFG.blendRamp > 0) {
    const w = Math.min(1, cq.count / CFG.blendRamp);
    if (w < 1) {
      const g = gaussShape(CFG.baseSigma, h);
      q = q.map((v, i) => w * v + (1 - w) * g[i]);
    }
  }
  if (CFG.centerMedian) {
    const med = q[2];
    q = q.map((v, t) => (t === 2 ? 0 : v - med));
  }
  return q;
}

/** Widen/narrow the outer (tailW) and inner (innerW) pairs around the median. */
function spreadAdjust(shape: number[], tailW: number, innerW: number): number[] {
  if (tailW === 1 && innerW === 1) return shape;
  const med = shape[2];
  return shape.map((v, t) => (t === 0 || t === 4 ? med + (v - med) * tailW : t === 2 ? v : med + (v - med) * innerW));
}

/** Interpolated raw shape at horizon h from knot shapes (sqrt scale). */
function shapeAt(knotQ: (number[] | null)[], knots: number[], h: number): number[] | null {
  let below: { h: number; q: number[] } | null = null;
  let above: { h: number; q: number[] } | null = null;
  for (let i = 0; i < knots.length; i++) {
    const q = knotQ[i];
    if (!q) continue;
    if (knots[i] <= h) below = { h: knots[i], q };
    if (knots[i] >= h && !above) above = { h: knots[i], q };
  }
  if (!below && !above) return null;
  if (!below) return above!.q.map((v) => v * Math.sqrt(h / above!.h));
  if (!above) return below.q.map((v) => v * Math.sqrt(h / below.h));
  if (above.h === below.h) return below.q;
  const s = Math.sqrt(h), s0 = Math.sqrt(below.h), s1 = Math.sqrt(above.h);
  const w = (s - s0) / (s1 - s0);
  return below.q.map((v, i) => v + (above!.q[i] - v) * w);
}

/** Raw shape at (end, h) without knots: empirical, else Gaussian fallback. */
function directShape(m: CaseMarket, end: number, h: number): number[] {
  const s = rawShape(m.prices, end, h);
  if (s) return s;
  if (CFG.mode === 'gauss') return gaussShape(CFG.baseSigma, h);
  return gaussShape(marketSigma(m.prices.slice(0, end + 1), CFG.W), h);
}

/** Reversion anchor at index e: median price over [e-35, e-5]; falls back to p[e]. */
function anchorAt(p: number[], e: number): number {
  const lo = Math.max(0, e - 35);
  const hi = e - 5;
  if (hi - lo < 10) return p[e];
  return medianOf(p.slice(lo, hi + 1));
}

interface Cal { multAt: (h: number) => number; tailW: number; revertK: number; }

/**
 * Calibrate the case's band multiplier(s), tail widening and reversion
 * strength by backtesting the estimator at pseudo-checkpoints (only data up
 * to the checkpoint, realized moves after), scoring pinball over the
 * calibration horizons; shrink each toward its default.
 */
function calibrate(markets: CaseMarket[]): Cal {
  const plain = (): Cal => ({ multAt: () => 1, tailW: CFG.tailW, revertK: 0 });
  if (!CFG.calibrate) return plain();
  type Item = { x: number; anchor: number; y: number; h: number; shape: number[] };
  const items: Item[] = [];
  const maxH = CFG.calHorizons[CFG.calHorizons.length - 1];
  for (const m of markets) {
    const p = m.prices;
    const n = p.length;
    for (let e = n - 1 - maxH; e >= 480; e -= CFG.calStep) {
      const anchor = anchorAt(p, e);
      for (const h of CFG.calHorizons) {
        if (e + h > n - 1) continue;
        items.push({ x: p[e], anchor, y: p[e + h], h, shape: directShape(m, e, h) });
      }
    }
  }
  if (items.length < 50) return plain();
  const buckets: Item[][] = CFG.calSplit
    ? [items.filter((it) => it.h <= CFG.splitH), items.filter((it) => it.h > CFG.splitH)]
    : [items];
  if (buckets.some((b) => b.length === 0)) return plain();
  let bestLoss = Infinity;
  let bestM: number[] = buckets.map(() => 1);
  let bestT = CFG.tailW, bestK = 0;
  for (const tailW of CFG.tailGrid) {
    for (const k of CFG.revertGrid) {
      // per bucket: adjusted shapes under this (tailW, k), then best multiplier
      let total = 0;
      const ms: number[] = [];
      for (const bucket of buckets) {
        const adj = bucket.map((it) => spreadAdjust(it.shape, tailW, CFG.innerW));
        const ctr = bucket.map((it) => it.x - k * (it.x - it.anchor));
        let bLoss = Infinity, bM = 1;
        for (const mult of CFG.mGrid) {
          let loss = 0;
          for (let i = 0; i < bucket.length; i++) {
            for (let t = 0; t < 5; t++) {
              const qq = clamp01(ctr[i] + mult * adj[i][t]);
              const d = bucket[i].y - qq;
              loss += Math.max(QUANTILES[t] * d, (QUANTILES[t] - 1) * d);
            }
          }
          if (loss < bLoss) { bLoss = loss; bM = mult; }
        }
        total += bLoss;
        ms.push(bM);
      }
      if (total < bestLoss) { bestLoss = total; bestM = ms; bestT = tailW; bestK = k; }
    }
  }
  const mS = 1 + CFG.shrink * (bestM[0] - 1);
  const mL = 1 + CFG.shrink * ((bestM[1] ?? bestM[0]) - 1);
  const tailW = CFG.tailW + CFG.tailShrink * (bestT - CFG.tailW);
  const revertK = CFG.revertShrink * bestK;
  const multAt = (h: number): number => {
    if (!CFG.calSplit) return mS;
    if (h <= CFG.splitH) return mS;
    if (h >= 240) return mL;
    const w = (Math.sqrt(h) - Math.sqrt(CFG.splitH)) / (Math.sqrt(240) - Math.sqrt(CFG.splitH));
    return mS + (mL - mS) * w;
  };
  return { multAt, tailW, revertK };
}

function forecastMarket(m: CaseMarket, horizon: number, cal: Cal): number[][] {
  const p = m.prices;
  if (p.length === 0) {
    return Array.from({ length: horizon }, () => [0.5, 0.5, 0.5, 0.5, 0.5]);
  }
  const end = p.length - 1;
  const x = p[end] - cal.revertK * (p[end] - anchorAt(p, end));
  const knotQ = CFG.mode === 'emp' ? CFG.knots.map((h) => rawShape(p, end, h)) : null;
  const sigma = CFG.mode === 'gauss' ? CFG.baseSigma : marketSigma(p, CFG.W);
  const rows: number[][] = [];
  for (let h = 1; h <= horizon; h++) {
    let s: number[] | null = knotQ ? shapeAt(knotQ, CFG.knots, h) : null;
    if (!s) s = gaussShape(sigma, h);
    const adj = spreadAdjust(s, cal.tailW, CFG.innerW);
    const row = adj.map((v) => price6(x + cal.multAt(h) * v));
    for (let t = 1; t < 5; t++) if (row[t] < row[t - 1]) row[t] = row[t - 1];
    rows.push(row);
  }
  return rows;
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.quantiles.length !== QUANTILES.length || c.quantiles.some((t, j) => t !== QUANTILES[j])) {
    throw new Error(`${file} asks for quantiles ${JSON.stringify(c.quantiles)}, not ${JSON.stringify(QUANTILES)}`);
  }
  const cal = calibrate(c.markets);
  if (CFG.debug) console.error(`${id}: tailW ${cal.tailW.toFixed(2)} revertK ${cal.revertK.toFixed(2)}`);
  const forecasts = c.markets.map((m) => ({ id: m.id, q: forecastMarket(m, c.horizon_minutes, cal) }));
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ forecasts })}\n`);
}

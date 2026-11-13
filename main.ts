// polymarket-nvidia-ceo-forecast-01 entry v3: v2's recency-weighted empirical
// change quantiles, plus three structural refinements:
//  - dwell (level-age) center: a last price that changed only a few minutes
//    ago is an unconfirmed print (midpoint bounce), so the center blends
//    partway back toward the previous level, with weight 5/(dwell+5) and
//    strength 0.45, ramped in over the first 45 forecast minutes. A level
//    that has sat for a long time is taken at face value.
//  - pooled width floor: every market's band is widened additively by 0.25x
//    the case's pooled (cross-market median) absolute quantile deviations,
//    so a dormant market that suddenly wakes up is not forecast with a
//    near-zero band just because its own recent history is flat.
//  - calibration ranges widened downward (band multipliers from 0.5) and the
//    vol-regime shrink raised to 0.75, letting quiet cases calibrate
//    narrower; inner-pair default widening 0.9.
// Deterministic; standard library only.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.644854, -0.67449, 0, 0.67449, 1.644854];

const CFG = {"mode": "emp", "W": 1080, "W2": 0, "knots": [1, 5, 15, 30, 60, 120, 240], "calibrate": true, "calSplit": true, "splitH": 90, "mGrid": [0.5, 0.6, 0.75, 0.9, 1, 1.1, 1.25, 1.45, 1.7, 2], "tailGrid": [1, 1.15, 1.3, 1.5], "revertGrid": [0], "calHorizons": [30, 120, 240], "calStep": 240, "shrink": 1, "tailShrink": 1, "revertShrink": 1, "baseSigma": 0.0025, "sigmaFloor": 0.0004, "sigmaCap": 0.012, "centerMedian": true, "tailW": 1.3, "innerW": 0.9, "blendRamp": 0, "minSamples": 30, "debug": false, "direct": 0, "wDecay": 150, "wDecayOut": -1, "WOut": 4320, "dwellK": 0.45, "dwellB": 5, "dwellRamp": 45, "poolFloor": 0.25, "flipGate": 0, "flipOuter": 0, "youngWin": 0, "youngScale": 1.5, "wH": 0, "pairCal": 0, "mInGrid": [0.45, 0.6, 0.75, 0.9, 1.05, 1.25, 1.5], "mOutGrid": [0.6, 0.8, 1, 1.2, 1.45, 1.7, 2, 2.4], "pairDefIn": 0.8, "pairDefOut": 1.3, "regime": 0.75, "regimeWin": 360, "regimeH": 30, "revRamp": 0, "revAnchorWin": 720, "revGrid": [0, 0.15, 0.3], "revShrink": 0.5, "revShape": "sqrt", "interpPow": 0.5, "pool": 0, "poolCount": 400};

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

/** Weighted quantile of sorted values with matching weights (midpoint rule). */
function weightedQuantileOf(sorted: Float64Array, wts: Float64Array, tau: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];
  let total = 0;
  for (let i = 0; i < n; i++) total += wts[i];
  let cum = 0;
  let prevU = 0, prevV = sorted[0];
  for (let i = 0; i < n; i++) {
    const u = (cum + wts[i] / 2) / total;
    if (tau <= u) {
      if (i === 0) return sorted[0];
      const span = u - prevU;
      return span > 0 ? prevV + (sorted[i] - prevV) * ((tau - prevU) / span) : sorted[i];
    }
    cum += wts[i];
    prevU = u; prevV = sorted[i];
  }
  return sorted[n - 1];
}

function medianOf(values: number[]): number {
  const s = Float64Array.from(values).sort();
  return quantileOf(s, 0.5);
}

interface ChangeQ { q: number[]; count: number; }

/** Effective estimation window at horizon h (wH = target window at h=240). */
function effWindow(h: number): number {
  if (!CFG.wH) return CFG.W;
  return Math.round(CFG.W + (CFG.wH - CFG.W) * Math.sqrt(h / 240));
}

/**
 * Empirical quantiles of the h-step price changes whose windows end at or
 * before index `end`, using at most the last W change samples (optionally
 * recency-weighted with exponential decay wDecay in minutes). Null when too
 * few samples exist.
 */
function changeQuantiles(prices: number[], end: number, h: number, W: number, decayOv?: number): ChangeQ | null {
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
  const decay = decayOv !== undefined ? decayOv : CFG.wDecay;
  if (decay > 0) {
    const order = Array.from({ length: count }, (_, i) => i).sort((a, b) => changes[a] - changes[b]);
    const sorted = new Float64Array(count);
    const wts = new Float64Array(count);
    for (let r = 0; r < count; r++) {
      const i = order[r];
      sorted[r] = changes[i];
      const endIdx = firstStart + i + h; // change ends at this price index
      wts[r] = Math.exp(-(end - endIdx) / decay);
    }
    return { q: QUANTILES.map((tau) => weightedQuantileOf(sorted, wts, tau)), count };
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
  const r = rawShapeC(prices, end, h);
  return r ? r.q : null;
}

/** rawShape plus the change-sample count behind it. */
function rawShapeC(prices: number[], end: number, h: number): ChangeQ | null {
  if (CFG.mode !== 'emp') return null;
  const cq = changeQuantiles(prices, end, h, effWindow(h));
  if (!cq) return null;
  let q = cq.q;
  if (CFG.wDecayOut >= 0) {
    const cqO = changeQuantiles(prices, end, h, CFG.WOut, CFG.wDecayOut);
    if (cqO) q = [cqO.q[0], q[1], q[2], q[3], cqO.q[4]];
  }
  if (CFG.flipGate > 0) {
    // State-flip gate: when the full-history change width at this horizon is
    // much wider than the trailing-window width, this market flips between
    // regimes; trust the long-memory shape instead of the calm recent one.
    const cqF = changeQuantiles(prices, end, h, 4320, 0);
    if (cqF) {
      const wF = cqF.q[3] - cqF.q[1];
      const wR = q[3] - q[1];
      if (wF > CFG.flipGate * Math.max(wR, 1e-9)) {
        q = CFG.flipOuter ? [cqF.q[0], q[1], q[2], q[3], cqF.q[4]] : cqF.q;
      }
    }
  }
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
  return { q, count: cq.count };
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
  if (!below) return above!.q.map((v) => v * Math.pow(h / above!.h, CFG.interpPow));
  if (!above) return below.q.map((v) => v * Math.pow(h / below.h, CFG.interpPow));
  if (above.h === below.h) return below.q;
  const s = Math.pow(h, CFG.interpPow), s0 = Math.pow(below.h, CFG.interpPow), s1 = Math.pow(above.h, CFG.interpPow);
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

/** Reversion anchor (short) at index e: median price over [e-35, e-5]. */
function anchorAt(p: number[], e: number): number {
  const lo = Math.max(0, e - 35);
  const hi = e - 5;
  if (hi - lo < 10) return p[e];
  return medianOf(p.slice(lo, hi + 1));
}

/** Long anchor at index e: median price over the trailing revAnchorWin minutes. */
function anchorLongAt(p: number[], e: number): number {
  const lo = Math.max(0, e - CFG.revAnchorWin + 1);
  if (e - lo < 30) return p[e];
  return medianOf(p.slice(lo, e + 1));
}

/** Ramp for center reversion at horizon h: 0 at h=0, 1 at h=240. */
function revRampAt(h: number): number {
  if (!CFG.revRamp) return 0;
  return CFG.revShape === 'lin' ? h / 240 : Math.sqrt(h / 240);
}

interface DwellCtx { prev: number; dwell: number; }
interface Cal {
  // multiplier applied to the (median-centered) deviation of quantile index t at horizon h
  scaleAt: (h: number, t: number) => number;
  // center for a forecast from price x with long anchor, at horizon h
  centerAt: (h: number, x: number, anchorL: number) => number;
  revertK: number;
}

/** Dwell (level-age) of the price at index e: minutes the current level has
 *  been unchanged, and the previous distinct level. */
function dwellAt(p: number[], e: number): DwellCtx {
  const x = p[e];
  let st = 0;
  while (e - st - 1 >= 0 && p[e - st - 1] === x) st++;
  const prev = e - st - 1 >= 0 ? p[e - st - 1] : x;
  return { prev, dwell: st + 1 };
}

/** Structural center: an unconfirmed (young) last level is blended back
 *  toward the previous level; weight B/(dwell+B), ramped in over dwellRamp. */
function dwellCenter(h: number, x: number, dc: DwellCtx): number {
  if (!CFG.dwellK) return x;
  const w = CFG.dwellB / (dc.dwell + CFG.dwellB);
  const ramp = Math.min(1, h / CFG.dwellRamp);
  return x - CFG.dwellK * ramp * w * (x - dc.prev);
}

function pinballItem(y: number, qq: number, t: number): number {
  const d = y - qq;
  return Math.max(QUANTILES[t] * d, (QUANTILES[t] - 1) * d);
}

interface CalItem { x: number; anchor: number; anchorL: number; y: number; h: number; shape: number[]; dc: DwellCtx; }

function collectItems(markets: CaseMarket[]): CalItem[] {
  const items: CalItem[] = [];
  const maxH = CFG.calHorizons[CFG.calHorizons.length - 1];
  for (const m of markets) {
    const p = m.prices;
    const n = p.length;
    for (let e = n - 1 - maxH; e >= 480; e -= CFG.calStep) {
      const anchor = anchorAt(p, e);
      const anchorL = anchorLongAt(p, e);
      for (const h of CFG.calHorizons) {
        if (e + h > n - 1) continue;
        items.push({ x: p[e], anchor, anchorL, y: p[e + h], h, shape: directShape(m, e, h), dc: dwellAt(p, e) });
      }
    }
  }
  return items;
}

/**
 * Calibrate per-case deviation scales by backtesting the estimator at
 * pseudo-checkpoints inside the history (pinball loss). Default mode: one
 * multiplier per horizon bucket x tail widening (v1). pairCal mode: separate
 * inner-pair and outer-pair multipliers per bucket. Optional horizon-ramped
 * center reversion toward the long anchor (pairCal mode), shrunk to 0.
 */
function calibrate(markets: CaseMarket[]): Cal {
  const plainScale = (t: number): number => (t === 0 || t === 4 ? CFG.tailW : t === 2 ? 1 : CFG.innerW);
  const plain = (): Cal => ({ scaleAt: (_h, t) => plainScale(t), centerAt: (_h, x) => x, revertK: 0 });
  if (!CFG.calibrate) return plain();
  const items = collectItems(markets);
  if (items.length < 50) return plain();
  const buckets: CalItem[][] = CFG.calSplit
    ? [items.filter((it) => it.h <= CFG.splitH), items.filter((it) => it.h > CFG.splitH)]
    : [items];
  if (buckets.some((b) => b.length === 0)) return plain();

  if (CFG.pairCal) {
    const kGrid = CFG.revRamp ? CFG.revGrid : [0];
    let bestTotal = Infinity;
    let bestK = 0;
    let bucketScales: { inS: number; outS: number }[] = buckets.map(() => ({ inS: CFG.pairDefIn, outS: CFG.pairDefOut }));
    for (const k of kGrid) {
      let total = 0;
      const chosen: { inS: number; outS: number }[] = [];
      for (const bucket of buckets) {
        let bLoss = Infinity, bIn = CFG.pairDefIn, bOut = CFG.pairDefOut;
        for (const mIn of CFG.mInGrid) {
          for (const mOut of CFG.mOutGrid) {
            let loss = 0;
            for (const it of bucket) {
              const ctr = it.x - k * revRampAt(it.h) * (it.x - it.anchorL);
              for (let t = 0; t < 5; t++) {
                const s = t === 0 || t === 4 ? mOut : mIn;
                loss += pinballItem(it.y, clamp01(ctr + s * it.shape[t]), t);
              }
            }
            if (loss < bLoss) { bLoss = loss; bIn = mIn; bOut = mOut; }
          }
        }
        total += bLoss;
        chosen.push({ inS: bIn, outS: bOut });
      }
      if (total < bestTotal) { bestTotal = total; bestK = k; bucketScales = chosen; }
    }
    const shrinkPair = (v: number, def: number): number => def + CFG.shrink * (v - def);
    const per = bucketScales.map((b) => ({
      inS: shrinkPair(b.inS, CFG.pairDefIn),
      outS: shrinkPair(b.outS, CFG.pairDefOut),
    }));
    const at = (h: number): { inS: number; outS: number } => {
      if (!CFG.calSplit || per.length === 1) return per[0];
      if (h <= CFG.splitH) return per[0];
      if (h >= 240) return per[1];
      const w = (Math.sqrt(h) - Math.sqrt(CFG.splitH)) / (Math.sqrt(240) - Math.sqrt(CFG.splitH));
      return { inS: per[0].inS + (per[1].inS - per[0].inS) * w, outS: per[0].outS + (per[1].outS - per[0].outS) * w };
    };
    const rk = CFG.revShrink * bestK;
    return {
      scaleAt: (h, t) => { const s = at(h); return t === 0 || t === 4 ? s.outS : s.inS; },
      centerAt: (h, x, anchorL) => x - rk * revRampAt(h) * (x - anchorL),
      revertK: rk,
    };
  }

  // v1 path: (tailW, revertK) outer loop, per-bucket multiplier inner loop.
  let bestLoss = Infinity;
  let bestM: number[] = buckets.map(() => 1);
  let bestT = CFG.tailW, bestK1 = 0;
  for (const tailW of CFG.tailGrid) {
    for (const k of CFG.revertGrid) {
      let total = 0;
      const ms: number[] = [];
      for (const bucket of buckets) {
        let bLoss = Infinity, bM = 1;
        for (const mult of CFG.mGrid) {
          let loss = 0;
          for (const it of bucket) {
            const ctr = dwellCenter(it.h, it.x, it.dc) - k * (it.x - it.anchor);
            for (let t = 0; t < 5; t++) {
              const adj = t === 0 || t === 4 ? it.shape[t] * tailW : t === 2 ? it.shape[t] : it.shape[t] * CFG.innerW;
              loss += pinballItem(it.y, clamp01(ctr + mult * adj), t);
            }
          }
          if (loss < bLoss) { bLoss = loss; bM = mult; }
        }
        total += bLoss;
        ms.push(bM);
      }
      if (total < bestLoss) { bestLoss = total; bestM = ms; bestT = tailW; bestK1 = k; }
    }
  }
  const mS = 1 + CFG.shrink * (bestM[0] - 1);
  const mL = 1 + CFG.shrink * ((bestM[1] ?? bestM[0]) - 1);
  const tailW = CFG.tailW + CFG.tailShrink * (bestT - CFG.tailW);
  const revertK = CFG.revertShrink * bestK1;
  const multAt = (h: number): number => {
    if (!CFG.calSplit) return mS;
    if (h <= CFG.splitH) return mS;
    if (h >= 240) return mL;
    const w = (Math.sqrt(h) - Math.sqrt(CFG.splitH)) / (Math.sqrt(240) - Math.sqrt(CFG.splitH));
    return mS + (mL - mS) * w;
  };
  return {
    scaleAt: (h, t) => multAt(h) * (t === 0 || t === 4 ? tailW : t === 2 ? 1 : CFG.innerW),
    centerAt: (_h, x) => x,
    revertK,
  };
}

/** Per-market vol-regime factor: recent change width vs window change width. */
function regimeFactor(m: CaseMarket): number {
  if (!CFG.regime) return 1;
  const p = m.prices;
  const end = p.length - 1;
  const recent = changeQuantiles(p, end, CFG.regimeH, CFG.regimeWin);
  const full = changeQuantiles(p, end, CFG.regimeH, effWindow(CFG.regimeH));
  if (!recent || !full) return 1;
  const wR = recent.q[3] - recent.q[1];
  const wF = full.q[3] - full.q[1];
  if (!(wF > 0)) return 1;
  const ratio = Math.min(1.4, Math.max(0.7, wR / wF));
  return 1 + CFG.regime * (ratio - 1);
}

function forecastMarket(m: CaseMarket, horizon: number, cal: Cal, knotQIn?: (number[] | null)[] | null, poolDev?: ((h: number) => number[] | null) | null): number[][] {
  const p = m.prices;
  if (p.length === 0) {
    return Array.from({ length: horizon }, () => [0.5, 0.5, 0.5, 0.5, 0.5]);
  }
  const end = p.length - 1;
  const young = CFG.youngWin > 0 && p.length < CFG.youngWin;
  const youngCtr = young ? medianOf(p) : 0;
  const anchorL = anchorLongAt(p, end);
  const anchorS = anchorAt(p, end);
  const regF = regimeFactor(m);
  const knotQ = knotQIn !== undefined ? knotQIn : CFG.mode === 'emp' ? CFG.knots.map((h) => rawShape(p, end, h)) : null;
  const sigma = CFG.mode === 'gauss' ? CFG.baseSigma : marketSigma(p, CFG.W);
  const rows: number[][] = [];
  for (let h = 1; h <= horizon; h++) {
    let s: number[] | null = null;
    if (CFG.direct) {
      s = rawShape(p, end, h);
      if (!s && knotQ) s = shapeAt(knotQ, CFG.knots, h);
    } else if (knotQ) {
      s = shapeAt(knotQ, CFG.knots, h);
    }
    if (!s) s = gaussShape(sigma, h);
    // center: pairCal/revRamp mode uses the ramped long-anchor center; the v1
    // path applies its flat short-anchor reversion via revertK.
    const x = young
      ? youngCtr
      : CFG.pairCal || CFG.revRamp
        ? cal.centerAt(h, p[end], anchorL)
        : dwellCenter(h, p[end], dwellAt(p, end)) - cal.revertK * (p[end] - anchorS);
    let devs = s.map((v, t) => cal.scaleAt(h, t) * regF * v * (young ? CFG.youngScale : 1));
    if (poolDev) {
      const pd = poolDev(h);
      if (pd) devs = devs.map((v, t) => (t === 2 ? v : v + Math.sign(v) * CFG.poolFloor * pd[t]));
    }
    const row = devs.map((v) => price6(x + v));
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
  if (CFG.debug) console.error(`${id}: revertK ${cal.revertK.toFixed(2)}`);
  // Optional cross-market pooling: markets whose knot estimate rests on few
  // change samples borrow the case's average normalized shape, rescaled by
  // their own h=30 width. Inactive unless CFG.pool > 0.
  let knotSets: ((number[] | null)[] | null)[] | null = null;
  if (CFG.pool > 0 && CFG.mode === 'emp') {
    const raw = c.markets.map((m) => {
      const end = m.prices.length - 1;
      return CFG.knots.map((h) => (end >= 0 ? rawShapeC(m.prices, end, h) : null));
    });
    const scales = raw.map((knots) => {
      const k30 = knots[CFG.knots.indexOf(30)] ?? knots[Math.min(3, knots.length - 1)];
      if (!k30) return 0;
      const w = k30.q[3] - k30.q[1];
      return w > 0 ? w : 0;
    });
    const pooled: (number[] | null)[] = CFG.knots.map((_, ki) => {
      const acc = [0, 0, 0, 0, 0];
      let nrm = 0;
      raw.forEach((knots, mi) => {
        const s = scales[mi];
        const cell = knots[ki];
        if (!cell || !(s > 0)) return;
        for (let t = 0; t < 5; t++) acc[t] += cell.q[t] / s;
        nrm++;
      });
      return nrm >= 3 ? acc.map((v) => v / nrm) : null;
    });
    knotSets = raw.map((knots, mi) => {
      const s = scales[mi];
      return knots.map((cell, ki) => {
        if (!cell) return null;
        const P = pooled[ki];
        if (!P || !(s > 0)) return cell.q;
        const w = CFG.pool * Math.min(1, Math.max(0, 1 - cell.count / CFG.poolCount));
        if (w <= 0) return cell.q;
        return cell.q.map((v, t) => (1 - w) * v + w * P[t] * s);
      });
    });
  }
  let poolDev: ((h: number) => number[] | null) | null = null;
  if (CFG.poolFloor > 0 && CFG.mode === 'emp') {
    const per = c.markets.map((m) => CFG.knots.map((h) => rawShape(m.prices, m.prices.length - 1, h)));
    const pooledKnots: (number[] | null)[] = CFG.knots.map((_, ki) => {
      const cols: number[][] = [[], [], [], [], []];
      for (const ks of per) { const q = ks[ki]; if (q) for (let t = 0; t < 5; t++) cols[t].push(Math.abs(q[t])); }
      if (cols[2].length < 3) return null;
      return cols.map((col) => medianOf(col));
    });
    poolDev = (h: number) => shapeAt(pooledKnots, CFG.knots, h);
  }
  const forecasts = c.markets.map((m, mi) => ({ id: m.id, q: forecastMarket(m, c.horizon_minutes, cal, knotSets ? knotSets[mi] : undefined, poolDev) }));
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ forecasts })}\n`);
}

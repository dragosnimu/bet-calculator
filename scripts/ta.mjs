// Analiza tehnica pe serie de preturi de inchidere (bare de 15 min), zero dependinte.
// Indicatori: EMA(9/21/50), RSI(14), MACD(12,26,9), Bollinger(20,2), ROC, breakout N-bare,
// volatilitate (stdev randamente) + trend prin regresie liniara.
// Le combina intr-un scor [-100..+100] si o stare: STRONG_BUY/BUY/NEUTRAL/REDUCE/STRONG_SELL.

export function emaSeries(vals, period) {
  const k = 2 / (period + 1);
  const out = new Array(vals.length).fill(null);
  if (vals.length < period) return out;
  let prev = 0;
  for (let j = 0; j < period; j++) prev += vals[j];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < vals.length; i++) { prev = vals[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}

export function rsiSeries(vals, period = 14) {
  const out = new Array(vals.length).fill(null);
  if (vals.length < period + 1) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) { const d = vals[i] - vals[i - 1]; if (d >= 0) gain += d; else loss -= d; }
  let ag = gain / period, al = loss / period;
  out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < vals.length; i++) {
    const d = vals[i] - vals[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

export function macd(vals, fast = 12, slow = 26, sig = 9) {
  const ef = emaSeries(vals, fast), es = emaSeries(vals, slow);
  const line = vals.map((_, i) => (ef[i] != null && es[i] != null) ? ef[i] - es[i] : null);
  const first = line.findIndex((v) => v != null);
  const signal = new Array(vals.length).fill(null);
  const hist = new Array(vals.length).fill(null);
  if (first >= 0) {
    const sub = line.slice(first);
    const sigSub = emaSeries(sub, sig);
    for (let i = 0; i < sigSub.length; i++) if (sigSub[i] != null) signal[first + i] = sigSub[i];
    for (let i = 0; i < vals.length; i++) if (line[i] != null && signal[i] != null) hist[i] = line[i] - signal[i];
  }
  return { line, signal, hist };
}

export function bollinger(vals, period = 20, mult = 2) {
  if (vals.length < period) return null;
  const win = vals.slice(-period);
  const mid = win.reduce((a, b) => a + b, 0) / period;
  const sd = Math.sqrt(win.reduce((a, b) => a + (b - mid) ** 2, 0) / period);
  const upper = mid + mult * sd, lower = mid - mult * sd;
  const price = vals[vals.length - 1];
  return { mid, upper, lower, sd, pctB: upper === lower ? 0.5 : (price - lower) / (upper - lower), bandwidth: mid ? (upper - lower) / mid * 100 : 0 };
}

export function roc(vals, n) {
  if (vals.length <= n) return null;
  const a = vals[vals.length - 1 - n];
  return a ? (vals[vals.length - 1] / a - 1) * 100 : null;
}

export function stdevReturns(vals, n = 20) {
  if (vals.length < n + 1) return null;
  const rets = [];
  for (let i = vals.length - n; i < vals.length; i++) if (vals[i - 1]) rets.push(vals[i] / vals[i - 1] - 1);
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  return Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / rets.length) * 100;
}

// Regresie liniara -> {movePct, r2} pe ultimele `win` valori.
export function regression(vals, win) {
  const ys = vals.slice(-win);
  const n = ys.length;
  if (n < 3) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += ys[i]; sxx += i * i; sxy += i * ys[i]; }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const slope = (n * sxy - sx * sy) / denom, intercept = (sy - slope * sx) / n, mean = sy / n;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) { const f = intercept + slope * i; ssRes += (ys[i] - f) ** 2; ssTot += (ys[i] - mean) ** 2; }
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  const ps = intercept, pe = intercept + slope * (n - 1);
  return { movePct: ps ? (pe - ps) / ps * 100 : 0, r2 };
}

const last = (arr) => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i]; return null; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Analiza completa. closes = preturi de inchidere, oldest->newest. Returneaza indicatori + scor + stare.
export function analyze(closes, cfg = {}) {
  const minBars = cfg.minBars ?? 30;
  const brkN = cfg.breakoutBars ?? 20;
  const price = closes[closes.length - 1];
  const n = closes.length;
  if (n < minBars || price == null) return { state: "INSUFICIENT", score: 0, bars: n, reasons: [] };

  const ema9 = emaSeries(closes, 9), ema21 = emaSeries(closes, 21), ema50 = emaSeries(closes, 50);
  const e9 = last(ema9), e21 = last(ema21), e50 = last(ema50);
  const rsiArr = rsiSeries(closes, 14);
  const rsi = last(rsiArr), rsiPrev = rsiArr[rsiArr.length - 2] ?? rsi;
  const { line, signal, hist } = macd(closes);
  const mh = last(hist), mhPrev = hist[hist.length - 2] ?? mh;
  const ml = last(line), sl = last(signal);
  const bb = bollinger(closes, 20, 2);
  const rocV = roc(closes, 8);
  const reg = regression(closes, Math.min(n, 8));

  // breakout pe ultimele brkN bare (exclusiv bara curenta)
  const past = closes.slice(-(brkN + 1), -1);
  const hi = past.length ? Math.max(...past) : price, lo = past.length ? Math.min(...past) : price;
  const newHigh = price > hi, newLow = price < lo;

  let score = 0;
  const reasons = [];
  const bull = [], bear = [];

  // 1) Structura EMA (aliniere)
  if (e9 != null && e21 != null && e50 != null) {
    if (price > e9 && e9 > e21 && e21 > e50) { score += 25; bull.push("EMA aliniate crescător (9>21>50)"); }
    else if (price > e21 && e21 > e50) { score += 14; bull.push("preț peste EMA21>EMA50"); }
    else if (price < e9 && e9 < e21 && e21 < e50) { score -= 25; bear.push("EMA aliniate descrescător (9<21<50)"); }
    else if (price < e21 && e21 < e50) { score -= 14; bear.push("preț sub EMA21<EMA50"); }
    else { const d = (price - e21) / e21 * 100; score += clamp(d * 2, -8, 8); }
  }
  // 2) MACD
  if (mh != null && mhPrev != null) {
    if (mh > 0 && mhPrev <= 0) { score += 12; bull.push("MACD a trecut pozitiv (cross)"); }
    else if (mh < 0 && mhPrev >= 0) { score -= 12; bear.push("MACD a trecut negativ (cross)"); }
    else { score += clamp((mh / price) * 4000, -10, 10); if (mh > 0) bull.push("MACD pozitiv"); else bear.push("MACD negativ"); }
  }
  // 3) RSI — penalizam supracumpararea DOAR cand momentum se rasuceste (RSI in scadere),
  //    ca sa nu blocam breakout-urile puternice (cresteri spectaculoase).
  if (rsi != null) {
    if (rsi >= 75 && rsi < rsiPrev) { score -= 8; bear.push(`RSI ${rsi.toFixed(0)} supracumpărat + se răsucește`); }
    else if (rsi <= 25 && rsi > rsiPrev) { score += 8; bull.push(`RSI ${rsi.toFixed(0)} supravândut + revine`); }
    if (rsiPrev < 50 && rsi >= 50) { score += 8; bull.push("RSI a depășit 50"); }
    else if (rsiPrev > 50 && rsi < 50) { score -= 8; bear.push("RSI a coborât sub 50"); }
    else if (rsi > 50 && rsi < 70 && rsi > rsiPrev) { score += 6; bull.push(`RSI ${rsi.toFixed(0)} în creștere`); }
    else if (rsi < 50 && rsi > 30 && rsi < rsiPrev) { score -= 6; bear.push(`RSI ${rsi.toFixed(0)} în scădere`); }
  }
  // 4) Bollinger
  if (bb) {
    if (bb.pctB > 1) { score += 10; bull.push("preț peste banda Bollinger sup. (breakout)"); }
    else if (bb.pctB < 0) { score -= 10; bear.push("preț sub banda Bollinger inf."); }
    else if (bb.pctB > 0.8) { score += 4; }
    else if (bb.pctB < 0.2) { score -= 4; }
  }
  // 5) Breakout N-bare
  if (newHigh) { score += 15; bull.push(`maxim nou pe ${brkN} bare`); }
  else if (newLow) { score -= 15; bear.push(`minim nou pe ${brkN} bare`); }
  // 6) Momentum (ROC)
  if (rocV != null) { score += clamp(rocV * 3, -15, 15); if (rocV > 0.3) bull.push(`momentum +${rocV.toFixed(1)}%`); else if (rocV < -0.3) bear.push(`momentum ${rocV.toFixed(1)}%`); }
  // 7) Trend regresie
  if (reg && reg.r2 >= 0.6) {
    if (reg.movePct > 0) { score += 8; bull.push(`trend curat +${reg.movePct.toFixed(1)}% (R²=${reg.r2.toFixed(2)})`); }
    else { score -= 8; bear.push(`trend curat ${reg.movePct.toFixed(1)}% (R²=${reg.r2.toFixed(2)})`); }
  }

  score = clamp(Math.round(score), -100, 100);
  const confirms = score >= 0 ? bull.length : bear.length;

  // Balansat: STRONG cere scor mare + confirmari multiple.
  const sBuy = cfg.strongBuy ?? 55, sSell = cfg.strongSell ?? -55, minConf = cfg.minConfirms ?? 3;
  let state;
  if (score >= sBuy && confirms >= minConf) state = "STRONG_BUY";
  else if (score >= 25) state = "BUY";
  else if (score <= sSell && confirms >= minConf) state = "STRONG_SELL";
  else if (score <= -25) state = "REDUCE";
  else state = "NEUTRAL";

  return {
    state, score, bars: n, confirms,
    reasons: (score >= 0 ? bull : bear).slice(0, 6),
    ind: {
      price, ema9: e9, ema21: e21, ema50: e50, rsi,
      macdHist: mh, bbPctB: bb?.pctB ?? null, roc: rocV,
      regMovePct: reg?.movePct ?? null, regR2: reg?.r2 ?? null, newHigh, newLow,
    },
    emaSeries: { ema9, ema21, ema50 }, // pt. grafic
  };
}

#!/usr/bin/env node
// Worker de alerte pret BET -> Telegram.
//
// - Verifica la fiecare ALERT_INTERVAL_MIN (default 15) minute, doar cat e bursa deschisa
//   (Luni-Vineri, MARKET_OPEN_HOUR..MARKET_CLOSE_HOUR, fus ALERT_TZ = Europe/Bucharest).
// - Alerta cand o actiune scade cu >= 1% (ALERT_DROP_STEP) fata de inchiderea de ieri
//   ("Pret referinta"). Re-alerta la fiecare treapta suplimentara (-1%, -2%, -3% ...).
// - Acknowledge: buton inline in Telegram SAU din aplicatie -> opreste alertele pentru
//   acea actiune pana la Reset din aplicatie. Resetare automata zilnica.
// - Zero dependente externe (doar fetch + fs).

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import { renderLineChartPNG } from "./png-chart.mjs";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const STATE_FILE = process.env.ALERT_STATE_FILE || "/data/alert-state.json";
const INTERVAL_MIN = Number(process.env.ALERT_INTERVAL_MIN || 15);
const DROP_STEP = Number(process.env.ALERT_DROP_STEP || 1); // procente
const TZ = process.env.ALERT_TZ || "Europe/Bucharest";
const OPEN_H = Number(process.env.MARKET_OPEN_HOUR || 10);
const CLOSE_H = Number(process.env.MARKET_CLOSE_HOUR || 18);

// Detectie trend (per actiune, intraday)
const TREND_ENABLED = (process.env.TREND_ENABLED ?? "true") !== "false";
const TREND_WINDOW = Number(process.env.TREND_WINDOW || 8);       // cate esantioane in fereastra (8 = ~2h)
const TREND_MIN_SAMPLES = Number(process.env.TREND_MIN_SAMPLES || 4); // minim de puncte ca sa evaluam
const TREND_MIN_MOVE = Number(process.env.TREND_MIN_MOVE || 1.0); // mutare minima pe fereastra, %
const TREND_MIN_R2 = Number(process.env.TREND_MIN_R2 || 0.6);    // cat de "curat" trebuie sa fie (0..1)
const HIST_MAX = 48;                                              // esantioane pastrate/actiune (o zi)

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const INDEX_URL = "https://bvb.ro/FinancialInstruments/Indices/IndicesProfiles.aspx?i=BET";
const DETAIL_URL = (s) =>
  `https://bvb.ro/FinancialInstruments/Details/FinancialInstrumentsDetails.aspx?s=${encodeURIComponent(s)}`;

const stripTags = (s) => s.replace(/<[^>]*>/g, "").trim();
const toNum = (s) => {
  const v = parseFloat(String(s).trim().replace(/\./g, "").replace(",", "."));
  return isNaN(v) ? null : v;
};
const fmt = (v) => (v == null ? "-" : v.toFixed(v < 1 ? 4 : 2).replace(".", ","));
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- Stare (fisier partajat cu aplicatia, scriere atomica) ----------
function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { day: null, updatedAt: null, tgOffset: 0, symbols: {} };
  }
}
function saveState(state) {
  state.updatedAt = new Date().toISOString();
  const dir = dirname(STATE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_FILE); // atomic
}
// Re-citeste inainte de scriere ca sa nu suprascrie comenzile venite din aplicatie
// (ex: muted setat de utilizator). Pastram doar campurile controlate de utilizator.
function mergeUserFields(fresh, current) {
  for (const [sym, s] of Object.entries(fresh.symbols || {})) {
    const cur = current.symbols[sym];
    if (cur) {
      if (typeof s.muted === "boolean") cur.muted = s.muted;
      if (typeof s.lastAlerted === "number") cur.lastAlerted = Math.min(cur.lastAlerted ?? 0, s.lastAlerted);
    }
  }
}

// ---------- Timp / program bursa ----------
function tzParts(date = new Date()) {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, weekday: "short", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  return Object.fromEntries(f.formatToParts(date).map((p) => [p.type, p.value]));
}
function todayStr(date = new Date()) {
  const p = tzParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}
function isMarketOpen(date = new Date()) {
  const p = tzParts(date);
  if (p.weekday === "Sat" || p.weekday === "Sun") return false;
  const h = Number(p.hour);
  return h >= OPEN_H && h < CLOSE_H;
}

// ---------- Scraping BVB ----------
async function fetchText(url, timeoutMs = 15000) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html" },
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.text();
}
function parseConstituents(html) {
  const tableMatch = html.match(/id="gvC"[\s\S]*?<\/table>/i);
  const scope = tableMatch ? tableMatch[0] : html;
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  const out = [];
  let row;
  while ((row = rowRegex.exec(scope)) !== null) {
    const cells = [];
    let cell;
    while ((cell = cellRegex.exec(row[1])) !== null) cells.push(stripTags(cell[1]));
    if (cells.length < 8) continue;
    const symbol = cells[0].trim();
    const name = cells[1].trim();
    const weight = toNum(cells[cells.length - 1]);
    if (symbol.length <= 5 && /^[A-Z0-9]+$/.test(symbol) && weight > 0 && weight < 100) {
      out.push({ symbol, name, weight });
    }
  }
  return out;
}
// Pret curent (Ultimul pret) + pret de referinta (inchiderea de ieri) de pe pagina de detaliu.
async function fetchQuote(symbol) {
  try {
    const html = await fetchText(DETAIL_URL(symbol), 12000);
    const last = html.match(/Ultimul pret\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/i);
    const ref = html.match(/Pret referinta\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/i);
    const lastV = last ? toNum(stripTags(last[1])) : null;
    const refV = ref ? toNum(stripTags(ref[1])) : null;
    return { last: lastV, ref: refV };
  } catch {
    return { last: null, ref: null };
  }
}

// ---------- Telegram ----------
async function tgSend(text, replyMarkup) {
  if (!BOT_TOKEN || !CHAT_ID) { log("[DRY-RUN] Telegram:", text.replace(/\n/g, " | ")); return; }
  try {
    const body = { chat_id: CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true };
    if (replyMarkup) body.reply_markup = replyMarkup;
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!r.ok) log("Telegram sendMessage err", r.status, await r.text());
  } catch (e) { log("Telegram send fail:", e.message); }
}
async function tgPhoto(png, caption) {
  if (!BOT_TOKEN || !CHAT_ID) { log("[DRY-RUN] Foto:", caption.replace(/\n/g, " | ")); return; }
  try {
    const form = new FormData();
    form.append("chat_id", CHAT_ID);
    form.append("caption", caption);
    form.append("parse_mode", "HTML");
    form.append("photo", new Blob([png], { type: "image/png" }), "trend.png");
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, { method: "POST", body: form });
    if (!r.ok) log("Telegram sendPhoto err", r.status, await r.text());
  } catch (e) { log("Telegram sendPhoto fail:", e.message); }
}
async function tgAnswer(callbackId, text) {
  if (!BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackId, text, show_alert: false }),
    });
  } catch (e) { log("answerCallback fail:", e.message); }
}
// Asculta apasarile pe butonul de acknowledge din Telegram (long-poll getUpdates).
async function pollTelegram() {
  if (!BOT_TOKEN) return;
  let state = loadState();
  try {
    const r = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?timeout=10&offset=${(state.tgOffset || 0) + 1}`,
      { signal: AbortSignal.timeout(15000) }
    );
    const data = await r.json();
    if (!data.ok || !data.result?.length) return;
    state = loadState();
    for (const u of data.result) {
      state.tgOffset = u.update_id;
      const cq = u.callback_query;
      if (cq && typeof cq.data === "string" && cq.data.startsWith("ack:")) {
        const sym = cq.data.slice(4);
        if (state.symbols[sym]) state.symbols[sym].muted = true;
        await tgAnswer(cq.id, `🔕 ${sym}: alerte oprite. Reactivează din aplicație.`);
        log(`Ack din Telegram pentru ${sym}`);
      }
    }
    saveState(state);
  } catch (e) {
    if (e.name !== "TimeoutError" && e.name !== "AbortError") log("pollTelegram:", e.message);
  }
}

// ---------- Trend (regresie liniara pe fereastra intraday) ----------
function linreg(ys) {
  const n = ys.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += ys[i]; sxx += i * i; sxy += i * ys[i]; }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const mean = sy / n;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) { const f = intercept + slope * i; ssRes += (ys[i] - f) ** 2; ssTot += (ys[i] - mean) ** 2; }
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  const predStart = intercept, predEnd = intercept + slope * (n - 1);
  const movePct = predStart !== 0 ? ((predEnd - predStart) / predStart) * 100 : 0;
  return { slope, r2, movePct };
}
// Returneaza {state: "up"|"down"|"none", movePct, r2, n, first, last}
function computeTrend(history) {
  const win = history.slice(-TREND_WINDOW);
  const ys = win.map((h) => h.p);
  if (ys.length < TREND_MIN_SAMPLES) return { state: "none", n: ys.length };
  const lr = linreg(ys);
  if (!lr) return { state: "none", n: ys.length };
  let state = "none";
  if (lr.r2 >= TREND_MIN_R2 && Math.abs(lr.movePct) >= TREND_MIN_MOVE) state = lr.movePct > 0 ? "up" : "down";
  return { state, movePct: lr.movePct, r2: lr.r2, n: ys.length, first: ys[0], last: ys[ys.length - 1] };
}

// ---------- Logica de verificare ----------
async function checkPrices() {
  if (!isMarketOpen()) { log("Bursa inchisa — skip."); return; }

  let indexHtml;
  try { indexHtml = await fetchText(INDEX_URL); }
  catch (e) { log("Index fetch fail:", e.message); return; }

  const all = parseConstituents(indexHtml);
  if (!all.length) { log("Nu am gasit constituenti."); return; }
  all.sort((a, b) => b.weight - a.weight);
  const top = all.slice(0, 10);

  const quotes = await Promise.all(top.map((c) => fetchQuote(c.symbol)));

  let state = loadState();
  const today = todayStr();
  if (state.day !== today) {
    log(`Zi noua de tranzactionare (${today}) — resetez alertele si istoricul.`);
    state.day = today;
    for (const s of Object.values(state.symbols)) {
      s.lastAlerted = 0; s.muted = false; s.history = []; s.trendNotified = "none";
    }
  }

  const alerts = [];
  const trendAlerts = [];
  const nowISO = new Date().toISOString();
  top.forEach((c, i) => {
    const { last, ref } = quotes[i];
    if (last == null || ref == null || ref <= 0) return;
    const dropPct = ((last - ref) / ref) * 100; // negativ cand scade
    const down = -dropPct;                       // magnitudinea scaderii
    const level = down >= DROP_STEP ? Math.floor(down / DROP_STEP) : 0;

    const s = (state.symbols[c.symbol] ||= { lastAlerted: 0, muted: false });
    s.name = c.name; s.ref = ref; s.last = last; s.dropPct = dropPct; s.level = level;

    // Daca si-a revenit sub pragul alertat, re-armam treapta.
    if (level < (s.lastAlerted || 0)) s.lastAlerted = level;

    if (!s.muted && level > (s.lastAlerted || 0)) {
      s.lastAlerted = level;
      alerts.push({ symbol: c.symbol, name: c.name, last, ref, dropPct, level });
    }

    // ---- Trend intraday ----
    s.history = (s.history || []).concat({ t: nowISO, p: last });
    if (s.history.length > HIST_MAX) s.history = s.history.slice(-HIST_MAX);
    const tr = computeTrend(s.history);
    s.trend = tr.state; s.trendMovePct = tr.movePct ?? null;
    if (TREND_ENABLED && (tr.state === "up" || tr.state === "down") && tr.state !== (s.trendNotified || "none")) {
      s.trendNotified = tr.state;
      trendAlerts.push({ symbol: c.symbol, name: c.name, ref, ...tr, history: s.history.map((h) => h.p) });
    } else if (tr.state === "none") {
      // pastram ultima directie clara ca sa nu re-alertam la fiecare oscilatie scurta
    }
  });

  saveState(state);

  for (const a of alerts) {
    const text =
      `🔻 <b>${a.symbol}</b> −${(-a.dropPct).toFixed(2)}% azi\n` +
      `${a.name}\n` +
      `Preț: <b>${fmt(a.last)}</b> RON (referință ${fmt(a.ref)})\n` +
      `<i>Prag atins: −${a.level * DROP_STEP}%</i>`;
    const markup = { inline_keyboard: [[{ text: `🔕 Oprește alertele ${a.symbol}`, callback_data: `ack:${a.symbol}` }]] };
    await tgSend(text, markup);
    log(`ALERTA ${a.symbol} nivel -${a.level * DROP_STEP}% (${a.dropPct.toFixed(2)}%)`);
  }

  for (const t of trendAlerts) {
    const up = t.state === "up";
    const arrow = up ? "📈" : "📉";
    const word = up ? "ASCENDENT" : "DESCENDENT";
    const ore = (t.n * INTERVAL_MIN / 60).toFixed(1);
    const caption =
      `${arrow} <b>${t.symbol}</b> — trend clar ${word} (intraday)\n` +
      `${t.name}\n` +
      `${t.movePct >= 0 ? "+" : ""}${t.movePct.toFixed(2)}% pe ultimele ~${ore}h (${t.n} puncte, R²=${t.r2.toFixed(2)})\n` +
      `Preț: ${fmt(t.first)} → <b>${fmt(t.last)}</b> RON (referință ${fmt(t.ref)})`;
    try {
      const png = renderLineChartPNG({ points: t.history, up, refPrice: t.ref });
      await tgPhoto(png, caption);
    } catch (e) { log("chart/photo fail:", e.message); await tgSend(caption); }
    log(`TREND ${t.symbol} ${t.state} ${t.movePct.toFixed(2)}% R2=${t.r2.toFixed(2)}`);
  }

  if (!alerts.length && !trendAlerts.length) log(`Verificat ${top.length} actiuni — nicio alerta noua.`);
}

// ---------- Bucle ----------
async function priceLoop() {
  try { await checkPrices(); } catch (e) { log("checkPrices err:", e.message); }
  setTimeout(priceLoop, INTERVAL_MIN * 60 * 1000);
}
async function telegramLoop() {
  await pollTelegram();
  setTimeout(telegramLoop, 1000);
}

// Ruleaza buclele doar cand scriptul e executat direct (nu cand e importat in teste).
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`;
if (isMain) {
  log(`Worker alerte pornit. Interval=${INTERVAL_MIN}min, prag=${DROP_STEP}%, program=${OPEN_H}:00-${CLOSE_H}:00 ${TZ}`);
  log(BOT_TOKEN && CHAT_ID ? "Telegram: configurat." : "Telegram: NECONFIGURAT (mod dry-run, alertele apar doar in log).");
  priceLoop();
  telegramLoop();
}

export { checkPrices, isMarketOpen, todayStr, parseConstituents, loadState, saveState, computeTrend };

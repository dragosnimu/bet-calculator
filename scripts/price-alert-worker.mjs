#!/usr/bin/env node
// Worker de alerte pret BET -> Telegram.
//
// - Verifica la fiecare ALERT_INTERVAL_MIN (default 15) minute, doar cat e bursa deschisa
//   (Luni-Vineri, MARKET_OPEN_HOUR..MARKET_CLOSE_HOUR, fus ALERT_TZ = Europe/Bucharest).
// - Alerta cand o actiune scade cu >= 3% (ALERT_DROP_STEP) fata de inchiderea de ieri
//   ("Pret referinta"). Re-alerta la fiecare treapta suplimentara (-3%, -6%, -9% ...).
// - Simetric: alerta cand o actiune creste cu >= 1% (ALERT_RISE_STEP) fata de inchiderea
//   de ieri, cu re-alerta la fiecare treapta suplimentara (+1%, +2%, +3% ...).
// - Acknowledge: buton inline in Telegram SAU din aplicatie -> opreste alertele pentru
//   acea actiune pana la Reset din aplicatie. Resetare automata zilnica.
// - Zero dependente externe (doar fetch + fs).

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import { renderLineChartPNG } from "./png-chart.mjs";
import { analyze, emaSeries } from "./ta.mjs";
import { fetchNews, scoreSentiment, NAME_QUERY } from "./news.mjs";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const STATE_FILE = process.env.ALERT_STATE_FILE || "/data/alert-state.json";
const INTERVAL_MIN = Number(process.env.ALERT_INTERVAL_MIN || 15);
const DROP_STEP = Number(process.env.ALERT_DROP_STEP || 3); // procente (scadere)
const RISE_STEP = Number(process.env.ALERT_RISE_STEP || DROP_STEP); // procente (crestere)
const TZ = process.env.ALERT_TZ || "Europe/Bucharest";
const OPEN_H = Number(process.env.MARKET_OPEN_HOUR || 10);
const CLOSE_H = Number(process.env.MARKET_CLOSE_HOUR || 18);

// Detectie trend (per actiune, intraday)
const TREND_ENABLED = (process.env.TREND_ENABLED ?? "true") !== "false";
const TREND_WINDOW = Number(process.env.TREND_WINDOW || 8);       // cate esantioane in fereastra (8 = ~2h)
const TREND_MIN_SAMPLES = Number(process.env.TREND_MIN_SAMPLES || 4); // minim de puncte ca sa evaluam
const TREND_MIN_MOVE = Number(process.env.TREND_MIN_MOVE || 1.0); // mutare minima pe fereastra, %
const TREND_MIN_R2 = Number(process.env.TREND_MIN_R2 || 0.6);    // cat de "curat" trebuie sa fie (0..1)
const HIST_MAX = 48;                                              // esantioane intraday/actiune (o zi)

// Semnale tehnice (Faza 1) — bare de 15 min, buffer multi-zi
const SIGNAL_ENABLED = (process.env.SIGNAL_ENABLED ?? "true") !== "false";
const BARS_MAX = Number(process.env.SIGNAL_BARS_MAX || 300);      // ~9 zile de bare 15 min
const SIGNAL_COOLDOWN_MIN = Number(process.env.SIGNAL_COOLDOWN_MIN || 45); // anti-spam per actiune
const TA_CFG = {
  strongBuy: Number(process.env.SIGNAL_STRONG_BUY || 55),
  strongSell: Number(process.env.SIGNAL_STRONG_SELL || -55),
  minConfirms: Number(process.env.SIGNAL_MIN_CONFIRMS || 3),
  minBars: Number(process.env.SIGNAL_MIN_BARS || 30),
};
// Verdict de continuare trend, atasat fiecarei alerte de pret (scadere/crestere).
const VERDICT_MIN_BARS = Number(process.env.VERDICT_MIN_BARS || 30); // bare minime pt. verdict ferm

function taArrow(v, eps) { return v > eps ? "↑" : v < -eps ? "↓" : "→"; }
function taEmaPos(ind) {
  const { price, ema9, ema21 } = ind;
  if (ema9 == null || ema21 == null || price == null) return null;
  if (price >= ema9 && price >= ema21) return "peste EMA9/21";
  if (price <= ema9 && price <= ema21) return "sub EMA9/21";
  return "între EMA9/21";
}
// dir: "down" = alerta de scadere, "up" = alerta de crestere.
// Verdict cu 5 stari, relativ la directia miscarii care a declansat alerta.
// Culori semafor: 🔴 pret probabil in scadere, 🟡 incert/slabeste, 🟢 pret probabil in urcare.
function taVerdict(dir, a, tr) {
  if (!a || a.state === "INSUFICIENT" || (a.bars || 0) < VERDICT_MIN_BARS) return null;
  const score = a.score;
  const aligned = dir === "down" ? -score : score; // cat de mult confirma TA directia miscarii
  const moveWord = dir === "down" ? "SCĂDEREA" : "CREȘTEREA";
  const invWord = dir === "down" ? "revenire" : "corecție";
  let headline, emoji;
  if (aligned >= 40)      { headline = `${moveWord} CONTINUĂ (puternic)`; emoji = dir === "down" ? "🔴" : "🟢"; }
  else if (aligned >= 15) { headline = `${moveWord} CONTINUĂ (slab)`;     emoji = dir === "down" ? "🔴" : "🟢"; }
  else if (aligned > -15) { headline = "TREND INCERT";                    emoji = "🟡"; }
  else if (aligned > -40) { headline = `${moveWord} SLĂBEȘTE`;            emoji = "🟡"; }
  else                    { headline = `POSIBILĂ INVERSARE (${invWord})`; emoji = dir === "down" ? "🟢" : "🔴"; }

  const confidence = Math.max(40, Math.min(95, Math.round(40 + Math.abs(aligned) * 0.5 + (a.confirms || 0) * 2)));
  const conf6 = Math.min(a.confirms || 0, 6);
  const iArrow = taArrow(tr?.movePct ?? 0, 0.1);
  const fArrow = taArrow(score, 10);
  const aln = (iArrow !== "→" && fArrow !== "→") ? (iArrow === fArrow ? " (aliniate)" : " (divergente)") : "";

  const i = a.ind, bits = [];
  if (i.rsi != null) bits.push(`RSI ${i.rsi.toFixed(0)}`);
  if (i.macdHist != null) bits.push(`MACD${i.macdHist >= 0 ? "+" : "−"}`);
  const ep = taEmaPos(i); if (ep) bits.push(ep);

  const lines = [
    `${emoji} <b>Analiză tehnică: ${headline}</b>`,
    `Scor <b>${score >= 0 ? "+" : ""}${score}</b>/100 · încredere ${confidence}% · ${conf6}/6 semnale`,
    `Intraday ${iArrow} · Fond ${fArrow}${aln}`,
    bits.join(" · "),
  ].filter(Boolean);
  return { emoji, text: lines.join("\n") };
}
// Eticheta scurta de stanta tehnica pt. /status (fara directie de alerta): pe scorul de fond.
function taStance(score, bars) {
  if (score == null || (bars || 0) < VERDICT_MIN_BARS) return "";
  if (score >= 25) return "🟢↑";
  if (score <= -25) return "🔴↓";
  return "🟡→";
}
// Trimite o alerta de pret. Daca exista verdict TA, mesajul devine poza (grafic intraday
// cu EMA9) + descrierea analizei; altfel doar text. dir = "down" | "up".
async function emitPriceAlert(a, dir) {
  const step = dir === "down" ? DROP_STEP : RISE_STEP;
  const sign = dir === "down" ? "−" : "+";
  const head = dir === "down"
    ? `🔻 <b>${a.symbol}</b> −${(-a.dropPct).toFixed(2)}% azi`
    : `🔺 <b>${a.symbol}</b> +${a.dropPct.toFixed(2)}% azi`;
  const base =
    `${head}\n${esc(a.name)}\n` +
    `Preț: <b>${fmt(a.last)}</b> RON (referință ${fmt(a.ref)})\n` +
    `<i>Prag atins: ${sign}${a.level * step}%</i>`;
  const markup = { inline_keyboard: [[{ text: `🔕 Oprește alertele ${a.symbol}`, callback_data: `ack:${a.symbol}` }]] };

  if (a.ta && a.history && a.history.length >= 2) {
    const caption = `${base}\n━━━━━━━━━━━\n${a.ta.text}\n<i>informativ — nu recomandare de investiție</i>`;
    try {
      const ov = [{ points: emaSeries(a.history, 9), r: 245, g: 158, b: 11, label: "EMA9" }]; // EMA9 (chihlimbar)
      const png = renderLineChartPNG({
        points: a.history, up: dir === "up", refPrice: a.ref, overlays: ov,
        title: `${a.symbol} · intraday 15m`, refLabel: "Referinta = inchidere ieri",
      });
      await tgPhoto(png, caption, markup);
    } catch (e) { log("alert chart fail:", e.message); await tgSend(caption, markup); }
  } else {
    await tgSend(base, markup);
  }
  log(`ALERTA ${a.symbol} nivel ${sign}${a.level * step}% (${a.dropPct.toFixed(2)}%)${a.ta ? " +TA" : ""}`);
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const INDEX_URL = "https://bvb.ro/FinancialInstruments/Indices/IndicesProfiles.aspx?i=BET";
const REPORTS_URL = "https://bvb.ro/FinancialInstruments/SelectedData/CurrentReports";
const ANNOUNCE_ENABLED = (process.env.ANNOUNCE_ENABLED ?? "true") !== "false";
const ANN_SEEN_MAX = 400;

// Sentiment stiri (Faza 3) — Google News RSS + scorare cu Claude
const SENTIMENT_ENABLED = (process.env.SENTIMENT_ENABLED ?? "true") !== "false";
const HAS_LLM = !!process.env.ANTHROPIC_API_KEY;
const SENTIMENT_MIN_ABS = Number(process.env.SENTIMENT_MIN_ABS || 0.5); // prag |score| pt. alerta
const NEWS_LOOKBACK_DAYS = Number(process.env.NEWS_LOOKBACK_DAYS || 3);
const NEWS_EVERY_TICKS = Number(process.env.NEWS_EVERY_TICKS || 4);      // ~o data pe ora la 15 min
const NEWS_SEEN_MAX = 500;
let newsTick = 0;
const DETAIL_URL = (s) =>
  `https://bvb.ro/FinancialInstruments/Details/FinancialInstrumentsDetails.aspx?s=${encodeURIComponent(s)}`;

// Escapa caracterele periculoase pentru HTML (parse_mode:'HTML' la Telegram), in ordinea
// corecta (& intai, apoi < si >), aplicat pe TOATE valorile dinamice inainte de inserare.
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
// Pret curent + referinta + indicatori fundamentali, de pe pagina de detaliu.
function fundField(html, label) {
  const m = html.match(new RegExp(`<td>${label}</td>\\s*<td[^>]*>([\\s\\S]*?)</td>`, "i"));
  return m ? toNum(stripTags(m[1])) : null;
}
async function fetchQuote(symbol) {
  try {
    const html = await fetchText(DETAIL_URL(symbol), 12000);
    const last = html.match(/Ultimul pret\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/i);
    const ref = html.match(/Pret referinta\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/i);
    const fund = { per: fundField(html, "PER"), pbv: fundField(html, "P/BV"), eps: fundField(html, "EPS"), divy: fundField(html, "DIVY"), cap: fundField(html, "Capitalizare") };
    return { last: last ? toNum(stripTags(last[1])) : null, ref: ref ? toNum(stripTags(ref[1])) : null, fund };
  } catch {
    return { last: null, ref: null, fund: null };
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
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) log("Telegram sendMessage err", r.status, await r.text());
  } catch (e) { log("Telegram send fail:", e.message); }
}
async function tgPhoto(png, caption, replyMarkup) {
  if (!BOT_TOKEN || !CHAT_ID) { log("[DRY-RUN] Foto:", caption.replace(/\n/g, " | ")); return; }
  try {
    const form = new FormData();
    form.append("chat_id", CHAT_ID);
    form.append("caption", caption);
    form.append("parse_mode", "HTML");
    if (replyMarkup) form.append("reply_markup", JSON.stringify(replyMarkup));
    form.append("photo", new Blob([png], { type: "image/png" }), "trend.png");
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, { method: "POST", body: form, signal: AbortSignal.timeout(15000) });
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

      // Autorizare: proceseaza doar update-uri din chat-ul configurat. In dry-run (fara
      // CHAT_ID) pastram comportamentul actual (acceptam orice, doar pentru testare locala).
      if (CHAT_ID) {
        const src = u.callback_query
          ? (u.callback_query.message?.chat?.id ?? u.callback_query.from?.id)
          : (u.message || u.edited_message)?.chat?.id;
        if (String(src) !== CHAT_ID) { log("Update Telegram ignorat: expeditor neautorizat."); continue; }
      }

      // Buton inline "Oprește alertele"
      const cq = u.callback_query;
      if (cq && typeof cq.data === "string" && cq.data.startsWith("ack:")) {
        const sym = cq.data.slice(4);
        if (Object.prototype.hasOwnProperty.call(state.symbols, sym)) state.symbols[sym].muted = true;
        await tgAnswer(cq.id, `🔕 ${sym}: alerte oprite. Reia cu /reset ${sym}`);
        log(`Ack din Telegram pentru ${sym}`);
        continue;
      }

      // Comenzi text: /reset [SIMBOL|all], /status
      const msg = u.message || u.edited_message;
      const text = (msg?.text || "").trim();
      if (!text.startsWith("/")) continue;
      const [cmdRaw, arg] = text.split(/\s+/);
      const cmd = cmdRaw.replace(/@.*$/, "").toLowerCase(); // suporta /reset@bot

      if (cmd === "/reset") {
        const target = (arg || "all").toUpperCase();
        if (target === "ALL") {
          for (const s of Object.values(state.symbols)) { s.muted = false; s.lastAlerted = 0; }
          await tgSend("🔔 Toate alertele au fost reactivate.");
          log("Reset ALL din Telegram");
        } else if (state.symbols[target]) {
          state.symbols[target].muted = false; state.symbols[target].lastAlerted = 0;
          await tgSend(`🔔 ${target}: alerte reactivate.`);
          log(`Reset ${target} din Telegram`);
        } else {
          await tgSend(`Nu cunosc simbolul „${esc(target)}". Folosește /reset SIMBOL sau /reset all.`);
        }
      } else if (cmd === "/status") {
        const sigIcon = { STRONG_BUY: "🟢🚀", BUY: "🟢", NEUTRAL: "⚪", REDUCE: "🔴", STRONG_SELL: "🔴⚠️", INSUFICIENT: "…" };
        const sIcon = (se) => !se ? "" : se.score > 0.15 ? " 📰🟢" : se.score < -0.15 ? " 📰🔴" : " 📰⚪";
        const rows = Object.entries(state.symbols)
          .map(([sym, s]) => ({ sym, dropPct: s.dropPct ?? 0, muted: s.muted, trend: s.trend || "none", sig: s.sigStateNow || "INSUFICIENT", score: s.sigScore ?? null, stance: s.taStance || "", per: s.fund?.per ?? null, divy: s.fund?.divy ?? null, senti: s.sentiment ?? null }))
          .sort((a, b) => (b.score ?? -999) - (a.score ?? -999));
        const line = (r) => `${sigIcon[r.sig] || "⚪"} <b>${esc(r.sym)}</b> ${r.score != null ? (r.score >= 0 ? "+" : "") + r.score : "—"}${r.stance ? " " + r.stance : ""}` +
          ` ${r.trend === "up" ? "📈" : r.trend === "down" ? "📉" : ""} ${r.dropPct >= 0 ? "+" : ""}${r.dropPct.toFixed(2)}%${r.muted ? " 🔕" : ""}` +
          `${r.per != null ? ` · P/E ${r.per}` : ""}${r.divy != null ? ` · div ${r.divy}%` : ""}${sIcon(r.senti)}`;
        const body = rows.length ? rows.map(line).join("\n") : "Încă nu există date (bursa închisă sau prima verificare în curs).";
        await tgSend(`📊 <b>Status BET</b> (${isMarketOpen() ? "bursă deschisă" : "bursă închisă"})\n<i>semnal · scor tehnic · fond 🔴🟡🟢 · trend · variație zi</i>\n${body}\n\n<i>🟢🚀 cumpărare puternică · 🔴⚠️ vânzare/risc · fond: 🟢 urcă/🟡 lateral/🔴 scade · 🔕 oprit · /reset SIMBOL</i>`);
      } else if (cmd === "/start" || cmd === "/help") {
        await tgSend("👋 Bot alerte BET.\nComenzi:\n/status — starea celor 10 acțiuni\n/reset SIMBOL — reia alertele pentru o acțiune\n/reset all — reia toate");
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

// ---------- Anunturi oficiale emitenti (rapoarte curente BVB) ----------
const htmlDecode = (s) => s.replace(/&nbsp;/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").trim();

function parseReports(html) {
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  const out = [];
  for (const r of rows) {
    const row = r[1];
    const sym = (row.match(/[?&]s=([A-Z0-9]+)"/) || row.match(/<b>\s*([A-Z0-9]+)\s*<\/b>/) || [])[1];
    const dt = (row.match(/(\d{2}\.\d{2}\.\d{4}\s+\d{1,2}:\d{2})/) || [])[1];
    const title = htmlDecode((row.match(/value="([^"]+)"/) || row.match(/data-search="([^"]+)"/) || [])[1] || "");
    if (sym && dt && title) out.push({ sym, dt, title });
  }
  return out;
}

async function checkAnnouncements() {
  if (!ANNOUNCE_ENABLED) return;
  let html;
  try { html = await fetchText(REPORTS_URL, 15000); }
  catch (e) { log("Reports fetch fail:", e.message); return; }

  const reports = parseReports(html);
  if (!reports.length) return;

  const state = loadState();
  const watch = new Set(Object.keys(state.symbols || {}));
  if (!watch.size) return; // inca nu stim ce actiuni urmarim (inainte de primul checkPrices)

  state.annSeen = state.annSeen || [];
  const seen = new Set(state.annSeen);
  const mine = reports.filter((a) => watch.has(a.sym));

  // Prima rulare: marcam tot ca vazut, fara alerta (evitam backlog-ul).
  if (!state.annSeeded) {
    for (const a of mine) seen.add(`${a.sym}|${a.dt}|${a.title.slice(0, 40)}`);
    state.annSeen = [...seen].slice(-ANN_SEEN_MAX);
    state.annSeeded = true;
    saveState(state);
    log(`Anunturi: seed initial (${mine.length} marcate ca vazute).`);
    return;
  }

  const fresh = [];
  for (const a of mine) {
    const key = `${a.sym}|${a.dt}|${a.title.slice(0, 40)}`;
    if (!seen.has(key)) { seen.add(key); fresh.push(a); }
  }
  state.annSeen = [...seen].slice(-ANN_SEEN_MAX);
  saveState(state);

  for (const a of fresh) {
    const nm = state.symbols[a.sym]?.name || a.sym;
    const text = `📢 <b>${esc(a.sym)}</b> — anunț nou BVB\n${esc(nm)}\n<i>${esc(a.dt)}</i>\n${esc(a.title)}`;
    await tgSend(text);
    log(`ANUNT ${a.sym} ${a.dt} :: ${a.title.slice(0, 50)}`);
  }
  if (fresh.length) log(`Anunturi: ${fresh.length} noi trimise.`);
}

// ---------- Sentiment stiri (Faza 3) ----------
async function checkNews() {
  if (!SENTIMENT_ENABLED) return;
  if (!HAS_LLM) { if (newsTick === 0) log("Sentiment: NECONFIGURAT (lipsa ANTHROPIC_API_KEY) — sar peste."); return; }
  if (newsTick++ % NEWS_EVERY_TICKS !== 0) return; // rulam ~o data pe ora

  const snap = loadState();
  const symbols = Object.keys(snap.symbols || {});
  if (!symbols.length) return;
  const wasSeeded = !!snap.newsSeeded;
  const seen = new Set(snap.newsSeen || []);
  const newLinks = [];
  const sentUpdates = {}; // sym -> {score,label,summary,ts,count}

  for (const sym of symbols) {
    const name = NAME_QUERY[sym] || snap.symbols[sym]?.name || sym;
    let items;
    try { items = await fetchNews(name, { lookbackDays: NEWS_LOOKBACK_DAYS }); }
    catch (e) { log(`Stiri ${sym} fetch fail:`, e.message); continue; }

    const fresh = items.filter((it) => !seen.has(it.link));
    if (!fresh.length) continue;
    fresh.forEach((it) => { seen.add(it.link); newLinks.push(it.link); });

    // Prima rulare: doar marcam ca vazute, fara scorare (evitam backlog + cost LLM).
    if (!wasSeeded) continue;

    const senti = await scoreSentiment(sym, name, fresh.map((f) => f.title), { model: process.env.SENTIMENT_MODEL });
    if (!senti) continue;
    sentUpdates[sym] = { ...senti, ts: fresh[0].ts, count: fresh.length };
    log(`SENTIMENT ${sym} ${senti.label} ${senti.score.toFixed(2)} (${fresh.length} titluri)`);

    if (Math.abs(senti.score) >= SENTIMENT_MIN_ABS) {
      const emo = senti.score > 0 ? "🟢📰" : "🔴📰";
      const text =
        `${emo} <b>${esc(sym)}</b> — sentiment ${esc(senti.label.toUpperCase())} din știri\n` +
        `${esc(name)}\n` +
        `Scor sentiment: <b>${senti.score >= 0 ? "+" : ""}${senti.score.toFixed(2)}</b>\n` +
        `${esc(senti.summary)}\n\n` +
        fresh.slice(0, 3).map((f) => `• <a href="${esc(f.link)}">${esc(f.title.slice(0, 90))}</a>`).join("\n") +
        `\n\n<i>Analiză de sentiment informativă — nu constituie recomandare.</i>`;
      await tgSend(text);
    }
  }

  // Reincarca si imbina doar campurile proprii (pollTelegram poate fi scris intre timp).
  const state = loadState();
  state.newsSeen = [...new Set([...(state.newsSeen || []), ...newLinks])].slice(-NEWS_SEEN_MAX);
  for (const [sym, se] of Object.entries(sentUpdates)) if (state.symbols[sym]) state.symbols[sym].sentiment = se;
  if (!wasSeeded) { state.newsSeeded = true; log(`Stiri: seed initial (${seen.size} marcate ca vazute).`); }
  saveState(state);
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
      s.lastAlerted = 0; s.lastRiseAlerted = 0; s.muted = false; s.history = []; s.trendNotified = "none";
    }
  }

  const alerts = [];
  const riseAlerts = [];
  const trendAlerts = [];
  const signalAlerts = [];
  const nowISO = new Date().toISOString();
  const nowMs = Date.now();
  top.forEach((c, i) => {
    const { last, ref } = quotes[i];
    if (last == null || ref == null || ref <= 0) return;
    const dropPct = ((last - ref) / ref) * 100; // negativ cand scade, pozitiv cand creste
    const down = -dropPct;                       // magnitudinea scaderii
    const level = down >= DROP_STEP ? Math.floor(down / DROP_STEP) : 0;
    const up = dropPct;                          // magnitudinea cresterii
    const riseLevel = up >= RISE_STEP ? Math.floor(up / RISE_STEP) : 0;

    const s = (state.symbols[c.symbol] ||= { lastAlerted: 0, lastRiseAlerted: 0, muted: false });
    s.name = c.name; s.ref = ref; s.last = last; s.dropPct = dropPct; s.level = level; s.riseLevel = riseLevel;

    // Fundamentale — pastram ultima valoare valida (BVB serveste ocazional pagini fara ele).
    const f = quotes[i].fund;
    if (f) { s.fund = { ...(s.fund || {}), ...Object.fromEntries(Object.entries(f).filter(([, v]) => v != null)) }; }

    // Daca si-a revenit sub pragul alertat, re-armam treapta (scadere si crestere).
    if (level < (s.lastAlerted || 0)) s.lastAlerted = level;
    if (riseLevel < (s.lastRiseAlerted || 0)) s.lastRiseAlerted = riseLevel;

    // ---- Trend intraday (calculat inainte de alerte, ca sa-l atasam verdictului) ----
    s.history = (s.history || []).concat({ t: nowISO, p: last });
    if (s.history.length > HIST_MAX) s.history = s.history.slice(-HIST_MAX);
    const tr = computeTrend(s.history);
    s.trend = tr.state; s.trendMovePct = tr.movePct ?? null;
    const intradayPrices = s.history.map((h) => h.p);

    // ---- Analiza tehnica multi-zi (buffer bare 15 min) — folosita si de verdict, si de semnale ----
    s.bars = (s.bars || []).concat(last);
    if (s.bars.length > BARS_MAX) s.bars = s.bars.slice(-BARS_MAX);
    const a = analyze(s.bars, TA_CFG);
    s.sigScore = a.score; s.sigStateNow = a.state; s.sigBars = a.bars;
    s.taStance = taStance(a.score, a.bars); // eticheta scurta pt. /status

    // ---- Alerte de pret (cu verdict de continuare a trendului atasat) ----
    if (!s.muted && level > (s.lastAlerted || 0)) {
      s.lastAlerted = level;
      alerts.push({ symbol: c.symbol, name: c.name, last, ref, dropPct, level,
        ta: taVerdict("down", a, tr), history: intradayPrices });
    }
    if (!s.muted && riseLevel > (s.lastRiseAlerted || 0)) {
      s.lastRiseAlerted = riseLevel;
      riseAlerts.push({ symbol: c.symbol, name: c.name, last, ref, dropPct, level: riseLevel,
        ta: taVerdict("up", a, tr), history: intradayPrices });
    }

    // ---- Alerta de trend intraday (mesaj separat cu grafic, doar la schimbarea de stare) ----
    if (TREND_ENABLED && (tr.state === "up" || tr.state === "down") && tr.state !== (s.trendNotified || "none")) {
      s.trendNotified = tr.state;
      trendAlerts.push({ symbol: c.symbol, name: c.name, ref, ...tr, history: intradayPrices });
    }

    // ---- Semnal tehnic puternic (Faza 1) — separat, cu cooldown per actiune ----
    if (SIGNAL_ENABLED) {
      const strong = a.state === "STRONG_BUY" || a.state === "STRONG_SELL";
      const coolOk = !s.lastSigAt || nowMs - s.lastSigAt >= SIGNAL_COOLDOWN_MIN * 60000;
      if (strong && a.state !== (s.sigNotified || "none") && coolOk) {
        s.sigNotified = a.state; s.lastSigAt = nowMs;
        signalAlerts.push({ symbol: c.symbol, name: c.name, ref, last, ...a, bars: s.bars.slice(), fund: s.fund, sentiment: s.sentiment });
      } else if (!strong) {
        s.sigNotified = "none"; // re-armam cand iese din starea puternica
      }
    }
  });

  saveState(state);

  for (const a of alerts) await emitPriceAlert(a, "down");
  for (const a of riseAlerts) await emitPriceAlert(a, "up");

  for (const t of trendAlerts) {
    const up = t.state === "up";
    const arrow = up ? "📈" : "📉";
    const word = up ? "ASCENDENT" : "DESCENDENT";
    const ore = (t.n * INTERVAL_MIN / 60).toFixed(1);
    const caption =
      `${arrow} <b>${esc(t.symbol)}</b> — trend clar ${word} (intraday)\n` +
      `${esc(t.name)}\n` +
      `${t.movePct >= 0 ? "+" : ""}${t.movePct.toFixed(2)}% pe ultimele ~${ore}h (${t.n} puncte, R²=${t.r2.toFixed(2)})\n` +
      `Preț: ${fmt(t.first)} → <b>${fmt(t.last)}</b> RON (referință ${fmt(t.ref)})`;
    try {
      const png = renderLineChartPNG({ points: t.history, up, refPrice: t.ref, title: `${t.symbol} · trend intraday`, refLabel: "Referinta = inchidere ieri" });
      await tgPhoto(png, caption);
    } catch (e) { log("chart/photo fail:", e.message); await tgSend(caption); }
    log(`TREND ${t.symbol} ${t.state} ${t.movePct.toFixed(2)}% R2=${t.r2.toFixed(2)}`);
  }

  for (const a of signalAlerts) {
    const buy = a.state === "STRONG_BUY";
    const head = buy ? "🟢🚀 <b>SEMNAL PUTERNIC DE CUMPĂRARE</b>" : "🔴⚠️ <b>SEMNAL PUTERNIC DE VÂNZARE / RISC</b>";
    const i = a.ind;
    const linii = [
      head,
      `<b>${esc(a.symbol)}</b> · ${esc(a.name)}`,
      `Scor tehnic: <b>${a.score >= 0 ? "+" : ""}${a.score}</b>/100 (${a.confirms} confirmări)`,
      `Preț: <b>${fmt(a.last)}</b> RON` + (i.rsi != null ? ` · RSI ${i.rsi.toFixed(0)}` : ""),
      ...(a.fund && (a.fund.per != null || a.fund.divy != null)
        ? [`Fundamental: ${a.fund.per != null ? `P/E ${a.fund.per}` : ""}${a.fund.eps != null ? ` · EPS ${a.fund.eps}` : ""}${a.fund.divy != null ? ` · div. ${a.fund.divy}%` : ""}`]
        : []),
      ...(a.sentiment
        ? [`Sentiment știri: ${a.sentiment.score > 0.15 ? "🟢" : a.sentiment.score < -0.15 ? "🔴" : "⚪"} ${a.sentiment.label} (${a.sentiment.score >= 0 ? "+" : ""}${a.sentiment.score.toFixed(2)})`]
        : []),
      "",
      "Motive:",
      ...a.reasons.map((r) => `• ${r}`),
      "",
      "<i>Semnal tehnic informativ — nu constituie recomandare de investiție.</i>",
    ];
    const em = a.emaSeries || {};
    const overlays = [];
    if (em.ema9) overlays.push({ points: em.ema9, r: 245, g: 158, b: 11, label: "EMA9" });   // EMA9 portocaliu
    if (em.ema21) overlays.push({ points: em.ema21, r: 96, g: 165, b: 250, label: "EMA21" });  // EMA21 albastru
    if (em.ema50) overlays.push({ points: em.ema50, r: 148, g: 163, b: 184, label: "EMA50" }); // EMA50 gri
    try {
      const png = renderLineChartPNG({
        points: a.bars, up: buy, refPrice: a.ref, overlays,
        title: `${a.symbol} · ${buy ? "semnal cumparare" : "semnal vanzare"}`, refLabel: "Referinta",
      });
      await tgPhoto(png, linii.join("\n"));
    } catch (e) { log("signal chart fail:", e.message); await tgSend(linii.join("\n")); }
    log(`SEMNAL ${a.symbol} ${a.state} scor=${a.score} confirms=${a.confirms}`);
  }

  if (!alerts.length && !trendAlerts.length && !signalAlerts.length)
    log(`Verificat ${top.length} actiuni — nicio alerta noua.`);
}

// ---------- Bucle ----------
async function priceLoop() {
  try { await checkAnnouncements(); } catch (e) { log("checkAnnouncements err:", e.message); }
  try { await checkNews(); } catch (e) { log("checkNews err:", e.message); }
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
  log(`Worker alerte pornit. Interval=${INTERVAL_MIN}min, prag scadere=-${DROP_STEP}% / crestere=+${RISE_STEP}%, program=${OPEN_H}:00-${CLOSE_H}:00 ${TZ}`);
  log(BOT_TOKEN && CHAT_ID ? "Telegram: configurat." : "Telegram: NECONFIGURAT (mod dry-run, alertele apar doar in log).");
  priceLoop();
  telegramLoop();
}

export { checkPrices, checkAnnouncements, checkNews, parseReports, isMarketOpen, todayStr, parseConstituents, loadState, saveState, computeTrend, taVerdict, taStance };

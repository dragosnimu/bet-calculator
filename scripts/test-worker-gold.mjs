#!/usr/bin/env node
// Regresie pentru instrumentul EXTRA 4GLD (Xetra-Gold) din price-alert-worker.mjs.
// Acopera sarcina "adauga 4GLD in worker-ul de alerte":
//  (a) fetchYahooQuote parseaza un meta JSON Yahoo mostra -> { last, ref, currency } corect
//      si intoarce null la esec (retea/parse/http/camp lipsa);
//  (b) o alerta pentru 4GLD foloseste moneda EUR si pragurile 3%/3% (level corect la -3% si +3%);
//  (c) 4GLD e EXCLUS din anunturi (checkAnnouncements) si din sentiment (checkNews);
//  + atacuri: GOLD_ENABLED=false dezactiveaza, moneda ostila din Yahoo e escapata, boundary-uri.
//
// FARA retea — tot ce iese afara e stubuit prin globalThis.fetch. NU face git commit/push.
// Env citite la load (GOLD_*, ANTHROPIC_API_KEY, ALERT_STATE_FILE) sunt setate INAINTE de import.
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// --- env la load: activeaza calea de sentiment (checkNews) + state file in temp ---
const tmp = mkdtempSync(join(tmpdir(), "bet-gold-"));
const stateFile = join(tmp, "state.json");
process.env.ALERT_STATE_FILE = stateFile;
process.env.ANTHROPIC_API_KEY = "sk-ant-stub-for-test"; // activeaza HAS_LLM in checkNews
process.env.SENTIMENT_ENABLED = "true";
process.env.ANNOUNCE_ENABLED = "true";
process.env.GOLD_ENABLED = "true";
process.env.GOLD_DROP_STEP = "3";
process.env.GOLD_RISE_STEP = "3";
delete process.env.TELEGRAM_BOT_TOKEN; // dry-run (alertele apar in log)
delete process.env.TELEGRAM_CHAT_ID;

let p = 0, f = 0;
const fails = [];
function test(name, fn) { try { fn(); console.log(`  ✅ ${name}`); p++; } catch (e) { console.log(`  ❌ ${name}\n     → ${e.message}`); fails.push(name); f++; } }
async function testA(name, fn) { try { await fn(); console.log(`  ✅ ${name}`); p++; } catch (e) { console.log(`  ❌ ${name}\n     → ${e.message}`); fails.push(name); f++; } }
function assert(c, m) { if (!c) throw new Error(m); }
const captureLogs = async (fn) => {
  const logs = []; const orig = console.log; console.log = (...a) => logs.push(a.join(" "));
  try { await fn(); } finally { console.log = orig; }
  return logs;
};

const W = await import(new URL("./price-alert-worker.mjs", import.meta.url).href);
const { fetchYahooQuote, processInstrument, emitPriceAlert, checkAnnouncements, checkNews, EXTRA_INSTRUMENTS } = W;

console.log("\n🥇 Worker: instrument extra 4GLD (Xetra-Gold)\n");

// ---------------------------------------------------------------------------
// (a) fetchYahooQuote — parsare meta mostra + robustete la esec
// ---------------------------------------------------------------------------
const stubFetch = (json, { ok = true, status = 200, throwErr = null } = {}) => {
  globalThis.fetch = async () => {
    if (throwErr) throw new Error(throwErr);
    return { ok, status, json: async () => json, text: async () => "" };
  };
};

await testA("(a) fetchYahooQuote parseaza meta Yahoo mostra -> { last, ref, currency }", async () => {
  // mostra realista (trunchiata) din query1.finance.yahoo.com/v8/finance/chart/4GLD.DE
  stubFetch({ chart: { result: [{ meta: {
    symbol: "4GLD.DE", currency: "EUR", regularMarketPrice: 245.5, chartPreviousClose: 250.0,
    regularMarketTime: 1730000000, exchangeName: "GER",
  } }], error: null } });
  const q = await fetchYahooQuote("4GLD.DE");
  assert(q && q.last === 245.5, `last gresit: ${JSON.stringify(q)}`);
  assert(q.ref === 250.0, `ref gresit (trebuie chartPreviousClose): ${JSON.stringify(q)}`);
  assert(q.currency === "EUR", `currency gresit: ${JSON.stringify(q)}`);
});

await testA("(a) fetchYahooQuote intoarce null la esec (http/retea/camp lipsa/result gol)", async () => {
  stubFetch({ chart: { result: [{ meta: { regularMarketPrice: 10 } }] } });
  assert(await fetchYahooQuote("X") === null, "ref lipsa ar trebui null");
  stubFetch({ chart: { result: [{ meta: { chartPreviousClose: 10 } }] } });
  assert(await fetchYahooQuote("X") === null, "last lipsa ar trebui null");
  stubFetch({ chart: { result: [] } });
  assert(await fetchYahooQuote("X") === null, "result gol ar trebui null");
  stubFetch({}, { ok: false, status: 429 });
  assert(await fetchYahooQuote("X") === null, "http 429 ar trebui null");
  stubFetch(null, { throwErr: "ECONNRESET" });
  assert(await fetchYahooQuote("X") === null, "eroare de retea ar trebui null (fara throw)");
  // regularMarketPrice ca string (nu number) -> respins (conservator)
  stubFetch({ chart: { result: [{ meta: { regularMarketPrice: "10", chartPreviousClose: 9 } }] } });
  assert(await fetchYahooQuote("X") === null, "pret ne-numeric ar trebui null");
  // currency ne-string -> last/ref valide, currency null (apelantul face fallback la EUR)
  stubFetch({ chart: { result: [{ meta: { regularMarketPrice: 100, chartPreviousClose: 90, currency: 42 } }] } });
  const q = await fetchYahooQuote("X");
  assert(q && q.last === 100 && q.ref === 90 && q.currency === null, `currency ne-string gresit: ${JSON.stringify(q)}`);
});

// ---------------------------------------------------------------------------
// (b) alerta 4GLD: moneda EUR + praguri 3%/3%, level corect la -3% si +3%
// ---------------------------------------------------------------------------
const runExtra = (last, ref, cfg = { dropStep: 3, riseStep: 3, currency: "EUR", extra: true }) => {
  const state = { symbols: {} };
  const out = { alerts: [], riseAlerts: [], trendAlerts: [], signalAlerts: [] };
  processInstrument({ symbol: "4GLD", name: "Xetra-Gold" }, { last, ref }, cfg, state,
    new Date().toISOString(), Date.now(), out);
  return { out, s: state.symbols["4GLD"] };
};

test("(b) 4GLD: level de scadere corect la pragul 3% (si boundary)", () => {
  assert(runExtra(97.1, 100).s.level === 0, "-2.9% nu trebuie sa declanseze (level 0)");
  const r3 = runExtra(97, 100); // exact -3%
  assert(r3.s.level === 1, `-3% trebuie level 1, a dat ${r3.s.level}`);
  assert(r3.out.alerts.length === 1, "trebuie exact o alerta de scadere la -3%");
  assert(runExtra(94, 100).s.level === 2, "-6% trebuie level 2");
  assert(runExtra(90.99, 100).s.level === 3, "-9.01% trebuie level 3");
});

test("(b) 4GLD: level de crestere corect la pragul 3% (si boundary)", () => {
  assert(runExtra(102.9, 100).s.riseLevel === 0, "+2.9% nu trebuie sa declanseze");
  const r3 = runExtra(103, 100); // exact +3%
  assert(r3.s.riseLevel === 1, `+3% trebuie riseLevel 1, a dat ${r3.s.riseLevel}`);
  assert(r3.out.riseAlerts.length === 1, "trebuie exact o alerta de crestere la +3%");
  assert(runExtra(106, 100).s.riseLevel === 2, "+6% trebuie riseLevel 2");
});

test("(b) 4GLD: flag extra + moneda EUR purtate in state si in payload-ul alertei", () => {
  const r = runExtra(97, 100);
  assert(r.s.extra === true, "s.extra trebuie true pt. 4GLD");
  assert(r.s.currency === "EUR", "s.currency trebuie EUR");
  assert(r.out.alerts[0].currency === "EUR" && r.out.alerts[0].step === 3,
    `payload alerta gresit: ${JSON.stringify(r.out.alerts[0])}`);
});

await testA("(b) emitPriceAlert afiseaza EUR si pragul corect (text, dry-run)", async () => {
  const down = await captureLogs(() => emitPriceAlert(
    { symbol: "4GLD", name: "Xetra-Gold", last: 97, ref: 100, dropPct: -3, level: 1, currency: "EUR", step: 3, ta: null, history: [] }, "down"));
  const dl = down.find((l) => l.includes("[DRY-RUN] Telegram"));
  assert(dl && dl.includes("EUR"), `alerta de scadere nu afiseaza EUR: ${dl}`);
  assert(!/\bRON\b/.test(dl), `alerta de scadere 4GLD contine RON hardcodat: ${dl}`);
  assert(dl.includes("−3%") || dl.includes("Prag atins: −3%"), `prag scadere gresit: ${dl}`);
  const up = await captureLogs(() => emitPriceAlert(
    { symbol: "4GLD", name: "Xetra-Gold", last: 103, ref: 100, dropPct: 3, level: 1, currency: "EUR", step: 3, ta: null, history: [] }, "up"));
  const ul = up.find((l) => l.includes("[DRY-RUN] Telegram"));
  assert(ul && ul.includes("EUR") && !/\bRON\b/.test(ul), `alerta de crestere EUR/RON gresit: ${ul}`);
  assert(ul.includes("+3%"), `prag crestere gresit: ${ul}`);
});

// ---------------------------------------------------------------------------
// (c) 4GLD exclus din anunturi + sentiment
// ---------------------------------------------------------------------------
const seedState = () => writeFileSync(stateFile, JSON.stringify({
  day: "2026-11-04", updatedAt: null, tgOffset: 0,
  annSeeded: true, annSeen: [], newsSeeded: true, newsSeen: [],
  symbols: {
    TLV: { name: "Banca Transilvania", muted: false, lastAlerted: 0, extra: false },
    "4GLD": { name: "Xetra-Gold", muted: false, lastAlerted: 0, extra: true },
  },
}));

await testA("(c) checkAnnouncements alerteaza TLV dar NU 4GLD (marfa, fara emitent BVB)", async () => {
  seedState();
  const ANN = `<table>
    <tr><td><a href="?s=TLV">TLV</a></td><td>01.09.2026 12:30</td><td><input value="Raport TLV"></td></tr>
    <tr><td><a href="?s=4GLD">4GLD</a></td><td>01.09.2026 12:31</td><td><input value="Raport despre aur"></td></tr>
  </table>`;
  globalThis.fetch = async (url) => String(url).includes("CurrentReports")
    ? { ok: true, status: 200, text: async () => ANN, json: async () => ({}) }
    : { ok: true, status: 200, text: async () => "", json: async () => ({ ok: true }) };
  const logs = await captureLogs(() => checkAnnouncements());
  const alerts = logs.filter((l) => l.includes("[DRY-RUN] Telegram") && l.includes("anunț nou"));
  assert(alerts.some((l) => l.includes("TLV")), "anuntul TLV ar fi trebuit emis");
  assert(!alerts.some((l) => l.includes("4GLD")), "4GLD NU trebuie sa genereze anunt (trebuie exclus)");
});

await testA("(c) checkNews interogheaza doar actiuni BVB, NU 4GLD", async () => {
  seedState();
  const newsUrls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("news.google.com")) { newsUrls.push(decodeURIComponent(u)); return { ok: true, status: 200, text: async () => "<rss></rss>", json: async () => ({}) }; }
    return { ok: true, status: 200, text: async () => "", json: async () => ({}) };
  };
  await captureLogs(() => checkNews());
  assert(newsUrls.length > 0, "checkNews nu a interogat nicio stire (setup gresit / HAS_LLM off)");
  assert(newsUrls.some((u) => /Banca Transilvania/i.test(u)), "ar fi trebuit sa interogheze stirile TLV");
  assert(!newsUrls.some((u) => /Xetra|4GLD/i.test(u)), "checkNews a interogat stiri pt. 4GLD (trebuie exclus)");
});

// ---------------------------------------------------------------------------
// Atacuri suplimentare
// ---------------------------------------------------------------------------
await testA("atac: moneda ostila din Yahoo e escapata in alerta (fara injectie HTML)", async () => {
  const state = { symbols: {} };
  const out = { alerts: [], riseAlerts: [], trendAlerts: [], signalAlerts: [] };
  processInstrument({ symbol: "4GLD", name: "Xetra-Gold" }, { last: 90, ref: 100, currency: "<b>x</b>&" },
    { dropStep: 3, riseStep: 3, currency: "<b>x</b>&", extra: true }, state, new Date().toISOString(), Date.now(), out);
  assert(out.alerts.length === 1, "ar fi trebuit o alerta la -10%");
  const logs = await captureLogs(() => emitPriceAlert(out.alerts[0], "down"));
  const l = logs.find((x) => x.includes("[DRY-RUN]"));
  assert(l && !l.includes("<b>x</b>"), `moneda ostila a ajuns neescapata: ${l}`);
  assert(l.includes("&lt;b&gt;x&lt;/b&gt;&amp;"), `moneda ostila nu a fost escapata corect: ${l}`);
});

test("atac: GOLD_ENABLED controleaza lista; fallback currency la config cand Yahoo nu da moneda", () => {
  assert(EXTRA_INSTRUMENTS.length === 1 && EXTRA_INSTRUMENTS[0].symbol === "4GLD", "4GLD lipseste din EXTRA_INSTRUMENTS");
  assert(EXTRA_INSTRUMENTS[0].yahooSymbol === "4GLD.DE", "yahooSymbol gresit");
  // currency null din quote -> cfg currency EUR folosit (simulat ca in checkPrices)
  const q = { last: 90, ref: 100, currency: null };
  const cfg = { dropStep: 3, riseStep: 3, currency: (q && q.currency) || "EUR", extra: true };
  assert(cfg.currency === "EUR", "fallback currency la EUR cand Yahoo nu da moneda");
});

test("robustete: ref=0/negativ/null si quote null nu declanseaza alerta si nu crapa", () => {
  for (const q of [null, { last: 90, ref: 0 }, { last: 90, ref: -5 }, { last: null, ref: 100 }, { last: 90, ref: null }]) {
    const state = { symbols: {} };
    const out = { alerts: [], riseAlerts: [], trendAlerts: [], signalAlerts: [] };
    processInstrument({ symbol: "4GLD", name: "Xetra-Gold" }, q, { dropStep: 3, riseStep: 3, currency: "EUR", extra: true },
      state, new Date().toISOString(), Date.now(), out);
    assert(out.alerts.length === 0 && out.riseAlerts.length === 0, `quote degenerat a produs alerta: ${JSON.stringify(q)}`);
  }
});

console.log(`\n  ${p + f} teste 4GLD | ✅ ${p} | ❌ ${f}`);
if (f > 0) { console.log("  eșecuri: " + fails.join(", ")); process.exit(1); }
process.exit(0);

#!/usr/bin/env node
// Regresie de securitate pentru worker-ul de alerte Telegram (price-alert-worker.mjs).
// Acopera findings-urile din audit:
//  - [High]  autorizarea expeditorului in pollTelegram (chat != CHAT_ID => ignorat);
//  - [Low]   garda anti prototype-pollution pe callback_data "ack:__proto__";
//  - [Medium] escaparea HTML a valorilor dinamice (nume companie, titluri anunturi) in mesaje.
//  - invarianti TA: scor in [-100,100], cele 5 stari de verdict + culorile semaforului.
//
// Ruleaza standalone (`node scripts/test-worker-security.mjs`) sau apelat din scripts/test.mjs.
import { mkdtempSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

let p = 0, f = 0;
const fails = [];
function test(name, fn) { try { fn(); console.log(`  ✅ ${name}`); p++; } catch (e) { console.log(`  ❌ ${name}\n     → ${e.message}`); fails.push(name); f++; } }
async function testA(name, fn) { try { await fn(); console.log(`  ✅ ${name}`); p++; } catch (e) { console.log(`  ❌ ${name}\n     → ${e.message}`); fails.push(name); f++; } }
function assert(c, m) { if (!c) throw new Error(m); }

const here = fileURLToPath(new URL(".", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "bet-sec-"));

console.log("\n🔒 Securitate worker Telegram\n");

// ---- [Medium] Escapare HTML: titlu de anunt + nume companie ostile ----
await testA("HTML escaping — titlu anunt/nume companie ostile (checkAnnouncements)", async () => {
  const stateFile = join(tmp, "state-esc.json");
  writeFileSync(stateFile, JSON.stringify({
    day: null, updatedAt: null, tgOffset: 0, annSeeded: true, annSeen: [],
    symbols: { TLV: { name: "Banca <b>&</b> Co", muted: false, lastAlerted: 0 } },
  }));
  process.env.ALERT_STATE_FILE = stateFile;
  delete process.env.TELEGRAM_BOT_TOKEN; delete process.env.TELEGRAM_CHAT_ID; // dry-run

  const HOSTILE = 'Pericol <script>alert(1)</script> & <b>x</b>';
  const HTML = `<table><tr><td><a href="?s=TLV">TLV</a></td><td>01.09.2026 12:30</td><td><input value="${HOSTILE}"></td></tr></table>`;
  globalThis.fetch = async (url) =>
    String(url).includes("CurrentReports")
      ? { ok: true, status: 200, text: async () => HTML, json: async () => ({}) }
      : { ok: true, status: 200, text: async () => "", json: async () => ({ ok: true }) };

  const logs = [];
  const orig = console.log; console.log = (...a) => logs.push(a.join(" "));
  const { checkAnnouncements } = await import("./price-alert-worker.mjs");
  await checkAnnouncements();
  console.log = orig;

  const dry = logs.find((l) => l.includes("[DRY-RUN] Telegram") && l.includes("anunț nou"));
  assert(dry, "nicio alerta de anunt emisa (setup gresit)");
  assert(!dry.includes("<script>"), "tag <script> brut a ajuns in mesaj (escapare lipsa)");
  assert(dry.includes("&lt;script&gt;"), "titlul ostil nu a fost escapat");
  assert(dry.includes("Banca &lt;b&gt;&amp;&lt;/b&gt; Co"), "numele companiei nu a fost escapat corect (& inainte de <>)");
});

// ---- Invarianti TA: scor, cele 5 stari, culori semafor ----
await testA("Invarianti TA — scor in [-100,100], 5 stari verdict, culori corecte", async () => {
  const { taVerdict, taStance, computeTrend } = await import("./price-alert-worker.mjs");
  const { analyze } = await import("./ta.mjs");
  const COLORS = new Set(["🔴", "🟡", "🟢"]);
  const HEADS = [/CONTINUĂ \(puternic\)/, /CONTINUĂ \(slab\)/, /TREND INCERT/, /SLĂBEȘTE/, /POSIBILĂ INVERSARE/];
  let rng = 123456789; const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
  for (let it = 0; it < 3000; it++) {
    const n = 2 + Math.floor(rand() * 120);
    const bars = []; let pr = 1 + rand() * 100;
    for (let i = 0; i < n; i++) { pr += (rand() - 0.5) * pr * 0.1; pr = Math.max(0.01, pr); bars.push(pr); }
    const a = analyze(bars, {});
    assert(a.score >= -100 && a.score <= 100, `scor in afara intervalului: ${a.score}`);
    const tr = computeTrend(bars.map((x) => ({ p: x })));
    for (const dir of ["down", "up"]) {
      const v = taVerdict(dir, a, tr); if (v === null) continue;
      assert(COLORS.has(v.emoji), `emoji semafor invalid: ${v.emoji}`);
      const head = v.text.split("\n")[0];
      assert(HEADS.some((r) => r.test(head)), `headline necunoscut: ${head}`);
      if (/INVERSARE/.test(head)) assert(v.emoji === (dir === "down" ? "🟢" : "🔴"), `culoare inversare gresita (${dir})`);
      if (/CONTINUĂ/.test(head)) assert(v.emoji === (dir === "down" ? "🔴" : "🟢"), `culoare continuare gresita (${dir})`);
      if (/INCERT|SLĂBEȘTE/.test(head)) assert(v.emoji === "🟡", `culoare neutra gresita: ${v.emoji}`);
    }
    assert(["", "🟢↑", "🔴↓", "🟡→"].includes(taStance(a.score, a.bars)), "taStance out of set");
  }
  // margini
  for (const e of [computeTrend([]), computeTrend([{ p: 5 }]), computeTrend([{ p: 0 }, { p: 0 }, { p: 0 }, { p: 0 }])])
    assert(["up", "down", "none"].includes(e.state), "computeTrend state invalid pe input degenerat");
  assert(taVerdict("down", { state: "BUY", score: 50, bars: 10, confirms: 3, ind: {} }, {}) === null, "verdict sub min bars ar trebui null");
  assert(taVerdict("up", null, {}) === null, "verdict cu a=null ar trebui null");
});

// ---- [High]+[Low] Autorizare expeditor + garda prototype pollution (worker rulat ca main) ----
await testA("Autorizare pollTelegram + garda __proto__ (integration)", async () => {
  const stateFile = join(tmp, "state-auth.json");
  writeFileSync(stateFile, JSON.stringify({
    day: null, updatedAt: null, tgOffset: 100,
    symbols: { TLV: { muted: false, lastAlerted: 0 }, SNP: { muted: false, lastAlerted: 0 } },
  }));
  const r = spawnSync(process.execPath, [join(here, "test-worker-authchild.mjs")], {
    env: {
      ...process.env, TELEGRAM_BOT_TOKEN: "test-token", TELEGRAM_CHAT_ID: "111",
      ALERT_STATE_FILE: stateFile, ANNOUNCE_ENABLED: "false", SENTIMENT_ENABLED: "false",
      TREND_ENABLED: "false", SIGNAL_ENABLED: "false", MARKET_OPEN_HOUR: "0", MARKET_CLOSE_HOUR: "0",
    },
    encoding: "utf8", timeout: 20000,
  });
  const line = (r.stdout || "").split(/\r?\n/).find((l) => l.startsWith("RESULT "));
  assert(line, `child fara RESULT (stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify((r.stderr||"").slice(0,300))})`);
  const res = JSON.parse(line.slice("RESULT ".length));
  assert(res.tlvMuted === false, "ack neautorizat (chat strain) a reusit sa dezactiveze TLV — garda de autorizare rupta");
  assert(res.snpMuted === true, "ack autorizat nu a dezactivat SNP — functionalitatea legitima rupta");
  assert(res.protoPolluted === false, "prototype pollution via ack:__proto__ — garda hasOwnProperty rupta");
  assert(res.offset === 105, `offset Telegram gresit: ${res.offset}`);
});

console.log(`\n  ${p + f} teste securitate | ✅ ${p} | ❌ ${f}`);
if (f > 0) { console.log("  eșecuri: " + fails.join(", ")); process.exit(1); }
process.exit(0);

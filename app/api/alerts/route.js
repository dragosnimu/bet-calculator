// GET  /api/alerts  -> starea alertelor (per actiune) + program bursa
// POST /api/alerts  -> { action: "ack" | "reset" | "resetAll", symbol }
//   ack      = oprestre alertele pentru o actiune (acknowledge)
//   reset    = reactiveaza alertele pentru o actiune (re-alerteaza si nivelul curent)
//   resetAll = reactiveaza toate
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";

export const dynamic = "force-dynamic";

const STATE_FILE = process.env.ALERT_STATE_FILE || "/data/alert-state.json";
const TZ = process.env.ALERT_TZ || "Europe/Bucharest";
const OPEN_H = Number(process.env.MARKET_OPEN_HOUR || 10);
const CLOSE_H = Number(process.env.MARKET_CLOSE_HOUR || 18);
const TG_CONFIGURED = !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); }
  catch { return { day: null, updatedAt: null, symbols: {} }; }
}
function saveState(state) {
  const dir = dirname(STATE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_FILE);
}
function isMarketOpen(date = new Date()) {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", hour: "2-digit", hour12: false });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  if (p.weekday === "Sat" || p.weekday === "Sun") return false;
  const h = Number(p.hour);
  return h >= OPEN_H && h < CLOSE_H;
}

export async function GET() {
  const state = loadState();
  const symbols = Object.entries(state.symbols || {})
    .map(([symbol, s]) => ({
      symbol,
      name: s.name || "",
      ref: s.ref ?? null,
      last: s.last ?? null,
      dropPct: s.dropPct ?? null,
      level: s.level ?? 0,
      lastAlerted: s.lastAlerted ?? 0,
      muted: !!s.muted,
      trend: s.trend ?? "none",           // "up" | "down" | "none"
      trendMovePct: s.trendMovePct ?? null,
    }))
    .sort((a, b) => (a.dropPct ?? 0) - (b.dropPct ?? 0)); // cele mai scazute primele

  return Response.json({
    telegramConfigured: TG_CONFIGURED,
    marketOpen: isMarketOpen(),
    day: state.day || null,
    updatedAt: state.updatedAt || null,
    symbols,
  });
}

export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return Response.json({ error: "JSON invalid" }, { status: 400 }); }
  const { action, symbol } = body || {};
  const state = loadState();
  state.symbols ||= {};

  if (action === "resetAll") {
    for (const s of Object.values(state.symbols)) { s.muted = false; s.lastAlerted = 0; }
  } else if (action === "ack" && symbol && state.symbols[symbol]) {
    state.symbols[symbol].muted = true;
  } else if (action === "reset" && symbol && state.symbols[symbol]) {
    state.symbols[symbol].muted = false;
    state.symbols[symbol].lastAlerted = 0; // reactiveaza inclusiv nivelul curent
  } else {
    return Response.json({ error: "Acțiune sau simbol invalid." }, { status: 400 });
  }

  saveState(state);
  return Response.json({ ok: true });
}

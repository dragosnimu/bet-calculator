// Stiri (Google News RSS RO) + scorare sentiment cu Claude API (HTTP direct, zero dependinte).
// Fara cheie ANTHROPIC_API_KEY, scorarea e dezactivata (returneaza null).

// Interogare per simbol — numele comun al companiei (mai putin zgomot decat simbolul).
export const NAME_QUERY = {
  TLV: "Banca Transilvania", SNP: "OMV Petrom", SNG: "Romgaz", H2O: "Hidroelectrica",
  BRD: "BRD Groupe Societe Generale", TGN: "Transgaz", DIGI: "Digi Communications",
  EL: "Electrica", SNN: "Nuclearelectrica", M: "MedLife", TEL: "Transelectrica", PE: "Premier Energy",
};

const strip = (s) => s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]*>/g, "")
  .replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();

// Preia stirile recente pentru o interogare. Returneaza [{title, link, ts}] (cele mai noi primele).
export async function fetchNews(query, { lookbackDays = 3, max = 8, timeoutMs = 12000 } = {}) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ro&gl=RO&ceid=RO:ro`;
  const xml = await (await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(timeoutMs) })).text();
  const cutoff = Date.now() - lookbackDays * 86400000;
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const b = m[1];
    const title = strip((b.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "");
    const link = strip((b.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || "");
    const dateStr = strip((b.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || "");
    const ts = Date.parse(dateStr);
    if (!title || !link || isNaN(ts)) continue;
    if (ts < cutoff) continue;
    out.push({ title, link, ts });
  }
  return out.sort((a, b) => b.ts - a.ts).slice(0, max);
}

// Scoreaza sentimentul unui set de titluri cu Claude. Returneaza {score:-1..1, label, summary} sau null.
export async function scoreSentiment(symbol, name, headlines, cfg = {}) {
  const key = cfg.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!key || !headlines.length) return null;
  const model = cfg.model || process.env.SENTIMENT_MODEL || "claude-opus-5";
  const sys = "Ești analist financiar. Evaluezi sentimentul general al unor titluri de știri despre o acțiune listată la Bursa de Valori București, din perspectiva unui investitor. Ignoră știrile irelevante. Răspunde DOAR cu un obiect JSON, fără alt text.";
  const user =
    `Acțiune: ${name} (${symbol}). Titluri recente:\n` +
    headlines.map((h, i) => `${i + 1}. ${h}`).join("\n") +
    `\n\nRăspunde DOAR cu JSON: {"score": <număr real între -1 (foarte negativ) și 1 (foarte pozitiv)>, "label": "pozitiv" | "neutru" | "negativ", "summary": "<o propoziție scurtă în română>"}`;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 1024, system: sys, messages: [{ role: "user", content: user }] }),
      signal: AbortSignal.timeout(cfg.timeoutMs || 30000),
    });
    if (!res.ok) { console.error("Anthropic status", res.status, (await res.text()).slice(0, 200)); return null; }
    const data = await res.json();
    if (data.stop_reason === "refusal") return null;
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    const jm = text.match(/\{[\s\S]*\}/);
    if (!jm) return null;
    const p = JSON.parse(jm[0]);
    let score = Number(p.score);
    if (isNaN(score)) return null;
    score = Math.max(-1, Math.min(1, score));
    const label = ["pozitiv", "neutru", "negativ"].includes(p.label) ? p.label : (score > 0.15 ? "pozitiv" : score < -0.15 ? "negativ" : "neutru");
    return { score, label, summary: String(p.summary || "").slice(0, 200) };
  } catch (e) {
    console.error("scoreSentiment fail:", e.message);
    return null;
  }
}

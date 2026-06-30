// GET /api/prices — Date reale BVB (zero dependente externe)
//
// Strategie in 2 pasi:
//  1) Pagina indicelui (IndicesProfiles) -> compozitia + ponderile oficiale (top 10).
//  2) Pagina de detaliu a fiecarui instrument -> "Ultimul pret" (pretul real tranzactionat).
//     Coloana "Pret ref." din tabelul indicelui este pretul de referinta, NU pretul curent
//     din piata, asa ca prețurile reale se iau din "Ultimul pret".
export const dynamic = "force-dynamic";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const INDEX_URL = "https://bvb.ro/FinancialInstruments/Indices/IndicesProfiles.aspx?i=BET";
const DETAIL_URL = (s) =>
  `https://bvb.ro/FinancialInstruments/Details/FinancialInstrumentsDetails.aspx?s=${encodeURIComponent(s)}`;

const stripTags = (s) => s.replace(/<[^>]*>/g, "").trim();
// BVB: punctul e separator de mii, virgula e separator zecimal -> "1.090,50" => 1090.50
const toNum = (s) => parseFloat(String(s).trim().replace(/\./g, "").replace(",", "."));

async function fetchText(url, timeoutMs = 15000) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.text();
}

// Extrage constituentii (simbol, nume, pondere, pret de referinta) din tabelul indicelui.
function parseConstituents(html) {
  // Scopam parsarea strict la tabelul de compozitie (id="gvC") ca sa nu prindem alte tabele.
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
    const refPrice = toNum(cells[3]);          // "Pret ref." (fallback)
    const weight = toNum(cells[cells.length - 1]); // "Pondere (%)"

    if (symbol.length <= 5 && /^[A-Z0-9]+$/.test(symbol) && refPrice > 0 && weight > 0 && weight < 100) {
      out.push({ symbol, name, weight, refPrice });
    }
  }
  return out;
}

// Extrage "Ultimul pret" (ultimul pret tranzactionat) de pe pagina de detaliu a instrumentului.
async function fetchLastPrice(symbol) {
  try {
    const html = await fetchText(DETAIL_URL(symbol), 12000);
    const m = html.match(/Ultimul pret\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/i);
    if (!m) return null;
    const v = toNum(stripTags(m[1]));
    return v > 0 ? v : null;
  } catch {
    return null;
  }
}

export async function GET() {
  try {
    const indexHtml = await fetchText(INDEX_URL, 15000);
    const all = parseConstituents(indexHtml);

    if (all.length === 0) {
      return Response.json(
        { error: "Nu am găsit date în tabelul BVB.", htmlSize: indexHtml.length },
        { status: 422 }
      );
    }

    all.sort((a, b) => b.weight - a.weight);
    const top = all.slice(0, 10);

    // Pretul real ("Ultimul pret") pentru fiecare companie, in paralel.
    const lastPrices = await Promise.all(top.map((c) => fetchLastPrice(c.symbol)));

    let liveCount = 0;
    const companies = top.map((c, i) => {
      const last = lastPrices[i];
      const live = last != null;
      if (live) liveCount++;
      return {
        symbol: c.symbol,
        name: c.name,
        weight: c.weight,
        price: live ? last : c.refPrice, // fallback pe pretul de referinta daca nu exista tranzactii
        live,
      };
    });

    return Response.json({
      companies,
      updated: new Date().toISOString(),
      count: companies.length,
      total: all.length,
      live: liveCount, // cate preturi sunt "Ultimul pret" real (restul = pret de referinta)
    });
  } catch (e) {
    const msg =
      e.name === "TimeoutError" || e.name === "AbortError"
        ? "Timeout: BVB nu a răspuns la timp."
        : e.message;
    return Response.json({ error: msg }, { status: 504 });
  }
}

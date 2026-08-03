"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import * as XLSX from "xlsx";

// Valori de referinta (BVB ~01.07.2026, pret de cumparare/Ask). Sunt doar fallback static —
// la deschidere aplicatia incarca automat preturile de cumparare (Ask) reale de pe bvb.ro.
const DEFAULT_DATA = [
  { symbol: "TLV", name: "Banca Transilvania S.A.", weight: 18.63, price: 39.70 },
  { symbol: "SNP", name: "OMV Petrom S.A.", weight: 14.86, price: 1.075 },
  { symbol: "SNG", name: "S.N.G.N. Romgaz S.A.", weight: 13.28, price: 15.48 },
  { symbol: "H2O", name: "S.P.E.E.H. Hidroelectrica S.A.", weight: 12.85, price: 198.80 },
  { symbol: "BRD", name: "BRD - Groupe Société Générale S.A.", weight: 7.26, price: 36.45 },
  { symbol: "TGN", name: "S.N.T.G.N. Transgaz S.A.", weight: 6.73, price: 94.90 },
  { symbol: "DIGI", name: "Digi Communications N.V.", weight: 5.32, price: 61.10 },
  { symbol: "EL", name: "Societatea Energetică Electrica S.A.", weight: 5.21, price: 41.50 },
  { symbol: "SNN", name: "S.N. Nuclearelectrica S.A.", weight: 3.29, price: 73.00 },
  { symbol: "M", name: "MedLife S.A.", weight: 3.23, price: 12.50 },
];

// Bump la fiecare deploy ca sa confirmam vizual ca ruleaza codul nou.
const APP_VERSION = "2.5.0";

const COLORS = [
  "#2563eb","#10b981","#f59e0b","#06b6d4","#8b5cf6",
  "#ef4444","#ec4899","#14b8a6","#f97316","#6366f1",
];

function normalize(data) {
  const total = data.reduce((s, c) => s + c.weight, 0);
  return data.map((c, i) => ({ ...c, normWeight: (c.weight / total) * 100, color: COLORS[i] }));
}

function fmt(v) {
  return v.toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function Bar({ pct, color, label, delay }) {
  return <div style={{ width: `${pct}%`, height: "100%", background: color, transition: "width 0.8s cubic-bezier(.4,0,.2,1)", transitionDelay: `${delay}ms`, minWidth: pct > 2 ? "2px" : "0" }} title={`${label}: ${pct.toFixed(1)}%`} />;
}

function Spin() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ animation: "spin 1s linear infinite" }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      <circle cx="12" cy="12" r="10" stroke="rgba(59,130,246,0.25)" strokeWidth="3" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke="#2563eb" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function PriceCell({ value, isLive, onChange }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const start = () => { setDraft(value < 1 ? value.toFixed(4) : value.toFixed(2)); setEditing(true); };
  const commit = () => { const v = parseFloat(draft.replace(",", ".")); if (v > 0) onChange(v); setEditing(false); };
  if (editing) return <input autoFocus type="text" value={draft} onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }} style={{ width: 80, background: "rgba(37,99,235,0.15)", border: "1px solid rgba(59,130,246,0.4)", borderRadius: 6, padding: "4px 8px", fontSize: 13, color: "#e2e8f0", fontFamily: "'Space Mono', monospace", textAlign: "right", outline: "none" }} />;
  return (
    <div onClick={start} style={{ cursor: "pointer", textAlign: "right" }} title="Click pentru a edita">
      <span style={{ fontSize: 13, fontFamily: "'Space Mono', monospace", color: isLive ? "#10b981" : "#94a3b8", borderBottom: "1px dashed rgba(148,163,184,0.3)", paddingBottom: 1 }}>
        {value < 1 ? value.toFixed(4) : fmt(value)}
      </span>
      {isLive && <div style={{ fontSize: 8, color: "#10b981", marginTop: 1, fontFamily: "'Space Mono', monospace" }}>LIVE</div>}
    </div>
  );
}

function generateExcel(alloc, investAmount, totalInvested, totalRemainder, lastUpdate) {
  const wb = XLSX.utils.book_new();
  const d = [];
  d.push(["RAPORT ALOCARE INDICE BET"]);
  d.push([]);
  d.push(["Data raport:", new Date().toLocaleDateString("ro-RO") + " " + new Date().toLocaleTimeString("ro-RO", { hour: "2-digit", minute: "2-digit" })]);
  d.push(["Sursa prețuri:", lastUpdate]);
  d.push(["Sumă de investit (RON):", investAmount]);
  d.push(["Total investit (RON):", totalInvested]);
  d.push(["Rest nealocat (RON):", totalRemainder]);
  d.push(["Eficiență:", investAmount > 0 ? ((totalInvested / investAmount) * 100).toFixed(2) + "%" : "N/A"]);
  d.push([]);
  d.push(["Nr.", "Simbol", "Companie", "Pondere (%)", "Pond. Norm. (%)", "Preț/Acț. (RON)", "Sumă Alocată (RON)", "Nr. Acțiuni", "Cost (RON)", "Diferență (RON)", "Obs."]);
  alloc.forEach((a, i) => {
    const isMin = a.shares === 1 && a.allocated < a.price;
    d.push([i + 1, a.symbol, a.name, a.weight, +(a.normWeight.toFixed(2)), +(a.price.toFixed(4)), +(a.allocated.toFixed(2)), a.shares, +(a.cost.toFixed(2)), +(a.remainder.toFixed(2)), isMin ? "Min 1 acțiune" : ""]);
  });
  d.push(["", "", "TOTAL", "", "100.00", "", +(investAmount.toFixed(2)), alloc.reduce((s, a) => s + a.shares, 0), +(totalInvested.toFixed(2)), +(totalRemainder.toFixed(2)), ""]);
  d.push([]);
  d.push(["Ponderile provin din compoziția oficială BET (bvb.ro), normalizate la 100% pentru top 10."]);
  d.push(["Acest raport nu constituie sfat de investiții."]);
  const ws = XLSX.utils.aoa_to_sheet(d);
  ws["!cols"] = [{ wch: 5 }, { wch: 8 }, { wch: 28 }, { wch: 12 }, { wch: 14 }, { wch: 16 }, { wch: 16 }, { wch: 10 }, { wch: 14 }, { wch: 14 }, { wch: 16 }];
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 5 } }];
  XLSX.utils.book_append_sheet(wb, ws, "Alocare BET");
  XLSX.writeFile(wb, `raport_BET_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

export default function BETCalculator() {
  const [amount, setAmount] = useState("");
  const [data, setData] = useState(DEFAULT_DATA);
  const [liveSymbols, setLiveSymbols] = useState(new Set());
  const [loading, setLoading] = useState(false);
  const [lastUpdate, setLastUpdate] = useState("se încarcă prețurile live…");
  const [error, setError] = useState(null);
  const [exported, setExported] = useState(false);

  const companies = useMemo(() => normalize(data), [data]);
  const investAmount = parseFloat(amount) || 0;

  const allocations = useMemo(() => companies.map(c => {
    const allocated = (investAmount * c.normWeight) / 100;
    const shares = investAmount > 0 ? Math.max(1, Math.floor(allocated / c.price)) : 0;
    const cost = shares * c.price;
    return { ...c, allocated, shares, cost, remainder: allocated - cost };
  }), [investAmount, companies]);

  const totalInvested = allocations.reduce((s, a) => s + a.cost, 0);
  const totalRemainder = investAmount - totalInvested;
  const investPct = investAmount > 0 ? ((totalInvested / investAmount) * 100).toFixed(1) : "0";
  const overBudget = totalInvested > investAmount;

  const updatePrice = useCallback((sym, val) => {
    setData(d => d.map(c => c.symbol === sym ? { ...c, price: val } : c));
    setLiveSymbols(s => { const n = new Set(s); n.delete(sym); return n; });
  }, []);

  const handleRefresh = useCallback(async (silent = false) => {
    setLoading(true); setError(null);
    try {
      const res = await fetch("/api/prices", { signal: AbortSignal.timeout(25000) });
      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        throw new Error("Actualizarea live funcționează doar pe serverul deployat (Docker). Aici poți edita prețurile manual — click pe orice preț din tabel.");
      }
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Eroare: ${res.status}`);
      if (!json.companies || json.companies.length === 0) throw new Error("Nu s-au găsit companii în răspuns.");
      setData(json.companies.map(c => ({ symbol: c.symbol, name: c.name, weight: c.weight, price: c.price })));
      // Marcam LIVE doar companiile pentru care avem "Ultimul pret" real (restul = pret de referinta).
      setLiveSymbols(new Set(json.companies.filter(c => c.live !== false).map(c => c.symbol)));
      const now = new Date();
      const liveCount = json.live ?? json.count;
      setLastUpdate(now.toLocaleDateString("ro-RO") + " " + now.toLocaleTimeString("ro-RO", { hour: "2-digit", minute: "2-digit" }) + ` (${liveCount}/${json.count} prețuri live de pe bvb.ro)`);
    } catch (e) { if (!silent) setError(e.message); } finally { setLoading(false); }
  }, []);

  // Incarca automat preturile reale de pe bvb.ro la deschiderea paginii.
  // In mod "silent" nu afiseaza eroare daca esueaza — raman valorile de referinta.
  useEffect(() => { handleRefresh(true); }, [handleRefresh]);

  const handleExport = useCallback(() => {
    if (investAmount <= 0) { setError("Introdu o sumă de investit."); return; }
    generateExcel(allocations, investAmount, totalInvested, totalRemainder, lastUpdate);
    setExported(true); setTimeout(() => setExported(false), 3000);
  }, [allocations, investAmount, totalInvested, totalRemainder, lastUpdate]);

  const mono = "'Space Mono', monospace";
  const sans = "'DM Sans', 'Segoe UI', system-ui, sans-serif";

  return (
    <div style={{ minHeight: "100vh", background: "#0a0f1a", fontFamily: sans, color: "#e2e8f0" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet" />

      {/* Header */}
      <div style={{ background: "linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%)", borderBottom: "1px solid rgba(59,130,246,0.2)", padding: "28px 24px 24px" }}>
        <div style={{ maxWidth: 960, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ width: 40, height: 40, borderRadius: 10, background: "linear-gradient(135deg, #2563eb, #7c3aed)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 700, color: "#fff", fontFamily: mono, boxShadow: "0 0 20px rgba(37,99,235,0.3)" }}>B</div>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em", background: "linear-gradient(90deg, #e2e8f0, #94a3b8)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>Calculator Alocare BET</h1>
                  <span style={{ fontSize: 10, fontWeight: 700, color: "#34d399", background: "rgba(16,185,129,0.12)", border: "1px solid rgba(16,185,129,0.3)", borderRadius: 6, padding: "2px 7px", fontFamily: mono }}>v{APP_VERSION}</span>
                </div>
                <p style={{ margin: 0, fontSize: 11, color: "#64748b", fontFamily: mono }}>Top 10 constituenți · bvb.ro · preț cumpărare (Ask) · v{APP_VERSION}</p>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 10, color: "#475569", fontFamily: mono }}>Actualizat</div>
                <div style={{ fontSize: 11, color: "#64748b", fontFamily: mono }}>{lastUpdate}</div>
              </div>
              <button onClick={() => handleRefresh(false)} disabled={loading} style={{ display: "flex", alignItems: "center", gap: 8, background: loading ? "rgba(37,99,235,0.08)" : "linear-gradient(135deg, rgba(37,99,235,0.15), rgba(124,58,237,0.12))", border: "1px solid rgba(59,130,246,0.25)", borderRadius: 10, padding: "10px 16px", color: loading ? "#94a3b8" : "#60a5fa", fontSize: 12, fontWeight: 600, cursor: loading ? "wait" : "pointer", fontFamily: sans, transition: "all 0.2s" }}>
                {loading ? <><Spin /> Actualizez...</> : <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21.5 2v6h-6M2.5 22v-6h6" /><path d="M2.5 11.5a10 10 0 0 1 18.14-4.5M21.5 12.5a10 10 0 0 1-18.14 4.5" /></svg>Actualizează</>}
              </button>
              <button onClick={handleExport} style={{ display: "flex", alignItems: "center", gap: 8, background: exported ? "rgba(16,185,129,0.2)" : "linear-gradient(135deg, rgba(16,185,129,0.12), rgba(6,182,212,0.08))", border: `1px solid ${exported ? "rgba(16,185,129,0.4)" : "rgba(16,185,129,0.2)"}`, borderRadius: 10, padding: "10px 16px", color: exported ? "#34d399" : "#10b981", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: sans, transition: "all 0.2s" }}>
                {exported ? <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>Descărcat!</> : <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="12" y1="18" x2="12" y2="12" /><polyline points="9 15 12 18 15 15" /></svg>Raport Excel</>}
              </button>
            </div>
          </div>
          {error && <div style={{ marginTop: 12, padding: "10px 14px", borderRadius: 8, background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", fontSize: 12, color: "#f87171", fontFamily: mono }}>⚠ {error}</div>}
        </div>
      </div>

      <div style={{ maxWidth: 960, margin: "0 auto", padding: "24px 24px 48px" }}>
        {/* Input */}
        <div style={{ background: "linear-gradient(135deg, rgba(37,99,235,0.08), rgba(124,58,237,0.06))", border: "1px solid rgba(59,130,246,0.15)", borderRadius: 16, padding: "24px 28px", marginBottom: 24 }}>
          <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10, fontFamily: mono }}>Sumă de investit (RON)</label>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <input type="number" value={amount} onChange={e => setAmount(e.target.value)} placeholder="ex: 50000" style={{ flex: 1, background: "rgba(15,23,42,0.8)", border: "1px solid rgba(59,130,246,0.25)", borderRadius: 10, padding: "14px 18px", fontSize: 22, fontWeight: 700, color: "#e2e8f0", outline: "none", fontFamily: mono }} />
            <span style={{ fontSize: 18, fontWeight: 600, color: "#475569" }}>RON</span>
          </div>
          {investAmount > 0 && (
            <div style={{ marginTop: 18 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#64748b", marginBottom: 6, fontFamily: mono }}>
                <span>Alocat efectiv: {fmt(totalInvested)} RON</span><span>{investPct}% din sumă</span>
              </div>
              <div style={{ height: 8, borderRadius: 4, background: "rgba(30,41,59,0.8)", overflow: "hidden", display: "flex" }}>
                {allocations.map((a, i) => <Bar key={a.symbol} pct={(a.cost / investAmount) * 100} color={a.color} label={a.symbol} delay={i * 40} />)}
              </div>
              <div style={{ marginTop: 8, fontSize: 12, fontFamily: mono, color: overBudget ? "#ef4444" : "#f59e0b" }}>
                {overBudget ? `⚠ Depășire cu ${fmt(totalInvested - investAmount)} RON (min 1 acțiune/companie)` : `Rest nealocat: ${fmt(totalRemainder)} RON`}
              </div>
            </div>
          )}
        </div>

        {/* Legend */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 20 }}>
          {companies.map(c => (
            <div key={c.symbol} style={{ display: "flex", alignItems: "center", gap: 5, background: "rgba(30,41,59,0.5)", borderRadius: 6, padding: "4px 10px", fontSize: 11, color: "#94a3b8", fontFamily: mono }}>
              <div style={{ width: 8, height: 8, borderRadius: 2, background: c.color }} />{c.symbol}<span style={{ color: "#475569" }}>{c.normWeight.toFixed(1)}%</span>
            </div>
          ))}
        </div>

        {/* Table */}
        <div style={{ background: "rgba(15,23,42,0.6)", border: "1px solid rgba(59,130,246,0.1)", borderRadius: 16, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "44px 1fr 80px 100px 80px 100px 90px", padding: "14px 20px", background: "rgba(30,41,59,0.4)", borderBottom: "1px solid rgba(59,130,246,0.1)", fontSize: 10, fontWeight: 600, color: "#475569", textTransform: "uppercase", letterSpacing: "0.08em", fontFamily: mono }}>
            <div></div><div>Companie</div><div style={{ textAlign: "right" }}>Pondere</div><div style={{ textAlign: "right" }}>Preț ✎</div><div style={{ textAlign: "right" }}>Acțiuni</div><div style={{ textAlign: "right" }}>Cost</div><div style={{ textAlign: "right" }}>Diferență</div>
          </div>
          {allocations.map((a, i) => {
            const isMin = a.shares === 1 && a.allocated < a.price;
            return (
              <div key={a.symbol} style={{ display: "grid", gridTemplateColumns: "44px 1fr 80px 100px 80px 100px 90px", padding: "12px 20px", borderBottom: i < allocations.length - 1 ? "1px solid rgba(30,41,59,0.8)" : "none", alignItems: "center", opacity: loading ? 0.4 : 1, transition: "opacity 0.3s", background: isMin ? "rgba(239,68,68,0.03)" : "transparent" }}
                onMouseEnter={e => e.currentTarget.style.background = isMin ? "rgba(239,68,68,0.06)" : "rgba(37,99,235,0.04)"}
                onMouseLeave={e => e.currentTarget.style.background = isMin ? "rgba(239,68,68,0.03)" : "transparent"}>
                <div style={{ width: 32, height: 32, borderRadius: 8, background: `${a.color}18`, border: `1px solid ${a.color}30`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, color: a.color, fontFamily: mono }}>{a.symbol.slice(0, 3)}</div>
                <div style={{ paddingLeft: 8 }}><span style={{ fontSize: 14, fontWeight: 600, color: "#e2e8f0" }}>{a.symbol}</span><div style={{ fontSize: 11, color: "#475569", marginTop: 1 }}>{a.name}</div></div>
                <div style={{ textAlign: "right", fontSize: 13, fontWeight: 600, color: "#94a3b8", fontFamily: mono }}>{a.normWeight.toFixed(2)}%</div>
                <PriceCell value={a.price} isLive={liveSymbols.has(a.symbol)} onChange={v => updatePrice(a.symbol, v)} />
                <div style={{ textAlign: "right", display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 4 }}>
                  <span style={{ fontSize: 16, fontWeight: 700, color: investAmount > 0 ? (isMin ? "#f59e0b" : "#2563eb") : "#334155", fontFamily: mono }}>{investAmount > 0 ? a.shares.toLocaleString("ro-RO") : "—"}</span>
                  {isMin && investAmount > 0 && <span style={{ fontSize: 9, color: "#f59e0b", fontWeight: 600 }}>MIN</span>}
                </div>
                <div style={{ textAlign: "right", fontSize: 12, color: "#94a3b8", fontFamily: mono }}>{investAmount > 0 ? fmt(a.cost) : "—"}</div>
                <div style={{ textAlign: "right", fontSize: 11, fontFamily: mono, color: investAmount > 0 ? (a.remainder < 0 ? "#ef4444" : "#f59e0b") : "#334155" }}>{investAmount > 0 ? (a.remainder >= 0 ? "+" : "") + fmt(a.remainder) : "—"}</div>
              </div>
            );
          })}
          {investAmount > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: "44px 1fr 80px 100px 80px 100px 90px", padding: "16px 20px", background: "rgba(37,99,235,0.06)", borderTop: "1px solid rgba(59,130,246,0.15)", fontFamily: mono }}>
              <div></div><div style={{ paddingLeft: 8, fontSize: 13, fontWeight: 700, color: "#e2e8f0" }}>TOTAL</div><div style={{ textAlign: "right", fontSize: 12, fontWeight: 600, color: "#64748b" }}>100%</div><div></div><div></div>
              <div style={{ textAlign: "right", fontSize: 13, fontWeight: 700, color: overBudget ? "#ef4444" : "#10b981" }}>{fmt(totalInvested)}</div>
              <div style={{ textAlign: "right", fontSize: 12, fontWeight: 600, color: overBudget ? "#ef4444" : "#f59e0b" }}>{(totalRemainder >= 0 ? "+" : "") + fmt(totalRemainder)}</div>
            </div>
          )}
        </div>

        <div style={{ marginTop: 20, padding: "14px 18px", background: "rgba(30,41,59,0.3)", borderRadius: 10, border: "1px solid rgba(59,130,246,0.08)", fontSize: 11, color: "#475569", lineHeight: 1.7, fontFamily: mono }}>
          <strong style={{ color: "#64748b" }}>Cum funcționează:</strong><br />
          • <strong style={{ color: "#60a5fa" }}>Actualizează</strong> — scraping direct pe bvb.ro (prețuri + ponderi, ~2s)<br />
          • <strong style={{ color: "#94a3b8" }}>Click pe preț</strong> — editare manuală · <strong style={{ color: "#10b981" }}>Raport Excel</strong> — descarcă .xlsx<br />
          • Min 1 acțiune/companie (<span style={{ color: "#f59e0b" }}>MIN</span>) · Nu constituie sfat de investiții
        </div>
      </div>
    </div>
  );
}

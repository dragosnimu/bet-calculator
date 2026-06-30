#!/usr/bin/env node
const BASE = process.argv[2] || "http://localhost:3000";
let p = 0, f = 0;
async function check(n, fn) { try { await fn(); console.log(`  ✅ ${n}`); p++; } catch (e) { console.log(`  ❌ ${n}\n     → ${e.message}`); f++; } }
console.log(`\n🏥 Health check: ${BASE}\n`);
await check("GET / → 200", async () => { const r = await fetch(BASE); if (!r.ok) throw new Error(`${r.status}`); });
await check("GET /api/prices → date BVB", async () => {
  const r = await fetch(`${BASE}/api/prices`);
  const d = await r.json();
  if (r.ok) { console.log(`     → ${d.count} companii, primul: ${d.companies?.[0]?.symbol} @ ${d.companies?.[0]?.price} RON`); }
  else { console.log(`     → ${d.error}`); }
});
await check("Timp răspuns < 2s", async () => { const t = Date.now(); await fetch(BASE); const ms = Date.now() - t; if (ms > 2000) throw new Error(`${ms}ms`); console.log(`     → ${ms}ms`); });
console.log(`\n${"═".repeat(35)}\n  ${p+f} | ✅ ${p} | ❌ ${f}\n${"═".repeat(35)}\n`);
process.exit(f > 0 ? 1 : 0);

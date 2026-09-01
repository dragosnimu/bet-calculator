#!/usr/bin/env node
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { spawnSync } from "child_process";
const root = resolve(import.meta.dirname, "..");
let p = 0, f = 0;
function test(name, fn) { try { fn(); console.log(`  ✅ ${name}`); p++; } catch (e) { console.log(`  ❌ ${name}\n     → ${e.message}`); f++; } }
function assert(c, m) { if (!c) throw new Error(m); }

console.log("\n🧪 Teste pre-deploy\n");
console.log("📁 Fișiere:");
for (const f of ["package.json","next.config.js","Dockerfile","docker-compose.yml",".dockerignore","app/layout.jsx","app/page.jsx","app/api/prices/route.js","components/BETCalculator.jsx"]) {
  test(f, () => assert(existsSync(resolve(root, f)), `Lipsește: ${f}`));
}
console.log("\n📦 Package:");
test("dependențe corecte", () => {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  assert(pkg.dependencies?.next, "next lipsește");
  assert(pkg.dependencies?.xlsx, "xlsx lipsește");
});
console.log("\n🐳 Docker:");
test("Dockerfile valid", () => {
  const d = readFileSync(resolve(root, "Dockerfile"), "utf8");
  assert(d.includes("AS deps") && d.includes("AS builder") && d.includes("AS runner"), "multi-stage lipsește");
  assert(d.includes("HEALTHCHECK"), "healthcheck lipsește");
});
console.log("\n🔌 API:");
test("route.js scraping BVB cu regex", () => {
  const a = readFileSync(resolve(root, "app/api/prices/route.js"), "utf8");
  assert(a.includes("bvb.ro"), "URL BVB lipsește");
  assert(a.includes("regex") || a.includes("Regex") || a.includes("<td") || a.includes("cellRegex"), "nu folosește regex parsing");
  assert(!a.includes("cheerio"), "încă folosește cheerio!");
  assert(!a.includes("anthropic"), "încă folosește Anthropic!");
});
console.log("\n🧩 Component:");
test("client component valid", () => {
  const c = readFileSync(resolve(root, "components/BETCalculator.jsx"), "utf8");
  assert(c.includes('"use client"'), "use client lipsește");
  assert(c.includes("/api/prices"), "nu apelează /api/prices");
  assert(c.includes("xlsx"), "xlsx lipsește");
  for (const s of ["TLV","SNP","SNG","H2O","BRD","TGN","DIGI","EL","SNN"]) assert(c.includes(`"${s}"`), `${s} lipsește`);
});
console.log("\n🔒 Securitate:");
test("fără chei hardcodate", () => {
  for (const f of ["components/BETCalculator.jsx","app/api/prices/route.js"]) {
    assert(!readFileSync(resolve(root, f), "utf8").includes("sk-ant-"), `Cheie în ${f}!`);
  }
});

// Suita de regresie de securitate a worker-ului (autorizare Telegram, escapare HTML, invarianti TA).
console.log("\n🔒 Worker (securitate):");
const sec = spawnSync(process.execPath, [resolve(root, "scripts/test-worker-security.mjs")], { encoding: "utf8", timeout: 60000 });
process.stdout.write(sec.stdout || "");
if (sec.stderr) process.stderr.write(sec.stderr);
test("regresie securitate worker (test-worker-security.mjs)", () => {
  assert(sec.status === 0, `suita de securitate a picat (exit ${sec.status})`);
});

// Suita rendererului de grafice PNG (font bitmap, axe/scala, legenda, PNG valid).
console.log("\n🖼️  Grafic PNG:");
const png = spawnSync(process.execPath, [resolve(root, "scripts/test-png-chart.mjs")], { encoding: "utf8", timeout: 60000 });
process.stdout.write(png.stdout || "");
if (png.stderr) process.stderr.write(png.stderr);
test("renderer grafic PNG (test-png-chart.mjs)", () => {
  assert(png.status === 0, `suita PNG a picat (exit ${png.status})`);
});

console.log("\n" + "═".repeat(45));
console.log(`  ${p + f} teste | ✅ ${p} | ❌ ${f}`);
console.log("═".repeat(45) + "\n");
process.exit(f > 0 ? 1 : 0);

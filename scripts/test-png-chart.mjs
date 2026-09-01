#!/usr/bin/env node
// Test durabil pentru rendererul de grafice PNG (png-chart.mjs, zero dependinte).
// Verifica:
//  - PNG valid cu title + overlay etichetat + refPrice: semnatura 8 bytes, chunk IHDR cu
//    latimea/inaltimea corecte, prezenta IDAT/IEND;
//  - drawText (indirect, prin randare) nu crapa pe input gol / caractere necunoscute.
// Ruleaza standalone (`node scripts/test-png-chart.mjs`) sau apelat din scripts/test.mjs.
import { renderLineChartPNG } from "./png-chart.mjs";
import { inflateSync } from "zlib";

let p = 0, f = 0;
const fails = [];
function test(name, fn) { try { fn(); console.log(`  ✅ ${name}`); p++; } catch (e) { console.log(`  ❌ ${name}\n     → ${e.message}`); fails.push(name); f++; } }
function assert(c, m) { if (!c) throw new Error(m); }

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
// Parcurge chunk-urile PNG si intoarce lista {type, length}.
function readChunks(buf) {
  assert(buf.subarray(0, 8).equals(PNG_SIG), "semnatura PNG lipsa/gresita");
  const out = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    out.push({ type, length: len, dataOff: off + 8 });
    off += 12 + len; // len(4)+type(4)+data+crc(4)
  }
  return out;
}

console.log("\n🖼️  Renderer grafic PNG\n");

test("PNG valid cu title + overlay etichetat + refPrice (IHDR corect)", () => {
  const width = 640, height = 300;
  const points = [10, 10.5, 10.2, 11, 10.8, 11.4, 11.1, 11.9];
  const overlays = [{ points: [null, 10.3, 10.35, 10.6, 10.7, 10.9, 11.0, 11.2], r: 245, g: 158, b: 11, label: "EMA9" }];
  const png = renderLineChartPNG({
    points, up: true, refPrice: 10.4, overlays, width, height,
    title: "TLV · intraday 15m", refLabel: "Referinta = inchidere ieri", sampleMinutes: 15,
  });
  assert(Buffer.isBuffer(png), "rezultatul nu e Buffer");
  const chunks = readChunks(png);
  const ihdr = chunks.find((c) => c.type === "IHDR");
  assert(ihdr && ihdr.dataOff === 16 && chunks[0].type === "IHDR", "IHDR lipsa sau nu e primul chunk");
  assert(png.readUInt32BE(ihdr.dataOff) === width, "latime IHDR gresita");
  assert(png.readUInt32BE(ihdr.dataOff + 4) === height, "inaltime IHDR gresita");
  assert(png[ihdr.dataOff + 8] === 8 && png[ihdr.dataOff + 9] === 2, "bit depth / color type gresit (asteptat 8/2)");
  assert(chunks.some((c) => c.type === "IDAT" && c.length > 0), "IDAT lipsa sau gol");
  assert(chunks.at(-1).type === "IEND", "IEND nu e ultimul chunk");
});

test("drawText nu crapa pe title gol / caractere necunoscute / diacritice", () => {
  // title cu simboluri neincluse in font (·, diacritice, emoji) — trebuie sarite, fara throw.
  const png = renderLineChartPNG({
    points: [1, 2, 3], up: false, refPrice: 2,
    overlays: [{ points: [null, 1.5, 2.5], r: 96, g: 165, b: 250, label: "Analiză ⚠ ĂÎȚ #@~" }],
    title: "Ș·Ț ✓ 🚀 <b>x</b>", refLabel: "", width: 320, height: 180,
  });
  const chunks = readChunks(png);
  assert(png.readUInt32BE(chunks.find((c) => c.type === "IHDR").dataOff) === 320, "latime gresita pe input cu chars necunoscute");
});

test("compatibilitate inapoi — apel minimal fara title/label/unit/sampleMinutes", () => {
  const png = renderLineChartPNG({ points: [5, 6, 5.5, 6.2] });
  const chunks = readChunks(png);
  assert(chunks[0].type === "IHDR" && chunks.at(-1).type === "IEND", "PNG minimal invalid");
  assert(png.readUInt32BE(chunks[0].dataOff) === 820, "latime default gresita");
});

test("input degenerat — points gol si un singur punct nu crapa", () => {
  for (const points of [[], [42]]) {
    const png = renderLineChartPNG({ points, title: "X", overlays: [{ points: points.map(() => null), r: 1, g: 2, b: 3, label: "Y" }] });
    assert(readChunks(png)[0].type === "IHDR", "IHDR lipsa pe input degenerat");
  }
});

// Verifica integritatea profunda: IDAT-ul decomprimat trebuie sa aiba exact
// height * (1 + width*3) bytes (un scanline "filter:none" + RGB per linie). Prinde
// erori de encoding/stride pe care doar citirea header-elor nu le-ar detecta.
test("IDAT se decomprima la dimensiunea raw corecta (stride/scanline valide)", () => {
  const cases = [
    { points: [10, 10.5, 10.2, 11], width: 640, height: 300, title: "TLV" },
    { points: [1, 2, 3], width: 21, height: 17 }, // dimensiuni impare, margini > canvas
  ];
  for (const c of cases) {
    const png = renderLineChartPNG(c);
    const chunks = readChunks(png);
    const idat = chunks.filter((x) => x.type === "IDAT")
      .map((x) => png.subarray(x.dataOff, x.dataOff + x.length));
    const raw = inflateSync(Buffer.concat(idat));
    const expected = c.height * (1 + c.width * 3);
    assert(raw.length === expected, `raw ${raw.length} != ${expected} (w=${c.width} h=${c.height})`);
  }
});

// Baterie de input netrusted / degenerat pe fluxul de randare: valori non-finite,
// ref la zero, preturi negative/egale, overlays nealiniate ca lungime, magnitudini
// extreme si titluri/etichete ostile. Niciunul nu trebuie sa arunce; toate produc PNG valid.
test("baterie edge-case: NaN/Infinity/null/ref=0/negative/overlays nealiniate nu crapa", () => {
  const cases = [
    { points: [1, NaN, 3, 2], title: "T" },
    { points: [1, null, 3], title: "T" },
    { points: [1, Infinity, 3], title: "T" },
    { points: [1, -Infinity, 3] },
    { points: [NaN, NaN] },
    { points: [1, 2, 3], refPrice: 0, title: "REF0" },
    { points: [-5, -3, -8], refPrice: -4, title: "NEG" },
    { points: [7, 7, 7, 7], refPrice: 7, title: "EQ" },
    { points: [1e12, 2e12, 1.5e12], title: "BIG" },
    { points: [0.0001, 0.0002, 0.00015], title: "SMALL" },
    { points: [1, 2], overlays: [{ points: [1, 2, 3, 4, 5], r: 1, g: 2, b: 3, label: "OVLONG" }] },
    { points: [1, 2, 3, 4], overlays: [{ points: [1], r: 1, g: 2, b: 3, label: "OVSHORT" }] },
    { points: [1, 2, 3], refPrice: NaN, title: "REFNAN" },
    { points: [1, 2, 3], sampleMinutes: -15, title: "NEGSM" },
    { points: [1, 2, 3], sampleMinutes: 1e9, title: "HUGESM" },
    { points: [1, 2, 3], title: "A".repeat(4000) }, // titlu enorm, off-canvas
    { points: [1, 2, 3], title: 12345 },             // titlu non-string
    { points: [1, 2, 3], title: null },
  ];
  for (const c of cases) {
    const png = renderLineChartPNG(c);
    const chunks = readChunks(png);
    assert(chunks[0].type === "IHDR" && chunks.at(-1).type === "IEND", `PNG invalid pe caz ${c.title ?? "?"}`);
  }
});

console.log(`\n  ${p + f} teste PNG | ✅ ${p} | ❌ ${f}`);
if (f > 0) { console.log("  eșecuri: " + fails.join(", ")); process.exit(1); }
process.exit(0);

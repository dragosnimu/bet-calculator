// Generator minimal de grafic linie -> PNG, folosind DOAR zlib din Node (zero dependinte).
// Deseneaza linia pretului + grila + overlays, plus SCALA (axe cu valori), LEGENDA si TITLU,
// randate cu un font bitmap 5x7 propriu (fara fisiere/dependinte externe).
import { deflateSync } from "zlib";

// CRC32 (pentru chunk-urile PNG)
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "latin1");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

// ---- Font bitmap 5x7 (zero dependinte) ----
// Fiecare glif = 7 randuri de cate 5 biti (bit 4 = coloana din stanga). Suficient pentru
// etichete: cifre, A-Z, si simbolurile . , : % - + / = ( ) si spatiu. Literele mici sunt
// mapate la majuscule (nu avem glife separate), caracterele necunoscute se sar (spatiu gol).
const FONT = {
  "0": [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  "1": [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  "2": [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
  "3": [0b11111, 0b00010, 0b00100, 0b00010, 0b00001, 0b10001, 0b01110],
  "4": [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  "5": [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  "6": [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  "7": [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  "8": [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  "9": [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
  A: [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  B: [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110],
  C: [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110],
  D: [0b11100, 0b10010, 0b10001, 0b10001, 0b10001, 0b10010, 0b11100],
  E: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
  F: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000],
  G: [0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01111],
  H: [0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  I: [0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  J: [0b00111, 0b00010, 0b00010, 0b00010, 0b00010, 0b10010, 0b01100],
  K: [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001],
  L: [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
  M: [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
  N: [0b10001, 0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001],
  O: [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  P: [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
  Q: [0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101],
  R: [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
  S: [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
  T: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
  U: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  V: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100],
  W: [0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b11011, 0b10001],
  X: [0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001],
  Y: [0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100],
  Z: [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111],
  " ": [0, 0, 0, 0, 0, 0, 0],
  ".": [0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b00100, 0b00100],
  ",": [0b00000, 0b00000, 0b00000, 0b00000, 0b00100, 0b00100, 0b01000],
  ":": [0b00000, 0b00100, 0b00100, 0b00000, 0b00100, 0b00100, 0b00000],
  "%": [0b11000, 0b11001, 0b00010, 0b00100, 0b01000, 0b10011, 0b00011],
  "-": [0b00000, 0b00000, 0b00000, 0b11111, 0b00000, 0b00000, 0b00000],
  "+": [0b00000, 0b00100, 0b00100, 0b11111, 0b00100, 0b00100, 0b00000],
  "/": [0b00001, 0b00010, 0b00010, 0b00100, 0b01000, 0b01000, 0b10000],
  "=": [0b00000, 0b00000, 0b11111, 0b00000, 0b11111, 0b00000, 0b00000],
  "(": [0b00010, 0b00100, 0b01000, 0b01000, 0b01000, 0b00100, 0b00010],
  ")": [0b01000, 0b00100, 0b00010, 0b00010, 0b00010, 0b00100, 0b01000],
  "·": [0b00000, 0b00000, 0b00000, 0b00100, 0b00000, 0b00000, 0b00000],
};
const GLYPH_W = 5, GLYPH_H = 7, CHAR_ADVANCE = 6; // 5px glif + 1px spatiu

function glyphFor(ch) {
  if (FONT[ch]) return FONT[ch];
  const up = ch.toUpperCase();
  return FONT[up] || null; // necunoscut -> null (se sare, dar avanseaza)
}
// Latimea in pixeli a unui text randat (fara spatiul de dupa ultimul caracter).
function measureText(text, scale = 1) {
  const s = String(text ?? "");
  if (!s.length) return 0;
  return (s.length * CHAR_ADVANCE - 1) * scale;
}

// Ruleaza un grafic linie. points = array de numere (preturi), in ordine cronologica.
// up = true (verde) / false (rosu). refPrice = linie de referinta (optional).
// overlays = [{ points:[...|null], r,g,b, label? }] — ex. linii EMA (null = fara valoare).
// title = titlu optional (sus). unit = unitatea axei Y (default RON). sampleMinutes =
// intervalul dintre esantioane (default 15) pentru etichetele de timp. refLabel = eticheta
// de legenda pentru linia de referinta.
export function renderLineChartPNG({
  points, up = true, refPrice = null, overlays = [], width = 820, height = 380,
  title = "", unit = "RON", sampleMinutes = 15, refLabel = "",
}) {
  const px = new Uint8Array(width * height * 3);
  const set = (x, y, r, g, b) => {
    x |= 0; y |= 0;
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const i = (y * width + x) * 3; px[i] = r; px[i + 1] = g; px[i + 2] = b;
  };
  const fill = (r, g, b) => { for (let i = 0; i < px.length; i += 3) { px[i] = r; px[i + 1] = g; px[i + 2] = b; } };
  const rect = (x, y, w, h, r, g, b) => { for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) set(x + xx, y + yy, r, g, b); };
  const hline = (y, x0, x1, r, g, b, dash = 0) => {
    for (let x = x0; x <= x1; x++) { if (dash && (x >> 0) % (dash * 2) >= dash) continue; set(x, y, r, g, b); }
  };
  const line = (x0, y0, x1, y1, r, g, b, thick = 2) => {
    x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      for (let o = -(thick - 1); o <= thick - 1; o++) { set(x0, y0 + o, r, g, b); set(x0 + o, y0, r, g, b); }
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  };
  const disc = (cx, cy, rad, r, g, b) => {
    for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) if (dx * dx + dy * dy <= rad * rad) set(cx + dx, cy + dy, r, g, b);
  };
  // Deseneaza text in bufferul de pixeli. Caracterele necunoscute se sar (avanseaza spatiul).
  const drawText = (x, y, text, r, g, b, scale = 1) => {
    let cx = x | 0;
    for (const ch of String(text ?? "")) {
      const gly = glyphFor(ch);
      if (gly) {
        for (let row = 0; row < GLYPH_H; row++) {
          const bits = gly[row];
          for (let col = 0; col < GLYPH_W; col++) {
            if ((bits >> (GLYPH_W - 1 - col)) & 1) {
              if (scale === 1) set(cx + col, y + row, r, g, b);
              else rect(cx + col * scale, y + row * scale, scale, scale, r, g, b);
            }
          }
        }
      }
      cx += CHAR_ADVANCE * scale;
    }
  };

  // fundal (tema inchisa, ca in aplicatie)
  fill(10, 15, 26);

  const hasTitle = !!(title && String(title).length);
  // Margini: L pt. etichetele axei Y (+unitate), B pt. timp, T pt. titlu, R ca 'acum' sa incapa.
  const L = 64, R = width - 48, T = hasTitle ? 34 : 20, B = height - 32;
  const n = points.length;
  let min = n ? Math.min(...points) : 0, max = n ? Math.max(...points) : 1;
  if (refPrice != null) { min = Math.min(min, refPrice); max = Math.max(max, refPrice); }
  for (const ov of overlays) for (const v of ov.points) if (v != null) { if (v < min) min = v; if (v > max) max = v; }
  if (!isFinite(min) || !isFinite(max)) { min = 0; max = 1; }
  if (min === max) { min -= 1; max += 1; }
  const pad = (max - min) * 0.08; min -= pad; max += pad;

  const xOf = (i) => L + (n <= 1 ? 0 : (i / (n - 1)) * (R - L));
  const yOf = (v) => B - ((v - min) / (max - min)) * (B - T);

  // Format lizibil pentru valorile axei Y (adaptiv la magnitudine).
  const fmtNum = (v) => { const a = Math.abs(v); return v.toFixed(a >= 1 ? 2 : 4); };

  const AXIS = [148, 163, 184];   // etichete axe (gri deschis)
  const GRID = [30, 41, 59];      // linii grila (gri inchis)
  const INK = [226, 232, 240];    // text principal (titlu/legenda)

  // grila orizontala + etichete Y (aliniate cu liniile de grila), unitatea pe linia de sus
  for (let k = 0; k <= 4; k++) {
    const y = (T + (k / 4) * (B - T)) | 0;
    hline(y, L, R, GRID[0], GRID[1], GRID[2]);
    const val = max - (k / 4) * (max - min);
    const label = k === 0 ? `${fmtNum(val)} ${unit}` : fmtNum(val);
    const tx = Math.max(2, L - 5 - measureText(label, 1)); // aliniat la dreapta, langa axa
    drawText(tx, y - 3, label, AXIS[0], AXIS[1], AXIS[2], 1);
  }

  // etichete axa X (timp relativ derivat din nr. de puncte * sampleMinutes)
  const spanMin = Math.max(0, (n - 1) * sampleMinutes);
  const ty = B + 6;
  if (spanMin > 0) {
    const hrs = spanMin / 60;
    const leftLabel = hrs >= 1 ? `-${Number.isInteger(hrs) ? hrs : hrs.toFixed(1)}H` : `-${spanMin}M`;
    drawText(L, ty, leftLabel, AXIS[0], AXIS[1], AXIS[2], 1);
    const mid = "...";
    drawText(((L + R) / 2 - measureText(mid, 1) / 2) | 0, ty, mid, AXIS[0], AXIS[1], AXIS[2], 1);
  }
  const rightLabel = "ACUM";
  drawText((R - measureText(rightLabel, 1)) | 0, ty, rightLabel, AXIS[0], AXIS[1], AXIS[2], 1);

  // linie de referinta (inchiderea de ieri) — gri, punctata
  if (refPrice != null) { const y = yOf(refPrice) | 0; hline(y, L, R, 100, 116, 139, 5); }

  // overlays (EMA etc.) — sub linia pretului, mai subtiri
  for (const ov of overlays) {
    for (let i = 1; i < n; i++) {
      if (ov.points[i - 1] == null || ov.points[i] == null) continue;
      line(xOf(i - 1), yOf(ov.points[i - 1]), xOf(i), yOf(ov.points[i]), ov.r, ov.g, ov.b, 1);
    }
  }

  // culoarea trendului
  const [cr, cg, cb] = up ? [16, 185, 129] : [239, 68, 68];

  // polilinia pretului
  for (let i = 1; i < n; i++) line(xOf(i - 1), yOf(points[i - 1]), xOf(i), yOf(points[i]), cr, cg, cb, 2);
  // puncte start/end
  if (n > 0) { disc(xOf(0) | 0, yOf(points[0]) | 0, 4, 148, 163, 184); disc(xOf(n - 1) | 0, yOf(points[n - 1]) | 0, 5, cr, cg, cb); }

  // titlu (sus, scala 2, centrat pe zona de plot)
  if (hasTitle) {
    const t = String(title);
    const tw = measureText(t, 2);
    drawText(Math.max(4, ((L + R) / 2 - tw / 2) | 0), 8, t, INK[0], INK[1], INK[2], 2);
  }

  // legenda (colt sus-stanga, in interiorul zonei de plot) — doar cand exista context
  const legend = [];
  const showLegend = hasTitle || overlays.some((o) => o && o.label);
  if (showLegend) {
    legend.push({ r: cr, g: cg, b: cb, label: "Pret" });
    for (const ov of overlays) if (ov && ov.label) legend.push({ r: ov.r, g: ov.g, b: ov.b, label: String(ov.label) });
    if (refPrice != null) legend.push({ r: 100, g: 116, b: 139, label: refLabel ? String(refLabel) : "Referinta", dashed: true });
  }
  const ly0 = T + 6;
  const lx = L + 8;
  if (legend.length) {
    // panou de fundal ca legenda sa ramana lizibila peste linia pretului
    const panelW = 18 + Math.max(...legend.map((e) => measureText(e.label, 1))) + 8;
    const panelH = legend.length * 12 + 4;
    rect(lx - 6, ly0 - 4, panelW, panelH, 17, 24, 39);
  }
  let ly = ly0;
  for (const e of legend) {
    if (e.dashed) { for (let dx = 0; dx < 14; dx += 4) rect(lx + dx, ly + 3, 2, 2, e.r, e.g, e.b); }
    else rect(lx, ly + 2, 14, 4, e.r, e.g, e.b);
    drawText(lx + 18, ly, e.label, INK[0], INK[1], INK[2], 1);
    ly += 12;
  }

  // ---- encode PNG (truecolor RGB, 8-bit) ----
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const stride = 1 + width * 3;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    raw.set(px.subarray(y * width * 3, (y + 1) * width * 3), y * stride + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

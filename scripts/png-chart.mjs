// Generator minimal de grafic linie -> PNG, folosind DOAR zlib din Node (zero dependinte).
// Textul (simbol, %, ore) se pune in caption-ul Telegram; imaginea e doar linia + grila.
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

// Ruleaza un grafic linie. points = array de numere (preturi), in ordine cronologica.
// up = true (verde) / false (rosu). refPrice = linie de referinta (optional).
export function renderLineChartPNG({ points, up = true, refPrice = null, width = 820, height = 380 }) {
  const px = new Uint8Array(width * height * 3);
  const set = (x, y, r, g, b) => {
    x |= 0; y |= 0;
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const i = (y * width + x) * 3; px[i] = r; px[i + 1] = g; px[i + 2] = b;
  };
  const fill = (r, g, b) => { for (let i = 0; i < px.length; i += 3) { px[i] = r; px[i + 1] = g; px[i + 2] = b; } };
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

  // fundal (ca in aplicatie)
  fill(10, 15, 26);

  const L = 12, R = width - 12, T = 16, B = height - 16;
  const n = points.length;
  let min = Math.min(...points), max = Math.max(...points);
  if (refPrice != null) { min = Math.min(min, refPrice); max = Math.max(max, refPrice); }
  if (min === max) { min -= 1; max += 1; }
  const pad = (max - min) * 0.08; min -= pad; max += pad;

  const xOf = (i) => L + (n <= 1 ? 0 : (i / (n - 1)) * (R - L));
  const yOf = (v) => B - ((v - min) / (max - min)) * (B - T);

  // grila orizontala
  for (let k = 0; k <= 4; k++) { const y = T + (k / 4) * (B - T); hline(y | 0, L, R, 30, 41, 59); }

  // linie de referinta (inchiderea de ieri) — gri, punctata
  if (refPrice != null) { const y = yOf(refPrice) | 0; hline(y, L, R, 100, 116, 139, 5); }

  // culoarea trendului
  const [cr, cg, cb] = up ? [16, 185, 129] : [239, 68, 68];

  // polilinia pretului
  for (let i = 1; i < n; i++) line(xOf(i - 1), yOf(points[i - 1]), xOf(i), yOf(points[i]), cr, cg, cb, 2);
  // puncte start/end
  if (n > 0) { disc(xOf(0) | 0, yOf(points[0]) | 0, 4, 148, 163, 184); disc(xOf(n - 1) | 0, yOf(points[n - 1]) | 0, 5, cr, cg, cb); }

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

// png-squeeze: squeeze 1280x720 RGBA screenshots into the smallest lossless PNG.
//
// Reads /input/<id>/image.png, writes /output/<id>/image.png.
// Pure TypeScript (erasable syntax), Node 22 stdlib only, no dependencies.
// Deterministic: the same input always yields byte-identical output.
//
// Strategy:
//   1. Decode the stored PNG (colour type 6, unfiltered rows, stored zlib).
//   2. Analyse the image: opaque? grey? how many distinct colours?
//   3. Try the exact representations that can hold it (palette, grey,
//      grey+alpha, RGB, RGBA, plus a tRNS key where one applies) and keep
//      the smallest after real compression.
//   4. Per-row adaptive filtering, chosen by an entropy estimate.
//   5. A from-scratch lazy-matching DEFLATE encoder (hash-chain match
//      search, dynamic Huffman tables) that usually beats zlib level 9.

import { deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------- PNG codec

const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngOf(chunks: [string, Uint8Array][]): Uint8Array {
  let size = SIGNATURE.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let at = SIGNATURE.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    for (let i = 0; i < 4; i++) out[at + 4 + i] = type.charCodeAt(i);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width: number, height: number, colourType: number): Uint8Array {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Filter one row (cur, stride samples) with `type` into out. */
function filterRow(type: number, cur: Uint8Array, prev: Uint8Array | null, bpp: number, out: Uint8Array): void {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    if (prev === null) out.set(cur);
    else for (let i = 0; i < n; i++) out[i] = cur[i] - prev[i];
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      out[i] = cur[i] - ((a + b) >> 1);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = i >= bpp && prev !== null ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

/** Sum of |signed byte| of a filtered row (PNG spec section 12.8 heuristic). */
function signedSum(row: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

/** Decode any bit-depth-8 non-interlaced PNG the contest accepts into RGBA. */
function decodePng(bytes: Uint8Array): { rgba: Uint8Array; width: number; height: number } {
  let at = 8;
  let width = 0;
  let height = 0;
  let colourType = 6;
  const idat: number[] = [];
  let plte: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  while (at + 8 <= bytes.length) {
    const len = (bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3];
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
      width = v.getUint32(0);
      height = v.getUint32(4);
      colourType = data[9];
    } else if (type === 'PLTE') {
      plte = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      for (let i = 0; i < data.length; i++) idat.push(data[i]);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + len;
  }
  const ch = CHANNELS[colourType];
  const stride = width * ch;
  const raw = inflateSync(new Uint8Array(idat));
  const rgba = new Uint8Array(width * height * 4);
  const prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = new Uint8Array(stride);
    if (f === 0) {
      out.set(row);
    } else if (f === 1) {
      for (let i = 0; i < stride; i++) out[i] = row[i] + (i >= ch ? out[i - ch] : 0);
    } else if (f === 2) {
      for (let i = 0; i < stride; i++) out[i] = row[i] + prev[i];
    } else if (f === 3) {
      for (let i = 0; i < stride; i++) {
        const a = i >= ch ? out[i - ch] : 0;
        out[i] = row[i] + ((a + prev[i]) >> 1);
      }
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= ch ? out[i - ch] : 0;
        const b = prev[i];
        const c = i >= ch ? prev[i - ch] : 0;
        out[i] = row[i] + paeth(a, b, c);
      }
    }
    prev.set(out);
    // Expand to RGBA.
    const d0 = y * width * 4;
    if (colourType === 6) {
      rgba.set(out, d0);
    } else if (colourType === 2) {
      for (let x = 0, s = 0; x < width; x++, s += 3) {
        rgba[d0 + x * 4] = out[s];
        rgba[d0 + x * 4 + 1] = out[s + 1];
        rgba[d0 + x * 4 + 2] = out[s + 2];
        rgba[d0 + x * 4 + 3] = 255;
      }
    } else if (colourType === 0) {
      for (let x = 0; x < width; x++) {
        const g = out[x];
        rgba[d0 + x * 4] = g;
        rgba[d0 + x * 4 + 1] = g;
        rgba[d0 + x * 4 + 2] = g;
        rgba[d0 + x * 4 + 3] = 255;
      }
    } else if (colourType === 4) {
      for (let x = 0, s = 0; x < width; x++, s += 2) {
        const g = out[s];
        rgba[d0 + x * 4] = g;
        rgba[d0 + x * 4 + 1] = g;
        rgba[d0 + x * 4 + 2] = g;
        rgba[d0 + x * 4 + 3] = out[s + 1];
      }
    } else if (colourType === 3 && plte !== null) {
      for (let x = 0; x < width; x++) {
        const idx = out[x];
        rgba[d0 + x * 4] = plte[idx * 3];
        rgba[d0 + x * 4 + 1] = plte[idx * 3 + 1];
        rgba[d0 + x * 4 + 2] = plte[idx * 3 + 2];
        rgba[d0 + x * 4 + 3] = trns !== null && idx < trns.length ? trns[idx] : 255;
      }
    }
  }
  return { rgba, width, height };
}

// ---------------------------------------------------------------- analysis

interface Colour {
  r: number;
  g: number;
  b: number;
  a: number;
  count: number;
}

function analyse(rgba: Uint8Array): { opaque: boolean; grey: boolean; colours: Colour[] | null } {
  const n = rgba.length >>> 2;
  let opaque = true;
  let grey = true;
  const map = new Map<number, number>();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const key = rgba[d] * 16777216 + rgba[d + 1] * 65536 + rgba[d + 2] * 256 + rgba[d + 3];
      const k = map.get(key);
      if (k === undefined) {
        if (map.size === 256) many = true;
        else map.set(key, 1);
      } else {
        map.set(key, k + 1);
      }
    }
  }
  if (many) return { opaque, grey, colours: null };
  const colours: Colour[] = [];
  for (const [key, count] of map) {
    colours.push({
      r: (key / 16777216) | 0,
      g: ((key / 65536) | 0) & 255,
      b: ((key / 256) | 0) & 255,
      a: key & 255,
      count,
    });
  }
  return { opaque, grey, colours };
}

/**
 * The one fully transparent value (grey sample or RGB triple) the image may
 * key by tRNS instead of an alpha channel: every pixel opaque or that exact
 * value at alpha 0, and no opaque pixel of the same value. Null otherwise.
 */
function transparentKey(rgba: Uint8Array, grey: boolean): number | null {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba: Uint8Array, ct: number): Uint8Array {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

// ---------------------------------------------------------------- palette

function lum(c: Colour): number {
  return 299 * c.r + 587 * c.g + 114 * c.b;
}

/** Palette entries in trial order: transparent ones first (by alpha), then by `order`. */
function paletteOrder(colours: Colour[], order: string): Colour[] {
  const list = [...colours];
  if (order === 'greedy') {
    // Transparent entries first (by alpha, then count), then a greedy
    // nearest-neighbour walk through the opaque colours so neighbouring
    // palette indices hold similar colours and the Sub filter stays small.
    const trans = list.filter((c) => c.a !== 255).sort((x, y) => x.a - y.a || y.count - x.count);
    const opaq = list.filter((c) => c.a === 255).sort((x, y) => y.count - x.count);
    const out: Colour[] = [...trans];
    const rest = [...opaq];
    if (out.length === 0 && rest.length > 0) out.push(rest.shift() as Colour);
    while (rest.length > 0) {
      const last = out[out.length - 1];
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < rest.length; i++) {
        const c = rest[i];
        const dr = c.r - last.r;
        const dg = c.g - last.g;
        const db = c.b - last.b;
        const dd = dr * dr + dg * dg + db * db;
        if (dd < bestD) {
          bestD = dd;
          best = i;
        }
      }
      out.push(rest.splice(best, 1)[0]);
    }
    return out;
  }
  return list.sort((x, y) => {
    const ta = x.a === 255 ? 1 : 0;
    const tb = y.a === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.a !== y.a) return x.a - y.a;
    if (order === 'luminance') return lum(x) - lum(y) || x.count - y.count;
    return y.count - x.count;
  });
}

interface PaletteForm {
  plte: Uint8Array;
  trns: Uint8Array | null;
  indices: Uint8Array;
}

function paletteForm(rgba: Uint8Array, colours: Colour[], order: string): PaletteForm {
  const entries = paletteOrder(colours, order);
  const index = new Map<number, number>();
  entries.forEach((c, i) => index.set(c.r * 16777216 + c.g * 65536 + c.b * 256 + c.a, i));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r;
    plte[i * 3 + 1] = c.g;
    plte[i * 3 + 2] = c.b;
    if (c.a !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.a);
  const n = rgba.length >>> 2;
  const indices = new Uint8Array(n);
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    indices[i] = index.get(rgba[d] * 16777216 + rgba[d + 1] * 65536 + rgba[d + 2] * 256 + rgba[d + 3]) as number;
  }
  return { plte, trns, indices };
}

// ---------------------------------------------------------------- filtering

/**
 * Filter all rows of `samples` (width x bpp per row), choosing each row's
 * filter by `choice`: a fixed filter (0..4), 'minsum' (PNG spec heuristic),
 * 'pairs' (fewest distinct neighbouring byte pairs), or 'brute' (each row's
 * five filters weighed by a real zlib run after the previous 32 KiB, as the
 * kit's scale compressor does). Returns the filtered data (filter byte +
 * row, per row).
 */
function filtered(samples: Uint8Array, width: number, height: number, bpp: number, choice: number | string): Uint8Array {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trials: Uint8Array[] = [];
  for (let t = 0; t < 5; t++) trials.push(new Uint8Array(stride));
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - 32768), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trials[t]);
      let cost: number;
      if (choice === 'minsum') {
        cost = signedSum(trials[t]);
      } else if (choice === 'pairs') {
        cost = 0;
        stamp++;
        const row = trials[t];
        for (let i = 1; i < row.length; i++) {
          const pair = (row[i - 1] << 8) | row[i];
          if (seen[pair] !== stamp) {
            seen[pair] = stamp;
            cost++;
          }
        }
      } else {
        // 'brute': real zlib cost of this row after the bytes before it.
        const trial = new Uint8Array(stride + 1);
        trial[0] = t;
        trial.set(trials[t], 1);
        cost = deflateSync(trial, before.length === 0 ? { level: 4, memLevel: 9 } : { level: 4, memLevel: 9, dictionary: before }).length;
      }
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw[at] = type;
    raw.set(trials[type], at + 1);
  }
  return raw;
}

// ---------------------------------------------------------------- DEFLATE (custom optimal-ish encoder)
//
// From-scratch DEFLATE: hash-chain LZ77 with lazy matching (no early exit:
// the chain is walked to its limit so the nearest long match wins) plus
// dynamic Huffman tables built from the parse's own frequencies, one block
// per megabyte so long-range matches survive. Deterministic throughout.

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

function lenSymbol(len: number): number {
  let lo = 0;
  let hi = 28;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (LEN_BASE[mid] <= len) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function distSymbol(dist: number): number {
  let lo = 0;
  let hi = 29;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (DIST_BASE[mid] <= dist) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Length-limited Huffman code lengths (zlib gen_bitlen style). */
function buildLengths(freq: Float64Array, maxBits: number): Uint8Array {
  const n = freq.length;
  const len = new Uint8Array(n);
  const syms: number[] = [];
  for (let i = 0; i < n; i++) if (freq[i] > 0) syms.push(i);
  if (syms.length === 0) return len;
  if (syms.length === 1) {
    len[syms[0]] = 1;
    return len;
  }
  interface HNode {
    f: number;
    sym: number;
    left: HNode | null;
    right: HNode | null;
  }
  let nodes: HNode[] = syms.map((s) => ({ f: freq[s], sym: s, left: null, right: null }));
  while (nodes.length > 1) {
    let m1 = 0;
    let m2 = 1;
    if (nodes[m2].f < nodes[m1].f) {
      const t = m1;
      m1 = m2;
      m2 = t;
    }
    for (let i = 2; i < nodes.length; i++) {
      if (nodes[i].f < nodes[m1].f) {
        m2 = m1;
        m1 = i;
      } else if (nodes[i].f < nodes[m2].f) m2 = i;
    }
    const a = nodes[m1];
    const b = nodes[m2];
    const parent: HNode = { f: a.f + b.f, sym: -1, left: a, right: b };
    nodes = nodes.filter((_, i) => i !== m1 && i !== m2);
    nodes.push(parent);
  }
  const depths = new Uint8Array(n);
  const walk = (node: HNode, d: number): void => {
    if (node.sym >= 0) {
      depths[node.sym] = d;
      return;
    }
    walk(node.left as HNode, d + 1);
    walk(node.right as HNode, d + 1);
  };
  walk(nodes[0], 0);
  const blCount = new Int32Array(maxBits + 1);
  let overflow = 0;
  for (const s of syms) {
    let l = depths[s];
    if (l > maxBits) {
      overflow++;
      l = maxBits;
    }
    if (l === 0) l = 1;
    depths[s] = l;
    blCount[l]++;
  }
  while (overflow > 0) {
    let bits = maxBits - 1;
    while (blCount[bits] === 0) bits--;
    blCount[bits]--;
    blCount[bits + 1] += 2;
    blCount[maxBits]--;
    overflow -= 2;
  }
  const sorted = [...syms].sort((a, b) => freq[b] - freq[a] || a - b);
  let k = 0;
  for (let l = 1; l <= maxBits; l++) {
    for (let c = 0; c < blCount[l]; c++) len[sorted[k++]] = l;
  }
  return len;
}

function canonicalCodes(lengths: Uint8Array): Uint32Array {
  const n = lengths.length;
  const codes = new Uint32Array(n);
  const blCount = new Int32Array(16);
  for (let i = 0; i < n; i++) blCount[lengths[i]]++;
  blCount[0] = 0;
  const next = new Int32Array(16);
  let code = 0;
  for (let bits = 1; bits < 16; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    next[bits] = code;
  }
  for (let i = 0; i < n; i++) {
    const l = lengths[i];
    if (l !== 0) codes[i] = next[l]++;
  }
  return codes;
}

function reverseBits(code: number, len: number): number {
  let r = 0;
  for (let i = 0; i < len; i++) {
    r = (r << 1) | (code & 1);
    code >>>= 1;
  }
  return r;
}

class BitWriter {
  buf: Uint8Array;
  pos = 0;
  bitbuf = 0;
  bitcnt = 0;
  constructor(cap: number) {
    this.buf = new Uint8Array(cap);
  }
  put(value: number, len: number): void {
    this.bitbuf |= (value & ((1 << len) - 1)) << this.bitcnt;
    this.bitcnt += len;
    while (this.bitcnt >= 8) {
      this.buf[this.pos++] = this.bitbuf & 0xff;
      this.bitbuf >>>= 8;
      this.bitcnt -= 8;
    }
  }
  putCode(code: number, len: number): void {
    this.put(reverseBits(code, len), len);
  }
  align(): void {
    if (this.bitcnt > 0) {
      this.buf[this.pos++] = this.bitbuf & 0xff;
      this.bitbuf = 0;
      this.bitcnt = 0;
    }
  }
  bytes(): Uint8Array {
    return this.buf.subarray(0, this.pos);
  }
}

const HASH_SIZE = 1 << 15;
const HASH_MASK = HASH_SIZE - 1;

class Matcher {
  d: Uint8Array;
  n: number;
  head: Int32Array;
  prev: Int32Array;
  inserted = -1;
  constructor(data: Uint8Array) {
    this.d = data;
    this.n = data.length;
    this.head = new Int32Array(HASH_SIZE).fill(-1);
    this.prev = new Int32Array(data.length);
  }
  hashAt(i: number): number {
    const d = this.d;
    return (((d[i] << 10) ^ (d[i + 1] << 5) ^ d[i + 2]) & HASH_MASK) >>> 0;
  }
  insert(i: number): void {
    const h = this.hashAt(i);
    this.prev[i] = this.head[h];
    this.head[h] = i;
  }
  ensure(pos: number): void {
    for (let i = this.inserted + 1; i < pos; i++) {
      if (i + 2 < this.n) this.insert(i);
    }
    this.inserted = Math.max(this.inserted, pos - 1);
  }
  /** Longest match at pos; returns [len, dist]. Walks the whole chain. */
  find(pos: number, maxChain: number): [number, number] {
    const d = this.d;
    const n = this.n;
    if (pos + 3 > n) return [0, 0];
    this.ensure(pos);
    let j = this.head[this.hashAt(pos)];
    let bestLen = 0;
    let bestDist = 0;
    let chain = 0;
    const maxLen = Math.min(258, n - pos);
    const limit = Math.max(0, pos - 32768);
    while (j >= limit && j >= 0 && chain++ < maxChain) {
      if (d[j + bestLen] === d[pos + bestLen]) {
        let len = 0;
        while (len < maxLen && d[j + len] === d[pos + len]) len++;
        if (len > bestLen) {
          bestLen = len;
          bestDist = pos - j;
          if (len >= maxLen) break;
        }
      }
      j = this.prev[j];
    }
    return [bestLen, bestDist];
  }
}

interface Parse {
  lits: number[];
  lens: number[];
  dists: number[];
}

/** Greedy lazy LZ77 parse: emits literal bytes / length symbols + lengths + distances. */
function lazyParse(data: Uint8Array, matcher: Matcher, maxChain: number): Parse {
  const n = data.length;
  const lits: number[] = [];
  const lens: number[] = [];
  const dists: number[] = [];
  let pos = 0;
  while (pos < n) {
    const [len, dist] = matcher.find(pos, maxChain);
    if (len >= 3 && pos + 1 < n) {
      const [len2] = matcher.find(pos + 1, maxChain);
      if (len2 > len) {
        lits.push(data[pos]);
        lens.push(0);
        dists.push(0);
        pos++;
        continue;
      }
    }
    if (len >= 3) {
      lits.push(257 + lenSymbol(len));
      lens.push(len);
      dists.push(dist);
      for (let k = pos; k < pos + len; k++) matcher.ensure(k + 1);
      pos += len;
    } else {
      lits.push(data[pos]);
      lens.push(0);
      dists.push(0);
      pos++;
    }
  }
  lits.push(256);
  lens.push(0);
  dists.push(0);
  return { lits, lens, dists };
}

const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** Emit one dynamic-Huffman DEFLATE block. */
function emitBlock(w: BitWriter, isFinal: number, lits: number[], lens: number[], dists: number[], litLen: Uint8Array, distLen: Uint8Array): void {
  let maxLit = 256;
  for (let i = 285; i > 256; i--) {
    if (litLen[i] !== 0) {
      maxLit = i;
      break;
    }
  }
  let maxDist = 0;
  for (let i = 29; i >= 0; i--) {
    if (distLen[i] !== 0) {
      maxDist = i;
      break;
    }
  }
  const hlitN = maxLit + 1;
  const hdistN = maxDist + 1;
  const combined = new Uint8Array(hlitN + hdistN);
  for (let i = 0; i < hlitN; i++) combined[i] = litLen[i];
  for (let i = 0; i < hdistN; i++) combined[hlitN + i] = distLen[i];
  let total = combined.length;
  while (total > 257 && combined[total - 1] === 0) total--;
  const trimmed = combined.subarray(0, total);
  const clItems: [number, number, number][] = [];
  let i = 0;
  while (i < trimmed.length) {
    const v = trimmed[i];
    let run = 1;
    while (i + run < trimmed.length && trimmed[i + run] === v) run++;
    if (v === 0) {
      let r = run;
      while (r >= 11) {
        const take = Math.min(r, 138);
        clItems.push([18, take - 11, 7]);
        r -= take;
      }
      if (r >= 3) {
        clItems.push([17, r - 3, 3]);
        r = 0;
      }
      while (r > 0) {
        clItems.push([0, 0, 0]);
        r--;
      }
    } else {
      clItems.push([v, 0, 0]);
      let r = run - 1;
      while (r >= 3) {
        const take = Math.min(r, 6);
        clItems.push([16, take - 3, 2]);
        r -= take;
      }
      while (r > 0) {
        clItems.push([v, 0, 0]);
        r--;
      }
    }
    i += run;
  }
  const clFreq = new Float64Array(19);
  for (const [s] of clItems) clFreq[s]++;
  const clLen = buildLengths(clFreq, 7);
  const clCode = canonicalCodes(clLen);
  let hclen = 19;
  while (hclen > 4 && clLen[CL_ORDER[hclen - 1]] === 0) hclen--;
  w.put(isFinal ? 1 : 0, 1);
  w.put(2, 2);
  w.put(hlitN - 257, 5);
  w.put(hdistN - 1, 5);
  w.put(hclen - 4, 4);
  for (let k = 0; k < hclen; k++) w.put(clLen[CL_ORDER[k]], 3);
  const litCode = canonicalCodes(litLen);
  const distCode = canonicalCodes(distLen);
  for (const [s, extra, ebits] of clItems) {
    w.putCode(clCode[s], clLen[s]);
    if (ebits > 0) w.put(extra, ebits);
  }
  for (let k = 0; k < lits.length; k++) {
    const s = lits[k];
    w.putCode(litCode[s], litLen[s]);
    if (s >= 257 && s <= 285) {
      const li = s - 257;
      const len = lens[k];
      const extra = LEN_EXTRA[li];
      if (extra > 0) w.put(len - LEN_BASE[li], extra);
      const ds = distSymbol(dists[k]);
      w.putCode(distCode[ds], distLen[ds]);
      const dextra = DIST_EXTRA[ds];
      if (dextra > 0) w.put(dists[k] - DIST_BASE[ds], dextra);
    }
  }
}

function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; ) {
    const end = Math.min(data.length, i + 5552);
    for (; i < end; i++) {
      a += data[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Custom DEFLATE: zlib wrapper (header 0x78 0x9c, adler32) around dynamic blocks. */
function deflateCustom(data: Uint8Array): Uint8Array {
  const n = data.length;
  const blockSize = 1 << 20;
  const w = new BitWriter(n + 1024 + Math.ceil(n / blockSize) * 512);
  let pos = 0;
  let first = true;
  while (pos < n || first) {
    first = false;
    const end = Math.min(n, pos + blockSize);
    const chunk = data.subarray(pos, end);
    const isFinal = end >= n;
    const matcher = new Matcher(chunk);
    const { lits, lens, dists } = lazyParse(chunk, matcher, 4096);
    const litFreq = new Float64Array(286);
    const distFreq = new Float64Array(30);
    for (let k = 0; k < lits.length; k++) {
      litFreq[lits[k]]++;
      if (lits[k] >= 257 && lits[k] <= 285) distFreq[distSymbol(dists[k])]++;
    }
    if (distFreq.every((v) => v === 0)) distFreq[0] = 1;
    const litLen = buildLengths(litFreq, 15);
    const distLen = buildLengths(distFreq, 15);
    emitBlock(w, isFinal ? 1 : 0, lits, lens, dists, litLen, distLen);
    pos = end;
    if (n === 0) break;
  }
  w.align();
  const body = w.bytes();
  const out = new Uint8Array(body.length + 6);
  out[0] = 0x78;
  out[1] = 0x9c;
  out.set(body, 2);
  const ad = adler32(data);
  out[out.length - 4] = (ad >>> 24) & 0xff;
  out[out.length - 3] = (ad >>> 16) & 0xff;
  out[out.length - 2] = (ad >>> 8) & 0xff;
  out[out.length - 1] = ad & 0xff;
  return out;
}

// ---------------------------------------------------------------- forms + encode

interface Form {
  colourType: number;
  bpp: number;
  samples: Uint8Array;
  plte: Uint8Array | null;
  trns: Uint8Array | null;
}

function formsOf(rgba: Uint8Array): Form[] {
  const { opaque, grey, colours } = analyse(rgba);
  const forms: Form[] = [];
  if (colours !== null) {
    for (const order of ['count', 'luminance', 'greedy']) {
      const p = paletteForm(rgba, colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct: number;
  let trns: Uint8Array | null = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct] as number;
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns });
  return forms;
}

function pngOfForm(width: number, height: number, form: Form, idat: Uint8Array): Uint8Array {
  const chunks: [string, Uint8Array][] = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

/** Encode one image; returns the smallest PNG found across forms. */
function encodeImage(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const choices: (number | string)[] = [0, 4, 'pairs'];
  let best: Uint8Array | null = null;
  let bestBytes = Infinity;
  // The single best candidate by zlib level 9, re-weighed with the custom
  // encoder at the end (one custom run per image keeps the wall in budget).
  let bestCand: { form: Form; data: Uint8Array; bytes9: number } | null = null;
  for (const form of formsOf(rgba)) {
    const chunkBytes = (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);
    // Screen every filter choice with zlib level 6 (fast, ranking matches
    // level 9), then re-weigh the best two with level 9.
    const screened: { data: Uint8Array; bytes6: number }[] = [];
    for (const choice of choices) {
      const data = filtered(form.samples, width, height, form.bpp, choice);
      const bytes6 = deflateSync(data, { level: 6, memLevel: 8 }).length + chunkBytes;
      screened.push({ data, bytes6 });
    }
    screened.sort((a, b) => a.bytes6 - b.bytes6);
    for (const cand of screened.slice(0, 2)) {
      const zlib = deflateSync(cand.data, { level: 9, memLevel: 9 });
      const bytes9 = zlib.length + chunkBytes;
      if (bytes9 < bestBytes) {
        bestBytes = bytes9;
        best = pngOfForm(width, height, form, new Uint8Array(zlib.buffer, zlib.byteOffset, zlib.length));
        bestCand = { form, data: cand.data, bytes9 };
      }
    }
  }
  // Brute-force per-row filter choice on the winning form (each row's five
  // filters weighed by a real zlib run after the previous 32 KiB): the
  // kit's scale compressor shows this wins on grey/rich images. Take the
  // smallest of the zlib-9 winner, its custom re-encoding, and the brute
  // variant (each weighed by both encoders).
  if (bestCand !== null) {
    const chunkBytes = (bestCand.form.plte === null ? 0 : 12 + bestCand.form.plte.length) + (bestCand.form.trns === null ? 0 : 12 + bestCand.form.trns.length);
    const bruteData = filtered(bestCand.form.samples, width, height, bestCand.form.bpp, 'brute');
    const bruteZ = deflateSync(bruteData, { level: 9, memLevel: 9 });
    const bruteCustom = deflateCustom(bruteData);
    const bruteBest = bruteCustom.length < bruteZ.length ? bruteCustom : new Uint8Array(bruteZ.buffer, bruteZ.byteOffset, bruteZ.length);
    if (bruteBest.length + chunkBytes < bestBytes) {
      bestBytes = bruteBest.length + chunkBytes;
      best = pngOfForm(width, height, bestCand.form, bruteBest);
    }
    const custom = deflateCustom(bestCand.data);
    if (custom.length + chunkBytes < bestBytes) {
      bestBytes = custom.length + chunkBytes;
      best = pngOfForm(width, height, bestCand.form, custom);
    }
  }
  return best as Uint8Array;
}

// ---------------------------------------------------------------- main

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

for (const id of readdirSync(I).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  const png = encodeImage(image.rgba, image.width, image.height);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), png);
  console.error(`${id}: ${png.length} bytes`);
}

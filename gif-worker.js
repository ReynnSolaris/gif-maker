// GIF89a encoder (median-cut palette per frame, optional Floyd–Steinberg dithering, LZW, and
// frame differencing via transparency so static regions cost almost nothing).
// Runs as a Web Worker. Message in: { type:'encode', frames:[ArrayBuffer RGBA...], width, height,
// delays:[centiseconds...], dither, optimize, loop }. Messages out: progress / done / error.

'use strict';

const MAX_COLORS = 256;
const TRANSPARENT = 255;          // palette slot reserved when optimize is on
const DIFF_TOLERANCE = 10;        // |dr|+|dg|+|db| below this counts as "unchanged" (optimize mode)

// Two ways to drive it: one 'encode' message with every frame, or a streamed
// 'start' → 'frame' (×N) → 'finish' sequence so encoding overlaps with capture.
let stream = null;
self.onmessage = (e) => {
  const m = e.data;
  if (!m) return;
  try {
    if (m.type === 'encode') {
      const out = encodeGif(m);
      self.postMessage({ type: 'done', buffer: out.buffer }, [out.buffer]);
    } else if (m.type === 'start') {
      stream = new GifEncoder(m);
    } else if (m.type === 'frame' && stream) {
      stream.addFrame(m.buffer, m.delay);
      self.postMessage({ type: 'progress', frame: stream.count, total: m.total || 0 });
    } else if (m.type === 'finish' && stream) {
      const out = stream.finish();
      stream = null;
      self.postMessage({ type: 'done', buffer: out.buffer }, [out.buffer]);
    }
  } catch (err) {
    stream = null;
    self.postMessage({ type: 'error', message: (err && err.message) || String(err) });
  }
};

// ----------------------------------------------------------------- byte writer
class ByteWriter {
  constructor(size = 1 << 16) { this.buf = new Uint8Array(size); this.len = 0; }
  ensure(n) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const nb = new Uint8Array(cap); nb.set(this.buf.subarray(0, this.len)); this.buf = nb;
  }
  u8(v) { this.ensure(1); this.buf[this.len++] = v & 0xff; }
  u16(v) { this.ensure(2); this.buf[this.len++] = v & 0xff; this.buf[this.len++] = (v >> 8) & 0xff; }
  bytes(arr) { this.ensure(arr.length); this.buf.set(arr, this.len); this.len += arr.length; }
  string(s) { for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i)); }
  result() { return this.buf.slice(0, this.len); }
}

// ----------------------------------------------------------------- palette (median cut on 5-bit histogram)
function buildPalette(rgba, maxColors) {
  const count = new Uint32Array(32768);
  const sumR = new Uint32Array(32768), sumG = new Uint32Array(32768), sumB = new Uint32Array(32768);
  // Large frames: sample every other pixel for the histogram (palette quality is unaffected in practice).
  const step = rgba.length > 600000 ? 8 : 4;
  for (let i = 0; i < rgba.length; i += step) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    count[k]++; sumR[k] += r; sumG[k] += g; sumB[k] += b;
  }
  let n = 0;
  for (let k = 0; k < 32768; k++) if (count[k]) n++;
  const bins = new Int32Array(n);
  for (let k = 0, j = 0; k < 32768; k++) if (count[k]) bins[j++] = k;

  // box = { s, e, total, rr, rg, rb (ranges), channel }
  const boxes = [];
  const makeBox = (s, e) => {
    let rmin = 31, rmax = 0, gmin = 31, gmax = 0, bmin = 31, bmax = 0, total = 0;
    for (let i = s; i < e; i++) {
      const k = bins[i], r = k >> 10, g = (k >> 5) & 31, b = k & 31;
      if (r < rmin) rmin = r; if (r > rmax) rmax = r;
      if (g < gmin) gmin = g; if (g > gmax) gmax = g;
      if (b < bmin) bmin = b; if (b > bmax) bmax = b;
      total += count[k];
    }
    const rr = rmax - rmin, rg = gmax - gmin, rb = bmax - bmin;
    let channel = 0, range = rr;
    if (rg >= range) { channel = 1; range = rg; }
    if (rb > range) { channel = 2; range = rb; }
    return { s, e, total, range, channel };
  };
  boxes.push(makeBox(0, n));

  while (boxes.length < maxColors) {
    // Pick the box with the best (population × range) score that can still be split.
    let bi = -1, best = -1;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.e - b.s < 2 || b.range === 0) continue;
      const score = b.total * (b.range + 1);
      if (score > best) { best = score; bi = i; }
    }
    if (bi < 0) break;
    const box = boxes[bi];
    const shift = box.channel === 0 ? 10 : box.channel === 1 ? 5 : 0;
    const sub = bins.subarray(box.s, box.e);
    sub.sort((a, b) => ((a >> shift) & 31) - ((b >> shift) & 31));
    // split at the weighted median
    const half = box.total / 2;
    let acc = 0, mid = box.s;
    for (let i = box.s; i < box.e - 1; i++) {
      acc += count[bins[i]];
      if (acc >= half) { mid = i + 1; break; }
    }
    if (mid <= box.s) mid = box.s + 1;
    if (mid >= box.e) mid = box.e - 1;
    boxes[bi] = makeBox(box.s, mid);
    boxes.push(makeBox(mid, box.e));
  }

  const palette = new Uint8Array(MAX_COLORS * 3);
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    let r = 0, g = 0, bl = 0, t = 0;
    for (let j = b.s; j < b.e; j++) { const k = bins[j]; r += sumR[k]; g += sumG[k]; bl += sumB[k]; t += count[k]; }
    palette[i * 3] = Math.round(r / t);
    palette[i * 3 + 1] = Math.round(g / t);
    palette[i * 3 + 2] = Math.round(bl / t);
  }
  return { palette, size: boxes.length };
}

// ----------------------------------------------------------------- nearest colour with cache
function makeLookup(palette, size) {
  const cache = new Int16Array(1 << 18).fill(-1); // 6 bits per channel
  return (r, g, b) => {
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    const c = cache[key];
    if (c >= 0) return c;
    let best = 0, bd = Infinity;
    for (let i = 0; i < size; i++) {
      const dr = r - palette[i * 3], dg = g - palette[i * 3 + 1], db = b - palette[i * 3 + 2];
      const d = dr * dr * 2 + dg * dg * 3 + db * db;
      if (d < bd) { bd = d; best = i; if (d === 0) break; }
    }
    cache[key] = best;
    return best;
  };
}

// ----------------------------------------------------------------- map frame to indices
// prevRGB: Uint8Array(w*h*3) of what the GIF canvas currently shows (updated in place), or null.
function mapFrame(rgba, w, h, palette, size, dither, prevRGB) {
  const idx = new Uint8Array(w * h);
  const nearest = makeLookup(palette, size);
  let used = false;

  if (!dither) {
    for (let p = 0, i = 0; p < w * h; p++, i += 4) {
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      if (prevRGB) {
        const q = p * 3;
        const d = Math.abs(r - prevRGB[q]) + Math.abs(g - prevRGB[q + 1]) + Math.abs(b - prevRGB[q + 2]);
        if (d <= DIFF_TOLERANCE) { idx[p] = TRANSPARENT; used = true; continue; }
      }
      const c = nearest(r, g, b);
      idx[p] = c;
      if (prevRGB) { const q = p * 3; prevRGB[q] = palette[c * 3]; prevRGB[q + 1] = palette[c * 3 + 1]; prevRGB[q + 2] = palette[c * 3 + 2]; }
    }
    return { idx, used };
  }

  // Floyd–Steinberg (serpentine)
  const errCur = new Float32Array((w + 2) * 3);
  const errNext = new Float32Array((w + 2) * 3);
  for (let y = 0; y < h; y++) {
    errNext.fill(0);
    const ltr = (y & 1) === 0;
    for (let xi = 0; xi < w; xi++) {
      const x = ltr ? xi : w - 1 - xi;
      const p = y * w + x, i = p * 4, e = (x + 1) * 3;
      let r = rgba[i] + errCur[e], g = rgba[i + 1] + errCur[e + 1], b = rgba[i + 2] + errCur[e + 2];
      r = r < 0 ? 0 : r > 255 ? 255 : r;
      g = g < 0 ? 0 : g > 255 ? 255 : g;
      b = b < 0 ? 0 : b > 255 ? 255 : b;
      let cr, cg, cb;
      if (prevRGB) {
        const q = p * 3;
        const d = Math.abs(r - prevRGB[q]) + Math.abs(g - prevRGB[q + 1]) + Math.abs(b - prevRGB[q + 2]);
        if (d <= DIFF_TOLERANCE) {
          idx[p] = TRANSPARENT; used = true;
          continue; // treat as exact; no error to diffuse
        }
      }
      const ri = Math.round(r), gi = Math.round(g), bi = Math.round(b);
      const c = nearest(ri, gi, bi);
      idx[p] = c;
      cr = palette[c * 3]; cg = palette[c * 3 + 1]; cb = palette[c * 3 + 2];
      if (prevRGB) { const q = p * 3; prevRGB[q] = cr; prevRGB[q + 1] = cg; prevRGB[q + 2] = cb; }
      const er = r - cr, eg = g - cg, eb = b - cb;
      const dir = ltr ? 3 : -3;
      // right (7/16), down-left (3/16), down (5/16), down-right (1/16)
      errCur[e + dir] += er * 0.4375; errCur[e + dir + 1] += eg * 0.4375; errCur[e + dir + 2] += eb * 0.4375;
      errNext[e - dir] += er * 0.1875; errNext[e - dir + 1] += eg * 0.1875; errNext[e - dir + 2] += eb * 0.1875;
      errNext[e] += er * 0.3125; errNext[e + 1] += eg * 0.3125; errNext[e + 2] += eb * 0.3125;
      errNext[e + dir] += er * 0.0625; errNext[e + dir + 1] += eg * 0.0625; errNext[e + dir + 2] += eb * 0.0625;
    }
    errCur.set(errNext);
  }
  return { idx, used };
}

// ----------------------------------------------------------------- LZW
const lzwDict = new Int16Array(4096 * 256);

function lzwEncode(indexes, minCodeSize, out) {
  const CLEAR = 1 << minCodeSize, EOI = CLEAR + 1;
  let codeSize = minCodeSize + 1, nextCode = EOI + 1;
  const dict = lzwDict; dict.fill(-1);

  const bytes = new ByteWriter(Math.max(1024, indexes.length >> 1));
  let acc = 0, nbits = 0;
  const emit = (code) => {
    acc |= code << nbits;
    nbits += codeSize;
    while (nbits >= 8) { bytes.u8(acc & 0xff); acc >>>= 8; nbits -= 8; }
  };

  emit(CLEAR);
  let prefix = indexes[0];
  for (let i = 1; i < indexes.length; i++) {
    const c = indexes[i];
    const key = (prefix << 8) | c;
    const found = dict[key];
    if (found >= 0) { prefix = found; continue; }
    emit(prefix);
    if (nextCode < 4096) {
      dict[key] = nextCode++;
      if (nextCode > (1 << codeSize) && codeSize < 12) codeSize++;
    } else {
      emit(CLEAR);
      dict.fill(-1);
      nextCode = EOI + 1;
      codeSize = minCodeSize + 1;
    }
    prefix = c;
  }
  emit(prefix);
  emit(EOI);
  if (nbits > 0) bytes.u8(acc & 0xff);

  // sub-blocks
  const data = bytes.buf, len = bytes.len;
  out.u8(minCodeSize);
  for (let p = 0; p < len; p += 255) {
    const n = Math.min(255, len - p);
    out.u8(n);
    out.bytes(data.subarray(p, p + n));
  }
  out.u8(0);
}

// ----------------------------------------------------------------- assemble
class GifEncoder {
  constructor({ width, height, dither, optimize, loop }) {
    this.w = width | 0; this.h = height | 0;
    this.dither = !!dither;
    this.maxColors = optimize ? MAX_COLORS - 1 : MAX_COLORS;
    this.prevRGB = optimize ? new Uint8Array(this.w * this.h * 3) : null;
    this.count = 0;
    const out = this.out = new ByteWriter(1 << 20);
    out.string('GIF89a');
    out.u16(this.w); out.u16(this.h);
    out.u8(0xF7);        // global colour table present, 8 bits/channel, 256 entries
    out.u8(0);           // background index
    out.u8(0);           // pixel aspect ratio
    this.gctPos = out.len;
    out.bytes(new Uint8Array(MAX_COLORS * 3)); // placeholder, filled with the first frame's palette
    // NETSCAPE looping extension
    out.u8(0x21); out.u8(0xFF); out.u8(0x0B);
    out.string('NETSCAPE2.0');
    out.u8(0x03); out.u8(0x01); out.u16(loop == null ? 0 : loop); out.u8(0x00);
  }

  addFrame(buffer, delayCs) {
    const { w, h, out, prevRGB } = this;
    const rgba = new Uint8ClampedArray(buffer);
    if (rgba.length !== w * h * 4) throw new Error(`Frame ${this.count} has the wrong size.`);
    const f = this.count++;
    const { palette, size } = buildPalette(rgba, this.maxColors);
    const usePrev = prevRGB && f > 0 ? prevRGB : null;
    const { idx, used } = mapFrame(rgba, w, h, palette, size, this.dither, usePrev);
    if (prevRGB && f === 0) {
      for (let p = 0; p < w * h; p++) {
        const c = idx[p]; prevRGB[p * 3] = palette[c * 3]; prevRGB[p * 3 + 1] = palette[c * 3 + 1]; prevRGB[p * 3 + 2] = palette[c * 3 + 2];
      }
    }
    if (f === 0) out.buf.set(palette, this.gctPos);

    // Graphic Control Extension
    const delay = Math.max(2, delayCs | 0);
    out.u8(0x21); out.u8(0xF9); out.u8(0x04);
    out.u8((1 << 2) | (used ? 1 : 0)); // disposal 1 (keep), transparency flag
    out.u16(delay);
    out.u8(used ? TRANSPARENT : 0);
    out.u8(0x00);

    // Image descriptor + local colour table
    out.u8(0x2C);
    out.u16(0); out.u16(0); out.u16(w); out.u16(h);
    out.u8(0x87); // local colour table, 256 entries
    out.bytes(palette);

    lzwEncode(idx, 8, out);
  }

  finish() {
    if (!this.count) throw new Error('No frames to encode.');
    this.out.u8(0x3B);
    return this.out.result();
  }
}

function encodeGif({ frames, width, height, delays, dither, optimize, loop }) {
  if (!frames || !frames.length) throw new Error('No frames to encode.');
  const enc = new GifEncoder({ width, height, dither, optimize, loop });
  for (let f = 0; f < frames.length; f++) {
    enc.addFrame(frames[f], delays[f]);
    self.postMessage({ type: 'progress', frame: f + 1, total: frames.length });
  }
  return enc.finish();
}

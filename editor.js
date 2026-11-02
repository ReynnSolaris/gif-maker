// Editor panel. Lives in an extension iframe; talks to the content script over a MessagePort.
'use strict';

const $ = (id) => document.getElementById(id);
const ui = {
  app: $('app'), dragbar: $('dragbar'), videoInfo: $('videoInfo'), closeBtn: $('closeBtn'),
  preview: $('preview'), canvas: $('frameCanvas'), resultImg: $('resultImg'), badge: $('previewBadge'), previewMsg: $('previewMsg'),
  track: $('track'), thumbs: $('thumbs'), dimL: $('dimL'), dimR: $('dimR'), range: $('range'), grip: $('grip'), hStart: $('hStart'), hEnd: $('hEnd'), playhead: $('playhead'),
  startIn: $('startIn'), endIn: $('endIn'), rangeInfo: $('rangeInfo'), loopPage: $('loopPage'),
  fps: $('fps'), sizeSel: $('sizeSel'), widthIn: $('widthIn'), dims: $('dims'), dither: $('dither'), optimize: $('optimize'),
  makeBtn: $('makeBtn'), playBtn: $('playBtn'), saveBtn: $('saveBtn'), cancelBtn: $('cancelBtn'), status: $('status'), progress: $('progress'), progressFill: $('progressFill')
};

const MAX_FRAMES = 600;
const MAX_PIXELS = 160e6;   // total RGBA pixels held in memory for one GIF
const THUMB_COUNT = 12;
const PRESETS = [160, 240, 320, 480, 640];

const state = {
  duration: 0, start: 0, end: 0, playhead: 0,
  fps: 15, width: 480, dither: true, optimize: true,
  videoW: 0, videoH: 0, title: '', src: '', tainted: false, settings: {},
  busy: false
};

let port = null;
let reqCounter = 0;
const pending = new Map();        // reqId -> { onFrame, resolve, reject }
let frameCache = null;            // { key, frames: [ArrayBuffer], width, height }
let result = null;                // { blob, url, bytes }
let worker = null;
let currentJob = null;            // { reqId } for cancel
let scrubTarget = null, scrubBusy = false;
let localVideo = null;            // fallback capture element when the page canvas is tainted

// ----------------------------------------------------------------- connection
window.addEventListener('message', (e) => {
  const m = e.data;
  if (!m || m.type !== 'gifmaker-connect' || !e.ports || !e.ports[0]) return;
  port = e.ports[0];
  port.onmessage = onPortMessage;
  port.postMessage({ type: 'ready' });
  reportSize();
});

function reportSize() { send({ type: 'resize', height: ui.app.offsetHeight + 2 }); }

function send(msg) { if (port) port.postMessage(msg); }

function onPortMessage(e) {
  const m = e.data || {};
  switch (m.type) {
    case 'init': onInit(m); break;
    case 'frame': {
      const p = pending.get(m.reqId);
      if (p) p.onFrame(m);
      break;
    }
    case 'capture-done': {
      const p = pending.get(m.reqId);
      if (p) { pending.delete(m.reqId); p.resolve(); }
      break;
    }
    case 'capture-cancelled': {
      const p = pending.get(m.reqId);
      if (p) { pending.delete(m.reqId); p.reject(Object.assign(new Error('cancelled'), { cancelled: true })); }
      break;
    }
    case 'capture-error': {
      const p = pending.get(m.reqId);
      if (p) { pending.delete(m.reqId); p.reject(new Error(m.message || 'Capture failed')); }
      break;
    }
    case 'time':
      if (ui.loopPage.checked) { state.playhead = m.t; layoutTimeline(); }
      break;
  }
}

// ----------------------------------------------------------------- init
function onInit(m) {
  state.duration = m.duration;
  state.videoW = m.videoWidth; state.videoH = m.videoHeight;
  state.title = m.title || 'video';
  state.src = m.src || '';
  state.tainted = !!m.tainted;
  state.settings = m.settings || {};

  state.fps = clampInt(state.settings.fps, 1, 50, 15);
  state.dither = state.settings.dither !== false;
  state.optimize = state.settings.optimize !== false;
  const defW = state.settings.width;
  state.width = defW === 0 ? state.videoW : clampInt(defW, 16, 4096, 480);
  if (state.width > state.videoW && state.videoW) state.width = state.videoW;

  const len = Math.min(3, state.duration);
  state.start = Math.max(0, Math.min(m.currentTime || 0, state.duration - len));
  state.end = Math.min(state.duration, state.start + len);
  state.playhead = state.start;

  ui.videoInfo.textContent = `${state.videoW}×${state.videoH} · ${fmt(state.duration)}s`;
  ui.fps.value = state.fps;
  ui.dither.checked = state.dither;
  ui.optimize.checked = state.optimize;
  syncSizeSelect();
  syncTimeInputs();
  layoutTimeline();
  updateDims();
  reportSize();

  if (state.tainted && state.src.startsWith('blob:')) {
    showPreviewMsg('This site blocks reading video pixels (cross-origin stream). GIF Maker cannot capture frames here.');
    ui.makeBtn.disabled = true;
    return;
  }
  loadThumbnails();
  scrub(state.playhead);
}

function clampInt(v, lo, hi, dflt) {
  const n = parseInt(v, 10);
  if (!isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}
function fmt(t) { return (Math.round(t * 100) / 100).toFixed(2); }

// ----------------------------------------------------------------- capture plumbing
async function captureFrames(times, width, kind, onFrame) {
  if (state.tainted) return localCapture(times, width, onFrame);
  const reqId = ++reqCounter;
  try {
    await new Promise((resolve, reject) => {
      pending.set(reqId, { onFrame, resolve, reject });
      send({ type: 'capture', reqId, times, width, kind });
      if (kind === 'capture') currentJob = { reqId };
    });
  } catch (err) {
    // The page canvas turned out to be tainted: fetch the file ourselves and retry once.
    if (err && err.message === 'tainted' && state.src && !state.src.startsWith('blob:')) {
      state.tainted = true;
      return localCapture(times, width, onFrame);
    }
    throw err;
  }
}

function cancelCurrent() {
  if (currentJob) { send({ type: 'cancel', reqId: currentJob.reqId }); currentJob.cancelled = true; }
  if (encoderAbort) encoderAbort();
  else if (worker) { worker.terminate(); worker = null; }
}

// Fallback: fetch the video into this (extension) origin and read frames from our own element.
async function ensureLocalVideo() {
  if (localVideo) return localVideo;
  setStatus('Downloading video for capture…');
  const res = await fetch(state.src);
  if (!res.ok) throw new Error(`Could not download the video (${res.status}).`);
  const blob = await res.blob();
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto';
  v.src = URL.createObjectURL(blob);
  v.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:16px;height:16px;opacity:0;pointer-events:none;';
  document.body.appendChild(v);
  await new Promise((resolve, reject) => {
    v.addEventListener('loadedmetadata', resolve, { once: true });
    v.addEventListener('error', () => reject(new Error('The downloaded video could not be decoded.')), { once: true });
  });
  localVideo = v;
  return v;
}

async function localCapture(times, width, onFrame) {
  const v = await ensureLocalVideo();
  const vw = v.videoWidth, vh = v.videoHeight;
  const w = Math.max(16, Math.min(Math.round(width) || vw, vw));
  const h = Math.max(1, Math.round(vh * w / vw));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const job = currentJob = { reqId: -1, cancelled: false };
  for (let i = 0; i < times.length; i++) {
    if (job.cancelled) throw Object.assign(new Error('cancelled'), { cancelled: true });
    await seekTo(v, times[i]);
    ctx.drawImage(v, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h);
    onFrame({ index: i, total: times.length, width: w, height: h, time: times[i], buffer: data.data.buffer });
  }
}

function seekTo(video, t) {
  const target = Math.max(0, Math.min(t, Math.max(0, video.duration - 0.01)));
  return new Promise((resolve) => {
    if (!video.seeking && Math.abs(video.currentTime - target) < 0.0005 && video.readyState >= 2) return resolve(true);
    let settled = false;
    const finish = (ok) => { if (settled) return; settled = true; video.removeEventListener('seeked', onSeeked); clearTimeout(timer); setTimeout(() => resolve(ok), 30); };
    const onSeeked = () => finish(true);
    const timer = setTimeout(() => finish(false), 5000);
    video.addEventListener('seeked', onSeeked);
    video.currentTime = target;
  });
}

// ----------------------------------------------------------------- thumbnails
async function loadThumbnails() {
  ui.thumbs.textContent = '';
  const canvases = [];
  for (let i = 0; i < THUMB_COUNT; i++) {
    const c = document.createElement('canvas');
    c.width = 1; c.height = 1;
    ui.thumbs.appendChild(c);
    canvases.push(c);
  }
  const times = [];
  for (let i = 0; i < THUMB_COUNT; i++) times.push(((i + 0.5) / THUMB_COUNT) * state.duration);
  try {
    await captureFrames(times, 128, 'thumbs', (f) => {
      const c = canvases[f.index];
      c.width = f.width; c.height = f.height;
      c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(f.buffer), f.width, f.height), 0, 0);
    });
  } catch (err) {
    if (!err.cancelled) setStatus(friendlyError(err), true);
  }
}

// ----------------------------------------------------------------- scrubbing (single frame preview)
function scrub(t) {
  scrubTarget = t;
  if (!scrubBusy) runScrub();
}

async function runScrub() {
  scrubBusy = true;
  while (scrubTarget != null && !state.busy) {
    const t = scrubTarget; scrubTarget = null;
    try {
      await captureFrames([t], Math.min(state.width, 640), 'scrub', (f) => drawPreviewFrame(f));
    } catch (err) {
      if (!err.cancelled) { setStatus(friendlyError(err), true); break; }
    }
  }
  scrubBusy = false;
}

function drawPreviewFrame(f) {
  if (!ui.resultImg.hidden) return; // the finished GIF is on screen; keep it until settings change
  drawFrameBuffer(f.buffer, f.width, f.height, f.time);
}

function drawFrameBuffer(buffer, w, h, time) {
  if (ui.canvas.width !== w || ui.canvas.height !== h) { ui.canvas.width = w; ui.canvas.height = h; }
  ui.canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(buffer), w, h), 0, 0);
  ui.badge.textContent = `frame @ ${fmt(time)}s`;
}

function showResultImg(show) {
  ui.resultImg.hidden = !show;
  ui.canvas.hidden = show;
  ui.badge.classList.toggle('gif', show);
  if (show) ui.badge.textContent = 'GIF preview';
}

// ----------------------------------------------------------------- timeline
function layoutTimeline() {
  const d = state.duration || 1;
  const w = ui.track.clientWidth;
  const xs = (state.start / d) * w, xe = (state.end / d) * w, xp = (state.playhead / d) * w;
  ui.dimL.style.left = '0'; ui.dimL.style.width = xs + 'px';
  ui.dimR.style.left = xe + 'px'; ui.dimR.style.width = (w - xe) + 'px';
  ui.range.style.left = xs + 'px'; ui.range.style.width = Math.max(0, xe - xs) + 'px';
  ui.grip.style.left = xs + 'px'; ui.grip.style.width = Math.max(0, xe - xs) + 'px';
  ui.hStart.style.left = Math.max(0, xs - 12) + 'px';
  ui.hEnd.style.left = Math.min(w - 12, xe) + 'px';
  ui.playhead.style.left = Math.max(0, Math.min(w - 2, xp - 1)) + 'px';
  const n = frameCount();
  ui.rangeInfo.textContent = `${fmt(state.end - state.start)}s · ${n} frame${n === 1 ? '' : 's'}`;
}

function frameCount() {
  return Math.max(1, Math.floor((state.end - state.start) * state.fps + 1e-6));
}

function syncTimeInputs() {
  ui.startIn.value = fmt(state.start);
  ui.endIn.value = fmt(state.end);
  ui.startIn.max = ui.endIn.max = fmt(state.duration);
}

function setRange(start, end, { scrubAt } = {}) {
  const minLen = 1 / state.fps;
  start = Math.max(0, Math.min(start, state.duration - minLen));
  end = Math.max(start + minLen, Math.min(end, state.duration));
  state.start = start; state.end = end;
  syncTimeInputs();
  invalidate();
  if (scrubAt != null) { state.playhead = scrubAt; scrub(scrubAt); }
  layoutTimeline();
  if (ui.loopPage.checked) send({ type: 'loop', on: true, start: state.start, end: state.end });
}

(function setupTimelineDrag() {
  let mode = null, grabOffset = 0, rangeLen = 0;
  const timeAt = (clientX) => {
    const r = ui.track.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * state.duration;
  };
  ui.track.addEventListener('pointerdown', (e) => {
    if (state.busy) return;
    e.preventDefault();
    stopPlay();
    const t = e.target;
    if (t === ui.hStart) mode = 'start';
    else if (t === ui.hEnd) mode = 'end';
    else if (t === ui.grip) { mode = 'move'; grabOffset = timeAt(e.clientX) - state.start; rangeLen = state.end - state.start; }
    else { mode = 'play'; }
    ui.track.setPointerCapture(e.pointerId);
    if (ui.loopPage.checked && mode !== 'play') { ui.loopPage.checked = false; send({ type: 'loop', on: false }); }
    onMove(e);
  });
  const onMove = (e) => {
    if (!mode) return;
    const t = timeAt(e.clientX);
    if (mode === 'start') setRange(t, state.end, { scrubAt: Math.min(t, state.end - 1 / state.fps) });
    else if (mode === 'end') setRange(state.start, t, { scrubAt: Math.max(t, state.start + 1 / state.fps) });
    else if (mode === 'move') {
      let s = t - grabOffset;
      s = Math.max(0, Math.min(s, state.duration - rangeLen));
      setRange(s, s + rangeLen, { scrubAt: s });
    } else if (mode === 'play') {
      state.playhead = t; layoutTimeline();
      if (ui.loopPage.checked) send({ type: 'seek', t }); else scrub(t);
    }
  };
  ui.track.addEventListener('pointermove', onMove);
  const end = () => { mode = null; };
  ui.track.addEventListener('pointerup', end);
  ui.track.addEventListener('pointercancel', end);
})();

ui.startIn.addEventListener('change', () => setRange(parseFloat(ui.startIn.value) || 0, state.end, { scrubAt: parseFloat(ui.startIn.value) || 0 }));
ui.endIn.addEventListener('change', () => setRange(state.start, parseFloat(ui.endIn.value) || state.duration, { scrubAt: parseFloat(ui.endIn.value) || state.duration }));

ui.loopPage.addEventListener('change', () => {
  send({ type: 'loop', on: ui.loopPage.checked, start: state.start, end: state.end });
});

window.addEventListener('resize', layoutTimeline);

// ----------------------------------------------------------------- settings controls
function syncSizeSelect() {
  if (state.width === state.videoW) ui.sizeSel.value = '0';
  else if (PRESETS.includes(state.width)) ui.sizeSel.value = String(state.width);
  else { ui.sizeSel.value = 'custom'; ui.widthIn.hidden = false; }
  ui.widthIn.value = state.width;
  ui.widthIn.max = state.videoW || 4096;
}

function updateDims() {
  const w = state.width, h = state.videoW ? Math.round(state.videoH * w / state.videoW) : 0;
  ui.dims.textContent = `${w}×${h}`;
  layoutTimeline();
}

ui.sizeSel.addEventListener('change', () => {
  const v = ui.sizeSel.value;
  if (v === 'custom') { ui.widthIn.hidden = false; ui.widthIn.focus(); return; }
  ui.widthIn.hidden = true;
  state.width = v === '0' ? state.videoW : Math.min(parseInt(v, 10), state.videoW || 4096);
  ui.widthIn.value = state.width;
  updateDims(); invalidate(); scrub(state.playhead);
});
ui.widthIn.addEventListener('change', () => {
  state.width = clampInt(ui.widthIn.value, 16, state.videoW || 4096, 480);
  ui.widthIn.value = state.width;
  updateDims(); invalidate(); scrub(state.playhead);
});
ui.fps.addEventListener('change', () => {
  state.fps = clampInt(ui.fps.value, 1, 50, 15);
  ui.fps.value = state.fps;
  setRange(state.start, state.end);
});
ui.dither.addEventListener('change', () => { state.dither = ui.dither.checked; invalidate(); });
ui.optimize.addEventListener('change', () => { state.optimize = ui.optimize.checked; invalidate(); });

// Any change that affects the output drops the encoded result (frame cache keeps itself keyed).
function invalidate() {
  stopPlay();
  if (!result) return;
  URL.revokeObjectURL(result.url);
  result = null;
  ui.resultImg.removeAttribute('src');
  showResultImg(false);
  ui.badge.textContent = 'frame';
  ui.saveBtn.disabled = true;
  setStatus('');
  if (!state.busy) scrub(state.playhead);
}

// ----------------------------------------------------------------- frames (capture into the cache)
function cacheKey() { return JSON.stringify([state.start, state.end, state.fps, state.width]); }
function cacheValid() { return !!frameCache && frameCache.key === cacheKey(); }
function checkLimits() {
  const n = frameCount();
  const w = state.width, h = Math.round(state.videoH * w / state.videoW);
  if (n > MAX_FRAMES) return `Too many frames (${n}). Lower the FPS or shorten the range (max ${MAX_FRAMES}).`;
  if (n * w * h > MAX_PIXELS) return 'That GIF is too large to build in memory. Reduce the size, FPS or length.';
  return null;
}

// Captures the selected range into frameCache (no-op if it is already there). onFrame fires per new frame.
async function ensureFrames(onFrame) {
  if (cacheValid()) return frameCache;
  frameCache = null;
  const key = cacheKey();
  const n = frameCount();
  const times = [];
  for (let i = 0; i < n; i++) times.push(state.start + i / state.fps);
  const frames = new Array(n);
  let fw = 0, fh = 0;
  await captureFrames(times, state.width, 'capture', (f) => {
    frames[f.index] = f.buffer; fw = f.width; fh = f.height;
    drawPreviewFrame(f);
    if (onFrame) onFrame(f, n);
  });
  frameCache = { key, frames, width: fw, height: fh };
  return frameCache;
}

// ----------------------------------------------------------------- make GIF (encoding overlaps capture)
ui.makeBtn.addEventListener('click', makeGif);
ui.cancelBtn.addEventListener('click', () => { cancelCurrent(); setStatus('Cancelled.'); });

async function makeGif() {
  if (state.busy) return;
  const limit = checkLimits();
  if (limit) return setStatus(limit, true);

  setBusy(true);
  invalidate();
  const n = frameCount();
  const delays = [];
  for (let i = 0; i < n; i++) delays.push(Math.round(100 * (i + 1) / state.fps) - Math.round(100 * i / state.fps));
  let captured = 0, encoded = 0;
  const report = () => {
    setProgress((captured + encoded) / (2 * n));
    setStatus(captured < n ? `Capturing ${captured}/${n} · encoding ${encoded}/${n}` : `Encoding… ${encoded}/${n}`);
  };
  try {
    const enc = startEncoder(n, (m) => { encoded = m; report(); });
    if (cacheValid()) {
      captured = n;
      enc.start(frameCache.width, frameCache.height);
      frameCache.frames.forEach((b, i) => enc.frame(b, delays[i]));
    } else {
      report();
      await ensureFrames((f) => {
        if (f.index === 0) enc.start(f.width, f.height);
        captured = f.index + 1;
        enc.frame(f.buffer, delays[f.index]);
        report();
      });
    }
    const bytes = await enc.finish();
    const blob = new Blob([bytes], { type: 'image/gif' });
    result = { blob, url: URL.createObjectURL(blob), bytes: bytes.length };
    ui.saveBtn.disabled = false;
    setProgress(1);
    setStatus(`${n} frames · ${frameCache.width}×${frameCache.height} · ${state.fps} fps · ${fmtBytes(result.bytes)}`);
    startPlay(); // shows the real, animated GIF
  } catch (err) {
    if (err && err.cancelled) setStatus('Cancelled.');
    else setStatus(friendlyError(err), true);
  } finally {
    currentJob = null;
    if (worker) { worker.terminate(); worker = null; }
    encoderAbort = null;
    setBusy(false);
    setTimeout(() => setProgress(0), 600);
  }
}

let encoderAbort = null;
function startEncoder(total, onProgress) {
  if (worker) worker.terminate();
  const wk = worker = new Worker('gif-worker.js');
  let resolveDone, rejectDone;
  const done = new Promise((res, rej) => { resolveDone = res; rejectDone = rej; });
  const cleanup = () => { if (worker === wk) worker = null; wk.terminate(); encoderAbort = null; };
  wk.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'progress') onProgress(m.frame);
    else if (m.type === 'done') { cleanup(); resolveDone(new Uint8Array(m.buffer)); }
    else if (m.type === 'error') { cleanup(); rejectDone(new Error(m.message)); }
  };
  wk.onerror = (e) => { cleanup(); rejectDone(new Error(e.message || 'Encoder crashed')); };
  encoderAbort = () => { cleanup(); rejectDone(Object.assign(new Error('cancelled'), { cancelled: true })); };
  return {
    start: (w, h) => wk.postMessage({ type: 'start', width: w, height: h, dither: state.dither, optimize: state.optimize, loop: 0 }),
    // Structured clone (no transfer) so the frame cache keeps its copy for re-encodes with other options.
    frame: (buffer, delay) => wk.postMessage({ type: 'frame', buffer, delay, total }),
    finish: () => { wk.postMessage({ type: 'finish' }); return done; }
  };
}

// ----------------------------------------------------------------- play / pause preview
const play = { on: false, idx: 0, timer: 0 };
ui.playBtn.addEventListener('click', togglePlay);

async function togglePlay() {
  if (play.on) return stopPlay();
  if (state.busy) return;
  if (!cacheValid()) {
    const limit = checkLimits();
    if (limit) return setStatus(limit, true);
    setBusy(true);
    try {
      await ensureFrames((f, n) => { setProgress((f.index + 1) / n); setStatus(`Capturing frames… ${f.index + 1}/${n}`); });
      setStatus('');
    } catch (err) {
      if (!err.cancelled) setStatus(friendlyError(err), true);
      return;
    } finally {
      currentJob = null;
      setBusy(false);
      setTimeout(() => setProgress(0), 600);
    }
    if (!cacheValid()) return;
  }
  startPlay();
}

function startPlay() {
  if (!cacheValid()) return;
  play.on = true;
  ui.playBtn.textContent = '❚❚ Pause';
  if (result) { ui.resultImg.src = result.url; showResultImg(true); } // the GIF animates itself; we only track the playhead
  else showResultImg(false);
  clearTimeout(play.timer);
  const step = () => {
    if (!play.on || !frameCache) return;
    const fr = frameCache;
    play.idx %= fr.frames.length;
    const t = state.start + play.idx / state.fps;
    if (ui.resultImg.hidden) drawFrameBuffer(fr.frames[play.idx], fr.width, fr.height, t);
    state.playhead = t; layoutTimeline();
    play.idx++;
    play.timer = setTimeout(step, 1000 / state.fps);
  };
  step();
}

function stopPlay() {
  if (!play.on) return;
  play.on = false;
  clearTimeout(play.timer);
  ui.playBtn.textContent = '▶ Play';
  if (result && cacheValid()) {
    // freeze on the current frame
    showResultImg(false);
    const i = (play.idx + frameCache.frames.length - 1) % frameCache.frames.length;
    drawFrameBuffer(frameCache.frames[i], frameCache.width, frameCache.height, state.start + i / state.fps);
  }
}

// ----------------------------------------------------------------- save
ui.saveBtn.addEventListener('click', async () => {
  if (!result) return;
  const base = (state.title || 'video').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50) || 'video';
  const filename = `${base} [${fmt(state.start)}-${fmt(state.end)}].gif`;
  try {
    if (typeof chrome !== 'undefined' && chrome.downloads && chrome.downloads.download) {
      await chrome.downloads.download({ url: result.url, filename, saveAs: !!state.settings.saveAs, conflictAction: 'uniquify' });
    } else {
      const a = document.createElement('a'); a.href = result.url; a.download = filename; a.click();
    }
    setStatus(`Saved ${filename} (${fmtBytes(result.bytes)})`);
  } catch (err) {
    setStatus('Could not save: ' + (err.message || err), true);
  }
});

// ----------------------------------------------------------------- helpers
function setBusy(b) {
  state.busy = b;
  ui.makeBtn.disabled = b;
  ui.playBtn.disabled = b;
  ui.cancelBtn.hidden = !b;
  ui.saveBtn.disabled = b || !result;
  for (const el of [ui.fps, ui.sizeSel, ui.widthIn, ui.startIn, ui.endIn, ui.loopPage]) el.disabled = b;
  if (!b) runScrubIfPending();
}
function runScrubIfPending() { if (scrubTarget != null && !scrubBusy) runScrub(); }
function setProgress(p) { ui.progressFill.style.width = Math.round(Math.max(0, Math.min(1, p)) * 100) + '%'; }
function setStatus(msg, isError) { ui.status.textContent = msg; ui.status.classList.toggle('err', !!isError); }
function showPreviewMsg(msg) { ui.previewMsg.textContent = msg; ui.previewMsg.hidden = false; }
function fmtBytes(n) { return n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`; }
function friendlyError(err) {
  const m = (err && err.message) || String(err);
  if (m === 'tainted') return 'This site blocks reading the video pixels, so frames cannot be captured.';
  return m;
}

// ----------------------------------------------------------------- panel chrome: drag, resize, close
(function setupDrag() {
  let dragging = false, lx = 0, ly = 0;
  ui.dragbar.addEventListener('pointerdown', (e) => {
    if (e.target === ui.closeBtn) return;
    dragging = true; lx = e.screenX; ly = e.screenY;
    ui.dragbar.setPointerCapture(e.pointerId);
  });
  ui.dragbar.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.screenX - lx, dy = e.screenY - ly;
    lx = e.screenX; ly = e.screenY;
    if (dx || dy) send({ type: 'drag', dx, dy });
  });
  const stop = () => { dragging = false; };
  ui.dragbar.addEventListener('pointerup', stop);
  ui.dragbar.addEventListener('pointercancel', stop);
})();

new ResizeObserver(() => {
  reportSize();
  layoutTimeline();
}).observe(ui.app);

function close() {
  cancelCurrent();
  if (ui.loopPage.checked) send({ type: 'loop', on: false });
  send({ type: 'close' });
}
ui.closeBtn.addEventListener('click', close);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

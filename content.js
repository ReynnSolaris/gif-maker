// Content script: shows a "GIF" button over hovered videos, opens the editor panel (an extension
// iframe) and feeds it frames captured from the page's <video> element.
(() => {
  if (window.__gifMakerLoaded) return;
  window.__gifMakerLoaded = true;
  if (!document.documentElement || !document.documentElement.appendChild) return;

  const EXT_ORIGIN = new URL(chrome.runtime.getURL('')).origin;
  const DEFAULTS = { enabled: true, fps: 15, width: 480, dither: true, optimize: true, saveAs: false };
  const MAX_Z = '2147483647';
  const PANEL_W = 600;
  let settings = { ...DEFAULTS };

  // ---------------------------------------------------------------- settings
  try {
    chrome.storage.sync.get('settings', (r) => {
      if (chrome.runtime.lastError) return;
      settings = { ...DEFAULTS, ...((r && r.settings) || {}) };
      if (!settings.enabled) hideButton();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync' || !changes.settings) return;
      settings = { ...DEFAULTS, ...(changes.settings.newValue || {}) };
      if (!settings.enabled) hideButton();
    });
  } catch (_) { /* extension context gone */ }

  // ---------------------------------------------------------------- overlay host
  const host = document.createElement('div');
  host.setAttribute('data-gifmaker', '');
  setStyle(host, {
    position: 'fixed', left: '0', top: '0', width: '0', height: '0',
    zIndex: MAX_Z, pointerEvents: 'none', margin: '0', padding: '0', border: '0'
  });
  const shadow = host.attachShadow({ mode: 'closed' });
  document.documentElement.appendChild(host);

  const CSS = `
    :host { all: initial; }
    .btn {
      position: fixed; display: none; align-items: center; gap: 6px; pointer-events: auto;
      box-sizing: border-box; height: 30px; padding: 0 10px 0 8px;
      font: 600 12px/1 system-ui, -apple-system, "Segoe UI", sans-serif; letter-spacing: .4px;
      color: #fff; background: rgba(20, 20, 26, .86); border: 1px solid rgba(255,255,255,.18);
      border-radius: 8px; cursor: pointer; backdrop-filter: blur(6px);
      box-shadow: 0 4px 14px rgba(0,0,0,.35); user-select: none; transition: background .12s, transform .12s;
    }
    .btn:hover { background: #ff3d7f; border-color: #ff3d7f; transform: translateY(-1px); }
    .btn svg { width: 16px; height: 16px; display: block; }
    .btn.show { display: flex; }
    .panel {
      position: fixed; pointer-events: auto; width: ${PANEL_W}px; height: 420px;
      border-radius: 14px; overflow: hidden; background: #16161c;
      box-shadow: 0 20px 60px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.08);
    }
    .panel iframe { width: 100%; height: 100%; border: 0; display: block; background: #16161c; }
    .toast {
      position: fixed; left: 50%; bottom: 32px; transform: translateX(-50%); pointer-events: none;
      background: #16161c; color: #fff; padding: 10px 16px; border-radius: 10px;
      font: 13px system-ui, -apple-system, "Segoe UI", sans-serif; box-shadow: 0 8px 30px rgba(0,0,0,.4);
      border: 1px solid rgba(255,255,255,.1); opacity: 0; transition: opacity .2s;
    }
    .toast.show { opacity: 1; }
  `;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    shadow.adoptedStyleSheets = [sheet];
  } catch (_) {
    const st = document.createElement('style');
    st.textContent = CSS;
    shadow.appendChild(st);
  }

  // The hover button (one shared button that follows whichever video is under the pointer).
  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.type = 'button';
  btn.title = 'Make a GIF from this video';
  btn.appendChild(makeIcon());
  btn.appendChild(document.createTextNode('GIF'));
  shadow.appendChild(btn);

  const toastEl = document.createElement('div');
  toastEl.className = 'toast';
  shadow.appendChild(toastEl);
  let toastTimer = 0;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
  }

  function makeIcon() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('x', '3'); rect.setAttribute('y', '5'); rect.setAttribute('width', '18'); rect.setAttribute('height', '14');
    rect.setAttribute('rx', '3'); rect.setAttribute('stroke', 'currentColor'); rect.setAttribute('stroke-width', '2');
    const tri = document.createElementNS(NS, 'path');
    tri.setAttribute('d', 'M10 9l5 3-5 3z'); tri.setAttribute('fill', 'currentColor');
    svg.appendChild(rect); svg.appendChild(tri);
    return svg;
  }

  function setStyle(el, obj) { for (const k in obj) el.style[k] = obj[k]; }

  // ---------------------------------------------------------------- hover tracking
  let hoverVideo = null;
  let btnVisible = false;
  let lastPt = null;
  let raf = 0;

  document.addEventListener('mousemove', (e) => {
    lastPt = { x: e.clientX, y: e.clientY };
    if (!raf) raf = requestAnimationFrame(updateHover);
  }, { passive: true, capture: true });
  document.addEventListener('mouseleave', () => hideButton(), { passive: true });
  window.addEventListener('scroll', () => hideButton(), { passive: true, capture: true });
  window.addEventListener('resize', () => { hideButton(); clampPanel(); }, { passive: true });

  function updateHover() {
    raf = 0;
    if (!settings.enabled || !lastPt) return;
    if (btnVisible && pointInRect(lastPt, btn.getBoundingClientRect(), 8)) return;
    const v = findVideoAt(lastPt.x, lastPt.y);
    if (v) showButtonFor(v); else hideButton();
  }

  function pointInRect(p, r, pad = 0) {
    return p.x >= r.left - pad && p.x <= r.right + pad && p.y >= r.top - pad && p.y <= r.bottom + pad;
  }

  function findVideoAt(x, y) {
    let best = null, bestArea = Infinity;
    const videos = document.querySelectorAll('video');
    for (const v of videos) {
      const r = v.getBoundingClientRect();
      if (r.width < 80 || r.height < 60) continue;
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      const area = r.width * r.height;
      if (area < bestArea) { best = v; bestArea = area; }
    }
    return best;
  }

  function showButtonFor(video) {
    hoverVideo = video;
    const r = video.getBoundingClientRect();
    btn.classList.add('show');
    btnVisible = true;
    const bw = btn.offsetWidth || 64, bh = btn.offsetHeight || 30;
    const left = Math.max(4, Math.min(window.innerWidth - bw - 4, r.right - bw - 10));
    const top = Math.max(4, Math.min(window.innerHeight - bh - 4, r.top + 10));
    btn.style.left = left + 'px';
    btn.style.top = top + 'px';
  }

  function hideButton() {
    if (!btnVisible) return;
    btnVisible = false;
    btn.classList.remove('show');
  }

  btn.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    if (hoverVideo) openEditor(hoverVideo);
    hideButton();
  });
  btn.addEventListener('mousedown', (e) => e.stopPropagation());

  // ---------------------------------------------------------------- context menu entry point
  let lastContext = { target: null, x: 0, y: 0 };
  document.addEventListener('contextmenu', (e) => {
    lastContext = { target: e.target, x: e.clientX, y: e.clientY };
  }, { capture: true, passive: true });

  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || msg.type !== 'gifmaker:open-context') return;
      let v = null;
      if (lastContext.target && lastContext.target.tagName === 'VIDEO') v = lastContext.target;
      if (!v) v = findVideoAt(lastContext.x, lastContext.y);
      if (!v) { toast('GIF Maker: could not find the video you right-clicked.'); return; }
      openEditor(v);
    });
  } catch (_) { /* ignore */ }

  // ---------------------------------------------------------------- editor panel
  let editor = null;

  function openEditor(video) {
    if (editor) closeEditor();
    const d = video.duration;
    if (!isFinite(d) || d <= 0) { toast('GIF Maker: this video has no seekable duration (yet).'); return; }

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.style.right = '24px';
    panel.style.top = '24px';
    const iframe = document.createElement('iframe');
    iframe.src = chrome.runtime.getURL('editor.html');
    panel.appendChild(iframe);
    shadow.appendChild(panel);

    editor = {
      video, panel, iframe, port: null, current: null,
      wasPaused: video.paused, origTime: video.currentTime,
      queue: [], running: false, loop: { on: false, start: 0, end: 0 },
      onPlay: null, onTimeUpdate: null, playFights: 0
    };

    try { video.pause(); } catch (_) {}

    editor.onTimeUpdate = () => {
      if (!editor || editor.video !== video) return;
      const lp = editor.loop;
      if (!lp.on || editor.running) return;
      if (video.currentTime >= lp.end || video.currentTime < lp.start - 0.25) video.currentTime = lp.start;
      post({ type: 'time', t: video.currentTime });
    };
    video.addEventListener('timeupdate', editor.onTimeUpdate);

    iframe.addEventListener('load', () => {
      if (!editor || editor.iframe !== iframe) return;
      const ch = new MessageChannel();
      editor.port = ch.port1;
      editor.port.onmessage = onEditorMessage;
      iframe.contentWindow.postMessage({ type: 'gifmaker-connect' }, EXT_ORIGIN, [ch.port2]);
    });
  }

  function closeEditor() {
    if (!editor) return;
    const ed = editor;
    editor = null;
    for (const job of ed.queue) job.cancelled = true;
    if (ed.current) ed.current.cancelled = true;
    ed.queue.length = 0;
    ed.loop.on = false;
    try { ed.port && ed.port.close(); } catch (_) {}
    ed.video.removeEventListener('timeupdate', ed.onTimeUpdate);
    if (ed.onPlay) ed.video.removeEventListener('play', ed.onPlay);
    ed.panel.remove();
    try {
      ed.video.currentTime = ed.origTime;
      if (!ed.wasPaused) ed.video.play().catch(() => {});
    } catch (_) {}
  }

  function post(msg, transfer) {
    if (!editor || !editor.port) return;
    try { editor.port.postMessage(msg, transfer || []); } catch (_) {}
  }

  function clampPanel() {
    if (!editor) return;
    const p = editor.panel;
    if (!p.style.left) return; // still anchored right/top
    const r = p.getBoundingClientRect();
    const left = Math.max(-r.width + 80, Math.min(window.innerWidth - 80, r.left));
    const top = Math.max(0, Math.min(window.innerHeight - 40, r.top));
    p.style.left = left + 'px';
    p.style.top = top + 'px';
  }

  function onEditorMessage(e) {
    if (!editor) return;
    const m = e.data || {};
    const video = editor.video;
    switch (m.type) {
      case 'ready': {
        let tainted = false;
        try {
          const c = document.createElement('canvas');
          c.width = c.height = 1;
          const ctx = c.getContext('2d');
          ctx.drawImage(video, 0, 0, 1, 1);
          ctx.getImageData(0, 0, 1, 1);
        } catch (_) { tainted = true; }
        post({
          type: 'init',
          duration: video.duration,
          currentTime: video.currentTime,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
          src: video.currentSrc || video.src || '',
          tainted,
          title: document.title || location.hostname,
          settings
        });
        break;
      }
      case 'capture':
        enqueue({ reqId: m.reqId, times: m.times || [], width: m.width || 480, kind: m.kind || 'capture', cancelled: false });
        break;
      case 'cancel':
        for (const job of editor.queue) if (job.reqId === m.reqId) job.cancelled = true;
        if (editor.current && editor.current.reqId === m.reqId) editor.current.cancelled = true;
        break;
      case 'seek':
        if (!editor.running) { try { video.currentTime = m.t; } catch (_) {} }
        break;
      case 'loop':
        editor.loop = { on: !!m.on, start: m.start || 0, end: m.end || video.duration };
        if (editor.loop.on) {
          if (!editor.running) {
            try { video.currentTime = editor.loop.start; video.play().catch(() => {}); } catch (_) {}
          }
        } else {
          try { video.pause(); } catch (_) {}
        }
        break;
      case 'drag': {
        const p = editor.panel;
        if (!p.style.left) {
          const r = p.getBoundingClientRect();
          p.style.left = r.left + 'px';
          p.style.top = r.top + 'px';
          p.style.right = 'auto';
        }
        p.style.left = (parseFloat(p.style.left) + m.dx) + 'px';
        p.style.top = (parseFloat(p.style.top) + m.dy) + 'px';
        clampPanel();
        break;
      }
      case 'resize': {
        const h = Math.max(200, Math.min(window.innerHeight - 48, Math.ceil(m.height || 420)));
        editor.panel.style.height = h + 'px';
        if (m.width) editor.panel.style.width = Math.min(window.innerWidth - 16, m.width) + 'px';
        clampPanel();
        break;
      }
      case 'toast':
        toast(m.message || '');
        break;
      case 'close':
        closeEditor();
        break;
    }
  }

  // ---------------------------------------------------------------- capture queue
  function enqueue(job) {
    if (!editor) return;
    if (job.kind === 'scrub') {
      // Only the latest scrub request matters.
      for (const q of editor.queue) if (q.kind === 'scrub') q.cancelled = true;
    }
    editor.queue.push(job);
    pump();
  }

  async function pump() {
    if (!editor || editor.running) return;
    const ed = editor;
    ed.running = true;
    const video = ed.video;

    // Some players auto-resume playback; keep it paused while we grab frames.
    ed.playFights = 0;
    ed.onPlay = () => { if (ed.playFights++ < 60) { try { video.pause(); } catch (_) {} } };
    video.addEventListener('play', ed.onPlay);
    try { video.pause(); } catch (_) {}

    try {
      while (editor === ed && ed.queue.length) {
        const job = ed.queue.shift();
        if (job.cancelled) { post({ type: 'capture-cancelled', reqId: job.reqId }); continue; }
        ed.current = job;
        try {
          await runCapture(ed, job);
        } catch (err) {
          post({ type: 'capture-error', reqId: job.reqId, message: (err && err.message) || String(err) });
        }
        ed.current = null;
      }
    } finally {
      video.removeEventListener('play', ed.onPlay);
      ed.onPlay = null;
      ed.running = false;
      if (editor === ed && ed.loop.on) {
        try { video.currentTime = ed.loop.start; video.play().catch(() => {}); } catch (_) {}
      }
    }
  }

  async function runCapture(ed, job) {
    const video = ed.video;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) throw new Error('The video has not loaded any frames yet.');
    if (!video.isConnected) throw new Error('The video was removed from the page.');

    const w = Math.max(16, Math.min(Math.round(job.width) || vw, vw));
    const h = Math.max(1, Math.round(vh * w / vw));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let timeouts = 0;

    for (let i = 0; i < job.times.length; i++) {
      if (job.cancelled || editor !== ed) { post({ type: 'capture-cancelled', reqId: job.reqId }); return; }
      if (!video.isConnected) throw new Error('The video was removed from the page.');
      if (video.error) throw new Error('The video reported a playback error.');
      const ok = await seekTo(video, job.times[i]);
      if (!ok && ++timeouts >= 3) throw new Error('The video stopped responding to seeks. Try playing it fully once, then retry.');
      ctx.drawImage(video, 0, 0, w, h);
      let data;
      try { data = ctx.getImageData(0, 0, w, h); }
      catch (_) { throw new Error('tainted'); }
      post({
        type: 'frame', reqId: job.reqId, index: i, total: job.times.length,
        width: w, height: h, time: job.times[i], buffer: data.data.buffer
      }, [data.data.buffer]);
    }
    post({ type: 'capture-done', reqId: job.reqId });
  }

  // Seek the video and wait until the new frame is actually presented. Resolves true on a clean seek,
  // false if we had to give up waiting.
  function seekTo(video, t) {
    const dur = video.duration;
    const target = Math.max(0, Math.min(t, isFinite(dur) ? Math.max(0, dur - 0.01) : t));
    return new Promise((resolve) => {
      if (!video.seeking && Math.abs(video.currentTime - target) < 0.0005 && video.readyState >= 2) return resolve(true);
      let presented = false, presentResolve = null;
      if (typeof video.requestVideoFrameCallback === 'function') {
        try { video.requestVideoFrameCallback(() => { presented = true; if (presentResolve) presentResolve(); }); } catch (_) {}
      }
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        video.removeEventListener('seeked', onSeeked);
        clearTimeout(timer);
        if (presented || !ok) return resolve(ok);
        // Give the compositor a moment to present the seeked frame.
        const t2 = setTimeout(() => resolve(ok), 50);
        presentResolve = () => { clearTimeout(t2); resolve(ok); };
      };
      const onSeeked = () => finish(true);
      const timer = setTimeout(() => finish(false), 5000);
      video.addEventListener('seeked', onSeeked);
      try { video.currentTime = target; } catch (_) { finish(false); }
    });
  }
})();

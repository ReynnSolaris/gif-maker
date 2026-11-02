const DEFAULTS = { enabled: true, fps: 15, width: 480, dither: true, optimize: true, saveAs: false };
const ids = ['enabled', 'fps', 'width', 'dither', 'optimize', 'saveAs'];
const el = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));

function read(s) {
  el.enabled.checked = !!s.enabled;
  el.fps.value = s.fps;
  el.width.value = String([160, 240, 320, 480, 640, 0].includes(s.width) ? s.width : 480);
  el.dither.checked = !!s.dither;
  el.optimize.checked = !!s.optimize;
  el.saveAs.checked = !!s.saveAs;
}

async function load() {
  const { settings } = await chrome.storage.sync.get('settings');
  read({ ...DEFAULTS, ...(settings || {}) });
}

async function save() {
  const { settings } = await chrome.storage.sync.get('settings');
  const next = {
    ...DEFAULTS,
    ...(settings || {}),
    enabled: el.enabled.checked,
    fps: Math.min(50, Math.max(1, parseInt(el.fps.value, 10) || DEFAULTS.fps)),
    width: parseInt(el.width.value, 10),
    dither: el.dither.checked,
    optimize: el.optimize.checked,
    saveAs: el.saveAs.checked
  };
  await chrome.storage.sync.set({ settings: next });
}

ids.forEach((id) => el[id].addEventListener('change', save));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.settings) read({ ...DEFAULTS, ...(changes.settings.newValue || {}) });
});
load();

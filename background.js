// Service worker: context menu entry + keyboard shortcut that flips the overlay toggle.
const DEFAULTS = { enabled: true, fps: 15, width: 480, dither: true, optimize: true, saveAs: false };

async function getSettings() {
  const { settings } = await chrome.storage.sync.get('settings');
  return { ...DEFAULTS, ...(settings || {}) };
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: 'gifmaker-open',
    title: 'Make GIF from this video',
    contexts: ['video']
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'gifmaker-open' || !tab || tab.id == null) return;
  const frameId = typeof info.frameId === 'number' ? info.frameId : 0;
  chrome.tabs.sendMessage(tab.id, { type: 'gifmaker:open-context' }, { frameId }).catch(() => {});
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-overlay') return;
  const s = await getSettings();
  await chrome.storage.sync.set({ settings: { ...s, enabled: !s.enabled } });
});

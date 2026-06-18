/**
 * Background service worker — handles download interception and file fetching.
 * Service worker is exempt from CORS for host_permissions domains.
 * File data is stored in IndexedDB (survives SW termination, no IPC size limits).
 * Analysis and conversion happen in the popup (which has DOM access).
 */

// In Chrome, service worker loads file-store.js via importScripts.
// In Firefox, background.scripts loads it separately (importScripts doesn't exist).
if (typeof importScripts === 'function') {
  importScripts('lib/file-store.js');
}

// Track in-flight URLs to prevent Mode A + Mode B double interception
const IN_FLIGHT_TTL = 30000;
const IN_FLIGHT_MAX = 50;
const inFlightUrls = new Set();

function markInFlight(url) {
  if (inFlightUrls.size >= IN_FLIGHT_MAX) inFlightUrls.clear();
  inFlightUrls.add(url);
  setTimeout(() => inFlightUrls.delete(url), IN_FLIGHT_TTL);
}

function extractBaseName(pathOrUrl) {
  try {
    const segment = pathOrUrl.split(/[/\\]/).pop() || '';
    const clean = segment.split('?')[0];
    const name = clean.replace(/\.3mf$/i, '');
    return name || 'model';
  } catch {
    return 'model';
  }
}

/** Extract original filename from Content-Disposition header. */
function extractNameFromDisposition(disposition) {
  if (!disposition) return null;
  // Try RFC 5987 filename*= first (handles non-ASCII)
  const utf8Match = disposition.match(/filename\*=(?:UTF-8''|utf-8'')([^;]+)/i);
  if (utf8Match) {
    try {
      const name = decodeURIComponent(utf8Match[1]).replace(/\.3mf$/i, '');
      if (name) return sanitizeFilename(name);
    } catch {
      // malformed percent-encoding — fall through to plain filename=
    }
  }
  const match = disposition.match(/filename="?([^";\n]+)"?/i);
  if (match) {
    const name = match[1].trim().replace(/\.3mf$/i, '');
    if (name) return sanitizeFilename(name);
  }
  return null;
}

/** Strip path separators and traversal from filenames to prevent path traversal via chrome.downloads. */
function sanitizeFilename(name) {
  return name.replace(/[/\\]/g, '_').replace(/\.\./g, '').replace(/^_+/, '') || 'model';
}

/** Fetch the .3mf file, extract filename, store in IndexedDB. */
async function fetchAndStore(url, fallbackName) {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);

  const originalName = extractNameFromDisposition(response.headers.get('Content-Disposition'))
    || sanitizeFilename(extractBaseName(fallbackName || url));

  // No size cap — large detailed models are allowed through. If the file is too big
  // for the browser to hold, fetch/arrayBuffer will reject and the caller shows an error.
  const arrayBuffer = await response.arrayBuffer();

  await self.MWU1.storeFile(arrayBuffer, { url, originalName });
  return originalName;
}

/** Validate a URL uses HTTPS (no javascript:, data:, file: etc). */
function isSafeFetchUrl(url) {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

function looks3mf(downloadItem) {
  const url = (downloadItem.url || '').toLowerCase();
  const filename = (downloadItem.filename || '').toLowerCase();
  const mime = downloadItem.mime || '';

  // Check URL path (before query string) for .3mf extension, not just anywhere in the URL
  let urlPath = '';
  try { urlPath = new URL(url).pathname.toLowerCase(); } catch {}

  return filename.endsWith('.3mf') ||
    urlPath.endsWith('.3mf');
}

/** Check if the download URL is a blob: from our own extension (skip self-generated downloads). */
function isOwnDownload(url) {
  return url.startsWith('blob:chrome-extension://') || url.startsWith('blob:moz-extension://');
}

const POPUP_URL = chrome.runtime.getURL('src/popup/popup.html');

/**
 * Mark that this browser session has intentionally opened a popup. storage.session
 * is in-memory and wiped on browser restart, so the popup uses the absence of this
 * flag to detect (and self-close) windows the browser restored on relaunch.
 */
async function markSessionActive() {
  try { await chrome.storage.session.set({ swSessionActive: true }); } catch {}
}

/** Close any open converter popup windows (single-window; also clears restored ones). */
async function closeExistingPopups() {
  try {
    const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['popup'] });
    for (const win of wins) {
      const isOurs = (win.tabs || []).some(t => (t.url || t.pendingUrl || '').startsWith(POPUP_URL));
      if (isOurs) {
        try { await chrome.windows.remove(win.id); } catch {}
      }
    }
  } catch {}
}

function createPopupWindow() {
  chrome.windows.create({
    url: POPUP_URL,
    type: 'popup',
    width: 560,
    height: 400,
    focused: true,
  });
}

/** Open a fresh converter popup, replacing any already-open one (no fetch). */
async function openPopup() {
  await markSessionActive();
  await closeExistingPopups();
  createPopupWindow();
}

function showBadgeProgress() {
  chrome.action.setBadgeText({ text: '...' });
  chrome.action.setBadgeBackgroundColor({ color: '#00B4D8' });
}

function showBadgeError() {
  chrome.action.setBadgeText({ text: '!' });
  chrome.action.setBadgeBackgroundColor({ color: '#D04040' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 5000);
}

function clearBadge() {
  chrome.action.setBadgeText({ text: '' });
}

// ---- Download interception (Mode B) ----
chrome.downloads.onCreated.addListener(async (downloadItem) => {
  const url = downloadItem.url || '';

  console.log('[MWU1] Download detected:', {
    url: url.slice(0, 120),
    filename: downloadItem.filename,
    referrer: downloadItem.referrer,
    mime: downloadItem.mime,
  });

  if (inFlightUrls.has(url)) return;
  if (isOwnDownload(url)) return;
  // Only intercept genuinely new downloads. Skip items the browser is resuming or
  // replaying (e.g. interrupted .3mf downloads re-created on startup), which would
  // otherwise pop open converter windows the user never asked for.
  if (downloadItem.state && downloadItem.state !== 'in_progress') return;
  if (!looks3mf(downloadItem)) return;

  console.log('[MWU1] Intercepting .3mf download');

  try { await chrome.downloads.cancel(downloadItem.id); } catch {}
  try { await chrome.downloads.erase({ id: downloadItem.id }); } catch {}

  markInFlight(url);
  showBadgeProgress();

  try {
    const name = await fetchAndStore(url, downloadItem.filename || url);
    clearBadge();
    console.log('[MWU1] File fetched, opening popup. Name:', name);
    openPopup();
  } catch (err) {
    console.error('[MWU1] Fetch failed:', err);
    showBadgeError();
  }
});

// ---- Message handling ----
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'intercept_download') {
    if (!sender.tab) return false;
    const url = message.url;
    if (!isSafeFetchUrl(url)) return false;

    markInFlight(url);
    showBadgeProgress();

    (async () => {
      try {
        await fetchAndStore(url);
        clearBadge();
        openPopup();
      } catch (err) {
        console.error('[MWU1] Content script fetch failed:', err);
        showBadgeError();
      }
    })();
    return false;
  }

  return false;
});

// ---- Extension action click — always open popup (shows drop zone if no pending file) ----
// A toolbar click is a manual open, so drop any leftover pending download first;
// otherwise the popup would re-process a stale file instead of showing the drop zone.
chrome.action.onClicked.addListener(async () => {
  try { await self.MWU1.clearFile(); } catch {}
  openPopup();
});

// ---- Browser relaunch cleanup ----
// On startup, drop any pending file left from a previous session and close converter
// windows the browser restored via session restore. The popup also self-closes when
// it sees no swSessionActive marker; this is a best-effort backstop.
chrome.runtime.onStartup.addListener(async () => {
  try { await self.MWU1.clearFile(); } catch {}
  await closeExistingPopups();
});

/**
 * Background service worker — handles download interception and file fetching.
 * Service worker is exempt from CORS for host_permissions domains.
 * File data is stored in IndexedDB (survives SW termination, no IPC size limits).
 * Analysis and conversion happen in the popup (which has DOM access).
 */

importScripts('lib/file-store.js');

// Track in-flight URLs to prevent Mode A + Mode B double interception
const IN_FLIGHT_TTL = 30000;
const IN_FLIGHT_MAX = 50;
const inFlightUrls = new Set();

// Maximum file size to process (bytes)
const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200 MB

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

  const contentLength = parseInt(response.headers.get('Content-Length') || '0', 10);
  if (contentLength > MAX_FILE_SIZE) throw new Error(`File too large: ${(contentLength / 1048576).toFixed(1)} MB`);

  const originalName = extractNameFromDisposition(response.headers.get('Content-Disposition'))
    || sanitizeFilename(extractBaseName(fallbackName || url));

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_FILE_SIZE) throw new Error(`File too large: ${(arrayBuffer.byteLength / 1048576).toFixed(1)} MB`);

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

  return filename.endsWith('.3mf') ||
    url.includes('.3mf') ||
    mime.includes('3mf') ||
    mime === 'application/zip' && url.includes('3mf');
}

/** Check if the download URL is a blob: from our own extension (skip self-generated downloads). */
function isOwnDownload(url) {
  return url.startsWith('blob:chrome-extension://') || url.startsWith('blob:moz-extension://');
}

function openPopup() {
  chrome.windows.create({
    url: chrome.runtime.getURL('src/popup/popup.html'),
    type: 'popup',
    width: 560,
    height: 400,
    focused: true,
  });
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
  if (message.action === 'conversion_complete') {
    self.MWU1.clearFile().catch(() => {});
    return false;
  }

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
chrome.action.onClicked.addListener(() => {
  openPopup();
});

/**
 * Content script for MakerWorld pages (Mode A enhancement).
 * Intercepts download button clicks and sends the URL to the service worker.
 */

const DOWNLOAD_SELECTORS = [
  'a[href*=".3mf"]',
  'a[href*="/download/"]',
  'button[data-testid*="download"]',
];

function attachInterceptors() {
  for (const selector of DOWNLOAD_SELECTORS) {
    document.querySelectorAll(selector).forEach(el => {
      if (el.dataset.mwu1Hooked) return;
      el.dataset.mwu1Hooked = 'true';
      el.addEventListener('click', handleDownloadClick, true); // capture phase
    });
  }
}

function handleDownloadClick(event) {
  const url = extractDownloadUrl(event.target);
  if (!url || !url.includes('.3mf')) return; // let non-3mf downloads pass through

  event.preventDefault();
  event.stopPropagation();

  chrome.runtime.sendMessage({
    action: 'intercept_download',
    url,
    pageUrl: window.location.href,
  });
}

function extractDownloadUrl(el) {
  // Walk up to find an anchor with an href
  let current = el;
  while (current && current !== document.body) {
    if (current.href) return current.href;
    if (current.dataset?.downloadUrl) return current.dataset.downloadUrl;
    current = current.parentElement;
  }
  return null;
}

// Re-scan on DOM mutations (MakerWorld is a React SPA)
const observer = new MutationObserver(() => attachInterceptors());
observer.observe(document.body, { childList: true, subtree: true });
attachInterceptors();

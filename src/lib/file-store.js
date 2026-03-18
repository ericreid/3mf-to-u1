/**
 * Simple IndexedDB helper for transferring file data between
 * service worker and popup without base64 encoding or IPC size limits.
 * Survives service worker termination.
 */
self.MWU1 = self.MWU1 || {};

const DB_NAME = 'mwu1';
const STORE_NAME = 'files';
const DB_VERSION = 1;

let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function idbGet(store, key) {
  return new Promise((resolve, reject) => {
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Store pending file data (ArrayBuffer + metadata). */
self.MWU1.storeFile = async function(arrayBuffer, metadata) {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  store.put(arrayBuffer, 'pendingData');
  store.put(metadata, 'pendingMeta');
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
};

/** Load pending file data. Returns { arrayBuffer, metadata } or null. */
self.MWU1.loadFile = async function() {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const [data, meta] = await Promise.all([
    idbGet(store, 'pendingData'),
    idbGet(store, 'pendingMeta'),
  ]);
  if (!data || !meta) return null;
  return { arrayBuffer: data, metadata: meta };
};

/** Clear pending file data. */
self.MWU1.clearFile = async function() {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).clear();
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
};

// storage.js – واجهة بسيطة لـ IndexedDB (ES Module)
const DB_NAME = 'epub-translator-db';
const DB_VERSION = 1;
const STORE_STATE = 'state';
const STORE_CHUNKS = 'chunks';
const STORE_ZIP = 'zip';
const STORE_API_COUNTERS = 'api_counters';

export async function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = ev => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains(STORE_STATE)) db.createObjectStore(STORE_STATE);
      if (!db.objectStoreNames.contains(STORE_CHUNKS)) db.createObjectStore(STORE_CHUNKS);
      if (!db.objectStoreNames.contains(STORE_ZIP)) db.createObjectStore(STORE_ZIP);
      if (!db.objectStoreNames.contains(STORE_API_COUNTERS)) db.createObjectStore(STORE_API_COUNTERS, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(storeName, mode, callback) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([storeName], mode);
    const store = tx.objectStore(storeName);
    const result = callback(store);
    tx.oncomplete = () => resolve(result);
    tx.onabort = tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
  });
}

// ===== state =====
export async function saveState(stateObj) {
  await withStore(STORE_STATE, 'readwrite', s => s.put(stateObj, 'meta'));
}
export async function loadState() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_STATE], 'readonly');
    const req = tx.objectStore(STORE_STATE).get('meta');
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
export async function clearAllState() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_STATE, STORE_CHUNKS, STORE_ZIP, STORE_API_COUNTERS], 'readwrite');
    tx.objectStore(STORE_STATE).clear();
    tx.objectStore(STORE_CHUNKS).clear();
    tx.objectStore(STORE_ZIP).clear();
    tx.objectStore(STORE_API_COUNTERS).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ===== chunks =====
export async function saveChunk(key, text) {
  await withStore(STORE_CHUNKS, 'readwrite', s => s.put(text, key));
}
export async function loadChunk(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_CHUNKS], 'readonly');
    const req = tx.objectStore(STORE_CHUNKS).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

// ===== zip blob =====
export async function saveZip(key, blob) {
  await withStore(STORE_ZIP, 'readwrite', s => s.put(blob, key));
}
export async function loadZip(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_ZIP], 'readonly');
    const req = tx.objectStore(STORE_ZIP).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

// ===== API counters =====
export async function getApiKeyUsage() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_API_COUNTERS], 'readonly');
    const req = tx.objectStore(STORE_API_COUNTERS).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
export async function incrementApiKeyUsage(key) {
  await withStore(STORE_API_COUNTERS, 'readwrite', store => {
    const getReq = store.get(key);
    getReq.onsuccess = () => {
      const rec = getReq.result || { key, count: 0, lastUsed: null };
      rec.count++;
      rec.lastUsed = Date.now();
      store.put(rec);
    };
  });
}
export async function resetAllApiKeyUsage() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_API_COUNTERS], 'readwrite');
    tx.objectStore(STORE_API_COUNTERS).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

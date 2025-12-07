// storage.js (es module) – واجهة بسيطة للـ IndexedDB
const DB_NAME = 'epub-translator-db';
const DB_VERSION = 1;
const STORE_STATE = 'state';
const STORE_CHUNKS = 'chunks';
const STORE_ZIP = 'zip';

export async function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains(STORE_STATE)) db.createObjectStore(STORE_STATE);
      if (!db.objectStoreNames.contains(STORE_CHUNKS)) db.createObjectStore(STORE_CHUNKS);
      if (!db.objectStoreNames.contains(STORE_ZIP)) db.createObjectStore(STORE_ZIP);
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

// state helpers
export async function saveState(stateObj) {
  await withStore(STORE_STATE, 'readwrite', (store) => store.put(stateObj, 'meta'));
}
export async function loadState() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_STATE], 'readonly');
    const store = tx.objectStore(STORE_STATE);
    const req = store.get('meta');
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
export async function clearAllState() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_STATE, STORE_CHUNKS, STORE_ZIP], 'readwrite');
    tx.objectStore(STORE_STATE).clear();
    tx.objectStore(STORE_CHUNKS).clear();
    tx.objectStore(STORE_ZIP).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// chunks helpers (key: `${filename}::${href}::${chunkIndex}`)
export async function saveChunk(key, text) {
  await withStore(STORE_CHUNKS, 'readwrite', (store) => store.put(text, key));
}
export async function loadChunk(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_CHUNKS], 'readonly');
    const store = tx.objectStore(STORE_CHUNKS);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
export async function deleteChunk(key) {
  await withStore(STORE_CHUNKS, 'readwrite', (store) => store.delete(key));
}

// zip store (save binary blob)
export async function saveZip(key, blob) {
  await withStore(STORE_ZIP, 'readwrite', (store) => store.put(blob, key));
}
export async function loadZip(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_ZIP], 'readonly');
    const store = tx.objectStore(STORE_ZIP);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
export async function deleteZip(key) {
  await withStore(STORE_ZIP, 'readwrite', (store) => store.delete(key));
}

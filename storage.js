// storage.js
// Module: يوفر واجهة مبسطة لـ IndexedDB
const DB = 'epub_translator_db_v1';
const VERSION = 1;
const S_STATE = 'state';
const S_CHUNKS = 'chunks';
const S_ZIP = 'zip';

async function openDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(S_STATE)) db.createObjectStore(S_STATE);
      if (!db.objectStoreNames.contains(S_CHUNKS)) db.createObjectStore(S_CHUNKS);
      if (!db.objectStoreNames.contains(S_ZIP)) db.createObjectStore(S_ZIP);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function withStore(storeName, mode, callback) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const res = callback(store);
    tx.oncomplete = () => resolve(res);
    tx.onabort = tx.onerror = () => reject(tx.error || new Error('IndexedDB error'));
  });
}

// state
export async function saveState(obj) { await withStore(S_STATE, 'readwrite', s => s.put(obj, 'meta')); }
export async function loadState() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(S_STATE, 'readonly');
    const req = tx.objectStore(S_STATE).get('meta');
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
export async function clearAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([S_STATE, S_CHUNKS, S_ZIP], 'readwrite');
    tx.objectStore(S_STATE).clear();
    tx.objectStore(S_CHUNKS).clear();
    tx.objectStore(S_ZIP).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// chunks (key format: `${filename}::${href}::${chunkIndex}`)
export async function saveChunk(key, text) { await withStore(S_CHUNKS, 'readwrite', s => s.put(text, key)); }
export async function loadChunk(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(S_CHUNKS, 'readonly');
    const req = tx.objectStore(S_CHUNKS).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
export async function deleteChunk(key) { await withStore(S_CHUNKS, 'readwrite', s => s.delete(key)); }

// zip (store blob)
export async function saveZip(key, blob) { await withStore(S_ZIP, 'readwrite', s => s.put(blob, key)); }
export async function loadZip(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(S_ZIP, 'readonly');
    const req = tx.objectStore(S_ZIP).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
export async function deleteZip(key) { await withStore(S_ZIP, 'readwrite', s => s.delete(key)); }
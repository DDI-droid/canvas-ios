// The board's last known ink, kept on this device (IndexedDB), so opening the canvas (or the
// automatic reload after an update) shows the ink at once and then fetches only what changed
// while it was closed. It also means the board is still visible with no connection.
//
// Each copy carries the board's id and revision; the server answers "since rev R of board X"
// with just the missing changes, or the whole board if X isn't its board any more (a reset or
// replaced data folder), so a stale copy can't stick around.
const DB = 'canvas';
const STORE = 'ink';
// WebKit sometimes never answers indexedDB.open (or a read) right after a page load. The copy
// only saves time, so past this it's skipped and the board comes from the server instead.
const OPEN_LIMIT_MS = 1500;
let dbp = null;

// How the last load went, for the start-up timing report: 'hit', 'miss', 'timeout' or 'error'.
export const cacheStats = { result: '', ms: 0 };

function within(ms, p) {
  return Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

function db() {
  if (!dbp) {
    dbp = within(OPEN_LIMIT_MS, new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    })).catch((err) => {
      dbp = null; // private mode / storage off / stuck: run without the copy, try again next time
      throw err;
    });
  }
  return dbp;
}

export async function loadInk(key) {
  const t0 = performance.now();
  try {
    const d = await db();
    const copy = await within(OPEN_LIMIT_MS, new Promise((resolve) => {
      const r = d.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => resolve(null);
    }));
    cacheStats.result = copy ? 'hit' : 'miss';
    return copy;
  } catch (err) {
    cacheStats.result = err && err.message === 'timeout' ? 'timeout' : 'error';
    return null;
  } finally {
    cacheStats.ms = Math.round(performance.now() - t0);
  }
}

export async function saveInk(key, value) {
  try {
    const d = await db();
    await new Promise((resolve) => {
      const t = d.transaction(STORE, 'readwrite');
      t.objectStore(STORE).put(value, key);
      t.oncomplete = resolve;
      t.onerror = resolve;
      t.onabort = resolve;
    });
  } catch { /* no copy this time: the server has everything */ }
}

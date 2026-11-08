// The board's last known ink, kept on this device (IndexedDB), so opening the canvas (or the
// automatic reload after an update) shows the ink at once and then fetches only what changed
// while it was closed. It also means the board is still visible with no connection.
//
// Each copy carries the board's id and revision; the server answers "since rev R of board X"
// with just the missing changes, or the whole board if X isn't its board any more (a reset or
// replaced data folder), so a stale copy can't stick around.
const DB = 'canvas';
const STORE = 'ink';
let dbp = null;

function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((err) => {
      dbp = null; // private mode / storage off: run without the copy
      throw err;
    });
  }
  return dbp;
}

export async function loadInk(key) {
  try {
    const d = await db();
    return await new Promise((resolve) => {
      const r = d.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => resolve(null);
    });
  } catch {
    return null;
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

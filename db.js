// IndexedDB 저장소 (오프라인 기록·셀작업·마스터·로그인 정보)
// stores: records(id), jobs(id), kv(k)
const DB = (() => {
  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open('pda-inbound', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('records')) db.createObjectStore('records', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('jobs')) db.createObjectStore('jobs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }
  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let result;
      Promise.resolve(fn(s)).then(r => { result = r; });
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
  const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  return {
    get: (store, key) => tx(store, 'readonly', s => reqP(s.get(key))),
    all: (store) => tx(store, 'readonly', s => reqP(s.getAll())),
    put: (store, val) => tx(store, 'readwrite', s => { s.put(val); }),
    putMany: (store, vals) => tx(store, 'readwrite', s => { vals.forEach(v => s.put(v)); }),
    del: (store, key) => tx(store, 'readwrite', s => { s.delete(key); }),
    kvGet: async (k, def) => { const r = await tx('kv', 'readonly', s => reqP(s.get(k))); return r ? r.v : def; },
    kvSet: (k, v) => tx('kv', 'readwrite', s => { s.put({ k, v }); })
  };
})();

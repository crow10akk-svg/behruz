import type { Book } from '../types.ts';

const DB_NAME = 'smart_kutubxona_cache_v1';
const DB_VERSION = 1;
const STORE_NAME = 'catalog';
const RECORD_KEY = 'books_state_v2';

export interface CachedCatalogState {
  books: Book[];
  knownDocIds: string[];
  deletedIds?: string[];
  maxUpdatedAt: string;
  fullSyncDone: boolean;
  savedAt: string;
}

function openCacheDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function loadCatalogCacheFromIdb(): Promise<CachedCatalogState | null> {
  const idb = await openCacheDb();
  if (!idb) return null;
  return new Promise((resolve) => {
    try {
      const tx = idb.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(RECORD_KEY);
      req.onsuccess = () => {
        const val = req.result as CachedCatalogState | undefined;
        if (val && Array.isArray(val.books) && Array.isArray(val.knownDocIds)) {
          resolve(val);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function saveCatalogCacheToIdb(state: CachedCatalogState): Promise<void> {
  const idb = await openCacheDb();
  if (!idb) return;
  return new Promise((resolve) => {
    try {
      const tx = idb.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(state, RECORD_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function clearCatalogCacheFromIdb(): Promise<void> {
  const idb = await openCacheDb();
  if (!idb) return;
  return new Promise((resolve) => {
    try {
      const tx = idb.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.delete(RECORD_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

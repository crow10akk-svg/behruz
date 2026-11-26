import {
  collection,
  deleteDoc,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import { db, isQuotaExceededError } from './firebase.ts';
import { loadCatalogCacheFromIdb, saveCatalogCacheToIdb } from './bookCache.ts';
import { generateSalt, hashPassword, verifyPassword } from './crypto.ts';
import {
  compareFaceDescriptors,
  makeFaceNameKey,
  makeFaceProfileId,
  verifyFaceDescriptorIntegrity,
} from './faceService.ts';
import {
  DEFAULT_BOOK_COVER_URL,
  makeSafeDocId,
  normalizeCompareText,
  normalizeGroupCompare,
  normalizeStudentId,
  toRelaxedPhonetic,
  transliterateToLatinCanonical,
} from './imageUtils.ts';
import type { ParsedExcelBookRow } from './excelImport.ts';
import type {
  ActivityLogRecord,
  AdminCredential,
  Book,
  FaceProfile,
  LibrarySetting,
  OfflinePendingAction,
  SignatureRecord,
  Student,
  TransactionRecord,
} from '../types.ts';

const OFFLINE_QUEUE_KEY = 'smart_kutubxona_offline_queue_v1';

export function getBookAvailableCount(
  book: Pick<Book, 'quantity' | 'availableQuantity' | 'status'>
): number {
  if (typeof book.availableQuantity === 'number' && !Number.isNaN(book.availableQuantity)) {
    return Math.max(0, book.availableQuantity);
  }
  return book.status === 'olingan' ? 0 : Math.max(1, book.quantity || 1);
}

const EXCLUSIVE_NEW_BOOK_CUTOFF = '2026-11-25T10:25:00.000Z';

function isAllowedFirestoreBook(
  id: string,
  book: Pick<Book, 'createdAt'>,
  bundledMap: Map<string, Book>
): boolean {
  if (bundledMap.has(id)) return true;
  if (id.startsWith('book_seed_')) return false;
  return (book.createdAt || '') >= EXCLUSIVE_NEW_BOOK_CUTOFF;
}

export async function logAdminActivity(params: {
  action: string;
  targetType: string;
  targetId: string;
  targetLabel: string;
  details: string;
  actor?: string;
}): Promise<void> {
  const id = makeSafeDocId('log');
  const payload: Omit<ActivityLogRecord, 'id'> = {
    action: params.action.slice(0, 120),
    targetType: params.targetType.slice(0, 48),
    targetId: params.targetId.slice(0, 128),
    targetLabel: params.targetLabel.slice(0, 200),
    details: params.details.slice(0, 500),
    actor: (params.actor || 'Administrator').slice(0, 80),
    createdAt: new Date().toISOString(),
  };
  await setDoc(doc(db, 'activityLogs', id), payload);
}

export function logAdminActivityNonBlocking(params: {
  action: string;
  targetType: string;
  targetId: string;
  targetLabel: string;
  details: string;
  actor?: string;
}): void {
  void logAdminActivity(params).catch(() => {
    // Non-blocking audit trail write
  });
}

const ADMIN_CRED_CACHE_KEY = 'smart_kutubxona_admin_cred_v1';
const APP_GATE_CRED_CACHE_KEY = 'smart_kutubxona_gate_cred_v1';

function readCachedCredential(key: string): AdminCredential | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AdminCredential;
    return parsed && parsed.passwordHash && parsed.salt ? parsed : null;
  } catch {
    return null;
  }
}

function writeCachedCredential(key: string, cred: AdminCredential): void {
  try {
    localStorage.setItem(key, JSON.stringify(cred));
  } catch {
    // Ignore storage quota errors
  }
}

let seedPromise: Promise<void> | null = null;
let adminCredCache: AdminCredential | null = readCachedCredential(ADMIN_CRED_CACHE_KEY);
let appGateCredCache: AdminCredential | null = readCachedCredential(APP_GATE_CRED_CACHE_KEY);

// Precomputed PBKDF2-SHA256 fallback ONLY for cold-boot offline before Firestore caches admins/app_gate
const OFFLINE_APP_GATE_SALT = 'a7c4e91f0b2d8e31c5a67f09d1248b3c';
const OFFLINE_APP_GATE_ITERATIONS = 100000;
let offlineAppGateHashPromise: Promise<string> | null = null;

async function ensureAppGateCredential(forceRemote = false): Promise<AdminCredential> {
  if (!forceRemote && appGateCredCache && !navigator.onLine) {
    return appGateCredCache;
  }

  const appGateRef = doc(db, 'admins', 'app_gate');
  try {
    const snap = await getDoc(appGateRef);
    const data = snap.exists() ? (snap.data() as AdminCredential) : null;
    if (data && data.algorithm === 'PBKDF2-SHA256-APPGATE') {
      appGateCredCache = data;
      writeCachedCredential(APP_GATE_CRED_CACHE_KEY, data);
      return data;
    }

    const now = new Date().toISOString();
    const salt = generateSalt();
    const iterations = 100000;
    const hashed = await hashPassword('kutubxona', salt, iterations);
    const gateDoc: AdminCredential = {
      username: 'app_gate',
      passwordHash: hashed,
      salt,
      algorithm: 'PBKDF2-SHA256-APPGATE',
      iterations,
      mustChangePassword: false,
      updatedAt: now,
    };
    await setDoc(appGateRef, gateDoc);
    appGateCredCache = gateDoc;
    writeCachedCredential(APP_GATE_CRED_CACHE_KEY, gateDoc);
    return gateDoc;
  } catch (err) {
    if (appGateCredCache) return appGateCredCache;
    throw err;
  }
}

export function warmAppGateCredential(): void {
  if (appGateCredCache) return;
  void ensureAppGateCredential().catch(() => {
    // Ignore background warmup error
  });
}

export function warmAdminCredential(): void {
  if (adminCredCache) return;
  void getDoc(doc(db, 'admins', 'primary'))
    .then((snap) => {
      if (snap.exists()) {
        const data = snap.data() as AdminCredential;
        if (data.algorithm === 'PBKDF2-SHA256-SHARED') {
          adminCredCache = data;
          writeCachedCredential(ADMIN_CRED_CACHE_KEY, data);
        }
      }
    })
    .catch(() => {
      // Ignore background warmup error
    });
}

export function ensureSeededDatabase(): Promise<void> {
  if (seedPromise) return seedPromise;
  seedPromise = (async () => {
    const now = new Date().toISOString();
    const adminRef = doc(db, 'admins', 'primary');
    const appGateRef = doc(db, 'admins', 'app_gate');
    const settingsRef = doc(db, 'settings', 'library');

    const [adminSnap, appGateSnap, settingsSnap] = await Promise.all([
      getDoc(adminRef),
      getDoc(appGateRef),
      getDoc(settingsRef),
    ]);

    const writeTasks: Promise<void>[] = [];

    // 1. Seed or migrate universal shared admin access code ('03.19.2010')
    const existingAdmin = adminSnap.exists() ? (adminSnap.data() as AdminCredential) : null;
    if (!existingAdmin || existingAdmin.algorithm !== 'PBKDF2-SHA256-SHARED') {
      const salt = generateSalt();
      const iterations = 100000;
      const hashed = await hashPassword('03.19.2010', salt, iterations);
      const adminDoc: AdminCredential = {
        username: 'admin',
        passwordHash: hashed,
        salt,
        algorithm: 'PBKDF2-SHA256-SHARED',
        iterations,
        mustChangePassword: false,
        updatedAt: now,
      };
      adminCredCache = adminDoc;
      writeCachedCredential(ADMIN_CRED_CACHE_KEY, adminDoc);
      writeTasks.push(setDoc(adminRef, adminDoc));
    } else {
      adminCredCache = existingAdmin;
      writeCachedCredential(ADMIN_CRED_CACHE_KEY, existingAdmin);
    }

    // 1b. Seed universal app-entry gate password ('kutubxona')
    const existingGate = appGateSnap.exists() ? (appGateSnap.data() as AdminCredential) : null;
    if (!existingGate || existingGate.algorithm !== 'PBKDF2-SHA256-APPGATE') {
      const salt = generateSalt();
      const iterations = 100000;
      const hashed = await hashPassword('kutubxona', salt, iterations);
      const gateDoc: AdminCredential = {
        username: 'app_gate',
        passwordHash: hashed,
        salt,
        algorithm: 'PBKDF2-SHA256-APPGATE',
        iterations,
        mustChangePassword: false,
        updatedAt: now,
      };
      appGateCredCache = gateDoc;
      writeCachedCredential(APP_GATE_CRED_CACHE_KEY, gateDoc);
      writeTasks.push(setDoc(appGateRef, gateDoc));
    } else {
      appGateCredCache = existingGate;
      writeCachedCredential(APP_GATE_CRED_CACHE_KEY, existingGate);
    }

    // 2. Seed library settings if missing
    if (!settingsSnap.exists()) {
      const settingDoc: LibrarySetting = {
        institutionName: 'IIV Andijon akademik litseyi',
        libraryName: 'Smart Kutubxona',
        defaultLoanDays: 14,
        updatedAt: now,
      };
      writeTasks.push(setDoc(settingsRef, settingDoc));
    }

    if (writeTasks.length > 0) {
      await Promise.all(writeTasks);
    }
  })().catch((err) => {
    seedPromise = null;
    throw err;
  });

  return seedPromise;
}

function normalizeBookDoc(id: string, raw: Record<string, unknown>): Book {
  const bookNumberRaw = raw.bookNumber;
  const bookNumber =
    typeof bookNumberRaw === 'string' && bookNumberRaw.trim()
      ? bookNumberRaw.trim()
      : bookNumberRaw !== undefined && bookNumberRaw !== null && String(bookNumberRaw).trim()
        ? String(bookNumberRaw).trim()
        : id;

  const qtyRaw = Number(raw.quantity);
  const quantity = Number.isFinite(qtyRaw) && qtyRaw >= 0 ? qtyRaw : 1;

  const availRaw =
    raw.availableQuantity !== undefined && raw.availableQuantity !== null
      ? Number(raw.availableQuantity)
      : undefined;
  const availableQuantity =
    availRaw !== undefined && Number.isFinite(availRaw) && availRaw >= 0 ? availRaw : undefined;

  const createdAt =
    typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : '1970-01-01T00:00:00.000Z';
  const updatedAt =
    typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : createdAt;

  const statusRaw = raw.status;
  const status: Book['status'] =
    statusRaw === 'olingan' || statusRaw === 'faol_emas' ? statusRaw : 'mavjud';

  return {
    id,
    bookNumber,
    title: typeof raw.title === 'string' ? raw.title : String(raw.title ?? 'Nomsiz kitob'),
    author: typeof raw.author === 'string' ? raw.author : String(raw.author ?? ''),
    category: typeof raw.category === 'string' && raw.category ? raw.category : 'Umumiy',
    description: typeof raw.description === 'string' ? raw.description : '',
    coverUrl: typeof raw.coverUrl === 'string' ? raw.coverUrl : '',
    quantity,
    ...(availableQuantity !== undefined ? { availableQuantity } : {}),
    status,
    isActive: raw.isActive !== false,
    isDeleted: raw.isDeleted === true,
    borrowCount: Number.isFinite(Number(raw.borrowCount)) ? Number(raw.borrowCount) : 0,
    currentTransactionId:
      typeof raw.currentTransactionId === 'string' ? raw.currentTransactionId : undefined,
    currentBorrowerName:
      typeof raw.currentBorrowerName === 'string' ? raw.currentBorrowerName : undefined,
    currentBorrowerGroup:
      typeof raw.currentBorrowerGroup === 'string' ? raw.currentBorrowerGroup : undefined,
    currentBorrowerCourse:
      typeof raw.currentBorrowerCourse === 'string' ? raw.currentBorrowerCourse : undefined,
    currentBorrowedAt:
      typeof raw.currentBorrowedAt === 'string' ? raw.currentBorrowedAt : undefined,
    currentDueDate: typeof raw.currentDueDate === 'string' ? raw.currentDueDate : undefined,
    createdAt,
    updatedAt,
  };
}

const bookNumberCollator = new Intl.Collator(undefined, { numeric: true });

function compareBookNumbersFast(aRaw: string, bRaw: string): number {
  const a = String(aRaw ?? '');
  const b = String(bRaw ?? '');
  if (a === b) return 0;
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && a.length > 0 && b.length > 0) {
    return na !== nb ? na - nb : a.length - b.length;
  }
  return bookNumberCollator.compare(a, b);
}

let bundledCatalogCache: Map<string, Book> | null = null;
let bundledCatalogPromise: Promise<Map<string, Book>> | null = null;

export function loadBundledCatalog(): Promise<Map<string, Book>> {
  if (bundledCatalogCache) return Promise.resolve(bundledCatalogCache);
  if (bundledCatalogPromise) return bundledCatalogPromise;
  if (typeof fetch === 'undefined') return Promise.resolve(new Map<string, Book>());

  bundledCatalogPromise = fetch('/data/library-catalog.json')
    .then(async (res) => {
      if (!res.ok) return new Map<string, Book>();
      const rawArr = (await res.json()) as Record<string, unknown>[];
      const map = new Map<string, Book>();
      if (Array.isArray(rawArr)) {
        for (const item of rawArr) {
          const id = typeof item.id === 'string' ? item.id : '';
          if (!id) continue;
          const normalized = normalizeBookDoc(id, item);
          if (!normalized.isDeleted) {
            map.set(id, normalized);
          }
        }
      }
      bundledCatalogCache = map;
      return map;
    })
    .catch(() => new Map<string, Book>());

  return bundledCatalogPromise;
}

async function getBundledBookById(bookId: string): Promise<Book | null> {
  if (!bookId) return null;
  const map = await loadBundledCatalog();
  return map.get(bookId) || null;
}

function sanitizeBookForFirestore(b: Omit<Book, 'id'>): Omit<Book, 'id'> {
  const qty = Math.max(0, Math.min(1000, Math.round(Number(b.quantity) || 1)));
  const avail =
    b.availableQuantity !== undefined
      ? Math.max(0, Math.min(1000, Math.round(Number(b.availableQuantity) || 0)))
      : qty;
  const status: Book['status'] =
    b.status === 'olingan' || b.status === 'faol_emas' ? b.status : 'mavjud';

  const docData: Omit<Book, 'id'> = {
    bookNumber: String(b.bookNumber || '001').trim().slice(0, 32) || '001',
    title: String(b.title || 'Nomsiz kitob').trim().slice(0, 200) || 'Nomsiz kitob',
    author: String(b.author || '').trim().slice(0, 160),
    category: (String(b.category || 'Umumiy').trim() || 'Umumiy').slice(0, 80),
    description: String(b.description || '').trim().slice(0, 1000),
    coverUrl: ((b.coverUrl || '').trim() || DEFAULT_BOOK_COVER_URL).slice(0, 350000),
    quantity: qty,
    availableQuantity: avail,
    status,
    isActive: b.isActive !== false,
    isDeleted: b.isDeleted === true,
    borrowCount: Math.max(0, Math.round(Number(b.borrowCount) || 0)),
    createdAt: String(b.createdAt || new Date().toISOString()).slice(0, 64),
    updatedAt: String(b.updatedAt || new Date().toISOString()).slice(0, 64),
  };

  if (b.currentTransactionId) docData.currentTransactionId = String(b.currentTransactionId).slice(0, 128);
  if (b.currentBorrowerName) docData.currentBorrowerName = String(b.currentBorrowerName).slice(0, 160);
  if (b.currentBorrowerGroup) docData.currentBorrowerGroup = String(b.currentBorrowerGroup).slice(0, 64);
  if (b.currentBorrowerCourse) docData.currentBorrowerCourse = String(b.currentBorrowerCourse).slice(0, 32);
  if (b.currentBorrowedAt) docData.currentBorrowedAt = String(b.currentBorrowedAt).slice(0, 64);
  if (b.currentDueDate) docData.currentDueDate = String(b.currentDueDate).slice(0, 64);

  return docData;
}

export async function upsertBookDoc(
  bookId: string,
  baseBook: Omit<Book, 'id'>,
  patch: Record<string, unknown>
): Promise<void> {
  const ref = doc(db, 'books', bookId);
  const existingSnap = await getDoc(ref);
  if (existingSnap.exists()) {
    await updateDoc(ref, patch);
  } else {
    const merged = sanitizeBookForFirestore({
      ...baseBook,
      ...(patch as Partial<Omit<Book, 'id'>>),
    });
    await setDoc(ref, merged);
  }
}

export function subscribeBooks(
  onData: (books: Book[]) => void,
  onError: (err: Error) => void,
  initialCachedBooks: Book[] = [],
  onDeletedData?: (deletedBooks: Book[]) => void
): Unsubscribe {
  let cancelled = false;
  let unsubDelta: Unsubscribe | null = null;
  let bundledMap = new Map<string, Book>();
  const bookMap = new Map<string, Book>();
  const knownDocIds = new Set<string>();
  const deletedDocIds = new Set<string>();
  let maxUpdatedAt = '';
  let fullSyncDone = false;

  let hasEmittedOnce = false;
  let emitTimer: ReturnType<typeof setTimeout> | null = null;
  let idbTimer: ReturnType<typeof setTimeout> | null = null;

  const getPartitionedItems = (): { active: Book[]; deleted: Book[] } => {
    const mergedActive = new Map<string, Book>();
    const mergedDeleted = new Map<string, Book>();

    for (const [id, b] of bundledMap) {
      if (b.isDeleted || deletedDocIds.has(id)) {
        mergedDeleted.set(id, { ...b, isDeleted: true, isActive: false });
      } else {
        mergedActive.set(id, b);
      }
    }

    for (const [id, b] of bookMap) {
      if (!isAllowedFirestoreBook(id, b, bundledMap)) continue;
      if (b.isDeleted || deletedDocIds.has(id)) {
        mergedActive.delete(id);
        mergedDeleted.set(id, { ...b, isDeleted: true });
      } else {
        mergedDeleted.delete(id);
        mergedActive.set(id, b);
      }
    }

    const active = Array.from(mergedActive.values());
    active.sort((a, b) => compareBookNumbersFast(a.bookNumber, b.bookNumber));

    const deleted = Array.from(mergedDeleted.values());
    deleted.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

    return { active, deleted };
  };

  const persistIdbNow = () => {
    void saveCatalogCacheToIdb({
      books: Array.from(bookMap.values()),
      knownDocIds: Array.from(knownDocIds),
      deletedIds: Array.from(deletedDocIds),
      maxUpdatedAt,
      fullSyncDone,
      savedAt: new Date().toISOString(),
    });
  };

  const schedulePersistIdb = () => {
    if (!fullSyncDone) return;
    if (idbTimer) clearTimeout(idbTimer);
    idbTimer = setTimeout(() => {
      idbTimer = null;
      if (!cancelled) persistIdbNow();
    }, 1200);
  };

  const emitSorted = (shouldPersist = false) => {
    hasEmittedOnce = true;
    const { active, deleted } = getPartitionedItems();
    onData(active);
    onDeletedData?.(deleted);
    if (shouldPersist && fullSyncDone) {
      schedulePersistIdb();
    }
  };

  const scheduleEmitSorted = (shouldPersist = false) => {
    if (!hasEmittedOnce) {
      emitSorted(shouldPersist);
      return;
    }
    if (emitTimer) clearTimeout(emitTimer);
    emitTimer = setTimeout(() => {
      emitTimer = null;
      if (!cancelled) emitSorted(shouldPersist);
    }, 90);
  };

  const attachDeltaListener = (sinceIso: string) => {
    if (cancelled) return;
    if (unsubDelta) {
      unsubDelta();
      unsubDelta = null;
    }
    const q = sinceIso
      ? query(collection(db, 'books'), where('updatedAt', '>', sinceIso))
      : query(collection(db, 'books'));

    unsubDelta = onSnapshot(
      q,
      (snap) => {
        if (cancelled) return;
        if (snap.empty && sinceIso) {
          if (!hasEmittedOnce) emitSorted(false);
          return;
        }
        let changed = false;
        const changes = snap.docChanges();
        changes.forEach((change) => {
          const normalized = normalizeBookDoc(
            change.doc.id,
            change.doc.data() as Record<string, unknown>
          );
          if (normalized.updatedAt > maxUpdatedAt) {
            maxUpdatedAt = normalized.updatedAt;
          }
          if (change.type === 'removed') {
            knownDocIds.delete(change.doc.id);
            deletedDocIds.delete(change.doc.id);
            if (bookMap.delete(change.doc.id)) changed = true;
          } else {
            knownDocIds.add(change.doc.id);
            if (isAllowedFirestoreBook(change.doc.id, normalized, bundledMap)) {
              if (normalized.isDeleted) {
                deletedDocIds.add(change.doc.id);
              } else {
                deletedDocIds.delete(change.doc.id);
              }
              bookMap.set(change.doc.id, normalized);
              changed = true;
            } else {
              bookMap.delete(change.doc.id);
            }
          }
        });
        if (!sinceIso) {
          fullSyncDone = true;
          emitSorted(true);
        } else if (changed) {
          if (changes.length > 5) {
            scheduleEmitSorted(true);
          } else {
            emitSorted(true);
          }
        }
      },
      (err) => {
        if (!cancelled) onError(err);
      }
    );
  };

  const runFullFetchAndListen = async () => {
    const snap = await getDocs(collection(db, 'books'));
    if (cancelled) return;
    bookMap.clear();
    knownDocIds.clear();
    deletedDocIds.clear();
    maxUpdatedAt = '';
    snap.forEach((d) => {
      knownDocIds.add(d.id);
      const normalized = normalizeBookDoc(d.id, d.data() as Record<string, unknown>);
      if (normalized.updatedAt > maxUpdatedAt) {
        maxUpdatedAt = normalized.updatedAt;
      }
      if (isAllowedFirestoreBook(d.id, normalized, bundledMap)) {
        if (normalized.isDeleted) {
          deletedDocIds.add(d.id);
        }
        bookMap.set(d.id, normalized);
      }
    });
    fullSyncDone = true;
    emitSorted(true);
    attachDeltaListener(maxUpdatedAt);
  };

  void (async () => {
    try {
      const [loadedBundled, idbCache] = await Promise.all([
        loadBundledCatalog(),
        loadCatalogCacheFromIdb(),
      ]);
      if (cancelled) return;
      bundledMap = loadedBundled;

      if (idbCache && (idbCache.books.length > 0 || idbCache.knownDocIds.length > 0)) {
        for (const rawBook of idbCache.books) {
          const b = normalizeBookDoc(rawBook.id, rawBook as unknown as Record<string, unknown>);
          if (!isAllowedFirestoreBook(b.id, b, bundledMap)) continue;
          if (
            bundledMap.has(b.id) &&
            idbCache.books.length > 15000 &&
            !b.isDeleted &&
            b.isActive &&
            (b.borrowCount || 0) === 0 &&
            getBookAvailableCount(b) === Math.max(1, b.quantity || 1)
          ) {
            continue;
          }
          if (b.isDeleted) {
            deletedDocIds.add(b.id);
          }
          bookMap.set(b.id, b);
        }
        for (const id of idbCache.knownDocIds) {
          knownDocIds.add(id);
        }
        for (const id of idbCache.deletedIds || []) {
          if (bundledMap.has(id) || bookMap.has(id)) {
            deletedDocIds.add(id);
          }
        }
        maxUpdatedAt = idbCache.maxUpdatedAt || '';
        fullSyncDone = Boolean(idbCache.fullSyncDone);
        emitSorted(false);
      } else if (initialCachedBooks.length > 0) {
        for (const rawBook of initialCachedBooks) {
          const b = normalizeBookDoc(rawBook.id, rawBook as unknown as Record<string, unknown>);
          if (!isAllowedFirestoreBook(b.id, b, bundledMap)) continue;
          bookMap.set(b.id, b);
          knownDocIds.add(b.id);
          if (b.updatedAt > maxUpdatedAt) maxUpdatedAt = b.updatedAt;
        }
        emitSorted(false);
      } else if (bundledMap.size > 0) {
        emitSorted(false);
      }

      const countSnap = await getCountFromServer(collection(db, 'books'));
      if (cancelled) return;
      const serverCount = countSnap.data().count;

      if (
        fullSyncDone &&
        maxUpdatedAt &&
        knownDocIds.size === serverCount
      ) {
        attachDeltaListener(maxUpdatedAt);
      } else {
        await runFullFetchAndListen();
      }
    } catch (err) {
      if (cancelled) return;
      if (bundledMap.size > 0 || bookMap.size > 0) {
        emitSorted(false);
      }
      if (bookMap.size > 0 && maxUpdatedAt) {
        attachDeltaListener(maxUpdatedAt);
      }
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  return () => {
    cancelled = true;
    if (emitTimer) clearTimeout(emitTimer);
    if (idbTimer) clearTimeout(idbTimer);
    if (unsubDelta) unsubDelta();
  };
}

const TX_RECENT_LIMIT = 3000;
const TX_ACTIVE_LIMIT = 3000;

export function subscribeTransactions(
  onData: (items: TransactionRecord[], meta?: { isTruncated: boolean }) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const recentMap = new Map<string, TransactionRecord>();
  const activeMap = new Map<string, TransactionRecord>();
  let recentReady = false;
  let activeReady = false;
  let recentCount = 0;

  const emitMerged = () => {
    if (!recentReady && !activeReady) return;
    const merged = new Map<string, TransactionRecord>();
    recentMap.forEach((v, k) => merged.set(k, v));
    activeMap.forEach((v, k) => merged.set(k, v));
    const list = Array.from(merged.values());
    list.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    onData(list, { isTruncated: recentCount >= TX_RECENT_LIMIT });
  };

  const recentQ = query(
    collection(db, 'transactions'),
    orderBy('createdAt', 'desc'),
    limit(TX_RECENT_LIMIT)
  );
  const activeQ = query(
    collection(db, 'transactions'),
    where('status', '==', 'active'),
    limit(TX_ACTIVE_LIMIT)
  );

  const unsubRecent = onSnapshot(
    recentQ,
    (snap) => {
      recentMap.clear();
      recentCount = snap.size;
      snap.forEach((d) => {
        recentMap.set(d.id, { id: d.id, ...(d.data() as Omit<TransactionRecord, 'id'>) });
      });
      recentReady = true;
      emitMerged();
    },
    (err) => onError(err)
  );

  const unsubActive = onSnapshot(
    activeQ,
    (snap) => {
      activeMap.clear();
      snap.forEach((d) => {
        activeMap.set(d.id, { id: d.id, ...(d.data() as Omit<TransactionRecord, 'id'>) });
      });
      activeReady = true;
      emitMerged();
    },
    (err) => onError(err)
  );

  return () => {
    unsubRecent();
    unsubActive();
  };
}

export function subscribeStudents(
  onData: (items: Student[]) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const q = query(collection(db, 'students'), orderBy('updatedAt', 'desc'), limit(2500));
  return onSnapshot(
    q,
    (snap) => {
      const items: Student[] = [];
      snap.forEach((d) => {
        items.push({ id: d.id, ...(d.data() as Omit<Student, 'id'>) });
      });
      onData(items);
    },
    (err) => onError(err)
  );
}

export function subscribeSignatures(
  onData: (items: Record<string, SignatureRecord>) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const q = query(collection(db, 'signatures'), orderBy('createdAt', 'desc'), limit(300));
  return onSnapshot(
    q,
    (snap) => {
      const map: Record<string, SignatureRecord> = {};
      snap.forEach((d) => {
        map[d.id] = { id: d.id, ...(d.data() as Omit<SignatureRecord, 'id'>) };
      });
      onData(map);
    },
    (err) => onError(err)
  );
}

export async function getSignatureById(signatureId: string): Promise<SignatureRecord | null> {
  if (!signatureId) return null;
  const snap = await getDoc(doc(db, 'signatures', signatureId));
  if (!snap.exists()) return null;
  return { id: snap.id, ...(snap.data() as Omit<SignatureRecord, 'id'>) };
}

export async function fetchSignaturesByStudentId(
  studentId: string
): Promise<SignatureRecord[]> {
  if (!studentId) return [];
  const snap = await getDocs(
    query(collection(db, 'signatures'), where('studentId', '==', studentId), limit(100))
  );
  const items: SignatureRecord[] = [];
  snap.forEach((d) => {
    items.push({ id: d.id, ...(d.data() as Omit<SignatureRecord, 'id'>) });
  });
  items.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return items;
}

export function subscribeActivityLogs(
  onData: (items: ActivityLogRecord[]) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const q = query(collection(db, 'activityLogs'), orderBy('createdAt', 'desc'), limit(200));
  return onSnapshot(
    q,
    (snap) => {
      const items: ActivityLogRecord[] = [];
      snap.forEach((d) => {
        items.push({ id: d.id, ...(d.data() as Omit<ActivityLogRecord, 'id'>) });
      });
      onData(items);
    },
    (err) => onError(err)
  );
}

export function subscribeLibrarySettings(
  onData: (setting: LibrarySetting) => void,
  onError: (err: Error) => void
): Unsubscribe {
  return onSnapshot(
    doc(db, 'settings', 'library'),
    (snap) => {
      if (snap.exists()) {
        onData(snap.data() as LibrarySetting);
      }
    },
    (err) => onError(err)
  );
}

// QR Mobile Photo Transfer Sessions
export async function createQrUploadSession(sessionId: string): Promise<void> {
  const now = new Date().toISOString();
  await setDoc(doc(db, 'qrUploads', sessionId), {
    status: 'waiting',
    createdAt: now,
    updatedAt: now,
  });
}

export function subscribeQrUploadSession(
  sessionId: string,
  onUploaded: (imageDataUrl: string) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  return onSnapshot(
    doc(db, 'qrUploads', sessionId),
    (snap) => {
      if (!snap.exists()) return;
      const data = snap.data() as { status?: string; imageDataUrl?: string };
      if (data.status === 'uploaded' && data.imageDataUrl) {
        onUploaded(data.imageDataUrl);
      }
    },
    (err) => {
      if (onError) onError(err);
    }
  );
}

export async function submitQrUploadPhoto(
  sessionId: string,
  imageDataUrl: string
): Promise<void> {
  const now = new Date().toISOString();
  await setDoc(doc(db, 'qrUploads', sessionId), {
    status: 'uploaded',
    imageDataUrl,
    createdAt: now,
    updatedAt: now,
  });
}

export async function deleteQrUploadSession(sessionId: string): Promise<void> {
  try {
    await deleteDoc(doc(db, 'qrUploads', sessionId));
  } catch {
    // non-critical cleanup
  }
}

const faceLookupCache = new Map<
  string,
  { ts: number; result: { exactMatch: FaceProfile | null; candidates: FaceProfile[] } }
>();

export function clearFaceLookupCache(): void {
  faceLookupCache.clear();
}

// Face ID Profile Lookups & Admin Reset (Scalable targeted queries with session caching)
export async function lookupFaceProfilesByName(
  firstName: string,
  lastName: string,
  group?: string
): Promise<{
  exactMatch: FaceProfile | null;
  candidates: FaceProfile[];
}> {
  const f = firstName.trim();
  const l = lastName.trim();
  if (f.length < 2 || l.length < 2) {
    return { exactMatch: null, candidates: [] };
  }

  const nameKey = makeFaceNameKey(f, l);
  const groupKey = group ? normalizeGroupCompare(group) : '';
  const cacheKey = `${nameKey}::${groupKey}`;
  const cached = faceLookupCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 5 * 60 * 1000) {
    return cached.result;
  }

  // Fast direct doc lookup first when group is known
  if (groupKey) {
    const directId = makeFaceProfileId(f, l, group || '');
    const directSnap = await getDoc(doc(db, 'faceProfiles', directId));
    if (directSnap.exists()) {
      const profile = { id: directSnap.id, ...(directSnap.data() as Omit<FaceProfile, 'id'>) };
      const result = { exactMatch: profile, candidates: [profile] };
      faceLookupCache.set(cacheKey, { ts: Date.now(), result });
      return result;
    }
  }

  // Targeted indexed query limited to 5 docs (enforced by firestore.rules limit <= 10)
  const snap = await getDocs(
    query(collection(db, 'faceProfiles'), where('nameKey', '==', nameKey), limit(5))
  );

  const candidates: FaceProfile[] = [];
  snap.forEach((d) => {
    candidates.push({ id: d.id, ...(d.data() as Omit<FaceProfile, 'id'>) });
  });

  let result: { exactMatch: FaceProfile | null; candidates: FaceProfile[] };
  if (candidates.length === 0) {
    result = { exactMatch: null, candidates: [] };
  } else if (groupKey) {
    const matchedByGroup = candidates.find(
      (c) => normalizeGroupCompare(c.group) === groupKey || c.groupKey === groupKey
    );
    result = { exactMatch: matchedByGroup || null, candidates };
  } else {
    result = {
      exactMatch: candidates[0],
      candidates,
    };
  }

  faceLookupCache.set(cacheKey, { ts: Date.now(), result });
  return result;
}

export async function getFaceProfileById(profileId: string): Promise<FaceProfile | null> {
  if (!profileId) return null;
  const snap = await getDoc(doc(db, 'faceProfiles', profileId));
  if (!snap.exists()) return null;
  return { id: snap.id, ...(snap.data() as Omit<FaceProfile, 'id'>) };
}

export async function deleteFaceProfileAdmin(
  profileId: string,
  studentLabel: string
): Promise<void> {
  if (!profileId) return;
  await deleteDoc(doc(db, 'faceProfiles', profileId));
  clearFaceLookupCache();
  logAdminActivityNonBlocking({
    action: 'O‘quvchi Face ID profili o‘chirildi',
    targetType: 'faceProfile',
    targetId: profileId,
    targetLabel: studentLabel,
    details: 'Administrator Face ID rasmini qayta tushish uchun tozaladi.',
  });
}

function isStudentFieldMatch(a: string, b: string): boolean {
  const na = normalizeCompareText(a);
  const nb = normalizeCompareText(b);
  if (na === nb) return true;
  const ca = transliterateToLatinCanonical(a);
  const cb = transliterateToLatinCanonical(b);
  return Boolean(ca && ca === cb);
}

export async function resolveReturnFaceRequirement(params: {
  bookId: string;
  firstName: string;
  lastName: string;
  group: string;
}): Promise<{
  borrowFound: boolean;
  requiresFaceVerification: boolean;
  requiresExtraBookNumber: boolean;
  faceProfile: FaceProfile | null;
  borrowStudentName?: string;
}> {
  const f = params.firstName.trim();
  const l = params.lastName.trim();
  const g = params.group.trim();
  if (!params.bookId || !f || !l || !g) {
    return {
      borrowFound: false,
      requiresFaceVerification: false,
      requiresExtraBookNumber: false,
      faceProfile: null,
    };
  }

  const normGroup = normalizeGroupCompare(g);

  const activeSnap = await getDocs(
    query(
      collection(db, 'transactions'),
      where('bookId', '==', params.bookId),
      where('status', '==', 'active')
    )
  );

  let matched: TransactionRecord | null = null;
  activeSnap.forEach((d) => {
    const data = d.data() as Omit<TransactionRecord, 'id'>;
    if (
      data.type === 'borrow' &&
      isStudentFieldMatch(data.studentFirstName, f) &&
      isStudentFieldMatch(data.studentLastName, l) &&
      normalizeGroupCompare(data.studentGroup) === normGroup
    ) {
      matched = { id: d.id, ...data };
    }
  });

  if (!matched) {
    return {
      borrowFound: false,
      requiresFaceVerification: false,
      requiresExtraBookNumber: false,
      faceProfile: null,
    };
  }

  const matchedTx = matched as TransactionRecord;
  const targetFaceId =
    matchedTx.faceProfileId ||
    makeFaceProfileId(matchedTx.studentFirstName, matchedTx.studentLastName, matchedTx.studentGroup);

  const faceProfile = await getFaceProfileById(targetFaceId);
  return {
    borrowFound: true,
    requiresFaceVerification: Boolean(faceProfile),
    requiresExtraBookNumber: Boolean((matchedTx.extraBookNumber || '').trim()),
    faceProfile,
    borrowStudentName: matchedTx.studentFullName,
  };
}

export interface ActiveBorrowBookSummary {
  bookId: string;
  count: number;
  borrowers: Array<{
    fullName: string;
    group: string;
    borrowedAt: string;
  }>;
}

export async function fetchActiveBorrowSummaries(): Promise<Map<string, ActiveBorrowBookSummary>> {
  const snap = await getDocs(
    query(collection(db, 'transactions'), where('status', '==', 'active'), limit(3000))
  );
  const map = new Map<string, ActiveBorrowBookSummary>();
  snap.forEach((d) => {
    const data = d.data() as Omit<TransactionRecord, 'id'>;
    if (data.type !== 'borrow' || !data.bookId) return;
    const existing = map.get(data.bookId);
    const borrower = {
      fullName: data.studentFullName || '',
      group: data.studentGroup || '',
      borrowedAt: data.borrowedAt || '',
    };
    if (existing) {
      existing.count += 1;
      existing.borrowers.push(borrower);
    } else {
      map.set(data.bookId, {
        bookId: data.bookId,
        count: 1,
        borrowers: [borrower],
      });
    }
  });
  return map;
}

// Multi-copy atomic borrow
export async function borrowBookAtomic(params: {
  bookId: string;
  bookNumber: string;
  extraBookNumber?: string;
  firstName: string;
  lastName: string;
  group: string;
  course: string;
  borrowedAtIso?: string;
  dueDateIso: string;
  signatureDataUrl: string;
  faceEnrollment?: {
    facePhotoUrl: string;
    faceDescriptor: number[];
    descriptorHash: string;
  };
  existingFaceProfileId?: string;
}): Promise<{ transactionId: string; borrowedAt: string; dueDate: string; faceProfileId?: string }> {
  const firstName = params.firstName.trim();
  const lastName = params.lastName.trim();
  const group = params.group.trim();
  const course = params.course.trim();
  const fullName = `${firstName} ${lastName}`.trim();

  if (!firstName || !lastName || !group || !course) {
    throw new Error('Iltimos, ism, familiya, guruh va kurs maydonlarini to‘liq kiriting.');
  }
  if (!params.signatureDataUrl || params.signatureDataUrl.length < 30) {
    throw new Error('Elektron imzo qo‘yilishi shart.');
  }

  const now = new Date().toISOString();
  const borrowedAt = params.borrowedAtIso || now;
  const studentId = normalizeStudentId(firstName, lastName, group, course);
  const transactionId = makeSafeDocId('tx');
  const signatureId = makeSafeDocId('sig');
  const faceProfileId =
    params.existingFaceProfileId || makeFaceProfileId(firstName, lastName, group);

  if (params.faceEnrollment) {
    const validIntegrity = await verifyFaceDescriptorIntegrity(
      makeFaceNameKey(firstName, lastName),
      params.faceEnrollment.faceDescriptor,
      params.faceEnrollment.descriptorHash
    );
    if (!validIntegrity) {
      throw new Error('Face ID xavfsizlik tekshiruvidan o‘tmadi. Qayta rasmga tushing.');
    }
  }

  const bookRef = doc(db, 'books', params.bookId);
  const studentRef = doc(db, 'students', studentId);
  const faceRef = doc(db, 'faceProfiles', faceProfileId);
  const txRef = doc(db, 'transactions', transactionId);
  const sigRef = doc(db, 'signatures', signatureId);

  const bundledBookFallback = await getBundledBookById(params.bookId);

  let finalFaceProfileId: string | undefined = params.existingFaceProfileId;

  await runTransaction(db, async (tx) => {
    const [bookSnap, studentSnap, faceSnap] = await Promise.all([
      tx.get(bookRef),
      tx.get(studentRef),
      tx.get(faceRef),
    ]);
    const bookExistsInFirestore = bookSnap.exists();
    const book: Omit<Book, 'id'> | null = bookExistsInFirestore
      ? (bookSnap.data() as Omit<Book, 'id'>)
      : bundledBookFallback;

    if (!book) {
      throw new Error('Tanlangan kitob tizimda topilmadi.');
    }
    if (book.isDeleted || !book.isActive) {
      throw new Error('Bu kitob hozirda faol katalogda emas.');
    }

    const avail = getBookAvailableCount(book);
    if (avail <= 0) {
      throw new Error(
        `«${book.title}» (${book.bookNumber}) kitobining barcha nusxalari olingan (qolgan: 0 ta). Qaytarilmaguncha olish mumkin emas.`
      );
    }
    if (book.bookNumber.toLowerCase() !== params.bookNumber.trim().toLowerCase()) {
      throw new Error('Kitob inventar raqami tizimdagi ma’lumot bilan mos kelmadi.');
    }

    if (faceSnap.exists()) {
      finalFaceProfileId = faceSnap.id;
    } else if (params.faceEnrollment) {
      finalFaceProfileId = faceProfileId;
      const newFace: Omit<FaceProfile, 'id'> = {
        nameKey: makeFaceNameKey(firstName, lastName),
        groupKey: normalizeGroupCompare(group),
        firstName,
        lastName,
        fullName,
        group,
        course,
        facePhotoUrl: params.faceEnrollment.facePhotoUrl,
        faceDescriptor: params.faceEnrollment.faceDescriptor,
        descriptorHash: params.faceEnrollment.descriptorHash,
        createdAt: now,
        updatedAt: now,
      };
      tx.set(faceRef, newFace);
    }

    if (studentSnap.exists()) {
      const existingStudent = studentSnap.data() as Omit<Student, 'id'>;
      tx.update(studentRef, {
        firstName,
        lastName,
        fullName,
        group,
        course,
        totalBorrowed: (existingStudent.totalBorrowed || 0) + 1,
        activeCount: (existingStudent.activeCount || 0) + 1,
        updatedAt: now,
      });
    } else {
      const newStudent: Omit<Student, 'id'> = {
        firstName,
        lastName,
        fullName,
        group,
        course,
        totalBorrowed: 1,
        totalReturned: 0,
        activeCount: 1,
        createdAt: now,
        updatedAt: now,
      };
      tx.set(studentRef, newStudent);
    }

    const nextAvail = avail - 1;
    if (bookExistsInFirestore) {
      tx.update(bookRef, {
        availableQuantity: nextAvail,
        status: nextAvail <= 0 ? 'olingan' : 'mavjud',
        currentTransactionId: transactionId,
        currentBorrowerName: fullName,
        currentBorrowerGroup: group,
        currentBorrowerCourse: course,
        currentBorrowedAt: borrowedAt,
        currentDueDate: params.dueDateIso,
        borrowCount: (book.borrowCount || 0) + 1,
        updatedAt: now,
      });
    } else {
      tx.set(
        bookRef,
        sanitizeBookForFirestore({
          ...book,
          availableQuantity: nextAvail,
          status: nextAvail <= 0 ? 'olingan' : 'mavjud',
          currentTransactionId: transactionId,
          currentBorrowerName: fullName,
          currentBorrowerGroup: group,
          currentBorrowerCourse: course,
          currentBorrowedAt: borrowedAt,
          currentDueDate: params.dueDateIso,
          borrowCount: (book.borrowCount || 0) + 1,
          updatedAt: now,
        })
      );
    }

    const extraBookNumberClean = (params.extraBookNumber || '').trim().slice(0, 64);

    const txRecord: Omit<TransactionRecord, 'id'> = {
      bookId: params.bookId,
      bookNumber: book.bookNumber,
      bookTitle: book.title,
      studentId,
      studentFirstName: firstName,
      studentLastName: lastName,
      studentFullName: fullName,
      studentGroup: group,
      studentCourse: course,
      type: 'borrow',
      status: 'active',
      borrowedAt,
      dueDate: params.dueDateIso,
      borrowSignatureId: signatureId,
      ...(finalFaceProfileId ? { faceProfileId: finalFaceProfileId } : {}),
      ...(extraBookNumberClean ? { extraBookNumber: extraBookNumberClean } : {}),
      createdAt: now,
    };
    tx.set(txRef, txRecord);

    const sigRecord: Omit<SignatureRecord, 'id'> = {
      transactionId,
      studentId,
      studentFullName: fullName,
      bookId: params.bookId,
      bookNumber: book.bookNumber,
      actionType: 'borrow',
      imageDataUrl: params.signatureDataUrl,
      createdAt: now,
    };
    tx.set(sigRef, sigRecord);
  });

  clearFaceLookupCache();
  return { transactionId, borrowedAt, dueDate: params.dueDateIso, faceProfileId: finalFaceProfileId };
}

// Borrow a book NOT yet in the catalog (creates catalog entry + borrow record atomically)
export async function borrowNewUnlistedBookAtomic(params: {
  title: string;
  bookNumber?: string;
  extraBookNumber?: string;
  author?: string;
  category?: string;
  quantity?: number;
  coverUrl: string;
  firstName: string;
  lastName: string;
  group: string;
  course: string;
  borrowedAtIso?: string;
  dueDateIso: string;
  signatureDataUrl: string;
  existingBooks?: Book[];
  faceEnrollment?: {
    facePhotoUrl: string;
    faceDescriptor: number[];
    descriptorHash: string;
  };
  existingFaceProfileId?: string;
}): Promise<{ bookId: string; bookNumber: string; transactionId: string; borrowedAt: string; dueDate: string }> {
  const title = params.title.trim();
  const firstName = params.firstName.trim();
  const lastName = params.lastName.trim();
  const group = params.group.trim();
  const course = params.course.trim();
  const fullName = `${firstName} ${lastName}`.trim();

  if (!title) {
    throw new Error('Kitob nomini kiriting.');
  }
  if (!firstName || !lastName || !group || !course) {
    throw new Error('Iltimos, ism, familiya, guruh va kurs maydonlarini to‘liq kiriting.');
  }
  if (!params.coverUrl || params.coverUrl.length < 20) {
    throw new Error('Yangi kitob uchun muqova rasmini kamera orqali oling yoki yuklang.');
  }
  if (!params.signatureDataUrl || params.signatureDataUrl.length < 30) {
    throw new Error('Elektron imzo qo‘yilishi shart.');
  }

  // Use in-memory books list when provided to skip downloading full books collection
  const activeBooks: Book[] = [];
  let maxNum = 0;
  if (params.existingBooks && params.existingBooks.length > 0) {
    for (const b of params.existingBooks) {
      if (!b.isDeleted) activeBooks.push(b);
      const parsed = parseInt((b.bookNumber || '').replace(/\D/g, ''), 10);
      if (!Number.isNaN(parsed) && parsed > maxNum) maxNum = parsed;
    }
  } else {
    const existingSnap = await getDocs(collection(db, 'books'));
    existingSnap.forEach((d) => {
      const b = { id: d.id, ...(d.data() as Omit<Book, 'id'>) };
      if (!b.isDeleted) {
        activeBooks.push(b);
      }
      const parsed = parseInt((b.bookNumber || '').replace(/\D/g, ''), 10);
      if (!Number.isNaN(parsed) && parsed > maxNum) {
        maxNum = parsed;
      }
    });
  }

  const requestedNum = (params.bookNumber || '').trim();
  const matchedExisting = activeBooks.find(
    (b) =>
      (requestedNum && b.bookNumber.toLowerCase() === requestedNum.toLowerCase()) ||
      b.title.toLowerCase() === title.toLowerCase()
  );

  // If book already exists in catalog with same title/number and has available copies, borrow from it
  if (matchedExisting && matchedExisting.title.toLowerCase() === title.toLowerCase()) {
    const res = await borrowBookAtomic({
      bookId: matchedExisting.id,
      bookNumber: matchedExisting.bookNumber,
      extraBookNumber: params.extraBookNumber,
      firstName,
      lastName,
      group,
      course,
      borrowedAtIso: params.borrowedAtIso,
      dueDateIso: params.dueDateIso,
      signatureDataUrl: params.signatureDataUrl,
      faceEnrollment: params.faceEnrollment,
      existingFaceProfileId: params.existingFaceProfileId,
    });
    return {
      bookId: matchedExisting.id,
      bookNumber: matchedExisting.bookNumber,
      ...res,
    };
  }

  // Otherwise ensure unique bookNumber for the brand-new catalog item
  let finalBookNumber = requestedNum && /^[a-zA-Z0-9_-]+$/.test(requestedNum)
    ? requestedNum
    : String(maxNum + 1).padStart(3, '0');

  const numInUse = activeBooks.some(
    (b) => b.bookNumber.toLowerCase() === finalBookNumber.toLowerCase()
  );
  if (numInUse) {
    finalBookNumber = String(maxNum + 1).padStart(3, '0');
    while (activeBooks.some((b) => b.bookNumber.toLowerCase() === finalBookNumber.toLowerCase())) {
      maxNum += 1;
      finalBookNumber = String(maxNum + 1).padStart(3, '0');
    }
  }

  const now = new Date().toISOString();
  const borrowedAt = params.borrowedAtIso || now;
  const qty = Math.max(1, Math.min(500, Number(params.quantity) || 1));
  const nextAvail = Math.max(0, qty - 1);

  const bookId = makeSafeDocId('book');
  const studentId = normalizeStudentId(firstName, lastName, group, course);
  const transactionId = makeSafeDocId('tx');
  const signatureId = makeSafeDocId('sig');
  const faceProfileId =
    params.existingFaceProfileId || makeFaceProfileId(firstName, lastName, group);

  if (params.faceEnrollment) {
    const validIntegrity = await verifyFaceDescriptorIntegrity(
      makeFaceNameKey(firstName, lastName),
      params.faceEnrollment.faceDescriptor,
      params.faceEnrollment.descriptorHash
    );
    if (!validIntegrity) {
      throw new Error('Face ID xavfsizlik tekshiruvidan o‘tmadi. Qayta rasmga tushing.');
    }
  }

  const bookRef = doc(db, 'books', bookId);
  const studentRef = doc(db, 'students', studentId);
  const faceRef = doc(db, 'faceProfiles', faceProfileId);
  const txRef = doc(db, 'transactions', transactionId);
  const sigRef = doc(db, 'signatures', signatureId);

  let finalFaceProfileId: string | undefined = params.existingFaceProfileId;

  await runTransaction(db, async (tx) => {
    const [studentSnap, faceSnap] = await Promise.all([
      tx.get(studentRef),
      tx.get(faceRef),
    ]);

    if (faceSnap.exists()) {
      finalFaceProfileId = faceSnap.id;
    } else if (params.faceEnrollment) {
      finalFaceProfileId = faceProfileId;
      const newFace: Omit<FaceProfile, 'id'> = {
        nameKey: makeFaceNameKey(firstName, lastName),
        groupKey: normalizeGroupCompare(group),
        firstName,
        lastName,
        fullName,
        group,
        course,
        facePhotoUrl: params.faceEnrollment.facePhotoUrl,
        faceDescriptor: params.faceEnrollment.faceDescriptor,
        descriptorHash: params.faceEnrollment.descriptorHash,
        createdAt: now,
        updatedAt: now,
      };
      tx.set(faceRef, newFace);
    }

    const newBook = sanitizeBookForFirestore({
      bookNumber: finalBookNumber,
      title,
      author: (params.author || '').trim(),
      category: (params.category || '').trim() || 'Umumiy',
      description: 'O‘quvchi tomonidan «Yangi kitob olish» orqali katalogga kiritilgan kitob.',
      coverUrl: (params.coverUrl || '').trim() || DEFAULT_BOOK_COVER_URL,
      quantity: qty,
      availableQuantity: nextAvail,
      status: nextAvail <= 0 ? 'olingan' : 'mavjud',
      isActive: true,
      isDeleted: false,
      currentTransactionId: transactionId,
      currentBorrowerName: fullName,
      currentBorrowerGroup: group,
      currentBorrowerCourse: course,
      currentBorrowedAt: borrowedAt,
      currentDueDate: params.dueDateIso,
      borrowCount: 1,
      createdAt: now,
      updatedAt: now,
    });
    tx.set(bookRef, newBook);

    if (studentSnap.exists()) {
      const existingStudent = studentSnap.data() as Omit<Student, 'id'>;
      tx.update(studentRef, {
        firstName,
        lastName,
        fullName,
        group,
        course,
        totalBorrowed: (existingStudent.totalBorrowed || 0) + 1,
        activeCount: (existingStudent.activeCount || 0) + 1,
        updatedAt: now,
      });
    } else {
      const newStudent: Omit<Student, 'id'> = {
        firstName,
        lastName,
        fullName,
        group,
        course,
        totalBorrowed: 1,
        totalReturned: 0,
        activeCount: 1,
        createdAt: now,
        updatedAt: now,
      };
      tx.set(studentRef, newStudent);
    }

    const extraBookNumberClean = (params.extraBookNumber || '').trim().slice(0, 64);

    const txRecord: Omit<TransactionRecord, 'id'> = {
      bookId,
      bookNumber: finalBookNumber,
      bookTitle: title,
      studentId,
      studentFirstName: firstName,
      studentLastName: lastName,
      studentFullName: fullName,
      studentGroup: group,
      studentCourse: course,
      type: 'borrow',
      status: 'active',
      borrowedAt,
      dueDate: params.dueDateIso,
      borrowSignatureId: signatureId,
      ...(finalFaceProfileId ? { faceProfileId: finalFaceProfileId } : {}),
      ...(extraBookNumberClean ? { extraBookNumber: extraBookNumberClean } : {}),
      createdAt: now,
    };
    tx.set(txRef, txRecord);

    const sigRecord: Omit<SignatureRecord, 'id'> = {
      transactionId,
      studentId,
      studentFullName: fullName,
      bookId,
      bookNumber: finalBookNumber,
      actionType: 'borrow',
      imageDataUrl: params.signatureDataUrl,
      createdAt: now,
    };
    tx.set(sigRef, sigRecord);
  });

  clearFaceLookupCache();
  return {
    bookId,
    bookNumber: finalBookNumber,
    transactionId,
    borrowedAt,
    dueDate: params.dueDateIso,
  };
}

// Multi-copy atomic return (supports multiple active borrowers for the same book + Face ID verification)
export async function returnBookAtomic(params: {
  bookId: string;
  bookNumber: string;
  extraBookNumber?: string;
  bookTitle?: string;
  firstName: string;
  lastName: string;
  group: string;
  course: string;
  returnedAtIso?: string;
  signatureDataUrl: string;
  liveFaceDescriptor?: number[];
  adminOverride?: boolean;
}): Promise<{ transactionId: string; returnedAt: string }> {
  const firstName = params.firstName.trim();
  const lastName = params.lastName.trim();
  const group = params.group.trim();
  const course = params.course.trim();
  const fullName = `${firstName} ${lastName}`.trim();

  if (!firstName || !lastName || !group || !course) {
    throw new Error('Iltimos, ism, familiya, guruh va kurs maydonlarini to‘liq kiriting.');
  }
  if (!params.signatureDataUrl || params.signatureDataUrl.length < 30) {
    throw new Error('Topshirish uchun elektron imzo qo‘yilishi shart.');
  }

  const normGroup = normalizeGroupCompare(group);
  const normBookNumber = normalizeCompareText(params.bookNumber);
  const normBookTitle = params.bookTitle ? normalizeCompareText(params.bookTitle) : '';
  const enteredStudentId = normalizeStudentId(firstName, lastName, group, course);

  const isBorrowMatchingStudent = (
    t: Pick<
      TransactionRecord,
      'studentId' | 'studentFirstName' | 'studentLastName' | 'studentGroup'
    >
  ): boolean => {
    return (
      isStudentFieldMatch(t.studentFirstName, firstName) &&
      isStudentFieldMatch(t.studentLastName, lastName) &&
      normalizeGroupCompare(t.studentGroup) === normGroup
    );
  };

  // Locate active borrow transactions for this book outside runTransaction
  const activeSnap = await getDocs(
    query(
      collection(db, 'transactions'),
      where('bookId', '==', params.bookId),
      where('status', '==', 'active')
    )
  );
  const activeBorrows: Array<TransactionRecord> = [];
  activeSnap.forEach((d) => {
    const data = d.data() as Omit<TransactionRecord, 'id'>;
    if (data.type === 'borrow') {
      activeBorrows.push({ id: d.id, ...data });
    }
  });

  const matchingBorrow = activeBorrows.find((t) => isBorrowMatchingStudent(t));
  const candidateBorrow = matchingBorrow || (params.adminOverride ? activeBorrows[0] : undefined);

  const now = new Date().toISOString();
  const returnedAt = params.returnedAtIso || now;
  const returnTxId = makeSafeDocId('tx');
  const signatureId = makeSafeDocId('sig');

  const bookRef = doc(db, 'books', params.bookId);
  const returnTxRef = doc(db, 'transactions', returnTxId);
  const sigRef = doc(db, 'signatures', signatureId);

  await runTransaction(db, async (tx) => {
    const bookSnap = await tx.get(bookRef);
    if (!bookSnap.exists()) {
      throw new Error('Tanlangan kitob tizimda topilmadi.');
    }
    const book = bookSnap.data() as Omit<Book, 'id'>;
    if (book.isDeleted) {
      throw new Error('Bu kitob o‘chirilgan.');
    }
    if (normalizeCompareText(book.bookNumber) !== normBookNumber) {
      throw new Error(
        `Kitob inventar raqami mos kelmadi. Kiritilgan: ${params.bookNumber}, tizimda: ${book.bookNumber}.`
      );
    }
    if (!params.adminOverride && normBookTitle) {
      const dbNormTitle = normalizeCompareText(book.title);
      const dbCanonTitle = transliterateToLatinCanonical(book.title);
      const inCanonTitle = transliterateToLatinCanonical(params.bookTitle || '');
      const dbRelTitle = toRelaxedPhonetic(dbCanonTitle);
      const inRelTitle = toRelaxedPhonetic(inCanonTitle);

      const titleMatches =
        dbNormTitle.includes(normBookTitle) ||
        (inCanonTitle.length > 0 && dbCanonTitle.includes(inCanonTitle)) ||
        (inRelTitle.length > 0 && dbRelTitle.includes(inRelTitle));

      if (!titleMatches) {
        throw new Error(
          `Kitob nomi mos kelmadi. Kiritilgan: «${params.bookTitle}». Kitob qabul qilinmadi.`
        );
      }
    }

    const currentAvail = getBookAvailableCount(book);
    const totalQty = Math.max(1, book.quantity || 1);

    // Resolve target active transaction (supports legacy fallback via book.currentTransactionId)
    const fallbackTxId =
      !candidateBorrow && activeBorrows.length === 0 ? book.currentTransactionId : undefined;
    const targetTxId = candidateBorrow?.id || fallbackTxId;

    let activeBorrowTx: Omit<TransactionRecord, 'id'> | null = candidateBorrow || null;
    if (!activeBorrowTx && targetTxId) {
      const activeTxSnap = await tx.get(doc(db, 'transactions', targetTxId));
      if (activeTxSnap.exists()) {
        activeBorrowTx = activeTxSnap.data() as Omit<TransactionRecord, 'id'>;
      }
    }

    if (!activeBorrowTx && currentAvail >= totalQty) {
      throw new Error(
        `«${book.title}» (${book.bookNumber}) kitobining barcha nusxalari kutubxonada mavjud. O‘zingizda bo‘lmagan kitobni topshira olmaysiz.`
      );
    }

    if (activeBorrowTx && activeBorrowTx.status === 'returned') {
      throw new Error(
        `«${book.title}» (${book.bookNumber}) kitobi bo‘yicha ushbu yozuv allaqachon topshirilgan.`
      );
    }

    if (!params.adminOverride) {
      if (!activeBorrowTx && activeBorrows.length === 0) {
        throw new Error(
          `«${book.title}» (${book.bookNumber}) kitobi bo‘yicha faol olingan yozuv topilmadi. Kitob qabul qilinmadi.`
        );
      }

      const poolToCompare =
        activeBorrows.length > 0 ? activeBorrows : activeBorrowTx ? [activeBorrowTx] : [];
      const exactMatch = poolToCompare.find((b) => isBorrowMatchingStudent(b));

      if (!exactMatch) {
        let closest = poolToCompare[0];
        let bestScore = -1;
        for (const b of poolToCompare) {
          let score = 0;
          if (isStudentFieldMatch(b.studentFirstName, firstName)) score++;
          if (isStudentFieldMatch(b.studentLastName, lastName)) score++;
          if (normalizeGroupCompare(b.studentGroup) === normGroup) score++;
          if (score > bestScore) {
            bestScore = score;
            closest = b;
          }
        }

        const mismatchedFields: string[] = [];
        if (closest) {
          if (!isStudentFieldMatch(closest.studentFirstName, firstName)) {
            mismatchedFields.push('Ism');
          }
          if (!isStudentFieldMatch(closest.studentLastName, lastName)) {
            mismatchedFields.push('Familiya');
          }
          if (normalizeGroupCompare(closest.studentGroup) !== normGroup) {
            mismatchedFields.push('Guruh');
          }
        }

        const detailText =
          mismatchedFields.length > 0
            ? ` (${mismatchedFields.join(', ')} noto‘g‘ri)`
            : '';

        throw new Error(
          `Kiritilgan ma’lumotlar mos kelmadi${detailText}. Kitob qabul qilinmadi — kitobni olgandagi ism, familiya va guruhni to‘g‘ri kiriting.`
        );
      }

      const expectedExtra = (exactMatch.extraBookNumber || '').trim();
      if (expectedExtra) {
        const enteredExtra = (params.extraBookNumber || '').trim();
        if (!enteredExtra) {
          throw new Error(
            'Ushbu kitobni olayotganda qo‘shimcha kitob raqami kiritilgan. Topshirish uchun o‘sha qo‘shimcha raqamni kiritish majburiy!'
          );
        }
        const directEq = normalizeCompareText(enteredExtra) === normalizeCompareText(expectedExtra);
        const canonExpected = transliterateToLatinCanonical(expectedExtra);
        const canonEntered = transliterateToLatinCanonical(enteredExtra);
        const canonEq = Boolean(canonExpected && canonEntered === canonExpected);
        if (!directEq && !canonEq) {
          throw new Error(
            'Kiritilgan qo‘shimcha kitob raqami kitobni olgandagi raqam bilan mos kelmadi. To‘g‘ri qo‘shimcha raqamni kiriting.'
          );
        }
      }
    }

    const targetStudentId = activeBorrowTx?.studentId || enteredStudentId;
    const targetStudentRef = doc(db, 'students', targetStudentId);
    const targetFaceProfileId =
      activeBorrowTx?.faceProfileId ||
      makeFaceProfileId(
        activeBorrowTx?.studentFirstName || firstName,
        activeBorrowTx?.studentLastName || lastName,
        activeBorrowTx?.studentGroup || group
      );
    const targetFaceRef = doc(db, 'faceProfiles', targetFaceProfileId);

    const [targetStudentSnap, targetFaceSnap] = await Promise.all([
      tx.get(targetStudentRef),
      tx.get(targetFaceRef),
    ]);

    if (!params.adminOverride && targetFaceSnap.exists()) {
      const savedFace = targetFaceSnap.data() as Omit<FaceProfile, 'id'>;
      const integrityOk = await verifyFaceDescriptorIntegrity(
        savedFace.nameKey,
        savedFace.faceDescriptor,
        savedFace.descriptorHash
      );
      if (!integrityOk) {
        throw new Error(
          'Saqlangan Face ID ma’lumotlari yaxlitligi buzilgan. Administratorga murojaat qiling.'
        );
      }
      if (!params.liveFaceDescriptor || params.liveFaceDescriptor.length !== 128) {
        throw new Error(
          'Kitobni topshirish uchun Face ID kamerasidan yuzingizni tasdiqlashingiz shart.'
        );
      }
      const cmp = compareFaceDescriptors(params.liveFaceDescriptor, savedFace.faceDescriptor);
      if (!cmp.match) {
        throw new Error(
          `Yuz mos kelmadi! Kameradagi shaxs kitobni olgan o‘quvchi (${activeBorrowTx?.studentFullName || fullName}) bilan mos emas. Kitob qabul qilinmadi.`
        );
      }
    }

    if (targetStudentSnap.exists()) {
      const st = targetStudentSnap.data() as Omit<Student, 'id'>;
      tx.update(targetStudentRef, {
        totalReturned: (st.totalReturned || 0) + 1,
        activeCount: Math.max(0, (st.activeCount || 1) - 1),
        updatedAt: now,
      });
    } else {
      tx.set(targetStudentRef, {
        firstName,
        lastName,
        fullName,
        group,
        course,
        totalBorrowed: 1,
        totalReturned: 1,
        activeCount: 0,
        createdAt: now,
        updatedAt: now,
      });
    }

    if (targetTxId && activeBorrowTx) {
      tx.update(doc(db, 'transactions', targetTxId), {
        status: 'returned',
        returnedAt,
        returnSignatureId: signatureId,
      });
    }

    const nextAvail = Math.min(totalQty, currentAvail + 1);
    const remainingActive = activeBorrows.filter((b) => b.id !== targetTxId);
    const nextHolder = remainingActive[0];

    tx.update(bookRef, {
      availableQuantity: nextAvail,
      status: book.isActive ? (nextAvail > 0 ? 'mavjud' : 'olingan') : 'faol_emas',
      currentTransactionId: nextHolder?.id || '',
      currentBorrowerName: nextHolder?.studentFullName || '',
      currentBorrowerGroup: nextHolder?.studentGroup || '',
      currentBorrowerCourse: nextHolder?.studentCourse || '',
      currentBorrowedAt: nextHolder?.borrowedAt || '',
      currentDueDate: nextHolder?.dueDate || '',
      updatedAt: now,
    });

    const finalExtraBookNumber = (
      params.extraBookNumber ||
      activeBorrowTx?.extraBookNumber ||
      ''
    )
      .trim()
      .slice(0, 64);

    const returnRecord: Omit<TransactionRecord, 'id'> = {
      bookId: params.bookId,
      bookNumber: book.bookNumber,
      bookTitle: book.title,
      studentId: targetStudentId,
      studentFirstName: activeBorrowTx?.studentFirstName || firstName,
      studentLastName: activeBorrowTx?.studentLastName || lastName,
      studentFullName: activeBorrowTx?.studentFullName || fullName,
      studentGroup: activeBorrowTx?.studentGroup || group,
      studentCourse: activeBorrowTx?.studentCourse || course,
      type: 'return',
      status: 'returned',
      borrowedAt: activeBorrowTx?.borrowedAt || book.currentBorrowedAt || now,
      dueDate: activeBorrowTx?.dueDate || book.currentDueDate || now,
      returnedAt,
      returnSignatureId: signatureId,
      ...(targetFaceSnap.exists() ? { faceProfileId: targetFaceProfileId } : {}),
      ...(finalExtraBookNumber ? { extraBookNumber: finalExtraBookNumber } : {}),
      adminOverride: Boolean(params.adminOverride),
      createdAt: now,
    };
    tx.set(returnTxRef, returnRecord);

    const sigRecord: Omit<SignatureRecord, 'id'> = {
      transactionId: returnTxId,
      studentId: targetStudentId,
      studentFullName: fullName,
      bookId: params.bookId,
      bookNumber: book.bookNumber,
      actionType: 'return',
      imageDataUrl: params.signatureDataUrl,
      createdAt: now,
    };
    tx.set(sigRef, sigRecord);
  });

  return { transactionId: returnTxId, returnedAt };
}

// Direct Return from Admin Panel (marks specific active borrow transaction as returned, updates stock & keeps full history)
export async function adminReturnTransactionAtomic(params: {
  transaction: TransactionRecord;
  returnedAtIso?: string;
}): Promise<{ returnTxId: string; returnedAt: string }> {
  const src = params.transaction;
  if (src.type !== 'borrow' || src.status !== 'active') {
    throw new Error('Bu yozuv allaqachon to‘liq topshirilgan.');
  }

  const now = new Date().toISOString();
  const returnedAt = params.returnedAtIso || now;
  const returnTxId = makeSafeDocId('tx');

  // Check other active borrows for this book to keep holder metadata accurate
  const activeSnap = await getDocs(
    query(
      collection(db, 'transactions'),
      where('bookId', '==', src.bookId),
      where('status', '==', 'active')
    )
  );
  const otherActives: TransactionRecord[] = [];
  activeSnap.forEach((d) => {
    if (d.id !== src.id) {
      const data = d.data() as Omit<TransactionRecord, 'id'>;
      if (data.type === 'borrow') {
        otherActives.push({ id: d.id, ...data });
      }
    }
  });

  const bookRef = doc(db, 'books', src.bookId);
  const origTxRef = doc(db, 'transactions', src.id);
  const studentRef = doc(db, 'students', src.studentId);
  const returnTxRef = doc(db, 'transactions', returnTxId);

  await runTransaction(db, async (tx) => {
    const [origTxSnap, bookSnap, studentSnap] = await Promise.all([
      tx.get(origTxRef),
      tx.get(bookRef),
      tx.get(studentRef),
    ]);

    if (!origTxSnap.exists()) {
      throw new Error('Operatsiya yozuvi topilmadi.');
    }
    const origData = origTxSnap.data() as Omit<TransactionRecord, 'id'>;
    if (origData.status === 'returned') {
      throw new Error('Bu kitob allaqachon topshirilgan.');
    }

    tx.update(origTxRef, {
      status: 'returned',
      returnedAt,
    });

    if (bookSnap.exists()) {
      const book = bookSnap.data() as Omit<Book, 'id'>;
      const totalQty = Math.max(1, book.quantity || 1);
      const currentAvail = getBookAvailableCount(book);
      const nextAvail = Math.min(totalQty, currentAvail + 1);
      const nextHolder = otherActives[0];

      tx.update(bookRef, {
        availableQuantity: nextAvail,
        status: book.isActive ? (nextAvail > 0 ? 'mavjud' : 'olingan') : 'faol_emas',
        currentTransactionId: nextHolder?.id || '',
        currentBorrowerName: nextHolder?.studentFullName || '',
        currentBorrowerGroup: nextHolder?.studentGroup || '',
        currentBorrowerCourse: nextHolder?.studentCourse || '',
        currentBorrowedAt: nextHolder?.borrowedAt || '',
        currentDueDate: nextHolder?.dueDate || '',
        updatedAt: now,
      });
    }

    if (studentSnap.exists()) {
      const st = studentSnap.data() as Omit<Student, 'id'>;
      tx.update(studentRef, {
        totalReturned: (st.totalReturned || 0) + 1,
        activeCount: Math.max(0, (st.activeCount || 1) - 1),
        updatedAt: now,
      });
    }

    const returnRecord: Omit<TransactionRecord, 'id'> = {
      bookId: src.bookId,
      bookNumber: src.bookNumber,
      bookTitle: src.bookTitle,
      studentId: src.studentId,
      studentFirstName: src.studentFirstName,
      studentLastName: src.studentLastName,
      studentFullName: src.studentFullName,
      studentGroup: src.studentGroup,
      studentCourse: src.studentCourse,
      type: 'return',
      status: 'returned',
      borrowedAt: src.borrowedAt,
      dueDate: src.dueDate,
      returnedAt,
      borrowSignatureId: src.borrowSignatureId,
      ...(src.extraBookNumber ? { extraBookNumber: src.extraBookNumber } : {}),
      adminOverride: true,
      createdAt: now,
    };
    tx.set(returnTxRef, returnRecord);
  });

  logAdminActivityNonBlocking({
    action: 'Admin paneldan kitob topshirildi',
    targetType: 'transaction',
    targetId: returnTxId,
    targetLabel: `${src.studentFullName} · № ${src.bookNumber}`,
    details: `«${src.bookTitle}» kitobi admin panel orqali to‘liq topshirilgan deb qayd etildi.`,
  });

  return { returnTxId, returnedAt };
}

// Offline Queue Helpers
export function loadOfflineQueue(): OfflinePendingAction[] {
  try {
    const raw = localStorage.getItem(OFFLINE_QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveOfflineQueue(items: OfflinePendingAction[]): void {
  localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(items));
}

export function enqueueOfflineAction(action: OfflinePendingAction): OfflinePendingAction[] {
  const existing = loadOfflineQueue();
  const next = [...existing, action];
  saveOfflineQueue(next);
  return next;
}

export async function flushOfflineQueue(): Promise<{
  syncedCount: number;
  remaining: OfflinePendingAction[];
  quotaExceeded?: boolean;
}> {
  const queue = loadOfflineQueue();
  if (queue.length === 0) return { syncedCount: 0, remaining: [], quotaExceeded: false };

  let syncedCount = 0;
  let quotaExceeded = false;
  const remaining: OfflinePendingAction[] = [];

  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    try {
      if (item.kind === 'borrow') {
        const faceEnrollment =
          item.payload.facePhotoUrl && item.payload.faceDescriptor && item.payload.descriptorHash
            ? {
                facePhotoUrl: item.payload.facePhotoUrl,
                faceDescriptor: item.payload.faceDescriptor,
                descriptorHash: item.payload.descriptorHash,
              }
            : undefined;
        await borrowBookAtomic({
          bookId: item.payload.bookId,
          bookNumber: item.payload.bookNumber,
          extraBookNumber: item.payload.extraBookNumber,
          firstName: item.payload.firstName,
          lastName: item.payload.lastName,
          group: item.payload.group,
          course: item.payload.course,
          borrowedAtIso: item.payload.borrowedAtIso,
          dueDateIso: item.payload.dueDateIso || new Date(Date.now() + 14 * 86400000).toISOString(),
          signatureDataUrl: item.payload.signatureDataUrl,
          faceEnrollment,
        });
      } else if (item.kind === 'new-book-borrow') {
        const faceEnrollment =
          item.payload.facePhotoUrl && item.payload.faceDescriptor && item.payload.descriptorHash
            ? {
                facePhotoUrl: item.payload.facePhotoUrl,
                faceDescriptor: item.payload.faceDescriptor,
                descriptorHash: item.payload.descriptorHash,
              }
            : undefined;
        await borrowNewUnlistedBookAtomic({
          title: item.payload.bookTitle,
          bookNumber: item.payload.bookNumber,
          extraBookNumber: item.payload.extraBookNumber,
          author: item.payload.author,
          category: item.payload.category,
          quantity: item.payload.quantity,
          coverUrl: item.payload.coverUrl || '',
          firstName: item.payload.firstName,
          lastName: item.payload.lastName,
          group: item.payload.group,
          course: item.payload.course,
          borrowedAtIso: item.payload.borrowedAtIso,
          dueDateIso: item.payload.dueDateIso || new Date(Date.now() + 14 * 86400000).toISOString(),
          signatureDataUrl: item.payload.signatureDataUrl,
          faceEnrollment,
        });
      } else {
        await returnBookAtomic({
          bookId: item.payload.bookId,
          bookNumber: item.payload.bookNumber,
          extraBookNumber: item.payload.extraBookNumber,
          bookTitle: item.payload.bookTitle,
          firstName: item.payload.firstName,
          lastName: item.payload.lastName,
          group: item.payload.group,
          course: item.payload.course,
          returnedAtIso: item.payload.returnedAtIso,
          signatureDataUrl: item.payload.signatureDataUrl,
          liveFaceDescriptor: item.payload.liveFaceDescriptor,
          adminOverride: item.payload.adminOverride,
        });
      }
      syncedCount++;
    } catch (err) {
      if (isQuotaExceededError(err)) {
        quotaExceeded = true;
        remaining.push(...queue.slice(i));
        break;
      }
      const msg = err instanceof Error ? err.message : String(err);
      remaining.push({ ...item, lastError: msg });
    }
  }

  saveOfflineQueue(remaining);
  return { syncedCount, remaining, quotaExceeded };
}

// Admin Authentication & Settings
async function fetchLatestAdminCredential(): Promise<AdminCredential> {
  if (!navigator.onLine && adminCredCache) {
    return adminCredCache;
  }

  try {
    const snap = await getDoc(doc(db, 'admins', 'primary'));
    const data = snap.exists() ? (snap.data() as AdminCredential) : null;
    if (!data || data.algorithm !== 'PBKDF2-SHA256-SHARED') {
      await ensureSeededDatabase();
      const seededSnap = await getDoc(doc(db, 'admins', 'primary'));
      if (!seededSnap.exists()) {
        throw new Error('Administrator ma’lumotlari topilmadi.');
      }
      const seeded = seededSnap.data() as AdminCredential;
      adminCredCache = seeded;
      writeCachedCredential(ADMIN_CRED_CACHE_KEY, seeded);
      return seeded;
    }
    adminCredCache = data;
    writeCachedCredential(ADMIN_CRED_CACHE_KEY, data);
    return data;
  } catch (err) {
    if (adminCredCache) return adminCredCache;
    throw err;
  }
}

export async function verifyAdminPassword(password: string): Promise<{
  valid: boolean;
  mustChangePassword: boolean;
}> {
  const cred = await fetchLatestAdminCredential();
  let valid = await verifyPassword(password, cred.salt, cred.passwordHash, cred.iterations);
  if (!valid && password !== password.trim()) {
    valid = await verifyPassword(password.trim(), cred.salt, cred.passwordHash, cred.iterations);
  }
  if (valid) {
    logAdminActivityNonBlocking({
      action: 'Admin tizimga kirdi',
      targetType: 'admin',
      targetId: 'primary',
      targetLabel: 'Admin panel',
      details: 'Administrator parol orqali tizimga muvaffaqiyatli kirdi.',
    });
  }
  return { valid, mustChangePassword: cred.mustChangePassword };
}

export async function changeAdminPassword(
  currentPassword: string,
  newPassword: string
): Promise<void> {
  const trimmedNew = newPassword.trim();
  const trimmedCurrent = currentPassword.trim();
  if (trimmedNew.length < 4) {
    throw new Error('Yangi parol kamida 4 ta belgidan iborat bo‘lishi kerak.');
  }
  if (trimmedNew === trimmedCurrent) {
    throw new Error('Yangi parol eski paroldan farq qilishi kerak.');
  }

  const cred = await fetchLatestAdminCredential();
  let valid = await verifyPassword(currentPassword, cred.salt, cred.passwordHash, cred.iterations);
  if (!valid && currentPassword !== trimmedCurrent) {
    valid = await verifyPassword(trimmedCurrent, cred.salt, cred.passwordHash, cred.iterations);
  }
  if (!valid) {
    throw new Error('Eski parol noto‘g‘ri kiritildi.');
  }

  const salt = generateSalt();
  const iterations = 100000;
  const passwordHash = await hashPassword(trimmedNew, salt, iterations);
  const updatedAt = new Date().toISOString();

  await updateDoc(doc(db, 'admins', 'primary'), {
    passwordHash,
    salt,
    algorithm: 'PBKDF2-SHA256-SHARED',
    iterations,
    mustChangePassword: false,
    updatedAt,
  });

  adminCredCache = {
    ...cred,
    passwordHash,
    salt,
    algorithm: 'PBKDF2-SHA256-SHARED',
    iterations,
    mustChangePassword: false,
    updatedAt,
  };
  writeCachedCredential(ADMIN_CRED_CACHE_KEY, adminCredCache);

  logAdminActivityNonBlocking({
    action: 'Admin paroli o‘zgartirildi',
    targetType: 'admin',
    targetId: 'primary',
    targetLabel: 'Xavfsizlik',
    details: 'Administrator kirish paroli yangi PBKDF2-SHA256 xesh bilan yangilandi.',
  });
}

// App-Entry Gate Password ('kutubxona' by default)
export async function verifyAppGatePassword(password: string): Promise<boolean> {
  const trimmed = password.trim();
  if (!trimmed) return false;
  try {
    const cred = await ensureAppGateCredential(navigator.onLine);
    return verifyPassword(trimmed, cred.salt, cred.passwordHash, cred.iterations);
  } catch {
    if (appGateCredCache) {
      return verifyPassword(
        trimmed,
        appGateCredCache.salt,
        appGateCredCache.passwordHash,
        appGateCredCache.iterations
      );
    }
    if (!offlineAppGateHashPromise) {
      offlineAppGateHashPromise = hashPassword(
        'kutubxona',
        OFFLINE_APP_GATE_SALT,
        OFFLINE_APP_GATE_ITERATIONS
      );
    }
    const expectedOfflineHash = await offlineAppGateHashPromise;
    return verifyPassword(
      trimmed,
      OFFLINE_APP_GATE_SALT,
      expectedOfflineHash,
      OFFLINE_APP_GATE_ITERATIONS
    );
  }
}

export async function changeAppGatePassword(
  currentPassword: string,
  newPassword: string
): Promise<void> {
  const trimmedNew = newPassword.trim();
  const trimmedCurrent = currentPassword.trim();
  if (trimmedNew.length < 4) {
    throw new Error('Yangi kirish paroli kamida 4 ta belgidan iborat bo‘lishi kerak.');
  }
  if (trimmedNew === trimmedCurrent) {
    throw new Error('Yangi parol eski paroldan farq qilishi kerak.');
  }
  const cred = await ensureAppGateCredential(true);
  const valid = await verifyPassword(
    trimmedCurrent,
    cred.salt,
    cred.passwordHash,
    cred.iterations
  );
  if (!valid) {
    throw new Error('Eski ilova kirish paroli noto‘g‘ri.');
  }

  const salt = generateSalt();
  const iterations = 100000;
  const passwordHash = await hashPassword(trimmedNew, salt, iterations);
  const updatedAt = new Date().toISOString();

  await updateDoc(doc(db, 'admins', 'app_gate'), {
    passwordHash,
    salt,
    algorithm: 'PBKDF2-SHA256-APPGATE',
    iterations,
    mustChangePassword: false,
    updatedAt,
  });

  appGateCredCache = {
    ...cred,
    passwordHash,
    salt,
    algorithm: 'PBKDF2-SHA256-APPGATE',
    iterations,
    mustChangePassword: false,
    updatedAt,
  };
  writeCachedCredential(APP_GATE_CRED_CACHE_KEY, appGateCredCache);

  logAdminActivityNonBlocking({
    action: 'Ilovaga kirish paroli o‘zgartirildi',
    targetType: 'admin',
    targetId: 'app_gate',
    targetLabel: 'Umumiy kirish paroli',
    details: 'Ilovaga kirish paroli yangi PBKDF2-SHA256 xesh bilan yangilandi.',
  });
}

// Admin Book CRUD
export async function createBookAdmin(params: {
  bookNumber: string;
  title: string;
  author: string;
  category: string;
  description: string;
  coverUrl: string;
  quantity: number;
  existingBooks?: Book[];
}): Promise<string> {
  const bookNumber = params.bookNumber.trim();
  const title = params.title.trim();
  if (!bookNumber || !/^[a-zA-Z0-9_-]+$/.test(bookNumber)) {
    throw new Error('Kitob inventar raqami faqat harf, raqam, tire (-) yoki pastki chiziq (_) dan iborat bo‘lishi kerak.');
  }
  if (!title) {
    throw new Error('Kitob nomi kiritilishi shart.');
  }

  let duplicate = false;
  if (params.existingBooks) {
    duplicate = params.existingBooks.some(
      (b) => !b.isDeleted && b.bookNumber.toLowerCase() === bookNumber.toLowerCase()
    );
  }
  if (!duplicate) {
    const dupSnap = await getDocs(
      query(collection(db, 'books'), where('bookNumber', '==', bookNumber))
    );
    dupSnap.forEach((d) => {
      const b = d.data() as Omit<Book, 'id'>;
      if (!b.isDeleted) duplicate = true;
    });
  }
  if (duplicate) {
    throw new Error(`«${bookNumber}» inventar raqamli kitob allaqachon mavjud. Har bir kitob raqami takrorlanmas bo‘lishi shart.`);
  }

  const now = new Date().toISOString();
  const bookId = makeSafeDocId('book');
  const qty = Math.max(1, Number(params.quantity) || 1);
  const effectiveCoverUrl = (params.coverUrl || '').trim() || DEFAULT_BOOK_COVER_URL;
  const newBook = sanitizeBookForFirestore({
    bookNumber,
    title,
    author: params.author.trim(),
    category: params.category.trim() || 'Umumiy',
    description: params.description.trim(),
    coverUrl: effectiveCoverUrl,
    quantity: qty,
    availableQuantity: qty,
    status: 'mavjud',
    isActive: true,
    isDeleted: false,
    borrowCount: 0,
    createdAt: now,
    updatedAt: now,
  });

  await setDoc(doc(db, 'books', bookId), newBook);
  logAdminActivityNonBlocking({
    action: 'Yangi kitob qo‘shildi',
    targetType: 'book',
    targetId: bookId,
    targetLabel: `${bookNumber} · ${title}`,
    details: `Muallif: ${newBook.author || 'Ko‘rsatilmagan'}, Soni: ${newBook.quantity}`,
  });
  return bookId;
}

export async function importBooksBatchAdmin(params: {
  rows: ParsedExcelBookRow[];
  existingBooks: Book[];
  duplicateStrategy: 'auto-number' | 'skip';
  onProgress?: (done: number, total: number) => void;
}): Promise<{
  importedCount: number;
  skippedCount: number;
  totalCopies: number;
}> {
  const usedNumbers = new Set<string>();
  let maxNum = 0;

  for (const b of params.existingBooks) {
    if (b.isDeleted) continue;
    const numLower = (b.bookNumber || '').trim().toLowerCase();
    if (numLower) usedNumbers.add(numLower);
    const parsed = parseInt((b.bookNumber || '').replace(/\D/g, ''), 10);
    if (!Number.isNaN(parsed) && parsed > maxNum) maxNum = parsed;
  }

  const nextFreeNumber = (): string => {
    let candidate = '';
    do {
      maxNum += 1;
      candidate = String(maxNum).padStart(3, '0');
    } while (usedNumbers.has(candidate.toLowerCase()));
    usedNumbers.add(candidate.toLowerCase());
    return candidate;
  };

  const toInsert: Array<{ id: string; data: Omit<Book, 'id'> }> = [];
  let skippedCount = 0;
  let totalCopies = 0;
  const now = new Date().toISOString();
  const stamp = Date.now();

  params.rows.forEach((row, idx) => {
    const title = (row.title || '').trim().slice(0, 200);
    if (!title) {
      skippedCount += 1;
      return;
    }

    let finalBookNumber = (row.bookNumber || '')
      .trim()
      .replace(/[\s./\\]+/g, '-')
      .replace(/[^a-zA-Z0-9_-]/g, '')
      .slice(0, 32);

    const isTaken = finalBookNumber
      ? usedNumbers.has(finalBookNumber.toLowerCase())
      : false;

    if (!finalBookNumber) {
      finalBookNumber = nextFreeNumber();
    } else if (isTaken) {
      if (params.duplicateStrategy === 'skip') {
        skippedCount += 1;
        return;
      }
      finalBookNumber = nextFreeNumber();
    } else {
      usedNumbers.add(finalBookNumber.toLowerCase());
      const parsed = parseInt(finalBookNumber.replace(/\D/g, ''), 10);
      if (!Number.isNaN(parsed) && parsed > maxNum) maxNum = parsed;
    }

    const qty = Math.max(1, Math.min(1000, Math.round(Number(row.quantity) || 1)));
    totalCopies += qty;
    const rand = Math.random().toString(36).slice(2, 6);
    const bookId = `book_${stamp}_${idx}_${rand}`;

    toInsert.push({
      id: bookId,
      data: {
        bookNumber: finalBookNumber,
        title,
        author: (row.author || '').trim().slice(0, 160),
        category: (row.category || '').trim().slice(0, 80) || 'Umumiy',
        description: (row.description || '').trim().slice(0, 1000),
        coverUrl: DEFAULT_BOOK_COVER_URL,
        quantity: qty,
        availableQuantity: qty,
        status: 'mavjud',
        isActive: true,
        isDeleted: false,
        borrowCount: 0,
        createdAt: now,
        updatedAt: now,
      },
    });
  });

  if (toInsert.length === 0) {
    return { importedCount: 0, skippedCount, totalCopies: 0 };
  }

  const CHUNK_SIZE = 250;
  const baseMs = Date.now();
  let done = 0;
  for (let i = 0; i < toInsert.length; i += CHUNK_SIZE) {
    const chunkIdx = Math.floor(i / CHUNK_SIZE);
    const chunkUpdatedAt = new Date(baseMs + chunkIdx).toISOString();
    const slice = toInsert.slice(i, i + CHUNK_SIZE);

    const commitChunk = async () => {
      const batch = writeBatch(db);
      for (const item of slice) {
        batch.set(doc(db, 'books', item.id), {
          ...item.data,
          updatedAt: chunkUpdatedAt,
        });
      }
      await batch.commit();
    };

    try {
      await commitChunk();
    } catch {
      await new Promise((r) => setTimeout(r, 400));
      await commitChunk();
    }

    done += slice.length;
    params.onProgress?.(done, toInsert.length);
    if (done < toInsert.length) {
      await new Promise((r) => setTimeout(r, 30));
    }
  }

  logAdminActivityNonBlocking({
    action: 'Excel orqali kitoblar import qilindi',
    targetType: 'book',
    targetId: 'excel-import',
    targetLabel: `${toInsert.length} ta kitob`,
    details: `Excel fayldan ${toInsert.length} ta kitob (jami ${totalCopies} dona nusxa) qo‘shildi, ${skippedCount} ta o‘tkazib yuborildi.`,
  });

  return {
    importedCount: toInsert.length,
    skippedCount,
    totalCopies,
  };
}

export async function updateBookAdmin(
  bookId: string,
  updates: {
    bookNumber: string;
    title: string;
    author: string;
    category: string;
    description: string;
    coverUrl?: string;
    quantity: number;
    existingBooks?: Book[];
  }
): Promise<void> {
  const bookNumber = updates.bookNumber.trim();
  const title = updates.title.trim();
  if (!bookNumber || !/^[a-zA-Z0-9_-]+$/.test(bookNumber)) {
    throw new Error('Kitob inventar raqami noto‘g‘ri formatda.');
  }
  if (!title) {
    throw new Error('Kitob nomi bo‘sh bo‘lishi mumkin emas.');
  }

  let duplicate = false;
  let currentBook: Omit<Book, 'id'> | null = null;

  if (updates.existingBooks) {
    for (const b of updates.existingBooks) {
      if (b.id === bookId) currentBook = b;
      if (b.id !== bookId && !b.isDeleted && b.bookNumber.toLowerCase() === bookNumber.toLowerCase()) {
        duplicate = true;
      }
    }
  }

  if (!currentBook || !duplicate) {
    const [targetSnap, dupSnap] = await Promise.all([
      currentBook ? Promise.resolve(null) : getDoc(doc(db, 'books', bookId)),
      getDocs(query(collection(db, 'books'), where('bookNumber', '==', bookNumber))),
    ]);
    if (targetSnap && targetSnap.exists()) {
      currentBook = targetSnap.data() as Omit<Book, 'id'>;
    }
    dupSnap.forEach((d) => {
      const b = d.data() as Omit<Book, 'id'>;
      if (d.id !== bookId && !b.isDeleted) duplicate = true;
    });
  }

  if (duplicate) {
    throw new Error(`«${bookNumber}» inventar raqami boshqa kitobga biriktirilgan.`);
  }

  const newQty = Math.max(1, Number(updates.quantity) || 1);
  let nextAvailable = newQty;
  let nextStatus: Book['status'] = 'mavjud';

  if (currentBook) {
    const cBook = currentBook as Omit<Book, 'id'>;
    const oldAvail = getBookAvailableCount(cBook);
    const oldQty = Math.max(1, cBook.quantity || 1);
    const activeBorrowedCopies = Math.max(0, oldQty - oldAvail);
    if (newQty < activeBorrowedCopies) {
      throw new Error(
        `Hozirda ${activeBorrowedCopies} ta nusxa o‘quvchilarda. Umumiy sonni bundan kam qilib bo‘lmaydi.`
      );
    }
    nextAvailable = newQty - activeBorrowedCopies;
    nextStatus = !cBook.isActive ? 'faol_emas' : nextAvailable <= 0 ? 'olingan' : 'mavjud';
  }

  const patch: Record<string, unknown> = {
    bookNumber,
    title,
    author: updates.author.trim(),
    category: updates.category.trim() || 'Umumiy',
    description: updates.description.trim(),
    quantity: newQty,
    availableQuantity: nextAvailable,
    status: nextStatus,
    updatedAt: new Date().toISOString(),
  };
  if (updates.coverUrl !== undefined) {
    patch.coverUrl = updates.coverUrl;
  }

  const fallbackBaseBook: Omit<Book, 'id'> = currentBook ||
    (await getBundledBookById(bookId)) || {
      bookNumber,
      title,
      author: updates.author.trim(),
      category: updates.category.trim() || 'Umumiy',
      description: updates.description.trim(),
      coverUrl: updates.coverUrl ?? DEFAULT_BOOK_COVER_URL,
      quantity: newQty,
      availableQuantity: nextAvailable,
      status: nextStatus,
      isActive: true,
      isDeleted: false,
      borrowCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

  await upsertBookDoc(bookId, fallbackBaseBook, patch);
  logAdminActivityNonBlocking({
    action: 'Kitob tahrirlandi',
    targetType: 'book',
    targetId: bookId,
    targetLabel: `${bookNumber} · ${title}`,
    details: `Soni: ${newQty}, Mavjud: ${nextAvailable}`,
  });
}

export async function toggleBookActiveAdmin(book: Book): Promise<void> {
  const avail = getBookAvailableCount(book);
  const borrowedCount = Math.max(0, (book.quantity || 1) - avail);
  if (borrowedCount > 0 && book.isActive) {
    throw new Error('O‘quvchida turgan kitobni faolsizlantirishdan oldin uni qaytarib olish kerak.');
  }
  const nextActive = !book.isActive;
  const nextStatus = nextActive ? (avail > 0 ? 'mavjud' : 'olingan') : 'faol_emas';

  await upsertBookDoc(book.id, book, {
    isActive: nextActive,
    status: nextStatus,
    updatedAt: new Date().toISOString(),
  });

  logAdminActivityNonBlocking({
    action: nextActive ? 'Kitob faollashtirildi' : 'Kitob vaqtincha faolsizlantirildi',
    targetType: 'book',
    targetId: book.id,
    targetLabel: `${book.bookNumber} · ${book.title}`,
    details: `Yangi holat: ${nextStatus}`,
  });
}

export async function softDeleteBookAdmin(book: Book): Promise<void> {
  await upsertBookDoc(book.id, book, {
    isDeleted: true,
    isActive: false,
    status: 'faol_emas',
    updatedAt: new Date().toISOString(),
  });
  logAdminActivityNonBlocking({
    action: 'Kitob o‘chirildi (tarix saqlandi)',
    targetType: 'book',
    targetId: book.id,
    targetLabel: `${book.bookNumber} · ${book.title}`,
    details: 'Kitob katalogdan o‘chirildi, tarixiy yozuvlar saqlab qolindi.',
  });
}

export async function restoreBookAdmin(book: Book): Promise<void> {
  const avail = getBookAvailableCount(book);
  const totalQty = Math.max(1, book.quantity || 1);
  const nextAvail = Math.min(totalQty, avail);
  const nextStatus: Book['status'] = nextAvail > 0 ? 'mavjud' : 'olingan';

  await upsertBookDoc(book.id, book, {
    isDeleted: false,
    isActive: true,
    availableQuantity: nextAvail,
    status: nextStatus,
    updatedAt: new Date().toISOString(),
  });
  logAdminActivityNonBlocking({
    action: 'O‘chirilgan kitob tiklandi',
    targetType: 'book',
    targetId: book.id,
    targetLabel: `${book.bookNumber} · ${book.title}`,
    details: 'Kitob ma’lumotlar bazasidan qayta faol katalogga tiklandi.',
  });
}

// Delete a single transaction manually from Admin Panel
export async function deleteSingleTransactionAdmin(targetTx: TransactionRecord): Promise<void> {
  const now = new Date().toISOString();

  // Pre-query other active borrows for the same book if this was an active borrow
  let otherActives: TransactionRecord[] = [];
  if (targetTx.type === 'borrow' && targetTx.status === 'active') {
    const activeSnap = await getDocs(
      query(
        collection(db, 'transactions'),
        where('bookId', '==', targetTx.bookId),
        where('status', '==', 'active')
      )
    );
    activeSnap.forEach((d) => {
      if (d.id !== targetTx.id) {
        const data = d.data() as Omit<TransactionRecord, 'id'>;
        if (data.type === 'borrow') {
          otherActives.push({ id: d.id, ...data });
        }
      }
    });
  }

  const txRef = doc(db, 'transactions', targetTx.id);
  const bookRef = doc(db, 'books', targetTx.bookId);
  const studentRef = doc(db, 'students', targetTx.studentId);

  await runTransaction(db, async (tx) => {
    const [txSnap, bookSnap, studentSnap] = await Promise.all([
      tx.get(txRef),
      tx.get(bookRef),
      tx.get(studentRef),
    ]);

    if (!txSnap.exists()) return;
    const txData = txSnap.data() as Omit<TransactionRecord, 'id'>;

    tx.delete(txRef);

    if (bookSnap.exists() && txData.type === 'borrow') {
      const book = bookSnap.data() as Omit<Book, 'id'>;
      const totalQty = Math.max(1, book.quantity || 1);
      const currentAvail = getBookAvailableCount(book);
      const nextBorrowCount = Math.max(0, (book.borrowCount || 1) - 1);

      if (txData.status === 'active') {
        const nextAvail = Math.min(totalQty, currentAvail + 1);
        const nextHolder = otherActives[0];
        tx.update(bookRef, {
          availableQuantity: nextAvail,
          status: book.isActive ? (nextAvail > 0 ? 'mavjud' : 'olingan') : 'faol_emas',
          borrowCount: nextBorrowCount,
          currentTransactionId: nextHolder?.id || '',
          currentBorrowerName: nextHolder?.studentFullName || '',
          currentBorrowerGroup: nextHolder?.studentGroup || '',
          currentBorrowerCourse: nextHolder?.studentCourse || '',
          currentBorrowedAt: nextHolder?.borrowedAt || '',
          currentDueDate: nextHolder?.dueDate || '',
          updatedAt: now,
        });
      } else {
        tx.update(bookRef, {
          borrowCount: nextBorrowCount,
          updatedAt: now,
        });
      }
    }

    if (studentSnap.exists()) {
      const st = studentSnap.data() as Omit<Student, 'id'>;
      let nextBorrowed = st.totalBorrowed || 0;
      let nextReturned = st.totalReturned || 0;
      let nextActive = st.activeCount || 0;

      if (txData.type === 'borrow') {
        nextBorrowed = Math.max(0, nextBorrowed - 1);
        if (txData.status === 'active') {
          nextActive = Math.max(0, nextActive - 1);
        }
      } else {
        nextReturned = Math.max(0, nextReturned - 1);
      }

      if (nextBorrowed <= 0 && nextReturned <= 0 && nextActive <= 0) {
        tx.delete(studentRef);
      } else {
        tx.update(studentRef, {
          totalBorrowed: nextBorrowed,
          totalReturned: nextReturned,
          activeCount: nextActive,
          updatedAt: now,
        });
      }
    }
  });

  logAdminActivityNonBlocking({
    action: 'Operatsiya yozuvi qo‘lda o‘chirildi',
    targetType: 'transaction',
    targetId: targetTx.id,
    targetLabel: `${targetTx.studentFullName} · № ${targetTx.bookNumber}`,
    details: `${targetTx.type === 'borrow' ? 'Olish' : 'Topshirish'} yozuvi («${targetTx.bookTitle}») o‘chirildi.`,
  });
}

// Clear ALL borrow/return transactions & student records (keeps catalog books intact & unlocks them)
export async function clearAllTransactionsAdmin(): Promise<{
  deletedTransactions: number;
  deletedStudents: number;
  resetBooks: number;
}> {
  const [txSnap, studentsSnap, booksSnap] = await Promise.all([
    getDocs(collection(db, 'transactions')),
    getDocs(collection(db, 'students')),
    getDocs(collection(db, 'books')),
  ]);

  const now = new Date().toISOString();
  const commitPromises: Promise<void>[] = [];
  let batch = writeBatch(db);
  let opCount = 0;

  const queueOp = (fn: () => void) => {
    fn();
    opCount += 1;
    if (opCount >= 400) {
      commitPromises.push(batch.commit());
      batch = writeBatch(db);
      opCount = 0;
    }
  };

  for (const d of txSnap.docs) {
    queueOp(() => {
      batch.delete(d.ref);
    });
  }

  for (const d of studentsSnap.docs) {
    queueOp(() => {
      batch.delete(d.ref);
    });
  }

  let resetBooks = 0;
  for (const d of booksSnap.docs) {
    const book = d.data() as Omit<Book, 'id'>;
    if (!book.isDeleted) {
      const fullQty = Math.max(1, book.quantity || 1);
      resetBooks += 1;
      queueOp(() => {
        batch.update(d.ref, {
          availableQuantity: fullQty,
          status: book.isActive ? 'mavjud' : 'faol_emas',
          borrowCount: 0,
          currentTransactionId: '',
          currentBorrowerName: '',
          currentBorrowerGroup: '',
          currentBorrowerCourse: '',
          currentBorrowedAt: '',
          currentDueDate: '',
          updatedAt: now,
        });
      });
    }
  }

  if (opCount > 0) {
    commitPromises.push(batch.commit());
  }

  await Promise.all(commitPromises);

  logAdminActivityNonBlocking({
    action: 'Barcha olish-topshirish yozuvlari tozalandi (Clear All)',
    targetType: 'transactions',
    targetId: 'all',
    targetLabel: 'Clear All',
    details: `O‘chirildi: ${txSnap.size} ta operatsiya, ${studentsSnap.size} ta o‘quvchi yozuvi. ${resetBooks} ta kitob qayta mavjud holatga tiklandi.`,
  });

  return {
    deletedTransactions: txSnap.size,
    deletedStudents: studentsSnap.size,
    resetBooks,
  };
}

export async function updateLibrarySettingsAdmin(params: {
  institutionName: string;
  libraryName: string;
  defaultLoanDays: number;
}): Promise<void> {
  await updateDoc(doc(db, 'settings', 'library'), {
    institutionName: params.institutionName.trim(),
    libraryName: params.libraryName.trim(),
    defaultLoanDays: Math.min(365, Math.max(1, Number(params.defaultLoanDays) || 14)),
    updatedAt: new Date().toISOString(),
  });
  logAdminActivityNonBlocking({
    action: 'Kutubxona sozlamalari yangilandi',
    targetType: 'settings',
    targetId: 'library',
    targetLabel: params.libraryName,
    details: `Standart muddat: ${params.defaultLoanDays} kun`,
  });
}

export async function createFullBackupPayload(): Promise<Record<string, unknown>> {
  const [bundledMap, booksSnap, studentsSnap, txSnap, sigSnap, logsSnap, settingsSnap] =
    await Promise.all([
      loadBundledCatalog(),
      getDocs(collection(db, 'books')),
      getDocs(collection(db, 'students')),
      getDocs(collection(db, 'transactions')),
      getDocs(collection(db, 'signatures')),
      getDocs(collection(db, 'activityLogs')),
      getDoc(doc(db, 'settings', 'library')),
    ]);

  const mergedBooks = new Map<string, Book>();
  for (const [id, b] of bundledMap) {
    mergedBooks.set(id, b);
  }
  booksSnap.forEach((d) => {
    const normalized = normalizeBookDoc(d.id, d.data() as Record<string, unknown>);
    if (isAllowedFirestoreBook(d.id, normalized, bundledMap)) {
      mergedBooks.set(d.id, normalized);
    }
  });
  const allBackupBooks = Array.from(mergedBooks.values());

  const now = new Date().toISOString();
  await updateDoc(doc(db, 'settings', 'library'), {
    lastBackupAt: now,
    updatedAt: now,
  });

  await logAdminActivity({
    action: 'Zaxira nusxa olindi',
    targetType: 'backup',
    targetId: 'full',
    targetLabel: 'JSON zaxira fayli',
    details: `Kitoblar: ${allBackupBooks.length}, Operatsiyalar: ${txSnap.size}, Imzolar: ${sigSnap.size}`,
  });

  return {
    exportedAt: now,
    version: '1.0',
    settings: settingsSnap.exists() ? settingsSnap.data() : null,
    books: allBackupBooks,
    students: studentsSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    transactions: txSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    signatures: sigSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    activityLogs: logsSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
  };
}

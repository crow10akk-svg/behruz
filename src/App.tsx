import { useCallback, useEffect, useState } from 'react';
import { AppLockScreen } from './components/AppLockScreen.tsx';
import { StudentKiosk } from './components/StudentKiosk.tsx';
import { AdminLoginModal } from './components/AdminLoginModal.tsx';
import { AdminPanel } from './components/AdminPanel.tsx';
import { QrMobileUploadPage } from './components/QrMobileUploadPage.tsx';
import { isQuotaExceededError, testFirestoreConnection } from './lib/firebase.ts';
import {
  ensureSeededDatabase,
  flushOfflineQueue,
  loadOfflineQueue,
  subscribeActivityLogs,
  subscribeBooks,
  subscribeLibrarySettings,
  subscribeSignatures,
  subscribeStudents,
  subscribeTransactions,
} from './lib/libraryService.ts';
import type {
  ActivityLogRecord,
  Book,
  LibrarySetting,
  OfflinePendingAction,
  SignatureRecord,
  Student,
  TransactionRecord,
} from './types.ts';

const BOOKS_CACHE_KEY = 'smart_kutubxona_books_cache_v1';
const SETTINGS_CACHE_KEY = 'smart_kutubxona_settings_cache_v1';
const STUDENTS_CACHE_KEY = 'smart_kutubxona_students_cache_v1';
const TX_CACHE_KEY = 'smart_kutubxona_tx_cache_v1';
const SEEDED_FLAG_KEY = 'smart_kutubxona_seeded_v2';
const APP_UNLOCKED_SESSION_KEY = 'smart_kutubxona_app_unlocked_v1';

const DEFAULT_SETTINGS: LibrarySetting = {
  institutionName: 'IIV Andijon akademik litseyi',
  libraryName: 'Smart Kutubxona',
  defaultLoanDays: 14,
  updatedAt: new Date().toISOString(),
};

function loadCachedArray<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function loadCachedBooks(): Book[] {
  return loadCachedArray<Book>(BOOKS_CACHE_KEY);
}

function loadCachedSettings(): LibrarySetting {
  try {
    const raw = localStorage.getItem(SETTINGS_CACHE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function getQrUploadSessionFromUrl(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const val = params.get('qrUpload');
    return val && /^[a-zA-Z0-9_-]+$/.test(val) ? val : null;
  } catch {
    return null;
  }
}

export default function App() {
  const qrSessionId = getQrUploadSessionFromUrl();
  if (qrSessionId) {
    return <QrMobileUploadPage sessionId={qrSessionId} />;
  }
  return <LibraryApp />;
}

function LibraryApp() {
  const [books, setBooks] = useState<Book[]>(() => loadCachedBooks());
  const [deletedBooks, setDeletedBooks] = useState<Book[]>([]);
  const [students, setStudents] = useState<Student[]>(() => loadCachedArray<Student>(STUDENTS_CACHE_KEY));
  const [transactions, setTransactions] = useState<TransactionRecord[]>(() =>
    loadCachedArray<TransactionRecord>(TX_CACHE_KEY)
  );
  const [isTxTruncated, setIsTxTruncated] = useState(false);
  const [signatures, setSignatures] = useState<Record<string, SignatureRecord>>({});
  const [activityLogs, setActivityLogs] = useState<ActivityLogRecord[]>([]);
  const [settings, setSettings] = useState<LibrarySetting>(() => loadCachedSettings());

  const [isLoadingBooks, setIsLoadingBooks] = useState(() => loadCachedBooks().length === 0);
  const [isQuotaExceeded, setIsQuotaExceeded] = useState(false);
  const [isOnline, setIsOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const [offlineQueue, setOfflineQueue] = useState<OfflinePendingAction[]>(() =>
    loadOfflineQueue()
  );

  const [isAppUnlocked, setIsAppUnlocked] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(APP_UNLOCKED_SESSION_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [isAdminAuthenticated, setIsAdminAuthenticated] = useState(false);
  const [isAdminLoginOpen, setIsAdminLoginOpen] = useState(false);

  const handleQuotaError = useCallback(() => {
    setIsQuotaExceeded(true);
    setIsLoadingBooks(false);
  }, []);

  const handleFlushOffline = useCallback(async () => {
    if (!navigator.onLine) return;
    const res = await flushOfflineQueue();
    setOfflineQueue(res.remaining);
    if (res.quotaExceeded) {
      handleQuotaError();
    }
  }, [handleQuotaError]);

  useEffect(() => {
    const onOnline = () => {
      setIsOnline(true);
      if (!isQuotaExceeded) {
        void handleFlushOffline();
      }
    };
    const onOffline = () => setIsOnline(false);

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [handleFlushOffline, isQuotaExceeded]);

  useEffect(() => {
    if (!isAppUnlocked || !isOnline || isQuotaExceeded || offlineQueue.length === 0) return;
    const intervalId = window.setInterval(() => {
      void handleFlushOffline();
    }, 25_000);
    return () => window.clearInterval(intervalId);
  }, [isAppUnlocked, isOnline, isQuotaExceeded, offlineQueue.length, handleFlushOffline]);

  // Fast public kiosk subscriptions (starts only after app entry password is verified)
  useEffect(() => {
    if (!isAppUnlocked) return;
    const initialCached = loadCachedBooks();
    if (initialCached.length > 0) {
      try {
        localStorage.setItem(SEEDED_FLAG_KEY, '1');
      } catch {
        // Ignore storage quota errors
      }
    }

    const handleErr = (err: Error) => {
      if (isQuotaExceededError(err)) {
        console.warn('Firestore daily read quota reached; running on cached/offline queue mode.');
        handleQuotaError();
        return;
      }
      console.error('Firestore subscription error:', err);
      setIsLoadingBooks(false);
    };

    let cacheTimer: ReturnType<typeof setTimeout> | null = null;

    const unsubBooks = subscribeBooks(
      (data) => {
        setBooks(data);
        setIsLoadingBooks(false);
        setIsQuotaExceeded(false);
        if (cacheTimer) clearTimeout(cacheTimer);
        cacheTimer = setTimeout(() => {
          try {
            if (data.length > 0) {
              localStorage.setItem(SEEDED_FLAG_KEY, '1');
            }
            if (data.length <= 5000) {
              localStorage.setItem(BOOKS_CACHE_KEY, JSON.stringify(data));
            } else {
              localStorage.removeItem(BOOKS_CACHE_KEY);
            }
          } catch {
            try {
              localStorage.removeItem(BOOKS_CACHE_KEY);
            } catch {
              // Ignore storage quota errors
            }
          }
        }, 0);
      },
      handleErr,
      initialCached,
      (deleted) => setDeletedBooks(deleted)
    );

    const unsubSettings = subscribeLibrarySettings((s) => {
      setSettings(s);
      try {
        localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify(s));
      } catch {
        // Ignore
      }
    }, handleErr);

    testFirestoreConnection().catch(() => {});

    // Non-blocking background initialization & offline sync
    if (!localStorage.getItem(SEEDED_FLAG_KEY) && initialCached.length === 0) {
      ensureSeededDatabase()
        .then(() => {
          localStorage.setItem(SEEDED_FLAG_KEY, '1');
        })
        .catch((err) => {
          if (isQuotaExceededError(err)) {
            handleQuotaError();
          } else {
            console.warn('Seed check skipped:', err);
          }
        });
    }
    void handleFlushOffline();

    return () => {
      if (cacheTimer) clearTimeout(cacheTimer);
      unsubBooks();
      unsubSettings();
    };
  }, [isAppUnlocked, handleFlushOffline, handleQuotaError]);

  // Admin-only subscriptions (loaded lazily only after admin login for speed)
  useEffect(() => {
    if (!isAppUnlocked || !isAdminAuthenticated) return;

    const handleErr = (err: Error) => {
      if (isQuotaExceededError(err)) {
        console.warn('Admin Firestore daily read quota reached; using cached records.');
        handleQuotaError();
        return;
      }
      console.warn('Admin Firestore subscription notice:', err);
    };

    let studentCacheTimer: ReturnType<typeof setTimeout> | null = null;
    let txCacheTimer: ReturnType<typeof setTimeout> | null = null;

    const unsubStudents = subscribeStudents((data) => {
      setStudents(data);
      if (studentCacheTimer) clearTimeout(studentCacheTimer);
      studentCacheTimer = setTimeout(() => {
        try {
          localStorage.setItem(STUDENTS_CACHE_KEY, JSON.stringify(data.slice(0, 600)));
        } catch {
          // Ignore
        }
      }, 250);
    }, handleErr);

    const unsubTx = subscribeTransactions((data, meta) => {
      setTransactions(data);
      setIsTxTruncated(Boolean(meta?.isTruncated));
      if (txCacheTimer) clearTimeout(txCacheTimer);
      txCacheTimer = setTimeout(() => {
        try {
          localStorage.setItem(TX_CACHE_KEY, JSON.stringify(data.slice(0, 500)));
        } catch {
          // Ignore
        }
      }, 250);
    }, handleErr);

    const unsubSig = subscribeSignatures(setSignatures, handleErr);
    const unsubLogs = subscribeActivityLogs(setActivityLogs, handleErr);

    return () => {
      if (studentCacheTimer) clearTimeout(studentCacheTimer);
      if (txCacheTimer) clearTimeout(txCacheTimer);
      unsubStudents();
      unsubTx();
      unsubSig();
      unsubLogs();
    };
  }, [isAppUnlocked, isAdminAuthenticated, handleQuotaError]);

  if (!isAppUnlocked) {
    return (
      <AppLockScreen
        institutionName={settings.institutionName}
        libraryName={settings.libraryName}
        onUnlocked={() => {
          try {
            sessionStorage.setItem(APP_UNLOCKED_SESSION_KEY, '1');
          } catch {
            // Ignore sessionStorage restrictions
          }
          setIsAppUnlocked(true);
        }}
      />
    );
  }

  if (isAdminAuthenticated) {
    return (
      <AdminPanel
        books={books}
        deletedBooks={deletedBooks}
        students={students}
        transactions={transactions}
        isTransactionsTruncated={isTxTruncated}
        signatures={signatures}
        activityLogs={activityLogs}
        settings={settings}
        onLogout={() => setIsAdminAuthenticated(false)}
      />
    );
  }

  return (
    <>

      <StudentKiosk
        books={books}
        isLoading={isLoadingBooks}
        settings={settings}
        isOnline={isOnline}
        offlineQueue={offlineQueue}
        onOfflineQueueChange={setOfflineQueue}
        onRetryOfflineQueue={handleFlushOffline}
        onOpenAdminLogin={() => setIsAdminLoginOpen(true)}
        onLockApp={() => {
          try {
            sessionStorage.removeItem(APP_UNLOCKED_SESSION_KEY);
          } catch {
            // Ignore
          }
          setIsAdminAuthenticated(false);
          setIsAppUnlocked(false);
        }}
      />

      <AdminLoginModal
        isOpen={isAdminLoginOpen}
        onClose={() => setIsAdminLoginOpen(false)}
        onAuthenticated={() => {
          setIsAdminLoginOpen(false);
          setIsAdminAuthenticated(true);
        }}
      />
    </>
  );
}

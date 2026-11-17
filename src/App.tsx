import { useCallback, useEffect, useState } from 'react';
import { AppLockScreen } from './components/AppLockScreen.tsx';
import { StudentKiosk } from './components/StudentKiosk.tsx';
import { AdminLoginModal } from './components/AdminLoginModal.tsx';
import { AdminPanel } from './components/AdminPanel.tsx';
import { QrMobileUploadPage } from './components/QrMobileUploadPage.tsx';
import { testFirestoreConnection } from './lib/firebase.ts';
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
const SEEDED_FLAG_KEY = 'smart_kutubxona_seeded_v2';
const APP_UNLOCKED_SESSION_KEY = 'smart_kutubxona_app_unlocked_v1';

const DEFAULT_SETTINGS: LibrarySetting = {
  institutionName: 'IIV Andijon akademik litseyi',
  libraryName: 'Smart Kutubxona',
  defaultLoanDays: 14,
  updatedAt: new Date().toISOString(),
};

function loadCachedBooks(): Book[] {
  try {
    const raw = localStorage.getItem(BOOKS_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
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
  const [students, setStudents] = useState<Student[]>([]);
  const [transactions, setTransactions] = useState<TransactionRecord[]>([]);
  const [signatures, setSignatures] = useState<Record<string, SignatureRecord>>({});
  const [activityLogs, setActivityLogs] = useState<ActivityLogRecord[]>([]);
  const [settings, setSettings] = useState<LibrarySetting>(() => loadCachedSettings());

  const [isLoadingBooks, setIsLoadingBooks] = useState(() => loadCachedBooks().length === 0);
  const [dbError, setDbError] = useState<string | null>(null);
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

  const handleFlushOffline = useCallback(async () => {
    if (!navigator.onLine) return;
    const res = await flushOfflineQueue();
    setOfflineQueue(res.remaining);
  }, []);

  useEffect(() => {
    const onOnline = () => {
      setIsOnline(true);
      handleFlushOffline();
    };
    const onOffline = () => setIsOnline(false);

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [handleFlushOffline]);

  useEffect(() => {
    if (!isAppUnlocked || !isOnline || offlineQueue.length === 0) return;
    const intervalId = window.setInterval(() => {
      void handleFlushOffline();
    }, 25_000);
    return () => window.clearInterval(intervalId);
  }, [isAppUnlocked, isOnline, offlineQueue.length, handleFlushOffline]);

  // Fast public kiosk subscriptions (starts only after app entry password is verified)
  useEffect(() => {
    if (!isAppUnlocked) return;
    const handleErr = (err: Error) => {
      console.error('Firestore subscription error:', err);
      setDbError('Ma’lumotlar bazasiga ulanishda xatolik yuz berdi. Internet aloqasini tekshiring.');
      setIsLoadingBooks(false);
    };

    let cacheTimer: ReturnType<typeof setTimeout> | null = null;

    const unsubBooks = subscribeBooks((data) => {
      setBooks(data);
      setIsLoadingBooks(false);
      setDbError(null);
      if (cacheTimer) clearTimeout(cacheTimer);
      cacheTimer = setTimeout(() => {
        try {
          localStorage.setItem(BOOKS_CACHE_KEY, JSON.stringify(data));
          if (data.length > 0) {
            localStorage.setItem(SEEDED_FLAG_KEY, '1');
          }
        } catch {
          // Ignore storage quota errors
        }
      }, 0);
    }, handleErr);

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
    if (!localStorage.getItem(SEEDED_FLAG_KEY)) {
      ensureSeededDatabase()
        .then(() => {
          localStorage.setItem(SEEDED_FLAG_KEY, '1');
        })
        .catch((err) => console.error('Seed check failed:', err));
    }
    handleFlushOffline();

    return () => {
      if (cacheTimer) clearTimeout(cacheTimer);
      unsubBooks();
      unsubSettings();
    };
  }, [isAppUnlocked, handleFlushOffline]);

  // Admin-only subscriptions (loaded lazily only after admin login for speed)
  useEffect(() => {
    if (!isAppUnlocked || !isAdminAuthenticated) return;

    const handleErr = (err: Error) => {
      console.error('Admin Firestore subscription error:', err);
    };

    const unsubStudents = subscribeStudents(setStudents, handleErr);
    const unsubTx = subscribeTransactions(setTransactions, handleErr);
    const unsubSig = subscribeSignatures(setSignatures, handleErr);
    const unsubLogs = subscribeActivityLogs(setActivityLogs, handleErr);

    return () => {
      unsubStudents();
      unsubTx();
      unsubSig();
      unsubLogs();
    };
  }, [isAppUnlocked, isAdminAuthenticated]);

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
        students={students}
        transactions={transactions}
        signatures={signatures}
        activityLogs={activityLogs}
        settings={settings}
        onLogout={() => setIsAdminAuthenticated(false)}
      />
    );
  }

  return (
    <>
      {dbError && (
        <div className="bg-red-700 text-white text-xs text-center py-2 px-4">
          {dbError}
        </div>
      )}

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

import { initializeApp } from 'firebase/app';
import {
  doc,
  getDocFromServer,
  getFirestore,
  initializeFirestore,
  memoryLocalCache,
  type Firestore,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);

function createFirestoreInstance(): Firestore {
  try {
    return initializeFirestore(
      app,
      {
        localCache: memoryLocalCache(),
      },
      firebaseConfig.firestoreDatabaseId
    );
  } catch {
    return getFirestore(app, firebaseConfig.firestoreDatabaseId);
  }
}

export const db = createFirestoreInstance();

export function isQuotaExceededError(err: unknown): boolean {
  if (!err) return false;
  const code =
    typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code || '') : '';
  const msg = err instanceof Error ? err.message : String(err);
  const combined = `${code} ${msg}`.toLowerCase();
  return (
    combined.includes('resource-exhausted') ||
    combined.includes('quota limit exceeded') ||
    combined.includes('quota exceeded') ||
    combined.includes('free daily read units')
  );
}

const CONN_CHECKED_SESSION_KEY = 'smart_kutubxona_conn_checked_v1';

export async function testFirestoreConnection(): Promise<boolean> {
  try {
    if (typeof sessionStorage !== 'undefined' && sessionStorage.getItem(CONN_CHECKED_SESSION_KEY) === '1') {
      return true;
    }
    await getDocFromServer(doc(db, 'settings', 'library'));
    try {
      sessionStorage.setItem(CONN_CHECKED_SESSION_KEY, '1');
    } catch {
      // Ignore sessionStorage restrictions
    }
    return true;
  } catch (error) {
    if (isQuotaExceededError(error)) {
      return false;
    }
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.warn('Firestore offline:', error.message);
      return false;
    }
    return true;
  }
}

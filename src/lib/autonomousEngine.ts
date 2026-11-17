import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  updateDoc,
} from 'firebase/firestore';
import { db } from './firebase.ts';
import { getBookAvailableCount, logAdminActivityNonBlocking } from './libraryService.ts';
import { isOverdueDate, normalizeCompareText } from './imageUtils.ts';
import type { Book, OfflinePendingAction, Student, TransactionRecord } from '../types.ts';

/**
 * Pure local Uzbek-aware text normalization (apostrophe & typography invariant).
 * Runs 100% locally inside the browser — zero external AI or server dependencies.
 */
export function normalizeUzbekFuzzy(text: string): string {
  return normalizeCompareText(text)
    .replace(/['ʻʼ`ʹ′]/g, '')
    .replace(/[^a-z0-9.\-\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function boundedLevenshtein(a: string, b: string, maxDist = 2): number {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > maxDist) return maxDist + 1;
  if (la === 0) return lb;
  if (lb === 0) return la;

  let prev = new Array<number>(lb + 1);
  let curr = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      const v = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > maxDist) return maxDist + 1;
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[lb];
}

export function scoreFuzzyMatch(rawQuery: string, fields: string[]): number {
  const q = normalizeUzbekFuzzy(rawQuery);
  if (!q) return 1;

  const qTokens = q.split(' ').filter(Boolean);
  let bestScore = 0;

  for (const field of fields) {
    if (!field) continue;
    const f = normalizeUzbekFuzzy(field);
    if (!f) continue;

    if (f === q) return 100;
    if (f.startsWith(q)) {
      bestScore = Math.max(bestScore, 90);
      continue;
    }
    if (f.includes(q)) {
      bestScore = Math.max(bestScore, 80);
      continue;
    }

    const fWords = f.split(' ').filter(Boolean);
    let matchedTokens = 0;
    let tokenScoreSum = 0;

    for (const qt of qTokens) {
      let tokenBest = 0;
      for (const fw of fWords) {
        if (fw === qt) {
          tokenBest = 1;
          break;
        }
        if (fw.startsWith(qt) || fw.includes(qt)) {
          tokenBest = Math.max(tokenBest, 0.85);
        } else if (qt.length >= 4 && fw.length >= 4) {
          const allowed = qt.length >= 7 ? 2 : 1;
          const dist = boundedLevenshtein(qt, fw, allowed);
          if (dist <= allowed) {
            tokenBest = Math.max(tokenBest, dist === 1 ? 0.72 : 0.58);
          }
        }
      }
      if (tokenBest > 0) {
        matchedTokens += 1;
        tokenScoreSum += tokenBest;
      }
    }

    if (matchedTokens === qTokens.length && qTokens.length > 0) {
      bestScore = Math.max(bestScore, Math.round((tokenScoreSum / qTokens.length) * 70));
    }
  }

  return bestScore;
}

export function smartFilterBooks(books: Book[], queryStr: string): Book[] {
  const trimmed = queryStr.trim();
  if (!trimmed) return books;

  const scored: Array<{ book: Book; score: number }> = [];
  for (const b of books) {
    const score = scoreFuzzyMatch(trimmed, [
      b.bookNumber,
      b.title,
      b.author || '',
      b.category || '',
    ]);
    if (score > 0) {
      scored.push({ book: b, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.book);
}

export interface LibrarySmartInsight {
  overdueCount: number;
  depletedPopularBooks: Book[];
  topGroup: { group: string; count: number } | null;
  returnRatePct: number;
  summaryText: string;
}

export function computeLibraryInsights(
  books: Book[],
  transactions: TransactionRecord[],
  students: Student[]
): LibrarySmartInsight {
  const activeBorrows = transactions.filter(
    (t) => t.type === 'borrow' && t.status === 'active'
  );
  const overdueCount = activeBorrows.filter((t) => isOverdueDate(t.dueDate)).length;

  const depletedPopularBooks = books
    .filter((b) => b.isActive && getBookAvailableCount(b) <= 0)
    .sort((a, b) => (b.borrowCount || 0) - (a.borrowCount || 0))
    .slice(0, 4);

  const groupMap = new Map<string, number>();
  for (const st of students) {
    const g = st.group.trim();
    if (!g) continue;
    groupMap.set(g, (groupMap.get(g) || 0) + (st.totalBorrowed || 0));
  }
  let topGroup: { group: string; count: number } | null = null;
  for (const [group, count] of groupMap.entries()) {
    if (!topGroup || count > topGroup.count) {
      topGroup = { group, count };
    }
  }

  const totalBorrows = transactions.filter((t) => t.type === 'borrow').length;
  const returnedBorrows = transactions.filter(
    (t) => t.type === 'borrow' && t.status === 'returned'
  ).length;
  const returnRatePct =
    totalBorrows > 0 ? Math.round((returnedBorrows / totalBorrows) * 100) : 100;

  const summaryParts: string[] = [];
  if (overdueCount > 0) {
    summaryParts.push(`${overdueCount} ta muddati o‘tgan kitob nazoratda`);
  } else {
    summaryParts.push('Muddati o‘tgan kitoblar yo‘q');
  }
  if (depletedPopularBooks.length > 0) {
    summaryParts.push(`${depletedPopularBooks.length} ta kitob nusxasi tugagan`);
  }
  if (topGroup) {
    summaryParts.push(`Eng faol guruh: ${topGroup.group} (${topGroup.count} ta olish)`);
  }

  return {
    overdueCount,
    depletedPopularBooks,
    topGroup,
    returnRatePct,
    summaryText: summaryParts.join(' · '),
  };
}

let lastSelfHealAt = 0;

/**
 * Autonomous internal consistency guardian:
 * Detects & quietly repairs drifted book stock counts, lock statuses, or student active counts
 * using active transactions as source of truth — runs automatically with zero external services.
 */
export async function runSelfHealingAudit(params: {
  books: Book[];
  transactions: TransactionRecord[];
  students: Student[];
  offlineQueue: OfflinePendingAction[];
}): Promise<{ repairedBooks: number; repairedStudents: number }> {
  const nowMs = Date.now();
  if (!navigator.onLine || nowMs - lastSelfHealAt < 180_000) {
    return { repairedBooks: 0, repairedStudents: 0 };
  }
  // Do not alter stock if offline actions are still waiting to sync
  if (params.offlineQueue.length > 0) {
    return { repairedBooks: 0, repairedStudents: 0 };
  }
  lastSelfHealAt = nowMs;

  const activeBorrowsByBook = new Map<string, TransactionRecord[]>();
  const activeCountByStudent = new Map<string, number>();

  for (const tx of params.transactions) {
    if (tx.type === 'borrow' && tx.status === 'active') {
      const list = activeBorrowsByBook.get(tx.bookId) || [];
      list.push(tx);
      activeBorrowsByBook.set(tx.bookId, list);
      activeCountByStudent.set(tx.studentId, (activeCountByStudent.get(tx.studentId) || 0) + 1);
    }
  }

  const nowIso = new Date().toISOString();
  const tasks: Promise<void>[] = [];
  let repairedBooks = 0;
  let repairedStudents = 0;

  for (const book of params.books) {
    if (book.isDeleted) continue;
    const totalQty = Math.max(1, book.quantity || 1);
    const activeList = activeBorrowsByBook.get(book.id) || [];
    const expectedAvail = Math.max(0, totalQty - activeList.length);
    const expectedStatus: Book['status'] = book.isActive
      ? expectedAvail > 0
        ? 'mavjud'
        : 'olingan'
      : 'faol_emas';

    const currentAvail = getBookAvailableCount(book);
    const latestHolder = activeList[0];
    const expectedHolderName = latestHolder?.studentFullName || '';

    const needsRepair =
      currentAvail !== expectedAvail ||
      book.status !== expectedStatus ||
      (activeList.length === 0 && Boolean(book.currentBorrowerName));

    if (needsRepair) {
      repairedBooks += 1;
      tasks.push(
        updateDoc(doc(db, 'books', book.id), {
          availableQuantity: expectedAvail,
          status: expectedStatus,
          currentTransactionId: latestHolder?.id || '',
          currentBorrowerName: expectedHolderName,
          currentBorrowerGroup: latestHolder?.studentGroup || '',
          currentBorrowerCourse: latestHolder?.studentCourse || '',
          currentBorrowedAt: latestHolder?.borrowedAt || '',
          currentDueDate: latestHolder?.dueDate || '',
          updatedAt: nowIso,
        })
      );
    }
  }

  for (const st of params.students) {
    const expectedActive = activeCountByStudent.get(st.id) || 0;
    if ((st.activeCount || 0) !== expectedActive) {
      repairedStudents += 1;
      tasks.push(
        updateDoc(doc(db, 'students', st.id), {
          activeCount: expectedActive,
          updatedAt: nowIso,
        })
      );
    }
  }

  // Opportunistic cleanup of expired temporary QR upload sessions (> 2 hours old)
  void getDocs(collection(db, 'qrUploads'))
    .then((snap) => {
      const cutoff = nowMs - 2 * 60 * 60 * 1000;
      snap.forEach((d) => {
        const data = d.data() as { createdAt?: string };
        const ts = data.createdAt ? new Date(data.createdAt).getTime() : 0;
        if (ts > 0 && ts < cutoff) {
          void deleteDoc(d.ref).catch(() => {});
        }
      });
    })
    .catch(() => {
      // Rules intentionally disallow qrUploads list; safe no-op when disallowed
    });

  if (tasks.length > 0) {
    await Promise.allSettled(tasks);
    logAdminActivityNonBlocking({
      action: 'Avtomatik ichki tizim tuzatishi',
      targetType: 'system',
      targetId: 'self-heal',
      targetLabel: 'Avtomatik nazorat',
      details: `Ichki nazorat moduli ${repairedBooks} ta kitob qoldig‘i va ${repairedStudents} ta o‘quvchi hisobini avtomatik muvofiqlashtirdi.`,
      actor: 'Avtomatik tizim',
    });
  }

  return { repairedBooks, repairedStudents };
}

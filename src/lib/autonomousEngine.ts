import {
  doc,
  updateDoc,
} from 'firebase/firestore';
import { db } from './firebase.ts';
import {
  getBookAvailableCount,
  logAdminActivityNonBlocking,
  upsertBookDoc,
} from './libraryService.ts';
import {
  isOverdueDate,
  toRelaxedPhonetic,
  transliterateToLatinCanonical,
} from './imageUtils.ts';
import type { Book, OfflinePendingAction, Student, TransactionRecord } from '../types.ts';

/**
 * Pure local Uzbek & Russian Cyrillic <-> Latin aware text normalization.
 * Runs 100% locally inside the browser — zero external AI or server dependencies.
 */
export function normalizeUzbekFuzzy(text: string): string {
  return transliterateToLatinCanonical(text);
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

function scoreNormalizedField(
  q: string,
  qRel: string,
  qTokens: string[],
  qRelTokens: string[],
  f: string,
  fRel: string,
  fWords: string[],
  fRelWords: string[]
): number {
  if (!f) return 0;

  if (f === q) return 100;
  if (f.startsWith(q)) return 92;
  if (f.includes(q)) return 84;

  if (qRel && fRel) {
    if (fRel === qRel) return 95;
    if (fRel.startsWith(qRel)) return 88;
    if (fRel.includes(qRel)) return 78;
  }

  let matchedTokens = 0;
  let tokenScoreSum = 0;

  for (let ti = 0; ti < qTokens.length; ti++) {
    const qt = qTokens[ti];
    const qrt = qRelTokens[ti] || qt;
    let tokenBest = 0;

    for (let wi = 0; wi < fWords.length; wi++) {
      const fw = fWords[wi];
      const fwr = fRelWords[wi] || fw;
      if (fw === qt) {
        tokenBest = 1;
        break;
      }
      if (fwr === qrt) {
        tokenBest = Math.max(tokenBest, 0.94);
        continue;
      }
      if (fw.startsWith(qt) || fw.includes(qt)) {
        tokenBest = Math.max(tokenBest, 0.86);
      } else if (fwr.startsWith(qrt) || fwr.includes(qrt)) {
        tokenBest = Math.max(tokenBest, 0.8);
      } else if (qrt.length >= 4 && fwr.length >= 4) {
        const allowed = qrt.length >= 7 ? 2 : 1;
        const dist = boundedLevenshtein(qrt, fwr, allowed);
        if (dist <= allowed) {
          tokenBest = Math.max(tokenBest, dist === 1 ? 0.72 : 0.58);
        }
      }
    }

    if (tokenBest === 0) return 0;
    matchedTokens += 1;
    tokenScoreSum += tokenBest;
  }

  if (matchedTokens === qTokens.length && qTokens.length > 0) {
    return Math.round((tokenScoreSum / qTokens.length) * 70);
  }
  return 0;
}

export function scoreFuzzyMatch(rawQuery: string, fields: string[]): number {
  const q = normalizeUzbekFuzzy(rawQuery);
  if (!q) return 1;

  const qRel = toRelaxedPhonetic(q);
  const qTokens = q.split(' ').filter(Boolean);
  const qRelTokens = qRel.split(' ').filter(Boolean);
  let bestScore = 0;

  for (const field of fields) {
    if (!field) continue;
    const f = normalizeUzbekFuzzy(field);
    if (!f) continue;
    const fRel = toRelaxedPhonetic(f);
    const fWords = f.split(' ').filter(Boolean);
    const fRelWords = fRel.split(' ').filter(Boolean);

    const score = scoreNormalizedField(
      q,
      qRel,
      qTokens,
      qRelTokens,
      f,
      fRel,
      fWords,
      fRelWords
    );
    if (score >= 100) return 100;
    if (score > bestScore) bestScore = score;
  }

  return bestScore;
}

interface IndexedEntityText {
  canonJoined: string;
  relJoined: string;
  canonWords: string[];
  relWords: string[];
}

const entityTextCache = new WeakMap<object, IndexedEntityText>();

function getIndexedEntityText(obj: object, fields: string[]): IndexedEntityText {
  const cached = entityTextCache.get(obj);
  if (cached) return cached;
  const canonJoined = normalizeUzbekFuzzy(fields.filter(Boolean).join(' '));
  const relJoined = toRelaxedPhonetic(canonJoined);
  const entry: IndexedEntityText = {
    canonJoined,
    relJoined,
    canonWords: canonJoined.split(' ').filter(Boolean),
    relWords: relJoined.split(' ').filter(Boolean),
  };
  entityTextCache.set(obj, entry);
  return entry;
}

export function matchesCachedRecordQuery(
  record: object,
  fields: string[],
  rawQuery: string
): boolean {
  const q = normalizeUzbekFuzzy(rawQuery);
  if (!q) return true;
  const idx = getIndexedEntityText(record, fields);
  if (!idx.canonJoined) return false;
  if (idx.canonJoined.includes(q)) return true;

  const qRel = toRelaxedPhonetic(q);
  if (qRel && idx.relJoined.includes(qRel)) return true;

  const qTokens = q.split(' ').filter(Boolean);
  const qRelTokens = qRel.split(' ').filter(Boolean);
  return (
    scoreNormalizedField(
      q,
      qRel,
      qTokens,
      qRelTokens,
      idx.canonJoined,
      idx.relJoined,
      idx.canonWords,
      idx.relWords
    ) > 0
  );
}

interface IndexedBookSearch {
  canonNum: string;
  canonTitle: string;
  canonAuthor: string;
  canonCategory: string;
  relNum: string;
  relTitle: string;
  relAuthor: string;
  relCategory: string;
  canonCombined: string;
  relCombined: string;
  canonWords: string[];
  relWords: string[];
}

const bookSearchIndexCache = new WeakMap<Book, IndexedBookSearch>();

function getIndexedBookSearch(b: Book): IndexedBookSearch {
  const cached = bookSearchIndexCache.get(b);
  if (cached) return cached;

  const canonNum = normalizeUzbekFuzzy(b.bookNumber || '');
  const canonTitle = normalizeUzbekFuzzy(b.title || '');
  const canonAuthor = normalizeUzbekFuzzy(b.author || '');
  const canonCategory = normalizeUzbekFuzzy(b.category || '');

  const relNum = toRelaxedPhonetic(canonNum);
  const relTitle = toRelaxedPhonetic(canonTitle);
  const relAuthor = toRelaxedPhonetic(canonAuthor);
  const relCategory = toRelaxedPhonetic(canonCategory);

  const canonCombined = `${canonNum} ${canonTitle} ${canonAuthor} ${canonCategory}`.trim();
  const relCombined = `${relNum} ${relTitle} ${relAuthor} ${relCategory}`.trim();

  const entry: IndexedBookSearch = {
    canonNum,
    canonTitle,
    canonAuthor,
    canonCategory,
    relNum,
    relTitle,
    relAuthor,
    relCategory,
    canonCombined,
    relCombined,
    canonWords: canonCombined.split(' ').filter(Boolean),
    relWords: relCombined.split(' ').filter(Boolean),
  };
  bookSearchIndexCache.set(b, entry);
  return entry;
}

export function smartFilterBooks(books: Book[], queryStr: string): Book[] {
  const q = normalizeUzbekFuzzy(queryStr);
  if (!q) return books;

  const qRel = toRelaxedPhonetic(q);
  const qTokens = q.split(' ').filter(Boolean);
  const qRelTokens = qRel.split(' ').filter(Boolean);
  const allowFuzzyTypo = qRelTokens.some((t) => t.length >= 4);

  const scored: Array<{ book: Book; score: number }> = [];

  for (let i = 0; i < books.length; i++) {
    const b = books[i];
    const idx = getIndexedBookSearch(b);

    let score = 0;
    if (idx.canonNum === q || idx.canonTitle === q) {
      score = 100;
    } else if (idx.canonTitle.startsWith(q) || idx.canonNum.startsWith(q)) {
      score = 94;
    } else if (idx.canonTitle.includes(q) || idx.canonAuthor.includes(q) || idx.canonNum.includes(q)) {
      score = 86;
    } else if (idx.relTitle === qRel) {
      score = 92;
    } else if (idx.relTitle.startsWith(qRel)) {
      score = 85;
    } else if (
      idx.relTitle.includes(qRel) ||
      idx.relAuthor.includes(qRel) ||
      idx.relCategory.includes(qRel) ||
      idx.relNum.includes(qRel)
    ) {
      score = 78;
    } else if (qTokens.length > 1) {
      // Multi-word query across combined fields (e.g., author + title)
      let allMatched = true;
      let sum = 0;
      for (let ti = 0; ti < qTokens.length; ti++) {
        const qt = qTokens[ti];
        const qrt = qRelTokens[ti] || qt;
        if (idx.canonCombined.includes(qt)) {
          sum += 0.9;
        } else if (idx.relCombined.includes(qrt)) {
          sum += 0.82;
        } else if (allowFuzzyTypo && qrt.length >= 4) {
          let bestDist = 3;
          const allowed = qrt.length >= 7 ? 2 : 1;
          for (let wi = 0; wi < idx.relWords.length; wi++) {
            const fw = idx.relWords[wi];
            if (fw.length < 4) continue;
            const d = boundedLevenshtein(qrt, fw, allowed);
            if (d < bestDist) {
              bestDist = d;
              if (d === 1) break;
            }
          }
          if (bestDist <= allowed) {
            sum += bestDist === 1 ? 0.72 : 0.58;
          } else {
            allMatched = false;
            break;
          }
        } else {
          allMatched = false;
          break;
        }
      }
      if (allMatched) {
        score = Math.round((sum / qTokens.length) * 72);
      }
    } else if (allowFuzzyTypo && qRel.length >= 4) {
      const allowed = qRel.length >= 7 ? 2 : 1;
      let bestDist = 3;
      for (let wi = 0; wi < idx.relWords.length; wi++) {
        const fw = idx.relWords[wi];
        if (fw.length < 4) continue;
        const d = boundedLevenshtein(qRel, fw, allowed);
        if (d < bestDist) {
          bestDist = d;
          if (d === 1) break;
        }
      }
      if (bestDist <= allowed) {
        score = bestDist === 1 ? 65 : 52;
      }
    }

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
  isTransactionsTruncated?: boolean;
}): Promise<{ repairedBooks: number; repairedStudents: number }> {
  const nowMs = Date.now();
  if (!navigator.onLine || nowMs - lastSelfHealAt < 600_000) {
    return { repairedBooks: 0, repairedStudents: 0 };
  }
  // Do not alter stock if offline actions are waiting or transactions snapshot is truncated
  if (params.offlineQueue.length > 0 || params.isTransactionsTruncated) {
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
    const currentAvail = getBookAvailableCount(book);

    // Fast skip for untouched books (99.9% of 20k bundled catalog)
    if (
      activeList.length === 0 &&
      (book.borrowCount || 0) === 0 &&
      currentAvail === totalQty &&
      !book.currentBorrowerName &&
      book.status === (book.isActive ? 'mavjud' : 'faol_emas')
    ) {
      continue;
    }

    const expectedAvail = Math.max(0, totalQty - activeList.length);
    const expectedStatus: Book['status'] = book.isActive
      ? expectedAvail > 0
        ? 'mavjud'
        : 'olingan'
      : 'faol_emas';

    const latestHolder = activeList[0];
    const expectedHolderName = latestHolder?.studentFullName || '';

    const needsRepair =
      currentAvail !== expectedAvail ||
      book.status !== expectedStatus ||
      (activeList.length === 0 && Boolean(book.currentBorrowerName));

    if (needsRepair) {
      repairedBooks += 1;
      tasks.push(
        upsertBookDoc(book.id, book, {
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

  if (tasks.length > 0) {
    await Promise.allSettled(tasks.slice(0, 30));
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

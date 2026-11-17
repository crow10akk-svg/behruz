import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowLeftRight,
  BarChart3,
  BookCheck,
  BookOpen,
  BookPlus,
  Clock,
  Database,
  Download,
  Edit3,
  Eye,
  FileSpreadsheet,
  FileText,
  GraduationCap,
  History,
  Home,
  KeyRound,
  LayoutGrid,
  List,
  Lock,
  LogOut,
  Menu,
  Power,
  Printer,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { BookCoverImage } from './BookCoverImage.tsx';
import { AdminBookForm } from './AdminBookForm.tsx';
import { StudentHistoryModal, TransactionDetailModal } from './AdminDetailModals.tsx';
import { UzDateSelects, buildReturnIso, getTodayDateStr } from './UzDateSelects.tsx';
import {
  adminReturnTransactionAtomic,
  changeAdminPassword,
  changeAppGatePassword,
  clearAllTransactionsAdmin,
  createFullBackupPayload,
  deleteSingleTransactionAdmin,
  getBookAvailableCount,
  loadOfflineQueue,
  logAdminActivityNonBlocking,
  softDeleteBookAdmin,
  toggleBookActiveAdmin,
  updateLibrarySettingsAdmin,
} from '../lib/libraryService.ts';
import {
  computeLibraryInsights,
  runSelfHealingAudit,
  scoreFuzzyMatch,
  smartFilterBooks,
} from '../lib/autonomousEngine.ts';
import {
  buildReportData,
  exportReportToExcel,
  exportReportToPdf,
  type ReportType,
} from '../lib/exportService.ts';
import { formatUzDate, formatUzDateTime, isOverdueDate } from '../lib/imageUtils.ts';
import type {
  ActivityLogRecord,
  AdminMenuId,
  Book,
  LibrarySetting,
  SignatureRecord,
  Student,
  TransactionRecord,
} from '../types.ts';

interface AdminPanelProps {
  books: Book[];
  students: Student[];
  transactions: TransactionRecord[];
  signatures: Record<string, SignatureRecord>;
  activityLogs: ActivityLogRecord[];
  settings: LibrarySetting;
  onLogout: () => void;
}

const MENU_ITEMS: Array<{ id: AdminMenuId; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'dashboard', label: 'Bosh sahifa', icon: Home },
  { id: 'all-books', label: 'Katalog (Kitoblar)', icon: BookOpen },
  { id: 'add-book', label: 'Yangi kitob qo‘shish', icon: BookPlus },
  { id: 'courses-groups', label: '1-kurs / 2-kurs guruhlari', icon: GraduationCap },
  { id: 'borrowers', label: 'Kitob olgan o‘quvchilar', icon: BookCheck },
  { id: 'returners', label: 'Kitob topshirgan o‘quvchilar', icon: ArrowLeftRight },
  { id: 'currently-holding', label: 'Hozirda kitobni saqlayotganlar', icon: Clock },
  { id: 'history', label: 'Barcha operatsiyalar tarixi', icon: History },
  { id: 'students', label: 'O‘quvchilar bazasi', icon: Users },
  { id: 'search', label: 'Qidiruv', icon: Search },
  { id: 'reports', label: 'Hisobotlar', icon: BarChart3 },
  { id: 'settings', label: 'Sozlamalar', icon: Settings },
];

const DEFAULT_GROUPS_BY_COURSE: Record<'1-kurs' | '2-kurs', string[]> = {
  '1-kurs': [
    '1.1-guruh',
    '1.2-guruh',
    '1.3-guruh',
    '1.4-guruh',
    '1.5-guruh',
    '1.6-guruh',
    '1.7-guruh',
    '1.8-guruh',
    '1.9-guruh',
  ],
  '2-kurs': [
    '2.1-guruh',
    '2.2-guruh',
    '2.3-guruh',
    '2.4-guruh',
    '2.5-guruh',
    '2.6-guruh',
    '2.7-guruh',
    '2.8-guruh',
    '2.9-guruh',
    '2.10-guruh',
  ],
};

function normalizeGroupKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_-]*guruh$/i, '')
    .replace(/\s+/g, '')
    .trim();
}

const REPORT_TYPES: Array<{ id: ReportType; label: string }> = [
  { id: 'daily-borrow', label: 'Kunlik kitob olish hisoboti' },
  { id: 'daily-return', label: 'Kunlik kitob topshirish hisoboti' },
  { id: 'weekly', label: 'Haftalik hisobot' },
  { id: 'monthly', label: 'Oylik hisobot' },
  { id: 'top-books', label: 'Eng ko‘p olingan kitoblar' },
  { id: 'top-students', label: 'Eng ko‘p kitob olgan o‘quvchilar' },
  { id: 'currently-held', label: 'Hozirda o‘quvchilarda turgan kitoblar' },
];

export function AdminPanel({
  books,
  students,
  transactions,
  signatures,
  activityLogs,
  settings,
  onLogout,
}: AdminPanelProps) {
  const [activeMenu, setActiveMenu] = useState<AdminMenuId>('dashboard');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const [editingBook, setEditingBook] = useState<Book | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Book | null>(null);
  const [bookCatalogFilter, setBookCatalogFilter] = useState('');
  const [bookCatalogStatus, setBookCatalogStatus] = useState<'all' | 'mavjud' | 'olingan' | 'inactive'>('all');
  const [booksViewMode, setBooksViewMode] = useState<'catalog' | 'table'>('catalog');
  const [actionMessage, setActionMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const [selectedTx, setSelectedTx] = useState<TransactionRecord | null>(null);
  const [selectedStudent, setSelectedStudent] = useState<Student | null>(null);
  const [returnTargetTx, setReturnTargetTx] = useState<TransactionRecord | null>(null);
  const [adminReturnDateStr, setAdminReturnDateStr] = useState(getTodayDateStr());
  const [isReturningTx, setIsReturningTx] = useState(false);

  // Manual single transaction delete & Clear All state
  const [deleteTxTarget, setDeleteTxTarget] = useState<TransactionRecord | null>(null);
  const [isDeletingTx, setIsDeletingTx] = useState(false);
  const [confirmClearAllOpen, setConfirmClearAllOpen] = useState(false);
  const [isClearingAll, setIsClearingAll] = useState(false);

  // Courses & Groups explorer state
  const [courseFilterTab, setCourseFilterTab] = useState<'all' | '1-kurs' | '2-kurs'>('all');
  const [groupDirectoryFilter, setGroupDirectoryFilter] = useState('');
  const [selectedGroupDetail, setSelectedGroupDetail] = useState<{
    course: '1-kurs' | '2-kurs';
    groupKey: string;
    label: string;
  } | null>(null);
  const [groupTxStatusFilter, setGroupTxStatusFilter] = useState<
    'all' | 'borrow' | 'active' | 'returned'
  >('all');
  const [groupInsideQuery, setGroupInsideQuery] = useState('');

  // Universal Admin quick search (works anywhere in Admin Panel: name, surname, group, book)
  const [quickAdminQuery, setQuickAdminQuery] = useState('');

  // Student directory search & filter
  const [studentListQuery, setStudentListQuery] = useState('');
  const [studentCourseFilter, setStudentCourseFilter] = useState<'all' | '1-kurs' | '2-kurs'>('all');

  // Pagination state so 1000+ rows stay fast and fully accessible
  const [txPage, setTxPage] = useState(1);
  const [txPageSize, setTxPageSize] = useState<number>(50);

  // Search & Filter Tab State (Section 6.3)
  const [globalQuery, setGlobalQuery] = useState('');
  const [txStatusFilter, setTxStatusFilter] = useState<
    'all' | 'borrowed' | 'returned' | 'unreturned' | 'overdue'
  >('all');
  const [groupFilter, setGroupFilter] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // Reports State (Section 9)
  const [selectedReport, setSelectedReport] = useState<ReportType>('currently-held');

  // Settings & Password State
  const [currPwd, setCurrPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [currGatePwd, setCurrGatePwd] = useState('');
  const [newGatePwd, setNewGatePwd] = useState('');
  const [confirmGatePwd, setConfirmGatePwd] = useState('');
  const [instName, setInstName] = useState(settings.institutionName);
  const [libName, setLibName] = useState(settings.libraryName);
  const [loanDays, setLoanDays] = useState(settings.defaultLoanDays);
  const [isBusy, setIsBusy] = useState(false);
  const [lastAutoHealText, setLastAutoHealText] = useState<string | null>(null);

  useEffect(() => {
    if (books.length === 0) return;
    let cancelled = false;
    void runSelfHealingAudit({
      books,
      transactions,
      students,
      offlineQueue: loadOfflineQueue(),
    })
      .then((res) => {
        if (cancelled) return;
        if (res.repairedBooks > 0 || res.repairedStudents > 0) {
          setLastAutoHealText(
            `Avtomatik nazorat: ${res.repairedBooks} ta kitob va ${res.repairedStudents} ta o‘quvchi hisobi muvofiqlashtirildi.`
          );
        }
      })
      .catch(() => {
        // Non-blocking background audit
      });
    return () => {
      cancelled = true;
    };
  }, [books, transactions, students]);

  const activeHoldingTxs = useMemo(
    () => transactions.filter((t) => t.type === 'borrow' && t.status === 'active'),
    [transactions]
  );

  const borrowTxs = useMemo(
    () => transactions.filter((t) => t.type === 'borrow'),
    [transactions]
  );

  const returnTxs = useMemo(
    () => transactions.filter((t) => t.type === 'return'),
    [transactions]
  );

  const stats = useMemo(() => {
    const totalBooks = books.length;
    const totalCopies = books.reduce((sum, b) => sum + Math.max(1, b.quantity || 1), 0);
    const availableCopies = books.reduce(
      (sum, b) => (b.isActive ? sum + getBookAvailableCount(b) : sum),
      0
    );
    const borrowedCopies = activeHoldingTxs.length;
    const overdueBooks = activeHoldingTxs.filter((t) => isOverdueDate(t.dueDate)).length;
    const totalBorrowOps = borrowTxs.length;
    const totalReturnOps = returnTxs.length;
    const uniqueBorrowers = students.filter((s) => (s.totalBorrowed || 0) > 0).length;
    return {
      totalBooks,
      totalCopies,
      availableCopies,
      borrowedCopies,
      overdueBooks,
      totalBorrowOps,
      totalReturnOps,
      uniqueBorrowers,
    };
  }, [books, students, activeHoldingTxs, borrowTxs, returnTxs]);

  const suggestedNextNumber = useMemo(() => {
    let maxNum = 0;
    books.forEach((b) => {
      const parsed = parseInt(b.bookNumber.replace(/\D/g, ''), 10);
      if (!Number.isNaN(parsed) && parsed > maxNum) maxNum = parsed;
    });
    return String(maxNum + 1).padStart(3, '0');
  }, [books]);

  const distinctGroups = useMemo(() => {
    const set = new Set<string>();
    transactions.forEach((t) => {
      if (t.studentGroup) set.add(t.studentGroup);
    });
    return Array.from(set).sort();
  }, [transactions]);

  const deferredQuickAdminQuery = useDeferredValue(quickAdminQuery);
  const deferredGlobalQuery = useDeferredValue(globalQuery);
  const deferredBookCatalogFilter = useDeferredValue(bookCatalogFilter);
  const deferredStudentListQuery = useDeferredValue(studentListQuery);

  const filteredSearchTxs = useMemo(() => {
    const q = deferredGlobalQuery.trim();
    const qNormGroup = normalizeGroupKey(q.toLowerCase());
    return transactions.filter((t) => {
      if (txStatusFilter === 'borrowed' && t.type !== 'borrow') return false;
      if (txStatusFilter === 'returned' && t.type !== 'return') return false;
      if (txStatusFilter === 'unreturned' && !(t.type === 'borrow' && t.status === 'active')) {
        return false;
      }
      if (
        txStatusFilter === 'overdue' &&
        !(t.type === 'borrow' && t.status === 'active' && isOverdueDate(t.dueDate))
      ) {
        return false;
      }
      if (groupFilter !== 'all' && t.studentGroup !== groupFilter) return false;

      const refDate = (t.type === 'borrow' ? t.borrowedAt : t.returnedAt || t.createdAt).slice(
        0,
        10
      );
      if (dateFrom && refDate < dateFrom) return false;
      if (dateTo && refDate > dateTo) return false;

      if (!q) return true;
      if (qNormGroup && normalizeGroupKey(t.studentGroup).includes(qNormGroup)) return true;
      return (
        scoreFuzzyMatch(q, [
          t.studentFullName,
          t.studentFirstName,
          t.studentLastName,
          t.studentGroup,
          t.studentCourse,
          t.bookTitle,
          t.bookNumber,
        ]) > 0
      );
    });
  }, [transactions, deferredGlobalQuery, txStatusFilter, groupFilter, dateFrom, dateTo]);

  const filteredAdminBooks = useMemo(() => {
    const preFiltered = books.filter((b) => {
      const avail = getBookAvailableCount(b);
      if (bookCatalogStatus === 'mavjud' && (!b.isActive || avail <= 0)) return false;
      if (bookCatalogStatus === 'olingan' && (!b.isActive || avail > 0)) return false;
      if (bookCatalogStatus === 'inactive' && b.isActive) return false;
      return true;
    });
    const q = deferredBookCatalogFilter.trim();
    if (!q) return preFiltered;
    return smartFilterBooks(preFiltered, q);
  }, [books, deferredBookCatalogFilter, bookCatalogStatus]);

  // Build 1-kurs and 2-kurs group summaries merging standard groups + actual DB groups
  const courseGroupDirectory = useMemo(() => {
    const buildForCourse = (courseName: '1-kurs' | '2-kurs') => {
      const groupMap = new Map<
        string,
        {
          groupKey: string;
          label: string;
          students: Student[];
          transactions: TransactionRecord[];
          activeHoldCount: number;
          borrowCount: number;
          returnCount: number;
        }
      >();

      DEFAULT_GROUPS_BY_COURSE[courseName].forEach((defLabel) => {
        const key = normalizeGroupKey(defLabel);
        groupMap.set(key, {
          groupKey: key,
          label: defLabel,
          students: [],
          transactions: [],
          activeHoldCount: 0,
          borrowCount: 0,
          returnCount: 0,
        });
      });

      students
        .filter((s) => s.course === courseName)
        .forEach((st) => {
          const key = normalizeGroupKey(st.group) || st.group.toLowerCase();
          if (!groupMap.has(key)) {
            groupMap.set(key, {
              groupKey: key,
              label: st.group.trim(),
              students: [],
              transactions: [],
              activeHoldCount: 0,
              borrowCount: 0,
              returnCount: 0,
            });
          }
          groupMap.get(key)!.students.push(st);
        });

      transactions
        .filter((t) => t.studentCourse === courseName)
        .forEach((tx) => {
          const key = normalizeGroupKey(tx.studentGroup) || tx.studentGroup.toLowerCase();
          if (!groupMap.has(key)) {
            groupMap.set(key, {
              groupKey: key,
              label: tx.studentGroup.trim(),
              students: [],
              transactions: [],
              activeHoldCount: 0,
              borrowCount: 0,
              returnCount: 0,
            });
          }
          const entry = groupMap.get(key)!;
          entry.transactions.push(tx);
          if (tx.type === 'borrow') {
            entry.borrowCount += 1;
            if (tx.status === 'active') entry.activeHoldCount += 1;
          } else {
            entry.returnCount += 1;
          }
        });

      return Array.from(groupMap.values()).sort((a, b) =>
        a.label.localeCompare(b.label, undefined, { numeric: true })
      );
    };

    return {
      '1-kurs': buildForCourse('1-kurs'),
      '2-kurs': buildForCourse('2-kurs'),
    };
  }, [students, transactions]);

  const activeSelectedGroupData = useMemo(() => {
    if (!selectedGroupDetail) return null;
    const list = courseGroupDirectory[selectedGroupDetail.course];
    return (
      list.find((g) => g.groupKey === selectedGroupDetail.groupKey) || {
        groupKey: selectedGroupDetail.groupKey,
        label: selectedGroupDetail.label,
        students: [],
        transactions: [],
        activeHoldCount: 0,
        borrowCount: 0,
        returnCount: 0,
      }
    );
  }, [selectedGroupDetail, courseGroupDirectory]);

  const courseTotals = useMemo(() => {
    const summarize = (courseName: '1-kurs' | '2-kurs') => {
      const list = courseGroupDirectory[courseName];
      return {
        groupCount: list.length,
        studentCount: list.reduce((s, g) => s + g.students.length, 0),
        borrowCount: list.reduce((s, g) => s + g.borrowCount, 0),
        activeHoldCount: list.reduce((s, g) => s + g.activeHoldCount, 0),
        returnCount: list.reduce((s, g) => s + g.returnCount, 0),
      };
    };
    return {
      '1-kurs': summarize('1-kurs'),
      '2-kurs': summarize('2-kurs'),
    };
  }, [courseGroupDirectory]);

  const filteredStudentsList = useMemo(() => {
    const q = deferredStudentListQuery.trim();
    const qGroup = normalizeGroupKey(q.toLowerCase());
    return students.filter((st) => {
      if (studentCourseFilter !== 'all' && st.course !== studentCourseFilter) return false;
      if (!q) return true;
      if (qGroup && normalizeGroupKey(st.group).includes(qGroup)) return true;
      return (
        scoreFuzzyMatch(q, [
          st.fullName,
          st.firstName,
          st.lastName,
          st.group,
          st.course,
        ]) > 0
      );
    });
  }, [students, deferredStudentListQuery, studentCourseFilter]);

  const quickSearchResults = useMemo(() => {
    const qRaw = deferredQuickAdminQuery.trim();
    const q = qRaw.toLowerCase();
    if (!q) return null;
    const qGroup = normalizeGroupKey(q);

    const matchedGroups: Array<{
      course: '1-kurs' | '2-kurs';
      groupKey: string;
      label: string;
      studentCount: number;
      borrowCount: number;
      activeHoldCount: number;
      returnCount: number;
    }> = [];

    (['1-kurs', '2-kurs'] as const).forEach((courseName) => {
      courseGroupDirectory[courseName].forEach((g) => {
        if (
          g.label.toLowerCase().includes(q) ||
          (qGroup && g.groupKey.includes(qGroup)) ||
          courseName.toLowerCase().includes(q) ||
          scoreFuzzyMatch(qRaw, [g.label, courseName]) > 0
        ) {
          matchedGroups.push({
            course: courseName,
            groupKey: g.groupKey,
            label: g.label,
            studentCount: g.students.length,
            borrowCount: g.borrowCount,
            activeHoldCount: g.activeHoldCount,
            returnCount: g.returnCount,
          });
        }
      });
    });

    const matchedStudents = students.filter(
      (st) =>
        (qGroup && normalizeGroupKey(st.group).includes(qGroup)) ||
        scoreFuzzyMatch(qRaw, [
          st.fullName,
          st.firstName,
          st.lastName,
          st.group,
          st.course,
        ]) > 0
    );

    const matchedTxs = transactions.filter(
      (t) =>
        (qGroup && normalizeGroupKey(t.studentGroup).includes(qGroup)) ||
        scoreFuzzyMatch(qRaw, [
          t.studentFullName,
          t.studentFirstName,
          t.studentLastName,
          t.studentGroup,
          t.studentCourse,
          t.bookTitle,
          t.bookNumber,
        ]) > 0
    );

    return { matchedGroups, matchedStudents, matchedTxs };
  }, [deferredQuickAdminQuery, courseGroupDirectory, students, transactions]);

  const insights = useMemo(
    () => computeLibraryInsights(books, transactions, students),
    [books, transactions, students]
  );

  const currentReportData = useMemo(
    () => buildReportData(selectedReport, books, students, transactions),
    [selectedReport, books, students, transactions]
  );

  const currentMenuLabel =
    MENU_ITEMS.find((m) => m.id === activeMenu)?.label || 'Bosh sahifa';

  const handleToggleActive = async (book: Book) => {
    setActionMessage(null);
    try {
      await toggleBookActiveAdmin(book);
      setActionMessage({
        type: 'ok',
        text: `«${book.title}» holati yangilandi.`,
      });
    } catch (err) {
      setActionMessage({
        type: 'err',
        text: err instanceof Error ? err.message : 'Xatolik yuz berdi.',
      });
    }
  };

  const confirmSoftDelete = async () => {
    if (!deleteTarget) return;
    setActionMessage(null);
    try {
      await softDeleteBookAdmin(deleteTarget);
      setActionMessage({
        type: 'ok',
        text: `«${deleteTarget.title}» katalogdan o‘chirildi (tarixiy yozuvlar saqlandi).`,
      });
      setDeleteTarget(null);
    } catch (err) {
      setActionMessage({
        type: 'err',
        text: err instanceof Error ? err.message : 'Kitobni o‘chirishda xatolik.',
      });
      setDeleteTarget(null);
    }
  };

  const handleUpdatePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionMessage(null);
    if (newPwd !== confirmPwd) {
      setActionMessage({ type: 'err', text: 'Yangi parollar mos kelmadi.' });
      return;
    }
    setIsBusy(true);
    try {
      await changeAdminPassword(currPwd, newPwd);
      setCurrPwd('');
      setNewPwd('');
      setConfirmPwd('');
      setActionMessage({
        type: 'ok',
        text: 'Administrator paroli xavfsiz xesh bilan yangilandi.',
      });
    } catch (err) {
      setActionMessage({
        type: 'err',
        text: err instanceof Error ? err.message : 'Parolni yangilashda xatolik.',
      });
    } finally {
      setIsBusy(false);
    }
  };

  const handleUpdateAppGatePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionMessage(null);
    if (newGatePwd !== confirmGatePwd) {
      setActionMessage({ type: 'err', text: 'Ilovaga kirish uchun yangi parollar mos kelmadi.' });
      return;
    }
    setIsBusy(true);
    try {
      await changeAppGatePassword(currGatePwd, newGatePwd);
      setCurrGatePwd('');
      setNewGatePwd('');
      setConfirmGatePwd('');
      setActionMessage({
        type: 'ok',
        text: 'Ilovaga kirish paroli xavfsiz xesh bilan yangilandi.',
      });
    } catch (err) {
      setActionMessage({
        type: 'err',
        text: err instanceof Error ? err.message : 'Ilova kirish parolini yangilashda xatolik.',
      });
    } finally {
      setIsBusy(false);
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionMessage(null);
    setIsBusy(true);
    try {
      await updateLibrarySettingsAdmin({
        institutionName: instName,
        libraryName: libName,
        defaultLoanDays: loanDays,
      });
      setActionMessage({ type: 'ok', text: 'Kutubxona sozlamalari saqlandi.' });
    } catch (err) {
      setActionMessage({
        type: 'err',
        text: err instanceof Error ? err.message : 'Sozlamalarni saqlashda xatolik.',
      });
    } finally {
      setIsBusy(false);
    }
  };

  const handleDownloadBackup = async () => {
    setActionMessage(null);
    setIsBusy(true);
    try {
      const payload = await createFullBackupPayload();
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `smart_kutubxona_backup_${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setActionMessage({
        type: 'ok',
        text: 'Barcha ma’lumotlarning zaxira nusxasi yuklab olindi.',
      });
    } catch (err) {
      setActionMessage({
        type: 'err',
        text: err instanceof Error ? err.message : 'Zaxira nusxa olishda xatolik.',
      });
    } finally {
      setIsBusy(false);
    }
  };

  const handleLogoutClick = () => {
    logAdminActivityNonBlocking({
      action: 'Admin tizimdan chiqdi',
      targetType: 'admin',
      targetId: 'primary',
      targetLabel: 'Admin panel',
      details: 'Administrator panelni yopib o‘quvchilar ekraniga qaytdi.',
    });
    onLogout();
  };

  const openStudentById = (studentId: string) => {
    const found = students.find((s) => s.id === studentId);
    if (found) setSelectedStudent(found);
  };

  const openAdminReturnModal = (tx: TransactionRecord) => {
    setAdminReturnDateStr(getTodayDateStr());
    setReturnTargetTx(tx);
  };

  const confirmAdminReturn = async () => {
    if (!returnTargetTx) return;
    setActionMessage(null);
    setIsReturningTx(true);
    try {
      const returnedAtIso = buildReturnIso(adminReturnDateStr);
      await adminReturnTransactionAtomic({
        transaction: returnTargetTx,
        returnedAtIso,
      });
      setActionMessage({
        type: 'ok',
        text: `«${returnTargetTx.bookTitle}» (${returnTargetTx.studentFullName}) to‘liq topshirilgan deb belgilandi va tarixda saqlandi.`,
      });
      setReturnTargetTx(null);
    } catch (err) {
      setActionMessage({
        type: 'err',
        text: err instanceof Error ? err.message : 'Kitobni topshirishda xatolik yuz berdi.',
      });
    } finally {
      setIsReturningTx(false);
    }
  };

  const confirmDeleteSingleTx = async () => {
    if (!deleteTxTarget) return;
    setActionMessage(null);
    setIsDeletingTx(true);
    try {
      await deleteSingleTransactionAdmin(deleteTxTarget);
      setActionMessage({
        type: 'ok',
        text: `«${deleteTxTarget.studentFullName} — ${deleteTxTarget.bookTitle}» yozuvi o‘chirildi.`,
      });
      setDeleteTxTarget(null);
    } catch (err) {
      setActionMessage({
        type: 'err',
        text: err instanceof Error ? err.message : 'Yozuvni o‘chirishda xatolik yuz berdi.',
      });
    } finally {
      setIsDeletingTx(false);
    }
  };

  const confirmClearAll = async () => {
    setActionMessage(null);
    setIsClearingAll(true);
    try {
      const res = await clearAllTransactionsAdmin();
      setActionMessage({
        type: 'ok',
        text: `Clear All bajarildi: ${res.deletedTransactions} ta operatsiya va ${res.deletedStudents} ta o‘quvchi yozuvi tozalandi. Katalogdagi ${res.resetBooks} ta kitob saqlandi.`,
      });
      setConfirmClearAllOpen(false);
      setTxPage(1);
    } catch (err) {
      setActionMessage({
        type: 'err',
        text: err instanceof Error ? err.message : 'Clear All bajarishda xatolik yuz berdi.',
      });
    } finally {
      setIsClearingAll(false);
    }
  };

  const renderTransactionTable = (
    rows: TransactionRecord[],
    emptyText: string,
    disablePagination = false
  ) => {
    if (rows.length === 0) {
      return (
        <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center text-sm text-slate-500">
          {emptyText}
        </div>
      );
    }

    const effectiveSize = disablePagination || txPageSize <= 0 ? rows.length : txPageSize;
    const totalPages = Math.max(1, Math.ceil(rows.length / effectiveSize));
    const safePage = Math.min(txPage, totalPages);
    const startIdx = (safePage - 1) * effectiveSize;
    const visibleRows = rows.slice(startIdx, startIdx + effectiveSize);

    return (
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        {!disablePagination && (
          <div className="px-4 py-3 border-b border-slate-200 bg-slate-50/70 flex flex-wrap items-center justify-between gap-3 text-xs">
            <span className="font-semibold text-slate-700 tabular-nums">
              Jami: {rows.length} ta yozuv
              {rows.length > effectiveSize
                ? ` (${startIdx + 1}–${Math.min(startIdx + effectiveSize, rows.length)} ko‘rsatilmoqda)`
                : ''}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={txPageSize}
                onChange={(e) => {
                  setTxPageSize(Number(e.target.value));
                  setTxPage(1);
                }}
                aria-label="Sahifadagi yozuvlar soni"
                className="min-h-[32px] px-2.5 py-1 rounded-lg border border-slate-300 bg-white font-medium text-slate-700"
              >
                <option value={50}>50 tadan</option>
                <option value={100}>100 tadan</option>
                <option value={250}>250 tadan</option>
                <option value={0}>Barchasi ({rows.length})</option>
              </select>
              {totalPages > 1 && (
                <div className="inline-flex items-center gap-1">
                  <button
                    type="button"
                    disabled={safePage <= 1}
                    onClick={() => setTxPage(safePage - 1)}
                    className="px-2.5 py-1 rounded-lg border border-slate-300 bg-white text-slate-700 disabled:opacity-40 hover:bg-slate-100"
                  >
                    Oldingi
                  </button>
                  <span className="px-2 font-mono tabular-nums text-slate-600">
                    {safePage} / {totalPages}
                  </span>
                  <button
                    type="button"
                    disabled={safePage >= totalPages}
                    onClick={() => setTxPage(safePage + 1)}
                    className="px-2.5 py-1 rounded-lg border border-slate-300 bg-white text-slate-700 disabled:opacity-40 hover:bg-slate-100"
                  >
                    Keyingi
                  </button>
                </div>
              )}
              {transactions.length > 0 && (
                <button
                  type="button"
                  onClick={() => setConfirmClearAllOpen(true)}
                  className="inline-flex items-center gap-1.5 min-h-[32px] px-3 py-1 rounded-lg font-semibold text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Clear All</span>
                </button>
              )}
            </div>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs sm:text-sm">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 text-xs">
              <tr>
                <th className="py-3 px-4 font-semibold">Ism-familiya</th>
                <th className="py-3 px-4 font-semibold">Guruh</th>
                <th className="py-3 px-4 font-semibold">Kurs</th>
                <th className="py-3 px-4 font-semibold">Kitob nomi</th>
                <th className="py-3 px-4 font-semibold">Raqami</th>
                <th className="py-3 px-4 font-semibold">Holat</th>
                <th className="py-3 px-4 font-semibold">Olingan sana</th>
                <th className="py-3 px-4 font-semibold">Muddat / Topshirilgan</th>
                <th className="py-3 px-4 font-semibold">Imzo</th>
                <th className="py-3 px-4 font-semibold text-right">Amal</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {visibleRows.map((tx) => {
                const isActiveBorrow = tx.type === 'borrow' && tx.status === 'active';
                const overdue = isActiveBorrow && isOverdueDate(tx.dueDate);
                const sigId =
                  tx.type === 'borrow' ? tx.borrowSignatureId : tx.returnSignatureId;
                const sig = sigId ? signatures[sigId] : undefined;

                return (
                  <tr
                    key={tx.id}
                    className={`hover:bg-slate-50/80 transition-colors ${
                      overdue ? 'bg-red-50/40' : ''
                    }`}
                  >
                    <td className="py-3 px-4 font-semibold text-slate-900">
                      <button
                        type="button"
                        onClick={() => openStudentById(tx.studentId)}
                        className="hover:text-blue-700 hover:underline text-left"
                      >
                        {tx.studentFullName}
                      </button>
                    </td>
                    <td className="py-3 px-4 text-slate-700 whitespace-nowrap">
                      {tx.studentGroup}
                    </td>
                    <td className="py-3 px-4 text-slate-700 whitespace-nowrap">
                      {tx.studentCourse}
                    </td>
                    <td className="py-3 px-4 font-medium text-slate-900 max-w-[200px] truncate">
                      {tx.bookTitle}
                    </td>
                    <td className="py-3 px-4 font-mono text-slate-700 tabular-nums whitespace-nowrap">
                      {tx.bookNumber}
                    </td>
                    <td className="py-3 px-4 whitespace-nowrap">
                      {tx.type === 'borrow' ? (
                        overdue ? (
                          <span className="inline-flex items-center gap-1 text-xs font-bold text-red-700">
                            <AlertTriangle className="w-3.5 h-3.5" />
                            <span>Muddati o‘tgan · Hali topshirilmagan</span>
                          </span>
                        ) : tx.status === 'active' ? (
                          <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-700">
                            <Clock className="w-3.5 h-3.5" />
                            <span>Hali topshirilmagan</span>
                          </span>
                        ) : (
                          <span className="text-xs font-semibold text-emerald-700">
                            To‘liq topshirilgan
                          </span>
                        )
                      ) : (
                        <span className="text-xs font-semibold text-emerald-700">
                          Topshirish · To‘liq topshirilgan
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 font-mono text-xs text-slate-600 tabular-nums whitespace-nowrap">
                      {formatUzDateTime(tx.borrowedAt)}
                    </td>
                    <td className="py-3 px-4 font-mono text-xs tabular-nums whitespace-nowrap">
                      {tx.returnedAt ? (
                        <span className="text-emerald-700">
                          {formatUzDateTime(tx.returnedAt)}
                        </span>
                      ) : (
                        <span className={overdue ? 'text-red-700 font-bold' : 'text-slate-600'}>
                          Muddat: {formatUzDate(tx.dueDate)}
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      {sig ? (
                        <img
                          src={sig.imageDataUrl}
                          alt="Elektron imzo"
                          className="h-8 w-16 object-contain rounded border border-slate-200 bg-white"
                        />
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1.5">
                        {isActiveBorrow && (
                          <button
                            type="button"
                            onClick={() => openAdminReturnModal(tx)}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg transition-colors"
                          >
                            <ArrowLeftRight className="w-3.5 h-3.5" />
                            <span>Topshirish</span>
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setSelectedTx(tx)}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-50 rounded-lg transition-colors"
                        >
                          <Eye className="w-3.5 h-3.5" />
                          <span>Ochish</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteTxTarget(tx)}
                          className="inline-flex items-center gap-1 px-2 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 rounded-lg transition-colors"
                          title="Yozuvni qo‘lda o‘chirish"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen flex bg-slate-50">
      {/* Left Sidebar (Desktop) */}
      <aside className="hidden lg:flex lg:w-[272px] lg:flex-col bg-[#0F2942] text-white shrink-0 no-print">
        <div className="h-16 px-5 flex items-center gap-3 border-b border-white/10">
          <span className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center shrink-0">
            <ShieldCheck className="w-4 h-4 text-white" />
          </span>
          <div className="min-w-0">
            <p className="font-display font-bold text-sm leading-tight truncate">
              Admin Panel
            </p>
            <p className="text-[11px] text-slate-300 truncate">Smart Kutubxona</p>
          </div>
        </div>

        <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
          {MENU_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = activeMenu === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setActiveMenu(item.id);
                  setEditingBook(null);
                  setSelectedGroupDetail(null);
                  setQuickAdminQuery('');
                  setActionMessage(null);
                  setTxPage(1);
                }}
                className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs sm:text-sm font-medium transition-colors text-left ${
                  isActive
                    ? 'bg-blue-700 text-white'
                    : 'text-slate-200 hover:bg-white/10 hover:text-white'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-3 border-t border-white/10">
          <button
            type="button"
            onClick={handleLogoutClick}
            className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium text-red-200 hover:bg-red-500/20 hover:text-white transition-colors"
          >
            <LogOut className="w-4 h-4 shrink-0" />
            <span>Tizimdan chiqish</span>
          </button>
        </div>
      </aside>

      {/* Mobile Sidebar Drawer */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex no-print">
          <div
            className="fixed inset-0 bg-slate-950/60"
            onClick={() => setMobileNavOpen(false)}
          />
          <aside className="relative w-72 max-w-[85vw] bg-[#0F2942] text-white flex flex-col h-full z-10">
            <div className="h-16 px-5 flex items-center justify-between border-b border-white/10">
              <span className="font-display font-bold text-sm">Admin Panel</span>
              <button
                type="button"
                onClick={() => setMobileNavOpen(false)}
                className="p-1.5 rounded-lg text-slate-300 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
              {MENU_ITEMS.map((item) => {
                const Icon = item.icon;
                const isActive = activeMenu === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setActiveMenu(item.id);
                      setEditingBook(null);
                      setSelectedGroupDetail(null);
                      setQuickAdminQuery('');
                      setMobileNavOpen(false);
                    }}
                    className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium text-left ${
                      isActive ? 'bg-blue-700 text-white' : 'text-slate-200 hover:bg-white/10'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span className="truncate">{item.label}</span>
                  </button>
                );
              })}
            </nav>
            <div className="p-3 border-t border-white/10">
              <button
                type="button"
                onClick={handleLogoutClick}
                className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium text-red-200 hover:bg-red-500/20"
              >
                <LogOut className="w-4 h-4 shrink-0" />
                <span>Tizimdan chiqish</span>
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="sticky top-0 z-20 h-16 bg-white border-b border-slate-200 px-4 sm:px-6 flex items-center justify-between gap-4 no-print">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              className="lg:hidden p-2 rounded-xl border border-slate-200 text-slate-700 hover:bg-slate-100"
              aria-label="Menyuni ochish"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="text-sm text-slate-500 truncate">
              <span>Admin panel</span>
              <span className="mx-2 text-slate-300">/</span>
              <span className="font-semibold text-slate-900">{currentMenuLabel}</span>
            </div>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={() => {
                setEditingBook(null);
                setActiveMenu('add-book');
              }}
              className="inline-flex items-center gap-2 min-h-[40px] px-3.5 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-xl transition-colors whitespace-nowrap"
            >
              <BookPlus className="w-4 h-4" />
              <span className="hidden sm:inline">Yangi kitob qo‘shish</span>
              <span className="sm:hidden">Qo‘shish</span>
            </button>
            <button
              type="button"
              onClick={handleLogoutClick}
              className="inline-flex items-center gap-1.5 min-h-[40px] px-3.5 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors whitespace-nowrap"
            >
              <LogOut className="w-4 h-4" />
              <span className="hidden sm:inline">Chiqish</span>
            </button>
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl w-full mx-auto space-y-6">
          {/* Always-visible Admin Quick Search Bar (Ism, Familiya, Guruh, Kitob) */}
          <div className="bg-white rounded-2xl border border-slate-200 p-3.5 sm:p-4 no-print">
            <div className="relative flex items-center gap-2">
              <Search className="w-4 h-4 sm:w-5 sm:h-5 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={quickAdminQuery}
                onChange={(e) => {
                  setQuickAdminQuery(e.target.value);
                  setTxPage(1);
                }}
                placeholder="Tezkor qidiruv: ism, familiya (masalan: Aliyev), guruh (masalan: 1.1 yoki 2.10) yoki kitob..."
                className="w-full min-h-[44px] pl-10 pr-24 py-2 text-sm rounded-xl border border-slate-300 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
              {quickAdminQuery && (
                <button
                  type="button"
                  onClick={() => setQuickAdminQuery('')}
                  className="absolute right-2.5 px-2.5 py-1 text-xs font-semibold text-slate-600 bg-slate-200/80 hover:bg-slate-300 rounded-lg"
                >
                  Tozalash
                </button>
              )}
            </div>
          </div>

          {actionMessage && (
            <div
              className={`rounded-xl border p-4 text-sm flex items-center justify-between gap-3 no-print ${
                actionMessage.type === 'ok'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                  : 'border-red-200 bg-red-50 text-red-900'
              }`}
            >
              <span>{actionMessage.text}</span>
              <button
                type="button"
                onClick={() => setActionMessage(null)}
                className="text-xs font-semibold underline shrink-0"
              >
                Yopish
              </button>
            </div>
          )}

          {/* Universal Quick Search Results Overlay Panel */}
          {quickSearchResults ? (
            <div className="space-y-6">
              <div className="flex flex-wrap items-center justify-between gap-3 bg-blue-50 border border-blue-200 rounded-2xl px-5 py-3.5">
                <div className="text-sm text-blue-950">
                  <span className="font-bold">«{quickAdminQuery.trim()}»</span> bo‘yicha natijalar:{' '}
                  <span className="font-mono font-semibold">
                    {quickSearchResults.matchedGroups.length} ta guruh,{' '}
                    {quickSearchResults.matchedStudents.length} ta o‘quvchi,{' '}
                    {quickSearchResults.matchedTxs.length} ta operatsiya
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setQuickAdminQuery('')}
                  className="text-xs font-semibold text-blue-800 hover:underline"
                >
                  Qidiruvni yopish
                </button>
              </div>

              {quickSearchResults.matchedGroups.length > 0 && (
                <div className="space-y-2.5">
                  <h3 className="font-display font-bold text-base text-slate-900">
                    Topilgan guruhlar ({quickSearchResults.matchedGroups.length})
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
                    {quickSearchResults.matchedGroups.map((grp) => (
                      <button
                        key={`${grp.course}-${grp.groupKey}`}
                        type="button"
                        onClick={() => {
                          setSelectedGroupDetail({
                            course: grp.course,
                            groupKey: grp.groupKey,
                            label: grp.label,
                          });
                          setGroupTxStatusFilter('all');
                          setGroupInsideQuery('');
                          setQuickAdminQuery('');
                          setActiveMenu('courses-groups');
                          setTxPage(1);
                        }}
                        className="text-left bg-white rounded-2xl border border-slate-200 hover:border-blue-500 hover:shadow-md p-4 transition-all space-y-2"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div>
                            <span className="text-[11px] font-semibold uppercase tracking-wider text-blue-700 block">
                              {grp.course}
                            </span>
                            <h4 className="font-display font-bold text-base text-slate-900">
                              {grp.label}
                            </h4>
                          </div>
                          <span className="text-xs font-semibold text-blue-700">
                            Kirish →
                          </span>
                        </div>
                        <div className="grid grid-cols-4 gap-2 pt-2 border-t border-slate-100 text-[11px]">
                          <div>
                            <span className="text-slate-500 block">O‘quvchi</span>
                            <span className="font-mono font-bold text-slate-900 tabular-nums">
                              {grp.studentCount}
                            </span>
                          </div>
                          <div>
                            <span className="text-slate-500 block">Olgan</span>
                            <span className="font-mono font-bold text-blue-700 tabular-nums">
                              {grp.borrowCount}
                            </span>
                          </div>
                          <div>
                            <span className="text-slate-500 block">Qo‘lda</span>
                            <span className="font-mono font-bold text-amber-700 tabular-nums">
                              {grp.activeHoldCount}
                            </span>
                          </div>
                          <div>
                            <span className="text-slate-500 block">Topshirgan</span>
                            <span className="font-mono font-bold text-emerald-700 tabular-nums">
                              {grp.returnCount}
                            </span>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {quickSearchResults.matchedStudents.length > 0 && (
                <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
                  <div className="px-5 py-3.5 border-b border-slate-200 bg-slate-50/70">
                    <h3 className="font-display font-bold text-sm text-slate-900">
                      Topilgan o‘quvchilar ({quickSearchResults.matchedStudents.length})
                    </h3>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs sm:text-sm">
                      <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 text-xs">
                        <tr>
                          <th className="py-2.5 px-4 font-semibold">Ism-familiya</th>
                          <th className="py-2.5 px-4 font-semibold">Guruh</th>
                          <th className="py-2.5 px-4 font-semibold">Kurs</th>
                          <th className="py-2.5 px-4 font-semibold">Olgan</th>
                          <th className="py-2.5 px-4 font-semibold">Topshirgan</th>
                          <th className="py-2.5 px-4 font-semibold">Hozir o‘zida</th>
                          <th className="py-2.5 px-4 font-semibold text-right">Tarix</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {quickSearchResults.matchedStudents.map((st) => (
                          <tr key={st.id} className="hover:bg-slate-50/80">
                            <td className="py-2.5 px-4 font-semibold text-slate-900">
                              {st.fullName}
                            </td>
                            <td className="py-2.5 px-4 text-slate-700">{st.group}</td>
                            <td className="py-2.5 px-4 text-slate-700">{st.course}</td>
                            <td className="py-2.5 px-4 font-mono tabular-nums">{st.totalBorrowed}</td>
                            <td className="py-2.5 px-4 font-mono tabular-nums text-emerald-700">
                              {st.totalReturned}
                            </td>
                            <td className="py-2.5 px-4 font-mono tabular-nums font-semibold text-amber-700">
                              {st.activeCount}
                            </td>
                            <td className="py-2.5 px-4 text-right">
                              <button
                                type="button"
                                onClick={() => setSelectedStudent(st)}
                                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-50 rounded-lg"
                              >
                                <Eye className="w-3.5 h-3.5" />
                                <span>To‘liq tarix</span>
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <div className="space-y-2.5">
                <h3 className="font-display font-bold text-base text-slate-900">
                  Topilgan kitob olish va topshirish yozuvlari ({quickSearchResults.matchedTxs.length})
                </h3>
                {renderTransactionTable(
                  quickSearchResults.matchedTxs,
                  `«${quickAdminQuery.trim()}» so‘rovi bo‘yicha olish-topshirish yozuvlari topilmadi.`
                )}
              </div>
            </div>
          ) : (
            <>
          {/* 1. BOSH SAHIFA (DASHBOARD) */}
          {activeMenu === 'dashboard' && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
                <div className="bg-white rounded-2xl border border-slate-200 p-5">
                  <span className="text-xs font-medium text-slate-500">Jami kitoblar</span>
                  <p className="font-mono text-3xl font-bold text-slate-900 mt-1 tabular-nums">
                    {stats.totalBooks}
                  </p>
                  <span className="text-xs text-slate-500 mt-1 block tabular-nums">
                    Jami nusxa: {stats.totalCopies} dona
                  </span>
                </div>

                <div className="bg-white rounded-2xl border border-slate-200 p-5">
                  <span className="text-xs font-medium text-slate-500">Mavjud nusxalar</span>
                  <p className="font-mono text-3xl font-bold text-emerald-700 mt-1 tabular-nums">
                    {stats.availableCopies}
                  </p>
                  <span className="text-xs text-slate-500 mt-1 block">
                    Kutubxonada qolgan
                  </span>
                </div>

                <div className="bg-white rounded-2xl border border-slate-200 p-5">
                  <span className="text-xs font-medium text-slate-500">Hali topshirilmagan</span>
                  <p className="font-mono text-3xl font-bold text-amber-700 mt-1 tabular-nums">
                    {stats.borrowedCopies}
                  </p>
                  <span className="text-xs text-slate-500 mt-1 block tabular-nums">
                    Jami olinganlar: {stats.totalBorrowOps}
                    {stats.overdueBooks > 0 && (
                      <span className="text-red-700 font-semibold">
                        {' '}
                        · {stats.overdueBooks} muddati o‘tgan
                      </span>
                    )}
                  </span>
                </div>

                <div className="bg-white rounded-2xl border border-slate-200 p-5">
                  <span className="text-xs font-medium text-slate-500">To‘liq topshirilgan</span>
                  <p className="font-mono text-3xl font-bold text-emerald-700 mt-1 tabular-nums">
                    {stats.totalReturnOps}
                  </p>
                  <span className="text-xs text-slate-500 mt-1 block">
                    Tarixdagi barcha qaytarishlar
                  </span>
                </div>

                <div className="bg-white rounded-2xl border border-slate-200 p-5">
                  <span className="text-xs font-medium text-slate-500">
                    Kitob olgan o‘quvchilar
                  </span>
                  <p className="font-mono text-3xl font-bold text-blue-700 mt-1 tabular-nums">
                    {stats.uniqueBorrowers}
                  </p>
                  <span className="text-xs text-slate-500 mt-1 block">
                    Ro‘yxatdan o‘tgan o‘quvchilar
                  </span>
                </div>
              </div>

              {/* Autonomous Local Control & Insights Panel (100% Built-in, Zero External Services) */}
              <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <span className="w-8 h-8 rounded-xl bg-blue-50 border border-blue-200 text-blue-700 flex items-center justify-center shrink-0">
                      <Activity className="w-4 h-4" />
                    </span>
                    <div>
                      <h3 className="font-display font-bold text-sm sm:text-base text-slate-900">
                        Ichki avtomatik nazorat va tahlil
                      </h3>
                      <p className="text-xs text-slate-500">{insights.summaryText}</p>
                    </div>
                  </div>
                  {lastAutoHealText && (
                    <span className="text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-1">
                      {lastAutoHealText}
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                  <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3.5">
                    <span className="text-slate-500 block">Qaytarish intizomi</span>
                    <p className="font-mono text-lg font-bold text-slate-900 mt-0.5 tabular-nums">
                      {insights.returnRatePct}%
                    </p>
                    <span className="text-[11px] text-slate-500">
                      Olingan kitoblardan topshirilgan ulushi
                    </span>
                  </div>

                  <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3.5">
                    <span className="text-slate-500 block">Eng faol guruh</span>
                    <p className="font-display text-lg font-bold text-blue-800 mt-0.5 truncate">
                      {insights.topGroup ? insights.topGroup.group : '—'}
                    </p>
                    <span className="text-[11px] text-slate-500 tabular-nums">
                      {insights.topGroup
                        ? `${insights.topGroup.count} marta kitob olingan`
                        : 'Hali ma’lumot yetarli emas'}
                    </span>
                  </div>

                  <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3.5">
                    <span className="text-slate-500 block">Nusxasi tugagan ommabop kitoblar</span>
                    {insights.depletedPopularBooks.length === 0 ? (
                      <>
                        <p className="font-display text-lg font-bold text-emerald-700 mt-0.5">
                          Barchasi mavjud
                        </p>
                        <span className="text-[11px] text-slate-500">
                          Katalogdagi barcha kitoblar zaxirada bor
                        </span>
                      </>
                    ) : (
                      <>
                        <p className="font-mono text-lg font-bold text-amber-700 mt-0.5 tabular-nums">
                          {insights.depletedPopularBooks.length} ta kitob
                        </p>
                        <span className="text-[11px] text-slate-600 line-clamp-1">
                          {insights.depletedPopularBooks.map((b) => `№${b.bookNumber}`).join(', ')}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              </div>

              {stats.overdueBooks > 0 && (
                <div className="rounded-2xl border border-red-300 bg-red-50 p-5 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="font-display font-bold text-red-900 flex items-center gap-2">
                      <AlertTriangle className="w-5 h-5 text-red-700" />
                      <span>Muddati o‘tgan kitoblar ({stats.overdueBooks} ta)</span>
                    </h3>
                    <button
                      type="button"
                      onClick={() => setActiveMenu('currently-holding')}
                      className="text-xs font-semibold text-red-800 hover:underline"
                    >
                      Barchasini ko‘rish
                    </button>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {activeHoldingTxs
                      .filter((t) => isOverdueDate(t.dueDate))
                      .slice(0, 6)
                      .map((t) => (
                        <div
                          key={t.id}
                          className="bg-white rounded-xl border border-red-200 p-3.5 flex items-center justify-between gap-3 text-sm"
                        >
                          <div className="min-w-0">
                            <p className="font-semibold text-slate-900 truncate">
                              {t.studentFullName} ({t.studentGroup})
                            </p>
                            <p className="text-xs text-slate-600 truncate">
                              № {t.bookNumber} · {t.bookTitle}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => openAdminReturnModal(t)}
                            className="px-2.5 py-1.5 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg whitespace-nowrap"
                          >
                            Topshirish
                          </button>
                        </div>
                      ))}
                  </div>
                </div>
              )}

              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h3 className="font-display font-bold text-lg text-slate-900">
                    So‘nggi operatsiyalar (Jami: {transactions.length} ta)
                  </h3>
                  <div className="flex items-center gap-2.5">
                    {transactions.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setConfirmClearAllOpen(true)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 rounded-lg transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Clear All</span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setTxPage(1);
                        setActiveMenu('history');
                      }}
                      className="text-xs font-semibold text-blue-700 hover:underline"
                    >
                      Barcha tarix ({transactions.length})
                    </button>
                  </div>
                </div>
                {renderTransactionTable(
                  transactions.slice(0, 10),
                  'Hali birorta kitob olish yoki topshirish operatsiyasi qayd etilmagan.',
                  true
                )}
              </div>
            </div>
          )}

          {/* 2. KATALOG (BARCHA KITOBLAR — VISUAL KATALOG VA JADVAL) */}
          {activeMenu === 'all-books' && (
            <div className="space-y-5">
              {editingBook ? (
                <AdminBookForm
                  editingBook={editingBook}
                  existingBooks={books}
                  onSuccess={() => setEditingBook(null)}
                  onCancel={() => setEditingBook(null)}
                />
              ) : (
                <>
                  <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-3 flex-1">
                      <div className="relative flex-1 min-w-[220px] max-w-md">
                        <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                        <input
                          type="text"
                          value={bookCatalogFilter}
                          onChange={(e) => setBookCatalogFilter(e.target.value)}
                          placeholder="Kitob nomi, muallif yoki raqami bo‘yicha qidiring..."
                          className="w-full min-h-[44px] pl-10 pr-4 py-2 text-sm rounded-xl border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
                        />
                      </div>

                      <div className="inline-flex items-center gap-1 p-1 bg-slate-200/75 rounded-xl">
                        {[
                          { id: 'all', label: 'Barchasi' },
                          { id: 'mavjud', label: 'Mavjud' },
                          { id: 'olingan', label: 'Tugagan' },
                          { id: 'inactive', label: 'Faol emas' },
                        ].map((tab) => (
                          <button
                            key={tab.id}
                            type="button"
                            onClick={() =>
                              setBookCatalogStatus(
                                tab.id as 'all' | 'mavjud' | 'olingan' | 'inactive'
                              )
                            }
                            className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap ${
                              bookCatalogStatus === tab.id
                                ? 'bg-white text-slate-900 shadow-xs'
                                : 'text-slate-600 hover:text-slate-900'
                            }`}
                          >
                            {tab.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="flex items-center gap-3 shrink-0">
                      <span className="text-xs text-slate-500 tabular-nums">
                        Jami: {filteredAdminBooks.length} ta kitob
                      </span>
                      <div className="inline-flex items-center gap-1 p-1 bg-slate-200/75 rounded-xl">
                        <button
                          type="button"
                          onClick={() => setBooksViewMode('catalog')}
                          className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
                            booksViewMode === 'catalog'
                              ? 'bg-white text-slate-900 shadow-xs'
                              : 'text-slate-600 hover:text-slate-900'
                          }`}
                        >
                          <LayoutGrid className="w-3.5 h-3.5" />
                          <span>Katalog</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setBooksViewMode('table')}
                          className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
                            booksViewMode === 'table'
                              ? 'bg-white text-slate-900 shadow-xs'
                              : 'text-slate-600 hover:text-slate-900'
                          }`}
                        >
                          <List className="w-3.5 h-3.5" />
                          <span>Jadval</span>
                        </button>
                      </div>
                    </div>
                  </div>

                  {filteredAdminBooks.length === 0 ? (
                    <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center text-sm text-slate-500">
                      Katalogda mos kitob topilmadi.
                    </div>
                  ) : booksViewMode === 'catalog' ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
                      {filteredAdminBooks.map((book) => {
                        const totalQty = Math.max(1, book.quantity || 1);
                        const availQty = getBookAvailableCount(book);
                        const isLocked = availQty <= 0;
                        const overdue =
                          availQty < totalQty && isOverdueDate(book.currentDueDate);

                        return (
                          <article
                            key={book.id}
                            className={`bg-white rounded-2xl border overflow-hidden flex flex-col transition-all ${
                              !book.isActive
                                ? 'border-slate-300 opacity-75'
                                : isLocked
                                  ? 'border-amber-200'
                                  : 'border-slate-200 hover:border-blue-400 hover:shadow-md'
                            }`}
                          >
                            <div className="relative aspect-[4/3] bg-slate-100 overflow-hidden">
                              <BookCoverImage
                                coverUrl={book.coverUrl}
                                title={book.title}
                                bookNumber={book.bookNumber}
                                className={`w-full h-full ${isLocked || !book.isActive ? 'opacity-75' : ''}`}
                              />

                              <span className="absolute top-3 left-3 px-2.5 py-1 rounded-lg bg-slate-950/80 text-white font-mono text-xs font-semibold tabular-nums">
                                № {book.bookNumber}
                              </span>

                              <span
                                className={`absolute top-3 right-3 inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-bold shadow-xs ${
                                  !book.isActive
                                    ? 'bg-slate-800 text-white'
                                    : isLocked
                                      ? overdue
                                        ? 'bg-red-700 text-white'
                                        : 'bg-amber-700 text-white'
                                      : 'bg-emerald-700 text-white'
                                }`}
                              >
                                {isLocked && <Lock className="w-3 h-3" />}
                                <span>
                                  {!book.isActive
                                    ? 'Faol emas'
                                    : isLocked
                                      ? 'Tugagan'
                                      : `${availQty} / ${totalQty} ta`}
                                </span>
                              </span>
                            </div>

                            <div className="p-4 flex-1 flex flex-col justify-between gap-3">
                              <div>
                                <div className="flex items-center justify-between gap-2 mb-1">
                                  <span className="text-[11px] font-semibold uppercase tracking-wider text-blue-700">
                                    {book.category || 'Umumiy'}
                                  </span>
                                  <span className="text-[11px] font-mono text-slate-500 tabular-nums">
                                    Soni: {availQty}/{totalQty}
                                  </span>
                                </div>
                                <h3 className="font-display font-bold text-base text-slate-900 line-clamp-2 leading-snug">
                                  {book.title}
                                </h3>
                                <p className="text-xs text-slate-600 mt-1 line-clamp-1">
                                  {book.author || 'Muallif ko‘rsatilmagan'}
                                </p>
                                {book.currentBorrowerName && availQty < totalQty && (
                                  <p className="text-[11px] text-amber-800 mt-1.5 line-clamp-1">
                                    Oxirgi olgan: {book.currentBorrowerName} ({book.currentBorrowerGroup})
                                  </p>
                                )}
                              </div>

                              <div className="pt-3 border-t border-slate-100 grid grid-cols-3 gap-2">
                                <button
                                  type="button"
                                  onClick={() => setEditingBook(book)}
                                  className="inline-flex items-center justify-center gap-1 min-h-[36px] px-2 py-1.5 text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors"
                                >
                                  <Edit3 className="w-3.5 h-3.5" />
                                  <span>Tahrir</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleToggleActive(book)}
                                  className="inline-flex items-center justify-center gap-1 min-h-[36px] px-2 py-1.5 text-xs font-semibold text-amber-800 bg-amber-50 hover:bg-amber-100 rounded-lg transition-colors"
                                  title={book.isActive ? 'Faolsizlantirish' : 'Faollashtirish'}
                                >
                                  <Power className="w-3.5 h-3.5" />
                                  <span>{book.isActive ? 'To‘xtat' : 'Yoqish'}</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setDeleteTarget(book)}
                                  className="inline-flex items-center justify-center gap-1 min-h-[36px] px-2 py-1.5 text-xs font-semibold text-red-700 bg-red-50 hover:bg-red-100 rounded-lg transition-colors"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                  <span>O‘chir</span>
                                </button>
                              </div>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-xs sm:text-sm">
                          <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 text-xs">
                            <tr>
                              <th className="py-3 px-4 font-semibold">Muqova</th>
                              <th className="py-3 px-4 font-semibold">Raqam</th>
                              <th className="py-3 px-4 font-semibold">Kitob nomi va muallifi</th>
                              <th className="py-3 px-4 font-semibold">Qolgan / Jami</th>
                              <th className="py-3 px-4 font-semibold">Holati</th>
                              <th className="py-3 px-4 font-semibold text-right">Amallar</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {filteredAdminBooks.map((book) => {
                              const totalQty = Math.max(1, book.quantity || 1);
                              const availQty = getBookAvailableCount(book);
                              const overdue =
                                availQty < totalQty && isOverdueDate(book.currentDueDate);
                              return (
                                <tr key={book.id} className="hover:bg-slate-50/80">
                                  <td className="py-3 px-4">
                                    <div className="w-11 h-14 rounded-lg overflow-hidden border border-slate-200">
                                      <BookCoverImage
                                        coverUrl={book.coverUrl}
                                        title={book.title}
                                        bookNumber={book.bookNumber}
                                        className="w-full h-full"
                                      />
                                    </div>
                                  </td>
                                  <td className="py-3 px-4 font-mono font-semibold text-slate-900 tabular-nums">
                                    {book.bookNumber}
                                  </td>
                                  <td className="py-3 px-4">
                                    <p className="font-semibold text-slate-900">{book.title}</p>
                                    <p className="text-xs text-slate-500">
                                      {book.author || 'Muallif ko‘rsatilmagan'} · {book.category}
                                    </p>
                                  </td>
                                  <td className="py-3 px-4 font-mono tabular-nums text-slate-700">
                                    {availQty} / {totalQty} dona
                                  </td>
                                  <td className="py-3 px-4 whitespace-nowrap">
                                    {!book.isActive ? (
                                      <span className="text-xs font-semibold text-slate-500">
                                        Faol emas
                                      </span>
                                    ) : availQty > 0 ? (
                                      <span className="text-xs font-semibold text-emerald-700">
                                        Mavjud ({availQty} ta)
                                      </span>
                                    ) : (
                                      <div>
                                        <span
                                          className={`inline-flex items-center gap-1 text-xs font-bold ${
                                            overdue ? 'text-red-700' : 'text-amber-700'
                                          }`}
                                        >
                                          <Lock className="w-3.5 h-3.5" />
                                          <span>{overdue ? 'Tugagan · Muddati o‘tgan' : 'Tugagan (Qulf)'}</span>
                                        </span>
                                        {book.currentBorrowerName && (
                                          <span className="text-[11px] text-slate-500 block">
                                            {book.currentBorrowerName}
                                          </span>
                                        )}
                                      </div>
                                    )}
                                  </td>
                                  <td className="py-3 px-4 text-right whitespace-nowrap">
                                    <div className="inline-flex items-center gap-1.5">
                                      <button
                                        type="button"
                                        onClick={() => setEditingBook(book)}
                                        className="p-2 text-slate-600 hover:text-blue-700 hover:bg-blue-50 rounded-lg transition-colors"
                                        title="Tahrirlash"
                                      >
                                        <Edit3 className="w-4 h-4" />
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => handleToggleActive(book)}
                                        className="p-2 text-slate-600 hover:text-amber-700 hover:bg-amber-50 rounded-lg transition-colors"
                                        title={book.isActive ? 'Faolsizlantirish' : 'Faollashtirish'}
                                      >
                                        <Power className="w-4 h-4" />
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => setDeleteTarget(book)}
                                        className="p-2 text-slate-600 hover:text-red-700 hover:bg-red-50 rounded-lg transition-colors"
                                        title="O‘chirish"
                                      >
                                        <Trash2 className="w-4 h-4" />
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* 3. YANGI KITOB QO‘SHISH */}
          {activeMenu === 'add-book' && (
            <AdminBookForm
              existingBooks={books}
              suggestedNextNumber={suggestedNextNumber}
              onSuccess={() => {
                setActionMessage({
                  type: 'ok',
                  text: 'Yangi kitob bazaga qo‘shildi va o‘quvchilar katalogida faollashdi.',
                });
              }}
            />
          )}

          {/* 3.5. 1-KURS VA 2-KURS GURUHLARI */}
          {activeMenu === 'courses-groups' && (
            <div className="space-y-6">
              {selectedGroupDetail && activeSelectedGroupData ? (
                <div className="space-y-5">
                  <div className="bg-white rounded-2xl border border-slate-200 p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedGroupDetail(null);
                          setGroupTxStatusFilter('all');
                          setGroupInsideQuery('');
                          setTxPage(1);
                        }}
                        className="inline-flex items-center gap-1.5 min-h-[40px] px-3.5 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors"
                      >
                        <ArrowLeft className="w-4 h-4" />
                        <span>Guruhlarga qaytish</span>
                      </button>
                      <div>
                        <span className="text-xs font-semibold uppercase tracking-wider text-blue-700 block">
                          {selectedGroupDetail.course}
                        </span>
                        <h3 className="font-display font-bold text-xl text-slate-900">
                          {activeSelectedGroupData.label}
                        </h3>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      {[
                        { id: 'all', label: `Barchasi (${activeSelectedGroupData.transactions.length})` },
                        {
                          id: 'borrow',
                          label: `Kitob olganlar (${activeSelectedGroupData.borrowCount})`,
                        },
                        {
                          id: 'active',
                          label: `Hali topshirilmagan (${activeSelectedGroupData.activeHoldCount})`,
                        },
                        {
                          id: 'returned',
                          label: `Topshirganlar (${activeSelectedGroupData.returnCount})`,
                        },
                      ].map((tab) => (
                        <button
                          key={tab.id}
                          type="button"
                          onClick={() => {
                            setGroupTxStatusFilter(
                              tab.id as 'all' | 'borrow' | 'active' | 'returned'
                            );
                            setTxPage(1);
                          }}
                          className={`px-3 py-1.5 font-semibold rounded-lg border transition-colors ${
                            groupTxStatusFilter === tab.id
                              ? 'bg-[#0F2942] text-white border-[#0F2942]'
                              : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                          }`}
                        >
                          {tab.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Group summary metrics */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    <div className="bg-white rounded-2xl border border-slate-200 p-4">
                      <span className="text-xs text-slate-500 block">Guruh o‘quvchilari</span>
                      <span className="font-mono text-2xl font-bold text-slate-900 tabular-nums">
                        {activeSelectedGroupData.students.length}
                      </span>
                    </div>
                    <div className="bg-white rounded-2xl border border-slate-200 p-4">
                      <span className="text-xs text-slate-500 block">Jami kitob olgan</span>
                      <span className="font-mono text-2xl font-bold text-blue-700 tabular-nums">
                        {activeSelectedGroupData.borrowCount}
                      </span>
                    </div>
                    <div className="bg-white rounded-2xl border border-slate-200 p-4">
                      <span className="text-xs text-slate-500 block">Hali topshirilmagan</span>
                      <span className="font-mono text-2xl font-bold text-amber-700 tabular-nums">
                        {activeSelectedGroupData.activeHoldCount}
                      </span>
                    </div>
                    <div className="bg-white rounded-2xl border border-slate-200 p-4">
                      <span className="text-xs text-slate-500 block">To‘liq topshirilgan</span>
                      <span className="font-mono text-2xl font-bold text-emerald-700 tabular-nums">
                        {activeSelectedGroupData.returnCount}
                      </span>
                    </div>
                  </div>

                  {/* Search inside selected group */}
                  <div className="relative max-w-md">
                    <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={groupInsideQuery}
                      onChange={(e) => {
                        setGroupInsideQuery(e.target.value);
                        setTxPage(1);
                      }}
                      placeholder={`${activeSelectedGroupData.label} ichida ism, familiya yoki kitob bo‘yicha qidirish...`}
                      className="w-full min-h-[42px] pl-10 pr-4 py-2 text-sm rounded-xl border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                  </div>

                  {/* Students in this group */}
                  <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
                    <div className="px-5 py-3.5 border-b border-slate-200 bg-slate-50/70 flex items-center justify-between">
                      <h4 className="font-display font-bold text-sm text-slate-900">
                        {activeSelectedGroupData.label} o‘quvchilari ({activeSelectedGroupData.students.length})
                      </h4>
                    </div>
                    {activeSelectedGroupData.students.length === 0 ? (
                      <div className="p-6 text-center text-xs text-slate-500">
                        Hozircha bu guruhdan birorta o‘quvchi kitob olmagan.
                      </div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-xs sm:text-sm">
                          <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 text-xs">
                            <tr>
                              <th className="py-2.5 px-4 font-semibold">Ism-familiya</th>
                              <th className="py-2.5 px-4 font-semibold">Olgan</th>
                              <th className="py-2.5 px-4 font-semibold">Topshirgan</th>
                              <th className="py-2.5 px-4 font-semibold">Hozir o‘zida</th>
                              <th className="py-2.5 px-4 font-semibold text-right">Tarix</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {activeSelectedGroupData.students
                              .filter((st) => {
                                const q = groupInsideQuery.trim().toLowerCase();
                                if (!q) return true;
                                return (
                                  st.firstName.toLowerCase().includes(q) ||
                                  st.lastName.toLowerCase().includes(q) ||
                                  st.fullName.toLowerCase().includes(q)
                                );
                              })
                              .map((st) => (
                                <tr key={st.id} className="hover:bg-slate-50/80">
                                  <td className="py-2.5 px-4 font-semibold text-slate-900">
                                    {st.fullName}
                                  </td>
                                  <td className="py-2.5 px-4 font-mono tabular-nums">
                                    {st.totalBorrowed}
                                  </td>
                                  <td className="py-2.5 px-4 font-mono tabular-nums text-emerald-700">
                                    {st.totalReturned}
                                  </td>
                                  <td className="py-2.5 px-4 font-mono tabular-nums font-semibold text-amber-700">
                                    {st.activeCount}
                                  </td>
                                  <td className="py-2.5 px-4 text-right">
                                    <button
                                      type="button"
                                      onClick={() => setSelectedStudent(st)}
                                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-50 rounded-lg"
                                    >
                                      <Eye className="w-3.5 h-3.5" />
                                      <span>To‘liq tarix</span>
                                    </button>
                                  </td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>

                  {/* Transactions ONLY for this group */}
                  <div className="space-y-2.5">
                    <h4 className="font-display font-bold text-base text-slate-900">
                      {activeSelectedGroupData.label} — kitob olgan va topshirganlar (barcha ma’lumotlar)
                    </h4>
                    {renderTransactionTable(
                      activeSelectedGroupData.transactions.filter((t) => {
                        if (groupTxStatusFilter === 'borrow' && t.type !== 'borrow') {
                          return false;
                        }
                        if (
                          groupTxStatusFilter === 'active' &&
                          !(t.type === 'borrow' && t.status === 'active')
                        ) {
                          return false;
                        }
                        if (groupTxStatusFilter === 'returned' && t.status !== 'returned') {
                          return false;
                        }
                        const q = groupInsideQuery.trim().toLowerCase();
                        if (!q) return true;
                        return (
                          t.studentFirstName.toLowerCase().includes(q) ||
                          t.studentLastName.toLowerCase().includes(q) ||
                          t.studentFullName.toLowerCase().includes(q) ||
                          t.bookTitle.toLowerCase().includes(q) ||
                          t.bookNumber.toLowerCase().includes(q)
                        );
                      }),
                      `«${activeSelectedGroupData.label}» guruhi bo‘yicha operatsiyalar topilmadi.`
                    )}
                  </div>
                </div>
              ) : (
                <div className="space-y-6">
                  {/* Course-level Aggregate Statistics (1-kurs vs 2-kurs) */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {(['1-kurs', '2-kurs'] as const).map((cName) => {
                      const cStat = courseTotals[cName];
                      return (
                        <div
                          key={cName}
                          className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3"
                        >
                          <div className="flex items-center justify-between">
                            <h4 className="font-display font-bold text-base text-slate-900 flex items-center gap-2">
                              <GraduationCap className="w-5 h-5 text-blue-700" />
                              <span>{cName} umumiy statistikasi</span>
                            </h4>
                            <span className="text-xs font-mono font-semibold text-slate-600 tabular-nums">
                              {cStat.groupCount} ta guruh
                            </span>
                          </div>
                          <div className="grid grid-cols-4 gap-2 pt-2 border-t border-slate-100 text-xs">
                            <div>
                              <span className="text-slate-500 block">O‘quvchi</span>
                              <span className="font-mono text-lg font-bold text-slate-900 tabular-nums">
                                {cStat.studentCount}
                              </span>
                            </div>
                            <div>
                              <span className="text-slate-500 block">Kitob olgan</span>
                              <span className="font-mono text-lg font-bold text-blue-700 tabular-nums">
                                {cStat.borrowCount}
                              </span>
                            </div>
                            <div>
                              <span className="text-slate-500 block">Qo‘lda</span>
                              <span className="font-mono text-lg font-bold text-amber-700 tabular-nums">
                                {cStat.activeHoldCount}
                              </span>
                            </div>
                            <div>
                              <span className="text-slate-500 block">Topshirgan</span>
                              <span className="font-mono text-lg font-bold text-emerald-700 tabular-nums">
                                {cStat.returnCount}
                              </span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Course tabs + group search bar */}
                  <div className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div className="relative flex-1 max-w-sm">
                      <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                      <input
                        type="text"
                        value={groupDirectoryFilter}
                        onChange={(e) => setGroupDirectoryFilter(e.target.value)}
                        placeholder="Guruhni qidirish (masalan: 1.1, 2.10)..."
                        className="w-full min-h-[40px] pl-10 pr-4 py-1.5 text-sm rounded-xl border border-slate-300 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
                      />
                    </div>
                    <div className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-xl self-start md:self-auto">
                      {[
                        { id: 'all', label: 'Barcha kurslar' },
                        { id: '1-kurs', label: '1-kurs (1.1–1.9+)' },
                        { id: '2-kurs', label: '2-kurs (2.1–2.10+)' },
                      ].map((cTab) => (
                        <button
                          key={cTab.id}
                          type="button"
                          onClick={() =>
                            setCourseFilterTab(cTab.id as 'all' | '1-kurs' | '2-kurs')
                          }
                          className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap ${
                            courseFilterTab === cTab.id
                              ? 'bg-white text-slate-900 shadow-xs'
                              : 'text-slate-600 hover:text-slate-900'
                          }`}
                        >
                          {cTab.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {(['1-kurs', '2-kurs'] as const)
                    .filter((c) => courseFilterTab === 'all' || courseFilterTab === c)
                    .map((courseName) => {
                      const gq = groupDirectoryFilter.trim().toLowerCase();
                      const gqKey = normalizeGroupKey(gq);
                      const groupsList = courseGroupDirectory[courseName].filter((g) => {
                        if (!gq) return true;
                        return (
                          g.label.toLowerCase().includes(gq) ||
                          (gqKey && g.groupKey.includes(gqKey))
                        );
                      });
                      return (
                        <section key={courseName} className="space-y-3">
                          <div className="flex items-center justify-between">
                            <h4 className="font-display font-bold text-base text-slate-900 flex items-center gap-2">
                              <GraduationCap className="w-5 h-5 text-blue-700" />
                              <span>{courseName} guruhlari</span>
                            </h4>
                            <span className="text-xs text-slate-500 tabular-nums">
                              {groupsList.length} ta guruh
                            </span>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                            {groupsList.map((grp) => (
                              <button
                                key={`${courseName}-${grp.groupKey}`}
                                type="button"
                                onClick={() => {
                                  setSelectedGroupDetail({
                                    course: courseName,
                                    groupKey: grp.groupKey,
                                    label: grp.label,
                                  });
                                  setGroupTxStatusFilter('all');
                                  setGroupInsideQuery('');
                                  setTxPage(1);
                                }}
                                className="text-left bg-white rounded-2xl border border-slate-200 hover:border-blue-500 hover:shadow-md p-4 transition-all space-y-3"
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <div>
                                    <span className="text-[11px] font-semibold uppercase tracking-wider text-blue-700 block">
                                      {courseName}
                                    </span>
                                    <h5 className="font-display font-bold text-lg text-slate-900">
                                      {grp.label}
                                    </h5>
                                  </div>
                                  {grp.activeHoldCount > 0 ? (
                                    <span className="px-2 py-1 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-[11px] font-bold tabular-nums">
                                      {grp.activeHoldCount} ta qo‘lda
                                    </span>
                                  ) : (
                                    <span className="px-2 py-1 rounded-lg bg-slate-100 text-slate-600 text-[11px] font-medium">
                                      {grp.borrowCount > 0 ? 'Topshirilgan' : 'Bo‘sh'}
                                    </span>
                                  )}
                                </div>

                                <div className="grid grid-cols-4 gap-1.5 pt-2 border-t border-slate-100 text-[11px]">
                                  <div>
                                    <span className="text-slate-500 block">O‘quvchi</span>
                                    <span className="font-mono font-bold text-slate-900 tabular-nums">
                                      {grp.students.length}
                                    </span>
                                  </div>
                                  <div>
                                    <span className="text-slate-500 block">Olgan</span>
                                    <span className="font-mono font-bold text-blue-700 tabular-nums">
                                      {grp.borrowCount}
                                    </span>
                                  </div>
                                  <div>
                                    <span className="text-slate-500 block">Qo‘lda</span>
                                    <span className="font-mono font-bold text-amber-700 tabular-nums">
                                      {grp.activeHoldCount}
                                    </span>
                                  </div>
                                  <div>
                                    <span className="text-slate-500 block">Topsh.</span>
                                    <span className="font-mono font-bold text-emerald-700 tabular-nums">
                                      {grp.returnCount}
                                    </span>
                                  </div>
                                </div>
                              </button>
                            ))}
                          </div>
                        </section>
                      );
                    })}
                </div>
              )}
            </div>
          )}

          {/* 4. KITOB OLGAN O‘QUVCHILAR */}
          {activeMenu === 'borrowers' &&
            renderTransactionTable(borrowTxs, 'Hali kitob olgan o‘quvchilar mavjud emas.')}

          {/* 5. KITOB TOPSHIRGAN O‘QUVCHILAR */}
          {activeMenu === 'returners' &&
            renderTransactionTable(returnTxs, 'Hali kitob topshirgan o‘quvchilar mavjud emas.')}

          {/* 6. HOZIRDA KITOBNI SAQLAYOTGANLAR */}
          {activeMenu === 'currently-holding' &&
            renderTransactionTable(
              activeHoldingTxs,
              'Hozirda o‘quvchilar qo‘lida qaytarilmagan kitob yo‘q.'
            )}

          {/* 7. BARCHA OPERATSIYALAR TARIXI */}
          {activeMenu === 'history' &&
            renderTransactionTable(transactions, 'Operatsiyalar tarixi bo‘sh.')}

          {/* 8. O‘QUVCHILAR BAZASI */}
          {activeMenu === 'students' && (
            <div className="space-y-4">
              <div className="bg-white rounded-2xl border border-slate-200 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="relative flex-1 max-w-md">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={studentListQuery}
                    onChange={(e) => setStudentListQuery(e.target.value)}
                    placeholder="O‘quvchi ismi, familiyasi yoki guruhi (1.1, 2.10) bo‘yicha qidirish..."
                    className="w-full min-h-[42px] pl-10 pr-4 py-2 text-sm rounded-xl border border-slate-300 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
                <div className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-xl self-start sm:self-auto">
                  {[
                    { id: 'all', label: `Barchasi (${students.length})` },
                    { id: '1-kurs', label: '1-kurs' },
                    { id: '2-kurs', label: '2-kurs' },
                  ].map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() =>
                        setStudentCourseFilter(tab.id as 'all' | '1-kurs' | '2-kurs')
                      }
                      className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
                        studentCourseFilter === tab.id
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
                {filteredStudentsList.length === 0 ? (
                  <div className="p-10 text-center text-sm text-slate-500">
                    Qidiruv bo‘yicha o‘quvchilar topilmadi.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs sm:text-sm">
                      <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 text-xs">
                        <tr>
                          <th className="py-3 px-4 font-semibold">Ism-familiya</th>
                          <th className="py-3 px-4 font-semibold">Guruh</th>
                          <th className="py-3 px-4 font-semibold">Kurs</th>
                          <th className="py-3 px-4 font-semibold">Olgan kitoblari</th>
                          <th className="py-3 px-4 font-semibold">Topshirgan</th>
                          <th className="py-3 px-4 font-semibold">Hozir o‘zida</th>
                          <th className="py-3 px-4 font-semibold text-right">Tarix</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {filteredStudentsList.map((st) => (
                          <tr key={st.id} className="hover:bg-slate-50/80">
                            <td className="py-3 px-4 font-semibold text-slate-900">{st.fullName}</td>
                            <td className="py-3 px-4 text-slate-700">{st.group}</td>
                            <td className="py-3 px-4 text-slate-700">{st.course}</td>
                            <td className="py-3 px-4 font-mono tabular-nums">{st.totalBorrowed}</td>
                            <td className="py-3 px-4 font-mono tabular-nums text-emerald-700">
                              {st.totalReturned}
                            </td>
                            <td className="py-3 px-4 font-mono tabular-nums font-semibold text-amber-700">
                              {st.activeCount}
                            </td>
                            <td className="py-3 px-4 text-right">
                              <button
                                type="button"
                                onClick={() => setSelectedStudent(st)}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-50 rounded-lg transition-colors"
                              >
                                <Eye className="w-3.5 h-3.5" />
                                <span>To‘liq tarix</span>
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 9. QIDIRUV */}
          {activeMenu === 'search' && (
            <div className="space-y-5">
              <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-4">
                <div className="relative">
                  <Search className="w-5 h-5 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={globalQuery}
                    onChange={(e) => setGlobalQuery(e.target.value)}
                    placeholder="Ism, familiya (masalan: Aliyev), guruh, kurs, kitob nomi yoki raqami bo‘yicha qidiring..."
                    className="w-full min-h-[48px] pl-11 pr-4 py-2.5 text-sm rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <div className="inline-flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-xl">
                    {[
                      { id: 'all', label: 'Barchasi' },
                      { id: 'borrowed', label: 'Faqat kitob olganlar' },
                      { id: 'returned', label: 'Kitobni topshirganlar' },
                      { id: 'unreturned', label: 'Hali topshirmaganlar' },
                      { id: 'overdue', label: 'Muddati o‘tganlar' },
                    ].map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() =>
                          setTxStatusFilter(
                            tab.id as 'all' | 'borrowed' | 'returned' | 'unreturned' | 'overdue'
                          )
                        }
                        className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
                          txStatusFilter === tab.id
                            ? 'bg-white text-slate-900 shadow-xs'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>

                  <select
                    value={groupFilter}
                    onChange={(e) => setGroupFilter(e.target.value)}
                    aria-label="Guruh bo‘yicha saralash"
                    className="min-h-[38px] px-3 py-1.5 text-xs font-semibold rounded-xl border border-slate-300 bg-white"
                  >
                    <option value="all">Barcha guruhlar</option>
                    {distinctGroups.map((g) => (
                      <option key={g} value={g}>
                        {g}
                      </option>
                    ))}
                  </select>

                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-slate-500">Sana:</span>
                    <input
                      type="date"
                      value={dateFrom}
                      onChange={(e) => setDateFrom(e.target.value)}
                      className="min-h-[36px] px-2.5 py-1 rounded-lg border border-slate-300 font-mono"
                    />
                    <span className="text-slate-400">—</span>
                    <input
                      type="date"
                      value={dateTo}
                      onChange={(e) => setDateTo(e.target.value)}
                      className="min-h-[36px] px-2.5 py-1 rounded-lg border border-slate-300 font-mono"
                    />
                  </div>
                </div>
              </div>

              {renderTransactionTable(
                filteredSearchTxs,
                'Qidiruv va filtr shartlariga mos yozuvlar topilmadi.'
              )}
            </div>
          )}

          {/* 10. HISOBOTLAR */}
          {activeMenu === 'reports' && (
            <div className="space-y-5">
              <div className="bg-white rounded-2xl border border-slate-200 p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4 no-print">
                <div className="flex flex-wrap items-center gap-2">
                  {REPORT_TYPES.map((rep) => (
                    <button
                      key={rep.id}
                      type="button"
                      onClick={() => setSelectedReport(rep.id)}
                      className={`px-3.5 py-2 text-xs font-semibold rounded-xl border transition-colors ${
                        selectedReport === rep.id
                          ? 'bg-[#0F2942] text-white border-[#0F2942]'
                          : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      {rep.label}
                    </button>
                  ))}
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => exportReportToExcel(currentReportData, selectedReport)}
                    className="inline-flex items-center gap-2 min-h-[42px] px-4 py-2 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-xl transition-colors"
                  >
                    <FileSpreadsheet className="w-4 h-4" />
                    <span>Excel (.xlsx)</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => exportReportToPdf(currentReportData, selectedReport)}
                    className="inline-flex items-center gap-2 min-h-[42px] px-4 py-2 text-xs font-semibold text-white bg-red-700 hover:bg-red-800 rounded-xl transition-colors"
                  >
                    <FileText className="w-4 h-4" />
                    <span>PDF (.pdf)</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => window.print()}
                    className="inline-flex items-center gap-2 min-h-[42px] px-4 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors"
                  >
                    <Printer className="w-4 h-4" />
                    <span>Chop etish</span>
                  </button>
                </div>
              </div>

              <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
                <div className="px-6 py-4 border-b border-slate-200">
                  <h3 className="font-display font-bold text-lg text-slate-900">
                    {currentReportData.title}
                  </h3>
                  <p className="text-xs text-slate-500 mt-0.5">{currentReportData.subtitle}</p>
                </div>
                {currentReportData.rows.length === 0 ? (
                  <div className="p-10 text-center text-sm text-slate-500">
                    Tanlangan davr yoki mezon bo‘yicha ma’lumot mavjud emas.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs sm:text-sm">
                      <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 text-xs">
                        <tr>
                          {currentReportData.columns.map((col) => (
                            <th key={col} className="py-3 px-4 font-semibold">
                              {col}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {currentReportData.rows.map((row, idx) => (
                          <tr key={idx} className="hover:bg-slate-50/70">
                            {row.map((cell, cIdx) => (
                              <td
                                key={cIdx}
                                className={`py-3 px-4 tabular-nums ${
                                  String(cell) === 'Muddati o‘tgan'
                                    ? 'text-red-700 font-bold'
                                    : 'text-slate-800'
                                }`}
                              >
                                {cell}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 11. SOZLAMALAR, ZAXIRA NUSXA VA ADMIN HARAKATLARI */}
          {activeMenu === 'settings' && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="space-y-6">
                  {/* Change Admin Password */}
                  <form
                    onSubmit={handleUpdatePassword}
                    className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4"
                  >
                    <div className="flex items-center gap-2.5">
                      <KeyRound className="w-5 h-5 text-blue-700" />
                      <h3 className="font-display font-bold text-lg text-slate-900">
                        Administrator parolini almashtirish
                      </h3>
                    </div>
                    <p className="text-xs text-slate-500">
                      Parol ma’lumotlar bazasida ochiq matnda emas, PBKDF2-SHA256 xesh shaklida
                      saqlanadi.
                    </p>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">
                        Joriy parol
                      </label>
                      <input
                        type="password"
                        required
                        value={currPwd}
                        onChange={(e) => setCurrPwd(e.target.value)}
                        className="w-full min-h-[42px] px-3.5 py-2 text-sm rounded-xl border border-slate-300"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">
                        Yangi parol
                      </label>
                      <input
                        type="password"
                        required
                        value={newPwd}
                        onChange={(e) => setNewPwd(e.target.value)}
                        className="w-full min-h-[42px] px-3.5 py-2 text-sm rounded-xl border border-slate-300"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">
                        Yangi parolni tasdiqlang
                      </label>
                      <input
                        type="password"
                        required
                        value={confirmPwd}
                        onChange={(e) => setConfirmPwd(e.target.value)}
                        className="w-full min-h-[42px] px-3.5 py-2 text-sm rounded-xl border border-slate-300"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={isBusy}
                      className="min-h-[44px] px-5 py-2 text-sm font-semibold text-white bg-[#0F2942] hover:bg-slate-800 rounded-xl transition-colors disabled:opacity-60"
                    >
                      Admin parolini yangilash
                    </button>
                  </form>

                  {/* Change App Gate Password */}
                  <form
                    onSubmit={handleUpdateAppGatePassword}
                    className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4"
                  >
                    <div className="flex items-center gap-2.5">
                      <ShieldCheck className="w-5 h-5 text-emerald-700" />
                      <h3 className="font-display font-bold text-lg text-slate-900">
                        Ilovaga kirish parolini almashtirish
                      </h3>
                    </div>
                    <p className="text-xs text-slate-500">
                      Barcha foydalanuvchilar ilovaga kirishda so‘raladigan umumiy kirish parolini
                      yangilash.
                    </p>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">
                        Joriy ilovaga kirish paroli
                      </label>
                      <input
                        type="password"
                        required
                        value={currGatePwd}
                        onChange={(e) => setCurrGatePwd(e.target.value)}
                        className="w-full min-h-[42px] px-3.5 py-2 text-sm rounded-xl border border-slate-300"
                      />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-semibold text-slate-700 mb-1">
                          Yangi parol
                        </label>
                        <input
                          type="password"
                          required
                          value={newGatePwd}
                          onChange={(e) => setNewGatePwd(e.target.value)}
                          className="w-full min-h-[42px] px-3.5 py-2 text-sm rounded-xl border border-slate-300"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-700 mb-1">
                          Parolni tasdiqlang
                        </label>
                        <input
                          type="password"
                          required
                          value={confirmGatePwd}
                          onChange={(e) => setConfirmGatePwd(e.target.value)}
                          className="w-full min-h-[42px] px-3.5 py-2 text-sm rounded-xl border border-slate-300"
                        />
                      </div>
                    </div>
                    <button
                      type="submit"
                      disabled={isBusy}
                      className="min-h-[44px] px-5 py-2 text-sm font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-xl transition-colors disabled:opacity-60"
                    >
                      Kirish parolini yangilash
                    </button>
                  </form>
                </div>

                {/* General Settings & Backup */}
                <div className="space-y-6">
                  <form
                    onSubmit={handleSaveSettings}
                    className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4"
                  >
                    <h3 className="font-display font-bold text-lg text-slate-900">
                      Kutubxona sozlamalari
                    </h3>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">
                        Muassasa nomi
                      </label>
                      <input
                        type="text"
                        required
                        value={instName}
                        onChange={(e) => setInstName(e.target.value)}
                        className="w-full min-h-[42px] px-3.5 py-2 text-sm rounded-xl border border-slate-300"
                      />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-semibold text-slate-700 mb-1">
                          Kutubxona nomi
                        </label>
                        <input
                          type="text"
                          required
                          value={libName}
                          onChange={(e) => setLibName(e.target.value)}
                          className="w-full min-h-[42px] px-3.5 py-2 text-sm rounded-xl border border-slate-300"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-700 mb-1">
                          Standart qaytarish muddati (kun)
                        </label>
                        <input
                          type="number"
                          min={1}
                          max={365}
                          required
                          value={loanDays}
                          onChange={(e) => setLoanDays(Number(e.target.value))}
                          className="w-full min-h-[42px] px-3.5 py-2 text-sm font-mono rounded-xl border border-slate-300"
                        />
                      </div>
                    </div>
                    <button
                      type="submit"
                      disabled={isBusy}
                      className="min-h-[44px] px-5 py-2 text-sm font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-xl transition-colors"
                    >
                      Sozlamalarni saqlash
                    </button>
                  </form>

                  <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-3">
                    <div className="flex items-center gap-2.5">
                      <Database className="w-5 h-5 text-emerald-700" />
                      <h3 className="font-display font-bold text-lg text-slate-900">
                        Ma’lumotlarni zaxiralash (Backup)
                      </h3>
                    </div>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      Barcha kitoblar, o‘quvchilar, operatsiyalar tarixi, elektron imzolar va
                      sozlamalarning to‘liq zaxira nusxasini JSON fayl ko‘rinishida yuklab oling.
                    </p>
                    {settings.lastBackupAt && (
                      <p className="text-xs font-mono text-slate-500 tabular-nums">
                        Oxirgi zaxira nusxa: {formatUzDateTime(settings.lastBackupAt)}
                      </p>
                    )}
                    <button
                      type="button"
                      onClick={handleDownloadBackup}
                      disabled={isBusy}
                      className="inline-flex items-center gap-2 min-h-[44px] px-5 py-2 text-sm font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-xl transition-colors"
                    >
                      <Download className="w-4 h-4" />
                      <span>Zaxira nusxasini yuklab olish (.json)</span>
                    </button>
                  </div>
                </div>
              </div>

              {/* Activity Logs */}
              <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
                <div className="px-6 py-4 border-b border-slate-200 flex items-center gap-2.5">
                  <Activity className="w-5 h-5 text-blue-700" />
                  <h3 className="font-display font-bold text-base text-slate-900">
                    Admin harakatlari tarixi (Audit jurnali)
                  </h3>
                </div>
                {activityLogs.length === 0 ? (
                  <div className="p-8 text-center text-xs text-slate-500">
                    Hali harakatlar qayd etilmagan.
                  </div>
                ) : (
                  <div className="overflow-x-auto max-h-96 overflow-y-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 sticky top-0">
                        <tr>
                          <th className="py-2.5 px-4 font-semibold">Sana va vaqt</th>
                          <th className="py-2.5 px-4 font-semibold">Harakat</th>
                          <th className="py-2.5 px-4 font-semibold">Obyekt</th>
                          <th className="py-2.5 px-4 font-semibold">Tafsilotlar</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {activityLogs.map((log) => (
                          <tr key={log.id} className="hover:bg-slate-50/70">
                            <td className="py-2.5 px-4 font-mono text-slate-500 tabular-nums whitespace-nowrap">
                              {formatUzDateTime(log.createdAt)}
                            </td>
                            <td className="py-2.5 px-4 font-semibold text-slate-900">
                              {log.action}
                            </td>
                            <td className="py-2.5 px-4 text-slate-700">{log.targetLabel}</td>
                            <td className="py-2.5 px-4 text-slate-600">{log.details}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
            </>
          )}
        </main>
      </div>

      {/* Delete Book Confirmation Modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-2xl bg-white border border-slate-200 p-6 space-y-4 shadow-2xl">
            <h3 className="font-display font-bold text-lg text-slate-900">
              Kitobni katalogdan o‘chirish
            </h3>
            <p className="text-sm text-slate-600">
              «{deleteTarget.title}» (№ {deleteTarget.bookNumber}) kitobini katalogdan o‘chirishni
              tasdiqlaysizmi?
            </p>
            {getBookAvailableCount(deleteTarget) < Math.max(1, deleteTarget.quantity || 1) && (
              <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
                Diqqat: Bu kitobning ayrim nusxalari hozirda o‘quvchilarda turibdi. O‘chirilsa ham avvalgi olish-topshirish tarixi saqlanadi.
              </div>
            )}
            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="min-h-[42px] px-4 py-2 text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-xl"
              >
                Bekor qilish
              </button>
              <button
                type="button"
                onClick={confirmSoftDelete}
                className="min-h-[42px] px-4 py-2 text-sm font-semibold text-white bg-red-700 hover:bg-red-800 rounded-xl"
              >
                Ha, o‘chirish
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Single Transaction Delete Confirmation Modal */}
      {deleteTxTarget && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-2xl bg-white border border-slate-200 p-6 space-y-4 shadow-2xl">
            <h3 className="font-display font-bold text-lg text-slate-900">
              Operatsiya yozuvini o‘chirish
            </h3>
            <div className="rounded-xl bg-slate-50 border border-slate-200 p-3.5 text-sm space-y-1">
              <p className="font-semibold text-slate-900">{deleteTxTarget.studentFullName}</p>
              <p className="text-xs text-slate-600">
                {deleteTxTarget.studentGroup} · {deleteTxTarget.studentCourse}
              </p>
              <p className="text-xs font-medium text-blue-800 pt-1">
                № {deleteTxTarget.bookNumber} · {deleteTxTarget.bookTitle}
              </p>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">
              Ushbu {deleteTxTarget.type === 'borrow' ? 'kitob olish' : 'kitob topshirish'} yozuvini o‘chirishni tasdiqlaysizmi?
              {deleteTxTarget.type === 'borrow' && deleteTxTarget.status === 'active'
                ? ' Kitob nusxasi katalogda qayta mavjud holatga qaytadi.'
                : ''}
            </p>
            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                disabled={isDeletingTx}
                onClick={() => setDeleteTxTarget(null)}
                className="min-h-[42px] px-4 py-2 text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-xl"
              >
                Bekor qilish
              </button>
              <button
                type="button"
                disabled={isDeletingTx}
                onClick={confirmDeleteSingleTx}
                className="min-h-[42px] px-4 py-2 text-sm font-semibold text-white bg-red-700 hover:bg-red-800 rounded-xl disabled:opacity-60"
              >
                {isDeletingTx ? 'O‘chirilmoqda...' : 'Ha, o‘chirish'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Clear All Transactions Confirmation Modal */}
      {confirmClearAllOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-2xl bg-white border border-slate-200 p-6 space-y-4 shadow-2xl">
            <div className="flex items-center gap-2.5 text-red-700">
              <AlertTriangle className="w-6 h-6 shrink-0" />
              <h3 className="font-display font-bold text-lg text-slate-900">
                Barcha olish-topshirish yozuvlarini tozalash (Clear All)
              </h3>
            </div>
            <p className="text-sm text-slate-600 leading-relaxed">
              Diqqat! <strong>Faqat</strong> kitob olgan, topshirgan va hali topshirilmagan barcha o‘quvchilar tarixi o‘chiriladi ({transactions.length} ta operatsiya).
            </p>
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900">
              Katalogdagi barcha kitoblar saqlanib qoladi va barcha nusxalar qayta mavjud holatga tiklanadi.
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                disabled={isClearingAll}
                onClick={() => setConfirmClearAllOpen(false)}
                className="min-h-[42px] px-4 py-2 text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-xl"
              >
                Bekor qilish
              </button>
              <button
                type="button"
                disabled={isClearingAll}
                onClick={confirmClearAll}
                className="min-h-[42px] px-5 py-2 text-sm font-semibold text-white bg-red-700 hover:bg-red-800 rounded-xl disabled:opacity-60"
              >
                {isClearingAll ? 'Tozalanmoqda...' : 'Ha, Clear All'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Admin Direct Return Modal */}
      {returnTargetTx && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-2xl bg-white border border-slate-200 p-6 space-y-4 shadow-2xl">
            <h3 className="font-display font-bold text-lg text-slate-900">
              Kitobni topshirilgan deb belgilash
            </h3>
            <div className="rounded-xl bg-slate-50 border border-slate-200 p-3.5 text-sm space-y-1">
              <p className="font-semibold text-slate-900">{returnTargetTx.studentFullName}</p>
              <p className="text-xs text-slate-600">
                {returnTargetTx.studentGroup} · {returnTargetTx.studentCourse}
              </p>
              <p className="text-xs font-medium text-blue-800 pt-1">
                № {returnTargetTx.bookNumber} · {returnTargetTx.bookTitle}
              </p>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-semibold text-slate-700 block">
                Topshirilgan sana (kun, oy, yil)
              </label>
              <UzDateSelects
                value={adminReturnDateStr}
                onChange={setAdminReturnDateStr}
                labelPrefix="Topshirish sanasi"
              />
            </div>

            <p className="text-xs text-slate-500 leading-relaxed">
              Tasdiqlangandan so‘ng yozuv «To‘liq topshirilgan» holatiga o‘tadi, tarixda abadiy saqlanadi va kitob katalogda qulfdan ochilib qayta mavjud bo‘ladi.
            </p>

            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                disabled={isReturningTx}
                onClick={() => setReturnTargetTx(null)}
                className="min-h-[42px] px-4 py-2 text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-xl"
              >
                Bekor qilish
              </button>
              <button
                type="button"
                disabled={isReturningTx}
                onClick={confirmAdminReturn}
                className="min-h-[42px] px-5 py-2 text-sm font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-xl disabled:opacity-60"
              >
                {isReturningTx ? 'Saqlanmoqda...' : 'Tasdiqlash va topshirish'}
              </button>
            </div>
          </div>
        </div>
      )}

      <TransactionDetailModal
        transaction={selectedTx}
        signatures={signatures}
        onClose={() => setSelectedTx(null)}
        onRequestReturn={openAdminReturnModal}
        onDeleteTransaction={(tx) => setDeleteTxTarget(tx)}
      />

      <StudentHistoryModal
        student={selectedStudent}
        transactions={transactions}
        signatures={signatures}
        onClose={() => setSelectedStudent(null)}
        onRequestReturn={openAdminReturnModal}
      />
    </div>
  );
}

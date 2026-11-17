import { useDeferredValue, useMemo, useState } from 'react';
import {
  ArrowLeftRight,
  BookCheck,
  BookOpen,
  BookPlus,
  Lock,
  RefreshCw,
  Search,
  ShieldCheck,
  WifiOff,
} from 'lucide-react';
import { BookCoverImage } from './BookCoverImage.tsx';
import { BookDetailModal } from './BookDetailModal.tsx';
import { BorrowReturnModal } from './BorrowReturnModal.tsx';
import { NewBookBorrowModal } from './NewBookBorrowModal.tsx';
import { getBookAvailableCount } from '../lib/libraryService.ts';
import { smartFilterBooks } from '../lib/autonomousEngine.ts';
import { isOverdueDate } from '../lib/imageUtils.ts';
import type { Book, LibrarySetting, OfflinePendingAction } from '../types.ts';

interface StudentKioskProps {
  books: Book[];
  isLoading: boolean;
  settings: LibrarySetting;
  isOnline: boolean;
  offlineQueue: OfflinePendingAction[];
  onOfflineQueueChange: (next: OfflinePendingAction[]) => void;
  onRetryOfflineQueue: () => void;
  onOpenAdminLogin: () => void;
  onLockApp?: () => void;
}

export function StudentKiosk({
  books,
  isLoading,
  settings,
  isOnline,
  offlineQueue,
  onOfflineQueueChange,
  onRetryOfflineQueue,
  onOpenAdminLogin,
  onLockApp,
}: StudentKioskProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'mavjud' | 'olingan'>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [selectedBook, setSelectedBook] = useState<Book | null>(null);
  const [isNewBookOpen, setIsNewBookOpen] = useState(false);
  const [modalState, setModalState] = useState<{
    mode: 'borrow' | 'return' | null;
    book: Book | null;
  }>({ mode: null, book: null });

  const activeBooks = useMemo(() => books.filter((b) => b.isActive), [books]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    activeBooks.forEach((b) => {
      if (b.category) set.add(b.category);
    });
    return Array.from(set).sort();
  }, [activeBooks]);

  const stats = useMemo(() => {
    const total = activeBooks.length;
    const available = activeBooks.filter((b) => getBookAvailableCount(b) > 0).length;
    const locked = activeBooks.filter((b) => getBookAvailableCount(b) <= 0).length;
    return { total, available, locked };
  }, [activeBooks]);

  const suggestedNextNumber = useMemo(() => {
    let maxNum = 0;
    books.forEach((b) => {
      const parsed = parseInt((b.bookNumber || '').replace(/\D/g, ''), 10);
      if (!Number.isNaN(parsed) && parsed > maxNum) maxNum = parsed;
    });
    return String(maxNum + 1).padStart(3, '0');
  }, [books]);

  const deferredSearchQuery = useDeferredValue(searchQuery);

  const filteredBooks = useMemo(() => {
    const preFiltered = activeBooks.filter((b) => {
      const avail = getBookAvailableCount(b);
      if (statusFilter === 'mavjud' && avail <= 0) return false;
      if (statusFilter === 'olingan' && avail > 0) return false;
      if (categoryFilter !== 'all' && b.category !== categoryFilter) return false;
      return true;
    });
    const q = deferredSearchQuery.trim();
    if (!q) return preFiltered;
    return smartFilterBooks(preFiltered, q);
  }, [activeBooks, deferredSearchQuery, statusFilter, categoryFilter]);

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      {/* Top Bar Contract: Brand — Nav Links — Single Primary Action */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-sm border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-6">
          <a
            href="#top"
            className="flex items-center gap-2.5 font-display font-bold text-slate-900 whitespace-nowrap shrink-0"
          >
            <span className="w-8 h-8 rounded-lg bg-[#0F2942] text-white flex items-center justify-center shrink-0">
              <ShieldCheck className="w-4 h-4" />
            </span>
            <span className="text-base sm:text-lg tracking-tight">
              {settings.institutionName}
            </span>
          </a>

          <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-slate-600">
            <a
              href="#katalog"
              className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
            >
              Katalog
            </a>
            <button
              type="button"
              onClick={() => setModalState({ mode: 'borrow', book: null })}
              className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
            >
              Kitob olish
            </button>
            <button
              type="button"
              onClick={() => setModalState({ mode: 'return', book: null })}
              className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
            >
              Kitob topshirish
            </button>
          </nav>

          <div className="shrink-0 flex items-center gap-2">
            {onLockApp && (
              <button
                type="button"
                onClick={onLockApp}
                title="Ilovani qulflash"
                className="inline-flex items-center gap-1.5 min-h-[40px] px-3 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors whitespace-nowrap shrink-0"
              >
                <Lock className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Qulflash</span>
              </button>
            )}
            <button
              type="button"
              onClick={onOpenAdminLogin}
              className="inline-flex items-center gap-2 min-h-[40px] px-4 py-2 text-xs sm:text-sm font-semibold text-white bg-[#0F2942] hover:bg-slate-800 rounded-xl transition-colors whitespace-nowrap shrink-0"
            >
              <Lock className="w-3.5 h-3.5" />
              <span>Admin panel</span>
            </button>
          </div>
        </div>
      </header>

      {/* Hero / Kiosk Control Banner */}
      <section id="top" className="bg-white border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-10">
          <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-6">
            <div className="space-y-2 max-w-2xl">
              <p className="text-xs font-semibold tracking-wider uppercase text-blue-700">
                {settings.institutionName}
              </p>
              <h1 className="font-display text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight text-balance">
                {settings.libraryName}
              </h1>
              <p className="text-sm sm:text-base text-slate-600 leading-relaxed">
                Katalogdan kerakli kitobni tanlang va mustaqil ravishda kitob olish yoki
                topshirishni elektron imzo bilan rasmiylashtiring.
              </p>
            </div>

            <div className="grid grid-cols-2 sm:flex sm:flex-nowrap items-center gap-3 shrink-0">
              <button
                type="button"
                onClick={() => setModalState({ mode: 'borrow', book: null })}
                className="inline-flex items-center justify-center gap-2 min-h-[52px] px-4 sm:px-6 py-3 text-xs sm:text-sm font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-xl shadow-xs transition-colors whitespace-nowrap"
              >
                <BookCheck className="w-4 h-4 sm:w-5 sm:h-5 shrink-0" />
                <span>KITOB OLISH</span>
              </button>
              <button
                type="button"
                onClick={() => setModalState({ mode: 'return', book: null })}
                className="inline-flex items-center justify-center gap-2 min-h-[52px] px-4 sm:px-6 py-3 text-xs sm:text-sm font-semibold text-slate-900 bg-white border border-slate-300 hover:bg-slate-50 rounded-xl transition-colors whitespace-nowrap"
              >
                <ArrowLeftRight className="w-4 h-4 sm:w-5 sm:h-5 text-slate-700 shrink-0" />
                <span>KITOB TOPSHIRISH</span>
              </button>
            </div>
          </div>

          {/* Search & Offline Queue Alert */}
          <div className="mt-6 space-y-3">
            <div className="relative">
              <Search className="w-5 h-5 text-slate-400 absolute left-4 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Kitob nomi, muallif yoki maxsus raqam (masalan: 001) bo‘yicha qidiring..."
                className="w-full min-h-[52px] pl-12 pr-4 py-3 text-base rounded-xl border border-slate-300 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-600 transition-colors"
              />
            </div>

            {(!isOnline || offlineQueue.length > 0) && (
              <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-sm text-amber-900">
                <div className="flex items-center gap-2.5">
                  <WifiOff className="w-4 h-4 text-amber-700 shrink-0" />
                  <span>
                    {!isOnline
                      ? 'Internet aloqasi vaqtincha uzilgan.'
                      : 'Internet tiklandi.'}{' '}
                    {offlineQueue.length > 0
                      ? `Navbatda ${offlineQueue.length} ta yuborilmagan operatsiya saqlanmoqda.`
                      : 'Yangi operatsiyalar keyin yuborish uchun saqlanadi.'}
                  </span>
                </div>
                {offlineQueue.length > 0 && isOnline && (
                  <button
                    type="button"
                    onClick={onRetryOfflineQueue}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold bg-amber-900 text-white rounded-lg hover:bg-amber-800 transition-colors"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Hozir yuborish</span>
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Catalog Main Section */}
      <main id="katalog" className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="inline-flex items-center gap-1 p-1 bg-slate-200/75 rounded-xl">
              <button
                type="button"
                onClick={() => setStatusFilter('all')}
                className={`min-h-[38px] px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap ${
                  statusFilter === 'all'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Barchasi
              </button>
              <button
                type="button"
                onClick={() => setStatusFilter('mavjud')}
                className={`min-h-[38px] px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap ${
                  statusFilter === 'mavjud'
                    ? 'bg-white text-emerald-700 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Mavjud
              </button>
              <button
                type="button"
                onClick={() => setStatusFilter('olingan')}
                className={`min-h-[38px] px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap ${
                  statusFilter === 'olingan'
                    ? 'bg-white text-amber-700 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Tugagan
              </button>
            </div>

            {categories.length > 0 && (
              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                aria-label="Fan bo‘yicha filtrlash"
                className="min-h-[42px] px-3.5 py-2 text-xs font-semibold rounded-xl border border-slate-300 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-600"
              >
                <option value="all">Barcha fanlar</option>
                {categories.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
            )}

            {/* Dedicated Button right beside Catalog for borrowing unlisted new books */}
            <button
              type="button"
              onClick={() => setIsNewBookOpen(true)}
              className="inline-flex items-center gap-2 min-h-[42px] px-4 py-2 text-xs sm:text-sm font-semibold text-white bg-[#0F2942] hover:bg-slate-800 rounded-xl shadow-xs transition-colors whitespace-nowrap"
            >
              <BookPlus className="w-4 h-4 shrink-0" />
              <span>Yangi kitob olish</span>
            </button>
          </div>

          <div className="flex items-center gap-2 text-xs text-slate-600 tabular-nums">
            <span>{stats.total} ta kitob</span>
            <span aria-hidden="true">·</span>
            <span className="text-emerald-700 font-medium">{stats.available} ta mavjud</span>
            <span aria-hidden="true">·</span>
            <span className="text-amber-700 font-medium">{stats.locked} ta tugagan</span>
          </div>
        </div>

        {isLoading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className="rounded-2xl border border-slate-200 bg-white overflow-hidden animate-pulse"
              >
                <div className="aspect-[3/4] bg-slate-200" />
                <div className="p-4 space-y-2.5">
                  <div className="h-3 w-20 bg-slate-200 rounded" />
                  <div className="h-4 w-full bg-slate-200 rounded" />
                  <div className="h-3 w-2/3 bg-slate-200 rounded" />
                </div>
              </div>
            ))}
          </div>
        ) : filteredBooks.length === 0 ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-12 text-center space-y-3">
            <BookOpen className="w-10 h-10 text-slate-300 mx-auto" />
            <h3 className="font-display text-lg font-semibold text-slate-900">
              Kitoblar topilmadi
            </h3>
            <p className="text-sm text-slate-500 max-w-md mx-auto">
              Agar qidirayotgan kitobingiz hali katalogda bo‘lmasa, «Yangi kitob olish» tugmasi orqali uni rasmga olib rasmiylashtirishingiz mumkin.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2.5 pt-1">
              <button
                type="button"
                onClick={() => setIsNewBookOpen(true)}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-[#0F2942] hover:bg-slate-800 rounded-xl transition-colors"
              >
                <BookPlus className="w-4 h-4" />
                <span>Yangi kitob olish</span>
              </button>
              {(searchQuery || statusFilter !== 'all' || categoryFilter !== 'all') && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery('');
                    setStatusFilter('all');
                    setCategoryFilter('all');
                  }}
                  className="inline-flex items-center px-4 py-2 text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-xl transition-colors"
                >
                  Filtrlarni tozalash
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-5">
            {filteredBooks.map((book) => {
              const totalQty = Math.max(1, book.quantity || 1);
              const availQty = getBookAvailableCount(book);
              const isAvailable = availQty > 0;
              const overdue = !isAvailable && isOverdueDate(book.currentDueDate);
              return (
                <button
                  key={book.id}
                  type="button"
                  onClick={() => setSelectedBook(book)}
                  className="group text-left rounded-2xl border border-slate-200 bg-white overflow-hidden hover:border-blue-500 hover:shadow-md transition-all flex flex-col focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                >
                  <div className="aspect-[3/4] w-full overflow-hidden bg-slate-100 border-b border-slate-100 relative">
                    <BookCoverImage
                      coverUrl={book.coverUrl}
                      title={book.title}
                      bookNumber={book.bookNumber}
                      className={`w-full h-full group-hover:scale-[1.03] transition-transform duration-200 ${
                        !isAvailable ? 'opacity-70 grayscale-[35%]' : ''
                      }`}
                    />
                    {!isAvailable && (
                      <div className="absolute inset-0 bg-slate-950/35 flex items-center justify-center">
                        <div className="bg-slate-900/90 text-white px-3 py-1.5 rounded-xl flex items-center gap-1.5 text-xs font-semibold shadow-sm">
                          <Lock className="w-3.5 h-3.5 text-amber-300" />
                          <span>Tugagan</span>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="p-4 flex-1 flex flex-col justify-between gap-2 w-full">
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="font-mono font-semibold text-slate-500 tabular-nums">
                          № {book.bookNumber}
                        </span>
                        <span
                          className={`inline-flex items-center gap-1 font-semibold tabular-nums ${
                            isAvailable
                              ? 'text-emerald-700'
                              : overdue
                                ? 'text-red-700'
                                : 'text-amber-700'
                          }`}
                        >
                          {isAvailable ? (
                            <BookCheck className="w-3.5 h-3.5 shrink-0" />
                          ) : (
                            <Lock className="w-3.5 h-3.5 shrink-0" />
                          )}
                          <span>
                            {isAvailable
                              ? totalQty > 1
                                ? `${availQty}/${totalQty} ta`
                                : `${availQty} ta mavjud`
                              : overdue
                                ? 'Muddati o‘tgan'
                                : 'Tugagan'}
                          </span>
                        </span>
                      </div>

                      <h3 className="font-display font-semibold text-sm sm:text-base text-slate-900 leading-snug line-clamp-2">
                        {book.title}
                      </h3>
                    </div>

                    {book.author && (
                      <p className="text-xs text-slate-500 truncate pt-1">
                        {book.author}
                      </p>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-5 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500">
          <span>
            {settings.institutionName} · {settings.libraryName}
          </span>
          <span>Sensorli monitor va kompyuterlar uchun moslashuvchan tizim</span>
        </div>
      </footer>

      <BookDetailModal
        book={selectedBook}
        onClose={() => setSelectedBook(null)}
        onBorrow={(book) => {
          setSelectedBook(null);
          setModalState({ mode: 'borrow', book });
        }}
        onReturn={(book) => {
          const avail = getBookAvailableCount(book);
          const totalQty = Math.max(1, book.quantity || 1);
          setSelectedBook(null);
          setModalState({
            mode: 'return',
            book: avail < totalQty ? book : null,
          });
        }}
      />

      <BorrowReturnModal
        mode={modalState.mode}
        books={books}
        initialBook={modalState.book}
        defaultLoanDays={settings.defaultLoanDays}
        onClose={() => setModalState({ mode: null, book: null })}
        onOfflineQueued={onOfflineQueueChange}
      />

      <NewBookBorrowModal
        isOpen={isNewBookOpen}
        existingBooks={books}
        suggestedBookNumber={suggestedNextNumber}
        defaultLoanDays={settings.defaultLoanDays}
        onClose={() => setIsNewBookOpen(false)}
        onOfflineQueued={onOfflineQueueChange}
      />
    </div>
  );
}

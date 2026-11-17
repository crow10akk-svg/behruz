import { ArrowLeftRight, BookCheck, Calendar, Clock, Hash, Lock, User, X } from 'lucide-react';
import { BookCoverImage } from './BookCoverImage.tsx';
import { getBookAvailableCount } from '../lib/libraryService.ts';
import { formatUzDate, formatUzDateTime, isOverdueDate } from '../lib/imageUtils.ts';
import type { Book } from '../types.ts';

interface BookDetailModalProps {
  book: Book | null;
  onClose: () => void;
  onBorrow: (book: Book) => void;
  onReturn: (book: Book) => void;
}

export function BookDetailModal({
  book,
  onClose,
  onBorrow,
  onReturn,
}: BookDetailModalProps) {
  if (!book) return null;

  const totalQty = Math.max(1, book.quantity || 1);
  const availQty = getBookAvailableCount(book);
  const isAvailable = book.isActive && availQty > 0;
  const isLockedOut = book.isActive && availQty <= 0;
  const hasBorrowedCopy = availQty < totalQty;
  const overdue = hasBorrowedCopy && isOverdueDate(book.currentDueDate);

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
      <div className="w-full max-w-2xl rounded-2xl bg-white border border-slate-200 shadow-2xl overflow-hidden my-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <div className="flex items-center gap-2 text-sm font-mono text-slate-600 tabular-nums">
            <Hash className="w-4 h-4 text-blue-700" />
            <span>Inventar raqami: {book.bookNumber}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-10 h-10 rounded-xl flex items-center justify-center text-slate-500 hover:bg-slate-100 hover:text-slate-900 transition-colors"
            aria-label="Yopish"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 grid grid-cols-1 sm:grid-cols-[200px_1fr] gap-6">
          <div className="aspect-[3/4] w-full max-w-[200px] mx-auto sm:mx-0 rounded-xl overflow-hidden border border-slate-200 bg-slate-100 relative">
            <BookCoverImage
              coverUrl={book.coverUrl}
              title={book.title}
              bookNumber={book.bookNumber}
              className={`w-full h-full ${isLockedOut ? 'opacity-70 grayscale-[35%]' : ''}`}
            />
            {isLockedOut && (
              <div className="absolute inset-0 bg-slate-950/35 flex items-center justify-center">
                <div className="bg-slate-900/90 text-white px-3 py-1.5 rounded-xl flex items-center gap-1.5 text-xs font-semibold">
                  <Lock className="w-3.5 h-3.5 text-amber-300" />
                  <span>Tugagan</span>
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-col justify-between space-y-5">
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-xs font-medium">
                {isAvailable ? (
                  <span className="inline-flex items-center gap-1.5 text-emerald-700 font-semibold">
                    <BookCheck className="w-4 h-4" />
                    <span>Mavjud · {availQty} ta qolgan</span>
                  </span>
                ) : isLockedOut ? (
                  <span
                    className={`inline-flex items-center gap-1.5 font-semibold ${
                      overdue ? 'text-red-700' : 'text-amber-700'
                    }`}
                  >
                    <Lock className="w-4 h-4" />
                    <span>{overdue ? 'Tugagan · Muddati o‘tgan' : 'Tugagan (Qulflangan)'}</span>
                  </span>
                ) : (
                  <span className="text-slate-500 font-semibold">Vaqtincha faol emas</span>
                )}
                {book.category && (
                  <>
                    <span className="text-slate-300" aria-hidden="true">
                      ·
                    </span>
                    <span className="text-slate-600">{book.category}</span>
                  </>
                )}
              </div>

              <h2 className="font-display text-2xl font-bold text-slate-900 leading-snug">
                {book.title}
              </h2>

              {book.author && (
                <p className="text-sm text-slate-600 flex items-center gap-2">
                  <User className="w-4 h-4 text-slate-400 shrink-0" />
                  <span>Muallif: {book.author}</span>
                </p>
              )}

              {book.description && (
                <p className="text-sm text-slate-600 leading-relaxed pt-1">
                  {book.description}
                </p>
              )}

              <div className="pt-2 border-t border-slate-100 grid grid-cols-2 gap-3 text-xs">
                <div>
                  <span className="text-slate-500 block">Kitob raqami</span>
                  <span className="font-mono font-semibold text-slate-900 tabular-nums">
                    {book.bookNumber}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 block">Mavjud / Jami nusxa</span>
                  <span className="font-mono font-semibold text-slate-900 tabular-nums">
                    {availQty} / {totalQty} dona
                  </span>
                </div>
                {hasBorrowedCopy && book.currentBorrowedAt && (
                  <div>
                    <span className="text-slate-500 block">Oxirgi olingan sana</span>
                    <span className="font-mono text-slate-800 tabular-nums">
                      {formatUzDateTime(book.currentBorrowedAt)}
                    </span>
                  </div>
                )}
                {hasBorrowedCopy && book.currentDueDate && (
                  <div>
                    <span className="text-slate-500 block">Qaytarish muddati</span>
                    <span
                      className={`font-mono font-semibold tabular-nums flex items-center gap-1 ${
                        overdue ? 'text-red-700' : 'text-slate-800'
                      }`}
                    >
                      <Calendar className="w-3.5 h-3.5" />
                      {formatUzDate(book.currentDueDate)}
                    </span>
                  </div>
                )}
              </div>
            </div>

            <div className="pt-2 space-y-2.5">
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  disabled={!isAvailable}
                  onClick={() => onBorrow(book)}
                  className="min-h-[48px] inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs sm:text-sm font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed rounded-xl transition-colors whitespace-nowrap"
                >
                  {isLockedOut ? (
                    <Lock className="w-4 h-4 shrink-0" />
                  ) : (
                    <BookCheck className="w-4 h-4 shrink-0" />
                  )}
                  <span>{isLockedOut ? 'TUGAGAN' : 'KITOB OLISH'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => onReturn(book)}
                  className="min-h-[48px] inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs sm:text-sm font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-xl transition-colors whitespace-nowrap"
                >
                  <ArrowLeftRight className="w-4 h-4 shrink-0" />
                  <span>KITOB TOPSHIRISH</span>
                </button>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="w-full min-h-[42px] px-4 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors whitespace-nowrap"
              >
                Yopish
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

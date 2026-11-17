import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeftRight,
  BookOpen,
  Calendar,
  CheckCircle2,
  Clock,
  RefreshCw,
  ScanFace,
  ShieldCheck,
  Trash2,
  User,
  X,
} from 'lucide-react';
import {
  deleteFaceProfileAdmin,
  getFaceProfileById,
} from '../lib/libraryService.ts';
import { makeFaceProfileId } from '../lib/faceService.ts';
import { formatUzDate, formatUzDateTime, isOverdueDate } from '../lib/imageUtils.ts';
import type { FaceProfile, SignatureRecord, Student, TransactionRecord } from '../types.ts';

interface TransactionDetailModalProps {
  transaction: TransactionRecord | null;
  signatures: Record<string, SignatureRecord>;
  onClose: () => void;
  onRequestReturn?: (tx: TransactionRecord) => void;
  onDeleteTransaction?: (tx: TransactionRecord) => void;
}

export function TransactionDetailModal({
  transaction,
  signatures,
  onClose,
  onRequestReturn,
  onDeleteTransaction,
}: TransactionDetailModalProps) {
  const [faceProfile, setFaceProfile] = useState<FaceProfile | null>(null);

  useEffect(() => {
    if (!transaction) {
      setFaceProfile(null);
      return;
    }
    let cancelled = false;
    const faceId =
      transaction.faceProfileId ||
      makeFaceProfileId(
        transaction.studentFirstName,
        transaction.studentLastName,
        transaction.studentGroup
      );
    void getFaceProfileById(faceId)
      .then((res) => {
        if (!cancelled) setFaceProfile(res);
      })
      .catch(() => {
        if (!cancelled) setFaceProfile(null);
      });
    return () => {
      cancelled = true;
    };
  }, [transaction]);

  if (!transaction) return null;

  const borrowSig = transaction.borrowSignatureId
    ? signatures[transaction.borrowSignatureId]
    : undefined;
  const returnSig = transaction.returnSignatureId
    ? signatures[transaction.returnSignatureId]
    : undefined;
  const isActiveBorrow = transaction.type === 'borrow' && transaction.status === 'active';
  const overdue = isActiveBorrow && isOverdueDate(transaction.dueDate);

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
      <div className="w-full max-w-2xl rounded-2xl bg-white border border-slate-200 shadow-2xl overflow-hidden my-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <div>
            <h3 className="font-display font-bold text-lg text-slate-900">
              Operatsiya tafsilotlari
            </h3>
            <p className="text-xs font-mono text-slate-500 mt-0.5">{transaction.id}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-9 h-9 rounded-lg flex items-center justify-center text-slate-500 hover:bg-slate-100 hover:text-slate-900"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 flex items-center gap-3">
              {faceProfile ? (
                <img
                  src={faceProfile.facePhotoUrl}
                  alt={transaction.studentFullName}
                  className="w-12 h-14 rounded-lg object-cover border border-emerald-300 shrink-0"
                />
              ) : null}
              <div className="min-w-0">
                <span className="text-xs text-slate-500 block">O‘quvchi F.I.Sh.</span>
                <span className="font-semibold text-slate-900">{transaction.studentFullName}</span>
                <span className="text-xs text-slate-600 block mt-0.5">
                  {transaction.studentGroup} · {transaction.studentCourse}
                </span>
                {faceProfile && (
                  <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 mt-0.5">
                    <ShieldCheck className="w-3 h-3" />
                    Face ID biriktirilgan
                  </span>
                )}
              </div>
            </div>

            <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200">
              <span className="text-xs text-slate-500 block">Kitob</span>
              <span className="font-semibold text-slate-900">{transaction.bookTitle}</span>
              <span className="text-xs font-mono text-blue-700 block mt-0.5 tabular-nums">
                Inventar raqami: {transaction.bookNumber}
              </span>
            </div>

            <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200">
              <span className="text-xs text-slate-500 block">Amal va holat</span>
              <span className="font-semibold text-slate-900">
                {transaction.type === 'borrow' ? 'Kitob olish' : 'Kitob topshirish'}
              </span>
              <span
                className={`text-xs font-semibold block mt-0.5 ${
                  transaction.status === 'returned'
                    ? 'text-emerald-700'
                    : overdue
                      ? 'text-red-700'
                      : 'text-amber-700'
                }`}
              >
                {transaction.status === 'returned'
                  ? 'To‘liq topshirilgan'
                  : overdue
                    ? 'Muddati o‘tgan · Hali topshirilmagan'
                    : 'Hali topshirilmagan'}
              </span>
            </div>

            <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-1">
              <div>
                <span className="text-xs text-slate-500">Olingan sana: </span>
                <span className="font-mono text-xs text-slate-900 tabular-nums">
                  {formatUzDateTime(transaction.borrowedAt)}
                </span>
              </div>
              <div>
                <span className="text-xs text-slate-500">Qaytarish muddati: </span>
                <span
                  className={`font-mono text-xs font-semibold tabular-nums ${
                    overdue ? 'text-red-700' : 'text-slate-900'
                  }`}
                >
                  {formatUzDate(transaction.dueDate)}
                </span>
              </div>
              <div>
                <span className="text-xs text-slate-500">Topshirilgan sana: </span>
                <span className="font-mono text-xs text-slate-900 tabular-nums">
                  {formatUzDateTime(transaction.returnedAt)}
                </span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {borrowSig && (
              <div className="rounded-xl border border-slate-200 p-4 space-y-2">
                <span className="text-xs font-semibold text-slate-700 block">
                  Olishdagi elektron imzo
                </span>
                <img
                  src={borrowSig.imageDataUrl}
                  alt="Olish imzosi"
                  className="w-full h-28 object-contain bg-slate-50 rounded-lg border border-slate-100"
                />
                <span className="text-[11px] font-mono text-slate-500 block tabular-nums">
                  {formatUzDateTime(borrowSig.createdAt)}
                </span>
              </div>
            )}

            {returnSig && (
              <div className="rounded-xl border border-slate-200 p-4 space-y-2">
                <span className="text-xs font-semibold text-slate-700 block">
                  Topshirishdagi elektron imzo
                </span>
                <img
                  src={returnSig.imageDataUrl}
                  alt="Topshirish imzosi"
                  className="w-full h-28 object-contain bg-slate-50 rounded-lg border border-slate-100"
                />
                <span className="text-[11px] font-mono text-slate-500 block tabular-nums">
                  {formatUzDateTime(returnSig.createdAt)}
                </span>
              </div>
            )}
          </div>

          {((isActiveBorrow && onRequestReturn) || onDeleteTransaction) && (
            <div className="flex flex-wrap items-center justify-end gap-2.5 pt-2 border-t border-slate-100">
              {onDeleteTransaction && (
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onDeleteTransaction(transaction);
                  }}
                  className="inline-flex items-center gap-2 min-h-[44px] px-4 py-2 text-sm font-semibold text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 rounded-xl transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                  <span>Yozuvni o‘chirish</span>
                </button>
              )}
              {isActiveBorrow && onRequestReturn && (
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onRequestReturn(transaction);
                  }}
                  className="inline-flex items-center gap-2 min-h-[44px] px-5 py-2 text-sm font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-xl transition-colors"
                >
                  <ArrowLeftRight className="w-4 h-4" />
                  <span>Admin paneldan topshirish</span>
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface StudentHistoryModalProps {
  student: Student | null;
  transactions: TransactionRecord[];
  signatures: Record<string, SignatureRecord>;
  onClose: () => void;
  onRequestReturn?: (tx: TransactionRecord) => void;
}

export function StudentHistoryModal({
  student,
  transactions,
  signatures,
  onClose,
  onRequestReturn,
}: StudentHistoryModalProps) {
  const [faceProfile, setFaceProfile] = useState<FaceProfile | null>(null);
  const [resettingFace, setResettingFace] = useState(false);

  useEffect(() => {
    if (!student) {
      setFaceProfile(null);
      return;
    }
    let cancelled = false;
    const faceId = makeFaceProfileId(student.firstName, student.lastName, student.group);
    void getFaceProfileById(faceId)
      .then((res) => {
        if (!cancelled) setFaceProfile(res);
      })
      .catch(() => {
        if (!cancelled) setFaceProfile(null);
      });
    return () => {
      cancelled = true;
    };
  }, [student]);

  if (!student) return null;

  const studentTxs = transactions.filter((t) => t.studentId === student.id);
  const activeBorrows = studentTxs.filter(
    (t) => t.type === 'borrow' && t.status === 'active'
  );
  const studentSigs = Object.values(signatures).filter(
    (s) => s.studentId === student.id
  );

  const handleResetFaceId = async () => {
    if (!faceProfile) return;
    setResettingFace(true);
    try {
      await deleteFaceProfileAdmin(faceProfile.id, student.fullName);
      setFaceProfile(null);
    } finally {
      setResettingFace(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
      <div className="w-full max-w-4xl rounded-2xl bg-white border border-slate-200 shadow-2xl overflow-hidden my-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-slate-50/70">
          <div className="flex items-center gap-3">
            {faceProfile ? (
              <img
                src={faceProfile.facePhotoUrl}
                alt={student.fullName}
                className="w-12 h-14 rounded-xl object-cover border-2 border-emerald-400 shrink-0"
              />
            ) : (
              <div className="w-10 h-10 rounded-xl bg-blue-50 border border-blue-200 text-blue-700 flex items-center justify-center">
                <User className="w-5 h-5" />
              </div>
            )}
            <div>
              <h3 className="font-display font-bold text-lg text-slate-900">
                {student.fullName} — To‘liq tarix
              </h3>
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                <span>
                  {student.group} · {student.course}
                </span>
                {faceProfile && (
                  <span className="inline-flex items-center gap-1 text-emerald-700 font-semibold">
                    <ScanFace className="w-3.5 h-3.5" />
                    Face ID faol
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {faceProfile && (
              <button
                type="button"
                disabled={resettingFace}
                onClick={handleResetFaceId}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-amber-800 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-lg transition-colors disabled:opacity-60"
                title="O‘quvchi keyingi safar yangi Face ID rasmga tushishi uchun eskisini o‘chirish"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${resettingFace ? 'animate-spin' : ''}`} />
                <span className="hidden sm:inline">Face ID ni yangilash</span>
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="w-9 h-9 rounded-lg flex items-center justify-center text-slate-500 hover:bg-slate-200/70 hover:text-slate-900"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="p-6 space-y-6 max-h-[82vh] overflow-y-auto">
          <div className="grid grid-cols-3 gap-4 text-center">
            <div className="p-3.5 rounded-xl border border-slate-200 bg-slate-50">
              <span className="text-xs text-slate-500 block">Jami olgan kitoblari</span>
              <span className="font-mono text-2xl font-bold text-slate-900 tabular-nums">
                {student.totalBorrowed}
              </span>
            </div>
            <div className="p-3.5 rounded-xl border border-slate-200 bg-slate-50">
              <span className="text-xs text-slate-500 block">Topshirgan kitoblari</span>
              <span className="font-mono text-2xl font-bold text-emerald-700 tabular-nums">
                {student.totalReturned}
              </span>
            </div>
            <div className="p-3.5 rounded-xl border border-slate-200 bg-slate-50">
              <span className="text-xs text-slate-500 block">Hali topshirilmagan</span>
              <span className="font-mono text-2xl font-bold text-amber-700 tabular-nums">
                {activeBorrows.length}
              </span>
            </div>
          </div>

          {/* Currently held books */}
          <div className="space-y-2.5">
            <h4 className="font-display font-semibold text-sm text-slate-900 flex items-center gap-2">
              <BookOpen className="w-4 h-4 text-amber-600" />
              <span>Hali topshirilmagan kitoblar ({activeBorrows.length})</span>
            </h4>
            {activeBorrows.length === 0 ? (
              <p className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-xl p-3.5">
                Hozirda bu o‘quvchida qaytarilmagan kitob yo‘q.
              </p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {activeBorrows.map((tx) => {
                  const overdue = isOverdueDate(tx.dueDate);
                  return (
                    <div
                      key={tx.id}
                      className={`p-3.5 rounded-xl border text-sm flex flex-col justify-between gap-2.5 ${
                        overdue
                          ? 'border-red-300 bg-red-50'
                          : 'border-amber-200 bg-amber-50/50'
                      }`}
                    >
                      <div>
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-xs font-semibold text-slate-700 tabular-nums">
                            № {tx.bookNumber}
                          </span>
                          {overdue ? (
                            <span className="inline-flex items-center gap-1 text-xs font-bold text-red-700">
                              <AlertTriangle className="w-3.5 h-3.5" />
                              <span>Muddati o‘tgan</span>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-700">
                              <Clock className="w-3.5 h-3.5" />
                              <span>Hali topshirilmagan</span>
                            </span>
                          )}
                        </div>
                        <p className="font-semibold text-slate-900 mt-1">{tx.bookTitle}</p>
                        <div className="mt-2 text-xs text-slate-600 space-y-0.5 font-mono tabular-nums">
                          <p>Olingan: {formatUzDateTime(tx.borrowedAt)}</p>
                          <p className={overdue ? 'text-red-700 font-semibold' : ''}>
                            Muddat: {formatUzDate(tx.dueDate)}
                          </p>
                        </div>
                      </div>

                      {onRequestReturn && (
                        <button
                          type="button"
                          onClick={() => {
                            onClose();
                            onRequestReturn(tx);
                          }}
                          className="inline-flex items-center justify-center gap-1.5 min-h-[36px] px-3 py-1.5 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg transition-colors"
                        >
                          <ArrowLeftRight className="w-3.5 h-3.5" />
                          <span>Topshirish</span>
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* All student transactions */}
          <div className="space-y-2.5">
            <h4 className="font-display font-semibold text-sm text-slate-900 flex items-center gap-2">
              <Calendar className="w-4 h-4 text-blue-700" />
              <span>Barcha olish va topshirish tarixi ({studentTxs.length})</span>
            </h4>
            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                  <tr>
                    <th className="py-2.5 px-3 font-semibold">Amal / Holat</th>
                    <th className="py-2.5 px-3 font-semibold">Kitob</th>
                    <th className="py-2.5 px-3 font-semibold">Raqam</th>
                    <th className="py-2.5 px-3 font-semibold">Olingan sana</th>
                    <th className="py-2.5 px-3 font-semibold">Topshirilgan sana</th>
                    <th className="py-2.5 px-3 font-semibold">Imzo</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {studentTxs.map((tx) => {
                    const sigId =
                      tx.type === 'borrow' ? tx.borrowSignatureId : tx.returnSignatureId;
                    const sig = sigId ? signatures[sigId] : undefined;
                    return (
                      <tr key={tx.id} className="hover:bg-slate-50/60">
                        <td className="py-2.5 px-3 font-semibold">
                          {tx.status === 'returned' ? (
                            <span className="text-emerald-700 inline-flex items-center gap-1">
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              {tx.type === 'borrow' ? 'Olish · To‘liq topshirilgan' : 'Topshirish'}
                            </span>
                          ) : (
                            <span className="text-amber-700">Hali topshirilmagan</span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 font-medium text-slate-900">{tx.bookTitle}</td>
                        <td className="py-2.5 px-3 font-mono tabular-nums">{tx.bookNumber}</td>
                        <td className="py-2.5 px-3 font-mono tabular-nums text-slate-600">
                          {formatUzDateTime(tx.borrowedAt)}
                        </td>
                        <td className="py-2.5 px-3 font-mono tabular-nums text-slate-600">
                          {formatUzDateTime(tx.returnedAt)}
                        </td>
                        <td className="py-2.5 px-3">
                          {sig ? (
                            <img
                              src={sig.imageDataUrl}
                              alt="Imzo"
                              className="h-8 w-16 object-contain border border-slate-200 rounded bg-white"
                            />
                          ) : (
                            '—'
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* All signatures gallery */}
          {studentSigs.length > 0 && (
            <div className="space-y-2.5">
              <h4 className="font-display font-semibold text-sm text-slate-900">
                Elektron imzolar arxivi ({studentSigs.length})
              </h4>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {studentSigs.map((sig) => (
                  <div
                    key={sig.id}
                    className="rounded-xl border border-slate-200 p-2.5 bg-slate-50 space-y-1.5"
                  >
                    <img
                      src={sig.imageDataUrl}
                      alt={sig.studentFullName}
                      className="h-16 w-full object-contain bg-white rounded-lg border border-slate-100"
                    />
                    <div className="text-[11px] text-slate-600 flex items-center justify-between">
                      <span className="font-semibold">
                        {sig.actionType === 'borrow' ? 'Olish' : 'Topshirish'}
                      </span>
                      <span className="font-mono tabular-nums">№ {sig.bookNumber}</span>
                    </div>
                    <span className="text-[10px] font-mono text-slate-400 block tabular-nums">
                      {formatUzDateTime(sig.createdAt)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Lock,
  WifiOff,
  X,
} from 'lucide-react';
import { SignaturePad } from './SignaturePad.tsx';
import { BookCoverImage } from './BookCoverImage.tsx';
import {
  FaceCaptureBox,
  type CapturedFaceEnrollment,
  type VerifiedFaceState,
} from './FaceCaptureBox.tsx';
import {
  UzDateSelects,
  buildBorrowAndDueIso,
  buildDateWithCurrentTime,
  buildReturnIso,
  getTodayDateStr,
} from './UzDateSelects.tsx';
import {
  borrowBookAtomic,
  enqueueOfflineAction,
  getBookAvailableCount,
  lookupFaceProfilesByName,
  resolveReturnFaceRequirement,
  returnBookAtomic,
  verifyAdminPassword,
} from '../lib/libraryService.ts';
import { formatUzDate, formatUzDateTime, makeSafeDocId, normalizeCompareText } from '../lib/imageUtils.ts';
import { scoreFuzzyMatch } from '../lib/autonomousEngine.ts';
import type { Book, FaceProfile, OfflinePendingAction } from '../types.ts';

interface BorrowReturnModalProps {
  mode: 'borrow' | 'return' | null;
  books: Book[];
  initialBook: Book | null;
  defaultLoanDays: number;
  onClose: () => void;
  onOfflineQueued: (queue: OfflinePendingAction[]) => void;
}

const COURSE_OPTIONS = ['1-kurs', '2-kurs'];

export function BorrowReturnModal({
  mode,
  books,
  initialBook,
  defaultLoanDays,
  onClose,
  onOfflineQueued,
}: BorrowReturnModalProps) {
  const [selectedBookId, setSelectedBookId] = useState<string>('');
  const [bookTitleInput, setBookTitleInput] = useState('');
  const [confirmBookNumber, setConfirmBookNumber] = useState('');

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [group, setGroup] = useState('');
  const [course, setCourse] = useState('1-kurs');
  const [borrowDateStr, setBorrowDateStr] = useState(getTodayDateStr());
  const [returnDateStr, setReturnDateStr] = useState(getTodayDateStr());
  const [signatureDataUrl, setSignatureDataUrl] = useState<string | null>(null);

  // Face ID states
  const [savedFaceProfile, setSavedFaceProfile] = useState<FaceProfile | null>(null);
  const [isLookingUpFace, setIsLookingUpFace] = useState(false);
  const [capturedFaceEnrollment, setCapturedFaceEnrollment] =
    useState<CapturedFaceEnrollment | null>(null);

  const [returnTargetFace, setReturnTargetFace] = useState<FaceProfile | null>(null);
  const [isResolvingReturnTarget, setIsResolvingReturnTarget] = useState(false);
  const [legacyNoFaceProfile, setLegacyNoFaceProfile] = useState(false);
  const [verifiedFaceState, setVerifiedFaceState] = useState<VerifiedFaceState | null>(null);

  const [useAdminOverride, setUseAdminOverride] = useState(false);
  const [overridePassword, setOverridePassword] = useState('');

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [offlineNotice, setOfflineNotice] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{
    action: 'borrow' | 'return';
    bookTitle: string;
    bookNumber: string;
    studentName: string;
    group: string;
    course: string;
    timestamp: string;
    dueDate?: string;
    signatureUrl: string;
  } | null>(null);

  useEffect(() => {
    if (mode) {
      setSelectedBookId(initialBook?.id || '');
      setBookTitleInput(initialBook?.title || '');
      setConfirmBookNumber(mode === 'return' && initialBook ? initialBook.bookNumber : '');
      setFirstName('');
      setLastName('');
      setGroup('');
      setCourse('1-kurs');
      const today = getTodayDateStr();
      setBorrowDateStr(today);
      setReturnDateStr(today);
      setSignatureDataUrl(null);
      setSavedFaceProfile(null);
      setIsLookingUpFace(false);
      setCapturedFaceEnrollment(null);
      setReturnTargetFace(null);
      setIsResolvingReturnTarget(false);
      setLegacyNoFaceProfile(false);
      setVerifiedFaceState(null);
      setUseAdminOverride(false);
      setOverridePassword('');
      setErrorMsg(null);
      setOfflineNotice(null);
      setReceipt(null);
    }
  }, [mode, initialBook, defaultLoanDays]);

  const candidateBooks = useMemo(() => {
    const titleQ = bookTitleInput.trim();
    const numQ = confirmBookNumber.trim().toLowerCase();
    const eligible = books.filter((b) => {
      if (!b.isActive) return false;
      const avail = getBookAvailableCount(b);
      const totalQty = Math.max(1, b.quantity || 1);
      if (mode === 'borrow' && avail <= 0) return false;
      if (mode === 'return' && avail >= totalQty) return false;
      if (numQ && !b.bookNumber.toLowerCase().includes(numQ)) return false;
      return true;
    });
    if (!titleQ) return eligible;
    return eligible
      .map((b) => ({
        book: b,
        score: scoreFuzzyMatch(titleQ, [b.title, b.author || '', b.bookNumber]),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((item) => item.book);
  }, [books, bookTitleInput, confirmBookNumber, mode]);

  const selectedBook = useMemo(
    () => books.find((b) => b.id === selectedBookId) || null,
    [books, selectedBookId]
  );

  const resolveBookForSubmit = useCallback((): Book | null => {
    if (selectedBook) return selectedBook;
    const titleQ = normalizeCompareText(bookTitleInput);
    const numQ = normalizeCompareText(confirmBookNumber);

    const byNumAndTitle = candidateBooks.find(
      (b) =>
        normalizeCompareText(b.bookNumber) === numQ &&
        normalizeCompareText(b.title) === titleQ
    );
    if (byNumAndTitle) return byNumAndTitle;

    if (numQ) {
      const byNum = books.find((b) => {
        if (!b.isActive) return false;
        const avail = getBookAvailableCount(b);
        const totalQty = Math.max(1, b.quantity || 1);
        const eligible = mode === 'borrow' ? avail > 0 : avail < totalQty;
        return eligible && normalizeCompareText(b.bookNumber) === numQ;
      });
      if (byNum) return byNum;
    }

    if (titleQ) {
      const exactTitleMatches = candidateBooks.filter(
        (b) => normalizeCompareText(b.title) === titleQ
      );
      if (exactTitleMatches.length === 1) {
        return exactTitleMatches[0];
      }
    }

    return null;
  }, [selectedBook, bookTitleInput, confirmBookNumber, candidateBooks, books, mode]);

  // Borrow mode: auto-recall permanently saved Face ID when firstName + lastName match
  useEffect(() => {
    if (mode !== 'borrow') return;
    const f = firstName.trim();
    const l = lastName.trim();
    if (f.length < 2 || l.length < 2) {
      setSavedFaceProfile(null);
      setIsLookingUpFace(false);
      return;
    }

    let cancelled = false;
    setIsLookingUpFace(true);
    const timer = window.setTimeout(async () => {
      try {
        const res = await lookupFaceProfilesByName(f, l, group.trim() || undefined);
        if (cancelled) return;
        setSavedFaceProfile(res.exactMatch);
        if (res.exactMatch) {
          setCapturedFaceEnrollment(null);
          if (!group.trim() && res.candidates.length === 1) {
            setGroup(res.exactMatch.group);
            setCourse(res.exactMatch.course);
          }
        }
      } catch {
        if (!cancelled) setSavedFaceProfile(null);
      } finally {
        if (!cancelled) setIsLookingUpFace(false);
      }
    }, 240);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [mode, firstName, lastName, group]);

  // Return mode: reset verified state on identity/book change and resolve target borrower's FaceProfile
  useEffect(() => {
    if (mode !== 'return') return;
    setVerifiedFaceState(null);
    setReturnTargetFace(null);
    setLegacyNoFaceProfile(false);

    const targetBook = resolveBookForSubmit();
    const f = firstName.trim();
    const l = lastName.trim();
    const g = group.trim();
    if (!targetBook || f.length < 2 || l.length < 2 || g.length < 2) {
      setIsResolvingReturnTarget(false);
      return;
    }

    let cancelled = false;
    setIsResolvingReturnTarget(true);
    const timer = window.setTimeout(async () => {
      try {
        const res = await resolveReturnFaceRequirement({
          bookId: targetBook.id,
          firstName: f,
          lastName: l,
          group: g,
        });
        if (cancelled) return;
        if (res.borrowFound) {
          setReturnTargetFace(res.faceProfile);
          setLegacyNoFaceProfile(!res.requiresFaceVerification);
        }
      } catch {
        // Ignore transient lookup error; submit/button click handles it
      } finally {
        if (!cancelled) setIsResolvingReturnTarget(false);
      }
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [mode, resolveBookForSubmit, firstName, lastName, group]);

  if (!mode) return null;

  const isBorrow = mode === 'borrow';

  const handleSelectBook = (book: Book) => {
    setSelectedBookId(book.id);
    setBookTitleInput(book.title);
    if (!isBorrow) {
      setConfirmBookNumber(book.bookNumber);
    }
    setErrorMsg(null);
  };

  const isNetworkFailure = (err: unknown): boolean => {
    if (!navigator.onLine) return true;
    const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
    return (
      msg.includes('offline') ||
      msg.includes('network') ||
      msg.includes('unavailable') ||
      msg.includes('failed to get document')
    );
  };

  const handleEnsureReturnTargetProfile = async (): Promise<{
    faceProfile: FaceProfile | null;
    legacyNoFace: boolean;
    errorMessage?: string;
  }> => {
    const targetBook = resolveBookForSubmit();
    if (!targetBook) {
      return {
        faceProfile: null,
        legacyNoFace: false,
        errorMessage: 'Avval topshirilayotgan kitobni ro‘yxatdan tanlang yoki raqamini kiriting.',
      };
    }
    if (!firstName.trim() || !lastName.trim() || !group.trim()) {
      return {
        faceProfile: null,
        legacyNoFace: false,
        errorMessage: 'Avval ism, familiya va guruhni kiriting.',
      };
    }
    const res = await resolveReturnFaceRequirement({
      bookId: targetBook.id,
      firstName,
      lastName,
      group,
    });
    if (!res.borrowFound) {
      return {
        faceProfile: null,
        legacyNoFace: false,
        errorMessage:
          'Kiritilgan ism, familiya va guruh bo‘yicha ushbu kitobni olgan faol yozuv topilmadi.',
      };
    }
    setReturnTargetFace(res.faceProfile);
    setLegacyNoFaceProfile(!res.requiresFaceVerification);
    return {
      faceProfile: res.faceProfile,
      legacyNoFace: !res.requiresFaceVerification,
    };
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setOfflineNotice(null);

    if (isBorrow && !bookTitleInput.trim()) {
      setErrorMsg('Iltimos, kitob nomini kiriting yoki ro‘yxatdan tanlang.');
      return;
    }
    if (!isBorrow && !bookTitleInput.trim() && !confirmBookNumber.trim()) {
      setErrorMsg('Topshirilayotgan kitobni ro‘yxatdan tanlang yoki raqamini kiriting.');
      return;
    }

    const targetBook = resolveBookForSubmit();
    if (!targetBook) {
      setErrorMsg(
        isBorrow
          ? 'Kiritilgan nom va raqam bo‘yicha mavjud kitob topilmadi. Ro‘yxatdan tanlang yoki raqamni tekshiring.'
          : 'Kiritilgan nom yoki raqam bo‘yicha olingan kitob topilmadi. Ro‘yxatdan tanlang yoki kitob raqamini kiriting.'
      );
      return;
    }

    const effectiveBookNumber = confirmBookNumber.trim() || (!isBorrow ? targetBook.bookNumber : '');
    if (!effectiveBookNumber) {
      setErrorMsg('Olinayotgan kitobning maxsus inventar raqamini kiriting.');
      return;
    }

    if (normalizeCompareText(effectiveBookNumber) !== normalizeCompareText(targetBook.bookNumber)) {
      setErrorMsg(
        isBorrow
          ? `Kiritilgan kitob raqami (${effectiveBookNumber}) «${targetBook.title}» kitobi raqami (${targetBook.bookNumber}) bilan mos kelmadi.`
          : `Kitob inventar raqami (${effectiveBookNumber}) tanlangan kitob raqami (${targetBook.bookNumber}) bilan mos kelmadi.`
      );
      return;
    }

    const inputTitleNorm = normalizeCompareText(bookTitleInput);
    const targetTitleNorm = normalizeCompareText(targetBook.title);
    if (isBorrow) {
      if (inputTitleNorm !== targetTitleNorm) {
        setErrorMsg(
          `Kiritilgan kitob nomi (${bookTitleInput}) tanlangan kitob nomi («${targetBook.title}») bilan mos kelmadi.`
        );
        return;
      }
    } else if (inputTitleNorm && !targetTitleNorm.includes(inputTitleNorm)) {
      setErrorMsg(
        `Kiritilgan kitob nomi («${bookTitleInput}») tanlangan kitob nomi («${targetBook.title}») bilan mos kelmadi.`
      );
      return;
    }

    if (!firstName.trim() || !lastName.trim() || !group.trim() || !course.trim()) {
      setErrorMsg('Ism, familiya, guruh va kurs ma’lumotlarini to‘liq kiriting.');
      return;
    }
    if (isBorrow && !savedFaceProfile && !capturedFaceEnrollment) {
      setErrorMsg('Kitob olish uchun Face ID orqali yuzingizni rasmga oling.');
      return;
    }
    if (
      !isBorrow &&
      !useAdminOverride &&
      !legacyNoFaceProfile &&
      !verifiedFaceState?.liveDescriptor
    ) {
      setErrorMsg('Kitobni topshirish uchun Face ID kamerasidan yuzingizni tasdiqlang.');
      return;
    }
    if (!signatureDataUrl) {
      setErrorMsg('Davom etish uchun elektron imzo maydoniga imzo qo‘ying.');
      return;
    }

    const { borrowedAtIso, dueDateIso } = buildBorrowAndDueIso(
      borrowDateStr,
      defaultLoanDays
    );
    const returnedAtIso = buildReturnIso(returnDateStr);

    if (!navigator.onLine) {
      const nextQ = enqueueOfflineAction({
        id: makeSafeDocId('offline'),
        kind: mode,
        createdAt: new Date().toISOString(),
        payload: {
          bookId: targetBook.id,
          bookNumber: targetBook.bookNumber,
          bookTitle: targetBook.title,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          group: group.trim(),
          course: course.trim(),
          borrowedAtIso: isBorrow ? borrowedAtIso : undefined,
          dueDateIso: isBorrow ? dueDateIso : undefined,
          returnedAtIso: !isBorrow ? returnedAtIso : undefined,
          signatureDataUrl,
          ...(isBorrow && capturedFaceEnrollment
            ? {
                facePhotoUrl: capturedFaceEnrollment.facePhotoUrl,
                faceDescriptor: capturedFaceEnrollment.faceDescriptor,
                descriptorHash: capturedFaceEnrollment.descriptorHash,
              }
            : {}),
          ...(!isBorrow && verifiedFaceState
            ? { liveFaceDescriptor: verifiedFaceState.liveDescriptor }
            : {}),
          adminOverride: !isBorrow && useAdminOverride,
        },
      });
      onOfflineQueued(nextQ);
      setOfflineNotice(
        'Internet aloqasi uzilgan. Operatsiya tasdiqlanmadi va yo‘qolmasligi uchun mahalliy navbatga saqlandi. Internet tiklangach tizim uni avtomatik serverga yuboradi.'
      );
      return;
    }

    setIsSubmitting(true);
    try {
      if (!isBorrow && useAdminOverride) {
        if (!overridePassword) {
          throw new Error('Kutubxonachi tasdig‘i uchun admin parolini kiriting.');
        }
        const authRes = await verifyAdminPassword(overridePassword);
        if (!authRes.valid) {
          throw new Error('Admin paroli noto‘g‘ri. Boshqa o‘quvchining kitobini topshirish rad etildi.');
        }
      }

      if (isBorrow) {
        const res = await borrowBookAtomic({
          bookId: targetBook.id,
          bookNumber: targetBook.bookNumber,
          firstName,
          lastName,
          group,
          course,
          borrowedAtIso,
          dueDateIso,
          signatureDataUrl,
          faceEnrollment:
            !savedFaceProfile && capturedFaceEnrollment ? capturedFaceEnrollment : undefined,
          existingFaceProfileId: savedFaceProfile?.id,
        });
        setReceipt({
          action: 'borrow',
          bookTitle: targetBook.title,
          bookNumber: targetBook.bookNumber,
          studentName: `${firstName.trim()} ${lastName.trim()}`,
          group: group.trim(),
          course: course.trim(),
          timestamp: res.borrowedAt,
          dueDate: res.dueDate,
          signatureUrl: signatureDataUrl,
        });
      } else {
        const res = await returnBookAtomic({
          bookId: targetBook.id,
          bookNumber: effectiveBookNumber,
          bookTitle: bookTitleInput.trim() || targetBook.title,
          firstName,
          lastName,
          group,
          course,
          returnedAtIso,
          signatureDataUrl,
          liveFaceDescriptor: verifiedFaceState?.liveDescriptor,
          adminOverride: useAdminOverride,
        });
        setReceipt({
          action: 'return',
          bookTitle: targetBook.title,
          bookNumber: targetBook.bookNumber,
          studentName: `${firstName.trim()} ${lastName.trim()}`,
          group: group.trim(),
          course: course.trim(),
          timestamp: res.returnedAt,
          signatureUrl: signatureDataUrl,
        });
      }
    } catch (err) {
      if (isNetworkFailure(err)) {
        const nextQ = enqueueOfflineAction({
          id: makeSafeDocId('offline'),
          kind: mode,
          createdAt: new Date().toISOString(),
          payload: {
            bookId: targetBook.id,
            bookNumber: targetBook.bookNumber,
            bookTitle: targetBook.title,
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            group: group.trim(),
            course: course.trim(),
            borrowedAtIso: isBorrow ? borrowedAtIso : undefined,
            dueDateIso: isBorrow ? dueDateIso : undefined,
            returnedAtIso: !isBorrow ? returnedAtIso : undefined,
            signatureDataUrl,
            ...(isBorrow && capturedFaceEnrollment
              ? {
                  facePhotoUrl: capturedFaceEnrollment.facePhotoUrl,
                  faceDescriptor: capturedFaceEnrollment.faceDescriptor,
                  descriptorHash: capturedFaceEnrollment.descriptorHash,
                }
              : {}),
            ...(!isBorrow && verifiedFaceState
              ? { liveFaceDescriptor: verifiedFaceState.liveDescriptor }
              : {}),
            adminOverride: !isBorrow && useAdminOverride,
          },
        });
        onOfflineQueued(nextQ);
        setOfflineNotice(
          'Server bilan aloqa uzildi. Operatsiya muvaffaqiyatli deb tasdiqlanmadi va keyinroq yuborish uchun saqlandi.'
        );
      } else {
        setErrorMsg(
          err instanceof Error ? err.message : 'Operatsiyani bajarishda xatolik yuz berdi.'
        );
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-3 sm:p-5 overflow-y-auto">
      <div className="w-full max-w-3xl rounded-2xl bg-white border border-slate-200 shadow-2xl overflow-hidden my-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-slate-50/70">
          <div>
            <h2 className="font-display text-xl font-bold text-slate-900">
              {isBorrow ? 'Kitob olish rasmiylashtiruvi' : 'Kitob topshirish rasmiylashtiruvi'}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {isBorrow
                ? 'Kitob nomi va raqamini kiriting, ma’lumotlarni to‘ldiring va imzo qo‘ying'
                : 'Topshirilayotgan kitob nomi va raqamini kiriting, ma’lumotlarni tekshiring va imzo qo‘ying'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-10 h-10 rounded-xl flex items-center justify-center text-slate-500 hover:bg-slate-200/70 hover:text-slate-900 transition-colors"
            aria-label="Yopish"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {receipt ? (
          <div className="p-6 sm:p-8 space-y-6">
            <div className="flex flex-col items-center text-center space-y-2">
              <div className="w-14 h-14 rounded-2xl bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-700">
                <CheckCircle2 className="w-8 h-8" />
              </div>
              <h3 className="font-display text-2xl font-bold text-slate-900">
                {receipt.action === 'borrow'
                  ? 'Kitob muvaffaqiyatli rasmiylashtirildi'
                  : 'Kitob muvaffaqiyatli topshirildi'}
              </h3>
              <p className="text-sm text-slate-600 max-w-md">
                Ma’lumotlar markaziy bazaga saqlandi va admin panelga avtomatik yuborildi.
              </p>
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50 p-5 grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-xs text-slate-500 block">Kitob nomi va raqami</span>
                <span className="font-semibold text-slate-900">
                  {receipt.bookTitle} (№ {receipt.bookNumber})
                </span>
              </div>
              <div>
                <span className="text-xs text-slate-500 block">O‘quvchi F.I.Sh.</span>
                <span className="font-semibold text-slate-900">{receipt.studentName}</span>
              </div>
              <div>
                <span className="text-xs text-slate-500 block">Guruh va kurs</span>
                <span className="font-medium text-slate-800">
                  {receipt.group} · {receipt.course}
                </span>
              </div>
              <div>
                <span className="text-xs text-slate-500 block">Qayd etilgan vaqt</span>
                <span className="font-mono text-slate-800 tabular-nums">
                  {formatUzDateTime(receipt.timestamp)}
                </span>
              </div>
              {receipt.dueDate && (
                <div>
                  <span className="text-xs text-slate-500 block">Qaytarish muddati</span>
                  <span className="font-mono font-semibold text-blue-700 tabular-nums">
                    {formatUzDate(receipt.dueDate)}
                  </span>
                </div>
              )}
              <div>
                <span className="text-xs text-slate-500 block mb-1">Elektron imzo</span>
                <img
                  src={receipt.signatureUrl}
                  alt="Saqlangan elektron imzo"
                  className="h-14 rounded-lg border border-slate-200 bg-white px-2 object-contain"
                />
              </div>
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="min-h-[48px] px-6 py-2.5 text-sm font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-xl transition-colors"
              >
                Bosh sahifaga qaytish
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="p-6 space-y-6 max-h-[82vh] overflow-y-auto">
            {offlineNotice && (
              <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 flex items-start gap-3 text-sm text-amber-900">
                <WifiOff className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="font-semibold">Operatsiya tasdiqlanmadi (Oflayn navbat)</p>
                  <p className="text-amber-800">{offlineNotice}</p>
                </div>
              </div>
            )}

            {errorMsg && (
              <div className="rounded-xl border border-red-200 bg-red-50 p-4 flex items-start gap-3 text-sm text-red-800">
                <AlertTriangle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                <p>{errorMsg}</p>
              </div>
            )}

            {/* Step 1: Book Name & Book Number (Fast entry + instant selection for both Borrow & Return) */}
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <label className="text-sm font-semibold text-slate-800">
                  1. Kitob nomi va inventar raqami
                </label>
                {selectedBook && (
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedBookId('');
                      setBookTitleInput('');
                      setConfirmBookNumber('');
                    }}
                    className="text-xs font-semibold text-blue-700 hover:underline"
                  >
                    Boshqa kitob tanlash
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-[1fr_190px] gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">
                    Kitob nomi {isBorrow ? '*' : '(yoki pastdan tanlang)'}
                  </label>
                  <input
                    type="text"
                    required={isBorrow}
                    value={bookTitleInput}
                    onChange={(e) => {
                      setBookTitleInput(e.target.value);
                      if (selectedBook && e.target.value !== selectedBook.title) {
                        setSelectedBookId('');
                      }
                    }}
                    placeholder={
                      isBorrow
                        ? 'Masalan: O‘zbekiston tarixi'
                        : 'Topshirilayotgan kitob nomini yozing...'
                    }
                    className="w-full min-h-[44px] px-3.5 py-2 text-sm rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">
                    Kitob raqami {isBorrow ? '*' : '(avto/qo‘lda)'}
                  </label>
                  <input
                    type="text"
                    required={isBorrow}
                    value={confirmBookNumber}
                    onChange={(e) => setConfirmBookNumber(e.target.value)}
                    placeholder="Masalan: 001"
                    className="w-full min-h-[44px] px-3.5 py-2 text-sm font-mono rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
              </div>

              {selectedBook ? (
                <div className="rounded-xl border border-blue-200 bg-blue-50/50 p-3 flex items-center gap-3.5">
                  <div className="w-12 h-16 rounded-lg overflow-hidden border border-slate-200 shrink-0">
                    <BookCoverImage
                      coverUrl={selectedBook.coverUrl}
                      title={selectedBook.title}
                      bookNumber={selectedBook.bookNumber}
                      className="w-full h-full"
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <span className="text-xs font-mono text-blue-800 font-semibold tabular-nums">
                      Tanlangan kitob · № {selectedBook.bookNumber} · {getBookAvailableCount(selectedBook)}/{Math.max(1, selectedBook.quantity || 1)} mavjud
                    </span>
                    <p className="font-display font-bold text-slate-900 truncate">
                      {selectedBook.title}
                    </p>
                    {!isBorrow && selectedBook.currentBorrowerName && (
                      <p className="text-xs text-amber-800 mt-0.5">
                        Oxirgi olgan: {selectedBook.currentBorrowerName} (
                        {selectedBook.currentBorrowerGroup})
                      </p>
                    )}
                  </div>
                </div>
              ) : candidateBooks.length === 0 ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 text-xs text-slate-500 text-center">
                  {isBorrow
                    ? 'Mos keladigan mavjud kitob topilmadi.'
                    : 'Mos keladigan olingan kitob topilmadi.'}
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-40 overflow-y-auto pr-1">
                  {candidateBooks.map((book) => {
                    const avail = getBookAvailableCount(book);
                    const totalQty = Math.max(1, book.quantity || 1);
                    return (
                      <button
                        key={book.id}
                        type="button"
                        onClick={() => handleSelectBook(book)}
                        className="text-left p-2.5 rounded-xl border border-slate-200 hover:border-blue-500 hover:bg-blue-50/40 transition-colors flex items-center gap-3"
                      >
                        <div className="w-9 h-12 rounded-md overflow-hidden border border-slate-200 shrink-0">
                          <BookCoverImage
                            coverUrl={book.coverUrl}
                            title={book.title}
                            bookNumber={book.bookNumber}
                            className="w-full h-full"
                          />
                        </div>
                        <div className="min-w-0">
                          <span className="text-xs font-mono font-semibold text-blue-700 tabular-nums">
                            № {book.bookNumber} · {avail}/{totalQty} ta
                          </span>
                          <p className="text-xs sm:text-sm font-semibold text-slate-900 truncate">
                            {book.title}
                          </p>
                          {!isBorrow && book.currentBorrowerName && (
                            <p className="text-[11px] text-slate-500 truncate">
                              {book.currentBorrowerName}
                            </p>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Step 2: Student Fields */}
            <div className="space-y-3">
              <label className="text-sm font-semibold text-slate-800 block">
                2. O‘quvchi ma’lumotlari
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">
                    Ism *
                  </label>
                  <input
                    type="text"
                    required
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    placeholder="Masalan: Jasurbek"
                    className="w-full min-h-[44px] px-3.5 py-2 text-sm rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">
                    Familiya *
                  </label>
                  <input
                    type="text"
                    required
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    placeholder="Masalan: Aliyev"
                    className="w-full min-h-[44px] px-3.5 py-2 text-sm rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">
                    Guruh *
                  </label>
                  <input
                    type="text"
                    required
                    list="kiosk-group-suggestions"
                    value={group}
                    onChange={(e) => {
                      const val = e.target.value;
                      setGroup(val);
                      const trimmed = val.trim();
                      if (trimmed.startsWith('2.')) {
                        setCourse('2-kurs');
                      } else if (trimmed.startsWith('1.')) {
                        setCourse('1-kurs');
                      }
                    }}
                    placeholder={course === '2-kurs' ? 'Masalan: 2.1-guruh' : 'Masalan: 1.1-guruh'}
                    className="w-full min-h-[44px] px-3.5 py-2 text-sm rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                  <datalist id="kiosk-group-suggestions">
                    {(course === '2-kurs'
                      ? [
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
                        ]
                      : [
                          '1.1-guruh',
                          '1.2-guruh',
                          '1.3-guruh',
                          '1.4-guruh',
                          '1.5-guruh',
                          '1.6-guruh',
                          '1.7-guruh',
                          '1.8-guruh',
                          '1.9-guruh',
                        ]
                    ).map((gOpt) => (
                      <option key={gOpt} value={gOpt} />
                    ))}
                  </datalist>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">
                    Kurs *
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    {COURSE_OPTIONS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setCourse(c)}
                        className={`min-h-[44px] rounded-xl text-xs font-semibold border transition-colors ${
                          course === c
                            ? 'bg-blue-700 text-white border-blue-700'
                            : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                        }`}
                      >
                        {c}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Step 3: Face ID Enrollment / Verification */}
            <FaceCaptureBox
              mode={isBorrow ? 'enroll' : 'verify'}
              firstName={firstName}
              lastName={lastName}
              savedProfile={savedFaceProfile}
              isLookingUpProfile={isLookingUpFace}
              capturedEnrollment={capturedFaceEnrollment}
              onCaptureEnrollment={setCapturedFaceEnrollment}
              targetFaceProfile={returnTargetFace}
              isResolvingTarget={isResolvingReturnTarget}
              legacyNoFaceProfile={legacyNoFaceProfile}
              adminOverride={useAdminOverride}
              verifiedState={verifiedFaceState}
              onVerifiedStateChange={setVerifiedFaceState}
              onEnsureTargetProfile={handleEnsureReturnTargetProfile}
              stepNumber={3}
            />

            {/* Step 4: Date (Kun, Oy, Yil) for both Borrow and Return */}
            {isBorrow ? (
              <div className="space-y-2.5">
                <label className="text-sm font-semibold text-slate-800 block">
                  4. Olayotgan sana (kun, oy, yil) *
                </label>
                <UzDateSelects
                  value={borrowDateStr}
                  onChange={setBorrowDateStr}
                  labelPrefix="Olish sanasi"
                />
                <p className="text-xs text-slate-500 font-mono tabular-nums">
                  Tanlangan sana: {formatUzDate(buildDateWithCurrentTime(borrowDateStr).toISOString())} ·{' '}
                  Qaytarish muddati:{' '}
                  {formatUzDate(
                    buildBorrowAndDueIso(borrowDateStr, defaultLoanDays).dueDateIso
                  )}{' '}
                  ({defaultLoanDays} kun)
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="space-y-2">
                  <label className="text-sm font-semibold text-slate-800 block">
                    4. Topshirilayotgan sana (kun, oy, yil) *
                  </label>
                  <UzDateSelects
                    value={returnDateStr}
                    onChange={setReturnDateStr}
                    labelPrefix="Topshirish sanasi"
                  />
                  <p className="text-xs text-slate-500 font-mono tabular-nums">
                    Topshirish sanasi: {formatUzDate(buildReturnIso(returnDateStr))}
                  </p>
                </div>

                <div className="rounded-xl border border-blue-200 bg-blue-50/70 px-3.5 py-2.5 text-xs text-blue-900">
                  Oson topshirish: kitobni tanlang, <strong>ism, familiya, guruhingizni</strong> kiriting va <strong>Face ID</strong> orqali yuzingizni tasdiqlang.
                </div>

                <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer select-none pt-1">
                  <input
                    type="checkbox"
                    checked={useAdminOverride}
                    onChange={(e) => setUseAdminOverride(e.target.checked)}
                    className="w-4 h-4 rounded border-slate-300 text-blue-700 focus:ring-blue-600"
                  />
                  <span>Boshqa o‘quvchi nomidan topshirish (Admin tasdig‘i)</span>
                </label>
                {useAdminOverride && (
                  <div className="relative max-w-sm">
                    <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="password"
                      value={overridePassword}
                      onChange={(e) => setOverridePassword(e.target.value)}
                      placeholder="Administrator parolini kiriting"
                      className="w-full min-h-[42px] pl-9 pr-3 py-2 text-xs rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                  </div>
                )}
              </div>
            )}

            {/* Step 5: Electronic Signature */}
            <SignaturePad
              onChange={setSignatureDataUrl}
              label="5. Elektron imzo *"
            />

            <div className="flex flex-wrap items-center justify-end gap-3 pt-2 border-t border-slate-200">
              <button
                type="button"
                onClick={onClose}
                className="min-h-[48px] px-5 py-2.5 text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors"
              >
                Bekor qilish
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className={`min-h-[48px] px-6 py-2.5 text-sm font-semibold text-white rounded-xl transition-colors disabled:opacity-60 ${
                  isBorrow
                    ? 'bg-blue-700 hover:bg-blue-800'
                    : 'bg-slate-900 hover:bg-slate-800'
                }`}
              >
                {isSubmitting
                  ? 'Saqlanmoqda...'
                  : isBorrow
                    ? 'TASDIQLASH VA KITOB OLISH'
                    : 'KITOBNI TOPSHIRISH'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

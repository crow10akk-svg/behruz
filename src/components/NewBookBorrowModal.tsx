import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  RefreshCw,
  SwitchCamera,
  Upload,
  WifiOff,
  X,
} from 'lucide-react';
import { openCameraStream, type CameraFacingMode } from '../lib/cameraUtils.ts';
import { BookCoverImage } from './BookCoverImage.tsx';
import { SignaturePad } from './SignaturePad.tsx';
import {
  FaceCaptureBox,
  type CapturedFaceEnrollment,
} from './FaceCaptureBox.tsx';
import {
  UzDateSelects,
  buildBorrowAndDueIso,
  getTodayDateStr,
} from './UzDateSelects.tsx';
import {
  borrowNewUnlistedBookAtomic,
  enqueueOfflineAction,
  lookupFaceProfilesByName,
} from '../lib/libraryService.ts';
import {
  compressFileToDataUrl,
  compressImageElementToDataUrl,
  DEFAULT_BOOK_COVER_URL,
  formatUzDate,
  formatUzDateTime,
  makeSafeDocId,
} from '../lib/imageUtils.ts';
import { isQuotaExceededError } from '../lib/firebase.ts';
import type { Book, FaceProfile, OfflinePendingAction } from '../types.ts';

interface NewBookBorrowModalProps {
  isOpen: boolean;
  existingBooks?: Book[];
  suggestedBookNumber: string;
  defaultLoanDays: number;
  onClose: () => void;
  onOfflineQueued: (queue: OfflinePendingAction[]) => void;
}

const COURSE_OPTIONS = ['1-kurs', '2-kurs'];

export function NewBookBorrowModal({
  isOpen,
  existingBooks,
  suggestedBookNumber,
  defaultLoanDays,
  onClose,
  onOfflineQueued,
}: NewBookBorrowModalProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const frontCameraInputRef = useRef<HTMLInputElement | null>(null);

  const [cameraActive, setCameraActive] = useState(false);
  const [facingMode, setFacingMode] = useState<CameraFacingMode>('environment');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [coverUrl, setCoverUrl] = useState<string>('');

  const [bookTitle, setBookTitle] = useState('');
  const [bookNumber, setBookNumber] = useState(suggestedBookNumber);
  const [extraBookNumber, setExtraBookNumber] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [author, setAuthor] = useState('');

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [group, setGroup] = useState('');
  const [course, setCourse] = useState('1-kurs');
  const [borrowDateStr, setBorrowDateStr] = useState(getTodayDateStr());
  const [signatureDataUrl, setSignatureDataUrl] = useState<string | null>(null);

  const [savedFaceProfile, setSavedFaceProfile] = useState<FaceProfile | null>(null);
  const [isLookingUpFace, setIsLookingUpFace] = useState(false);
  const [capturedFaceEnrollment, setCapturedFaceEnrollment] =
    useState<CapturedFaceEnrollment | null>(null);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [offlineNotice, setOfflineNotice] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{
    bookTitle: string;
    bookNumber: string;
    extraBookNumber?: string;
    coverUrl: string;
    studentName: string;
    group: string;
    course: string;
    timestamp: string;
    dueDate: string;
    signatureUrl: string;
  } | null>(null);

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setCameraActive(false);
  };

  useEffect(() => {
    if (!cameraActive || !streamRef.current || !videoRef.current) return;
    const video = videoRef.current;
    if (video.srcObject !== streamRef.current) {
      video.srcObject = streamRef.current;
    }
    void video.play().catch(() => {
      // ignore autoplay block
    });
  }, [cameraActive, facingMode]);

  const startCamera = async (targetFacing: CameraFacingMode = facingMode) => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setCameraError(null);
    try {
      const stream = await openCameraStream(targetFacing, { width: 1280, height: 960 });
      streamRef.current = stream;
      setFacingMode(targetFacing);
      setCameraActive(true);
      requestAnimationFrame(() => {
        if (videoRef.current && streamRef.current) {
          videoRef.current.srcObject = streamRef.current;
          void videoRef.current.play().catch(() => {
            // ignore autoplay block
          });
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Kamera ruxsati berilmadi';
      setCameraError(
        `Kameraga ulanib bo‘lmadi (${msg}). Quyidagi «Old kamera» yoki «Fayldan» tugmasi orqali rasm olishingiz mumkin.`
      );
      setCameraActive(false);
    }
  };

  const handleToggleFacing = () => {
    const next: CameraFacingMode = facingMode === 'environment' ? 'user' : 'environment';
    setFacingMode(next);
    if (cameraActive) {
      void startCamera(next);
    }
  };

  useEffect(() => {
    if (isOpen) {
      setCoverUrl('');
      setBookTitle('');
      setBookNumber(suggestedBookNumber);
      setExtraBookNumber('');
      setQuantity(1);
      setAuthor('');
      setFirstName('');
      setLastName('');
      setGroup('');
      setCourse('1-kurs');
      setBorrowDateStr(getTodayDateStr());
      setSignatureDataUrl(null);
      setSavedFaceProfile(null);
      setIsLookingUpFace(false);
      setCapturedFaceEnrollment(null);
      setErrorMsg(null);
      setOfflineNotice(null);
      setReceipt(null);
    } else {
      stopCamera();
    }
    return () => {
      stopCamera();
    };
  }, [isOpen, suggestedBookNumber]);

  // Auto-recall saved Face ID when firstName + lastName match
  useEffect(() => {
    if (!isOpen) return;
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
  }, [isOpen, firstName, lastName, group]);

  if (!isOpen) return null;

  const handleCapturePhoto = () => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;
    const dataUrl = compressImageElementToDataUrl(video, 360, 480, 0.72);
    setCoverUrl(dataUrl);
    stopCamera();
    setErrorMsg(null);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const compressed = await compressFileToDataUrl(file);
      setCoverUrl(compressed);
      stopCamera();
      setCameraError(null);
      setErrorMsg(null);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Rasmni yuklab bo‘lmadi.');
    } finally {
      e.target.value = '';
    }
  };

  const isNetworkFailure = (err: unknown): boolean => {
    if (!navigator.onLine || isQuotaExceededError(err)) return true;
    const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
    return (
      msg.includes('offline') ||
      msg.includes('network') ||
      msg.includes('unavailable') ||
      msg.includes('failed to get document')
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setOfflineNotice(null);

    if (!bookTitle.trim()) {
      setErrorMsg('Kitob nomini kiriting.');
      return;
    }
    if (!firstName.trim() || !lastName.trim() || !group.trim() || !course.trim()) {
      setErrorMsg('Ism, familiya, guruh va kurs maydonlarini to‘liq kiriting.');
      return;
    }
    if (!savedFaceProfile && !capturedFaceEnrollment) {
      setErrorMsg('Yangi kitob olish uchun Face ID orqali yuzingizni rasmga oling.');
      return;
    }
    if (!signatureDataUrl) {
      setErrorMsg('Elektron imzo qo‘yilishi shart.');
      return;
    }

    const effectiveCoverUrl = coverUrl || DEFAULT_BOOK_COVER_URL;
    const cleanExtraBookNumber = extraBookNumber.trim().slice(0, 64);

    const { borrowedAtIso, dueDateIso } = buildBorrowAndDueIso(
      borrowDateStr,
      defaultLoanDays
    );

    if (!navigator.onLine) {
      const nextQ = enqueueOfflineAction({
        id: makeSafeDocId('offline'),
        kind: 'new-book-borrow',
        createdAt: new Date().toISOString(),
        payload: {
          bookId: '',
          bookNumber: bookNumber.trim() || suggestedBookNumber,
          ...(cleanExtraBookNumber ? { extraBookNumber: cleanExtraBookNumber } : {}),
          bookTitle: bookTitle.trim(),
          author: author.trim(),
          category: 'Umumiy',
          quantity: Math.max(1, Number(quantity) || 1),
          coverUrl: effectiveCoverUrl,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          group: group.trim(),
          course: course.trim(),
          borrowedAtIso,
          dueDateIso,
          signatureDataUrl,
          ...(capturedFaceEnrollment
            ? {
                facePhotoUrl: capturedFaceEnrollment.facePhotoUrl,
                faceDescriptor: capturedFaceEnrollment.faceDescriptor,
                descriptorHash: capturedFaceEnrollment.descriptorHash,
              }
            : {}),
        },
      });
      onOfflineQueued(nextQ);
      setOfflineNotice(
        'Internet aloqasi uzilgan. Yangi kitob va olish operatsiyasi mahalliy navbatga saqlandi. Internet tiklangach avtomatik yuboriladi.'
      );
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await borrowNewUnlistedBookAtomic({
        title: bookTitle,
        bookNumber,
        extraBookNumber: cleanExtraBookNumber || undefined,
        author,
        quantity,
        coverUrl: effectiveCoverUrl,
        firstName,
        lastName,
        group,
        course,
        borrowedAtIso,
        dueDateIso,
        signatureDataUrl,
        existingBooks,
        faceEnrollment: !savedFaceProfile && capturedFaceEnrollment ? capturedFaceEnrollment : undefined,
        existingFaceProfileId: savedFaceProfile?.id,
      });

      setReceipt({
        bookTitle: bookTitle.trim(),
        bookNumber: res.bookNumber,
        ...(cleanExtraBookNumber ? { extraBookNumber: cleanExtraBookNumber } : {}),
        coverUrl: effectiveCoverUrl,
        studentName: `${firstName.trim()} ${lastName.trim()}`,
        group: group.trim(),
        course: course.trim(),
        timestamp: res.borrowedAt,
        dueDate: res.dueDate,
        signatureUrl: signatureDataUrl,
      });
    } catch (err) {
      if (isNetworkFailure(err)) {
        const nextQ = enqueueOfflineAction({
          id: makeSafeDocId('offline'),
          kind: 'new-book-borrow',
          createdAt: new Date().toISOString(),
          payload: {
            bookId: '',
            bookNumber: bookNumber.trim() || suggestedBookNumber,
            ...(cleanExtraBookNumber ? { extraBookNumber: cleanExtraBookNumber } : {}),
            bookTitle: bookTitle.trim(),
            author: author.trim(),
            category: 'Umumiy',
            quantity: Math.max(1, Number(quantity) || 1),
            coverUrl: effectiveCoverUrl,
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            group: group.trim(),
            course: course.trim(),
            borrowedAtIso,
            dueDateIso,
            signatureDataUrl,
            ...(capturedFaceEnrollment
              ? {
                  facePhotoUrl: capturedFaceEnrollment.facePhotoUrl,
                  faceDescriptor: capturedFaceEnrollment.faceDescriptor,
                  descriptorHash: capturedFaceEnrollment.descriptorHash,
                }
              : {}),
          },
        });
        onOfflineQueued(nextQ);
        setOfflineNotice(
          'Server bilan aloqa uzildi yoki kunlik limit to‘ldi. Operatsiya saqlandi va tizim tiklanishi bilan avtomatik yuboriladi.'
        );
      } else {
        setErrorMsg(
          err instanceof Error ? err.message : 'Yangi kitobni rasmiylashtirishda xatolik yuz berdi.'
        );
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-start sm:items-center justify-center p-2.5 sm:p-5 overflow-y-auto">
      <div className="w-full max-w-3xl rounded-2xl bg-white border border-slate-200 shadow-2xl overflow-hidden my-auto">
        <div className="flex items-center justify-between px-5 sm:px-6 py-4 border-b border-slate-200 bg-slate-50/70">
          <div>
            <h2 className="font-display text-xl font-bold text-slate-900">
              Yangi kitob olish
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Katalogda hali mavjud bo‘lmagan kitobni ma’lumotlarini kiritib oling
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              stopCamera();
              onClose();
            }}
            className="w-10 h-10 rounded-xl flex items-center justify-center text-slate-500 hover:bg-slate-200/70 hover:text-slate-900 transition-colors shrink-0"
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
                Yangi kitob katalogga qo‘shildi va rasmiylashtirildi
              </h3>
              <p className="text-sm text-slate-600 max-w-md">
                Kitob katalogda saqlandi hamda admin panelga «Hali topshirilmagan» holati bilan yuborildi.
              </p>
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50 p-5 grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-xs text-slate-500 block">Kitob nomi va raqami</span>
                <span className="font-semibold text-slate-900">
                  {receipt.bookTitle} (№ {receipt.bookNumber})
                </span>
                {receipt.extraBookNumber && (
                  <span className="text-xs font-mono text-amber-800 block mt-0.5">
                    Qo‘shimcha raqami: {receipt.extraBookNumber}
                  </span>
                )}
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
              <div>
                <span className="text-xs text-slate-500 block">Qaytarish muddati</span>
                <span className="font-mono font-semibold text-blue-700 tabular-nums">
                  {formatUzDate(receipt.dueDate)}
                </span>
              </div>
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
          <form onSubmit={handleSubmit} className="p-5 sm:p-6 space-y-6 max-h-[85dvh] overflow-y-auto">
            {offlineNotice && (
              <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 flex items-start gap-3 text-sm text-amber-900">
                <WifiOff className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
                <p>{offlineNotice}</p>
              </div>
            )}

            {errorMsg && (
              <div className="rounded-xl border border-red-200 bg-red-50 p-4 flex items-start gap-3 text-sm text-red-800">
                <AlertTriangle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                <p>{errorMsg}</p>
              </div>
            )}

            {/* Step 1: Book Cover Preview (Unified default cover, optional custom camera capture) */}
            <div className="space-y-3">
              <label className="text-sm font-semibold text-slate-800 block">
                1. Kitob muqovasi (umumiy yagona dizayn avtomatik qo‘yiladi)
              </label>

              <div className="grid grid-cols-1 sm:grid-cols-[170px_1fr] gap-4 items-center">
                <div className="relative aspect-[3/4] w-full max-w-[170px] mx-auto sm:mx-0 rounded-xl overflow-hidden bg-slate-900 border border-slate-200 flex items-center justify-center">
                  {cameraActive ? (
                    <video
                      ref={videoRef}
                      autoPlay
                      playsInline
                      muted
                      className={`w-full h-full object-cover ${
                        facingMode === 'user' ? 'scale-x-[-1]' : ''
                      }`}
                    />
                  ) : (
                    <BookCoverImage
                      coverUrl={coverUrl}
                      title={bookTitle || 'Yangi kitob'}
                      bookNumber={bookNumber || suggestedBookNumber}
                      className="w-full h-full"
                    />
                  )}
                </div>

                <div className="space-y-3">
                  {cameraError && (
                    <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl p-3">
                      {cameraError}
                    </p>
                  )}

                  <div className="flex flex-wrap gap-2">
                    {cameraActive ? (
                      <>
                        <button
                          type="button"
                          onClick={handleCapturePhoto}
                          className="inline-flex items-center gap-2 min-h-[42px] px-4 py-2 text-xs sm:text-sm font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-xl transition-colors"
                        >
                          <Camera className="w-4 h-4" />
                          <span>Rasmga olish</span>
                        </button>
                        <button
                          type="button"
                          onClick={handleToggleFacing}
                          className="inline-flex items-center gap-1.5 min-h-[42px] px-3 py-2 text-xs font-semibold text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors"
                        >
                          <SwitchCamera className="w-4 h-4" />
                          <span>{facingMode === 'environment' ? 'Old kamera' : 'Orqa kamera'}</span>
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            setCoverUrl('');
                            void startCamera(facingMode);
                          }}
                          className="inline-flex items-center gap-2 min-h-[42px] px-4 py-2 text-xs font-semibold text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors"
                        >
                          {coverUrl ? <RefreshCw className="w-4 h-4" /> : <Camera className="w-4 h-4" />}
                          <span>{coverUrl ? 'Qayta rasmga olish' : 'Kamera bilan rasm'}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => frontCameraInputRef.current?.click()}
                          className="inline-flex items-center gap-1.5 min-h-[42px] px-3.5 py-2 text-xs font-semibold text-blue-800 bg-blue-50 border border-blue-200 hover:bg-blue-100 rounded-xl transition-colors"
                        >
                          <Camera className="w-4 h-4" />
                          <span>Old kamera</span>
                        </button>
                      </>
                    )}

                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="inline-flex items-center gap-2 min-h-[42px] px-4 py-2 text-xs font-semibold text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors"
                    >
                      <Upload className="w-4 h-4" />
                      <span>Fayldan (ixtiyoriy)</span>
                    </button>
                  </div>

                  <p className="text-xs text-slate-500">
                    Barcha kitoblarga yagona IIV Andijon Akademik litseyi muqovasi va kitob nomi avtomatik biriktiriladi.
                  </p>
                </div>
              </div>

              <input
                ref={frontCameraInputRef}
                type="file"
                accept="image/*"
                capture="user"
                onChange={handleFileUpload}
                className="hidden"
              />
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleFileUpload}
                className="hidden"
              />
            </div>

            {/* Step 2: New Book Details */}
            <div className="space-y-3">
              <label className="text-sm font-semibold text-slate-800 block">
                2. Kitob ma’lumotlari
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-600 mb-1">
                    Kitob nomi *
                  </label>
                  <input
                    type="text"
                    required
                    value={bookTitle}
                    onChange={(e) => setBookTitle(e.target.value)}
                    placeholder="Masalan: Jinoyat huquqi asoslari"
                    className="w-full min-h-[44px] px-3.5 py-2 text-sm rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">
                    Kitob raqami *
                  </label>
                  <input
                    type="text"
                    required
                    value={bookNumber}
                    onChange={(e) => setBookNumber(e.target.value)}
                    placeholder="Masalan: 006"
                    className="w-full min-h-[44px] px-3.5 py-2 text-sm font-mono rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">
                    Kutubxonadagi soni (dona) *
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={500}
                    required
                    value={quantity}
                    onChange={(e) => setQuantity(Number(e.target.value))}
                    className="w-full min-h-[44px] px-3.5 py-2 text-sm font-mono rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-600 mb-1">
                    Qo‘shimcha kitob raqami (ixtiyoriy — kitobning boshqacha nomi)
                  </label>
                  <input
                    type="text"
                    maxLength={64}
                    value={extraBookNumber}
                    onChange={(e) => setExtraBookNumber(e.target.value)}
                    placeholder="Kitobning boshqacha nomi yoki qo‘shimcha raqami (majburiy emas)"
                    className="w-full min-h-[44px] px-3.5 py-2 text-sm rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-600 mb-1">
                    Muallif (ixtiyoriy)
                  </label>
                  <input
                    type="text"
                    value={author}
                    onChange={(e) => setAuthor(e.target.value)}
                    placeholder="Muallif ismi"
                    className="w-full min-h-[44px] px-3.5 py-2 text-sm rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
              </div>
            </div>

            {/* Step 3: Student Info */}
            <div className="space-y-3">
              <label className="text-sm font-semibold text-slate-800 block">
                3. O‘quvchi ma’lumotlari
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
                    list="new-book-group-suggestions"
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
                  <datalist id="new-book-group-suggestions">
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

            {/* Step 4: Face ID Enrollment */}
            <FaceCaptureBox
              mode="enroll"
              firstName={firstName}
              lastName={lastName}
              savedProfile={savedFaceProfile}
              isLookingUpProfile={isLookingUpFace}
              capturedEnrollment={capturedFaceEnrollment}
              onCaptureEnrollment={setCapturedFaceEnrollment}
              stepNumber={4}
            />

            {/* Step 5: Date (Kun, Oy, Yil) */}
            <div className="space-y-2.5">
              <label className="text-sm font-semibold text-slate-800 block">
                5. Olayotgan sana (kun, oy, yil) *
              </label>
              <UzDateSelects
                value={borrowDateStr}
                onChange={setBorrowDateStr}
                labelPrefix="Olish sanasi"
              />
              <p className="text-xs text-slate-500 font-mono tabular-nums">
                Qaytarish muddati:{' '}
                {formatUzDate(buildBorrowAndDueIso(borrowDateStr, defaultLoanDays).dueDateIso)}{' '}
                ({defaultLoanDays} kun)
              </p>
            </div>

            {/* Step 6: Electronic Signature */}
            <SignaturePad
              onChange={setSignatureDataUrl}
              label="6. Elektron imzo *"
            />

            <div className="flex flex-wrap items-center justify-end gap-3 pt-2 border-t border-slate-200">
              <button
                type="button"
                onClick={() => {
                  stopCamera();
                  onClose();
                }}
                className="min-h-[48px] px-5 py-2.5 text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors"
              >
                Bekor qilish
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="min-h-[48px] px-6 py-2.5 text-sm font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-xl transition-colors disabled:opacity-60"
              >
                {isSubmitting ? 'Saqlanmoqda...' : 'TASDIQLASH VA YANGI KITOB OLISH'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

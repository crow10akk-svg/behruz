import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  RefreshCw,
  Upload,
  WifiOff,
  X,
} from 'lucide-react';
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
  formatUzDate,
  formatUzDateTime,
  makeSafeDocId,
} from '../lib/imageUtils.ts';
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

  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [coverUrl, setCoverUrl] = useState<string>('');

  const [bookTitle, setBookTitle] = useState('');
  const [bookNumber, setBookNumber] = useState(suggestedBookNumber);
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

  const startCamera = async () => {
    setCameraError(null);
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Brauzer kamerani qo‘llab-quvvatlamaydi');
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: false,
      });
      streamRef.current = stream;
      setCameraActive(true);
      requestAnimationFrame(async () => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          try {
            await videoRef.current.play();
          } catch {
            // ignore autoplay block
          }
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Kamera ruxsati berilmadi';
      setCameraError(
        `Kameraga ulanib bo‘lmadi (${msg}). Quyidagi tugma orqali kitob rasmini fayldan tanlashingiz mumkin.`
      );
      setCameraActive(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      setCoverUrl('');
      setBookTitle('');
      setBookNumber(suggestedBookNumber);
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
      startCamera();
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
    if (!navigator.onLine) return true;
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

    if (!coverUrl) {
      setErrorMsg('Iltimos, avval yangi kitobning rasmini kameradan oling yoki yuklang.');
      return;
    }
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
          bookTitle: bookTitle.trim(),
          author: author.trim(),
          category: 'Umumiy',
          quantity: Math.max(1, Number(quantity) || 1),
          coverUrl,
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
        author,
        quantity,
        coverUrl,
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
        coverUrl,
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
            bookTitle: bookTitle.trim(),
            author: author.trim(),
            category: 'Umumiy',
            quantity: Math.max(1, Number(quantity) || 1),
            coverUrl,
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            group: group.trim(),
            course: course.trim(),
            borrowedAtIso,
            dueDateIso,
            signatureDataUrl,
          },
        });
        onOfflineQueued(nextQ);
        setOfflineNotice(
          'Server bilan aloqa uzildi. Operatsiya saqlandi va aloqa tiklanishi bilan avtomatik yuboriladi.'
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
    <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-3 sm:p-5 overflow-y-auto">
      <div className="w-full max-w-3xl rounded-2xl bg-white border border-slate-200 shadow-2xl overflow-hidden my-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-slate-50/70">
          <div>
            <h2 className="font-display text-xl font-bold text-slate-900">
              Yangi kitob olish
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Katalogda hali mavjud bo‘lmagan kitobni rasmga olib, ma’lumotlarini kiritib oling
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              stopCamera();
              onClose();
            }}
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
          <form onSubmit={handleSubmit} className="p-6 space-y-6 max-h-[82vh] overflow-y-auto">
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

            {/* Step 1: Inline Live Camera Capture for New Book */}
            <div className="space-y-3">
              <label className="text-sm font-semibold text-slate-800 block">
                1. Kitob muqovasini rasmga olish *
              </label>

              <div className="grid grid-cols-1 sm:grid-cols-[200px_1fr] gap-4 items-start">
                <div className="relative aspect-[3/4] w-full max-w-[200px] mx-auto sm:mx-0 rounded-xl overflow-hidden bg-slate-900 border border-slate-200 flex items-center justify-center">
                  {coverUrl ? (
                    <img
                      src={coverUrl}
                      alt="Olingan kitob muqovasi"
                      className="w-full h-full object-cover"
                    />
                  ) : cameraActive ? (
                    <video
                      ref={videoRef}
                      playsInline
                      muted
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="text-center p-3 text-slate-300 text-xs space-y-2">
                      <Camera className="w-8 h-8 mx-auto text-slate-400" />
                      <span>Kitob rasmi olinmagan</span>
                    </div>
                  )}
                </div>

                <div className="space-y-3">
                  {cameraError && (
                    <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl p-3">
                      {cameraError}
                    </p>
                  )}

                  <div className="flex flex-wrap gap-2.5">
                    {cameraActive && !coverUrl ? (
                      <button
                        type="button"
                        onClick={handleCapturePhoto}
                        className="inline-flex items-center gap-2 min-h-[46px] px-5 py-2.5 text-sm font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-xl transition-colors"
                      >
                        <Camera className="w-4 h-4" />
                        <span>Rasmga olish</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setCoverUrl('');
                          startCamera();
                        }}
                        className="inline-flex items-center gap-2 min-h-[46px] px-4 py-2.5 text-sm font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-xl transition-colors"
                      >
                        {coverUrl ? <RefreshCw className="w-4 h-4" /> : <Camera className="w-4 h-4" />}
                        <span>{coverUrl ? 'Qayta rasmga olish' : 'Kamerani yoqish'}</span>
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="inline-flex items-center gap-2 min-h-[46px] px-4 py-2.5 text-sm font-semibold text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors"
                    >
                      <Upload className="w-4 h-4" />
                      <span>Fayldan tanlash</span>
                    </button>
                  </div>

                  <p className="text-xs text-slate-500">
                    Kitob muqovasi katalogda boshqa o‘quvchilar ham ko‘rishi uchun avtomatik saqlanadi.
                  </p>
                </div>
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                capture="environment"
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

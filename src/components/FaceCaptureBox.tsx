import { useEffect, useRef, useState } from 'react';
import {
  Camera,
  CheckCircle2,
  Loader2,
  RefreshCw,
  ScanFace,
  ShieldCheck,
  SwitchCamera,
  Upload,
  UserCheck,
  AlertTriangle,
} from 'lucide-react';
import { openCameraStream, type CameraFacingMode } from '../lib/cameraUtils.ts';
import {
  compareFaceDescriptors,
  computeFaceDescriptorHash,
  extractFaceFromSource,
  makeFaceNameKey,
  preloadFaceModels,
} from '../lib/faceService.ts';
import type { FaceProfile } from '../types.ts';

export interface CapturedFaceEnrollment {
  facePhotoUrl: string;
  faceDescriptor: number[];
  descriptorHash: string;
}

export interface VerifiedFaceState {
  liveDescriptor: number[];
  similarityPct: number;
}

interface FaceCaptureBoxProps {
  mode: 'enroll' | 'verify';
  firstName: string;
  lastName: string;
  /** Enroll mode: auto-recalled profile from Firestore by ism + familiya */
  savedProfile?: FaceProfile | null;
  isLookingUpProfile?: boolean;
  /** Enroll mode: newly captured face data when no saved profile exists */
  capturedEnrollment?: CapturedFaceEnrollment | null;
  onCaptureEnrollment?: (data: CapturedFaceEnrollment | null) => void;
  /** Verify mode: borrower's saved FaceProfile to match against */
  targetFaceProfile?: FaceProfile | null;
  isResolvingTarget?: boolean;
  legacyNoFaceProfile?: boolean;
  adminOverride?: boolean;
  verifiedState?: VerifiedFaceState | null;
  onVerifiedStateChange?: (state: VerifiedFaceState | null) => void;
  /** Optional callback to ensure target FaceProfile is resolved right before comparing */
  onEnsureTargetProfile?: () => Promise<{
    faceProfile: FaceProfile | null;
    legacyNoFace: boolean;
    errorMessage?: string;
  }>;
  stepNumber?: number;
}

export function FaceCaptureBox({
  mode,
  firstName,
  lastName,
  savedProfile,
  isLookingUpProfile,
  capturedEnrollment,
  onCaptureEnrollment,
  targetFaceProfile,
  isResolvingTarget,
  legacyNoFaceProfile,
  adminOverride,
  verifiedState,
  onVerifiedStateChange,
  onEnsureTargetProfile,
  stepNumber = 3,
}: FaceCaptureBoxProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const frontCameraInputRef = useRef<HTMLInputElement | null>(null);

  const [cameraActive, setCameraActive] = useState(false);
  const [facingMode, setFacingMode] = useState<CameraFacingMode>('user');
  const [isProcessing, setIsProcessing] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [mismatchPct, setMismatchPct] = useState<number | null>(null);

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setCameraActive(false);
  };

  useEffect(() => {
    preloadFaceModels();
    return () => {
      stopCamera();
    };
  }, []);

  // Ensure <video> always receives the active stream after mounting on mobile browsers
  useEffect(() => {
    if (!cameraActive || !streamRef.current || !videoRef.current) return;
    const video = videoRef.current;
    if (video.srcObject !== streamRef.current) {
      video.srcObject = streamRef.current;
    }
    void video.play().catch(() => {
      // ignore autoplay restriction; playsInline + user click handles it
    });
  }, [cameraActive, facingMode]);

  // Stop camera automatically if savedProfile is auto-recalled in enroll mode or adminOverride enabled
  useEffect(() => {
    if (mode === 'enroll' && savedProfile) {
      stopCamera();
      setStatusError(null);
    }
    if (mode === 'verify' && (adminOverride || legacyNoFaceProfile)) {
      stopCamera();
      setStatusError(null);
    }
  }, [mode, savedProfile, adminOverride, legacyNoFaceProfile]);

  const startCamera = async (targetFacing: CameraFacingMode = facingMode) => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setStatusError(null);
    setMismatchPct(null);
    try {
      const stream = await openCameraStream(targetFacing, { width: 640, height: 480 });
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
      setStatusError(
        `Kamerani yoqib bo‘lmadi (${msg}). Quyidagi «Old kamera» yoki «Fayldan» tugmasi orqali rasm olishingiz mumkin.`
      );
      setCameraActive(false);
    }
  };

  const handleToggleFacing = () => {
    const next: CameraFacingMode = facingMode === 'user' ? 'environment' : 'user';
    setFacingMode(next);
    if (cameraActive) {
      void startCamera(next);
    }
  };

  const processSource = async (source: HTMLVideoElement | HTMLImageElement) => {
    setIsProcessing(true);
    setStatusError(null);
    setMismatchPct(null);

    try {
      const extracted = await extractFaceFromSource(source);

      if (mode === 'enroll') {
        if (!firstName.trim() || !lastName.trim()) {
          throw new Error('Avval o‘quvchining ism va familiyasini kiriting.');
        }
        const nameKey = makeFaceNameKey(firstName, lastName);
        const descriptorHash = await computeFaceDescriptorHash(
          nameKey,
          extracted.faceDescriptor
        );
        onCaptureEnrollment?.({
          facePhotoUrl: extracted.facePhotoUrl,
          faceDescriptor: extracted.faceDescriptor,
          descriptorHash,
        });
        stopCamera();
      } else {
        let profileToMatch = targetFaceProfile || null;
        let isLegacy = Boolean(legacyNoFaceProfile);

        if (!profileToMatch && !isLegacy && onEnsureTargetProfile) {
          const resolved = await onEnsureTargetProfile();
          if (resolved.errorMessage) {
            throw new Error(resolved.errorMessage);
          }
          profileToMatch = resolved.faceProfile;
          isLegacy = resolved.legacyNoFace;
        }

        if (isLegacy) {
          stopCamera();
          return;
        }

        if (!profileToMatch) {
          throw new Error(
            'Avval kitobni, ism, familiya va guruhni to‘liq kiriting — shundan so‘ng Face ID tekshiriladi.'
          );
        }

        const cmp = compareFaceDescriptors(
          extracted.faceDescriptor,
          profileToMatch.faceDescriptor
        );

        if (!cmp.match) {
          onVerifiedStateChange?.(null);
          setMismatchPct(cmp.similarityPct);
          throw new Error(
            `Yuz mos kelmadi! Kameradagi shaxs kitobni olgan o‘quvchi (${profileToMatch.fullName}) bilan bir xil emas. Qayta urinib ko‘ring.`
          );
        }

        onVerifiedStateChange?.({
          liveDescriptor: extracted.faceDescriptor,
          similarityPct: cmp.similarityPct,
        });
        stopCamera();
      }
    } catch (err) {
      setStatusError(
        err instanceof Error ? err.message : 'Face ID tahlilida xatolik yuz berdi.'
      );
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCaptureFromVideo = async () => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) {
      setStatusError('Kamera tasviri hali yuklanmadi. Biroz kuting.');
      return;
    }
    await processSource(video);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const objectUrl = URL.createObjectURL(file);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Rasmni o‘qib bo‘lmadi.'));
        image.src = objectUrl;
      });
      await processSource(img);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : 'Rasmni tekshirib bo‘lmadi.');
    } finally {
      URL.revokeObjectURL(objectUrl);
      e.target.value = '';
    }
  };

  if (mode === 'enroll') {
    const hasSaved = Boolean(savedProfile);
    const hasCaptured = Boolean(capturedEnrollment);

    return (
      <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ScanFace className="w-4 h-4 text-blue-700" />
            <label className="text-sm font-semibold text-slate-900">
              {stepNumber}. Face ID — Shaxsni tasdiqlovchi rasm *
            </label>
          </div>
          {isLookingUpProfile && (
            <span className="inline-flex items-center gap-1.5 text-xs text-blue-700 font-medium">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>Bazadan tekshirilmoqda...</span>
            </span>
          )}
        </div>

        {hasSaved && savedProfile ? (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50/80 p-3.5 flex flex-col sm:flex-row items-center gap-4">
            <div className="w-20 h-24 rounded-xl overflow-hidden border-2 border-emerald-400 bg-white shrink-0 shadow-xs">
              <img
                src={savedProfile.facePhotoUrl}
                alt={savedProfile.fullName}
                className="w-full h-full object-cover"
              />
            </div>
            <div className="flex-1 min-w-0 text-center sm:text-left space-y-1">
              <div className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-800">
                <UserCheck className="w-4 h-4" />
                <span>Saqlangan Face ID avtomatik topildi</span>
              </div>
              <p className="text-sm font-semibold text-slate-900 truncate">
                {savedProfile.fullName} · {savedProfile.group}
              </p>
              <p className="text-xs text-emerald-800">
                Avvalgi rasm ushbu ism-familiyaga doimiy biriktirilgan — qayta rasmga tushish shart emas.
              </p>
            </div>
            <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-emerald-200 text-xs font-semibold text-emerald-700 shrink-0">
              <ShieldCheck className="w-4 h-4" />
              <span>Himoyalangan</span>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-[170px_1fr] gap-4 items-center">
            <div className="relative aspect-[4/5] w-full max-w-[170px] mx-auto sm:mx-0 rounded-xl overflow-hidden bg-slate-900 border border-slate-300 flex items-center justify-center">
              {hasCaptured && capturedEnrollment ? (
                <img
                  src={capturedEnrollment.facePhotoUrl}
                  alt="Olingan Face ID rasmi"
                  className="w-full h-full object-cover"
                />
              ) : cameraActive ? (
                <>
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted
                    className={`w-full h-full object-cover ${
                      facingMode === 'user' ? 'scale-x-[-1]' : ''
                    }`}
                  />
                  <div className="pointer-events-none absolute inset-3 rounded-[45%] border-2 border-dashed border-blue-400/80" />
                </>
              ) : (
                <div className="text-center p-3 text-slate-300 text-xs space-y-2">
                  <ScanFace className="w-9 h-9 mx-auto text-slate-400" />
                  <span>Yuz rasmi olinmagan</span>
                </div>
              )}
            </div>

            <div className="space-y-3">
              {hasCaptured ? (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900 flex items-start gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" />
                  <span>
                    Face ID muvaffaqiyatli aniqlandi! Ushbu rasm{' '}
                    <strong>
                      {firstName.trim() || 'o‘quvchi'} {lastName.trim()}
                    </strong>{' '}
                    nomiga butunlay saqlanadi.
                  </span>
                </div>
              ) : (
                <p className="text-xs text-slate-600 leading-relaxed">
                  Birinchi marta kitob olayotganda yuzingizni Face ID orqali rasmga oling. Keyingi safar ism-familiyangizni yozishingiz bilan ushbu rasm avtomatik chiqadi.
                </p>
              )}

              {statusError && (
                <div className="rounded-xl border border-red-200 bg-red-50 p-2.5 text-xs text-red-800 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                  <span>{statusError}</span>
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                {cameraActive && !hasCaptured ? (
                  <>
                    <button
                      type="button"
                      disabled={isProcessing}
                      onClick={handleCaptureFromVideo}
                      className="inline-flex items-center gap-2 min-h-[42px] px-4 py-2 text-xs sm:text-sm font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-xl transition-colors disabled:opacity-60"
                    >
                      {isProcessing ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Camera className="w-4 h-4" />
                      )}
                      <span>{isProcessing ? 'Yuz aniqlanmoqda...' : 'Rasmga tushish (Face ID)'}</span>
                    </button>
                    <button
                      type="button"
                      disabled={isProcessing}
                      onClick={handleToggleFacing}
                      className="inline-flex items-center gap-1.5 min-h-[42px] px-3 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-100 rounded-xl transition-colors disabled:opacity-60"
                    >
                      <SwitchCamera className="w-4 h-4" />
                      <span>{facingMode === 'user' ? 'Orqa kamera' : 'Old kamera'}</span>
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    disabled={isProcessing}
                    onClick={() => {
                      onCaptureEnrollment?.(null);
                      void startCamera(facingMode);
                    }}
                    className="inline-flex items-center gap-2 min-h-[42px] px-4 py-2 text-xs sm:text-sm font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-xl transition-colors disabled:opacity-60"
                  >
                    {hasCaptured ? (
                      <RefreshCw className="w-4 h-4" />
                    ) : (
                      <Camera className="w-4 h-4" />
                    )}
                    <span>{hasCaptured ? 'Qayta rasmga olish' : 'Face ID kamerasini yoqish'}</span>
                  </button>
                )}

                <button
                  type="button"
                  disabled={isProcessing}
                  onClick={() => frontCameraInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 min-h-[42px] px-3.5 py-2 text-xs font-semibold text-blue-800 bg-blue-50 border border-blue-200 hover:bg-blue-100 rounded-xl transition-colors disabled:opacity-60"
                >
                  <Camera className="w-4 h-4" />
                  <span>Old kamera (telefon)</span>
                </button>

                <button
                  type="button"
                  disabled={isProcessing}
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-2 min-h-[42px] px-3.5 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-100 rounded-xl transition-colors disabled:opacity-60"
                >
                  <Upload className="w-4 h-4" />
                  <span>Fayldan</span>
                </button>
              </div>
            </div>
          </div>
        )}

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
    );
  }

  // Verify Mode (Kitob topshirish)
  if (adminOverride) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-700 flex items-center gap-2.5">
        <ShieldCheck className="w-4 h-4 text-blue-700 shrink-0" />
        <span>
          Administrator tasdig‘i yoqilgan — Face ID tekshiruvisiz admin paroli bilan topshiriladi.
        </span>
      </div>
    );
  }

  if (legacyNoFaceProfile) {
    return (
      <div className="rounded-2xl border border-blue-200 bg-blue-50/70 p-4 text-xs text-blue-900 flex items-center gap-2.5">
        <UserCheck className="w-4 h-4 text-blue-700 shrink-0" />
        <span>
          Ushbu kitob avvalroq Face ID joriy etilishidan oldin olingan — ism, familiya va guruh bo‘yicha tasdiqlanadi.
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ScanFace className="w-4 h-4 text-blue-700" />
          <label className="text-sm font-semibold text-slate-900">
            {stepNumber}. Face ID bilan shaxsni tasdiqlash *
          </label>
        </div>
        {isResolvingTarget && (
          <span className="inline-flex items-center gap-1.5 text-xs text-blue-700 font-medium">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span>Ma’lumot tekshirilmoqda...</span>
          </span>
        )}
      </div>

      {verifiedState ? (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3.5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            {targetFaceProfile?.facePhotoUrl ? (
              <img
                src={targetFaceProfile.facePhotoUrl}
                alt={targetFaceProfile.fullName}
                className="w-14 h-16 rounded-lg object-cover border border-emerald-300"
              />
            ) : (
              <div className="w-12 h-12 rounded-xl bg-emerald-100 text-emerald-700 flex items-center justify-center">
                <CheckCircle2 className="w-6 h-6" />
              </div>
            )}
            <div>
              <p className="text-sm font-bold text-emerald-900 flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-emerald-700" />
                <span>Face ID tasdiqlandi ({verifiedState.similarityPct}% mos)</span>
              </p>
              <p className="text-xs text-emerald-800 mt-0.5">
                Faqat yuz tuzilishi solishtirildi — kiyim va fon farqi inobatga olinmaydi.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              onVerifiedStateChange?.(null);
              void startCamera(facingMode);
            }}
            className="text-xs font-semibold text-emerald-800 hover:underline"
          >
            Qayta tekshirish
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-[170px_1fr] gap-4 items-center">
          <div className="relative aspect-[4/5] w-full max-w-[170px] mx-auto sm:mx-0 rounded-xl overflow-hidden bg-slate-900 border border-slate-300 flex items-center justify-center">
            {cameraActive ? (
              <>
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className={`w-full h-full object-cover ${
                    facingMode === 'user' ? 'scale-x-[-1]' : ''
                  }`}
                />
                <div className="pointer-events-none absolute inset-3 rounded-[45%] border-2 border-dashed border-emerald-400/80" />
              </>
            ) : (
              <div className="text-center p-3 text-slate-300 text-xs space-y-2">
                <ScanFace className="w-9 h-9 mx-auto text-slate-400" />
                <span>Face ID kutmoqda</span>
              </div>
            )}
          </div>

          <div className="space-y-3">
            <p className="text-xs text-slate-600 leading-relaxed">
              Kitobni topshirish uchun kameraga qarang. Tizim faqat yuzingizni kitob olgan vaqtdagi yuz bilan solishtiradi (kiyim boshqa bo‘lsa ham muammo yo‘q).
            </p>

            {targetFaceProfile && (
              <div className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 text-[11px] text-slate-700">
                <ShieldCheck className="w-3.5 h-3.5 text-blue-700" />
                <span>
                  Solishtiriladigan egasi: <strong>{targetFaceProfile.fullName}</strong> ({targetFaceProfile.group})
                </span>
              </div>
            )}

            {statusError && (
              <div className="rounded-xl border border-red-200 bg-red-50 p-2.5 text-xs text-red-800 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                <div>
                  <p>{statusError}</p>
                  {mismatchPct !== null && (
                    <p className="font-mono text-[11px] text-red-700 mt-0.5">
                      O‘xshashlik darajasi: {mismatchPct}% (tasdiqlash uchun yetarli emas)
                    </p>
                  )}
                </div>
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              {cameraActive ? (
                <>
                  <button
                    type="button"
                    disabled={isProcessing || isResolvingTarget}
                    onClick={handleCaptureFromVideo}
                    className="inline-flex items-center gap-2 min-h-[42px] px-4 py-2 text-xs sm:text-sm font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-xl transition-colors disabled:opacity-60"
                  >
                    {isProcessing ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <ScanFace className="w-4 h-4" />
                    )}
                    <span>{isProcessing ? 'Tekshirilmoqda...' : 'Yuzni tasdiqlash (Face ID)'}</span>
                  </button>
                  <button
                    type="button"
                    disabled={isProcessing || isResolvingTarget}
                    onClick={handleToggleFacing}
                    className="inline-flex items-center gap-1.5 min-h-[42px] px-3 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-100 rounded-xl transition-colors disabled:opacity-60"
                  >
                    <SwitchCamera className="w-4 h-4" />
                    <span>{facingMode === 'user' ? 'Orqa kamera' : 'Old kamera'}</span>
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  disabled={isProcessing || isResolvingTarget}
                  onClick={() => void startCamera(facingMode)}
                  className="inline-flex items-center gap-2 min-h-[42px] px-4 py-2 text-xs sm:text-sm font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-xl transition-colors disabled:opacity-60"
                >
                  <Camera className="w-4 h-4" />
                  <span>Face ID kamerasini yoqish</span>
                </button>
              )}

              <button
                type="button"
                disabled={isProcessing || isResolvingTarget}
                onClick={() => frontCameraInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 min-h-[42px] px-3.5 py-2 text-xs font-semibold text-blue-800 bg-blue-50 border border-blue-200 hover:bg-blue-100 rounded-xl transition-colors disabled:opacity-60"
              >
                <Camera className="w-4 h-4" />
                <span>Old kamera (telefon)</span>
              </button>

              <button
                type="button"
                disabled={isProcessing || isResolvingTarget}
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-2 min-h-[42px] px-3.5 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-100 rounded-xl transition-colors disabled:opacity-60"
              >
                <Upload className="w-4 h-4" />
                <span>Rasm orqali</span>
              </button>
            </div>
          </div>
        </div>
      )}

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
  );
}

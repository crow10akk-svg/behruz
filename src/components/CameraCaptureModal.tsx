import { useEffect, useRef, useState } from 'react';
import { Camera, Check, RefreshCw, X } from 'lucide-react';
import { compressImageElementToDataUrl } from '../lib/imageUtils.ts';

interface CameraCaptureModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCapture: (dataUrl: string) => void;
}

export function CameraCaptureModal({
  isOpen,
  onClose,
  onCapture,
}: CameraCaptureModalProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [capturedUrl, setCapturedUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);

  const stopStream = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  };

  const startCamera = async () => {
    setErrorMsg(null);
    setCapturedUrl(null);
    setIsStarting(true);
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Brauzer kameraga ulanishni qo‘llab-quvvatlamaydi.');
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Kamerani ochib bo‘lmadi. Ruxsat berilganligini tekshiring.';
      setErrorMsg(
        `Kameraga ulanib bo‘lmadi (${msg}). Qurilmada kamera mavjudligini va ruxsat berilganligini tekshiring yoki fayldan yuklash usulidan foydalaning.`
      );
    } finally {
      setIsStarting(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      startCamera();
    } else {
      stopStream();
      setCapturedUrl(null);
      setErrorMsg(null);
    }
    return () => {
      stopStream();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const handleTakeShot = () => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;
    const dataUrl = compressImageElementToDataUrl(video, 360, 480, 0.72);
    setCapturedUrl(dataUrl);
    stopStream();
  };

  const handleRetake = () => {
    startCamera();
  };

  const handleConfirm = () => {
    if (!capturedUrl) return;
    onCapture(capturedUrl);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white border border-slate-200 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <div className="flex items-center gap-2.5">
            <Camera className="w-5 h-5 text-blue-700" />
            <h3 className="font-display font-semibold text-slate-900">
              Kamera orqali kitob rasmini olish
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-9 h-9 rounded-lg flex items-center justify-center text-slate-500 hover:bg-slate-100 hover:text-slate-900 transition-colors"
            aria-label="Yopish"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {errorMsg ? (
            <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 space-y-3">
              <p>{errorMsg}</p>
              <button
                type="button"
                onClick={startCamera}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold bg-white border border-red-200 text-red-700 rounded-lg hover:bg-red-100 transition-colors"
              >
                <RefreshCw className="w-4 h-4" />
                <span>Qayta urinish</span>
              </button>
            </div>
          ) : (
            <div className="relative aspect-[3/4] max-h-[380px] mx-auto rounded-xl overflow-hidden bg-slate-900 border border-slate-200 flex items-center justify-center">
              {capturedUrl ? (
                <img
                  src={capturedUrl}
                  alt="Olingan kitob muqovasi"
                  className="w-full h-full object-contain bg-slate-950"
                />
              ) : (
                <>
                  <video
                    ref={videoRef}
                    playsInline
                    muted
                    className="w-full h-full object-cover"
                  />
                  {isStarting && (
                    <div className="absolute inset-0 bg-slate-900/80 flex items-center justify-center text-sm text-slate-200">
                      Kamera ishga tushirilmoqda...
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="min-h-[44px] px-4 py-2 text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors"
            >
              Bekor qilish
            </button>
            {capturedUrl ? (
              <>
                <button
                  type="button"
                  onClick={handleRetake}
                  className="inline-flex items-center gap-2 min-h-[44px] px-4 py-2 text-sm font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors"
                >
                  <RefreshCw className="w-4 h-4" />
                  <span>Qayta olish</span>
                </button>
                <button
                  type="button"
                  onClick={handleConfirm}
                  className="inline-flex items-center gap-2 min-h-[44px] px-5 py-2 text-sm font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-xl transition-colors"
                >
                  <Check className="w-4 h-4" />
                  <span>Rasmni tasdiqlash</span>
                </button>
              </>
            ) : (
              !errorMsg && (
                <button
                  type="button"
                  onClick={handleTakeShot}
                  disabled={isStarting}
                  className="inline-flex items-center gap-2 min-h-[44px] px-5 py-2 text-sm font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-50 rounded-xl transition-colors"
                >
                  <Camera className="w-4 h-4" />
                  <span>Rasmga olish</span>
                </button>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

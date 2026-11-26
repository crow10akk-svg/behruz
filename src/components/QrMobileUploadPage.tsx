import { useRef, useState } from 'react';
import { AlertCircle, Camera, CheckCircle2, ShieldCheck, SwitchCamera, Upload } from 'lucide-react';
import { compressFileToDataUrl } from '../lib/imageUtils.ts';
import { submitQrUploadPhoto } from '../lib/libraryService.ts';

interface QrMobileUploadPageProps {
  sessionId: string;
}

export function QrMobileUploadPage({ sessionId }: QrMobileUploadPageProps) {
  const rearCameraInputRef = useRef<HTMLInputElement | null>(null);
  const frontCameraInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [isSent, setIsSent] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleSelectedFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setErrorMsg(null);
    setIsSending(true);
    try {
      const compressed = await compressFileToDataUrl(file);
      setPreviewUrl(compressed);
      await submitQrUploadPhoto(sessionId, compressed);
      setIsSent(true);
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Rasmni yuborishda xatolik yuz berdi. Qaytadan urinib ko‘ring.'
      );
    } finally {
      setIsSending(false);
      e.target.value = '';
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl bg-white border border-slate-200 shadow-lg overflow-hidden">
        <div className="bg-[#0F2942] text-white px-5 py-4 flex items-center gap-3">
          <span className="w-9 h-9 rounded-lg bg-blue-600 flex items-center justify-center shrink-0">
            <ShieldCheck className="w-5 h-5" />
          </span>
          <div>
            <p className="font-display font-bold text-sm">Smart Kutubxona</p>
            <p className="text-[11px] text-slate-300">QR kod orqali rasm yuklash</p>
          </div>
        </div>

        <div className="p-6 space-y-5">
          {errorMsg && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3.5 flex items-start gap-2.5 text-xs text-red-800">
              <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
          )}

          {isSent && previewUrl ? (
            <div className="text-center space-y-4">
              <div className="w-12 h-12 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-700 flex items-center justify-center mx-auto">
                <CheckCircle2 className="w-7 h-7" />
              </div>
              <div className="space-y-1">
                <h2 className="font-display text-lg font-bold text-slate-900">
                  Rasm muvaffaqiyatli yuborildi
                </h2>
                <p className="text-xs text-slate-600">
                  Admin paneldagi kitob qo‘shish oynasi avtomatik ravishda ushbu rasm bilan yangilandi.
                </p>
              </div>
              <img
                src={previewUrl}
                alt="Yuborilgan kitob rasmi"
                className="w-40 aspect-[3/4] object-cover rounded-xl border border-slate-200 mx-auto"
              />
              <div className="grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={() => {
                    setIsSent(false);
                    rearCameraInputRef.current?.click();
                  }}
                  className="min-h-[46px] px-3 py-2 text-xs sm:text-sm font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-xl transition-colors"
                >
                  Orqa kamera
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setIsSent(false);
                    frontCameraInputRef.current?.click();
                  }}
                  className="min-h-[46px] px-3 py-2 text-xs sm:text-sm font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-xl transition-colors"
                >
                  Old kamera
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="space-y-1.5 text-center">
                <h1 className="font-display text-lg font-bold text-slate-900">
                  Kamera bilan rasmga oling
                </h1>
                <p className="text-xs text-slate-500">
                  Telefonning orqa yoki old kamerasi orqali rasmga oling yoxud galereyadan tanlang. Rasm darhol admin panelga uzatiladi.
                </p>
              </div>

              <div className="space-y-3">
                <button
                  type="button"
                  disabled={isSending}
                  onClick={() => rearCameraInputRef.current?.click()}
                  className="w-full min-h-[52px] inline-flex items-center justify-center gap-2.5 px-5 py-3 text-sm font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-xl transition-colors disabled:opacity-60"
                >
                  <Camera className="w-5 h-5" />
                  <span>{isSending ? 'Yuborilmoqda...' : 'Orqa kamera bilan rasmga olish'}</span>
                </button>

                <button
                  type="button"
                  disabled={isSending}
                  onClick={() => frontCameraInputRef.current?.click()}
                  className="w-full min-h-[50px] inline-flex items-center justify-center gap-2.5 px-5 py-2.5 text-sm font-semibold text-blue-900 bg-blue-50 border border-blue-200 hover:bg-blue-100 rounded-xl transition-colors disabled:opacity-60"
                >
                  <SwitchCamera className="w-5 h-5 text-blue-700" />
                  <span>{isSending ? 'Yuborilmoqda...' : 'Old kamera bilan rasmga olish'}</span>
                </button>

                <button
                  type="button"
                  disabled={isSending}
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full min-h-[48px] inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors disabled:opacity-60"
                >
                  <Upload className="w-4 h-4" />
                  <span>Galereyadan rasm tanlash</span>
                </button>
              </div>
            </>
          )}

          <input
            ref={rearCameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handleSelectedFile}
            className="hidden"
          />
          <input
            ref={frontCameraInputRef}
            type="file"
            accept="image/*"
            capture="user"
            onChange={handleSelectedFile}
            className="hidden"
          />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleSelectedFile}
            className="hidden"
          />
        </div>
      </div>
    </div>
  );
}

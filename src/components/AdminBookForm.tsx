import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import {
  AlertCircle,
  Camera,
  CheckCircle2,
  QrCode,
  Smartphone,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { BookCoverImage } from './BookCoverImage.tsx';
import { CameraCaptureModal } from './CameraCaptureModal.tsx';
import { compressFileToDataUrl, makeSafeDocId } from '../lib/imageUtils.ts';
import {
  createBookAdmin,
  createQrUploadSession,
  deleteQrUploadSession,
  subscribeQrUploadSession,
  updateBookAdmin,
} from '../lib/libraryService.ts';
import type { Book } from '../types.ts';

interface AdminBookFormProps {
  editingBook?: Book | null;
  existingBooks?: Book[];
  suggestedNextNumber?: string;
  onSuccess: () => void;
  onCancel?: () => void;
}

export function AdminBookForm({
  editingBook,
  existingBooks,
  suggestedNextNumber = '006',
  onSuccess,
  onCancel,
}: AdminBookFormProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [bookNumber, setBookNumber] = useState(editingBook?.bookNumber || suggestedNextNumber);
  const [title, setTitle] = useState(editingBook?.title || '');
  const [author, setAuthor] = useState(editingBook?.author || '');
  const [category, setCategory] = useState(editingBook?.category || 'O‘quv qo‘llanma');
  const [quantity, setQuantity] = useState(editingBook?.quantity || 1);
  const [description, setDescription] = useState(editingBook?.description || '');
  const [coverUrl, setCoverUrl] = useState(editingBook?.coverUrl || '');

  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [qrModalState, setQrModalState] = useState<{
    open: boolean;
    sessionId: string;
    qrDataUrl: string;
    uploadUrl: string;
    received: boolean;
  }>({ open: false, sessionId: '', qrDataUrl: '', uploadUrl: '', received: false });

  const [isSaving, setIsSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  useEffect(() => {
    if (editingBook) {
      setBookNumber(editingBook.bookNumber);
      setTitle(editingBook.title);
      setAuthor(editingBook.author || '');
      setCategory(editingBook.category || 'Umumiy');
      setQuantity(editingBook.quantity || 1);
      setDescription(editingBook.description || '');
      setCoverUrl(editingBook.coverUrl || '');
    } else {
      setBookNumber(suggestedNextNumber);
      setTitle('');
      setAuthor('');
      setCategory('O‘quv qo‘llanma');
      setQuantity(1);
      setDescription('');
      setCoverUrl('');
    }
    setErrorMsg(null);
    setSuccessMsg(null);
  }, [editingBook, suggestedNextNumber]);

  // Listen in real time for phone photo uploaded via QR code
  useEffect(() => {
    if (!qrModalState.open || !qrModalState.sessionId) return;
    const unsub = subscribeQrUploadSession(
      qrModalState.sessionId,
      (uploadedImage) => {
        setCoverUrl(uploadedImage);
        setQrModalState((prev) => ({ ...prev, received: true }));
        setTimeout(() => {
          deleteQrUploadSession(qrModalState.sessionId);
          setQrModalState({
            open: false,
            sessionId: '',
            qrDataUrl: '',
            uploadUrl: '',
            received: false,
          });
        }, 150);
      },
      () => {
        // Ignore transient subscription errors
      }
    );
    return () => {
      unsub();
    };
  }, [qrModalState.open, qrModalState.sessionId]);

  const handleOpenQrUpload = async () => {
    setErrorMsg(null);
    try {
      const sessionId = makeSafeDocId('qr');
      const uploadUrl = `${window.location.origin}/?qrUpload=${encodeURIComponent(sessionId)}`;
      const qrPromise = QRCode.toDataURL(uploadUrl, {
        width: 280,
        margin: 2,
        color: { dark: '#0F2942', light: '#FFFFFF' },
      });
      const sessionPromise = createQrUploadSession(sessionId);
      const qrDataUrl = await qrPromise;
      setQrModalState({
        open: true,
        sessionId,
        qrDataUrl,
        uploadUrl,
        received: false,
      });
      await sessionPromise;
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'QR kod yaratishda xatolik yuz berdi.'
      );
    }
  };

  const handleCloseQrModal = () => {
    if (qrModalState.sessionId) {
      deleteQrUploadSession(qrModalState.sessionId);
    }
    setQrModalState({
      open: false,
      sessionId: '',
      qrDataUrl: '',
      uploadUrl: '',
      received: false,
    });
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setErrorMsg(null);
    try {
      const compressed = await compressFileToDataUrl(file);
      setCoverUrl(compressed);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Rasmni yuklab bo‘lmadi.');
    } finally {
      e.target.value = '';
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);
    setIsSaving(true);

    try {
      if (editingBook) {
        await updateBookAdmin(editingBook.id, {
          bookNumber,
          title,
          author,
          category,
          description,
          coverUrl,
          quantity,
          existingBooks,
        });
        setSuccessMsg('Kitob ma’lumotlari muvaffaqiyatli yangilandi.');
      } else {
        await createBookAdmin({
          bookNumber,
          title,
          author,
          category,
          description,
          coverUrl,
          quantity,
          existingBooks,
        });
        setSuccessMsg('Yangi kitob katalogga muvaffaqiyatli qo‘shildi!');
        setTitle('');
        setAuthor('');
        setDescription('');
        setCoverUrl('');
      }
      onSuccess();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Saqlashda xatolik yuz berdi.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="bg-white rounded-2xl border border-slate-200 p-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
        <div>
          <h3 className="font-display text-xl font-bold text-slate-900">
            {editingBook ? `Kitobni tahrirlash (№ ${editingBook.bookNumber})` : 'Yangi kitob qo‘shish'}
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Qo‘shilgan kitob avtomatik ravishda o‘quvchilar katalogida paydo bo‘ladi
          </p>
        </div>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="min-h-[40px] px-4 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors"
          >
            Bekor qilish
          </button>
        )}
      </div>

      {errorMsg && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 flex items-start gap-2.5 text-sm text-red-800">
          <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
          <span>{errorMsg}</span>
        </div>
      )}

      {successMsg && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 flex items-start gap-2.5 text-sm text-emerald-800">
          <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
          <span>{successMsg}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[240px_1fr] gap-6">
        {/* Image Upload / Camera / QR Section */}
        <div className="space-y-3">
          <label className="block text-xs font-semibold text-slate-700">
            Kitob muqova rasmi
          </label>
          <div className="aspect-[3/4] w-full max-w-[240px] rounded-xl overflow-hidden border border-slate-200 bg-slate-100">
            <BookCoverImage
              coverUrl={coverUrl}
              title={title || 'Yangi kitob'}
              bookNumber={bookNumber || '000'}
              className="w-full h-full"
            />
          </div>

          <div className="grid grid-cols-1 gap-2">
            <button
              type="button"
              onClick={handleOpenQrUpload}
              className="inline-flex items-center justify-center gap-2 min-h-[42px] px-3.5 py-2 text-xs font-semibold text-white bg-[#0F2942] hover:bg-slate-800 rounded-xl transition-colors"
            >
              <QrCode className="w-4 h-4" />
              <span>QR kod orqali rasm qo‘shish</span>
            </button>

            <button
              type="button"
              onClick={() => setIsCameraOpen(true)}
              className="inline-flex items-center justify-center gap-2 min-h-[42px] px-3.5 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-xl transition-colors"
            >
              <Camera className="w-4 h-4" />
              <span>Kamera orqali rasmga olish</span>
            </button>

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center justify-center gap-2 min-h-[42px] px-3.5 py-2 text-xs font-semibold text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors"
            >
              <Upload className="w-4 h-4" />
              <span>Fayldan yuklash</span>
            </button>

            {coverUrl && (
              <button
                type="button"
                onClick={() => setCoverUrl('')}
                className="inline-flex items-center justify-center gap-2 min-h-[38px] px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 rounded-xl transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Rasmni olib tashlash</span>
              </button>
            )}

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              className="hidden"
            />
          </div>
        </div>

        {/* Form Fields */}
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Kitob raqami (Takrorlanmas) *
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
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Kitob soni (dona) *
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
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Kitob nomi *
            </label>
            <input
              type="text"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Masalan: O‘zbekiston tarixi"
              className="w-full min-h-[44px] px-3.5 py-2 text-sm rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Muallif
              </label>
              <input
                type="text"
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
                placeholder="Muallif ismi"
                className="w-full min-h-[44px] px-3.5 py-2 text-sm rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Fan / Kategoriya
              </label>
              <input
                type="text"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="Masalan: Huquqshunoslik, Tarix"
                className="w-full min-h-[44px] px-3.5 py-2 text-sm rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Qisqacha tavsif
            </label>
            <textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Kitob mazmuni haqida qisqacha ma’lumot..."
              className="w-full px-3.5 py-2.5 text-sm rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
          </div>

          <div className="pt-2 flex justify-end">
            <button
              type="submit"
              disabled={isSaving}
              className="min-h-[46px] px-6 py-2.5 text-sm font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-xl transition-colors disabled:opacity-60"
            >
              {isSaving
                ? 'Saqlanmoqda...'
                : editingBook
                  ? 'O‘zgarishlarni saqlash'
                  : 'Kitobni katalogga qo‘shish'}
            </button>
          </div>
        </div>
      </div>

      <CameraCaptureModal
        isOpen={isCameraOpen}
        onClose={() => setIsCameraOpen(false)}
        onCapture={(url) => setCoverUrl(url)}
      />

      {/* QR Code Photo Transfer Modal */}
      {qrModalState.open && (
        <div className="fixed inset-0 z-50 bg-slate-950/65 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-2xl bg-white border border-slate-200 shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
              <div className="flex items-center gap-2">
                <QrCode className="w-5 h-5 text-blue-700" />
                <h4 className="font-display font-bold text-slate-900">
                  QR kod orqali rasm yuklash
                </h4>
              </div>
              <button
                type="button"
                onClick={handleCloseQrModal}
                className="w-9 h-9 rounded-lg flex items-center justify-center text-slate-500 hover:bg-slate-100"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 text-center space-y-4">
              {qrModalState.received ? (
                <div className="py-6 space-y-3">
                  <CheckCircle2 className="w-12 h-12 text-emerald-600 mx-auto" />
                  <p className="font-display font-bold text-slate-900">
                    Rasm muvaffaqiyatli qabul qilindi!
                  </p>
                </div>
              ) : (
                <>
                  <div className="inline-block p-3 rounded-2xl border border-slate-200 bg-white shadow-xs">
                    <img
                      src={qrModalState.qrDataUrl}
                      alt="QR kod"
                      className="w-56 h-56 mx-auto"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-sm font-semibold text-slate-900 flex items-center justify-center gap-1.5">
                      <Smartphone className="w-4 h-4 text-blue-700" />
                      <span>Telefon kamerasi bilan skanerlang</span>
                    </p>
                    <p className="text-xs text-slate-500 leading-relaxed">
                      Telefoningizda ochilgan sahifada kitob muqovasini rasmga oling — rasm avtomatik ravishda ushbu formaga tushadi.
                    </p>
                  </div>
                </>
              )}

              <button
                type="button"
                onClick={handleCloseQrModal}
                className="w-full min-h-[44px] px-4 py-2 text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors"
              >
                Yopish
              </button>
            </div>
          </div>
        </div>
      )}
    </form>
  );
}

import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, KeyRound, Lock, ShieldCheck, X } from 'lucide-react';
import {
  changeAdminPassword,
  verifyAdminPassword,
  warmAdminCredential,
} from '../lib/libraryService.ts';

interface AdminLoginModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAuthenticated: () => void;
}

export function AdminLoginModal({
  isOpen,
  onClose,
  onAuthenticated,
}: AdminLoginModalProps) {
  const [step, setStep] = useState<'login' | 'change-password'>('login');
  const [password, setPassword] = useState('');
  const [verifiedCurrentPassword, setVerifiedCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      warmAdminCredential();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const resetAndClose = () => {
    setStep('login');
    setPassword('');
    setVerifiedCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setErrorMsg(null);
    onClose();
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    if (!password.trim()) {
      setErrorMsg('Kirish parolini kiriting.');
      return;
    }

    setIsLoading(true);
    try {
      const res = await verifyAdminPassword(password);
      if (!res.valid) {
        setErrorMsg('Parol noto‘g‘ri. Qaytadan urinib ko‘ring.');
        return;
      }

      if (res.mustChangePassword) {
        setVerifiedCurrentPassword(password);
        setStep('change-password');
      } else {
        setPassword('');
        onAuthenticated();
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Kirishda xatolik yuz berdi.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleChangeFirstPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    if (newPassword.trim().length < 5) {
      setErrorMsg('Yangi parol kamida 5 ta belgidan iborat bo‘lishi kerak.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setErrorMsg('Yangi parollar bir-biriga mos kelmadi.');
      return;
    }

    setIsLoading(true);
    try {
      await changeAdminPassword(verifiedCurrentPassword, newPassword);
      setStep('login');
      setPassword('');
      setVerifiedCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      onAuthenticated();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Parolni almashtirishda xatolik.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/65 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl bg-white border border-slate-200 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-slate-50/70">
          <div className="flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-lg bg-[#0F2942] text-white flex items-center justify-center">
              <ShieldCheck className="w-4 h-4" />
            </span>
            <h2 className="font-display font-bold text-slate-900">
              {step === 'login' ? 'Admin panelga kirish' : 'Birinchi kirish: parolni yangilang'}
            </h2>
          </div>
          <button
            type="button"
            onClick={resetAndClose}
            className="w-9 h-9 rounded-lg flex items-center justify-center text-slate-500 hover:bg-slate-200/70 hover:text-slate-900 transition-colors"
            aria-label="Yopish"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {step === 'login' ? (
          <form onSubmit={handleLogin} className="p-6 space-y-5">
            <p className="text-sm text-slate-600 leading-relaxed">
              Kutubxonani boshqarish, kitob qo‘shish va o‘quvchilar tarixini ko‘rish uchun
              umumiy administrator kirish kodini (parolini) kiriting.
            </p>

            {errorMsg && (
              <div className="rounded-xl border border-red-200 bg-red-50 p-3.5 flex items-start gap-2.5 text-xs text-red-800">
                <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                <span>{errorMsg}</span>
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Umumiy kirish kodi (parol)
              </label>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="password"
                  autoFocus
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Kirish kodini kiriting"
                  className="w-full min-h-[46px] pl-10 pr-4 py-2.5 text-sm rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
              <p className="text-[11px] text-slate-400 mt-1.5">
                Faqat mas’ul xodimlar uchun yagona kirish kodi amal qiladi.
              </p>
            </div>

            <div className="flex items-center justify-end gap-3 pt-1">
              <button
                type="button"
                onClick={resetAndClose}
                className="min-h-[44px] px-4 py-2 text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors"
              >
                Bekor qilish
              </button>
              <button
                type="submit"
                disabled={isLoading}
                className="min-h-[44px] px-5 py-2 text-sm font-semibold text-white bg-[#0F2942] hover:bg-slate-800 rounded-xl transition-colors disabled:opacity-60"
              >
                {isLoading ? 'Tekshirilmoqda...' : 'Kirish'}
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={handleChangeFirstPassword} className="p-6 space-y-4">
            <div className="rounded-xl border border-blue-200 bg-blue-50 p-3.5 flex items-start gap-2.5 text-xs text-blue-900">
              <KeyRound className="w-4 h-4 text-blue-700 shrink-0 mt-0.5" />
              <span>
                Xavfsizlik uchun birinchi kirishda boshlang‘ich parolni yangi shaxsiy parolga
                almashtiring. Parol bazada xavfsiz PBKDF2 xesh shaklida saqlanadi.
              </span>
            </div>

            {errorMsg && (
              <div className="rounded-xl border border-red-200 bg-red-50 p-3.5 flex items-start gap-2.5 text-xs text-red-800">
                <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                <span>{errorMsg}</span>
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Yangi parol (kamida 5 ta belgi)
              </label>
              <input
                type="password"
                required
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Yangi parolni kiriting"
                className="w-full min-h-[44px] px-3.5 py-2 text-sm rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Yangi parolni tasdiqlang
              </label>
              <input
                type="password"
                required
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Parolni qayta kiriting"
                className="w-full min-h-[44px] px-3.5 py-2 text-sm rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
              <button
                type="button"
                onClick={() => {
                  setStep('login');
                  setPassword('');
                  onAuthenticated();
                }}
                className="text-xs font-medium text-slate-500 hover:text-slate-800 underline"
              >
                Keyinroq almashtirish
              </button>
              <button
                type="submit"
                disabled={isLoading}
                className="inline-flex items-center gap-2 min-h-[44px] px-5 py-2 text-sm font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-xl transition-colors disabled:opacity-60"
              >
                <CheckCircle2 className="w-4 h-4" />
                <span>{isLoading ? 'Saqlanmoqda...' : 'Saqlash va kirish'}</span>
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

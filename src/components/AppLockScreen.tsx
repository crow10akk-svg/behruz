import { useEffect, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  ShieldCheck,
} from 'lucide-react';
import {
  changeAppGatePassword,
  verifyAppGatePassword,
  warmAppGateCredential,
} from '../lib/libraryService.ts';

interface AppLockScreenProps {
  institutionName: string;
  libraryName: string;
  onUnlocked: () => void;
}

export function AppLockScreen({
  institutionName,
  libraryName,
  onUnlocked,
}: AppLockScreenProps) {
  const [mode, setMode] = useState<'login' | 'change'>('login');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showOldPwd, setShowOldPwd] = useState(false);
  const [showNewPwd, setShowNewPwd] = useState(false);

  const [isChecking, setIsChecking] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  useEffect(() => {
    warmAppGateCredential();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);
    if (!password.trim()) {
      setErrorMsg('Ilovaga kirish parolini kiriting.');
      return;
    }

    setIsChecking(true);
    try {
      const valid = await verifyAppGatePassword(password);
      if (!valid) {
        setErrorMsg('Kirish paroli noto‘g‘ri. Qaytadan urinib ko‘ring.');
        return;
      }
      setPassword('');
      onUnlocked();
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Parolni tekshirishda xatolik yuz berdi.'
      );
    } finally {
      setIsChecking(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);

    if (!oldPassword.trim()) {
      setErrorMsg('Eski parolni kiriting.');
      return;
    }
    if (newPassword.trim().length < 4) {
      setErrorMsg('Yangi parol kamida 4 ta belgidan iborat bo‘lishi kerak.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setErrorMsg('Yangi parollar bir-biriga mos kelmadi.');
      return;
    }

    setIsChecking(true);
    try {
      await changeAppGatePassword(oldPassword, newPassword);
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPassword('');
      setMode('login');
      setSuccessMsg(
        'Parol muvaffaqiyatli almashtirildi! Eski parol o‘chirildi — endi yangi parol bilan kiring.'
      );
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Parolni almashtirishda xatolik yuz berdi.'
      );
    } finally {
      setIsChecking(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl bg-white border border-slate-200 shadow-xl overflow-hidden">
        <div className="bg-[#0F2942] px-6 py-7 text-white text-center space-y-2.5">
          <div className="w-14 h-14 mx-auto rounded-2xl bg-white/10 border border-white/20 flex items-center justify-center">
            {mode === 'change' ? (
              <KeyRound className="w-7 h-7 text-white" />
            ) : (
              <ShieldCheck className="w-7 h-7 text-white" />
            )}
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-blue-200">
              {institutionName}
            </p>
            <h1 className="font-display text-2xl font-bold tracking-tight mt-0.5">
              {libraryName}
            </h1>
          </div>
        </div>

        {mode === 'login' ? (
          <form onSubmit={handleSubmit} className="p-6 sm:p-7 space-y-5">
            <div className="text-center space-y-1">
              <h2 className="font-display font-bold text-lg text-slate-900">
                Ilovaga kirish himoyalangan
              </h2>
              <p className="text-xs text-slate-500">
                Kutubxona tizimidan foydalanish uchun kirish parolini kiriting
              </p>
            </div>

            {successMsg && (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3.5 flex items-start gap-2.5 text-xs text-emerald-900">
                <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" />
                <span>{successMsg}</span>
              </div>
            )}

            {errorMsg && (
              <div className="rounded-xl border border-red-200 bg-red-50 p-3.5 flex items-start gap-2.5 text-xs text-red-800">
                <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                <span>{errorMsg}</span>
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Ilovaga kirish paroli
              </label>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  autoFocus
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Kirish parolini kiriting"
                  className="w-full min-h-[48px] pl-10 pr-11 py-2.5 text-sm rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
                  aria-label={showPassword ? 'Parolni yashirish' : 'Parolni ko‘rsatish'}
                >
                  {showPassword ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={isChecking}
              className="w-full min-h-[48px] px-5 py-3 text-sm font-semibold text-white bg-[#0F2942] hover:bg-slate-800 rounded-xl transition-colors disabled:opacity-60"
            >
              {isChecking ? 'Tekshirilmoqda...' : 'Ilovaga kirish'}
            </button>

            <div className="pt-1 border-t border-slate-100 text-center">
              <button
                type="button"
                onClick={() => {
                  setMode('change');
                  setErrorMsg(null);
                  setSuccessMsg(null);
                  setOldPassword('');
                  setNewPassword('');
                  setConfirmPassword('');
                }}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-700 hover:text-blue-800 hover:underline py-1"
              >
                <KeyRound className="w-3.5 h-3.5" />
                <span>Parolni almashtirish</span>
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={handleChangePassword} className="p-6 sm:p-7 space-y-4">
            <div className="text-center space-y-1">
              <h2 className="font-display font-bold text-lg text-slate-900">
                Saytga kirish parolini almashtirish
              </h2>
              <p className="text-xs text-slate-500">
                Eski parolni va yangi parolni kiriting — yangi parol o‘rnatilgach eskisi o‘chib ketadi
              </p>
            </div>

            {errorMsg && (
              <div className="rounded-xl border border-red-200 bg-red-50 p-3.5 flex items-start gap-2.5 text-xs text-red-800">
                <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                <span>{errorMsg}</span>
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Eski parol *
              </label>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type={showOldPwd ? 'text' : 'password'}
                  autoFocus
                  required
                  value={oldPassword}
                  onChange={(e) => setOldPassword(e.target.value)}
                  placeholder="Amaldagi eski parolni kiriting"
                  className="w-full min-h-[46px] pl-10 pr-11 py-2 text-sm rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
                <button
                  type="button"
                  onClick={() => setShowOldPwd((prev) => !prev)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-slate-100"
                  aria-label="Parolni ko‘rsatish"
                >
                  {showOldPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Yangi parol * (kamida 4 ta belgi)
              </label>
              <div className="relative">
                <KeyRound className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type={showNewPwd ? 'text' : 'password'}
                  required
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Yangi parolni kiriting"
                  className="w-full min-h-[46px] pl-10 pr-11 py-2 text-sm rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
                <button
                  type="button"
                  onClick={() => setShowNewPwd((prev) => !prev)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-slate-100"
                  aria-label="Yangi parolni ko‘rsatish"
                >
                  {showNewPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Yangi parolni tasdiqlang *
              </label>
              <input
                type={showNewPwd ? 'text' : 'password'}
                required
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Yangi parolni qayta kiriting"
                className="w-full min-h-[46px] px-3.5 py-2 text-sm rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </div>

            <div className="grid grid-cols-[auto_1fr] gap-2.5 pt-1">
              <button
                type="button"
                onClick={() => {
                  setMode('login');
                  setErrorMsg(null);
                  setOldPassword('');
                  setNewPassword('');
                  setConfirmPassword('');
                }}
                className="inline-flex items-center justify-center gap-1.5 min-h-[46px] px-4 py-2.5 text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors"
              >
                <ArrowLeft className="w-4 h-4" />
                <span>Orqaga</span>
              </button>
              <button
                type="submit"
                disabled={isChecking}
                className="inline-flex items-center justify-center gap-2 min-h-[46px] px-5 py-2.5 text-sm font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-xl transition-colors disabled:opacity-60"
              >
                <CheckCircle2 className="w-4 h-4" />
                <span>{isChecking ? 'Saqlanmoqda...' : 'Parolni almashtirish'}</span>
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

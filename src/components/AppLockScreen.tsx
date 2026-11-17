import { useEffect, useState } from 'react';
import { AlertCircle, Eye, EyeOff, Lock, ShieldCheck } from 'lucide-react';
import {
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
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    warmAppGateCredential();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
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

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl bg-white border border-slate-200 shadow-xl overflow-hidden">
        <div className="bg-[#0F2942] px-6 py-7 text-white text-center space-y-2.5">
          <div className="w-14 h-14 mx-auto rounded-2xl bg-white/10 border border-white/20 flex items-center justify-center">
            <ShieldCheck className="w-7 h-7 text-white" />
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

        <form onSubmit={handleSubmit} className="p-6 sm:p-7 space-y-5">
          <div className="text-center space-y-1">
            <h2 className="font-display font-bold text-lg text-slate-900">
              Ilovaga kirish himoyalangan
            </h2>
            <p className="text-xs text-slate-500">
              Kutubxona tizimidan foydalanish uchun kirish parolini kiriting
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
        </form>
      </div>
    </div>
  );
}

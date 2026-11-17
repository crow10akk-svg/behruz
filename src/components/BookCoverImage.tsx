import { useState } from 'react';
import { BookOpen } from 'lucide-react';

interface BookCoverImageProps {
  coverUrl?: string;
  title: string;
  bookNumber: string;
  className?: string;
}

export function BookCoverImage({
  coverUrl,
  title,
  bookNumber,
  className = '',
}: BookCoverImageProps) {
  const [hasError, setHasError] = useState(false);

  if (!coverUrl || hasError) {
    return (
      <div
        className={`relative flex flex-col items-center justify-between bg-gradient-to-br from-slate-800 via-slate-900 to-blue-950 p-4 text-white select-none ${className}`}
      >
        <div className="w-full flex items-center justify-between text-xs font-mono text-slate-300">
          <span>№ {bookNumber}</span>
          <span>SMART KUTUBXONA</span>
        </div>
        <div className="my-auto flex flex-col items-center text-center gap-2 px-2">
          <div className="w-11 h-11 rounded-xl bg-white/10 border border-white/15 flex items-center justify-center">
            <BookOpen className="w-5 h-5 text-blue-200" />
          </div>
          <p className="font-display font-semibold text-sm leading-snug line-clamp-3 text-white">
            {title}
          </p>
        </div>
        <div className="w-full border-t border-white/15 pt-2 text-[11px] text-slate-300 text-center truncate">
          IIV Andijon akademik litseyi
        </div>
      </div>
    );
  }

  return (
    <img
      src={coverUrl}
      alt={`${title} (${bookNumber}) kitob muqovasi`}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setHasError(true)}
      className={`object-cover bg-slate-100 ${className}`}
    />
  );
}

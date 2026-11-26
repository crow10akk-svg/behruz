import { useState } from 'react';
import { BookOpen } from 'lucide-react';
import { DEFAULT_BOOK_COVER_URL } from '../lib/imageUtils.ts';

interface BookCoverImageProps {
  coverUrl?: string;
  title: string;
  bookNumber: string;
  className?: string;
  compact?: boolean;
}

export function BookCoverImage({
  title,
  bookNumber,
  className = '',
  compact = false,
}: BookCoverImageProps) {
  const [hasError, setHasError] = useState(false);

  return (
    <div
      className={`relative overflow-hidden bg-[#0A1F3C] select-none ${className}`}
      aria-label={`${title} (${bookNumber}) kitob muqovasi`}
    >
      {!hasError ? (
        <img
          src={DEFAULT_BOOK_COVER_URL}
          alt={`${title} (${bookNumber}) kitob muqovasi`}
          loading="lazy"
          decoding="async"
          onError={() => setHasError(true)}
          className="w-full h-full object-cover"
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-[#0A1F3C] via-[#0F2942] to-slate-900">
          <BookOpen className="w-8 h-8 text-amber-300/60" />
        </div>
      )}

      {!compact && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-between p-2 sm:p-2.5">
          {/* Top Institution Banner */}
          <div className="w-full rounded-md bg-[#07162B]/90 backdrop-blur-[1px] border border-amber-300/50 px-2 py-1 text-center shadow-xs">
            <p className="font-display text-[9px] sm:text-[10px] font-bold tracking-wider uppercase text-amber-200 leading-tight truncate">
              IIV Andijon Akademik litseyi
            </p>
          </div>

          {/* Center Book Title */}
          <div className="my-auto w-full rounded-lg bg-[#07162B]/88 backdrop-blur-[2px] border border-amber-300/45 px-2.5 py-2 text-center shadow-md">
            <p className="font-display font-bold text-[11px] sm:text-xs text-white leading-snug line-clamp-3 break-words drop-shadow-xs">
              {title || 'Nomsiz kitob'}
            </p>
          </div>

          <div className="h-1" aria-hidden="true" />
        </div>
      )}
    </div>
  );
}

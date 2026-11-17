export const UZ_MONTHS = [
  { value: 1, label: 'Yanvar' },
  { value: 2, label: 'Fevral' },
  { value: 3, label: 'Mart' },
  { value: 4, label: 'Aprel' },
  { value: 5, label: 'May' },
  { value: 6, label: 'Iyun' },
  { value: 7, label: 'Iyul' },
  { value: 8, label: 'Avgust' },
  { value: 9, label: 'Sentabr' },
  { value: 10, label: 'Oktabr' },
  { value: 11, label: 'Noyabr' },
  { value: 12, label: 'Dekabr' },
];

export function getTodayDateStr(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

export function buildDateWithCurrentTime(dateStr: string): Date {
  const now = new Date();
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(
    y || now.getFullYear(),
    (m || now.getMonth() + 1) - 1,
    d || now.getDate(),
    now.getHours(),
    now.getMinutes(),
    now.getSeconds()
  );
}

export function buildBorrowAndDueIso(
  borrowDateStr: string,
  defaultLoanDays: number
): {
  borrowedAtIso: string;
  dueDateIso: string;
} {
  const borrowDate = buildDateWithCurrentTime(borrowDateStr);
  const dueDate = new Date(borrowDate.getTime() + defaultLoanDays * 86400000);
  dueDate.setHours(23, 59, 59, 999);
  return {
    borrowedAtIso: borrowDate.toISOString(),
    dueDateIso: dueDate.toISOString(),
  };
}

export function buildReturnIso(returnDateStr: string): string {
  return buildDateWithCurrentTime(returnDateStr).toISOString();
}

export function UzDateSelects({
  value,
  onChange,
  labelPrefix,
}: {
  value: string;
  onChange: (nextDateStr: string) => void;
  labelPrefix: string;
}) {
  const nowYear = new Date().getFullYear();
  const [rawY, rawM, rawD] = value.split('-').map(Number);
  const year = rawY || nowYear;
  const month = rawM || new Date().getMonth() + 1;
  const maxDay = getDaysInMonth(year, month);
  const day = Math.min(rawD || new Date().getDate(), maxDay);

  const yearOptions: number[] = [];
  for (let y = nowYear - 2; y <= nowYear + 3; y++) {
    yearOptions.push(y);
  }
  const dayOptions = Array.from({ length: maxDay }, (_, idx) => idx + 1);

  const emitChange = (nextY: number, nextM: number, nextD: number) => {
    const clampedD = Math.min(nextD, getDaysInMonth(nextY, nextM));
    onChange(
      `${nextY}-${String(nextM).padStart(2, '0')}-${String(clampedD).padStart(2, '0')}`
    );
  };

  return (
    <div className="grid grid-cols-3 gap-2.5 max-w-md">
      <div>
        <label className="block text-[11px] font-medium text-slate-500 mb-1">
          Kun
        </label>
        <select
          aria-label={`${labelPrefix} kuni`}
          value={day}
          onChange={(e) => emitChange(year, month, Number(e.target.value))}
          className="w-full min-h-[44px] px-3 py-2 text-sm font-mono font-semibold rounded-xl border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
        >
          {dayOptions.map((d) => (
            <option key={d} value={d}>
              {String(d).padStart(2, '0')}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-[11px] font-medium text-slate-500 mb-1">
          Oy
        </label>
        <select
          aria-label={`${labelPrefix} oyi`}
          value={month}
          onChange={(e) => emitChange(year, Number(e.target.value), day)}
          className="w-full min-h-[44px] px-3 py-2 text-sm font-medium rounded-xl border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
        >
          {UZ_MONTHS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label} ({String(m.value).padStart(2, '0')})
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-[11px] font-medium text-slate-500 mb-1">
          Yil
        </label>
        <select
          aria-label={`${labelPrefix} yili`}
          value={year}
          onChange={(e) => emitChange(Number(e.target.value), month, day)}
          className="w-full min-h-[44px] px-3 py-2 text-sm font-mono font-semibold rounded-xl border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
        >
          {yearOptions.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

import { useMemo, useRef, useState } from 'react';
import type * as XLSX from 'xlsx';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Upload,
} from 'lucide-react';
import {
  downloadBooksExcelTemplate,
  extractSheetRows,
  readExcelWorkbookFile,
  type ParsedExcelWorkbook,
} from '../lib/excelImport.ts';
import { DEFAULT_BOOK_COVER_URL } from '../lib/imageUtils.ts';
import { importBooksBatchAdmin } from '../lib/libraryService.ts';
import type { Book } from '../types.ts';

interface AdminExcelImportProps {
  existingBooks: Book[];
  onImported: (summaryText: string) => void;
  onOpenCatalog?: () => void;
}

export function AdminExcelImport({
  existingBooks,
  onImported,
  onOpenCatalog,
}: AdminExcelImportProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const workbookRef = useRef<XLSX.WorkBook | null>(null);

  const [parsed, setParsed] = useState<ParsedExcelWorkbook | null>(null);
  const [duplicateStrategy, setDuplicateStrategy] = useState<'auto-number' | 'skip'>('auto-number');
  const [isDragging, setIsDragging] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [resultSummary, setResultSummary] = useState<{
    importedCount: number;
    skippedCount: number;
    totalCopies: number;
  } | null>(null);

  const existingNumberSet = useMemo(() => {
    const set = new Set<string>();
    existingBooks.forEach((b) => {
      if (!b.isDeleted && b.bookNumber) {
        set.add(b.bookNumber.trim().toLowerCase());
      }
    });
    return set;
  }, [existingBooks]);

  const previewStats = useMemo(() => {
    if (!parsed) return null;
    const seenInFile = new Set<string>();
    let duplicateNumbers = 0;
    let totalCopies = 0;

    parsed.rows.forEach((row) => {
      totalCopies += Math.max(1, row.quantity || 1);
      const key = row.bookNumber.trim().toLowerCase();
      if (key) {
        if (existingNumberSet.has(key) || seenInFile.has(key)) {
          duplicateNumbers += 1;
        }
        seenInFile.add(key);
      }
    });

    const toImportCount =
      duplicateStrategy === 'skip'
        ? Math.max(0, parsed.rows.length - duplicateNumbers)
        : parsed.rows.length;

    return {
      totalRows: parsed.rows.length,
      duplicateNumbers,
      toImportCount,
      totalCopies,
    };
  }, [parsed, existingNumberSet, duplicateStrategy]);

  const processFile = async (file: File) => {
    setErrorMsg(null);
    setResultSummary(null);
    setIsParsing(true);
    try {
      const wb = await readExcelWorkbookFile(file);
      if (!wb.SheetNames || wb.SheetNames.length === 0) {
        throw new Error('Excel faylida birorta ham varaq (sheet) topilmadi.');
      }
      workbookRef.current = wb;
      const firstSheet = wb.SheetNames[0];
      const extracted = extractSheetRows(wb, firstSheet, file.name);
      if (extracted.rows.length === 0) {
        throw new Error(
          'Fayldan birorta ham kitob qatori o‘qilmadi. Ustunlarda «Kitob nomi» mavjudligini tekshiring.'
        );
      }
      setParsed(extracted);
    } catch (err) {
      setParsed(null);
      setErrorMsg(
        err instanceof Error ? err.message : 'Excel faylini o‘qishda xatolik yuz berdi.'
      );
    } finally {
      setIsParsing(false);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    await processFile(file);
  };

  const handleSheetChange = (sheetName: string) => {
    if (!workbookRef.current || !parsed) return;
    setErrorMsg(null);
    setResultSummary(null);
    const extracted = extractSheetRows(workbookRef.current, sheetName, parsed.fileName);
    setParsed(extracted);
  };

  const handleRunImport = async () => {
    if (!parsed || parsed.rows.length === 0) return;
    setErrorMsg(null);
    setResultSummary(null);
    setIsImporting(true);
    setProgress({ done: 0, total: parsed.rows.length });

    try {
      const res = await importBooksBatchAdmin({
        rows: parsed.rows,
        existingBooks,
        duplicateStrategy,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      setResultSummary(res);
      onImported(
        `Excel import yakunlandi: ${res.importedCount} ta kitob (${res.totalCopies} ta nusxa) katalogga qo‘shildi.`
      );
      setParsed(null);
      workbookRef.current = null;
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Excel import vaqtida bazaga saqlashda xatolik yuz berdi.'
      );
    } finally {
      setIsImporting(false);
      setProgress(null);
    }
  };

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 pb-4">
        <div className="flex items-start gap-3">
          <div className="w-11 h-11 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 flex items-center justify-center shrink-0">
            <FileSpreadsheet className="w-5 h-5" />
          </div>
          <div>
            <h3 className="font-display text-xl font-bold text-slate-900">
              Excel fayldan kitoblarni ommaviy import qilish
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              .xlsx, .xls yoki .csv faylini yuklang — barcha kitoblar rasmiy litsey muqova rasmi bilan katalogga qo‘shiladi
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={downloadBooksExcelTemplate}
          className="inline-flex items-center gap-2 min-h-[40px] px-4 py-2 text-xs font-semibold text-blue-800 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-xl transition-colors whitespace-nowrap"
        >
          <Download className="w-4 h-4" />
          <span>Namuna shablon (.xlsx)</span>
        </button>
      </div>

      {/* Default Cover Preview Banner */}
      <div className="rounded-xl border border-slate-200 bg-slate-50/75 p-4 flex flex-col sm:flex-row items-start sm:items-center gap-4">
        <div className="w-16 h-22 rounded-lg overflow-hidden border border-slate-300 shadow-xs shrink-0 bg-slate-900">
          <img
            src={DEFAULT_BOOK_COVER_URL}
            alt="Standart kitob muqovasi"
            className="w-full h-full object-cover"
          />
        </div>
        <div className="space-y-1 text-xs">
          <p className="font-semibold text-slate-900">
            Barcha Excel kitoblari va rasmi yo‘q kitoblar uchun yagona muqova
          </p>
          <p className="text-slate-600 leading-relaxed">
            Excel orqali qo‘shiladigan barcha kitoblarga hamda katalogdagi alohida rasmi yo‘q kitoblarga siz yuklagan{' '}
            <span className="font-semibold text-slate-800">IIV Andijon akademik litseyi</span> rasmiy muqovasi avtomatik qo‘yiladi.
          </p>
          <p className="text-[11px] text-slate-500">
            Qo‘llab-quvvatlanadigan ustunlar: <span className="font-mono text-slate-700">Kitob raqami, Kitob nomi, Muallif, Fan / Kategoriya, Soni, Tavsif</span>
          </p>
        </div>
      </div>

      {errorMsg && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 flex items-start gap-2.5 text-sm text-red-800">
          <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
          <span>{errorMsg}</span>
        </div>
      )}

      {resultSummary && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 flex flex-wrap items-center justify-between gap-3 text-sm text-emerald-900">
          <div className="flex items-start gap-2.5">
            <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">
                {resultSummary.importedCount} ta kitob (jami {resultSummary.totalCopies} dona nusxa) katalogga saqlandi!
              </p>
              {resultSummary.skippedCount > 0 && (
                <p className="text-xs text-emerald-800 mt-0.5">
                  Takrorlangan yoki bo‘sh {resultSummary.skippedCount} ta qator o‘tkazib yuborildi.
                </p>
              )}
            </div>
          </div>
          {onOpenCatalog && (
            <button
              type="button"
              onClick={onOpenCatalog}
              className="px-4 py-2 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-xl transition-colors"
            >
              Katalogni ko‘rish
            </button>
          )}
        </div>
      )}

      {/* Dropzone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={async (e) => {
          e.preventDefault();
          setIsDragging(false);
          const file = e.dataTransfer.files?.[0];
          if (file) await processFile(file);
        }}
        className={`rounded-2xl border-2 border-dashed p-8 text-center transition-colors ${
          isDragging
            ? 'border-blue-600 bg-blue-50/70'
            : 'border-slate-300 bg-slate-50/50 hover:border-blue-400'
        }`}
      >
        <Upload className="w-9 h-9 text-slate-400 mx-auto mb-3" />
        <p className="font-display font-semibold text-base text-slate-900">
          {isParsing
            ? 'Excel fayl o‘qilmoqda...'
            : 'Excel faylni shu yerga tashlang yoki kompyuterdan tanlang'}
        </p>
        <p className="text-xs text-slate-500 mt-1 mb-4">
          Formatlar: .xlsx, .xls, .csv (minglab kitoblarni bir zumda yuklaydi)
        </p>
        <button
          type="button"
          disabled={isParsing || isImporting}
          onClick={() => fileInputRef.current?.click()}
          className="inline-flex items-center gap-2 min-h-[44px] px-5 py-2.5 text-sm font-semibold text-white bg-[#0F2942] hover:bg-slate-800 rounded-xl transition-colors disabled:opacity-60"
        >
          <FileSpreadsheet className="w-4 h-4" />
          <span>Excel fayl tanlash</span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv"
          onChange={handleFileChange}
          className="hidden"
        />
      </div>

      {/* Parsed Preview & Controls */}
      {parsed && previewStats && (
        <div className="space-y-4 pt-2 border-t border-slate-200">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h4 className="font-display font-bold text-base text-slate-900">
                Fayl tekshiruvi: {parsed.fileName}
              </h4>
              <p className="text-xs text-slate-500 tabular-nums">
                Topildi: {previewStats.totalRows} ta kitob · Jami nusxa: {previewStats.totalCopies} dona
                {previewStats.duplicateNumbers > 0 &&
                  ` · ${previewStats.duplicateNumbers} ta raqam katalogda/faylda takrorlangan`}
              </p>
            </div>

            {parsed.sheetNames.length > 1 && (
              <div className="flex items-center gap-2">
                <label className="text-xs font-medium text-slate-600">Varaq (Sheet):</label>
                <select
                  value={parsed.activeSheet}
                  onChange={(e) => handleSheetChange(e.target.value)}
                  className="min-h-[38px] px-3 py-1.5 text-xs font-semibold rounded-xl border border-slate-300 bg-white"
                >
                  {parsed.sheetNames.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 flex flex-wrap items-center justify-between gap-3 text-xs">
            <span className="font-semibold text-slate-700">
              Kitob raqami band yoki bo‘sh bo‘lsa:
            </span>
            <div className="flex flex-wrap items-center gap-4">
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="dupStrategy"
                  checked={duplicateStrategy === 'auto-number'}
                  onChange={() => setDuplicateStrategy('auto-number')}
                  className="text-blue-700 focus:ring-blue-600"
                />
                <span>Avtomatik keyingi bo‘sh raqam berish ({parsed.rows.length} ta qo‘shiladi)</span>
              </label>
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="dupStrategy"
                  checked={duplicateStrategy === 'skip'}
                  onChange={() => setDuplicateStrategy('skip')}
                  className="text-blue-700 focus:ring-blue-600"
                />
                <span>Takrorlanganlarini o‘tkazib yuborish ({previewStats.toImportCount} ta qo‘shiladi)</span>
              </label>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 overflow-hidden">
            <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-700 flex items-center justify-between">
              <span>
                Oldindan ko‘rish (dastlabki {Math.min(50, parsed.rows.length)} ta qator)
              </span>
              <span className="font-mono tabular-nums text-slate-500">
                Jami: {parsed.rows.length} ta
              </span>
            </div>
            <div className="overflow-x-auto max-h-72 overflow-y-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 sticky top-0">
                  <tr>
                    <th className="py-2.5 px-3 font-semibold">Muqova</th>
                    <th className="py-2.5 px-3 font-semibold">Raqam</th>
                    <th className="py-2.5 px-3 font-semibold">Kitob nomi</th>
                    <th className="py-2.5 px-3 font-semibold">Muallif</th>
                    <th className="py-2.5 px-3 font-semibold">Fan / Kategoriya</th>
                    <th className="py-2.5 px-3 font-semibold">Soni</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {parsed.rows.slice(0, 50).map((row) => (
                    <tr key={`${row.rowIndex}-${row.title}`} className="hover:bg-slate-50/70">
                      <td className="py-2 px-3">
                        <img
                          src={DEFAULT_BOOK_COVER_URL}
                          alt="Muqova"
                          className="w-7 h-10 object-cover rounded border border-slate-200"
                        />
                      </td>
                      <td className="py-2 px-3 font-mono text-slate-700">
                        {row.bookNumber || <span className="text-blue-700">Avto</span>}
                      </td>
                      <td className="py-2 px-3 font-semibold text-slate-900 max-w-[260px] truncate">
                        {row.title}
                      </td>
                      <td className="py-2 px-3 text-slate-600 max-w-[160px] truncate">
                        {row.author || '—'}
                      </td>
                      <td className="py-2 px-3 text-slate-600">{row.category}</td>
                      <td className="py-2 px-3 font-mono tabular-nums font-semibold">
                        {row.quantity}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {isImporting && progress && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs font-semibold text-blue-800 tabular-nums">
                <span>Katalogga yozilmoqda...</span>
                <span>
                  {progress.done} / {progress.total}
                </span>
              </div>
              <div className="w-full h-2.5 rounded-full bg-slate-200 overflow-hidden">
                <div
                  className="h-full bg-blue-700 transition-all duration-200"
                  style={{
                    width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%`,
                  }}
                />
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-end gap-3">
            <button
              type="button"
              disabled={isImporting}
              onClick={() => {
                setParsed(null);
                workbookRef.current = null;
              }}
              className="min-h-[44px] px-4 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors"
            >
              Bekor qilish
            </button>
            <button
              type="button"
              disabled={isImporting || previewStats.toImportCount === 0}
              onClick={handleRunImport}
              className="inline-flex items-center gap-2 min-h-[44px] px-6 py-2.5 text-sm font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-xl transition-colors disabled:opacity-60"
            >
              <Upload className="w-4 h-4" />
              <span>
                {isImporting
                  ? 'Import qilinmoqda...'
                  : `${previewStats.toImportCount} ta kitobni katalogga qo‘shish`}
              </span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

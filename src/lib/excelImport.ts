import * as XLSX from 'xlsx';

export interface ParsedExcelBookRow {
  rowIndex: number;
  bookNumber: string;
  title: string;
  author: string;
  category: string;
  quantity: number;
  description: string;
}

export interface ParsedExcelWorkbook {
  fileName: string;
  sheetNames: string[];
  activeSheet: string;
  rows: ParsedExcelBookRow[];
  skippedEmptyRows: number;
}

type CanonicalField =
  | 'bookNumber'
  | 'title'
  | 'author'
  | 'category'
  | 'quantity'
  | 'description';

function normalizeHeaderKey(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\u2018\u2019\u02BB\u02BC\u02B9\u2032ʼ′`']/g, '')
    .replace(/[^a-z0-9\u0400-\u04ff]+/g, ' ')
    .trim();
}

const HEADER_ALIASES: Record<CanonicalField, string[]> = {
  bookNumber: [
    'kitob raqami',
    'raqami',
    'raqam',
    'inventar',
    'inventar raqami',
    'inv',
    'inv no',
    'kod',
    'code',
    'book number',
    'booknumber',
    'number',
    'no',
    'id',
    'номер',
    'инвентарный номер',
    'инв номер',
    'код',
  ],
  title: [
    'kitob nomi',
    'nomi',
    'nom',
    'sarlavha',
    'kitob',
    'title',
    'book title',
    'name',
    'book',
    'наименование',
    'название',
    'название книги',
    'книга',
  ],
  author: [
    'muallif',
    'muallifi',
    'avtor',
    'author',
    'authors',
    'автор',
    'авторы',
  ],
  category: [
    'kategoriya',
    'fan',
    'fan kategoriya',
    'bolim',
    'turi',
    'janr',
    'category',
    'subject',
    'genre',
    'категория',
    'предмет',
    'раздел',
  ],
  quantity: [
    'soni',
    'kitob soni',
    'miqdori',
    'miqdor',
    'nusxa',
    'nusxalar',
    'nusxalar soni',
    'dona',
    'quantity',
    'qty',
    'count',
    'copies',
    'количество',
    'кол во',
    'экземпляры',
  ],
  description: [
    'tavsif',
    'qisqacha tavsif',
    'izoh',
    'malumot',
    'description',
    'notes',
    'note',
    'описание',
    'примечание',
  ],
};

function detectField(headerCell: unknown): CanonicalField | null {
  const norm = normalizeHeaderKey(headerCell);
  if (!norm) return null;

  for (const field of Object.keys(HEADER_ALIASES) as CanonicalField[]) {
    if (HEADER_ALIASES[field].includes(norm)) return field;
  }

  for (const field of Object.keys(HEADER_ALIASES) as CanonicalField[]) {
    for (const alias of HEADER_ALIASES[field]) {
      if (alias.length >= 4 && norm.includes(alias)) return field;
    }
  }
  return null;
}

export function sanitizeBookNumber(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[\s./\\]+/g, '-')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return cleaned;
}

function parseQuantity(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.max(1, Math.min(1000, Math.round(raw)));
  }
  const str = String(raw ?? '').replace(/[^\d]/g, '');
  if (!str) return 1;
  const parsed = parseInt(str, 10);
  if (Number.isNaN(parsed) || parsed < 1) return 1;
  return Math.min(1000, parsed);
}

export function extractSheetRows(
  workbook: XLSX.WorkBook,
  sheetName: string,
  fileName: string
): ParsedExcelWorkbook {
  const ws = workbook.Sheets[sheetName];
  if (!ws) {
    return {
      fileName,
      sheetNames: workbook.SheetNames,
      activeSheet: sheetName,
      rows: [],
      skippedEmptyRows: 0,
    };
  }

  const matrix = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    defval: '',
    blankrows: false,
  });

  if (matrix.length === 0) {
    return {
      fileName,
      sheetNames: workbook.SheetNames,
      activeSheet: sheetName,
      rows: [],
      skippedEmptyRows: 0,
    };
  }

  // Locate header row within first 10 rows (supports title banner above headers)
  let headerRowIdx = 0;
  let bestColMap = new Map<number, CanonicalField>();

  for (let r = 0; r < Math.min(10, matrix.length); r++) {
    const row = matrix[r] || [];
    const map = new Map<number, CanonicalField>();
    row.forEach((cell, cIdx) => {
      const f = detectField(cell);
      if (f && !Array.from(map.values()).includes(f)) {
        map.set(cIdx, f);
      }
    });
    if (map.size > bestColMap.size) {
      bestColMap = map;
      headerRowIdx = r;
    }
  }

  // Fallback positional mapping if Excel has no recognized header names
  const hasExplicitHeaders = bestColMap.has(0) || bestColMap.size > 0;
  const colToField = new Map<number, CanonicalField>(bestColMap);
  let dataStartRow = headerRowIdx + 1;

  if (!hasExplicitHeaders) {
    // Assume positional: [0]=bookNumber or title; if col 0 looks numeric & col 1 has text -> [0]=num,[1]=title,[2]=author,[3]=category,[4]=qty
    const firstRow = matrix[0] || [];
    const col0 = String(firstRow[0] ?? '').trim();
    const col1 = String(firstRow[1] ?? '').trim();
    if (col0 && col1 && /^[a-zA-Z0-9_-]{1,12}$/.test(col0)) {
      colToField.set(0, 'bookNumber');
      colToField.set(1, 'title');
      colToField.set(2, 'author');
      colToField.set(3, 'category');
      colToField.set(4, 'quantity');
    } else {
      colToField.set(0, 'title');
      colToField.set(1, 'author');
      colToField.set(2, 'category');
      colToField.set(3, 'quantity');
    }
    dataStartRow = 0;
  }

  const parsedRows: ParsedExcelBookRow[] = [];
  let skippedEmptyRows = 0;

  for (let r = dataStartRow; r < matrix.length; r++) {
    const rawRow = matrix[r] || [];
    const record: Record<CanonicalField, unknown> = {
      bookNumber: '',
      title: '',
      author: '',
      category: '',
      quantity: 1,
      description: '',
    };

    colToField.forEach((field, cIdx) => {
      record[field] = rawRow[cIdx] ?? '';
    });

    // If title wasn't mapped explicitly, pick first non-empty long string cell
    let title = String(record.title ?? '').trim().slice(0, 200);
    if (!title && !colToField.size) {
      title = String(rawRow[0] ?? '').trim().slice(0, 200);
    }

    if (!title) {
      const hasAnyValue = rawRow.some((v) => String(v ?? '').trim() !== '');
      if (hasAnyValue) skippedEmptyRows += 1;
      continue;
    }

    const bookNumber = sanitizeBookNumber(String(record.bookNumber ?? ''));
    const author = String(record.author ?? '').trim().slice(0, 160);
    const category = String(record.category ?? '').trim().slice(0, 80) || 'Umumiy';
    const quantity = parseQuantity(record.quantity);
    const description = String(record.description ?? '').trim().slice(0, 1000);

    parsedRows.push({
      rowIndex: r + 1,
      bookNumber,
      title,
      author,
      category,
      quantity,
      description,
    });
  }

  return {
    fileName,
    sheetNames: workbook.SheetNames,
    activeSheet: sheetName,
    rows: parsedRows,
    skippedEmptyRows,
  };
}

export async function readExcelWorkbookFile(file: File): Promise<XLSX.WorkBook> {
  const buffer = await file.arrayBuffer();
  return XLSX.read(buffer, { type: 'array' });
}

export function downloadBooksExcelTemplate(): void {
  const headers = [
    'Kitob raqami',
    'Kitob nomi',
    'Muallif',
    'Fan / Kategoriya',
    'Soni',
    'Tavsif',
  ];
  const sampleRows = [
    ['101', 'O‘zbekiston tarixi', 'A. Karimov', 'Tarix', 5, 'Akademik litsey darsligi'],
    ['102', 'Huquqshunoslik asoslari', 'M. Qodirov', 'Huquqshunoslik', 3, ''],
    ['', 'Ingliz tili grammatikasi', 'D. Tursunova', 'Xorijiy tillar', 10, 'Raqam bo‘sh qolsa avtomatik beriladi'],
  ];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([headers, ...sampleRows]);
  ws['!cols'] = [
    { wch: 16 },
    { wch: 36 },
    { wch: 24 },
    { wch: 22 },
    { wch: 10 },
    { wch: 38 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Kitoblar');
  XLSX.writeFile(wb, 'kitoblar_import_shablon.xlsx');
}

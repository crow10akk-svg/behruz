import * as XLSX from 'xlsx';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { formatUzDate, formatUzDateTime, isOverdueDate, sanitizeForPdf } from './imageUtils.ts';
import { getBookAvailableCount } from './libraryService.ts';
import type { Book, Student, TransactionRecord } from '../types.ts';

export type ReportType =
  | 'daily-borrow'
  | 'daily-return'
  | 'weekly'
  | 'monthly'
  | 'top-books'
  | 'top-students'
  | 'currently-held';

export interface ReportTableData {
  title: string;
  subtitle: string;
  columns: string[];
  rows: Array<Array<string | number>>;
}

function isSameDay(iso: string, ref: Date): boolean {
  const d = new Date(iso);
  return (
    d.getFullYear() === ref.getFullYear() &&
    d.getMonth() === ref.getMonth() &&
    d.getDate() === ref.getDate()
  );
}

function isWithinDays(iso: string, days: number): boolean {
  const d = new Date(iso).getTime();
  return Date.now() - d <= days * 86400000;
}

export function buildReportData(
  type: ReportType,
  books: Book[],
  students: Student[],
  transactions: TransactionRecord[]
): ReportTableData {
  const now = new Date();
  const todayLabel = formatUzDate(now.toISOString());

  switch (type) {
    case 'daily-borrow': {
      const items = transactions.filter(
        (t) => t.type === 'borrow' && isSameDay(t.borrowedAt, now)
      );
      return {
        title: 'Kunlik kitob olish hisoboti',
        subtitle: `Sana: ${todayLabel} · Jami: ${items.length} ta operatsiya`,
        columns: ['F.I.Sh.', 'Guruh', 'Kurs', 'Kitob nomi', 'Raqami', 'Olingan vaqt', 'Muddati'],
        rows: items.map((t) => [
          t.studentFullName,
          t.studentGroup,
          t.studentCourse,
          t.bookTitle,
          t.bookNumber,
          formatUzDateTime(t.borrowedAt),
          formatUzDate(t.dueDate),
        ]),
      };
    }

    case 'daily-return': {
      const items = transactions.filter(
        (t) => t.type === 'return' && t.returnedAt && isSameDay(t.returnedAt, now)
      );
      return {
        title: 'Kunlik kitob topshirish hisoboti',
        subtitle: `Sana: ${todayLabel} · Jami: ${items.length} ta operatsiya`,
        columns: ['F.I.Sh.', 'Guruh', 'Kurs', 'Kitob nomi', 'Raqami', 'Topshirilgan vaqt'],
        rows: items.map((t) => [
          t.studentFullName,
          t.studentGroup,
          t.studentCourse,
          t.bookTitle,
          t.bookNumber,
          formatUzDateTime(t.returnedAt),
        ]),
      };
    }

    case 'weekly': {
      const items = transactions.filter((t) => isWithinDays(t.createdAt, 7));
      return {
        title: 'Haftalik kutubxona hisoboti',
        subtitle: `So‘nggi 7 kun · Jami: ${items.length} ta operatsiya`,
        columns: ['Amal', 'F.I.Sh.', 'Guruh', 'Kitob nomi', 'Raqami', 'Sana va vaqt', 'Holat'],
        rows: items.map((t) => [
          t.type === 'borrow' ? 'Olish' : 'Topshirish',
          t.studentFullName,
          t.studentGroup,
          t.bookTitle,
          t.bookNumber,
          formatUzDateTime(t.type === 'borrow' ? t.borrowedAt : t.returnedAt),
          t.status === 'active'
            ? isOverdueDate(t.dueDate)
              ? 'Muddati o‘tgan'
              : 'Hali topshirilmagan'
            : 'To‘liq topshirilgan',
        ]),
      };
    }

    case 'monthly': {
      const items = transactions.filter((t) => isWithinDays(t.createdAt, 30));
      return {
        title: 'Oylik kutubxona hisoboti',
        subtitle: `So‘nggi 30 kun · Jami: ${items.length} ta operatsiya`,
        columns: ['Amal', 'F.I.Sh.', 'Guruh', 'Kitob nomi', 'Raqami', 'Sana va vaqt', 'Holat'],
        rows: items.map((t) => [
          t.type === 'borrow' ? 'Olish' : 'Topshirish',
          t.studentFullName,
          t.studentGroup,
          t.bookTitle,
          t.bookNumber,
          formatUzDateTime(t.type === 'borrow' ? t.borrowedAt : t.returnedAt),
          t.status === 'active'
            ? isOverdueDate(t.dueDate)
              ? 'Muddati o‘tgan'
              : 'Hali topshirilmagan'
            : 'To‘liq topshirilgan',
        ]),
      };
    }

    case 'top-books': {
      const sorted = [...books]
        .sort((a, b) => (b.borrowCount || 0) - (a.borrowCount || 0))
        .slice(0, 500);
      return {
        title: 'Eng ko‘p olingan kitoblar hisoboti',
        subtitle: `Jami katalog: ${books.length} ta kitob (Top ${sorted.length} ta ko‘rsatilgan)`,
        columns: ['Raqami', 'Kitob nomi', 'Muallif', 'Kategoriya', 'Olinishlar soni', 'Qoldiq / Holat'],
        rows: sorted.map((b) => {
          const avail = getBookAvailableCount(b);
          const qty = Math.max(1, b.quantity || 1);
          return [
            b.bookNumber,
            b.title,
            b.author || '—',
            b.category || '—',
            b.borrowCount || 0,
            !b.isActive ? 'Faol emas' : avail <= 0 ? `Tugagan (0/${qty})` : `${avail}/${qty} mavjud`,
          ];
        }),
      };
    }

    case 'top-students': {
      const sorted = [...students].sort((a, b) => (b.totalBorrowed || 0) - (a.totalBorrowed || 0));
      return {
        title: 'Eng ko‘p kitob olgan o‘quvchilar',
        subtitle: `Jami o‘quvchilar: ${sorted.length} nafar`,
        columns: ['F.I.Sh.', 'Guruh', 'Kurs', 'Jami olgan', 'Topshirgan', 'Hali topshirilmagan'],
        rows: sorted.map((s) => [
          s.fullName,
          s.group,
          s.course,
          s.totalBorrowed || 0,
          s.totalReturned || 0,
          s.activeCount || 0,
        ]),
      };
    }

    case 'currently-held': {
      const activeTxs = transactions.filter((t) => t.type === 'borrow' && t.status === 'active');
      return {
        title: 'Hozirda o‘quvchilarda turgan kitoblar',
        subtitle: `Jami: ${activeTxs.length} ta nusxa o‘quvchilar qo‘lida`,
        columns: ['Raqami', 'Kitob nomi', 'O‘quvchi', 'Guruh', 'Kurs', 'Olingan sana', 'Muddati', 'Holati'],
        rows: activeTxs.map((t) => [
          t.bookNumber,
          t.bookTitle,
          t.studentFullName,
          t.studentGroup,
          t.studentCourse,
          formatUzDateTime(t.borrowedAt),
          formatUzDate(t.dueDate),
          isOverdueDate(t.dueDate) ? 'Muddati o‘tgan' : 'Hali topshirilmagan',
        ]),
      };
    }
  }
}

export function exportReportToExcel(report: ReportTableData, filePrefix: string): void {
  const sheetData = [
    [report.title],
    [report.subtitle],
    [],
    report.columns,
    ...report.rows,
  ];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(sheetData);
  ws['!cols'] = report.columns.map(() => ({ wch: 22 }));
  XLSX.utils.book_append_sheet(wb, ws, 'Hisobot');
  const stamp = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `${filePrefix}_${stamp}.xlsx`);
}

export function exportReportToPdf(report: ReportTableData, filePrefix: string): void {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  doc.setFontSize(14);
  doc.text(sanitizeForPdf('IIV Andijon akademik litseyi - Smart Kutubxona'), 40, 42);
  doc.setFontSize(12);
  doc.text(sanitizeForPdf(report.title), 40, 64);
  doc.setFontSize(9);
  doc.setTextColor(90);
  doc.text(sanitizeForPdf(report.subtitle), 40, 80);

  autoTable(doc, {
    startY: 96,
    head: [report.columns.map((c) => sanitizeForPdf(c))],
    body: report.rows.map((r) => r.map((cell) => sanitizeForPdf(String(cell)))),
    styles: {
      fontSize: 8.5,
      cellPadding: 6,
    },
    headStyles: {
      fillColor: [15, 41, 66],
      textColor: [255, 255, 255],
    },
    alternateRowStyles: {
      fillColor: [248, 250, 252],
    },
  });

  const stamp = new Date().toISOString().slice(0, 10);
  doc.save(`${filePrefix}_${stamp}.pdf`);
}

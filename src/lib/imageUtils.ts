export const DEFAULT_BOOK_COVER_URL =
  '/assets/aistudio/IIV_Andijon_Academic_Lyceum_Cover__1__8dae0d95.png';

export function compressImageElementToDataUrl(
  source: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement,
  maxWidth = 360,
  maxHeight = 480,
  quality = 0.72
): string {
  const srcWidth =
    source instanceof HTMLVideoElement
      ? source.videoWidth
      : source instanceof HTMLImageElement
        ? source.naturalWidth || source.width
        : source.width;
  const srcHeight =
    source instanceof HTMLVideoElement
      ? source.videoHeight
      : source instanceof HTMLImageElement
        ? source.naturalHeight || source.height
        : source.height;

  const scale = Math.min(maxWidth / Math.max(srcWidth, 1), maxHeight / Math.max(srcHeight, 1), 1);
  const targetWidth = Math.max(1, Math.round(srcWidth * scale));
  const targetHeight = Math.max(1, Math.round(srcHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas kontekstini yaratib bo‘lmadi.');
  }
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, targetWidth, targetHeight);
  ctx.drawImage(source, 0, 0, targetWidth, targetHeight);
  return canvas.toDataURL('image/jpeg', quality);
}

export async function compressFileToDataUrl(file: File): Promise<string> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Rasmni yuklashda xatolik yuz berdi.'));
      image.src = objectUrl;
    });
    return compressImageElementToDataUrl(img, 360, 480, 0.72);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export function formatUzDateTime(iso?: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${dd}.${mm}.${yyyy} · ${hh}:${min}`;
}

export function formatUzDate(iso?: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

export function isOverdueDate(dueDateIso?: string): boolean {
  if (!dueDateIso) return false;
  const due = new Date(dueDateIso);
  if (Number.isNaN(due.getTime())) return false;
  // End of due day
  due.setHours(23, 59, 59, 999);
  return Date.now() > due.getTime();
}

export function sanitizeForPdf(text: string): string {
  return (text || '')
    .replace(/[\u2018\u2019\u02BB\u02BC`]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2014/g, '-')
    .replace(/\u2013/g, '-')
    .replace(/\u00B7/g, '·');
}

const CYRILLIC_TO_LATIN_MAP: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'yo',
  ж: 'j',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'x',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ъ: '',
  ы: 'i',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
  ў: 'o',
  қ: 'q',
  ғ: 'g',
  ҳ: 'h',
  і: 'i',
  ї: 'yi',
  є: 'e',
};

export function transliterateToLatinCanonical(text: string): string {
  const lowered = (text || '')
    .normalize('NFC')
    .trim()
    .toLowerCase()
    .replace(/[\u2018\u2019\u02BB\u02BC\u02B9\u2032ʼ′`ʻ]/g, "'");

  // Handle Uzbek Latin o' and g' cleanly, then strip remaining apostrophes
  const normalizedLatin = lowered
    .replace(/([og])'/g, '$1')
    .replace(/'/g, '');

  let out = '';
  for (let i = 0; i < normalizedLatin.length; i++) {
    const ch = normalizedLatin[i];
    out += CYRILLIC_TO_LATIN_MAP[ch] ?? ch;
  }

  // Collapse initial / post-vowel "ye" to "e" so Cyrillic "е" (Европа/Ер) matches Latin "Yevropa/Yer"
  return out
    .replace(/(^|[\s.,;:!?()[\]"'/-]|a|e|i|o|u)ye/g, '$1e')
    .replace(/[^a-z0-9.\-\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function toRelaxedPhonetic(canonicalText: string): string {
  return canonicalText
    .replace(/kh/g, 'h')
    .replace(/x/g, 'h')
    .replace(/q/g, 'k')
    .replace(/shch/g, 'sh')
    .replace(/zh/g, 'j')
    .replace(/ts/g, 's')
    .replace(/c(?!h)/g, 's')
    .replace(/w/g, 'v');
}

export function normalizeStudentId(
  firstName: string,
  lastName: string,
  group: string,
  course: string
): string {
  const raw = transliterateToLatinCanonical(
    `${firstName.trim()}_${lastName.trim()}_${group.trim()}_${course.trim()}`
  )
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return raw ? `st_${raw.slice(0, 96)}` : `st_${Date.now()}`;
}

export function makeSafeDocId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now()}_${rand}`;
}

export function normalizeCompareText(text: string): string {
  return (text || '')
    .trim()
    .toLowerCase()
    .replace(/[\u2018\u2019\u02BB\u02BC\u02B9\u2032ʼ′`]/g, "'")
    .replace(/\s+/g, ' ');
}

export function normalizeGroupCompare(group: string): string {
  return normalizeCompareText(group)
    .replace(/[\s_-]*guruh$/i, '')
    .replace(/\s+/g, '');
}

// Fayllar bilan ishlash: yuklangan fayl turini aniqlash, nomini tozalash, Telegramdan xavfsiz yuklab olish.
import { apiFor, fileUrl } from '../tg.js';
import type { BotKind } from '../types.js';
import { tgErrorCode, tgErrorDescription } from '../util.js';
import { normalizeMime } from './dto.js';

/** Mini App orqali yuklanadigan faylning maksimal hajmi (Vercel so'rov limiti 4.5 MB). */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

export type ImageMime = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

/** Baytlari bo'yicha aniqlanadigan rasm turlari: brauzer shu turni aytsa, baytlar ham mos kelishi shart. */
const SNIFFABLE_IMAGE_MIMES: ReadonlySet<string> = new Set<string>(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function ascii(b: Uint8Array, from: number, to: number): string {
  let s = '';
  for (let i = from; i < to; i++) s += String.fromCharCode(b[i]!);
  return s;
}

/** Faylning birinchi baytlariga qarab rasm turini aniqlash (brauzer bergan turga ishonmaymiz). */
export function sniffImage(b: Uint8Array): ImageMime | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (
    b.length >= 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (b.length >= 6 && ascii(b, 0, 4) === 'GIF8' && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'image/gif';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'application/zip': 'zip',
  'video/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
};

export function extForMime(mime: string): string {
  return EXT_BY_MIME[mime] ?? 'bin';
}

/**
 * Fayl nomini xavfsiz qilish: yo'l, boshqaruv belgilari va juda uzun nomlarni olib tashlash.
 * grammY multipart sarlavhasida nomni qo'shtirnoqsiz yozadi va \r/\n bo'lsa xato beradi — shuning uchun
 * boshqaruv belgilari, qo'shtirnoq va nuqtali vergul ham almashtiriladi.
 */
export function sanitizeFileName(name: string | null | undefined, mime: string): string {
  let n = String(name ?? '')
    .split(/[\\/]/)
    .pop()!
    .replace(/[\p{Cc}\p{Zl}\p{Zp}"<>|:*?;]/gu, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^\.+$/.test(n)) n = '';
  if (!n) return `file.${extForMime(mime)}`;
  const chars = Array.from(n);
  if (chars.length > 120) {
    const dot = n.lastIndexOf('.');
    const ext = dot > 0 && n.length - dot <= 10 ? n.slice(dot) : '';
    const base = Array.from(ext ? n.slice(0, dot) : n)
      .slice(0, 120 - ext.length)
      .join('');
    n = base + ext;
  }
  return n;
}

export interface UploadClass {
  kind: 'photo' | 'animation' | 'document';
  /** Bazada saqlanadigan MIME turi — Telegram saqlagan fayl turi (GIF uchun 'video/mp4') */
  mimeType: string;
  /** Yuklangan baytlarning haqiqiy MIME turi (hujjat sifatida qayta urinishda ishlatiladi) */
  sourceMime: string;
  fileName: string;
}

/**
 * Yuklangan fayl qanday yuborilishini aniqlash:
 * - JPEG/PNG/WEBP -> rasm (photo);
 * - GIF -> animatsiya (sendAnimation). Telegram GIF ni baribir MPEG-4 animatsiyaga aylantiradi (sendDocument ham),
 *   shuning uchun turi 'animation', MIME esa 'video/mp4' deb saqlanadi. Ilgari 'document' + 'image/gif' deb
 *   saqlanardi va proksi MP4 baytlarni image/gif sifatida berib, Mini App da buzilgan rasm chiqardi;
 * - qolgan hammasi -> hujjat (document).
 */
export function classifyUpload(data: Uint8Array, declaredType: string, declaredName: string): UploadClass {
  const sniffed = sniffImage(data);
  let mime = normalizeMime(declaredType);
  if (sniffed) mime = sniffed;
  // Brauzer "rasm" degan, lekin baytlar rasm emas — Mini App da rasm sifatida ko'rsatmaslik uchun
  else if (SNIFFABLE_IMAGE_MIMES.has(mime)) mime = 'application/octet-stream';
  if (!mime) mime = 'application/octet-stream';
  let fileName = sanitizeFileName(declaredName, mime);
  if (sniffed === 'image/gif') {
    if (!/\.gif$/i.test(fileName)) fileName = `${fileName}.gif`;
    return { kind: 'animation', mimeType: 'video/mp4', sourceMime: mime, fileName };
  }
  const kind = sniffed ? 'photo' : 'document';
  if (kind === 'photo' && !/\.(jpe?g|png|webp)$/i.test(fileName)) fileName = `${fileName}.${extForMime(mime)}`;
  return { kind, mimeType: mime, sourceMime: mime, fileName };
}

/** Log yozuvlaridan bot tokenlarini olib tashlash. */
export function redact(s: string): string {
  return s.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot<token>').replace(/\d{5,}:[A-Za-z0-9_-]{20,}/g, '<token>');
}

export class MediaFetchError extends Error {
  constructor(
    readonly status: 404 | 413 | 502,
    message: string,
  ) {
    super(message);
  }
}

export interface OpenedFile {
  body: ReadableStream<Uint8Array>;
  size: number | null;
  filePath: string;
}

/**
 * Telegram faylini ochish (oqim sifatida). URL ichida bot tokeni bo'lgani uchun u hech qachon tashqariga chiqmaydi.
 * Xatolar: MediaFetchError(404 — fayl yo'q/yaroqsiz, 413 — juda katta, 502 — Telegram xatosi).
 */
export async function openTelegramFile(bot: BotKind, fileId: string, maxBytes: number): Promise<OpenedFile> {
  const api = apiFor(bot);
  if (!api) throw new MediaFetchError(404, `${bot} boti sozlanmagan`);
  let file;
  try {
    // grammY signal turini abort-controller shim orqali e'lon qiladi; native AbortSignal ish vaqtida mos keladi
    const signal = AbortSignal.timeout(20_000) as unknown as Parameters<typeof api.getFile>[1];
    file = await api.getFile(fileId, signal);
  } catch (e) {
    const code = tgErrorCode(e);
    if (code === 400) throw new MediaFetchError(404, redact(tgErrorDescription(e)));
    throw new MediaFetchError(502, redact(tgErrorDescription(e)));
  }
  if (!file.file_path) throw new MediaFetchError(413, 'file_path yo\'q (fayl juda katta)');
  if (file.file_size != null && file.file_size > maxBytes) throw new MediaFetchError(413, 'Fayl juda katta');

  let res: Response;
  try {
    res = await fetch(fileUrl(bot, file.file_path), { signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    throw new MediaFetchError(502, redact(e instanceof Error ? e.message : String(e)));
  }
  if (!res.ok || !res.body) {
    try {
      await res.body?.cancel();
    } catch {
      /* e'tiborsiz */
    }
    throw new MediaFetchError(res.status === 404 ? 404 : 502, `Telegram fayl serveri: HTTP ${res.status}`);
  }
  // Siqilgan (content-encoding) javobda fetch baytlarni ochib beradi — content-length ga ishonib bo'lmaydi
  const encoded = !!res.headers.get('content-encoding');
  const len = encoded ? NaN : Number(res.headers.get('content-length') ?? '');
  const size = Number.isFinite(len) && len > 0 ? len : null;
  if ((size ?? file.file_size ?? 0) > maxBytes) {
    try {
      await res.body.cancel();
    } catch {
      /* e'tiborsiz */
    }
    throw new MediaFetchError(413, 'Fayl juda katta');
  }
  return { body: res.body as ReadableStream<Uint8Array>, size, filePath: file.file_path };
}

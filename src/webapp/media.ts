// Media proksi: GET /api/media
//  ?staff=<id>&v=<ver>  — xodimning ochiq rasmi (faqat kanonik URL Telegramdan yuklanadi va CDN da keshlanadi)
//  ?t=<token>           — xabar fayli (imzolangan, vaqtinchalik token)
// Telegram fayl URL manzili (ichida bot tokeni bor) hech qachon mijozga berilmaydi — baytlar shu yerdan uzatiladi.
import { verifyMediaToken } from '../auth.js';
import { getMessage, getStaff } from '../repo.js';
import { staffApi } from '../tg.js';
import type { BotKind, Message } from '../types.js';
import { tgErrorDescription } from '../util.js';
import {
  INLINE_IMAGE_MIMES,
  MEDIA_KINDS,
  MEDIA_PROXY_MAX_BYTES,
  MEDIA_TOKEN_BUCKET,
  MEDIA_TOKEN_MIN_TTL,
  normalizeMime,
  staffPhotoUrl,
} from './dto.js';
import { MediaFetchError, extForMime, openTelegramFile, redact, type OpenedFile } from './files.js';
import { hitRateLimit, type RateRule } from './guards.js';

/** Xodim rasmlari odatda bir necha yuz KB; baribir chegaralaymiz. */
const STAFF_PHOTO_MAX_BYTES = MEDIA_PROXY_MAX_BYTES;

/**
 * Xodim rasmi Vercel CDN da shuncha vaqt keshlanadi (soniya). Brauzer uchun URL o'zgarmas (immutable, 1 yil),
 * lekin CDN nusxasi cheklangan: admin rasmni olib tashlasa yoki xodimni o'chirsa, eski URL ko'pi bilan
 * shuncha vaqtdan keyin ishlamay qoladi. Telegramga murojaat: har bir kanonik URL uchun shu muddatda bir marta.
 */
const STAFF_PHOTO_CDN_TTL = 6 * 60 * 60;

/** Eski/noto'g'ri URL dan kanonik URL ga yo'naltirish qisqa muddat keshlanadi. */
const REDIRECT_TTL = 60;

/**
 * Qo'shimcha himoya (CDN keshi chetlab o'tilsa ham): bitta fayl uchun Telegramga (getFile + yuklab olish)
 * murojaatlar soni cheklanadi. Odatda kanonik rasm URL i CDN da keshlanadi va bu yerga kamdan-kam yetib keladi;
 * xabar fayli esa brauzerda keshlanadi. Holat Postgres da (rate_limits), jadval bo'lmasa — cheklovsiz (fail-open).
 */
const TELEGRAM_FETCH_RULES: readonly RateRule[] = [
  { windowSec: 60, max: 60 },
  { windowSec: 3600, max: 600 },
];

function plain(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

/** Limitdan oshsa 429 javobi (aks holda null). Kalit — fayl (xodim rasmi / xabar), foydalanuvchi emas. */
async function fetchLimited(key: string): Promise<Response | null> {
  const verdict = await hitRateLimit(key, TELEGRAM_FETCH_RULES);
  if (verdict.allowed) return null;
  console.warn(`media: ${key} — chastota limiti (${verdict.retryAfterSec} s)`);
  return new Response('Too many requests', {
    status: 429,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'retry-after': String(verdict.retryAfterSec),
      'x-content-type-options': 'nosniff',
    },
  });
}

function parseId(v: string | null): number | null {
  if (!v || !/^\d{1,15}$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Nomzod fayllarni ketma-ket sinab ko'rish; birinchisi muvaffaqiyatli bo'lsa — o'sha. */
async function openFirst(candidates: Array<[BotKind, string]>, maxBytes: number): Promise<OpenedFile | Response> {
  let worst: number = 404;
  for (const [bot, fileId] of candidates) {
    try {
      return await openTelegramFile(bot, fileId, maxBytes);
    } catch (e) {
      if (e instanceof MediaFetchError) {
        if (e.status === 413) worst = 413;
        else if (e.status === 502 && worst !== 413) worst = 502;
        if (e.status !== 404) console.warn(`media: ${bot} fayli ochilmadi (${e.status}): ${e.message}`);
      } else {
        worst = worst === 413 ? 413 : 502;
        console.error(`media: ${bot} fayli ochilmadi:`, redact(tgErrorDescription(e)));
      }
    }
  }
  if (worst === 413) return plain(413, 'File too large');
  if (worst === 502) return plain(500, 'Upstream error');
  return plain(404, 'Not found');
}

function withLength(headers: Headers, size: number | null): Headers {
  if (size != null && Number.isFinite(size) && size > 0) headers.set('content-length', String(size));
  return headers;
}

/**
 * Xodimning ochiq rasmi. Autentifikatsiyasiz bo'lgani uchun Telegramga (getFile + yuklab olish) faqat
 * AYNAN kanonik URL (staffPhotoUrl: ?staff=<id>&v=<joriy versiya>) bilan murojaat qilinadi — u CDN da keshlanadi.
 * Boshqa har qanday ko'rinish (eski yoki yo'q v, ortiqcha parametrlar, boshqa tartib, "01" kabi id) arzon
 * DB o'qishidan keyin kanonik URL ga 302 bilan yo'naltiriladi: tasodifiy v bilan keshni chetlab o'tib,
 * xodimlar botining limitini va trafikni sarflab bo'lmaydi. <img> yo'naltirishga ergashadi, shuning uchun
 * eski ro'yxatdagi URL ham joriy rasmni ko'rsatadi.
 * O'chirilgan xodim — 404. Faol emas / ulanmagan xodimning rasmi ataylab beriladi: mijozning suhbatlar
 * ro'yxati va admin paneli ularni ham ko'rsatadi.
 */
async function staffPhoto(url: URL): Promise<Response> {
  const id = parseId(url.searchParams.get('staff'));
  if (!id) return plain(404, 'Not found');
  const staff = await getStaff(id);
  if (!staff || staff.deleted_at) return plain(404, 'Not found');

  const canonical = staffPhotoUrl(staff.id, staff);
  if (!canonical) return plain(404, 'Not found');
  if (url.search !== canonical.slice(canonical.indexOf('?'))) {
    return new Response(null, {
      status: 302,
      headers: {
        location: canonical,
        'cache-control': `public, max-age=${REDIRECT_TTL}`,
        'vercel-cdn-cache-control': `max-age=${REDIRECT_TTL}`,
        'x-content-type-options': 'nosniff',
      },
    });
  }

  const candidates: Array<[BotKind, string]> = [];
  if (staff.photo_file_id && staffApi()) candidates.push(['staff', staff.photo_file_id]);
  if (staff.client_photo_file_id) candidates.push(['client', staff.client_photo_file_id]);
  if (!candidates.length) return plain(404, 'Not found');

  const limited = await fetchLimited(`media:staff:${staff.id}`);
  if (limited) return limited;
  const opened = await openFirst(candidates, STAFF_PHOTO_MAX_BYTES);
  if (opened instanceof Response) return opened;

  const headers = withLength(
    new Headers({
      'content-type': 'image/jpeg',
      // Brauzer: URL versiyali — o'zgarmas. CDN: cheklangan muddat (olib tashlangan rasm uzoq qolib ketmasin).
      'cache-control': 'public, max-age=31536000, immutable',
      'vercel-cdn-cache-control': `max-age=${STAFF_PHOTO_CDN_TTL}`,
      'content-disposition': 'inline',
      'x-content-type-options': 'nosniff',
      'content-security-policy': 'sandbox',
    }),
    opened.size,
  );
  return new Response(opened.body, { status: 200, headers });
}

/** Xabar fayli uchun Content-Type. */
function contentTypeOf(m: Message): string {
  if (m.kind === 'photo') return 'image/jpeg';
  if (m.kind === 'sticker' && !m.meta?.sticker_animated) return 'image/webp';
  return normalizeMime(m.mime_type) || 'application/octet-stream';
}

function fallbackName(m: Message, contentType: string): string {
  return m.file_name?.trim() || `${m.kind}_${m.id}.${extForMime(contentType)}`;
}

/** RFC 6266 bo'yicha Content-Disposition (UTF-8 nomlar bilan). */
function disposition(type: 'inline' | 'attachment', name: string): string {
  const asciiName = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_').slice(0, 150) || 'file';
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${type}; filename="${asciiName}"; filename*=UTF-8''${encoded}`;
}

/** Brauzer keshining eng uzoq muddati (DTO dagi tokenlar 6–12 soat amal qiladi). */
const MEDIA_CACHE_MAX_AGE = MEDIA_TOKEN_MIN_TTL + MEDIA_TOKEN_BUCKET;

/** Tekshirilgan tokendan tugash vaqtini olish (format: <id>.<exp>.<imzo>). */
function tokenExpiry(token: string): number {
  const exp = Number(token.split('.')[1]);
  return Number.isSafeInteger(exp) ? exp : 0;
}

async function messageMedia(token: string): Promise<Response> {
  const id = verifyMediaToken(token);
  if (id == null) return plain(403, 'Forbidden');
  // Xabar fayli o'zgarmaydi: nusxa URL (token) amal qilguncha keshlanadi, undan uzoq emas
  const maxAge = Math.min(Math.max(0, tokenExpiry(token) - Math.floor(Date.now() / 1000)), MEDIA_CACHE_MAX_AGE);
  const m = await getMessage(id);
  if (!m || !MEDIA_KINDS.has(m.kind)) return plain(404, 'Not found');
  if (m.file_size != null && m.file_size > MEDIA_PROXY_MAX_BYTES) return plain(413, 'File too large');

  const candidates: Array<[BotKind, string]> = [];
  if (m.file_id_staff && staffApi()) candidates.push(['staff', m.file_id_staff]);
  if (m.file_id_client) candidates.push(['client', m.file_id_client]);
  if (!candidates.length) return plain(404, 'Not found');

  const limited = await fetchLimited(`media:msg:${m.id}`);
  if (limited) return limited;
  const opened = await openFirst(candidates, MEDIA_PROXY_MAX_BYTES);
  if (opened instanceof Response) return opened;

  const contentType = contentTypeOf(m);
  const inline = INLINE_IMAGE_MIMES.has(contentType);
  const headers = withLength(
    new Headers({
      'content-type': contentType,
      'cache-control': `private, max-age=${maxAge}, immutable`,
      'content-disposition': inline ? 'inline' : disposition('attachment', fallbackName(m, contentType)),
      'x-content-type-options': 'nosniff',
      'content-security-policy': 'sandbox',
      'referrer-policy': 'no-referrer',
    }),
    opened.size,
  );
  return new Response(opened.body, { status: 200, headers });
}

export async function handleMediaRequest(req: Request): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  }
  let res: Response;
  try {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('t');
    if (token != null) res = await messageMedia(token);
    else if (url.searchParams.has('staff')) res = await staffPhoto(url);
    else res = plain(404, 'Not found');
  } catch (e) {
    console.error('media proksi xatosi:', redact(tgErrorDescription(e)));
    res = plain(500, 'Internal error');
  }
  if (req.method === 'HEAD') {
    try {
      await res.body?.cancel();
    } catch {
      /* e'tiborsiz */
    }
    return new Response(null, { status: res.status, headers: res.headers });
  }
  return res;
}

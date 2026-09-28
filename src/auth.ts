// Telegram Mini App initData tekshiruvi va imzolangan media havolalari.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import type { BotKind } from './types.js';

export interface WebAppUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  photo_url?: string;
}

export interface WebAppAuth {
  bot: BotKind;
  user: WebAppUser;
  authDate: number;
}

/** initData amal qilish muddati (soniya). */
const INIT_DATA_MAX_AGE = 24 * 60 * 60;

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || !/^[0-9a-f]+$/i.test(a)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

function checkWithToken(params: URLSearchParams, hash: string, token: string): boolean {
  const pairs: string[] = [];
  for (const [k, v] of params) if (k !== 'hash') pairs.push(`${k}=${v}`);
  pairs.sort();
  const dataCheckString = pairs.join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const expected = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  return safeEqualHex(expected, hash);
}

/**
 * initData ni ikkala bot tokeni bilan tekshiradi. Qaysi bot bilan mos kelsa — o'sha bot (client/staff).
 * Noto'g'ri yoki eskirgan bo'lsa null.
 */
export function verifyInitData(initData: string, nowSec = Math.floor(Date.now() / 1000)): WebAppAuth | null {
  if (!initData || initData.length > 8192) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;

  let bot: BotKind | null = null;
  if (checkWithToken(params, hash, config.clientBotToken)) bot = 'client';
  else if (config.hasStaffBot && checkWithToken(params, hash, config.staffBotToken)) bot = 'staff';
  if (!bot) return null;

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || authDate <= 0) return null;
  if (nowSec - authDate > INIT_DATA_MAX_AGE) return null;

  try {
    const user = JSON.parse(params.get('user') ?? 'null') as WebAppUser | null;
    if (!user || !Number.isSafeInteger(user.id)) return null;
    return { bot, user, authDate };
  } catch {
    return null;
  }
}

/** Testlar uchun: berilgan token bilan to'g'ri initData yaratish. */
export function buildInitData(token: string, user: WebAppUser, authDate = Math.floor(Date.now() / 1000)): string {
  const params = new URLSearchParams();
  params.set('auth_date', String(authDate));
  params.set('query_id', 'AAtest');
  params.set('user', JSON.stringify(user));
  const pairs: string[] = [];
  for (const [k, v] of params) pairs.push(`${k}=${v}`);
  pairs.sort();
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(pairs.join('\n')).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

// ───────────────────── Imzolangan media havolalari ─────────────────────

/**
 * Media tokenlari imzosi kaliti: MEDIA_SECRET (berilgan bo'lsa) — aks holda WEBHOOK_SECRET dan hosil qilinadi.
 * Alohida kalit media tokenlarini (≤ 6 soat yashaydi) webhooklarni qayta ro'yxatdan o'tkazmasdan almashtirish imkonini beradi.
 */
function mediaKey(): Buffer {
  const own = config.mediaSecret;
  if (own) return createHmac('sha256', 'uzgrow-media-v2').update(own).digest();
  return createHmac('sha256', 'uzgrow-media').update(config.webhookSecret).digest();
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

/** Xabar media fayli uchun vaqtinchalik imzolangan token (standart: 6 soat). */
export function signMediaToken(messageId: number, ttlSec = 6 * 60 * 60, nowSec = Math.floor(Date.now() / 1000)): string {
  const exp = nowSec + ttlSec;
  const payload = `${messageId}.${exp}`;
  const sig = b64url(createHmac('sha256', mediaKey()).update(payload).digest()).slice(0, 32);
  return `${payload}.${sig}`;
}

/** Token to'g'ri va muddati o'tmagan bo'lsa message id ni qaytaradi. */
export function verifyMediaToken(token: string, nowSec = Math.floor(Date.now() / 1000)): number | null {
  const m = /^(\d{1,15})\.(\d{1,12})\.([A-Za-z0-9_-]{32})$/.exec(token ?? '');
  if (!m) return null;
  const [, idStr, expStr, sig] = m;
  const payload = `${idStr}.${expStr}`;
  const expected = b64url(createHmac('sha256', mediaKey()).update(payload).digest()).slice(0, 32);
  const a = Buffer.from(expected);
  const b = Buffer.from(sig!);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Number(expStr) < nowSec) return null;
  return Number(idStr);
}

/** Webhook so'rovi Telegramdan kelganini tekshirish (X-Telegram-Bot-Api-Secret-Token). */
export function webhookSecretFor(bot: BotKind): string {
  // Har bir bot uchun alohida, lekin bitta WEBHOOK_SECRET dan hosil qilinadi. Faqat [A-Za-z0-9_-] ruxsat.
  // WEBHOOK_SECRET hech qachon URL/so'rov parametrida uzatilmaydi (/api/setup alohida SETUP_KEY ishlatadi).
  return createHmac('sha256', config.webhookSecret).update(`webhook:${bot}`).digest('base64url').slice(0, 64);
}

/**
 * Maxfiy satrlarni doimiy vaqtda solishtirish. Ikkala qiymatning SHA-256 xeshi solishtiriladi — shunda javob
 * vaqti na mos kelgan prefiksni, na kalit uzunligini oshkor qiladi.
 */
export function safeEqualStr(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

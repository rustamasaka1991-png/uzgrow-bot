// Xodimga yetkazilmay qolgan mijoz xabarlarini FONDA (alohida funksiya chaqiruvida) qayta yetkazishni rejalashtirish.
//
// Telegram 429 (retry_after) yoki boshqa vaqtinchalik xatodan keyin xabar "kutishga" o'tadi (messages.delivery_retry_at).
// Suhbat jim bo'lib qolsa ham xodimga yetib borishi uchun shu vaqtga POST /api/redeliver chaqiriladi: u notBefore gacha
// kutadi (uzoq bo'lsa — o'zini qayta chaqiradi) va xodimning navbatini tartib bilan yetkazadi (src/relay.ts →
// runScheduledRedelivery). Hammasi "band qilish" orqali: parallel fon chaqiruvlari bitta xabarni ikki marta yubormaydi.
// Takroriy chaqiruvlar staff.redeliver_at belgisi bilan kamaytiriladi (shu yoki oldingi vaqtga rejalashtirilgan bo'lsa,
// yangi chaqiruv yuborilmaydi).
import { createHmac } from 'node:crypto';
import { config } from './config.js';
import { remainingMs } from './deadline.js';
import { getAppUrl } from './links.js';
import { markRedeliveryScheduled } from './repo.js';
import { staffApi } from './tg.js';
import { describeError } from './util.js';

/** Bitta zanjirdagi (o'zini qayta chaqirish / keyingi urinish) chaqiruvlar soni cheklovi. */
export const REDELIVER_MAX_HOPS = 20;
/**
 * /api/redeliver bitta chaqiruvda notBefore gacha shuncha kutadi: 55 s byudjetdan yetkazish uchun (≥ 20 s,
 * relay.ts REDELIVERY_MIN_MS) joy qolishi kerak. Undan uzoq bo'lsa — uxlab, o'zini qayta chaqiradi.
 */
export const REDELIVER_MAX_INLINE_WAIT_MS = 30_000;
/** O'zini qayta chaqirishdan oldin bir chaqiruvda uxlash chegarasi (55 s byudjet ichida). */
export const REDELIVER_HOP_SLEEP_MS = 45_000;
/** Bundan uzoqroq kelajakka fonda kutilmaydi (keyingi hodisa yoki 2 daqiqalik TTL yetkazadi). */
export const REDELIVER_MAX_AHEAD_MS = 10 * 60_000;
/** Soat farqi (baza ↔ funksiya) uchun zaxira: retry vaqtidan biroz keyin uyg'onamiz. */
export const REDELIVER_MARGIN_MS = 500;
/** Fon chaqiruvini yuborish: javob kutilmaydi, so'rov yetib borishi uchun qisqa vaqt. */
const TRIGGER_TIMEOUT_MS = 2_500;

/** /api/redeliver uchun maxfiy kalit (WEBHOOK_SECRET dan hosil qilinadi, broadcastKey kabi). */
export function redeliverKey(): string {
  return createHmac('sha256', config.webhookSecret).update('redeliver-pending').digest('base64url');
}

export interface RedeliverRequest {
  staffId: number;
  /** Epoch ms: shu vaqtdan oldin yetkazishga urinilmaydi. */
  notBefore: number;
  hop: number;
}

/**
 * Xodim navbatini `notBefore` da fonda yetkazishni so'rash (javob kutilmaydi; xato jim — keyingi hodisa yoki
 * TTL yetkazadi). `force` — belgini tekshirmasdan (o'zini qayta chaqirishda). Chaqiruv yuborilgan bo'lsa true.
 */
export async function requestRedelivery(
  staffId: number,
  notBefore: Date | number,
  opts: { hop?: number; force?: boolean } = {},
): Promise<boolean> {
  try {
    if (!staffApi() || !Number.isSafeInteger(staffId) || staffId <= 0) return false;
    const hop = Math.max(0, Math.floor(opts.hop ?? 0));
    if (hop > REDELIVER_MAX_HOPS) {
      console.warn(`[redeliver] xodim #${staffId}: fon zanjiri cheklovi (${REDELIVER_MAX_HOPS}) — keyingi hodisa kutiladi`);
      return false;
    }
    const now = Date.now();
    let at = typeof notBefore === 'number' ? notBefore : notBefore.getTime();
    if (!Number.isFinite(at) || at < now) at = now;
    if (at - now > REDELIVER_MAX_AHEAD_MS) return false;
    at = Math.ceil(at);
    if (!opts.force && !(await markRedeliveryScheduled(staffId, new Date(at)))) return false;
    const base = await getAppUrl();
    if (!/^https:\/\//.test(base)) return false;
    const left = remainingMs();
    const timeout = Number.isFinite(left) ? Math.max(500, Math.min(TRIGGER_TIMEOUT_MS, left - 5_000)) : TRIGGER_TIMEOUT_MS;
    const body: RedeliverRequest = { staffId, notBefore: at, hop };
    await fetch(`${base}/api/redeliver`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-redeliver-key': redeliverKey() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    }).catch(() => {});
    return true;
  } catch (e) {
    console.error(`[redeliver] xodim #${staffId} uchun fon yetkazishni rejalashtirib bo'lmadi:`, describeError(e));
    return false;
  }
}

/** So'rov tanasini tekshirish (ichki endpoint — baribir kalit bilan himoyalangan). */
export function parseRedeliverRequest(body: unknown): RedeliverRequest | null {
  const b = (body ?? {}) as { staffId?: unknown; notBefore?: unknown; hop?: unknown };
  const staffId = Number(b.staffId);
  const notBefore = b.notBefore == null ? Date.now() : Number(b.notBefore);
  const hop = b.hop == null ? 0 : Number(b.hop);
  if (!Number.isSafeInteger(staffId) || staffId <= 0) return null;
  if (!Number.isFinite(notBefore) || !Number.isSafeInteger(hop) || hop < 0 || hop > REDELIVER_MAX_HOPS) return null;
  // Juda uzoq kelajak — noto'g'ri so'rov
  if (notBefore - Date.now() > REDELIVER_MAX_AHEAD_MS + 60_000) return null;
  return { staffId, notBefore, hop };
}

/**
 * Vercel "waitUntil" (javob qaytarilgandan keyin ham ishni davom ettirish). @vercel/functions paketi shu global
 * kontekstni o'qiydi; bo'lmasa (lokal, testlar) — undefined va ish so'rov ichida bajariladi.
 */
export function vercelWaitUntil(): ((p: Promise<unknown>) => void) | undefined {
  try {
    const holder = (globalThis as Record<symbol, unknown>)[Symbol.for('@vercel/request-context')] as
      | { get?: () => { waitUntil?: (p: Promise<unknown>) => void } | undefined }
      | undefined;
    const ctx = holder?.get?.();
    return typeof ctx?.waitUntil === 'function' ? ctx.waitUntil.bind(ctx) : undefined;
  } catch {
    return undefined;
  }
}

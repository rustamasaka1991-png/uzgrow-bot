// Mini App himoyalari: so'rovlar chastotasini cheklash (rate limit) va takroriy yuborishdan himoya (idempotentlik).
// Serverless nusxalar xotirani bo'lishmaydi — shuning uchun holat Postgres da saqlanadi (rate_limits, webapp_sends).
// Jadvallar src/schema.ts migratsiyasida yaratiladi. Jadval hali yo'q bo'lsa (migratsiya ishga tushirilmagan),
// himoya o'chiq holda ishlaydi (fail-open) — yuborish buzilmaydi, logga bir marta ogohlantirish yoziladi.
import { db } from '../db.js';
import type { Sender } from '../types.js';

// ───────────────────────────── Umumiy ─────────────────────────────

function pgCode(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

const warned = new Set<string>();

/** Himoya so'rovi bajarilmadi — yuborishni to'xtatmaymiz (fail-open), lekin logga yozamiz. */
function failOpen(what: string, e: unknown): void {
  if (pgCode(e) === '42P01') {
    // undefined_table: migratsiya hali qo'llanmagan — har so'rovda logni to'ldirmaslik uchun bir marta
    if (!warned.has(what)) {
      warned.add(what);
      console.warn(`[guards] ${what}: jadval topilmadi — himoya o'chiq. «npm run setup» (yoki POST /api/setup, SETUP_KEY bilan) ni ishga tushiring.`);
    }
    return;
  }
  console.error(`[guards] ${what} xatosi (himoyasiz davom etilmoqda):`, e instanceof Error ? e.message : e);
}

/** Eski yozuvlarni vaqti-vaqti bilan tozalash (har ~100 chaqiruvda bir marta, xatolar e'tiborsiz). */
function maybeCleanup(run: () => Promise<unknown>): void {
  if (Math.random() >= 0.01) return;
  run().catch(() => {});
}

// ───────────────────────────── Rate limit ─────────────────────────────

export interface RateRule {
  /** Oyna uzunligi (soniya) */
  windowSec: number;
  /** Oynadagi ruxsat etilgan so'rovlar soni */
  max: number;
}

export interface RateVerdict {
  allowed: boolean;
  /** Cheklov tugashigacha qolgan vaqt (soniya), ruxsat berilgan bo'lsa 0 */
  retryAfterSec: number;
}

/**
 * Qat'iy (fixed-window) hisoblagichlar: har bir qoida uchun `<key>:<windowSec>` kaliti.
 * Bitta atomik so'rov (INSERT ... ON CONFLICT DO UPDATE) — parallel so'rovlarda ham to'g'ri sanaydi.
 * Rad etilgan so'rovlar ham sanaladi: to'xtovsiz urinishlar oyna tugaguncha bloklanib turadi.
 */
export async function hitRateLimit(key: string, rules: readonly RateRule[]): Promise<RateVerdict> {
  if (!rules.length) return { allowed: true, retryAfterSec: 0 };
  const sql = db();
  const nowMs = Date.now();
  const rows = rules.map((r) => ({
    key: `${key}:${r.windowSec}`,
    window_start: new Date(Math.floor(nowMs / 1000 / r.windowSec) * r.windowSec * 1000),
    count: 1,
  }));
  let result: Array<{ key: string; count: number; window_start: Date }>;
  try {
    result = await sql<Array<{ key: string; count: number; window_start: Date }>>`
      insert into rate_limits ${sql(rows as never, 'key', 'window_start', 'count')}
      on conflict (key, window_start) do update set count = rate_limits.count + 1
      returning key, count, window_start`;
  } catch (e) {
    failOpen('rate_limits', e);
    return { allowed: true, retryAfterSec: 0 };
  }
  maybeCleanup(() => sql`delete from rate_limits where window_start < now() - interval '1 day'`);

  let retryAfterSec = 0;
  for (const rule of rules) {
    const row = result.find((r) => r.key === `${key}:${rule.windowSec}`);
    if (!row || row.count <= rule.max) continue;
    const endsMs = new Date(row.window_start).getTime() + rule.windowSec * 1000;
    retryAfterSec = Math.max(retryAfterSec, Math.max(1, Math.ceil((endsMs - nowMs) / 1000)));
  }
  return { allowed: retryAfterSec === 0, retryAfterSec };
}

// ───────────────────────────── Idempotentlik ─────────────────────────────

/**
 * Mini App yuborishlari uchun "nonce" da'vosi (claim).
 * - `claimed`  — birinchi so'rov: xabarni yuborish kerak;
 * - `done`     — bu nonce bilan xabar allaqachon saqlangan (javob yo'qolib, qayta yuborilgan);
 * - `pending`  — birinchi so'rov hali bajarilmoqda;
 * - `disabled` — himoya ishlamayapti (jadval yo'q / DB xatosi): odatdagidek yuboriladi.
 */
export type SendClaim =
  | { state: 'claimed' }
  | { state: 'done'; messageId: number }
  | { state: 'pending' }
  | { state: 'disabled' };

export async function claimSend(conversationId: number, sender: Sender, nonce: string): Promise<SendClaim> {
  const sql = db();
  try {
    const inserted = await sql`
      insert into webapp_sends (conversation_id, sender, nonce)
      values (${conversationId}, ${sender}, ${nonce})
      on conflict do nothing
      returning 1 as ok`;
    maybeCleanup(() => sql`delete from webapp_sends where created_at < now() - interval '3 days'`);
    if (inserted.length) return { state: 'claimed' };

    // Bu nonce avval ishlatilgan: natija tayyormi yoki birinchi so'rov hali bajarilmoqdami
    const rows = await sql<Array<{ message_id: number | null; stale: boolean }>>`
      select message_id, (created_at < now() - interval '3 minutes') as stale
      from webapp_sends
      where conversation_id = ${conversationId} and sender = ${sender} and nonce = ${nonce}`;
    const row = rows[0];
    if (!row) {
      // Shu orada o'chirildi (yuborish muvaffaqiyatsiz tugagan) — yana bir marta urinib ko'ramiz
      const again = await sql`
        insert into webapp_sends (conversation_id, sender, nonce)
        values (${conversationId}, ${sender}, ${nonce})
        on conflict do nothing
        returning 1 as ok`;
      return again.length ? { state: 'claimed' } : { state: 'pending' };
    }
    if (row.message_id != null) return { state: 'done', messageId: row.message_id };
    if (row.stale) {
      // Oldingi so'rov tugamay qolgan (funksiya maxDuration = 60 s, zaxira bilan 3 daqiqa) —
      // da'voni atomik tarzda o'zimizga olamiz
      const taken = await sql`
        update webapp_sends set created_at = now()
        where conversation_id = ${conversationId} and sender = ${sender} and nonce = ${nonce}
          and message_id is null and created_at < now() - interval '3 minutes'
        returning 1 as ok`;
      if (taken.length) return { state: 'claimed' };
    }
    return { state: 'pending' };
  } catch (e) {
    failOpen('webapp_sends', e);
    return { state: 'disabled' };
  }
}

/** Xabar saqlandi — nonce ni unga bog'laymiz (takroriy so'rov shu xabarni qaytaradi). */
export async function completeSend(conversationId: number, sender: Sender, nonce: string, messageId: number): Promise<void> {
  try {
    await db()`
      update webapp_sends set message_id = ${messageId}
      where conversation_id = ${conversationId} and sender = ${sender} and nonce = ${nonce}`;
  } catch (e) {
    failOpen('webapp_sends', e);
  }
}

/** Hech narsa saqlanmadi — da'voni bo'shatamiz, foydalanuvchi qayta urinib ko'ra olsin. */
export async function releaseSend(conversationId: number, sender: Sender, nonce: string): Promise<void> {
  try {
    await db()`
      delete from webapp_sends
      where conversation_id = ${conversationId} and sender = ${sender} and nonce = ${nonce} and message_id is null`;
  } catch (e) {
    failOpen('webapp_sends', e);
  }
}

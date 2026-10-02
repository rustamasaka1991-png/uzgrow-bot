// Ommaviy xabar (ROP/developer → barcha mijozlar, mijozlar boti orqali).
// Serverless cheklovlari sababli bo'laklab yuboriladi: har bir chaqiruv vaqt byudjeti ichida imkon qadar ko'p
// mijozga yuboradi, `last_client_id` kursorini saqlaydi va tugamasa /api/broadcast ni o'zi qayta chaqiradi.
// Bir vaqtda faqat bitta ishlovchi (locked_until qulfi). Telegram limiti: ~25 xabar/soniya.
import { createHmac } from 'node:crypto';
import { InlineKeyboard } from 'grammy';
import { config } from './config.js';
import { db } from './db.js';
import { getAppUrl } from './links.js';
import { setClientBlocked } from './repo.js';
import { sendContent, staffApi } from './tg.js';
import type { Content, MessageMeta, MsgKind } from './types.js';
import { esc, sleep, tgErrorCode, tgErrorDescription } from './util.js';

/** Ommaviy xabarda ruxsat etilgan turlar. */
export const BROADCAST_KINDS: MsgKind[] = ['text', 'photo', 'video', 'animation', 'document', 'audio', 'voice'];

export interface BroadcastContent {
  kind: MsgKind;
  text?: string;
  entities?: Content['entities'];
  /** Xodimlar botidagi file_id (ROP xabaridan) */
  fileId?: string;
  fileUniqueId?: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  meta?: MessageMeta;
  /** Birinchi yuborishdan keyin mijozlar botidagi file_id (qayta yuklamaslik uchun) */
  clientFileId?: string;
}

export type BroadcastStatus = 'pending' | 'running' | 'done' | 'cancelled';

export interface Broadcast {
  id: number;
  created_by: number;
  content: BroadcastContent;
  status: BroadcastStatus;
  total: number;
  sent: number;
  failed: number;
  blocked: number;
  last_client_id: number;
  locked_until: Date | null;
  progress_chat_id: number | null;
  progress_msg_id: number | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

/** Botni bloklamagan barcha mijozlar soni. */
export async function countBroadcastRecipients(): Promise<number> {
  const rows = await db()<{ n: number }[]>`select count(*)::int as n from clients where not bot_blocked`;
  return rows[0]?.n ?? 0;
}

export async function createBroadcast(createdBy: number, content: BroadcastContent): Promise<Broadcast> {
  const sql = db();
  const rows = await sql<Broadcast[]>`
    insert into broadcasts (created_by, content, total)
    values (${createdBy}, ${sql.json(content as never)}, (select count(*)::int from clients where not bot_blocked))
    returning *`;
  return rows[0]!;
}

export async function getBroadcast(id: number): Promise<Broadcast | null> {
  if (!Number.isSafeInteger(id)) return null;
  const rows = await db()<Broadcast[]>`select * from broadcasts where id = ${id}`;
  return rows[0] ?? null;
}

export async function setBroadcastProgressMessage(id: number, chatId: number, msgId: number): Promise<void> {
  await db()`update broadcasts set progress_chat_id = ${chatId}, progress_msg_id = ${msgId} where id = ${id}`;
}

/** To'xtatish (hali tugamagan bo'lsa). */
export async function cancelBroadcast(id: number): Promise<Broadcast | null> {
  const rows = await db()<Broadcast[]>`
    update broadcasts set status = 'cancelled', finished_at = now(), locked_until = null
    where id = ${id} and status in ('pending', 'running')
    returning *`;
  return rows[0] ?? getBroadcast(id);
}

/** Ishlov to'xtab qolganmi (running, lekin qulf muddati o'tgan) — «Davom ettirish» tugmasi uchun. */
export function isStalled(b: Broadcast): boolean {
  return (b.status === 'running' || b.status === 'pending') && (!b.locked_until || b.locked_until.getTime() < Date.now());
}

/** Jarayon xabari (HTML) va tugmalar. */
export function renderBroadcastProgress(b: Broadcast): { text: string; markup?: InlineKeyboard } {
  const done = b.sent + b.failed + b.blocked;
  const head =
    b.status === 'done'
      ? `✅ <b>Ommaviy xabar #${b.id} yakunlandi</b>`
      : b.status === 'cancelled'
        ? `✖️ <b>Ommaviy xabar #${b.id} to'xtatildi</b>`
        : `📤 <b>Ommaviy xabar #${b.id} yuborilmoqda…</b>`;
  const text =
    `${head}\n\n` +
    `👥 Jami: ${b.total}\n` +
    `📨 Ishlandi: ${Math.min(done, Math.max(b.total, done))}\n` +
    `✅ Yetkazildi: ${b.sent}\n` +
    `⛔ Botni bloklagan: ${b.blocked}\n` +
    `⚠️ Xato: ${b.failed}`;
  if (b.status === 'done' || b.status === 'cancelled') return { text };
  const kb = new InlineKeyboard();
  if (isStalled(b)) kb.text('▶️ Davom ettirish', `bc:go:${b.id}`);
  kb.text('🔄 Yangilash', `bc:r:${b.id}`).row().text("✖️ To'xtatish", `bc:x:${b.id}`);
  return { text, markup: kb };
}

/**
 * Qulfni olish. `locked_until` millisekundgacha qirqiladi: u shu ishlovchining "egalik belgisi" bo'lib xizmat qiladi
 * (JS Date millisekund aniqlikda — bazaga aynan shu qiymat qaytib boradi; bo'shatish faqat o'z qulfini bo'shatadi).
 */
async function claim(id: number, holdMs: number): Promise<Broadcast | null> {
  const rows = await db()<Broadcast[]>`
    update broadcasts set status = 'running', started_at = coalesce(started_at, now()),
      locked_until = date_trunc('milliseconds', now() + make_interval(secs => ${Math.ceil(holdMs / 1000)}))
    where id = ${id} and status in ('pending', 'running')
      and (locked_until is null or locked_until < now())
    returning *`;
  return rows[0] ?? null;
}

async function updateProgressMessage(b: Broadcast): Promise<void> {
  const api = staffApi();
  if (!api || !b.progress_chat_id || !b.progress_msg_id) return;
  const view = renderBroadcastProgress(b);
  try {
    await api.editMessageText(b.progress_chat_id, b.progress_msg_id, view.text, {
      parse_mode: 'HTML',
      ...(view.markup ? { reply_markup: view.markup } : {}),
    });
  } catch (e) {
    if (!/message is not modified/i.test(tgErrorDescription(e))) {
      console.warn(`[broadcast] #${b.id} jarayon xabarini yangilab bo'lmadi:`, tgErrorDescription(e));
    }
  }
}

function toContent(c: BroadcastContent): { content: Content; source: 'client' | 'staff' } {
  const base: Content = {
    kind: c.kind,
    text: c.text,
    entities: c.entities,
    fileUniqueId: c.fileUniqueId,
    fileName: c.fileName,
    mimeType: c.mimeType,
    fileSize: c.fileSize,
    meta: c.meta,
  };
  if (c.kind === 'text') return { content: base, source: 'client' };
  if (c.clientFileId) return { content: { ...base, fileId: c.clientFileId }, source: 'client' };
  return { content: { ...base, fileId: c.fileId }, source: 'staff' };
}

export interface RunResult {
  broadcast: Broadcast | null;
  /** true — hammasi yuborildi yoki to'xtatildi */
  finished: boolean;
  /** false — boshqa ishlovchi band (qulf) yoki shu ishlovchining qulfini boshqasi egallab olgan */
  claimed: boolean;
  /** Shu ishlovda kursor oldinga siljidimi (kamida bitta mijoz ishlandi). */
  progressed?: boolean;
  /**
   * Telegram 429 (retry_after) bo'lak ichida kutib bo'lmadi: keyingi bo'lak shu vaqtdan (epoch ms) oldin
   * boshlanmasin. Qulf shu vaqtgacha ushlab turiladi — hech kim (jumladan «▶️ Davom ettirish») flood paytida yubormaydi.
   */
  retryAt?: number;
}

/** Telegram xatosidagi retry_after (soniya). */
function retryAfterOf(e: unknown): number | undefined {
  const n = Number((e as { parameters?: { retry_after?: unknown } } | null)?.parameters?.retry_after);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Bir bo'lak: `budgetMs` ichida imkon qadar ko'p mijozga yuborish. Takroriy yuborishdan himoya: kursor har bir
 * yuborishdan keyin saqlanadi, bir vaqtda faqat bitta ishlovchi (qulf; bo'shatish faqat o'z qulfini bo'shatadi).
 */
export async function runBroadcast(id: number, opts: { budgetMs: number }): Promise<RunResult> {
  const started = Date.now();
  const deadline = started + Math.max(opts.budgetMs, 3_000);
  const claimed = await claim(id, opts.budgetMs + 15_000);
  if (!claimed) {
    const cur = await getBroadcast(id);
    return { broadcast: cur, claimed: false, finished: !cur || cur.status === 'done' || cur.status === 'cancelled' };
  }
  const myLock = claimed.locked_until;
  const startCursor = claimed.last_client_id;
  let b: Broadcast = claimed;
  const sql = db();
  let lastProgressAt = Date.now();
  let sinceCheck = 0;
  /** Bo'lak ichida kutib bo'lmagan Telegram 429 ning retry_after (soniya). */
  let floodSec: number | undefined;
  /** Mijozlar botida yuklangan fayl file_id si (saqlab bo'lmasa ham shu ishlovda qayta yuklamaslik uchun). */
  let clientFileId = b.content.clientFileId;

  outer: while (Date.now() < deadline - 2_500) {
    const batch: { tg_user_id: number }[] = await sql<{ tg_user_id: number }[]>`
      select tg_user_id from clients
      where tg_user_id > ${b.last_client_id} and not bot_blocked
      order by tg_user_id limit 50`;
    if (!batch.length) {
      const rows: Broadcast[] = await sql<Broadcast[]>`
        update broadcasts set status = 'done', finished_at = now(), locked_until = null
        where id = ${id} and status = 'running' returning *`;
      b = rows[0] ?? (await getBroadcast(id)) ?? b;
      break;
    }
    for (const { tg_user_id: chatId } of batch) {
      if (Date.now() >= deadline - 2_500) break outer;
      // Har 25 ta xabarda to'xtatilganmi tekshiramiz
      if (++sinceCheck >= 25) {
        sinceCheck = 0;
        const cur = await getBroadcast(id);
        if (!cur || cur.status === 'cancelled') {
          b = cur ?? b;
          break outer;
        }
      }
      let outcome: 'sent' | 'blocked' | 'failed' = 'failed';
      const { content, source } = toContent(clientFileId ? { ...b.content, clientFileId } : b.content);
      let sentFileId: string | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          // Faqat yuborishning o'zi try ichida: keyingi baza xatosi yetkazilgan xabarni "xato" deb sanamasin
          const res = await sendContent('client', chatId, content, source);
          outcome = 'sent';
          if (source === 'staff') sentFileId = res.fileId;
          break;
        } catch (e) {
          const code = tgErrorCode(e);
          if (code === 403) {
            outcome = 'blocked';
            await setClientBlocked(chatId, true).catch(() => {});
            break;
          }
          const retryAfter = retryAfterOf(e);
          if (code === 429 && attempt === 0 && retryAfter && Date.now() + retryAfter * 1000 < deadline - 3_000) {
            await sleep(retryAfter * 1000);
            continue;
          }
          if (code === 429) {
            // Vaqt yetmaydi — keyingi bo'lak retry_after o'tgach shu mijozdan davom etadi
            floodSec = retryAfter ?? 5;
            break outer;
          }
          console.warn(`[broadcast] #${id} → ${chatId}:`, tgErrorDescription(e));
          outcome = 'failed';
          break;
        }
      }
      if (sentFileId && !clientFileId) {
        // Mijozlar botidagi file_id ni saqlash (keyingi mijozlarga qayta yuklamaslik uchun). Xato — faqat log:
        // xabar yetkazilgan, u "xato" deb sanalmasin
        clientFileId = sentFileId;
        try {
          await sql`update broadcasts set content = ${sql.json({ ...b.content, clientFileId } as never)} where id = ${id}`;
        } catch (e) {
          console.warn(`[broadcast] #${id}: clientFileId saqlanmadi:`, tgErrorDescription(e));
        }
      }
      // Kursor compare-and-swap: qulf muddati o'tib ketib, shu oraliqda boshqa ishlovchi (masalan, «▶️ Davom
      // ettirish») ishga tushgan bo'lsa — u kursorni surgan: ikki marta yubormaslik uchun bu ishlovchi to'xtaydi
      // (qulfga ham, jarayon xabariga ham tegmaydi — ular endi o'sha ishlovchiniki)
      const prevCursor = b.last_client_id;
      const rows: Broadcast[] = await sql<Broadcast[]>`
        update broadcasts set last_client_id = ${chatId},
          sent = sent + ${outcome === 'sent' ? 1 : 0},
          blocked = blocked + ${outcome === 'blocked' ? 1 : 0},
          failed = failed + ${outcome === 'failed' ? 1 : 0}
        where id = ${id} and last_client_id = ${prevCursor} returning *`;
      if (!rows[0]) {
        console.warn(`[broadcast] #${id}: boshqa ishlovchi davom ettirmoqda — bu ishlovchi to'xtadi`);
        const cur = await getBroadcast(id);
        return {
          broadcast: cur ?? b,
          claimed: false,
          finished: !cur || cur.status === 'done' || cur.status === 'cancelled',
          progressed: true,
        };
      }
      b = rows[0];
      // «✖️ To'xtatish» bosilgan — keyingi mijozga yubormasdan darhol to'xtaymiz
      if (b.status === 'cancelled') break outer;
      if (Date.now() - lastProgressAt > 4_000) {
        lastProgressAt = Date.now();
        await updateProgressMessage(b);
      }
      await sleep(40);
    }
  }
  const progressed = b.last_client_id !== startCursor;

  if (b.status === 'done' || b.status === 'cancelled') {
    // Yakunlangan/to'xtatilgan: qulf allaqachon tozalangan ('done' yangilanishi, cancelBroadcast)
    await updateProgressMessage(b);
    return { broadcast: b, claimed: true, finished: true, progressed };
  }

  // Qulfni bo'shatish — faqat O'Z qulfimiz bo'lsa (qulf muddati o'tib, boshqa ishlovchi egallagan bo'lsa unga
  // tegmaymiz va davom ettirishni ham so'ramaymiz). Telegram 429: qulf flood tugaguncha ushlab turiladi — boshqa
  // ishlovchi (o'z-o'zini chaqirish yoki «▶️ Davom ettirish») flood paytida yubormasin; keyingi bo'lak retryAt da.
  const holdSec = floodSec ? Math.ceil(floodSec) + 1 : 0;
  const released = await sql<(Broadcast & { lock_left_ms: number | null })[]>`
    update broadcasts set locked_until = ${holdSec ? sql`now() + make_interval(secs => ${holdSec})` : null}
    where id = ${id} and locked_until = ${myLock}
    returning *, (extract(epoch from (locked_until - now())) * 1000)::float8 as lock_left_ms`;
  const row = released[0];
  if (!row) {
    const cur = await getBroadcast(id);
    console.warn(`[broadcast] #${id}: qulf boshqa ishlovchida (yoki to'xtatilgan) — bu ishlovchi davom ettirmaydi`);
    return {
      broadcast: cur ?? b,
      claimed: false,
      finished: !cur || cur.status === 'done' || cur.status === 'cancelled',
      progressed,
    };
  }
  const { lock_left_ms: lockLeftMs, ...rest } = row;
  b = rest as Broadcast;
  await updateProgressMessage(b);
  const finished = b.status === 'done' || b.status === 'cancelled';
  const retryAt = holdSec ? Date.now() + Math.max(0, Number(lockLeftMs) || holdSec * 1000) + 1_000 : undefined;
  if (holdSec) console.warn(`[broadcast] #${id}: Telegram 429 (retry_after ${floodSec}) — davomi ${holdSec} s dan keyin`);
  return { broadcast: b, claimed: true, finished, progressed, ...(retryAt ? { retryAt } : {}) };
}

/** /api/broadcast uchun maxfiy kalit (WEBHOOK_SECRET dan hosil qilinadi). */
export function broadcastKey(): string {
  return createHmac('sha256', config.webhookSecret).update('broadcast-continue').digest('base64url');
}

/** /api/broadcast so'rovi: `notBefore` (epoch ms) gacha boshlanmaydi; `hop` — zanjirdagi tartib raqami;
 * `stalled` — ketma-ket kursor siljimagan bo'laklar soni (cheklovdan oshsa zanjir to'xtaydi). */
export interface BroadcastContinue {
  notBefore?: number;
  hop?: number;
  stalled?: number;
}

/**
 * Keyingi bo'lakni alohida funksiya chaqiruvida boshlash (o'z-o'zini chaqirish). So'rov yuboriladi va javob
 * kutilmaydi; xato bo'lsa jim — ROP «▶️ Davom ettirish» tugmasi bilan davom ettira oladi.
 */
export async function continueBroadcastInBackground(id: number, opts: BroadcastContinue = {}): Promise<void> {
  try {
    const base = await getAppUrl();
    if (!/^https:\/\//.test(base)) return;
    const body: { id: number } & BroadcastContinue = { id };
    if (opts.notBefore && Number.isFinite(opts.notBefore)) body.notBefore = Math.ceil(opts.notBefore);
    if (opts.hop) body.hop = opts.hop;
    if (opts.stalled) body.stalled = opts.stalled;
    await fetch(`${base}/api/broadcast`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-broadcast-key': broadcastKey() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2_500),
    }).catch(() => {});
  } catch {
    /* e'tiborsiz */
  }
}

/** Ommaviy xabar oldindan ko'rinishi uchun qisqa tavsif (HTML). */
export function describeBroadcastContent(c: BroadcastContent): string {
  const kinds: Partial<Record<MsgKind, string>> = {
    text: '📝 Matn',
    photo: '📷 Rasm',
    video: '🎬 Video',
    animation: '🎞 GIF',
    document: '📎 Fayl',
    audio: '🎵 Audio',
    voice: '🎤 Ovozli xabar',
  };
  const label = kinds[c.kind] ?? '📎';
  const t = (c.text ?? '').trim();
  return t ? `${label}: ${esc(t.length > 200 ? t.slice(0, 200) + '…' : t)}` : label;
}

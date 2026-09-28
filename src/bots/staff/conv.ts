// Xodimlar boti: suhbatni aniqlash (Reply, tugmalar, aktiv suhbat) va maxfiylik tekshiruvlari.
// staff.ts va admin.ts ikkalasi ham ishlatadi (aylanma importdan qochish uchun alohida fayl).
import type { Message as TgMessage } from 'grammy/types';
import { db } from '../../db.js';
import { findConversationByStaffReply, getConversation, getConversationView, setStaffActiveConversation } from '../../repo.js';
import type { Conversation, ConversationView, Staff } from '../../types.js';
import { clientName } from '../../util.js';

/** `staff.active_set_at` — xodim suhbatni aniq tanlagan (aktiv qilgan) vaqt (setStaffActiveConversation yozadi). */
export function activeSetAt(me: Staff): Date | null {
  const v: Date | string | null | undefined = me.active_set_at;
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Konversatsiya faqat shu xodimga tegishli bo'lsa qaytadi (maxfiylik). */
export async function ownConversationView(me: Staff, id: number | null): Promise<ConversationView | null> {
  if (!id) return null;
  const v = await getConversationView(id);
  return v && v.staff_id === me.id ? v : null;
}

export function clientNameOf(v: Pick<ConversationView, 'client_first_name' | 'client_last_name'>): string {
  return clientName({ first_name: v.client_first_name, last_name: v.client_last_name });
}

/**
 * Faqat BITTA suhbatga tegishli bot xabarlaridagi tugmalar (transkript, «Mijoz haqida», «Aktiv suhbat» xabarlari,
 * mijoz xabari ostidagi «↩️ Javob berish»). Chatlar ro'yxati (`open:`), sahifalar (`chats:`), ro'yxatdagi
 * `deact:<id>:<sahifa>` va «Bu xabar kimga?» (`to:`) so'rovlari ataylab kirmaydi — ular bir nechta suhbatni ko'rsatadi.
 */
const CONV_BUTTON_RE = /^(?:act|cinfo|deact):(\d{1,15})$|^shist:(\d{1,15}):\d{1,15}$/;
/**
 * Bitta SAQLANGAN xabarga tegishli tugmalar — «🔁 Qayta yuborish» (`retry:<messageId>`) bildirishnomasi.
 * Suhbat shu xabar orqali aniqlanadi (egalik tekshiriladi).
 */
const MSG_BUTTON_RE = /^retry:(\d{1,15})$/;

function positiveId(s: string | undefined): number | null {
  const n = Number(s);
  return s && Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Bot xabarining tugmalaridagi havolalar: suhbatlar va saqlangan xabarlar id lari. */
export interface BotMessageRefs {
  conversationIds: number[];
  messageIds: number[];
}

/**
 * Botning o'z xabari qaysi suhbatga tegishli ekanini aniqlash uchun uning inline tugmalaridagi havolalar.
 * Tugmalarni bot o'zi yaratgan (Telegram ularni o'zgartirishga yo'l qo'ymaydi); baribir egalik alohida tekshiriladi.
 * Bot xabari bo'lmasa yoki mos tugma yo'q bo'lsa — null.
 */
export function botMessageRefs(msg: TgMessage | undefined, botId: number): BotMessageRefs | null {
  if (!msg || msg.from?.id !== botId) return null;
  const conversationIds = new Set<number>();
  const messageIds = new Set<number>();
  for (const row of msg.reply_markup?.inline_keyboard ?? []) {
    for (const b of row) {
      const data = 'callback_data' in b ? b.callback_data : undefined;
      if (!data) continue;
      const c = CONV_BUTTON_RE.exec(data);
      const cid = c ? positiveId(c[1] ?? c[2]) : null;
      if (cid) conversationIds.add(cid);
      const m = MSG_BUTTON_RE.exec(data);
      const mid = m ? positiveId(m[1]) : null;
      if (mid) messageIds.add(mid);
    }
  }
  if (!conversationIds.size && !messageIds.size) return null;
  return { conversationIds: [...conversationIds], messageIds: [...messageIds] };
}

/** Saqlangan xabar qaysi suhbatga tegishli — faqat shu xodimning suhbati bo'lsa (maxfiylik). */
async function ownMessageConversationId(staffId: number, messageId: number): Promise<number | null> {
  const rows = await db()<{ conversation_id: number }[]>`
    select m.conversation_id from messages m join conversations c on c.id = m.conversation_id
    where m.id = ${messageId} and c.staff_id = ${staffId}`;
  return rows[0]?.conversation_id ?? null;
}

/**
 * Xodim Reply qilgan xabardan suhbatni aniqlash (faqat shu xodimning suhbati):
 *  1) yetkazilgan xabarlar xaritasi — mijoz xabari (sarlavhasi, bo'laklari ham) yoki xodimning o'z xabari;
 *  2) botning bitta suhbatga bog'langan xabarlari — tugmalari orqali (transkript, «Mijoz haqida», «Aktiv suhbat»,
 *     «🔁 Qayta yuborish» bildirishnomasi).
 * Topilmasa, tugmalar turli suhbatlarni ko'rsatsa yoki birortasi begona bo'lsa — null: chaqiruvchi hech qachon
 * "aktiv suhbat"ga taxminan yubormasligi kerak.
 */
export async function resolveReplyConversation(
  me: Staff,
  chatId: number,
  botId: number,
  replyTo: TgMessage,
): Promise<Conversation | null> {
  const mapped = await findConversationByStaffReply(me.id, chatId, replyTo.message_id);
  if (mapped) return mapped;
  const refs = botMessageRefs(replyTo, botId);
  if (!refs) return null;
  const ids = new Set(refs.conversationIds);
  for (const messageId of refs.messageIds) {
    const cid = await ownMessageConversationId(me.id, messageId);
    if (!cid) return null; // begona yoki o'chirilgan xabar — taxmin qilinmaydi
    ids.add(cid);
  }
  if (ids.size !== 1) return null;
  const [id] = [...ids];
  const c = id ? await getConversation(id) : null;
  return c && c.staff_id === me.id ? c : null;
}

/** Xodimning aktiv suhbati (egalik tekshirilgan). Yaroqsiz bo'lib qolgan aktiv suhbat tozalanadi. */
export async function ownActiveConversation(me: Staff): Promise<ConversationView | null> {
  if (!me.active_conversation_id) return null;
  const v = await ownConversationView(me, me.active_conversation_id);
  if (!v) await setStaffActiveConversation(me.id, null);
  return v;
}

/** Aktiv suhbatni yopish — faqat u hali ham shu suhbat bo'lsa (eski tugma yangi aktiv suhbatni yopmasin). */
export async function clearActiveIf(staffId: number, conversationId: number): Promise<boolean> {
  const rows = await db()`
    update staff set active_conversation_id = null, active_set_at = null
    where id = ${staffId} and active_conversation_id = ${conversationId}
    returning id`;
  return rows.length > 0;
}

export interface RecipientCandidate {
  id: number;
  name: string;
  preview: string | null;
  unread: number;
}

function toCandidate(r: {
  id: number;
  client_first_name: string;
  client_last_name: string | null;
  last_message_preview: string | null;
  unread_staff: number;
}): RecipientCandidate {
  return { id: r.id, name: clientNameOf(r), preview: r.last_message_preview, unread: r.unread_staff };
}

/**
 * Aktiv suhbat bilan oxirgi muloqotdan (xodimning oxirgi xabari yoki suhbatni aniq tanlagan payti) KEYIN
 * yozgan va hali javob olmagan boshqa mijozlar. Bo'lsa — Reply'siz xabar kimga ekanini taxmin qilmaymiz.
 */
export async function newerWaitingConversations(me: Staff, activeId: number, limit = 4): Promise<RecipientCandidate[]> {
  const sql = db();
  const setAt = activeSetAt(me);
  const rows = await sql<
    {
      id: number;
      client_first_name: string;
      client_last_name: string | null;
      last_message_preview: string | null;
      unread_staff: number;
    }[]
  >`
    with anchor as (
      select coalesce(max(id), 0) as id, max(created_at) as last_at
      from messages where conversation_id = ${activeId} and sender = 'staff'
    )
    select c.id, cl.first_name as client_first_name, cl.last_name as client_last_name,
           c.last_message_preview, c.unread_staff
    from conversations c
    join clients cl on cl.tg_user_id = c.client_id
    cross join anchor a
    where c.staff_id = ${me.id} and c.id <> ${activeId} and c.last_sender = 'client'
      and c.last_message_at >= coalesce(a.last_at, '-infinity'::timestamptz)
      ${setAt ? sql`and c.last_message_at > ${setAt}` : sql``}
      and exists (
        select 1 from messages m
        where m.conversation_id = c.id and m.sender = 'client' and m.id > a.id
          ${setAt ? sql`and m.created_at > ${setAt}` : sql``}
      )
    order by c.last_message_at desc, c.id desc
    limit ${limit}`;
  return rows.map(toCandidate);
}

/** Oxirgi suhbatlar (tanlash tugmalari uchun). */
export async function recentCandidates(me: Staff, limit = 5): Promise<RecipientCandidate[]> {
  const rows = await db()<
    {
      id: number;
      client_first_name: string;
      client_last_name: string | null;
      last_message_preview: string | null;
      unread_staff: number;
    }[]
  >`
    select c.id, cl.first_name as client_first_name, cl.last_name as client_last_name,
           c.last_message_preview, c.unread_staff
    from conversations c
    join clients cl on cl.tg_user_id = c.client_id
    where c.staff_id = ${me.id} and c.last_message_at is not null
    order by c.last_message_at desc, c.id desc
    limit ${limit}`;
  return rows.map(toCandidate);
}

export function candidateOf(v: ConversationView): RecipientCandidate {
  return toCandidate(v);
}

/** Xodimning shu chatdagi xabari allaqachon mijozga yuborilganmi (saqlangan yozuv). */
export async function relayedStaffMessageExists(staffId: number, chatId: number, msgId: number): Promise<boolean> {
  const rows = await db()`
    select 1 from messages m join conversations c on c.id = m.conversation_id
    where m.sender = 'staff' and m.staff_chat_id = ${chatId} and m.staff_chat_msg_id = ${msgId}
      and c.staff_id = ${staffId}
    limit 1`;
  return rows.length > 0;
}

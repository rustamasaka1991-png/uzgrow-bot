// Mijoz xabarlarini yo'naltirish yordamchilari:
// - "saqlangan" (hali xodim tanlanmagan) xabarlar — user_state('client') da, tanlov bilan birga yuboriladi;
// - mijoz chatida oxirgi ko'rsatilgan xabar qaysi suhbatga tegishli (xabar boshqa xodimga ketayotganini aytish uchun);
// - xabarlarni ketma-ket xodimga yetkazish (relayClientMessage orqali).
import type { Message as TgMessage } from 'grammy/types';
import { db } from '../../db.js';
import { relayClientMessage, relayErrorText, type RelayResult } from '../../relay.js';
import { getStaff } from '../../repo.js';
import { clientApi } from '../../tg.js';
import type { Client, Content, Conversation, Message, Staff } from '../../types.js';
import { esc, tgErrorDescription } from '../../util.js';
import { heldSentLine, staffName } from './ui.js';

// ───────────────────────────── Saqlangan xabarlar ─────────────────────────────

/** Saqlangan xabar necha vaqt "yangi" hisoblanadi (keyin tanlov bilan yuborilmaydi). */
export const HELD_TTL_MS = 30 * 60 * 1000;
/** Bir vaqtda saqlanadigan xabarlar soni (albom — 10 tagacha). */
export const HELD_MAX = 20;

export interface HeldItem {
  content: Content;
  /** Mijoz chatidagi asl xabar id si (Reply orqali yo'naltirish shu bilan ishlaydi). */
  msgId: number;
  /** Saqlangan vaqt (ms). */
  at: number;
  /** Albom (media group) id si — albomning har bir qismiga alohida javob yozmaslik uchun. */
  group?: string;
  /**
   * Mijoz Reply qilgan (o'z chatidagi) xabar — faqat Reply orqali suhbat aniqlanganda: xodimda o'sha xabar
   * iqtibos sifatida ko'rinadi (Telegramdagidek).
   */
  replyTo?: number;
}

/** user_state('client') ko'rinishi. */
interface ClientState {
  /** Xodim tanlanishini kutayotgan xabarlar (eskisi birinchi). */
  held?: HeldItem[];
  /** Botda aniq tanlangan suhbat (vaqti — user_state.updated_at). */
  sel?: number;
}

export function heldItemFrom(msg: TgMessage, content: Content): HeldItem {
  return {
    content,
    msgId: msg.message_id,
    at: Date.now(),
    ...(msg.media_group_id ? { group: msg.media_group_id } : {}),
  };
}

function isHeldItem(x: unknown): x is HeldItem {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  const c = r.content as Record<string, unknown> | null | undefined;
  return (
    typeof r.msgId === 'number' &&
    typeof r.at === 'number' &&
    !!c &&
    typeof c === 'object' &&
    typeof c.kind === 'string'
  );
}

function heldOf(state: unknown): HeldItem[] {
  const raw = (state as ClientState | null)?.held;
  return Array.isArray(raw) ? raw.filter(isHeldItem) : [];
}

function freshHeld(items: HeldItem[]): HeldItem[] {
  const since = Date.now() - HELD_TTL_MS;
  return items.filter((it) => it.at > since);
}

export interface HoldResult {
  /** Xabar(lar) saqlandimi (limit to'lgan bo'lsa — yo'q). */
  saved: boolean;
  /** Saqlangan xabarlarning umumiy soni (shu xabarlar bilan). */
  count: number;
  /** Yangi qo'shilganlardan oldingi xabar (albom qismimi — tekshirish uchun). */
  prev?: HeldItem;
}

/**
 * Xabar(lar)ni tanlov kutayotganlar ro'yxatiga atomik qo'shish.
 * 30 daqiqadan eski ro'yxat yangisi bilan almashtiriladi; limitdan oshsa hech narsa qo'shilmaydi.
 */
export async function holdMessages(clientId: number, items: HeldItem[]): Promise<HoldResult> {
  if (!items.length) return { saved: false, count: 0 };
  const sql = db();
  const rows = await sql<{ state: unknown }[]>`
    insert into user_state as us (bot, tg_user_id, state, updated_at)
    values ('client', ${clientId}, ${sql.json({ held: items } as never)}, now())
    on conflict (bot, tg_user_id) do update set
      state = case
        when us.updated_at <= now() - interval '30 minutes'
          or jsonb_typeof(us.state -> 'held') is distinct from 'array'
          then excluded.state
        when jsonb_array_length(us.state -> 'held') + ${items.length} > ${HELD_MAX}
          then us.state
        else jsonb_set(us.state, '{held}', (us.state -> 'held') || (excluded.state -> 'held'))
      end,
      updated_at = now()
    returning state`;
  const all = heldOf(rows[0]?.state);
  const lastId = items[items.length - 1]!.msgId;
  const saved = all.length >= items.length && all[all.length - 1]!.msgId === lastId;
  if (!saved) return { saved: false, count: all.length };
  return { saved: true, count: all.length, prev: all[all.length - items.length - 1] };
}

/**
 * Saqlangan xabarlarni atomik olib qo'yish (ikki marta yuborilmasligi uchun).
 * selectedConvId berilsa — botda aniq tanlangan suhbat sifatida belgilanadi.
 */
export async function takeHeld(clientId: number, selectedConvId: number | null): Promise<HeldItem[]> {
  const sql = db();
  // DELETE ... RETURNING atomik: bir vaqtda kelgan ikki chaqiruvdan faqat bittasi ro'yxatni oladi
  const rows = await sql<{ state: unknown; fresh: boolean }[]>`
    delete from user_state where bot = 'client' and tg_user_id = ${clientId}
    returning state, (updated_at > now() - interval '30 minutes') as fresh`;
  if (selectedConvId != null) {
    // Oraliqda saqlangan xabar bo'lsa (juda kam holat) — u yo'qolmaydi: kalitlar birlashtiriladi
    await sql`
      insert into user_state (bot, tg_user_id, state, updated_at)
      values ('client', ${clientId}, ${sql.json({ sel: selectedConvId } as never)}, now())
      on conflict (bot, tg_user_id) do update set state = user_state.state || excluded.state, updated_at = now()`;
  }
  const r = rows[0];
  return r && r.fresh ? freshHeld(heldOf(r.state)) : [];
}

/**
 * Tanlov belgisini o'chirish: mijoz shu suhbatga yozgach, chatdagi oxirgi xabar shu suhbatniki bo'ladi va belgi
 * endi kerak emas. Faqat aynan shu belgi bo'lsa o'chiriladi (oraliqda saqlangan xabar yoki yangi tanlov qoladi).
 */
export async function clearSelection(clientId: number, selectedConvId: number): Promise<void> {
  const sql = db();
  await sql`
    delete from user_state
    where bot = 'client' and tg_user_id = ${clientId} and state = ${sql.json({ sel: selectedConvId } as never)}`;
}

// ───────────────────────────── Botning o'z xabaridan suhbatni aniqlash ─────────────────────────────

/**
 * Faqat BITTA suhbatga yoki xodimga tegishli bot xabarlaridagi tugmalar: xodim xabari ostidagi «↩️ Javob berish»
 * va «↩️ … ga yozish» (`to:`), transkript sahifalari (`hist:`), xodim kartasi (`pick:` / `nav:`).
 * Ro'yxatlar (`conv:`, `card:`, `ls:`) ataylab kirmaydi — ular bir nechta nomzodni ko'rsatadi.
 */
const CONV_BUTTON_RE = /^to:(\d{1,15})$|^hist:(\d{1,15}):\d{1,15}$/;
const STAFF_BUTTON_RE = /^pick:(\d{1,15})$|^nav:(\d{1,15}):(?:prev|next)$/;

export type BotMessageTarget = { conversationId: number } | { staffId: number };

/**
 * Mijoz Reply qilgan BOT xabari (transkript, xodim kartasi, bildirishnoma...) qaysi suhbatga/xodimga tegishli
 * ekanini uning inline tugmalaridan aniqlash. Aniq bitta nomzod bo'lmasa — null (taxmin qilinmaydi).
 * Tugmalarni bot o'zi yaratgan; egalik va xodim mavjudligi chaqiruvchida alohida tekshiriladi.
 */
export function targetFromBotMessage(msg: TgMessage | undefined, botId: number): BotMessageTarget | null {
  if (!msg || msg.from?.id !== botId) return null;
  const convIds = new Set<number>();
  const staffIds = new Set<number>();
  for (const row of msg.reply_markup?.inline_keyboard ?? []) {
    for (const b of row) {
      const data = 'callback_data' in b ? b.callback_data : undefined;
      if (!data) continue;
      const c = CONV_BUTTON_RE.exec(data);
      if (c) convIds.add(Number(c[1] ?? c[2]));
      const s = STAFF_BUTTON_RE.exec(data);
      if (s) staffIds.add(Number(s[1] ?? s[2]));
    }
  }
  const valid = (n: number | undefined): n is number => n !== undefined && Number.isSafeInteger(n) && n > 0;
  if (convIds.size === 1 && staffIds.size === 0) {
    const [id] = [...convIds];
    return valid(id) ? { conversationId: id } : null;
  }
  if (staffIds.size === 1 && convIds.size === 0) {
    const [id] = [...staffIds];
    return valid(id) ? { staffId: id } : null;
  }
  return null;
}

// ───────────────────────────── Yo'naltirish konteksti ─────────────────────────────

export interface RouteInfo {
  /** Mijoz chatida oxirgi ko'rsatilgan (bazada saqlangan) xabarning suhbati. */
  lastConvId: number | null;
  lastAt: Date | null;
  /** Yuborilishi kutilayotgan saqlangan xabarlar bormi. */
  hasHeld: boolean;
  /** Botda oxirgi marta aniq tanlangan suhbat va vaqti. */
  selConvId: number | null;
  selAt: Date | null;
}

/** Bitta so'rovda: oxirgi ko'rsatilgan xabar suhbati + mijoz holati (saqlangan xabarlar, tanlov). */
export async function loadRouteInfo(clientId: number): Promise<RouteInfo> {
  const sql = db();
  const rows = await sql<
    { last_conv_id: number | null; last_at: Date | null; state: unknown; state_at: Date | null; fresh: boolean | null }[]
  >`
    select ls.conversation_id as last_conv_id, ls.created_at as last_at,
      st.state, st.updated_at as state_at, (st.updated_at > now() - interval '30 minutes') as fresh
    from (select 1) as one
    left join lateral (
      select x.conversation_id, x.created_at
      from conversations c
      cross join lateral (
        select m.id, m.conversation_id, m.created_at from messages m
        where m.conversation_id = c.id and m.client_chat_msg_id is not null
        order by m.id desc
        limit 1
      ) x
      where c.client_id = ${clientId}
      order by x.id desc
      limit 1
    ) ls on true
    left join user_state st
      on st.bot = 'client' and st.tg_user_id = ${clientId} and st.updated_at > now() - interval '1 day'`;
  const r = rows[0];
  const state = (r?.state ?? null) as ClientState | null;
  const sel = typeof state?.sel === 'number' ? state.sel : null;
  return {
    lastConvId: r?.last_conv_id ?? null,
    lastAt: r?.last_at ?? null,
    hasHeld: !!r?.fresh && freshHeld(heldOf(state)).length > 0,
    selConvId: sel,
    selAt: sel != null ? (r?.state_at ?? null) : null,
  };
}

/**
 * Xabar mijoz kutganidan boshqa xodimga ketyaptimi: chatdagi oxirgi xabar boshqa suhbatdan
 * va mijoz bu suhbatni o'shandan keyin botda aniq tanlamagan (masalan, Mini App da almashtirgan).
 */
export function isUnexpectedTarget(info: RouteInfo, convId: number): boolean {
  if (info.lastConvId == null || info.lastConvId === convId) return false;
  const selectedAfter =
    info.selConvId === convId && info.selAt != null && info.lastAt != null && info.selAt.getTime() >= info.lastAt.getTime();
  return !selectedAfter;
}

export interface RecentContact {
  conversationId: number;
  staff: Staff;
}

/** Mijoz oxirgi yozishgan xodimlar (xabari bor suhbatlar bo'yicha, eng yangisi birinchi). */
export async function recentContacts(clientId: number, limit = 10): Promise<RecentContact[]> {
  const rows = await db()<(Staff & { conv_id: number })[]>`
    select c.id as conv_id, s.* from conversations c join staff s on s.id = c.staff_id
    where c.client_id = ${clientId} and c.last_message_at is not null
    order by c.last_message_at desc, c.id desc
    limit ${limit}`;
  return rows.map(({ conv_id, ...staff }) => ({ conversationId: conv_id, staff: staff as Staff }));
}

/** Suhbatning xodimi (faqat shu mijozning suhbati bo'lsa). */
export async function conversationStaff(convId: number, clientId: number): Promise<Staff | null> {
  const rows = await db()<Staff[]>`
    select s.* from conversations c join staff s on s.id = c.staff_id
    where c.id = ${convId} and c.client_id = ${clientId}`;
  return rows[0] ?? null;
}

/**
 * Yetkazilmagan xabarlar "seriyasi"ning birinchisimi: shu suhbatdagi oldingi mijoz xabari
 * xodimga yetkazilgan (yoki umuman yo'q). Ogohlantirish har xabarda takrorlanmasligi uchun.
 */
async function isFirstUndelivered(message: Message): Promise<boolean> {
  const rows = await db()<{ staff_chat_msg_id: number | null }[]>`
    select staff_chat_msg_id from messages
    where conversation_id = ${message.conversation_id} and sender = 'client' and id < ${message.id}
    order by id desc
    limit 1`;
  return !rows[0] || rows[0].staff_chat_msg_id != null;
}

// ───────────────────────────── Ketma-ket yetkazish ─────────────────────────────

/** Xato matnini mijozga (asl xabariga javob sifatida) yuborish. */
export type ErrorReporter = (html: string, replyTo: number) => Promise<void>;

export interface QueueOutcome {
  /** Muvaffaqiyatli saqlangan/yuborilgan xabarlar soni. */
  sent: number;
  /** Muvaffaqiyatli yuborilgan xabarlarning mijoz chatidagi id lari. */
  sentMsgIds: number[];
  /** Saqlangan, lekin xodimga hozircha yetkazilmagan (va seriyada birinchi) xabar bo'ldimi. */
  undelivered: boolean;
  /** Xodim mavjud emas — to'xtatildi; `rest` — yuborilmay qolgan xabarlar. */
  unavailable: boolean;
  rest: HeldItem[];
}

/** relay natijasidagi yetkazilmaslik sababi (relay uni qaytarsa): 'transient' — vaqtinchalik xato. */
function undeliveredReason(result: RelayResult): string | undefined {
  const reason = (result as { undeliveredReason?: unknown }).undeliveredReason;
  return typeof reason === 'string' ? reason : undefined;
}

/**
 * Xabarlarni tartib bilan xodimga yetkazish. Birinchi xabarda avto-javob relay ichida yuboriladi (bir marta).
 * Xodim mavjud bo'lmay qolsa — to'xtaydi va qolganlarini qaytaradi. Boshqa xatolar xabarma-xabar aytiladi.
 */
export async function relayQueue(
  client: Client,
  conversation: Conversation,
  items: HeldItem[],
  reportError: ErrorReporter,
): Promise<QueueOutcome> {
  let conv = conversation;
  const sentMsgIds: number[] = [];
  let firstUndelivered: Message | null = null;
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const result = await relayClientMessage({
      client,
      conversation: conv,
      content: it.content,
      clientMsgId: it.msgId,
      via: 'bot',
      ...(it.replyTo ? { replyToClientMsgId: it.replyTo } : {}),
    });
    if (!result.ok) {
      if (result.error === 'staff_unavailable') {
        return {
          sent: sentMsgIds.length,
          sentMsgIds,
          undelivered: false,
          unavailable: true,
          rest: items.slice(i),
        };
      }
      await reportError(esc(relayErrorText(result.error)), it.msgId);
      continue;
    }
    sentMsgIds.push(it.msgId);
    // Keyingi xabar "birinchi" hisoblanmasligi uchun (🆕 belgisi) mahalliy nusxani yangilaymiz
    conv = { ...conv, last_message_at: result.message.created_at, last_sender: 'client' };
    if (!result.delivered && !firstUndelivered && undeliveredReason(result) !== 'transient') {
      firstUndelivered = result.message;
    }
  }
  let undelivered = false;
  if (firstUndelivered) {
    undelivered = await isFirstUndelivered(firstUndelivered).catch((e: unknown) => {
      console.warn('[client] isFirstUndelivered:', e);
      return false;
    });
  }
  return { sent: sentMsgIds.length, sentMsgIds, undelivered, unavailable: false, rest: [] };
}

// ───────────────────────────── Mini App uchun ─────────────────────────────

/**
 * Mini App da suhbat ochilganda (xodim tanlanganda): botda saqlangan xabarlarni shu xodimga yuborish
 * va natijani mijozning bot chatiga yozish. Yuborilgan xabarlar sonini qaytaradi.
 * Xodim mavjud emasligi chaqiruvchi tomonidan oldindan tekshirilgan bo'lishi kerak.
 */
export async function deliverHeldToConversation(client: Client, conversation: Conversation): Promise<number> {
  if (conversation.client_id !== client.tg_user_id) return 0;
  const items = await takeHeld(client.tg_user_id, null);
  if (!items.length) return 0;
  const send = async (html: string, replyTo?: number): Promise<void> => {
    try {
      await clientApi().sendMessage(client.tg_user_id, html, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
      });
    } catch (e) {
      console.warn('[client] saqlangan xabar natijasini yuborib bo\'lmadi:', tgErrorDescription(e));
    }
  };
  const out = await relayQueue(client, conversation, items, (html, replyTo) => send(html, replyTo));
  if (out.unavailable) {
    // Xodim shu orada mavjud bo'lmay qoldi — xabarlar keyingi tanlov uchun saqlanib qoladi
    await holdMessages(client.tg_user_id, out.rest).catch(() => undefined);
    return out.sent;
  }
  if (out.sent > 0) {
    const staff = await getStaff(conversation.staff_id);
    await send(heldSentLine(out.sent, staffName(staff)), items[0]!.msgId);
  }
  return out.sent;
}

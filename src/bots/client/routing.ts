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
  /** Shikoyat: joriy draftning so'rov xabari (✍️ … ustidan shikoyatingizni yozing) id si. */
  cmpMsg?: number;
  /** Shikoyat: shikoyat sifatida qabul qilingan albom (media group) — qolgan qismlari hech kimga yuborilmaydi. */
  cmpAlbum?: string;
  /** Shikoyatdan keyingi himoya: shikoyat qilingan xodimga ketayotgan xabarlar vaqtincha ushlanadi. */
  cmpGuard?: ComplaintGuard;
}

/**
 * Shikoyat yuborilgandan (yoki shikoyat oynasi yopilgandan) keyingi himoya: shu muddat ichida SHIKOYAT QILINGAN
 * xodimga ketayotgan xabarlar unga yuborilmaydi (Telegram bo'lib yuborgan uzun shikoyatning davomi, izohsiz isbot
 * rasmi, parallel kelgan xabar). Boshqa xodimlarga xabarlar odatdagidek ketadi.
 */
export interface ComplaintGuard {
  /** Yuborilgan shikoyat id si — matnli xabar shunga qo'shiladi; null — xabar faqat hech kimga yuborilmaydi. */
  id: number | null;
  /** Shikoyat qilingan xodim (staff.id). */
  staff: number;
  /** Amal qilish muddati (ms, epoch). */
  until: number;
  /**
   * Mijoz chatidagi xabar id si: shundan boshlab (mijoz izohni ko'rgandan keyin) yozilgan xabarlar ushlanmaydi.
   * Faqat id=null himoyada (parallel kelgan xabarlar uchun) qo'yiladi.
   */
  beforeMsg?: number;
}

function guardOf(state: unknown): ComplaintGuard | null {
  const g = (state as ClientState | null)?.cmpGuard as Record<string, unknown> | undefined;
  if (!g || typeof g !== 'object') return null;
  const staff = Number(g.staff);
  const until = Number(g.until);
  if (!Number.isSafeInteger(staff) || !Number.isFinite(until) || until <= Date.now()) return null;
  const id = g.id == null ? null : Number(g.id);
  const beforeMsg = g.beforeMsg == null ? undefined : Number(g.beforeMsg);
  return {
    id: id != null && Number.isSafeInteger(id) ? id : null,
    staff,
    until,
    ...(beforeMsg != null && Number.isSafeInteger(beforeMsg) ? { beforeMsg } : {}),
  };
}

/** Himoya shu xabarga (mijoz chatidagi id) va shu xodimga amal qiladimi. */
export function guardApplies(g: ComplaintGuard | null, staffId: number, msgId: number): g is ComplaintGuard {
  return !!g && g.staff === staffId && g.until > Date.now() && (g.beforeMsg == null || msgId < g.beforeMsg);
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
          -- shikoyat belgilari (cmpGuard / cmpMsg / cmpAlbum) saqlanadi
          then excluded.state || (us.state - 'held' - 'sel')
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
  // Amaldagi shikoyat himoyasi yo'qolmaydi (aks holda keyingi xabar shikoyat qilingan xodimning o'ziga ketardi)
  const guard = guardOf(rows[0]?.state);
  const keep: ClientState = {
    ...(selectedConvId != null ? { sel: selectedConvId } : {}),
    ...(guard ? { cmpGuard: guard } : {}),
  };
  if (Object.keys(keep).length) {
    // Oraliqda saqlangan xabar bo'lsa (juda kam holat) — u yo'qolmaydi: kalitlar birlashtiriladi
    await sql`
      insert into user_state (bot, tg_user_id, state, updated_at)
      values ('client', ${clientId}, ${sql.json(keep as never)}, now())
      on conflict (bot, tg_user_id) do update set state = user_state.state || excluded.state, updated_at = now()`;
  }
  const r = rows[0];
  return r && r.fresh ? freshHeld(heldOf(r.state)) : [];
}

/**
 * Tanlov belgisini o'chirish: mijoz shu suhbatga yozgach, chatdagi oxirgi xabar shu suhbatniki bo'ladi va belgi
 * endi kerak emas. Faqat aynan shu belgi bo'lsa o'chiriladi (oraliqda saqlangan xabar yoki yangi tanlov qoladi).
 * Shikoyat belgilari (cmpMsg/cmpAlbum) hisobga olinmaydi — ular vaqtinchalik va bu paytda draft yo'q.
 * Shikoyat himoyasi (cmpGuard) bo'lsa — yozuv o'chirilmaydi, faqat `sel` olib tashlanadi.
 */
export async function clearSelection(clientId: number, selectedConvId: number): Promise<void> {
  const sql = db();
  const onlySel = sql`(state - 'cmpMsg' - 'cmpAlbum' - 'cmpGuard') = ${sql.json({ sel: selectedConvId } as never)}`;
  await sql`
    with d as (
      delete from user_state
      where bot = 'client' and tg_user_id = ${clientId} and ${onlySel} and not (state ? 'cmpGuard')
      returning 1
    )
    update user_state set state = state - 'sel'
    where bot = 'client' and tg_user_id = ${clientId} and ${onlySel} and (state ? 'cmpGuard')`;
}

// ───────────────────────────── Shikoyat belgilari ─────────────────────────────

export interface ComplaintMarks {
  /** Joriy draftning so'rov xabari id si (mijoz chatida). */
  promptMsgId: number | null;
  /** Shikoyat sifatida qabul qilingan (yoki shikoyat draftida kelgan) oxirgi albom. */
  album: string | null;
}

export async function getComplaintMarks(clientId: number): Promise<ComplaintMarks> {
  const rows = await db()<{ state: unknown }[]>`
    select state from user_state where bot = 'client' and tg_user_id = ${clientId}`;
  const s = (rows[0]?.state ?? null) as ClientState | null;
  return {
    promptMsgId: typeof s?.cmpMsg === 'number' ? s.cmpMsg : null,
    album: typeof s?.cmpAlbum === 'string' ? s.cmpAlbum : null,
  };
}

/**
 * Holatga kalit(lar) qo'shish. updated_at ataylab yangilanmaydi — u `sel` (tanlov) vaqti va saqlangan xabarlar
 * muddati uchun ishlatiladi. Yangi yozuvda boshqa kalitlar yo'q, shuning uchun now() hech narsaga ta'sir qilmaydi.
 */
async function mergeClientState(clientId: number, patch: ClientState): Promise<void> {
  const sql = db();
  await sql`
    insert into user_state (bot, tg_user_id, state, updated_at)
    values ('client', ${clientId}, ${sql.json(patch as never)}, now())
    on conflict (bot, tg_user_id) do update set state = user_state.state || excluded.state`;
}

export function setComplaintPrompt(clientId: number, msgId: number): Promise<void> {
  return mergeClientState(clientId, { cmpMsg: msgId });
}

export function markComplaintAlbum(clientId: number, group: string): Promise<void> {
  return mergeClientState(clientId, { cmpAlbum: group });
}

/**
 * Shikoyat himoyasini (va albom belgisini) BITTA yozuvda qo'yish — draft o'chirilishidan / yuborilishidan OLDIN
 * chaqiriladi: parallel kelgan xabar draftni topmasa ham himoyani topadi.
 */
export function setComplaintGuard(clientId: number, guard: ComplaintGuard, album?: string): Promise<void> {
  return mergeClientState(clientId, { cmpGuard: guard, ...(album ? { cmpAlbum: album } : {}) });
}

/**
 * id=null himoyani mijoz chatidagi izoh xabari bilan chegaralash: izohdan keyin (uni o'qib) yozilgan xabarlar
 * odatdagidek ketadi. Faqat hali o'sha (id=null, shu xodim) himoya bo'lsa.
 */
export async function boundComplaintGuard(clientId: number, staffId: number, beforeMsg: number): Promise<void> {
  const sql = db();
  await sql`
    update user_state set state = jsonb_set(state, '{cmpGuard,beforeMsg}', to_jsonb(${beforeMsg}::bigint))
    where bot = 'client' and tg_user_id = ${clientId}
      and jsonb_typeof(state -> 'cmpGuard') = 'object'
      and (state -> 'cmpGuard' ->> 'staff') = ${String(staffId)}
      and coalesce(state -> 'cmpGuard' ->> 'id', '') = ''`;
}

/**
 * Shikoyat himoyasini olib tashlash — mijoz shu xodimga yozishni o'zi aniq tanladi (✍️ / ↩️ tugmasi, shaxsiy havola).
 * staffId berilsa — faqat o'sha xodim himoyasi.
 */
export async function clearComplaintGuard(clientId: number, staffId?: number): Promise<void> {
  const sql = db();
  await sql`
    update user_state set state = state - 'cmpGuard'
    where bot = 'client' and tg_user_id = ${clientId} and (state ? 'cmpGuard')
      ${staffId != null ? sql`and (state -> 'cmpGuard' ->> 'staff') = ${String(staffId)}` : sql``}`;
}

/**
 * Mijozda shikoyat drafti bormi (muddati o'tgani ham). Har bir kiruvchi xabarda chaqiriladi — odatdagi holatda
 * (draft yo'q) bitta yengil so'rov (complaints_client_draft_idx); muddatni getActiveDraft (src/complaints.ts) aniqlaydi.
 */
export async function hasComplaintDraft(clientId: number): Promise<boolean> {
  return (await complaintDraftAgeSec(clientId)) !== null;
}

/**
 * Mijozning eng yangi shikoyat draftining yoshi (soniya; muddati o'tgani ham), draft yo'q bo'lsa null. Odatdagi
 * holatda (draft yo'q) bitta yengil so'rov (complaints_client_draft_idx).
 */
export async function complaintDraftAgeSec(clientId: number): Promise<number | null> {
  return (await complaintDraftInfo(clientId))?.ageSec ?? null;
}

/** Eng yangi shikoyat draftining yoshi (soniya) va xodimi (muddati o'tgani ham); draft yo'q bo'lsa null. */
export async function complaintDraftInfo(clientId: number): Promise<{ ageSec: number; staffId: number } | null> {
  try {
    const rows = await db()<{ age: number | null; staff_id: number | null }[]>`
      select extract(epoch from (now() - created_at))::float8 as age, staff_id
      from complaints where client_id = ${clientId} and status = 'draft'
      order by created_at desc, id desc
      limit 1`;
    const r = rows[0];
    return r && r.age != null ? { ageSec: Math.max(0, Number(r.age)), staffId: Number(r.staff_id) } : null;
  } catch (e) {
    // Jadval hali yo'q (migratsiya qo'llanmagan) — demak draft ham yo'q: mijoz xabarlari to'xtab qolmasin
    if ((e as { code?: unknown } | null)?.code === '42P01') return null;
    throw e;
  }
}

/**
 * Shikoyat uchun: mijozning shu xodim bilan xabari bor suhbati (xodim hozir bloklangan/o'chirilgan bo'lsa ham).
 * Bunday suhbat bo'lmasa null (begona xodim ustidan shikoyat yo'q).
 */
export async function complaintTarget(
  clientId: number,
  staffId: number,
): Promise<{ conversationId: number; staffFullName: string } | null> {
  if (!Number.isSafeInteger(staffId) || staffId <= 0) return null;
  const rows = await db()<{ conv_id: number; full_name: string }[]>`
    select c.id as conv_id, s.full_name from conversations c join staff s on s.id = c.staff_id
    where c.client_id = ${clientId} and c.staff_id = ${staffId} and c.last_message_at is not null
    limit 1`;
  const r = rows[0];
  return r ? { conversationId: Number(r.conv_id), staffFullName: r.full_name } : null;
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

/** Bot xabarida tugma yo'q yoki faqat rol tanlash (`ls:`) tugmalari bor — ular hech bir xodimga ishora qilmaydi. */
function hasOnlyRoleButtons(msg: TgMessage): boolean {
  for (const row of msg.reply_markup?.inline_keyboard ?? []) {
    for (const b of row) {
      const data = 'callback_data' in b ? b.callback_data : undefined;
      if (data === undefined || !/^ls:(?:operator|manager)(?::\d{1,4})?$/.test(data)) return false;
    }
  }
  return true;
}

/** Xabar matni/izohidagi qalin (bold) bo'laklar. */
function boldTexts(msg: TgMessage): Set<string> {
  const isText = msg.text !== undefined;
  const text = (isText ? msg.text : msg.caption) ?? '';
  const entities = (isText ? msg.entities : msg.caption_entities) ?? [];
  const out = new Set<string>();
  for (const e of entities) {
    if (e.type !== 'bold') continue;
    const s = text.slice(e.offset, e.offset + e.length).trim();
    if (s) out.add(s);
  }
  return out;
}

/**
 * Tugmasiz (yoki faqat rol tugmali) BOT xabari — shaxsiy havola orqali ulanish xabari
 * ("Siz <b>Aziza</b> bilan bog'landingiz"), «✍️ Yozish» tasdig'i, /start dagi "Siz <b>…</b> bilan suhbatdasiz" va h.k.
 * Ularda tugma bo'lmagani uchun suhbatni tugmalardan aniqlab bo'lmaydi; o'rniga xabarda QALIN yozilgan ism shu
 * mijozning suhbatlaridan aynan BITTA xodimning ismiga to'liq mos kelsa — o'sha suhbat id si. Aks holda null
 * (taxmin qilinmaydi). Xodim mavjudligi chaqiruvchida tekshiriladi.
 */
export async function conversationFromNamedStaff(
  clientId: number,
  msg: TgMessage | undefined,
  botId: number,
): Promise<number | null> {
  if (!msg || msg.from?.id !== botId || !hasOnlyRoleButtons(msg)) return null;
  const names = boldTexts(msg);
  if (!names.size) return null;
  const rows = await db()<{ conv_id: number; full_name: string }[]>`
    select c.id as conv_id, s.full_name from conversations c join staff s on s.id = c.staff_id
    where c.client_id = ${clientId}`;
  const matches = rows.filter((r) => names.has(staffName(r)));
  return matches.length === 1 ? Number(matches[0]!.conv_id) : null;
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
  /** Amaldagi shikoyat himoyasi (muddati o'tmagan) — guardApplies bilan tekshiriladi. */
  cmpGuard: ComplaintGuard | null;
}

/** Bitta so'rovda: oxirgi ko'rsatilgan xabar suhbati + mijoz holati (saqlangan xabarlar, tanlov). */
export async function loadRouteInfo(clientId: number): Promise<RouteInfo> {
  const sql = db();
  const rows = await sql<
    {
      last_conv_id: number | null;
      last_at: Date | null;
      state: unknown;
      state_at: Date | null;
      fresh: boolean | null;
      guard: unknown;
    }[]
  >`
    select ls.conversation_id as last_conv_id, ls.created_at as last_at,
      st.state, st.updated_at as state_at, (st.updated_at > now() - interval '30 minutes') as fresh,
      -- shikoyat himoyasi updated_at dan qat'i nazar (mergeClientState uni yangilamaydi)
      (select jsonb_build_object('cmpGuard', u.state -> 'cmpGuard') from user_state u
        where u.bot = 'client' and u.tg_user_id = ${clientId} and (u.state ? 'cmpGuard')) as guard
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
    cmpGuard: guardOf(r?.guard ?? null),
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

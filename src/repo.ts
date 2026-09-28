// Ma'lumotlar bazasi bilan ishlovchi barcha umumiy funksiyalar.
import { db } from './db.js';
import type {
  BotKind,
  Client,
  Conversation,
  ConversationView,
  Message,
  MessageMeta,
  MsgKind,
  Role,
  Sender,
  Staff,
  Via,
} from './types.js';
import type { MessageEntity } from 'grammy/types';
import { previewOf, randomCode } from './util.js';

// ───────────────────────────── Updates (takrorlanishdan himoya) ─────────────────────────────

/** Update birinchi marta ko'rilayotgan bo'lsa true qaytaradi. */
export async function markUpdateProcessed(bot: BotKind, updateId: number): Promise<boolean> {
  const sql = db();
  const rows = await sql`
    insert into processed_updates (bot, update_id) values (${bot}, ${updateId})
    on conflict do nothing
    returning update_id`;
  if (Math.random() < 0.02) {
    await sql`delete from processed_updates where created_at < now() - interval '3 days'`.catch(() => {});
  }
  return rows.length > 0;
}

/** Xatolik bo'lsa, Telegram qayta yuborganda update qayta ishlanishi uchun belgini o'chirish. */
export async function unmarkUpdate(bot: BotKind, updateId: number): Promise<void> {
  await db()`delete from processed_updates where bot = ${bot} and update_id = ${updateId}`;
}

// ───────────────────────────── Settings ─────────────────────────────

// Har bir api/*.ts alohida Vercel funksiyasi (o'z instansiyalari bilan) — xotiradagi kesh boshqa funksiyalarga
// tarqalmaydi. Shuning uchun admin tahrirlaydigan matnlar (salomlashuv, avto-javob, oflayn izohi) HAR DOIM
// bazadan o'qiladi (bir xil mintaqa, ~1 ms). Keshda faqat setup vaqtida o'zgaradigan yoki o'zini tiklaydigan
// qiymatlar turadi.
const CACHEABLE_SETTINGS = new Set(['app_url', 'placeholder_photo_file_id', 'client_bot_username', 'staff_bot_username']);
const settingsCache = new Map<string, { value: string | null; at: number }>();
/** Har bir kalit yozilganda oshadi: parallel o'qish eski qiymatni yangi yozuv ustidan keshlab qo'ymasligi uchun. */
const settingsGeneration = new Map<string, number>();
const SETTINGS_TTL = 30_000;

function bumpSetting(key: string): void {
  settingsGeneration.set(key, (settingsGeneration.get(key) ?? 0) + 1);
}

export async function getSetting(key: string): Promise<string | null> {
  const cacheable = CACHEABLE_SETTINGS.has(key);
  if (cacheable) {
    const cached = settingsCache.get(key);
    if (cached && Date.now() - cached.at < SETTINGS_TTL) return cached.value;
  }
  const gen = settingsGeneration.get(key) ?? 0;
  const rows = await db()<{ value: string }[]>`select value from settings where key = ${key}`;
  const value = rows[0]?.value ?? null;
  if (cacheable && (settingsGeneration.get(key) ?? 0) === gen) settingsCache.set(key, { value, at: Date.now() });
  return value;
}

/** Bir nechta sozlamani bitta so'rovda o'qish (keshsiz). Topilmaganlar null. */
export async function getSettings<K extends string>(keys: readonly K[]): Promise<Record<K, string | null>> {
  const out = {} as Record<K, string | null>;
  for (const k of keys) out[k] = null;
  if (!keys.length) return out;
  const sql = db();
  const rows = await sql<{ key: string; value: string }[]>`
    select key, value from settings where key = any(${sql.array([...keys] as string[])}::text[])`;
  for (const r of rows) if ((keys as readonly string[]).includes(r.key)) out[r.key as K] = r.value;
  return out;
}

export async function setSetting(key: string, value: string): Promise<void> {
  bumpSetting(key);
  await db()`
    insert into settings (key, value, updated_at) values (${key}, ${value}, now())
    on conflict (key) do update set value = excluded.value, updated_at = now()`;
  bumpSetting(key);
  if (CACHEABLE_SETTINGS.has(key)) settingsCache.set(key, { value, at: Date.now() });
  else settingsCache.delete(key);
}

export async function deleteSetting(key: string): Promise<void> {
  bumpSetting(key);
  await db()`delete from settings where key = ${key}`;
  bumpSetting(key);
  settingsCache.delete(key);
}

// ───────────────────────────── User state (admin/xodim bosqichli jarayonlari) ─────────────────────────────

export async function getState<T = Record<string, unknown>>(bot: BotKind, userId: number): Promise<T | null> {
  const rows = await db()<{ state: T }[]>`
    select state from user_state
    where bot = ${bot} and tg_user_id = ${userId} and updated_at > now() - interval '1 day'`;
  return rows[0]?.state ?? null;
}

export async function setState(bot: BotKind, userId: number, state: object): Promise<void> {
  const sql = db();
  await sql`
    insert into user_state (bot, tg_user_id, state, updated_at)
    values (${bot}, ${userId}, ${sql.json(state as never)}, now())
    on conflict (bot, tg_user_id) do update set state = excluded.state, updated_at = now()`;
}

export async function clearState(bot: BotKind, userId: number): Promise<void> {
  await db()`delete from user_state where bot = ${bot} and tg_user_id = ${userId}`;
}

// ───────────────────────────── Clients ─────────────────────────────

export interface TgUserLike {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

/**
 * Mijozni yaratish/yangilash (har bir update da chaqiriladi).
 * `unblock` — mijoz botga yozgan bo'lsa, demak botni bloklamagan (standart: true).
 * Mini App so'rovlari bot chatining holatini bildirmaydi — ular `unblock: false` bilan chaqiradi.
 */
export async function upsertClient(u: TgUserLike, opts: { unblock?: boolean } = {}): Promise<Client> {
  const sql = db();
  const unblock = opts.unblock !== false;
  const rows = await sql<Client[]>`
    insert into clients (tg_user_id, first_name, last_name, username, language_code, last_seen_at, bot_blocked)
    values (${u.id}, ${u.first_name ?? ''}, ${u.last_name ?? null}, ${u.username ?? null}, ${u.language_code ?? null}, now(), false)
    on conflict (tg_user_id) do update set
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      username = excluded.username,
      language_code = excluded.language_code,
      last_seen_at = now()
      ${unblock ? sql`, bot_blocked = false` : sql``}
    returning *`;
  return rows[0]!;
}

export async function getClient(tgUserId: number): Promise<Client | null> {
  const rows = await db()<Client[]>`select * from clients where tg_user_id = ${tgUserId}`;
  return rows[0] ?? null;
}

export async function setClientBlocked(tgUserId: number, blocked: boolean): Promise<void> {
  await db()`update clients set bot_blocked = ${blocked} where tg_user_id = ${tgUserId}`;
}

export async function setClientActiveConversation(tgUserId: number, conversationId: number | null): Promise<void> {
  await db()`update clients set active_conversation_id = ${conversationId} where tg_user_id = ${tgUserId}`;
}

// ───────────────────────────── Staff ─────────────────────────────

/** Mijozlarga ko'rinadigan xodimmi (faol, o'chirilmagan, Telegramga ulangan). */
export function isStaffAvailable(s: Staff | null | undefined): s is Staff {
  return !!s && s.is_active && !s.deleted_at && s.tg_user_id != null;
}

export async function getStaff(id: number): Promise<Staff | null> {
  if (!Number.isSafeInteger(id)) return null;
  const rows = await db()<Staff[]>`select * from staff where id = ${id}`;
  return rows[0] ?? null;
}

export async function getStaffByTgId(tgUserId: number): Promise<Staff | null> {
  const rows = await db()<Staff[]>`
    select * from staff where tg_user_id = ${tgUserId} and deleted_at is null`;
  return rows[0] ?? null;
}

/** Mijozlar uchun: faqat mavjud (faol + ulangan) xodimlar. */
export async function listAvailableStaff(role?: Role): Promise<Staff[]> {
  const sql = db();
  return sql<Staff[]>`
    select * from staff
    where is_active and deleted_at is null and tg_user_id is not null
      ${role ? sql`and role = ${role}` : sql``}
    order by sort_order asc, id asc`;
}

/** Admin uchun: o'chirilmagan barcha xodimlar. */
export async function listAllStaff(): Promise<Staff[]> {
  return db()<Staff[]>`
    select * from staff where deleted_at is null
    order by role asc, sort_order asc, id asc`;
}

export interface NewStaff {
  role: Role;
  full_name: string;
  position?: string;
  description?: string;
  greeting?: string | null;
  photo_file_id?: string | null;
  photo_unique_id?: string | null;
}

export async function createStaff(s: NewStaff): Promise<Staff> {
  const rows = await db()<Staff[]>`
    insert into staff (role, full_name, position, description, greeting, photo_file_id, photo_unique_id, invite_code, sort_order)
    values (
      ${s.role}, ${s.full_name}, ${s.position ?? ''}, ${s.description ?? ''}, ${s.greeting ?? null},
      ${s.photo_file_id ?? null}, ${s.photo_unique_id ?? null}, ${randomCode(20)},
      coalesce((select max(sort_order) + 1 from staff), 0)
    )
    returning *`;
  return rows[0]!;
}

export type StaffEditableField =
  | 'full_name'
  | 'position'
  | 'description'
  | 'greeting'
  | 'role'
  | 'is_active'
  | 'is_online'
  | 'sort_order';

export async function updateStaff(
  id: number,
  patch: Partial<Pick<Staff, StaffEditableField>>,
): Promise<Staff | null> {
  const sql = db();
  const allowed: StaffEditableField[] = [
    'full_name',
    'position',
    'description',
    'greeting',
    'role',
    'is_active',
    'is_online',
    'sort_order',
  ];
  const clean: Record<string, unknown> = {};
  for (const k of allowed) if (k in patch) clean[k] = (patch as Record<string, unknown>)[k];
  if (Object.keys(clean).length === 0) return getStaff(id);
  // Holatni qo'lda o'zgartirish — bloklashdan oldingi holatni tiklash rejasini bekor qiladi
  const touchOnline = 'is_online' in clean;
  const rows = await sql<Staff[]>`
    update staff set ${sql(clean as never, Object.keys(clean) as never)},
      ${touchOnline ? sql`online_before_block = null,` : sql``}
      updated_at = now()
    where id = ${id} and deleted_at is null
    returning *`;
  const row = rows[0] ?? null;
  if (row && clean.is_active === false) {
    // O'chirib qo'yilgan xodimga mijozlar yoza olmaydi — ularning "aktiv suhbati" ham tozalanadi (unlinkStaff kabi),
    // aks holda bot chatidagi keyingi xabar "mavjud emas" xatosiga uchrab, faol suhbat noto'g'ri ko'rsatiladi.
    await sql`
      update clients set active_conversation_id = null
      where active_conversation_id in (select id from conversations where staff_id = ${id})`;
  }
  return row;
}

/**
 * Xodim xodimlar botini bloklagan/to'xtatgan (403): xabarlar unga yetib bormaydi.
 * Mijozlar uni oflayn ko'rsin (avto-javobga "ish joyida emas" izohi qo'shiladi); oldingi holat eslab qolinadi.
 * Holat haqiqatan o'zgargan bo'lsa (birinchi marta) xodim yozuvini qaytaradi — adminlarni bir marta ogohlantirish uchun.
 */
export async function markStaffUnreachable(id: number): Promise<Staff | null> {
  const rows = await db()<Staff[]>`
    update staff set bot_blocked = true,
      online_before_block = coalesce(online_before_block, is_online),
      is_online = false, updated_at = now()
    where id = ${id} and not bot_blocked
    returning *`;
  return rows[0] ?? null;
}

/** Xodim botga qaytdi: belgini olib tashlash va bloklashdan oldingi onlayn holatini tiklash. O'zgargan bo'lsa yozuv qaytadi. */
export async function markStaffReachable(id: number): Promise<Staff | null> {
  const rows = await db()<Staff[]>`
    update staff set bot_blocked = false,
      is_online = coalesce(online_before_block, is_online),
      online_before_block = null, updated_at = now()
    where id = ${id} and bot_blocked
    returning *`;
  return rows[0] ?? null;
}

/** Rasmni yangilash (staff botdagi file_id). Mijoz botidagi keshlangan rasm tozalanadi. */
export async function setStaffPhoto(id: number, fileId: string | null, uniqueId: string | null): Promise<Staff | null> {
  const rows = await db()<Staff[]>`
    update staff set photo_file_id = ${fileId}, photo_unique_id = ${uniqueId},
      client_photo_file_id = null, updated_at = now()
    where id = ${id} and deleted_at is null
    returning *`;
  return rows[0] ?? null;
}

/** Mijoz botida bir marta yuklangan rasmning file_id sini keshlash. */
export async function cacheClientPhoto(id: number, uniqueId: string | null, clientFileId: string): Promise<void> {
  await db()`
    update staff set client_photo_file_id = ${clientFileId}
    where id = ${id} and photo_unique_id is not distinct from ${uniqueId}`;
}

/** Telegram qabul qilmagan (yaroqsiz) keshlangan file_id ni tozalash — faqat hali o'sha qiymat bo'lsa. */
export async function clearClientPhoto(id: number, badFileId: string): Promise<void> {
  await db()`
    update staff set client_photo_file_id = null
    where id = ${id} and client_photo_file_id = ${badFileId}`;
}

/** Yangi taklif kodi (eski havola bekor bo'ladi). */
export async function regenerateInvite(id: number): Promise<Staff | null> {
  const rows = await db()<Staff[]>`
    update staff set invite_code = ${randomCode(20)}, updated_at = now()
    where id = ${id} and deleted_at is null
    returning *`;
  return rows[0] ?? null;
}

export type LinkResult =
  | { ok: true; staff: Staff }
  | { ok: false; reason: 'invalid' | 'taken' | 'already_linked_other' };

/** Taklif havolasi orqali Telegram akkauntni xodim profiliga ulash. */
export async function linkStaffByInvite(code: string, tgUserId: number, username: string | null): Promise<LinkResult> {
  const sql = db();
  return sql.begin(async (tx) => {
    const t = tx as unknown as typeof sql;
    const found = await t<Staff[]>`
      select * from staff where invite_code = ${code} and deleted_at is null for update`;
    const target = found[0];
    if (!target) return { ok: false, reason: 'invalid' } as const;
    if (target.tg_user_id != null && target.tg_user_id !== tgUserId) return { ok: false, reason: 'taken' } as const;
    const other = await t<Staff[]>`
      select * from staff where tg_user_id = ${tgUserId} and id <> ${target.id}`;
    if (other[0]) {
      if (other[0].deleted_at) {
        // O'chirilgan eski profil ulanishni band qilib turmasin
        await t`update staff set tg_user_id = null where id = ${other[0].id}`;
      } else {
        return { ok: false, reason: 'already_linked_other' } as const;
      }
    }
    const rows = await t<Staff[]>`
      update staff set tg_user_id = ${tgUserId}, tg_username = ${username}, invite_code = null, updated_at = now()
      where id = ${target.id}
      returning *`;
    return { ok: true, staff: rows[0]! } as const;
  });
}

/**
 * Akkauntni uzish (xodim profili qoladi, yangi taklif kodi beriladi).
 * Mijozlarning shu xodim bilan aktiv suhbati ham tozalanadi (xodim endi xabar qabul qila olmaydi).
 */
export async function unlinkStaff(id: number): Promise<Staff | null> {
  const sql = db();
  const rows = await sql<Staff[]>`
    update staff set tg_user_id = null, tg_username = null, active_conversation_id = null,
      invite_code = ${randomCode(20)}, updated_at = now()
    where id = ${id} and deleted_at is null
    returning *`;
  if (rows[0]) {
    await sql`
      update clients set active_conversation_id = null
      where active_conversation_id in (select id from conversations where staff_id = ${id})`;
  }
  return rows[0] ?? null;
}

/** Yumshoq o'chirish — suhbatlar tarixi saqlanib qoladi. */
export async function softDeleteStaff(id: number): Promise<boolean> {
  const sql = db();
  const rows = await sql`
    update staff set deleted_at = now(), is_active = false, tg_user_id = null, tg_username = null,
      invite_code = null, active_conversation_id = null, updated_at = now()
    where id = ${id} and deleted_at is null
    returning id`;
  if (rows.length) {
    await sql`
      update clients set active_conversation_id = null
      where active_conversation_id in (select id from conversations where staff_id = ${id})`;
  }
  return rows.length > 0;
}

export async function updateStaffUsername(id: number, username: string | null): Promise<void> {
  await db()`update staff set tg_username = ${username} where id = ${id} and tg_username is distinct from ${username}`;
}

/** Aktiv suhbatni o'rnatish; `active_set_at` — xodim uni aniq tanlagan vaqt (tozalanganda null). */
export async function setStaffActiveConversation(staffId: number, conversationId: number | null): Promise<void> {
  const sql = db();
  await sql`
    update staff set active_conversation_id = ${conversationId},
      active_set_at = ${conversationId == null ? sql`null` : sql`now()`}
    where id = ${staffId}`;
}

// ───────────────────────────── Conversations ─────────────────────────────

export async function getConversation(id: number): Promise<Conversation | null> {
  if (!Number.isSafeInteger(id)) return null;
  const rows = await db()<Conversation[]>`select * from conversations where id = ${id}`;
  return rows[0] ?? null;
}

/** Mijoz + xodim juftligi uchun suhbatni olish yoki yaratish. */
export async function getOrCreateConversation(clientId: number, staffId: number): Promise<Conversation> {
  const sql = db();
  const rows = await sql<Conversation[]>`
    insert into conversations (client_id, staff_id) values (${clientId}, ${staffId})
    on conflict (client_id, staff_id) do update set client_id = excluded.client_id
    returning *`;
  return rows[0]!;
}

const VIEW_COLUMNS = (sql: ReturnType<typeof db>) => sql`
  c.*,
  s.full_name as staff_full_name, s.role as staff_role, s.position as staff_position,
  s.photo_unique_id as staff_photo_unique_id, s.is_online as staff_is_online,
  cl.first_name as client_first_name, cl.last_name as client_last_name, cl.username as client_username`;

export async function getConversationView(id: number): Promise<ConversationView | null> {
  const sql = db();
  const rows = await sql<ConversationView[]>`
    select ${VIEW_COLUMNS(sql)}
    from conversations c
    join staff s on s.id = c.staff_id
    join clients cl on cl.tg_user_id = c.client_id
    where c.id = ${id}`;
  return rows[0] ?? null;
}

/** Mijozning suhbatlari (eng oxirgisi birinchi). */
export async function listClientConversations(clientId: number, limit = 50): Promise<ConversationView[]> {
  const sql = db();
  return sql<ConversationView[]>`
    select ${VIEW_COLUMNS(sql)}
    from conversations c
    join staff s on s.id = c.staff_id
    join clients cl on cl.tg_user_id = c.client_id
    where c.client_id = ${clientId}
    order by c.last_message_at desc nulls last, c.id desc
    limit ${limit}`;
}

/** Xodimning suhbatlari — faqat xabar bor suhbatlar (boshqa xodimlarniki hech qachon qaytmaydi). */
export async function listStaffConversations(
  staffId: number,
  opts: { limit?: number; offset?: number; search?: string } = {},
): Promise<ConversationView[]> {
  const sql = db();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const q = (opts.search ?? '').trim();
  const like = `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
  return sql<ConversationView[]>`
    select ${VIEW_COLUMNS(sql)}
    from conversations c
    join staff s on s.id = c.staff_id
    join clients cl on cl.tg_user_id = c.client_id
    where c.staff_id = ${staffId} and c.last_message_at is not null
      ${q ? sql`and (cl.first_name ilike ${like} or cl.last_name ilike ${like} or cl.username ilike ${like})` : sql``}
    order by c.last_message_at desc, c.id desc
    limit ${limit} offset ${offset}`;
}

export async function countStaffConversations(staffId: number): Promise<number> {
  const rows = await db()<{ n: number }[]>`
    select count(*)::int as n from conversations where staff_id = ${staffId} and last_message_at is not null`;
  return rows[0]?.n ?? 0;
}

export async function markReadByStaff(conversationId: number): Promise<void> {
  await db()`update conversations set unread_staff = 0 where id = ${conversationId} and unread_staff <> 0`;
}

export async function markReadByClient(conversationId: number): Promise<void> {
  await db()`update conversations set unread_client = 0 where id = ${conversationId} and unread_client <> 0`;
}

/**
 * Avto-javob faqat bir marta yuborilishi uchun atomik belgi.
 * true qaytsa — shu chaqiruv avto-javob yuborishi kerak.
 */
export async function claimAutoReply(conversationId: number): Promise<boolean> {
  const rows = await db()`
    update conversations set auto_replied = true
    where id = ${conversationId} and auto_replied = false
    returning id`;
  return rows.length > 0;
}

/** Avto-javob vaqtinchalik xato bilan yuborilmadi — keyingi xabarda qayta urinish uchun belgini qaytarish. */
export async function releaseAutoReply(conversationId: number): Promise<void> {
  await db()`update conversations set auto_replied = false where id = ${conversationId}`;
}

// ───────────────────────────── Messages ─────────────────────────────

export interface NewMessage {
  conversation_id: number;
  sender: Sender;
  kind: MsgKind;
  text?: string | null;
  entities?: MessageEntity[] | null;
  file_id_client?: string | null;
  file_id_staff?: string | null;
  file_unique_id?: string | null;
  file_name?: string | null;
  mime_type?: string | null;
  file_size?: number | null;
  meta?: MessageMeta | null;
  client_chat_msg_id?: number | null;
  staff_chat_id?: number | null;
  staff_chat_msg_id?: number | null;
  via?: Via;
  /**
   * Yetkazish shu chaqiruvga "band" qilinadi (delivery_claimed_at = now()): parallel ishlayotgan qayta yetkazish
   * (claimPendingForStaff) uni ikkinchi marta yubormaydi. Chaqiruv to'xtab qolsa, 2 daqiqadan keyin navbatga qaytadi.
   */
  claimed?: boolean;
}

/**
 * Xabarni saqlash va suhbatning oxirgi xabar ma'lumotlarini yangilash.
 * client xabari -> unread_staff++, staff xabari -> unread_client++ (unread_staff = 0).
 */
export async function insertMessage(m: NewMessage): Promise<Message> {
  const sql = db();
  const preview = previewOf(m.kind, m.text);
  // Suhbatning "oxirgi xabar" maydonlari shu so'rovning o'zida (bitta round-trip) yangilanadi.
  // sender = 'bot' (avto-javob) — suhbat ro'yxatidagi oxirgi xabar ko'rinishini o'zgartirmaydi.
  const touch =
    m.sender === 'client'
      ? sql`, touched as (
          update conversations set last_message_at = (select created_at from inserted), last_message_preview = ${preview},
            last_sender = 'client', unread_staff = unread_staff + 1
          where id = ${m.conversation_id}
          returning id)`
      : m.sender === 'staff'
        ? sql`, touched as (
            update conversations set last_message_at = (select created_at from inserted), last_message_preview = ${preview},
              last_sender = 'staff', unread_client = unread_client + 1, unread_staff = 0
            where id = ${m.conversation_id}
            returning id)`
        : sql``;
  const rows = await sql<Message[]>`
    with inserted as (
      insert into messages (
        conversation_id, sender, kind, text, entities, file_id_client, file_id_staff, file_unique_id,
        file_name, mime_type, file_size, meta, client_chat_msg_id, staff_chat_id, staff_chat_msg_id, via,
        delivery_claimed_at
      ) values (
        ${m.conversation_id}, ${m.sender}, ${m.kind}, ${m.text ?? null},
        ${m.entities && m.entities.length ? sql.json(m.entities as never) : null},
        ${m.file_id_client ?? null}, ${m.file_id_staff ?? null}, ${m.file_unique_id ?? null},
        ${m.file_name ?? null}, ${m.mime_type ?? null}, ${m.file_size ?? null},
        ${m.meta ? sql.json(m.meta as never) : null},
        ${m.client_chat_msg_id ?? null}, ${m.staff_chat_id ?? null}, ${m.staff_chat_msg_id ?? null},
        ${m.via ?? 'bot'},
        ${m.claimed ? sql`now()` : null}
      )
      returning *
    )${touch}
    select * from inserted`;
  return rows[0]!;
}

/** Yetkazilgandan keyin boshqa tomondagi message_id / file_id ni saqlash. */
export async function updateMessageDelivery(
  id: number,
  patch: {
    client_chat_msg_id?: number | null;
    staff_chat_id?: number | null;
    staff_chat_msg_id?: number | null;
    file_id_client?: string | null;
    file_id_staff?: string | null;
  },
): Promise<void> {
  const sql = db();
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) clean[k] = v;
  if (!Object.keys(clean).length) return;
  await sql`update messages set ${sql(clean as never, Object.keys(clean) as never)} where id = ${id}`;
}

export async function getMessage(id: number): Promise<Message | null> {
  if (!Number.isSafeInteger(id)) return null;
  const rows = await db()<Message[]>`select * from messages where id = ${id}`;
  return rows[0] ?? null;
}

/**
 * Suhbat xabarlari, id bo'yicha o'sish tartibida.
 * afterId — shundan keyingi yangi xabarlar; beforeId — oldingi (tarix) xabarlar.
 */
export async function listMessages(
  conversationId: number,
  opts: { afterId?: number; beforeId?: number; limit?: number } = {},
): Promise<Message[]> {
  const sql = db();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  if (opts.afterId != null) {
    return sql<Message[]>`
      select * from messages where conversation_id = ${conversationId} and id > ${opts.afterId}
      order by id asc limit ${limit}`;
  }
  const rows = await sql<Message[]>`
    select * from messages where conversation_id = ${conversationId}
      ${opts.beforeId != null ? sql`and id < ${opts.beforeId}` : sql``}
    order by id desc limit ${limit}`;
  return rows.reverse();
}

// ───────────────────────────── Xabarlar xaritasi (Reply orqali yo'naltirish) ─────────────────────────────

/**
 * Bot bitta saqlangan xabar uchun yuborgan QO'SHIMCHA Telegram xabarlarini bog'lash (alohida sarlavha,
 * matn bo'laklari, izoh davomi, tahrir xabarlari, "📥 Botda ochish" nusxalari). Ularning istalganiga Reply
 * qilinsa ham suhbat to'g'ri topiladi. Takroriy id — oxirgi bog'lanish ustun.
 */
export async function addMessageLinks(messageId: number, bot: BotKind, chatId: number, tgMsgIds: readonly number[]): Promise<void> {
  const ids = [...new Set(tgMsgIds.filter((x) => Number.isSafeInteger(x) && x > 0))];
  if (!ids.length) return;
  const sql = db();
  const rows = ids.map((id) => ({ bot, chat_id: chatId, tg_msg_id: id, message_id: messageId }));
  await sql`
    insert into message_links ${sql(rows as never, 'bot' as never, 'chat_id' as never, 'tg_msg_id' as never, 'message_id' as never)}
    on conflict (bot, chat_id, tg_msg_id) do update set message_id = excluded.message_id`;
}

/**
 * Xodim chatidagi Telegram xabaridan saqlangan xabarni topish (faqat shu xodimning suhbatlari — maxfiylik):
 * asosiy xarita (staff_chat_msg_id) yoki qo'shimcha xabarlar (message_links).
 */
export async function findMessageByStaffChatMsg(
  staffId: number,
  staffChatId: number,
  staffChatMsgId: number,
  opts: { conversationId?: number } = {},
): Promise<Message | null> {
  const sql = db();
  const conv = () => (opts.conversationId != null ? sql`and c.id = ${opts.conversationId}` : sql``);
  // Har bir tarmoqda egalik filtri — indekslar (staff_chat_id, staff_chat_msg_id) va message_links PK ishlaydi
  const rows = await sql<Message[]>`
    select m.* from messages m join conversations c on c.id = m.conversation_id
    where m.staff_chat_id = ${staffChatId} and m.staff_chat_msg_id = ${staffChatMsgId} and c.staff_id = ${staffId} ${conv()}
    union all
    select m.* from message_links l
    join messages m on m.id = l.message_id
    join conversations c on c.id = m.conversation_id
    where l.bot = 'staff' and l.chat_id = ${staffChatId} and l.tg_msg_id = ${staffChatMsgId} and c.staff_id = ${staffId} ${conv()}
    order by id desc limit 1`;
  return rows[0] ?? null;
}

/** Mijoz chatidagi Telegram xabaridan saqlangan xabarni topish (faqat shu mijozning suhbatlari). */
export async function findMessageByClientChatMsg(
  clientId: number,
  clientChatMsgId: number,
  opts: { conversationId?: number } = {},
): Promise<Message | null> {
  const sql = db();
  const conv = () => (opts.conversationId != null ? sql`and c.id = ${opts.conversationId}` : sql``);
  // Mijoz chatidagi id lar boshqa mijozlarnikiga to'g'ri kelishi mumkin — avval mijozning suhbatlari bo'yicha
  const rows = await sql<Message[]>`
    select m.* from conversations c join messages m on m.conversation_id = c.id
    where c.client_id = ${clientId} and m.client_chat_msg_id = ${clientChatMsgId} ${conv()}
    union all
    select m.* from message_links l
    join messages m on m.id = l.message_id
    join conversations c on c.id = m.conversation_id
    where l.bot = 'client' and l.chat_id = ${clientId} and l.tg_msg_id = ${clientChatMsgId} and c.client_id = ${clientId} ${conv()}
    order by id desc limit 1`;
  return rows[0] ?? null;
}

/** Xodim reply qilgan xabardan suhbatni topish (faqat shu xodimning suhbati; qo'shimcha xabarlar ham hisobga olinadi). */
export async function findConversationByStaffReply(
  staffId: number,
  staffChatId: number,
  staffChatMsgId: number,
): Promise<Conversation | null> {
  const m = await findMessageByStaffChatMsg(staffId, staffChatId, staffChatMsgId);
  return m ? getConversation(m.conversation_id) : null;
}

/** Mijoz reply qilgan xabardan suhbatni topish (faqat shu mijozning suhbati; qo'shimcha xabarlar ham hisobga olinadi). */
export async function findConversationByClientReply(clientId: number, clientChatMsgId: number): Promise<Conversation | null> {
  const m = await findMessageByClientChatMsg(clientId, clientChatMsgId);
  return m ? getConversation(m.conversation_id) : null;
}

// ───────────────────────────── Yetkazish navbati ─────────────────────────────

/** Xodimga hali yetkazilmagan mijoz xabari (qayta yetkazish uchun). */
export interface PendingClientMessage extends Message {
  client_id: number;
  /** Suhbatdagi eng birinchi xabarmi (🆕 belgisi uchun). */
  is_first: boolean;
}

/** Yetkazish qancha vaqtgacha qayta urinadi (eski xabarlarni kunlar o'tib yuborish chalg'itadi). */
const PENDING_MAX_AGE = '3 days';
/** "Band" qilingan yetkazish shuncha vaqtdan keyin (chaqiruv to'xtab qolgan bo'lsa) yana navbatga qaytadi. */
const CLAIM_TTL = '2 minutes';

/**
 * Xodimga yetkazilmagan mijoz xabarlarini (eskisi birinchi) atomik "band" qilish. Parallel webhooklar bitta
 * xabarni ikki marta olmaydi (FOR UPDATE SKIP LOCKED + delivery_claimed_at).
 */
export async function claimPendingForStaff(staffId: number, limit = 5): Promise<PendingClientMessage[]> {
  const sql = db();
  const rows = await sql<PendingClientMessage[]>`
    with picked as (
      select m.id from messages m
      join conversations c on c.id = m.conversation_id
      where c.staff_id = ${staffId}
        and m.sender = 'client' and m.staff_chat_msg_id is null and m.delivery_error is null
        and m.created_at > now() - ${PENDING_MAX_AGE}::interval
        and (m.delivery_claimed_at is null or m.delivery_claimed_at < now() - ${CLAIM_TTL}::interval)
      order by m.id
      limit ${limit}
      for update of m skip locked
    )
    update messages m set delivery_claimed_at = now()
    from picked
    where m.id = picked.id
    returning m.*,
      (select client_id from conversations where id = m.conversation_id) as client_id,
      not exists (select 1 from messages p where p.conversation_id = m.conversation_id and p.id < m.id) as is_first`;
  return [...rows].sort((a, b) => a.id - b.id);
}

/** Xodimga yetkazilmagan xabarlar bormi (arzon tekshiruv — navbatni band qilmaydi). */
export async function hasPendingForStaff(staffId: number): Promise<boolean> {
  const rows = await db()`
    select 1 from messages m join conversations c on c.id = m.conversation_id
    where c.staff_id = ${staffId}
      and m.sender = 'client' and m.staff_chat_msg_id is null and m.delivery_error is null
      and m.created_at > now() - ${PENDING_MAX_AGE}::interval
    limit 1`;
  return rows.length > 0;
}

/**
 * Bitta xabarni qo'lda qayta yuborish uchun band qilish (ikki marta bosilganda takrorlanmasin).
 * target: 'staff' — mijoz xabarini xodimga, 'client' — xodim xabarini mijozga. Allaqachon yetkazilgan
 * yoki hozir boshqa chaqiruv yuborayotgan bo'lsa null.
 */
export async function claimMessageDelivery(id: number, target: BotKind): Promise<Message | null> {
  const sql = db();
  const rows = await sql<Message[]>`
    update messages set delivery_claimed_at = now()
    where id = ${id}
      and ${target === 'staff' ? sql`sender = 'client' and staff_chat_msg_id is null` : sql`sender = 'staff' and client_chat_msg_id is null`}
      and (delivery_claimed_at is null or delivery_claimed_at < now() - ${CLAIM_TTL}::interval)
    returning *`;
  return rows[0] ?? null;
}

/** Band qilishni bekor qilish (keyingi urinish kutmasdan olishi uchun). */
export async function releaseDeliveryClaims(ids: readonly number[]): Promise<void> {
  if (!ids.length) return;
  const sql = db();
  await sql`update messages set delivery_claimed_at = null where id = any(${sql.array([...ids])}::bigint[])`;
}

/** Qayta urinib bo'lmaydigan yetkazish xatosi (navbatdan chiqariladi). */
export async function setDeliveryError(id: number, error: string): Promise<void> {
  await db()`update messages set delivery_error = ${error}, delivery_claimed_at = null where id = ${id}`;
}

// ───────────────────────────── Tahrirlar ─────────────────────────────

/** Mijoz o'z chatida tahrirlagan xabari (faqat mijozning o'z xabarlari, sender = 'client') + suhbat xodimi. */
export async function findClientMessageForEdit(
  clientId: number,
  clientChatMsgId: number,
): Promise<(Message & { conversation_staff_id: number }) | null> {
  const rows = await db()<(Message & { conversation_staff_id: number })[]>`
    select m.*, c.staff_id as conversation_staff_id from messages m join conversations c on c.id = m.conversation_id
    where m.sender = 'client' and m.client_chat_msg_id = ${clientChatMsgId} and c.client_id = ${clientId}
    order by m.id desc limit 1`;
  return rows[0] ?? null;
}

/** Xodim o'z chatida tahrirlagan xabari (faqat shu xodimning suhbatlari, sender = 'staff'). */
export async function findStaffMessageForEdit(staffId: number, staffChatId: number, staffChatMsgId: number): Promise<Message | null> {
  const rows = await db()<Message[]>`
    select m.* from messages m join conversations c on c.id = m.conversation_id
    where m.sender = 'staff' and m.staff_chat_id = ${staffChatId} and m.staff_chat_msg_id = ${staffChatMsgId}
      and c.staff_id = ${staffId}
    order by m.id desc limit 1`;
  return rows[0] ?? null;
}

/**
 * Tahrirni saqlash: matn/entity lar (media almashtirilgan bo'lsa — fayl maydonlari ham), edited_at = now().
 * Xabar suhbatning oxirgi (avto-javobsiz) xabari bo'lsa, ro'yxatdagi ko'rinish (preview) ham yangilanadi.
 * Yangilangan yozuvni qaytaradi.
 */
export async function applyMessageEdit(
  id: number,
  patch: {
    text: string | null;
    entities: MessageEntity[] | null;
    media?: {
      kind: MsgKind;
      file_id_client?: string | null;
      file_id_staff?: string | null;
      file_unique_id?: string | null;
      file_name?: string | null;
      mime_type?: string | null;
      file_size?: number | null;
      meta?: MessageMeta | null;
    };
  },
): Promise<Message | null> {
  const sql = db();
  const md = patch.media;
  const rows = await sql<Message[]>`
    update messages set
      text = ${patch.text},
      entities = ${patch.entities && patch.entities.length ? sql.json(patch.entities as never) : null},
      ${
        md
          ? sql`kind = ${md.kind}, file_id_client = ${md.file_id_client ?? null}, file_id_staff = ${md.file_id_staff ?? null},
              file_unique_id = ${md.file_unique_id ?? null}, file_name = ${md.file_name ?? null},
              mime_type = ${md.mime_type ?? null}, file_size = ${md.file_size ?? null},
              meta = ${md.meta ? sql.json(md.meta as never) : null},`
          : sql``
      }
      edited_at = now()
    where id = ${id}
    returning *`;
  const row = rows[0];
  if (!row) return null;
  await sql`
    update conversations c set last_message_preview = ${previewOf(row.kind, row.text)}
    where c.id = ${row.conversation_id}
      and not exists (select 1 from messages m where m.conversation_id = c.id and m.id > ${row.id} and m.sender <> 'bot')`;
  return row;
}

/** Xabar suhbatdagi eng birinchi xabarmi (sarlavhadagi 🆕 belgisini tahrirda ham saqlash uchun). */
export async function isFirstMessageOfConversation(message: Pick<Message, 'id' | 'conversation_id'>): Promise<boolean> {
  const rows = await db()`
    select 1 from messages where conversation_id = ${message.conversation_id} and id < ${message.id} limit 1`;
  return rows.length === 0;
}

// ───────────────────────────── Statistika ─────────────────────────────

export interface Stats {
  clients: number;
  clients_today: number;
  conversations: number;
  messages: number;
  messages_today: number;
  staff_total: number;
  staff_linked: number;
}

export async function getStats(): Promise<Stats> {
  const rows = await db()<Stats[]>`
    select
      (select count(*)::int from clients) as clients,
      (select count(*)::int from clients where created_at > now() - interval '1 day') as clients_today,
      (select count(*)::int from conversations where last_message_at is not null) as conversations,
      (select count(*)::int from messages) as messages,
      (select count(*)::int from messages where created_at > now() - interval '1 day') as messages_today,
      (select count(*)::int from staff where deleted_at is null) as staff_total,
      (select count(*)::int from staff where deleted_at is null and tg_user_id is not null) as staff_linked`;
  return rows[0]!;
}

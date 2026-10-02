// Mini App uchun qo'shimcha (faqat o'qish) so'rovlari. Umumiy funksiyalar src/repo.ts da.
import { db, type Sql } from '../db.js';
import type { Conversation, ConversationView, Staff } from '../types.js';
import type { ClientConvRow, MessageDTOSource, StaffConvSummarySource } from './dto.js';

// ───────────────────────────── Polling (sync) uchun ixcham so'rovlar ─────────────────────────────
// Mini App har 3–8 soniyada so'rov yuboradi. Supabase chiqish trafigi (egress) har bir qaytgan bayt uchun hisoblanadi,
// jumladan har bir so'rovdagi ustunlar tavsifi (RowDescription) — shuning uchun bu yerda faqat kerakli ustunlar olinadi.

/** sync uchun xodim identifikatori: faqat id va aktiv suhbat (to'liq profil — bootstrap va boshqa amallarda). */
export type StaffRef = Pick<Staff, 'id' | 'active_conversation_id'>;

/** getStaffByTgId (src/repo.ts) bilan bir xil shart, lekin faqat sync ga kerakli ustunlar. */
export async function getStaffRefByTgId(tgUserId: number): Promise<StaffRef | null> {
  const rows = await db()<StaffRef[]>`
    select id, active_conversation_id from staff where tg_user_id = ${tgUserId} and deleted_at is null`;
  return rows[0] ?? null;
}

/** Egalik tekshiruvi va o'qilmaganlar uchun suhbatning kerakli ustunlari. */
export type ConversationRef = Pick<Conversation, 'id' | 'client_id' | 'staff_id' | 'unread_staff' | 'unread_client'>;

export async function getConversationRef(id: number): Promise<ConversationRef | null> {
  if (!Number.isSafeInteger(id)) return null;
  const rows = await db()<ConversationRef[]>`
    select id, client_id, staff_id, unread_staff, unread_client from conversations where id = ${id}`;
  return rows[0] ?? null;
}

/** messageDTO ga kerakli ustunlar (entities, file_unique_id, staff_chat_id, delivery_* — kerak emas). */
const DTO_MESSAGE_COLUMNS = (sql: Sql) => sql`
  id, conversation_id, sender, kind, text, meta, file_id_client, file_id_staff, file_name, mime_type, file_size,
  client_chat_msg_id, staff_chat_msg_id, via, created_at, edited_at`;

export interface SyncMessages {
  /** Yangi xabarlar (afterId dan keyingilar yoki oxirgi `latest` tasi), id bo'yicha o'sish tartibida */
  fresh: MessageDTOSource[];
  /** `editedSince` dan keyin tahrirlanganlar, edited_at bo'yicha o'sish tartibida */
  edited: MessageDTOSource[];
  /** `checkIds` dan endi suhbatdoshga yetkazilganlari */
  delivered: MessageDTOSource[];
}

/**
 * Ochiq chat uchun sync ning uchta o'qishi BITTA so'rovda (UNION ALL): yangi xabarlar (listMessages bilan bir xil),
 * tahrirlanganlar (messages_edited_idx) va yetkazilganligi tekshiriladiganlar. Natijalar avvalgi uchta alohida
 * so'rov (listMessages / listEditedMessages / deliveredAmong) bilan bir xil; bitta round-trip va bitta ustunlar
 * tavsifi — har ~3 soniyadagi so'rovda baza ulanishi va trafik kamayadi.
 */
export async function syncMessages(
  conversationId: number,
  opts: { afterId?: number; latest: number; newLimit: number; editedSince: Date | null; editedLimit?: number; checkIds: readonly number[] },
): Promise<SyncMessages> {
  const sql = db();
  const cols = DTO_MESSAGE_COLUMNS(sql);
  const cid = conversationId;
  const clamp = (n: number) => Math.min(Math.max(Math.trunc(n), 1), 200);
  let q =
    opts.afterId != null
      ? sql`(select 'n' as src, ${cols} from messages
            where conversation_id = ${cid} and id > ${opts.afterId} order by id asc limit ${clamp(opts.newLimit)})`
      : sql`(select 'n' as src, ${cols} from messages
            where conversation_id = ${cid} order by id desc limit ${clamp(opts.latest)})`;
  if (opts.editedSince) {
    q = sql`${q} union all (select 'e' as src, ${cols} from messages
      where conversation_id = ${cid} and edited_at is not null and edited_at > ${opts.editedSince}
      order by edited_at asc limit ${opts.editedLimit ?? 50})`;
  }
  const ids = [...new Set(opts.checkIds)];
  if (ids.length) {
    q = sql`${q} union all (select 'd' as src, ${cols} from messages
      where conversation_id = ${cid} and id = any(${sql.array(ids)}::bigint[])
        and ((sender = 'client' and staff_chat_msg_id is not null) or (sender = 'staff' and client_chat_msg_id is not null))
      order by id asc)`;
  }
  const rows = await sql<(MessageDTOSource & { src: 'n' | 'e' | 'd' })[]>`${q}`;
  const out: SyncMessages = { fresh: [], edited: [], delivered: [] };
  for (const { src, ...m } of rows) {
    if (src === 'n') out.fresh.push(m);
    else if (src === 'e') out.edited.push(m);
    else out.delivered.push(m);
  }
  // UNION ALL natijalari tartibi kafolatlanmagan — har bir qism o'z tartibiga keltiriladi
  out.fresh.sort((a, b) => a.id - b.id);
  out.edited.sort((a, b) => (a.edited_at?.getTime() ?? 0) - (b.edited_at?.getTime() ?? 0) || a.id - b.id);
  out.delivered.sort((a, b) => a.id - b.id);
  return out;
}

// ───────────────────────────── Xodimning suhbatlar ro'yxati va uning imzosi ─────────────────────────────

/**
 * Ro'yxat imzosi formatining versiyasi. staffConvSummary (dto.ts) boshqa ustunlarga bog'liq bo'lib qolsa yoki
 * imzodagi kanonik satr o'zgarsa — oshiring (Mini App dagi eski imzolar bir marta to'liq ro'yxat oladi).
 */
export const STAFF_LIST_SIG_VERSION = 'sl1';

/**
 * Mini App ro'yxati: xodimning xabari bor suhbatlari (listStaffConversations bilan bir xil shart va tartib), faqat
 * staffConvSummary ishlatadigan ustunlar bilan. `rn` — tartib raqami (1 — eng yangi).
 * staff jadvali bilan join kerak emas: staff_id = so'rovchining o'zi (FK, not null).
 */
function staffListCte(sql: Sql, staffId: number, limit: number) {
  return sql`list as (
    select t.*, row_number() over (order by t.last_message_at desc, t.id desc) as rn
    from (
      select c.id, c.staff_id, c.client_id, c.last_message_at, c.last_message_preview, c.last_sender, c.unread_staff,
        cl.first_name as client_first_name, cl.last_name as client_last_name, cl.username as client_username
      from conversations c
      join clients cl on cl.tg_user_id = c.client_id
      where c.staff_id = ${staffId} and c.last_message_at is not null
      order by c.last_message_at desc, c.id desc
      limit ${limit}
    ) t
  )`;
}

/**
 * Imzo bazaning o'zida hisoblanadi: ro'yxatdagi (tartib bilan) har bir qatorning staffConvSummary natijasiga ta'sir
 * qiladigan BARCHA qiymatlari — id, staff_id, client_id, last_message_at (mikrosoniyagacha), ko'rinish, oxirgi
 * yuboruvchi, o'qilmaganlar, mijoz ismi/familiyasi/username i va is_active (id = aktiv suhbat) — JSON massiv
 * sifatida (null va '' farqlanadi) birlashtirilib md5 qilinadi. Faqat 32 belgili imzo qaytadi.
 * Vaqt matn emas, epoch sifatida olinadi — sessiya TimeZone/DateStyle sozlamalariga bog'liq bo'lmasin.
 */
function staffListSigExpr(sql: Sql, activeId: number | null) {
  return sql`md5(${STAFF_LIST_SIG_VERSION}::text || coalesce(string_agg(json_build_array(
      l.id, l.staff_id, l.client_id, (extract(epoch from l.last_message_at) * 1000000)::bigint,
      l.last_message_preview, l.last_sender, l.unread_staff,
      l.client_first_name, l.client_last_name, l.client_username,
      coalesce(l.id = ${activeId}::bigint, false)
    )::text, ',' order by l.rn), ''))`;
}

export interface StaffListState {
  /** Ro'yxat imzosi (md5 hex, 32 belgi) */
  sig: string;
  /** Ro'yxatdagi qatorlar soni (≤ limit) */
  listed: number;
  /** withTotals: xabari bor barcha suhbatlar soni (countStaffConversations bilan bir xil) */
  total: number;
  /** withTotals: barcha suhbatlardagi o'qilmaganlar yig'indisi (sumStaffUnread bilan bir xil) */
  unread: number;
}

/**
 * Ro'yxatning faqat imzosi (qatorlarsiz) — polling uchun: o'zgarmagan ro'yxat ~100 bayt trafik.
 * `withTotals` (bootstrap) — shu so'rovning o'zida jami suhbatlar soni va o'qilmaganlar yig'indisi ham.
 */
export async function staffListState(
  staffId: number,
  activeId: number | null,
  limit: number,
  withTotals = false,
): Promise<StaffListState> {
  const sql = db();
  const rows = await sql<{ list_sig: string; listed: number; total: number | null; unread: number | null }[]>`
    with ${staffListCte(sql, staffId, limit)}
    ${
      withTotals
        ? sql`, totals as (
            select count(*) filter (where last_message_at is not null)::int as total,
              coalesce(sum(unread_staff), 0)::int as unread
            from conversations where staff_id = ${staffId})`
        : sql``
    }
    select ${staffListSigExpr(sql, activeId)} as list_sig, count(*)::int as listed,
      ${withTotals ? sql`(select total from totals) as total, (select unread from totals) as unread` : sql`null::int as total, null::int as unread`}
    from list l`;
  const r = rows[0]!;
  return { sig: r.list_sig, listed: r.listed, total: r.total ?? 0, unread: r.unread ?? 0 };
}

/** Ro'yxat qatori (staffConvSummary uchun). */
export type StaffConvRow = StaffConvSummarySource;

/**
 * Ro'yxat qatorlari va ularning imzosi BITTA so'rovda (bir xil snapshot — imzo aynan qaytgan qatorlarga mos).
 * Imzo faqat birinchi qatorda keladi (bo'sh ro'yxatda — yagona "bo'sh" qatorda).
 */
export async function staffListRows(
  staffId: number,
  activeId: number | null,
  limit: number,
): Promise<{ rows: StaffConvRow[]; sig: string }> {
  const sql = db();
  const rows = await sql<(StaffConvRow & { list_sig: string | null })[]>`
    with ${staffListCte(sql, staffId, limit)}
    select l.id, l.staff_id, l.client_id, l.last_message_at, l.last_message_preview, l.last_sender, l.unread_staff,
      l.client_first_name, l.client_last_name, l.client_username,
      case when l.rn is null or l.rn = 1 then s.list_sig end as list_sig
    from (select ${staffListSigExpr(sql, activeId)} as list_sig from list l) s
    left join list l on true
    order by l.rn`;
  const sig = rows[0]?.list_sig;
  if (!sig) throw new Error("staffListRows: ro'yxat imzosi qaytmadi");
  return { rows: rows.filter((r) => r.id != null).map(({ list_sig: _s, ...r }) => r), sig };
}

/**
 * Mijozning barcha suhbatlari (bo'sh suhbatlar ham), xodim ma'lumotlari va mavjudligi bilan.
 * Mijozda har bir xodim uchun ko'pi bilan bitta suhbat bo'ladi, shuning uchun ro'yxat kichik.
 */
export async function listClientConvRows(clientId: number, limit = 200): Promise<ClientConvRow[]> {
  const sql = db();
  return sql<ClientConvRow[]>`
    select c.*,
      s.full_name as staff_full_name,
      s.role as staff_role,
      s.position as staff_position,
      s.is_online as staff_is_online,
      s.photo_file_id as staff_photo_file_id,
      s.photo_unique_id as staff_photo_unique_id,
      s.client_photo_file_id as staff_client_photo_file_id,
      (s.deleted_at is not null) as staff_deleted,
      (s.is_active and s.deleted_at is null and s.tg_user_id is not null) as staff_available
    from conversations c
    join staff s on s.id = c.staff_id
    where c.client_id = ${clientId}
    order by c.last_message_at desc nulls last, c.id desc
    limit ${limit}`;
}

/** ILIKE uchun maxsus belgilarni (\ % _) ekranlash. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
}

/**
 * Xodimning suhbatlari sahifalab va qidiruv bilan (Mini App "Chatlar" ro'yxati uchun).
 * Maxfiylik: faqat `c.staff_id = staffId` — boshqa xodimlarning suhbatlari hech qachon qaytmaydi.
 * Qidiruv: mijozning to'liq ismi, @username, oxirgi xabar ko'rinishi va Telegram ID (raqam bo'lsa).
 */
export async function searchStaffConvRows(
  staffId: number,
  opts: { limit: number; offset: number; search?: string },
): Promise<ConversationView[]> {
  const sql = db();
  const q = (opts.search ?? '').replace(/\s+/g, ' ').trim();
  const like = likePattern(q);
  const userLike = likePattern(q.replace(/^@+/, ''));
  const tgId = /^\d{1,15}$/.test(q) ? Number(q) : null;
  const filter = q
    ? sql`and (
        (cl.first_name || ' ' || coalesce(cl.last_name, '')) ilike ${like}
        or coalesce(cl.username, '') ilike ${userLike}
        or coalesce(c.last_message_preview, '') ilike ${like}
        ${tgId != null && Number.isSafeInteger(tgId) ? sql`or c.client_id = ${tgId}` : sql``}
      )`
    : sql``;
  return sql<ConversationView[]>`
    select c.*,
      s.full_name as staff_full_name, s.role as staff_role, s.position as staff_position,
      s.photo_unique_id as staff_photo_unique_id, s.is_online as staff_is_online,
      cl.first_name as client_first_name, cl.last_name as client_last_name, cl.username as client_username
    from conversations c
    join staff s on s.id = c.staff_id
    join clients cl on cl.tg_user_id = c.client_id
    where c.staff_id = ${staffId} and c.last_message_at is not null
      ${filter}
    order by c.last_message_at desc, c.id desc
    limit ${opts.limit} offset ${opts.offset}`;
}

/** Xodimning barcha suhbatlaridagi o'qilmagan xabarlar yig'indisi (ro'yxat 100 ta bilan cheklangan bo'lsa ham to'g'ri). */
export async function sumStaffUnread(staffId: number): Promise<number> {
  const rows = await db()<{ n: number }[]>`
    select coalesce(sum(unread_staff), 0)::int as n from conversations where staff_id = ${staffId}`;
  return rows[0]?.n ?? 0;
}

/**
 * Mijoz bot chatida yozgan xabarlari hozir kimga boradi: aktiv suhbatning xodimi (mavjud bo'lsa).
 * Suhbat mijozga tegishli bo'lmasa yoki xodim endi xabar qabul qila olmasa — null.
 */
export async function activeRouteStaff(clientId: number, conversationId: number): Promise<Staff | null> {
  const rows = await db()<Staff[]>`
    select s.* from conversations c
    join staff s on s.id = c.staff_id
    where c.id = ${conversationId} and c.client_id = ${clientId}
      and s.is_active and s.deleted_at is null and s.tg_user_id is not null`;
  return rows[0] ?? null;
}

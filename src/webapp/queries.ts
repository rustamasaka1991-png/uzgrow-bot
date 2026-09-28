// Mini App uchun qo'shimcha (faqat o'qish) so'rovlari. Umumiy funksiyalar src/repo.ts da.
import { db } from '../db.js';
import type { ConversationView, Message, Staff } from '../types.js';
import type { ClientConvRow } from './dto.js';

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

/**
 * Suhbatda `since` dan keyin tahrirlangan xabarlar (ochiq chat tahrirlarni ko'rishi uchun; sync har ~3 s da).
 * Indeks: messages_edited_idx (conversation_id, edited_at) where edited_at is not null.
 */
export async function listEditedMessages(conversationId: number, since: Date, limit = 50): Promise<Message[]> {
  return db()<Message[]>`
    select * from messages
    where conversation_id = ${conversationId} and edited_at is not null and edited_at > ${since}
    order by edited_at asc
    limit ${limit}`;
}

/**
 * Berilgan (ilgari yetkazilmagan) xabarlardan qaysilari endi suhbatdoshga yetkazilgan — Mini App dagi ❗ belgisini
 * olib tashlash uchun (masalan, xodim botga qaytganda navbat yetkazildi). Faqat shu suhbat xabarlari.
 */
export async function deliveredAmong(conversationId: number, ids: readonly number[]): Promise<Message[]> {
  if (!ids.length) return [];
  const sql = db();
  return sql<Message[]>`
    select * from messages
    where conversation_id = ${conversationId} and id = any(${sql.array([...ids])}::bigint[])
      and ((sender = 'client' and staff_chat_msg_id is not null) or (sender = 'staff' and client_chat_msg_id is not null))`;
}

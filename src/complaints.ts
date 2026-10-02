// Mijozlarning operator/menejerlar ustidan shikoyatlari.
// Oqim: mijoz /shikoyat → xodimni tanlaydi (draft) → keyingi matnli xabari shikoyat matni bo'ladi (xodimga YUBORILMAYDI)
// → ROP va developerlarga xodimlar boti orqali bildirishnoma → ROP panelida ko'rib chiqiladi va "hal qilindi" deb belgilanadi.
import { InlineKeyboard } from 'grammy';
import { db } from './db.js';
import { panelRecipients } from './roles.js';
import { clientApi, staffApi } from './tg.js';
import type { Role } from './types.js';
import { clientName, esc, formatTime, roleLabel, tgErrorDescription, truncate } from './util.js';

/** Mijoz xodimni tanlagandan keyin shikoyat matnini shu vaqt ichida yozishi kerak. */
export const COMPLAINT_DRAFT_TTL_MIN = 30;
/** Shikoyat matni chegarasi. */
export const COMPLAINT_TEXT_MAX = 2000;

export type ComplaintStatus = 'draft' | 'new' | 'resolved';

export interface Complaint {
  id: number;
  client_id: number;
  staff_id: number;
  conversation_id: number | null;
  text: string | null;
  status: ComplaintStatus;
  created_at: Date;
  submitted_at: Date | null;
  resolved_at: Date | null;
  resolved_by: number | null;
}

export interface ComplaintView extends Complaint {
  client_first_name: string;
  client_last_name: string | null;
  client_username: string | null;
  staff_full_name: string;
  staff_role: Role;
  /**
   * Shikoyat qilingan xodimning HOZIRGI Telegram ID si (bog'lanmagan bo'lsa null). U ROP/developer ham bo'lishi
   * mumkin — o'z ustidagi shikoyatni hech qachon olmaydi, ko'rmaydi va hal qila olmaydi.
   */
  staff_tg_user_id: number | null;
}

const VIEW = (sql: ReturnType<typeof db>) => sql`
  select c.*, cl.first_name as client_first_name, cl.last_name as client_last_name, cl.username as client_username,
    s.full_name as staff_full_name, s.role as staff_role, s.tg_user_id as staff_tg_user_id
  from complaints c
  join clients cl on cl.tg_user_id = c.client_id
  join staff s on s.id = c.staff_id`;

/** Yangi draft (mijozning boshqa draftlari o'chiriladi). Suhbat bo'lsa unga bog'lanadi. */
export async function startComplaintDraft(clientId: number, staffId: number): Promise<Complaint> {
  // Mijoz bo'yicha qulf: ikki xodim tugmasi bir vaqtda bosilsa ham mijozda bitta draft qoladi (oxirgisi)
  return db().begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('complaint-draft'), hashtext(${String(clientId)}))`;
    await tx`delete from complaints where client_id = ${clientId} and status = 'draft'`;
    const rows = await tx<Complaint[]>`
      insert into complaints (client_id, staff_id, conversation_id, status)
      values (
        ${clientId}, ${staffId},
        (select id from conversations where client_id = ${clientId} and staff_id = ${staffId}),
        'draft'
      )
      returning *`;
    return rows[0]!;
  }) as Promise<Complaint>;
}

/** Mijozning amaldagi drafti (30 daqiqadan eski bo'lsa — yo'q hisoblanadi). */
export async function getActiveDraft(clientId: number): Promise<Complaint | null> {
  const rows = await db()<Complaint[]>`
    select * from complaints
    where client_id = ${clientId} and status = 'draft'
      and created_at > now() - make_interval(mins => ${COMPLAINT_DRAFT_TTL_MIN})
    order by id desc limit 1`;
  return rows[0] ?? null;
}

export async function cancelComplaintDrafts(clientId: number): Promise<boolean> {
  const rows = await db()`delete from complaints where client_id = ${clientId} and status = 'draft' returning id`;
  return rows.length > 0;
}

/**
 * Draftni darhol «muddati o'tgan» qilish — shikoyat so'rovi mijozga ko'rsatildimi, noma'lum bo'lganda (so'rovni
 * yuborishda xato). Mijozning keyingi xabari na shikoyat bo'lib rahbariyatga, na xodimga ketadi: u hech kimga
 * yuborilmaydi va mijozga CT.expired izohi (qayta yuborsa — xodimga, shikoyat uchun — /shikoyat).
 */
export async function expireComplaintDrafts(clientId: number): Promise<void> {
  await db()`
    update complaints set created_at = now() - make_interval(mins => ${COMPLAINT_DRAFT_TTL_MIN + 1})
    where client_id = ${clientId} and status = 'draft'`;
}

/** Draftni yuborilgan shikoyatga aylantirish (faqat shu mijozning drafti). */
export async function submitComplaint(draftId: number, clientId: number, text: string): Promise<ComplaintView | null> {
  const body = truncate(text.trim(), COMPLAINT_TEXT_MAX);
  if (!body) return null;
  const sql = db();
  // Shu bilan birga mijozning boshqa draftlari ham o'chiriladi: xodimni tanlash tugmasi bir vaqtda ikki marta bosilsa
  // ikkinchi draft qolib ketib, mijozning KEYINGI (xodimga mo'ljallangan) xabarini ham shikoyat qilib yubormasin
  // Ko'rinish (mijoz/xodim ismlari) shu bitta so'rovda: holat 'new' bo'lib commit qilingandan keyin ALOHIDA so'rov
  // xato bersa, mijoz «qayta urinib ko'ring» ni ko'rib shikoyatini qayta yuborardi — draft endi yo'q, matn esa
  // odatdagi xabar bo'lib ayblangan xodimning o'ziga ketib qolardi
  const rows = await sql<ComplaintView[]>`
    with sub as (
      update complaints set status = 'new', text = ${body}, submitted_at = now()
      where id = ${draftId} and client_id = ${clientId} and status = 'draft'
      returning *
    ), others as (
      delete from complaints
      where client_id = ${clientId} and status = 'draft' and id <> ${draftId} and exists (select 1 from sub)
      returning id
    )
    select sub.*, cl.first_name as client_first_name, cl.last_name as client_last_name, cl.username as client_username,
      s.full_name as staff_full_name, s.role as staff_role, s.tg_user_id as staff_tg_user_id
    from sub
    join clients cl on cl.tg_user_id = sub.client_id
    join staff s on s.id = sub.staff_id`;
  return rows[0] ?? null;
}

/**
 * Yuborilgan (hali hal qilinmagan) shikoyatga mijozning qo'shimcha matni (shikoyatdan keyin darhol yozilgan
 * xabarlar — Telegram bo'lib yuborgan uzun matn, isbot izohi va h.k.). Umumiy uzunlik COMPLAINT_TEXT_MAX bilan
 * cheklanadi. Qo'shilmasa (hal qilingan, boshqa mijozniki, matn to'lgan) null.
 */
export async function appendComplaintText(id: number, clientId: number, text: string): Promise<ComplaintView | null> {
  const body = text.trim();
  if (!body || !Number.isSafeInteger(id)) return null;
  const sql = db();
  // Ko'rinish shu bitta so'rovda (commitdan keyingi alohida so'rov xatosi «qayta urinib ko'ring» bo'lib chiqmasin)
  const rows = await sql<ComplaintView[]>`
    with a as (
      update complaints set text = left(coalesce(text, '') || E'\n\n' || ${body}, ${COMPLAINT_TEXT_MAX})
      where id = ${id} and client_id = ${clientId} and status = 'new'
        and char_length(coalesce(text, '')) < ${COMPLAINT_TEXT_MAX}
      returning *
    )
    select a.*, cl.first_name as client_first_name, cl.last_name as client_last_name, cl.username as client_username,
      s.full_name as staff_full_name, s.role as staff_role, s.tg_user_id as staff_tg_user_id
    from a
    join clients cl on cl.tg_user_id = a.client_id
    join staff s on s.id = a.staff_id`;
  return rows[0] ?? null;
}

export async function getComplaintView(id: number): Promise<ComplaintView | null> {
  if (!Number.isSafeInteger(id)) return null;
  const sql = db();
  const rows = await sql<ComplaintView[]>`${VIEW(sql)} where c.id = ${id} and c.status <> 'draft'`;
  return rows[0] ?? null;
}

/**
 * excludeStaffTgId — ko'ruvchining Telegram ID si: uning O'Z ustidagi shikoyatlar ro'yxatda/sonda yo'q
 * (ROP/developer xodim profiliga ham ega bo'lishi mumkin).
 */
export async function listComplaints(
  opts: { status?: 'new' | 'resolved' | 'all'; limit?: number; offset?: number; excludeStaffTgId?: number } = {},
): Promise<ComplaintView[]> {
  const sql = db();
  const status = opts.status ?? 'all';
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  return sql<ComplaintView[]>`
    ${VIEW(sql)}
    where ${status === 'all' ? sql`c.status in ('new', 'resolved')` : sql`c.status = ${status}`}
      ${opts.excludeStaffTgId != null ? sql`and s.tg_user_id is distinct from ${opts.excludeStaffTgId}` : sql``}
    order by (c.status = 'new') desc, c.submitted_at desc, c.id desc
    limit ${limit} offset ${offset}`;
}

export async function countComplaints(
  status: 'new' | 'resolved' | 'all' = 'all',
  excludeStaffTgId?: number,
): Promise<number> {
  const sql = db();
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from complaints c
    where ${status === 'all' ? sql`c.status in ('new', 'resolved')` : sql`c.status = ${status}`}
      ${excludeStaffTgId != null
        ? sql`and not exists (select 1 from staff s where s.id = c.staff_id and s.tg_user_id = ${excludeStaffTgId})`
        : sql``}`;
  return rows[0]?.n ?? 0;
}

/**
 * "Hal qilindi" deb belgilash. Allaqachon hal qilingan bo'lsa — yoki hal qilmoqchi bo'lgan odam shikoyat qilingan
 * xodimning o'zi bo'lsa (ROP/developer xodim profiliga ham ega) — null: o'z ustidagi shikoyatni hech kim yopa olmaydi.
 * Ko'rinish shu bitta so'rovda (commitdan keyingi alohida so'rov xatosi «hal qilinmadi» deb ko'rinmasin).
 */
export async function resolveComplaint(id: number, byTgUserId: number): Promise<ComplaintView | null> {
  const rows = await db()<ComplaintView[]>`
    with r as (
      update complaints set status = 'resolved', resolved_at = now(), resolved_by = ${byTgUserId}
      where id = ${id} and status = 'new'
        and not exists (select 1 from staff s where s.id = complaints.staff_id and s.tg_user_id = ${byTgUserId})
      returning *
    )
    select r.*, cl.first_name as client_first_name, cl.last_name as client_last_name, cl.username as client_username,
      s.full_name as staff_full_name, s.role as staff_role, s.tg_user_id as staff_tg_user_id
    from r
    join clients cl on cl.tg_user_id = r.client_id
    join staff s on s.id = r.staff_id`;
  return rows[0] ?? null;
}

/** Ko'ruvchi shu shikoyat qilingan xodimning o'zimi (o'z ustidagi shikoyatni ko'rmaydi / hal qilmaydi). */
export function isComplaintSubject(c: Pick<ComplaintView, 'staff_tg_user_id'>, viewerTgId: number | undefined): boolean {
  return c.staff_tg_user_id != null && viewerTgId != null && Number(c.staff_tg_user_id) === Number(viewerTgId);
}

/** Shikoyat kartasi matni (HTML, xodimlar botida ROP/developer uchun). */
export function complaintCardHtml(c: ComplaintView): string {
  const client = clientName({ first_name: c.client_first_name, last_name: c.client_last_name });
  const lines = [
    `⚠️ <b>Shikoyat #${c.id}</b> · ${c.status === 'new' ? '🆕 yangi' : '✅ hal qilingan'}`,
    '',
    `👤 Mijoz: <b>${esc(client)}</b>${c.client_username ? ` (@${esc(c.client_username)})` : ''} · ID <code>${c.client_id}</code>`,
    `🧑‍💼 Xodim: <b>${esc(c.staff_full_name)}</b> (${roleLabel(c.staff_role)})`,
    `🕐 ${esc(formatTime(c.submitted_at ?? c.created_at))}`,
    '',
    `💬 ${esc(truncate(c.text ?? '', 3000))}`,
  ];
  if (c.status === 'resolved' && c.resolved_at) lines.push('', `✅ Hal qilindi: ${esc(formatTime(c.resolved_at))}`);
  return lines.join('\n');
}

/**
 * Shikoyat bildirishnomasini oluvchilar: ROP va developerlar, shikoyat qilingan xodimning O'ZIDAN tashqari (u ham
 * ROP/developer bo'lishi mumkin). Hech kim qolmasa — ogohlantirish logga (shikoyat panelda baribir saqlanadi).
 */
async function complaintRecipients(c: ComplaintView): Promise<number[]> {
  const ids = (await panelRecipients('complaints')).filter((id) => !isComplaintSubject(c, id));
  if (!ids.length) {
    console.warn(
      `[complaints] shikoyat #${c.id}: bildirishnoma oluvchi yo'q (shikoyat qilingan xodimdan boshqa ROP/developer yo'q)`,
    );
  }
  return ids;
}

/** ROP va developerlarga yangi shikoyat haqida bildirishnoma (xatolar e'tiborsiz; ayblangan xodimga — hech qachon). */
export async function notifyNewComplaint(c: ComplaintView): Promise<void> {
  const api = staffApi();
  if (!api) return;
  const ids = await complaintRecipients(c);
  const kb = new InlineKeyboard().text("👁 Ko'rib chiqish", `cmpv:${c.id}`);
  await Promise.allSettled(
    ids.map((id) =>
      api
        .sendMessage(id, `🔔 <b>Yangi shikoyat!</b>\n\n${complaintCardHtml(c)}`, {
          parse_mode: 'HTML',
          reply_markup: kb,
          link_preview_options: { is_disabled: true },
        })
        .catch((e) => console.warn(`[complaints] ${id} ga bildirishnoma yuborilmadi:`, tgErrorDescription(e))),
    ),
  );
}

/** Shikoyatga mijozning qo'shimcha matni haqida qisqa bildirishnoma (xatolar e'tiborsiz; ayblangan xodimga — hech qachon). */
export async function notifyComplaintAddition(c: ComplaintView, added: string): Promise<void> {
  const api = staffApi();
  if (!api) return;
  const ids = await complaintRecipients(c);
  const kb = new InlineKeyboard().text("👁 Ko'rib chiqish", `cmpv:${c.id}`);
  const html =
    `📎 <b>Shikoyat #${c.id} ga qo'shimcha</b> (${esc(c.staff_full_name)} ustidan)\n\n` +
    `💬 ${esc(truncate(added.trim(), 1500))}`;
  await Promise.allSettled(
    ids.map((id) =>
      api
        .sendMessage(id, html, { parse_mode: 'HTML', reply_markup: kb, link_preview_options: { is_disabled: true } })
        .catch((e) => console.warn(`[complaints] ${id} ga qo'shimcha bildirishnomasi yuborilmadi:`, tgErrorDescription(e))),
    ),
  );
}

/** Mijozga shikoyati ko'rib chiqilgani haqida xabar (mijozlar boti orqali, xatolar e'tiborsiz). */
export async function notifyClientResolved(c: ComplaintView): Promise<void> {
  try {
    await clientApi().sendMessage(
      c.client_id,
      `✅ #${c.id}-sonli shikoyatingiz rahbariyat tomonidan ko'rib chiqildi. E'tiboringiz uchun rahmat!`,
    );
  } catch (e) {
    console.warn(`[complaints] mijozga (#${c.id}) xabar yuborilmadi:`, tgErrorDescription(e));
  }
}

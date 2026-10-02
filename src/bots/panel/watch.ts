// 👁 Chatlar kuzatuvi (admin, ROP, developer — barchasi): operator/menejerlarning
// suhbatlarini FAQAT O'QISH uchun ko'rish. Kuzatuvchiga hech qanday xabar kelmaydi
// (bildirishnoma ham, jonli nusxa ham yo'q) va u suhbatga yoza olmaydi —
// o'qilgan belgilari (unread_*) va aktiv suhbatlar ham o'zgarmaydi.
// Callbacklar: wtch:list:<sahifa>, wtch:staff:<id>:<sahifa>, wtch:conv:<id>:<beforeId>.
import { Composer, InlineKeyboard } from 'grammy';
import {
  clearState,
  countStaffConversations,
  getConversationView,
  getStaff,
  listAllStaff,
  listMessages,
  listStaffConversations,
} from '../../repo.js';
import { clientName, esc, oneLine } from '../../util.js';
import { buildTranscript } from '../staff/transcript.js';
import { afterSuccess, parseId, render, type StaffContext, type View } from '../staff/ui.js';
import { requirePerm, stale } from './access.js';

const STAFF_PAGE_SIZE = 10;
const CONV_PAGE_SIZE = 8;
const TRANSCRIPT_SIZE = 15;

/** Xodimlar ro'yxati (kuzatuv uchun). */
export async function watchStaffView(page: number): Promise<View> {
  const all = await listAllStaff();
  const pages = Math.max(1, Math.ceil(all.length / STAFF_PAGE_SIZE));
  const p = Math.min(Math.max(0, Math.trunc(page) || 0), pages - 1);
  const lines = [
    '👁 <b>Chatlar kuzatuvi</b>',
    '',
    "Operator va menejerlarning suhbatlarini faqat o'qish uchun kuzating.",
    '<i>🔒 Sizga ularning xabarlari kelmaydi — faqat kirib o\u2018qiysiz.</i>',
    '',
  ];
  if (!all.length) {
    lines.push("Hozircha xodimlar yo'q.");
  } else {
    lines.push(`Xodimni tanlang 👇 (${all.length})`);
  }
  const kb = new InlineKeyboard();
  for (const s of all.slice(p * STAFF_PAGE_SIZE, (p + 1) * STAFF_PAGE_SIZE)) {
    const state = s.tg_user_id != null ? (s.is_active ? '🟢' : '🚫') : '⏳';
    kb.text(`${state} ${oneLine(s.full_name, 32)}`, `wtch:staff:${s.id}:0`).row();
  }
  if (pages > 1) {
    if (p > 0) kb.text('⬅️', `wtch:list:${p - 1}`);
    kb.text(`${p + 1}/${pages}`, 'noop');
    if (p < pages - 1) kb.text('➡️', `wtch:list:${p + 1}`);
    kb.row();
  }
  kb.text('⬅️ Admin panel', 'adm:home');
  return { text: lines.join('\n'), keyboard: kb };
}

/** Bitta xodimning suhbatlari (faqat xabari borlari). */
export async function watchConvsView(staffId: number, page: number): Promise<View | null> {
  const s = await getStaff(staffId);
  if (!s || s.deleted_at) return null;
  const total = await countStaffConversations(s.id);
  const pages = Math.max(1, Math.ceil(total / CONV_PAGE_SIZE));
  const p = Math.min(Math.max(0, Math.trunc(page) || 0), pages - 1);
  const list = total ? await listStaffConversations(s.id, { limit: CONV_PAGE_SIZE, offset: p * CONV_PAGE_SIZE }) : [];
  const lines = [
    `👁 <b>${esc(oneLine(s.full_name, 40))}</b> — chatlari (${total})`,
    '<i>🔒 Faqat o\u2018qish uchun</i>',
    '',
  ];
  if (!list.length) lines.push("Bu xodimda hali suhbatlar yo'q.");
  else lines.push('Suhbatni tanlang 👇', '<i>🔴 — o\u2018qilmagan xabarlar (xodim o\u2018qimagan)</i>');
  const kb = new InlineKeyboard();
  for (const v of list) {
    const unread = v.unread_staff > 0 ? `🔴${v.unread_staff} ` : '';
    const name = oneLine(clientName({ first_name: v.client_first_name, last_name: v.client_last_name }), 24);
    const preview = oneLine(v.last_message_preview, 26);
    kb.text(`${unread}👤 ${name}${preview ? ' · ' + preview : ''}`, `wtch:conv:${v.id}:0`).row();
  }
  if (pages > 1) {
    if (p > 0) kb.text('⬅️', `wtch:staff:${s.id}:${p - 1}`);
    kb.text(`${p + 1}/${pages}`, 'noop');
    if (p < pages - 1) kb.text('➡️', `wtch:staff:${s.id}:${p + 1}`);
    kb.row();
  }
  kb.text('⬅️ Xodimlar', 'wtch:list:0');
  return { text: lines.join('\n'), keyboard: kb };
}

/** Suhbat tarixi — faqat o'qish (o'qilgan belgilari o'zgarmaydi). */
export async function watchTranscriptView(conversationId: number, beforeId: number | null): Promise<View | null> {
  const v = await getConversationView(conversationId);
  if (!v) return null;
  const rows = await listMessages(v.id, {
    ...(beforeId ? { beforeId } : {}),
    limit: TRANSCRIPT_SIZE + 1,
  });
  const more = rows.length > TRANSCRIPT_SIZE;
  const msgs = more ? rows.slice(rows.length - TRANSCRIPT_SIZE) : rows;
  const client = oneLine(clientName({ first_name: v.client_first_name, last_name: v.client_last_name }), 40);
  const staff = oneLine(v.staff_full_name, 40);
  const header =
    `👁 <b>${esc(staff)}</b> ↔ 👤 <b>${esc(client)}</b>${beforeId ? ' (oldingi xabarlar)' : ''}\n` +
    "<i>🔒 Faqat o'qish uchun — javob yozib bo'lmaydi</i>";
  const t = buildTranscript(
    msgs,
    { client: `👤 <b>${esc(client)}</b>`, staff: `🧑‍💼 <b>${esc(staff)}</b>`, bot: '🤖 <i>Avto-javob</i>' },
    {
      header,
      hasMore: more,
      empty: beforeId ? "<i>Bundan oldingi xabarlar yo'q.</i>" : "<i>Bu suhbatda xabarlar yo'q.</i>",
    },
  );
  const kb = new InlineKeyboard();
  if (t.hasMore && t.oldestId) kb.text('⬆️ Oldingi', `wtch:conv:${v.id}:${t.oldestId}`).row();
  if (beforeId) kb.text('⬇️ Eng yangilari', `wtch:conv:${v.id}:0`).row();
  kb.text('⬅️ Chatlar', `wtch:staff:${v.staff_id}:0`);
  return { text: t.text, keyboard: kb };
}

export const watchComposer = new Composer<StaffContext>();

watchComposer.callbackQuery(/^wtch:list:(\d{1,6})$/, async (ctx) => {
  if (!(await requirePerm(ctx, 'panel'))) return;
  await clearState('staff', ctx.from!.id);
  await ctx.answerCallbackQuery();
  await afterSuccess('kuzatuv ro\u2018yxati', async () => render(ctx, await watchStaffView(Number(ctx.match[1]))));
});

watchComposer.callbackQuery(/^wtch:staff:(\d{1,15}):(\d{1,6})$/, async (ctx) => {
  if (!(await requirePerm(ctx, 'panel'))) return;
  await clearState('staff', ctx.from!.id);
  const id = parseId(ctx.match[1]);
  if (!id) {
    await ctx.answerCallbackQuery({ text: "Xodim topilmadi (o'chirilgan bo'lishi mumkin)", show_alert: true });
    await render(ctx, await watchStaffView(0));
    return;
  }
  const view = await watchConvsView(id, Number(ctx.match[2]));
  if (!view) {
    await ctx.answerCallbackQuery({ text: "Xodim topilmadi (o'chirilgan bo'lishi mumkin)", show_alert: true });
    await render(ctx, await watchStaffView(0));
    return;
  }
  await ctx.answerCallbackQuery();
  await render(ctx, view);
});

watchComposer.callbackQuery(/^wtch:conv:(\d{1,15}):(\d{1,15})$/, async (ctx) => {
  if (!(await requirePerm(ctx, 'panel'))) return;
  await clearState('staff', ctx.from!.id);
  const id = parseId(ctx.match[1]);
  const before = ctx.match[2] === '0' ? null : parseId(ctx.match[2]);
  const view = id ? await watchTranscriptView(id, before) : null;
  if (!view) {
    await ctx.answerCallbackQuery({ text: 'Suhbat topilmadi', show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  await render(ctx, view);
});

watchComposer.callbackQuery(/^wtch:/, async (ctx) => {
  if (!(await requirePerm(ctx, 'panel'))) return;
  await stale(ctx);
});

// ⚠️ Shikoyatlar (ROP va developer): ro'yxat, karta, shikoyat qilingan suhbatni o'qish (faqat o'qish uchun —
// o'qilgan belgilari va aktiv suhbatlar o'zgarmaydi) va «hal qilindi» deb belgilash.
// Callbacklar: cmpl:<new|all>:<sahifa>, cmpv:<id>, cmpc:<id>:<beforeId>, cmpr:<id>.
import { Composer, InlineKeyboard } from 'grammy';
import {
  complaintCardHtml,
  countComplaints,
  getComplaintView,
  isComplaintSubject,
  listComplaints,
  notifyClientResolved,
  resolveComplaint,
  type ComplaintView,
} from '../../complaints.js';
import { clearState, getStaff, listMessages } from '../../repo.js';
import { clientName, esc, oneLine } from '../../util.js';
import { buildTranscript } from '../staff/transcript.js';
import { afterSuccess, parseId, render, type StaffContext, type View } from '../staff/ui.js';
import { requirePerm, stale } from './access.js';

export type ComplaintFilter = 'new' | 'all';

/** Ro'yxat sahifasidagi shikoyatlar soni. */
export const COMPLAINTS_PAGE_SIZE = 8;
/** Suhbat sahifasidagi xabarlar soni. */
export const COMPLAINT_TRANSCRIPT_SIZE = 15;

const EMPTY_TEXT = "Hozircha shikoyatlar yo'q 🎉";
const EMPTY_NEW_TEXT = "Yangi shikoyatlar yo'q 🎉";
/**
 * Shikoyat ko'ruvchining O'Z ustidan (ROP/developer xodim profiliga ham ega): uni ko'ra olmaydi, suhbatini o'qiy
 * olmaydi va hal qila olmaydi — shikoyatni rahbariyatning boshqa a'zosi ko'rib chiqadi.
 */
export const OWN_COMPLAINT_TEXT = "⛔ Bu shikoyat sizning ustingizdan — uni rahbariyatning boshqa a'zosi ko'rib chiqadi";

function clientNameOfComplaint(c: ComplaintView): string {
  return clientName({ first_name: c.client_first_name, last_name: c.client_last_name });
}

// ───────────────────────────── Ko'rinishlar ─────────────────────────────

/** viewerTgId — ko'ruvchi: uning o'z ustidagi shikoyatlar ro'yxatda ham, sonlarda ham yo'q. */
export async function complaintsListView(filter: ComplaintFilter, page: number, viewerTgId?: number): Promise<View> {
  const [nNew, nAll] = await Promise.all([countComplaints('new', viewerTgId), countComplaints('all', viewerTgId)]);
  const total = filter === 'new' ? nNew : nAll;
  const pages = Math.max(1, Math.ceil(total / COMPLAINTS_PAGE_SIZE));
  const p = Math.min(Math.max(0, Math.trunc(page) || 0), pages - 1);
  const list = total
    ? await listComplaints({
        status: filter,
        limit: COMPLAINTS_PAGE_SIZE,
        offset: p * COMPLAINTS_PAGE_SIZE,
        ...(viewerTgId != null ? { excludeStaffTgId: viewerTgId } : {}),
      })
    : [];

  const lines = [`⚠️ <b>Shikoyatlar</b> — 🆕 ${nNew} yangi · jami ${nAll}`, ''];
  if (!list.length) {
    lines.push(filter === 'new' && nAll > 0 ? EMPTY_NEW_TEXT : EMPTY_TEXT);
  } else {
    lines.push(
      filter === 'new' ? "🆕 Yangi shikoyatlar — ko'rib chiqish uchun tanlang 👇" : '📋 Barcha shikoyatlar — tanlang 👇',
      "<i>🆕 — yangi · ✅ — hal qilingan · xodim ← mijoz</i>",
    );
  }

  const kb = new InlineKeyboard();
  for (const c of list) {
    const icon = c.status === 'new' ? '🆕' : '✅';
    kb.text(
      `#${c.id} ${icon} ${oneLine(c.staff_full_name, 24)} ← ${oneLine(clientNameOfComplaint(c), 24)}`,
      `cmpv:${c.id}`,
    ).row();
  }
  if (pages > 1) {
    if (p > 0) kb.text('⬅️', `cmpl:${filter}:${p - 1}`);
    kb.text(`${p + 1}/${pages}`, 'noop');
    if (p < pages - 1) kb.text('➡️', `cmpl:${filter}:${p + 1}`);
    kb.row();
  }
  kb.text('🆕 Yangilar', 'cmpl:new:0').text('📋 Hammasi', 'cmpl:all:0').row();
  kb.text('⬅️ Admin panel', 'adm:home');
  return { text: lines.join('\n'), keyboard: kb };
}

export async function complaintCardView(c: ComplaintView, notice?: string): Promise<View> {
  const staff = await getStaff(c.staff_id);
  const staffState = !staff || staff.deleted_at
    ? "🗑 Xodim o'chirilgan"
    : staff.is_active
      ? '✅ Xodim faol'
      : '🚫 Xodim bloklangan';
  const parts: string[] = [];
  if (notice) parts.push(notice, '');
  parts.push(complaintCardHtml(c), '', `🧑‍💼 Holati: ${staffState}`);

  const kb = new InlineKeyboard();
  if (c.conversation_id) kb.text("💬 Suhbatni ko'rish", `cmpc:${c.id}:0`).row();
  if (c.status === 'new') kb.text('✅ Hal qilindi', `cmpr:${c.id}`).row();
  // Xodimni bloklash / o'chirish — uning kartasidan (admin paneli)
  if (staff && !staff.deleted_at) kb.text('🧑‍💼 Xodim kartasi', `adm:s:${staff.id}`).row();
  kb.text('⬅️ Shikoyatlar', 'cmpl:new:0');
  return { text: parts.join('\n'), keyboard: kb };
}

/** Shikoyat qilingan suhbat — faqat o'qish uchun (hech qanday o'qilgan belgisi / aktiv suhbat o'zgarmaydi). */
export async function complaintTranscriptView(c: ComplaintView, beforeId: number | null): Promise<View | null> {
  if (!c.conversation_id) return null;
  const rows = await listMessages(c.conversation_id, {
    ...(beforeId ? { beforeId } : {}),
    limit: COMPLAINT_TRANSCRIPT_SIZE + 1,
  });
  const more = rows.length > COMPLAINT_TRANSCRIPT_SIZE;
  const msgs = more ? rows.slice(rows.length - COMPLAINT_TRANSCRIPT_SIZE) : rows;
  const client = oneLine(clientNameOfComplaint(c), 40);
  const staff = oneLine(c.staff_full_name, 40);
  const header =
    `💬 <b>Shikoyat #${c.id}</b> — suhbat${beforeId ? ' (oldingi xabarlar)' : ''}\n` +
    `👤 ${esc(client)} ↔ 🧑‍💼 ${esc(staff)}\n` +
    "<i>🔒 Faqat o'qish uchun</i>";
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
  if (t.hasMore && t.oldestId) kb.text('⬆️ Oldingi', `cmpc:${c.id}:${t.oldestId}`).row();
  if (beforeId) kb.text('⬇️ Eng yangilari', `cmpc:${c.id}:0`).row();
  kb.text(`⬅️ Shikoyat #${c.id}`, `cmpv:${c.id}`);
  return { text: t.text, keyboard: kb };
}

// ───────────────────────────── Handlerlar ─────────────────────────────

export const complaintsComposer = new Composer<StaffContext>();

complaintsComposer.callbackQuery(/^cmpl:(new|all):(\d{1,6})$/, async (ctx) => {
  if (!(await requirePerm(ctx, 'complaints'))) return;
  // Navigatsiya kutilayotgan panel kiritmasini bekor qiladi (keyingi xabar kutilmaganda kiritma bo'lib qolmasin)
  await clearState('staff', ctx.from!.id);
  await ctx.answerCallbackQuery();
  await render(ctx, await complaintsListView(ctx.match[1] as ComplaintFilter, Number(ctx.match[2]), ctx.from!.id));
});

complaintsComposer.callbackQuery(/^cmpv:(\d{1,15})$/, async (ctx) => {
  if (!(await requirePerm(ctx, 'complaints'))) return;
  await clearState('staff', ctx.from!.id);
  const c = await loadComplaintOr(ctx, ctx.match[1]);
  if (!c) return;
  await ctx.answerCallbackQuery();
  await render(ctx, await complaintCardView(c));
});

complaintsComposer.callbackQuery(/^cmpc:(\d{1,15}):(\d{1,15})$/, async (ctx) => {
  if (!(await requirePerm(ctx, 'complaints'))) return;
  await clearState('staff', ctx.from!.id);
  const c = await loadComplaintOr(ctx, ctx.match[1]);
  if (!c) return;
  const before = ctx.match[2] === '0' ? null : parseId(ctx.match[2]);
  const view = await complaintTranscriptView(c, before);
  if (!view) {
    await ctx.answerCallbackQuery({ text: 'Bu shikoyatga bog\'langan suhbat topilmadi', show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  await render(ctx, view);
});

complaintsComposer.callbackQuery(/^cmpr:(\d{1,15})$/, async (ctx) => {
  if (!(await requirePerm(ctx, 'complaints'))) return;
  await clearState('staff', ctx.from!.id);
  // Avval yuklanadi: o'z ustidagi shikoyat — ⛔ (resolveComplaint SQL da ham rad etadi)
  const pre = await loadComplaintOr(ctx, ctx.match[1]);
  if (!pre) return;
  const resolved = await resolveComplaint(pre.id, ctx.from!.id);
  if (!resolved) {
    const c = await loadComplaintOr(ctx, ctx.match[1]);
    if (!c) return;
    await ctx.answerCallbackQuery({ text: 'Allaqachon hal qilingan' });
    await render(ctx, await complaintCardView(c));
    return;
  }
  await ctx.answerCallbackQuery({ text: '✅ Hal qilindi' });
  await notifyClientResolved(resolved).catch(() => {});
  // Shikoyat allaqachon «hal qilindi» — karta eng yaxshi urinish (umumiy xato matni chalg'itadi)
  await afterSuccess(`shikoyat #${resolved.id} kartasi`, async () => render(ctx, await complaintCardView(resolved)));
});

// Noto'g'ri ko'rinishdagi shikoyat tugmalari
complaintsComposer.callbackQuery(/^(cmpl|cmpv|cmpc|cmpr):/, async (ctx) => {
  if (!(await requirePerm(ctx, 'complaints'))) return;
  await stale(ctx);
});

/**
 * Shikoyatni yuklash; topilmasa — alert va ro'yxat. Ko'ruvchining O'Z ustidagi shikoyat (u ROP/developer va xodim
 * ham) — ⛔ alert va ro'yxat: kartasi, suhbati va «hal qilindi» unga hech qachon ochilmaydi (soxta callback ham).
 */
async function loadComplaintOr(ctx: StaffContext, idStr: string | undefined): Promise<ComplaintView | null> {
  const id = parseId(idStr);
  const c = id ? await getComplaintView(id) : null;
  if (c && !isComplaintSubject(c, ctx.from?.id)) return c;
  await ctx.answerCallbackQuery({ text: c ? OWN_COMPLAINT_TEXT : 'Shikoyat topilmadi', show_alert: true });
  await render(ctx, await complaintsListView('new', 0, ctx.from?.id));
  return null;
}

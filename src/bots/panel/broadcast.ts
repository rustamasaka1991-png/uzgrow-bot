// 📣 Mijozlarga ommaviy xabar (admin, ROP va developer): xabar yozish → oldindan ko'rish (aynan mijozlar ko'radigan
// ko'rinish — copyMessage) → tasdiqlash → bo'laklab yuborish (src/broadcast.ts) va jarayon xabari.
// Holatlar: {step:'broadcast'} → {step:'broadcast_confirm', content, srcMsgId}. Callbacklar: adm:bc (../admin.ts dan),
// bc:send, bc:r:<id> (yangilash), bc:x:<id> (to'xtatish), bc:go:<id> (to'xtab qolganini davom ettirish).
import { Composer, InlineKeyboard } from 'grammy';
import type { Message as TgMessage } from 'grammy/types';
import {
  BROADCAST_KINDS,
  cancelBroadcast,
  continueBroadcastInBackground,
  countBroadcastRecipients,
  createBroadcast,
  describeBroadcastContent,
  getBroadcast,
  isStalled,
  renderBroadcastProgress,
  runBroadcast,
  setBroadcastProgressMessage,
  type Broadcast,
  type BroadcastContent,
} from '../../broadcast.js';
import { remainingMs } from '../../deadline.js';
import { setState } from '../../repo.js';
import { can } from '../../roles.js';
import { MAX_DOWNLOAD_BYTES, extractContent } from '../../tg.js';
import { esc } from '../../util.js';
import {
  NO_ACCESS_TEXT,
  afterSuccess,
  callbackMessage,
  logError,
  parseId,
  render,
  sendHtml,
  stripKeyboard,
  type StaffContext,
  type View,
} from '../staff/ui.js';
import { requirePerm, stale } from './access.js';
import {
  casState,
  enterState,
  loadState,
  loadStateRow,
  repromptState,
  statePerm,
  type BroadcastConfirmState,
  type BroadcastState,
} from './state.js';

const UNSUPPORTED_TEXT =
  "Bu turdagi xabarni yuborib bo'lmaydi. Matn, rasm, video, GIF, fayl, audio yoki ovozli xabar yuboring.";
const TOO_BIG_TEXT = "Fayl juda katta — 20 MB gacha bo'lishi kerak.";

// ───────────────────────────── Ko'rinishlar ─────────────────────────────

export async function broadcastPromptView(error?: string): Promise<View> {
  const n = await countBroadcastRecipients();
  const lines = [
    '📣 <b>Mijozlarga xabar</b>',
    '',
    'Barcha mijozlarga yuboriladigan xabarni shu yerga yuboring: matn, rasm, video, GIF, fayl, audio yoki ovozli xabar (izoh bilan).',
    '',
    `👥 Qabul qiluvchilar: ${n} ta mijoz`,
  ];
  if (error) lines.push('', `⚠️ ${esc(error)}`);
  return { text: lines.join('\n'), keyboard: new InlineKeyboard().text('✖️ Bekor qilish', 'adm:cancel') };
}

function progressView(b: Broadcast): View {
  const v = renderBroadcastProgress(b);
  return { text: v.text, ...(v.markup ? { keyboard: v.markup } : {}) };
}

// ───────────────────────────── Yozish va oldindan ko'rish ─────────────────────────────

/** `adm:bc` — xabar yozish so'rovi (huquq chaqiruvchida tekshirilgan). */
export async function startBroadcast(ctx: StaffContext): Promise<void> {
  const st: BroadcastState = { step: 'broadcast' };
  await ctx.answerCallbackQuery();
  await enterState(ctx, st, await broadcastPromptView(), 'edit');
}

/** Telegram xabaridan ommaviy xabar mazmuni (qo'llab-quvvatlanmasa — xato matni). */
function broadcastContentOf(msg: TgMessage): { ok: true; content: BroadcastContent } | { ok: false; error: string } {
  const c = extractContent(msg);
  if (!c || !BROADCAST_KINDS.includes(c.kind)) return { ok: false, error: UNSUPPORTED_TEXT };
  if (c.kind === 'text' && !(c.text ?? '').trim()) return { ok: false, error: UNSUPPORTED_TEXT };
  if (c.kind !== 'text' && !c.fileId) return { ok: false, error: UNSUPPORTED_TEXT };
  if (c.fileSize && c.fileSize > MAX_DOWNLOAD_BYTES) return { ok: false, error: TOO_BIG_TEXT };
  const content: BroadcastContent = { kind: c.kind };
  if (c.text !== undefined) content.text = c.text;
  if (c.entities?.length) content.entities = c.entities;
  if (c.fileId) content.fileId = c.fileId;
  if (c.fileUniqueId) content.fileUniqueId = c.fileUniqueId;
  if (c.fileName) content.fileName = c.fileName;
  if (c.mimeType) content.mimeType = c.mimeType;
  if (c.fileSize) content.fileSize = c.fileSize;
  if (c.meta && Object.keys(c.meta).length) content.meta = c.meta;
  return { ok: true, content };
}

/**
 * `broadcast` (yoki `broadcast_confirm` — yangi xabar avvalgisini almashtiradi) holatidagi xabar: mazmun tekshiriladi,
 * xabarning aynan nusxasi (copyMessage) va tasdiqlash so'rovi ko'rsatiladi.
 */
export async function handleBroadcastInput(
  ctx: StaffContext,
  msg: TgMessage,
  st: BroadcastState | BroadcastConfirmState,
): Promise<void> {
  const uid = ctx.from!.id;
  const chatId = ctx.chat!.id;
  const parsed = broadcastContentOf(msg);
  if (!parsed.ok) {
    // Tasdiqlash bosqichida ham noto'g'ri xabar — yozish bosqichiga qaytamiz (eski oldindan ko'rish bekor)
    await repromptState(ctx, st, msg, await broadcastPromptView(parsed.error), (cur) => ({
      step: 'broadcast',
      ...(cur.ignoreGroup ? { ignoreGroup: cur.ignoreGroup } : {}),
    }));
    return;
  }
  const next: BroadcastConfirmState = {
    step: 'broadcast_confirm',
    content: parsed.content,
    srcMsgId: msg.message_id,
    // Albomning qolgan elementlari jimgina e'tiborsiz qoldiriladi (ommaviy xabar — bitta xabar)
    ...(msg.media_group_id ? { ignoreGroup: msg.media_group_id } : {}),
  };
  // Bir vaqtda kelgan ikkinchi xabar (albom) — faqat bittasi qabul qilinadi
  if (!(await casState(uid, st, next))) return;
  await stripKeyboard(ctx, st.promptMsgId);

  let copied = false;
  try {
    await ctx.api.copyMessage(chatId, chatId, msg.message_id);
    copied = true;
  } catch (e) {
    logError('ommaviy xabar oldindan ko\'rinishi (copyMessage)', e);
  }
  const n = await countBroadcastRecipients();
  const lines: string[] = [];
  if (!copied) lines.push(`👀 ${describeBroadcastContent(parsed.content)}`, '');
  if (msg.media_group_id) {
    lines.push("ℹ️ Albomdan faqat shu bitta fayl olindi — bir nechta faylni alohida xabarlar qilib yuboring.", '');
  }
  lines.push(`Yuqoridagi xabar <b>${n}</b> ta mijozga yuborilsinmi?`);
  const kb = new InlineKeyboard()
    .text('✅ Yuborish', 'bc:send')
    .text('✏️ Boshqasini yozish', 'adm:bc')
    .row()
    .text('✖️ Bekor qilish', 'adm:cancel');
  const m = await sendHtml(ctx, lines.join('\n'), { markup: kb });
  await casState(uid, next, { ...next, promptMsgId: m.message_id });
}

// ───────────────────────────── Yuborish va jarayon ─────────────────────────────

/** Bitta bo'lakni shu so'rov vaqt byudjeti ichida yuborish; tugamasa — keyingi bo'lak alohida chaqiruvda. */
async function runChunk(id: number): Promise<void> {
  const budgetMs = Math.max(5_000, Math.min(40_000, remainingMs() - 8_000));
  const r = await runBroadcast(id, { budgetMs });
  // Telegram 429: keyingi bo'lak retry_after o'tgach (qulf shu vaqtgacha ushlab turiladi); kursor siljimagan bo'lsa — hisoblanadi
  if (r.claimed && !r.finished) await continueBroadcastInBackground(id, { notBefore: r.retryAt, stalled: r.progressed ? 0 : 1 });
}

/** `bc:send` — tasdiqlash. Holat atomik olinadi: ikki marta bosilsa ham xabar faqat bir marta yuboriladi. */
async function onSend(ctx: StaffContext): Promise<void> {
  const uid = ctx.from!.id;
  const prompt = callbackMessage(ctx);
  if (!can(ctx.panelRole, 'broadcast')) {
    // Huquq olib tashlangan (masalan, ROP → admin): tugallanmagan ommaviy xabar bekor qilinadi
    const row = await loadStateRow(uid);
    if (row && statePerm(row.st) === 'broadcast' && (await casState(uid, row.st, null))) {
      await stripKeyboard(ctx, row.st.promptMsgId);
      if (prompt && prompt.message_id !== row.st.promptMsgId) await stripKeyboard(ctx, prompt.message_id);
    }
    await ctx.answerCallbackQuery({ text: NO_ACCESS_TEXT, show_alert: true });
    return;
  }
  const st = await loadState(uid);
  const mismatch =
    !st ||
    st.step !== 'broadcast_confirm' ||
    // Eski (almashtirilgan) oldindan ko'rish tugmasi — yangi xabarni yuborib yubormasin. Tasdiqlash so'rovi hali
    // yozilmagan (yangi xabar hozirgina qabul qilinib, oldindan ko'rinishi ko'rsatilmoqda) bo'lsa ham — eskirgan:
    // ROP hali ko'rmagan xabar yuborilib ketmasin
    !prompt ||
    st.promptMsgId !== prompt.message_id;
  if (mismatch) {
    await stale(ctx);
    if (prompt) await stripKeyboard(ctx, prompt.message_id);
    return;
  }
  if (!(await casState(uid, st, null))) {
    await stale(ctx);
    return;
  }
  let b: Broadcast;
  try {
    b = await createBroadcast(uid, st.content);
  } catch (e) {
    // Qayta urinish mumkin bo'lsin: tasdiqlash holati tiklanadi
    await setState('staff', uid, st).catch(() => {});
    throw e;
  }
  await ctx.answerCallbackQuery({ text: '📤 Yuborish boshlandi' });
  if (prompt) await stripKeyboard(ctx, prompt.message_id);
  // Ommaviy xabar allaqachon yaratilgan (tasdiqlash holati olingan): jarayon xabari chiqmasa ham u albatta
  // yuborilishi kerak. Bu yerdagi xato «⚠️ Xatolik… qayta urinib ko'ring» ga aylansa, ROP xabarni qayta yaratib,
  // mijozlar uni ikki marta olardi (birinchisi esa «pending» bo'lib qolib ketardi).
  await afterSuccess(`ommaviy xabar #${b.id} jarayoni xabari`, async () => {
    const view = progressView(b);
    const m = await sendHtml(ctx, view.text, view.keyboard ? { markup: view.keyboard } : {});
    await setBroadcastProgressMessage(b.id, ctx.chat!.id, m.message_id);
  });
  try {
    await runChunk(b.id);
  } catch (e) {
    logError(`ommaviy xabar #${b.id} yuborish bo'lagi`, e);
    // Umumiy «qayta urinib ko'ring» o'rniga — aniq yo'l: shu ommaviy xabarni davom ettirish (qayta yaratmaslik)
    await afterSuccess(`ommaviy xabar #${b.id} xato izohi`, () =>
      sendHtml(
        ctx,
        `⚠️ Ommaviy xabar #${b.id} yuborilishi to'xtab qoldi. Uni qayta yaratmang (mijozlar ikki marta oladi) — ` +
          '«🔄 Yangilash» bilan holatini ko\'ring va «▶️ Davom ettirish» bilan davom ettiring.',
        { markup: new InlineKeyboard().text('🔄 Yangilash', `bc:r:${b.id}`) },
      ),
    );
  }
}

async function loadBroadcastOr(ctx: StaffContext, idStr: string | undefined): Promise<Broadcast | null> {
  const id = parseId(idStr);
  const b = id ? await getBroadcast(id) : null;
  if (!b) await ctx.answerCallbackQuery({ text: 'Ommaviy xabar topilmadi', show_alert: true });
  return b;
}

/** `bc:r:<id>` — jarayon xabarini yangilash. */
async function onRefresh(ctx: StaffContext, idStr: string | undefined): Promise<void> {
  const b = await loadBroadcastOr(ctx, idStr);
  if (!b) return;
  await ctx.answerCallbackQuery({ text: '🔄 Yangilandi' });
  await render(ctx, progressView(b));
}

/** `bc:x:<id>` — to'xtatish. */
async function onStop(ctx: StaffContext, idStr: string | undefined): Promise<void> {
  const id = parseId(idStr);
  const b = id ? await cancelBroadcast(id) : null;
  if (!b) {
    await ctx.answerCallbackQuery({ text: 'Ommaviy xabar topilmadi', show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery({
    text: b.status === 'cancelled' ? "✖️ To'xtatildi" : '✅ Allaqachon yakunlangan',
  });
  await render(ctx, progressView(b));
}

/** `bc:go:<id>` — to'xtab qolgan (qulf muddati o'tgan) yuborishni shu so'rovda davom ettirish. */
async function onContinue(ctx: StaffContext, idStr: string | undefined): Promise<void> {
  const b = await loadBroadcastOr(ctx, idStr);
  if (!b) return;
  if (b.status === 'done' || b.status === 'cancelled') {
    await ctx.answerCallbackQuery({ text: b.status === 'done' ? '✅ Allaqachon yakunlangan' : "✖️ To'xtatilgan" });
    await render(ctx, progressView(b));
    return;
  }
  if (!isStalled(b)) {
    await ctx.answerCallbackQuery({ text: '⏳ Yuborish davom etmoqda' });
    await render(ctx, progressView(b));
    return;
  }
  await ctx.answerCallbackQuery({ text: '▶️ Davom ettirilmoqda…' });
  // Jarayon endi shu xabarda ko'rsatiladi
  const here = callbackMessage(ctx);
  if (here) await setBroadcastProgressMessage(b.id, here.chat.id, here.message_id);
  await runChunk(b.id);
}

export const broadcastComposer = new Composer<StaffContext>();

broadcastComposer.callbackQuery('bc:send', onSend);
broadcastComposer.callbackQuery(/^bc:(r|x|go):(\d{1,15})$/, async (ctx) => {
  if (!(await requirePerm(ctx, 'broadcast'))) return;
  const [, action, id] = ctx.match;
  if (action === 'r') return onRefresh(ctx, id);
  if (action === 'x') return onStop(ctx, id);
  return onContinue(ctx, id);
});
broadcastComposer.callbackQuery(/^bc:/, async (ctx) => {
  if (!(await requirePerm(ctx, 'broadcast'))) return;
  await stale(ctx);
});

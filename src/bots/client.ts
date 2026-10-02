// Mijozlar boti (@uzgroww_bot): juda sodda — mijoz xodimning shaxsiy havolasi (t.me/<bot>?start=<nom>) orqali
// kirsa, hech narsa tanlamasdan o'sha xodim bilan chat boshlanadi; oddiy /start da operator/menejer tanlanadi.
// Mini App (web_app) tugmalari va doimiy pastki klaviatura yo'q.
import { Bot, InputMediaBuilder, type Context } from 'grammy';
import type {
  ForceReply,
  InlineKeyboardMarkup,
  Message as TgMessage,
  ReplyKeyboardMarkup,
  ReplyKeyboardRemove,
  ReplyParameters,
} from 'grammy/types';
import {
  appendComplaintText,
  cancelComplaintDrafts,
  expireComplaintDrafts,
  getActiveDraft,
  notifyComplaintAddition,
  notifyNewComplaint,
  startComplaintDraft,
  submitComplaint,
  type ComplaintView,
} from '../complaints.js';
import { config } from '../config.js';
import { relayErrorText } from '../relay.js';
import {
  clearLegacyKeyboard,
  findConversationByClientReply,
  getConversation,
  getOrCreateConversation,
  getStaff,
  getStaffByLinkCode,
  isStaffAvailable,
  listAvailableStaff,
  listClientConversations,
  listMessages,
  markReadByClient,
  normalizeLinkCode,
  setClientActiveConversation,
  setClientBlocked,
  upsertClient,
} from '../repo.js';
import { welcomeText } from '../texts.js';
import { extractContent, retryOnFlood } from '../tg.js';
import type { Client, Conversation, Role, Staff } from '../types.js';
import { hitRateLimit, type RateRule } from '../webapp/guards.js';
import { dativeSuffix, describeError, esc, isNotModified, tgErrorCode, tgErrorDescription, truncate } from '../util.js';
import {
  COMPLAINT_ABANDONED_SEC,
  COMPLAINT_ADD_RULES,
  COMPLAINT_FOLLOWUP_SEC,
  COMPLAINT_RACE_GUARD_SEC,
  COMPLAINT_RATE_RULES,
  CT,
  complaintAcceptedText,
  complaintCancelMarkup,
  complaintFollowUpText,
  complaintPromptText,
  complaintSentPromptText,
  complaintStaffName,
  renderComplaintPicker,
} from './client/complaint.js';
import { withStaffPhoto } from './client/photo.js';
import {
  boundComplaintGuard,
  clearComplaintGuard,
  clearSelection,
  complaintTarget,
  conversationFromNamedStaff,
  conversationStaff,
  complaintDraftInfo,
  getComplaintMarks,
  guardApplies,
  hasComplaintDraft,
  heldItemFrom,
  holdMessages,
  isUnexpectedTarget,
  loadRouteInfo,
  markComplaintAlbum,
  recentContacts,
  relayQueue,
  setComplaintGuard,
  setComplaintPrompt,
  takeHeld,
  targetFromBotMessage,
  type ComplaintGuard,
  type ErrorReporter,
  type HeldItem,
  type QueueOutcome,
} from './client/routing.js';
import {
  BTN,
  HISTORY_PAGE_SIZE,
  REMOVE_KEYBOARD,
  T,
  activeChosenText,
  activeStartText,
  activeChosenToast,
  cardMarkup,
  cb,
  heldSentLine,
  helpText,
  linkWelcomeCaption,
  markup,
  neighbour,
  pickedText,
  redirectedNote,
  renderChats,
  renderChoose,
  renderStaffList,
  renderTranscript,
  roleRow,
  staffCaption,
  staffGoneText,
  staffName,
  switchedNote,
  tooFastText,
  undeliveredNote,
  writeToButton,
  type Rows,
} from './client/ui.js';

type ReplyMarkup = InlineKeyboardMarkup | ReplyKeyboardMarkup | ReplyKeyboardRemove | ForceReply;

// ───────────────────────────── Update holati (ctx ga bog'langan) ─────────────────────────────

/** Har bir update uchun bazadagi mijoz yozuvi. */
const ctxClients = new WeakMap<Context, Client>();
/** Javob berilgan callback query lar (har biriga faqat bir marta javob beriladi). */
const answeredCallbacks = new WeakSet<Context>();

function clientOf(ctx: Context): Client {
  const client = ctxClients.get(ctx);
  if (!client) throw new Error('Mijoz yuklanmagan (middleware tartibi buzilgan)');
  return client;
}

/** Callback query ga javob (bir marta; xatolar — masalan, "query is too old" — e'tiborsiz). */
async function answer(ctx: Context, text?: string, alert = false): Promise<void> {
  if (!ctx.callbackQuery || answeredCallbacks.has(ctx)) return;
  answeredCallbacks.add(ctx);
  try {
    await ctx.answerCallbackQuery(text ? { text: truncate(text, 200), show_alert: alert } : {});
  } catch (e) {
    console.warn('[client] answerCallbackQuery:', tgErrorDescription(e));
  }
}

// ───────────────────────────── Yuborish yordamchilari ─────────────────────────────

async function sendHtml(
  ctx: Context,
  text: string,
  replyMarkup?: ReplyMarkup,
  replyTo?: number,
): Promise<TgMessage> {
  const replyParameters: ReplyParameters | undefined = replyTo
    ? { message_id: replyTo, allow_sending_without_reply: true }
    : undefined;
  return ctx.reply(text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    ...(replyParameters ? { reply_parameters: replyParameters } : {}),
  });
}

function callbackMessageHasMedia(ctx: Context): boolean {
  const m = ctx.callbackQuery?.message;
  if (!m || m.date === 0) return false;
  return !!(m.photo || m.video || m.animation || m.document || m.audio || m.voice || m.sticker || m.video_note);
}

/**
 * Callback kelgan xabarni tahrirlash; iloji bo'lmasa (juda eski, o'chirilgan, rasmli xabar) — yangisini yuborish.
 * Rasmli karta ro'yxatga qaytganda karta o'chiriladi va ro'yxat yangi xabar sifatida yuboriladi.
 * replyMarkup berilmasa — tugmalar olib tashlanadi. Natija: ko'rsatilgan (tahrirlangan yoki yangi) xabar id si.
 */
async function editOrSend(ctx: Context, text: string, replyMarkup?: InlineKeyboardMarkup): Promise<number | undefined> {
  const current = ctx.callbackQuery?.message;
  if (current) {
    if (callbackMessageHasMedia(ctx)) {
      await ctx.deleteMessage().catch(() => {});
    } else {
      try {
        await ctx.editMessageText(text, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        });
        return current.message_id;
      } catch (e) {
        if (isNotModified(e)) return current.message_id;
        if (tgErrorCode(e) === 403) throw e;
        console.warn('[client] editMessageText bajarilmadi, yangi xabar yuboriladi:', tgErrorDescription(e));
      }
    }
  }
  return (await sendHtml(ctx, text, replyMarkup)).message_id;
}

async function showUploadAction(ctx: Context): Promise<void> {
  await ctx.replyWithChatAction('upload_photo').catch(() => {});
}

/**
 * Amal bajarilgandan KEYINGI bildirishnoma (xabar xodimga yetkazildi / navbatga saqlandi / shikoyat qabul qilindi,
 * keyin — izoh, tasdiq, rasm): eng yaxshi urinish. Xato faqat logga yoziladi va xato chegarasiga (handleError →
 * T.error «qayta urinib ko'ring») CHIQMAYDI — aks holda mijoz xabarini qayta yuboradi va xodim uni ikki marta oladi
 * (yoki shikoyat matni xodimning o'ziga ketib qoladi). Mijoz botni bloklagan bo'lsa (403) — odatdagidek belgilanadi.
 * Natija: fn qaytargan qiymat, xatoda undefined.
 */
async function afterSuccess<T>(ctx: Context, where: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    console.warn(`[client] update #${ctx.update.update_id}: ${where} (amal bajarilgan, xato e'tiborsiz):`, describeError(e));
    if (tgErrorCode(e) === 403 && ctx.from) await setClientBlocked(ctx.from.id, true).catch(() => {});
    return undefined;
  }
}

/** `committed` bo'lsa — afterSuccess (eng yaxshi urinish), aks holda odatdagidek (xato chegarasigacha). */
async function afterIf(ctx: Context, committed: boolean, where: string, fn: () => Promise<unknown>): Promise<void> {
  if (committed) await afterSuccess(ctx, where, fn);
  else await fn();
}

/**
 * Ketma-ket yetkazishda xabarma-xabar xato matni (mijozning asl xabariga javob qilib).
 * Eng yaxshi urinish: bu yerdagi xato qolgan xabarlarni yetkazishni to'xtatmasligi kerak.
 */
function botErrorReporter(ctx: Context): ErrorReporter {
  return async (html, replyTo) => {
    try {
      await sendHtml(ctx, html, undefined, replyTo);
    } catch (e) {
      console.warn('[client] xato xabarini yuborib bo\'lmadi:', tgErrorDescription(e));
    }
  };
}

/**
 * Eski mijozlarda v1 dagi doimiy pastki menyu (👨‍💻 Operatorlar / 👔 Menejerlar / 💬 Suhbatlarim / ℹ️ Yordam) qolgan.
 * U faqat `remove_keyboard` li xabar bilan yo'qoladi, inline tugmalar bilan esa bitta xabarda yuborib bo'lmaydi.
 * silent — joriy javobning o'zi `remove_keyboard` bilan yuborildi (faqat belgi olib tashlanadi); aks holda bir
 * martalik qisqa izoh yuboriladi (keyin — odatdagi javob). Yangi mijozlarda belgi yo'q — hech narsa qilinmaydi.
 */
async function dropLegacyKeyboard(ctx: Context, silent: boolean): Promise<void> {
  const client = clientOf(ctx);
  if (!client.legacy_keyboard) return;
  client.legacy_keyboard = false;
  const claimed = await clearLegacyKeyboard(client.tg_user_id).catch((e: unknown) => {
    console.warn('[client] clearLegacyKeyboard:', e);
    return false;
  });
  if (claimed && !silent) await sendHtml(ctx, T.legacyKeyboardRemoved, REMOVE_KEYBOARD);
}

// ───────────────────────────── Ekranlar ─────────────────────────────

/**
 * Oddiy /start (va /menu): BITTA xabar + [👨‍💻 Operatorlar] [👔 Menejerlar].
 * Mavjud xodim bilan faol suhbat bo'lsa — "Siz … bilan suhbatdasiz", aks holda salomlashuv matni.
 * note — oldidan qo'shiladigan izoh (masalan, havola bo'yicha xodim topilmadi).
 */
async function sendStart(ctx: Context, note?: string): Promise<void> {
  await dropLegacyKeyboard(ctx, false);
  const client = clientOf(ctx);
  let text: string | null = null;
  if (client.active_conversation_id != null) {
    const staff = await conversationStaff(client.active_conversation_id, client.tg_user_id);
    if (isStaffAvailable(staff)) text = activeStartText(staffName(staff));
  }
  if (text == null) text = esc(await welcomeText(client));
  if (note) text = `${note}\n\n${text}`;
  await sendHtml(ctx, text, markup([roleRow()]));
}

/** /help — qisqa matn; eski doimiy klaviatura (bo'lsa) olib tashlanadi. */
async function sendHelp(ctx: Context): Promise<void> {
  await sendHtml(ctx, helpText(), REMOVE_KEYBOARD);
  await dropLegacyKeyboard(ctx, true);
}

/** Endi ko'rsatilmaydigan eski buyruq yoki eski pastki menyu tugmasi: eski menyu (bo'lsa) olib tashlanadi. */
async function legacyStaffList(ctx: Context, role: Role): Promise<void> {
  await dropLegacyKeyboard(ctx, false);
  await showStaffList(ctx, role, 0, 'send');
}

async function legacyChats(ctx: Context): Promise<void> {
  await dropLegacyKeyboard(ctx, false);
  await showChats(ctx, 0, 'send');
}

async function showStaffList(ctx: Context, role: Role, page: number, mode: 'send' | 'edit'): Promise<void> {
  const staff = await listAvailableStaff(role);
  const view = renderStaffList(role, staff, page);
  if (mode === 'edit') await editOrSend(ctx, view.text, view.markup);
  else await sendHtml(ctx, view.text, view.markup);
}

/** Xodim kartasini yangi rasmli xabar sifatida yuborish (rasm umuman bo'lmasa — matnli karta). */
async function sendStaffCard(ctx: Context, staff: Staff): Promise<void> {
  const list = await listAvailableStaff(staff.role);
  const index = list.findIndex((s) => s.id === staff.id);
  const caption = staffCaption(staff);
  const kb = cardMarkup(staff, index, list.length);
  try {
    await withStaffPhoto(
      staff,
      (media) => ctx.replyWithPhoto(media, { caption, parse_mode: 'HTML', reply_markup: kb }),
      () => showUploadAction(ctx),
    );
  } catch (e) {
    if (tgErrorCode(e) === 403) throw e;
    console.error(`[client] xodim #${staff.id} kartasini rasm bilan yuborib bo'lmadi:`, tgErrorDescription(e));
    await sendHtml(ctx, caption, kb);
  }
}

async function showChats(ctx: Context, page: number, mode: 'send' | 'edit'): Promise<void> {
  const client = clientOf(ctx);
  const [convs, available] = await Promise.all([
    listClientConversations(client.tg_user_id, 200),
    listAvailableStaff(),
  ]);
  const availableIds = new Set(available.map((s) => s.id));
  // Faol suhbatning xodimi mavjud emas (o'chirib qo'yilgan/uzilgan): "faol" deb ko'rsatmaymiz va tozalaymiz
  const activeConv =
    client.active_conversation_id != null ? convs.find((c) => c.id === client.active_conversation_id) : undefined;
  if (activeConv && !availableIds.has(activeConv.staff_id)) {
    await setClientActiveConversation(client.tg_user_id, null);
    client.active_conversation_id = null;
  }
  const visible = convs.filter((c) => c.last_message_at != null || c.id === client.active_conversation_id);
  const view = renderChats(visible, client.active_conversation_id, availableIds, page);
  if (mode === 'edit') await editOrSend(ctx, view.text, view.markup);
  else await sendHtml(ctx, view.text, view.markup);
}

/** Suhbat tarixi (≤ 10 xabar). beforeId = 0 — eng oxirgilari. */
async function sendTranscript(
  ctx: Context,
  conv: Conversation,
  staff: Staff | null,
  beforeId: number,
  opts: { footer?: string; extraRows?: Rows } = {},
): Promise<void> {
  const rows = await listMessages(conv.id, {
    beforeId: beforeId > 0 ? beforeId : undefined,
    limit: HISTORY_PAGE_SIZE + 1,
  });
  const hasMore = rows.length > HISTORY_PAGE_SIZE;
  const messages = hasMore ? rows.slice(rows.length - HISTORY_PAGE_SIZE) : rows;
  const view = renderTranscript({ staff, messages, hasMore, older: beforeId > 0, footer: opts.footer });
  const kb: Rows = [];
  if (view.hasMore && view.oldestShownId != null) {
    kb.push([cb('⬆️ Oldingi xabarlar', `hist:${conv.id}:${view.oldestShownId}`)]);
  }
  if (opts.extraRows) kb.push(...opts.extraRows);
  const reply = kb.some((r) => r.length) ? markup(kb) : undefined;
  await sendHtml(ctx, view.text, reply);
}

/**
 * Botda suhbat aniq tanlanganda (pick/conv/to): tanlov belgilanadi va xodim tanlanmaguncha
 * saqlab qo'yilgan xabarlar shu suhbatga yuboriladi.
 */
async function deliverHeldOnSelect(ctx: Context, client: Client, conv: Conversation): Promise<QueueOutcome | null> {
  // Mijoz shu xodimga yozishni o'zi aniq tanladi — shikoyatdan keyingi himoya (bo'lsa) olib tashlanadi
  await clearComplaintGuard(client.tg_user_id, conv.staff_id);
  const held = await takeHeld(client.tg_user_id, conv.id);
  if (!held.length) return null;
  return relayQueue(client, conv, held, botErrorReporter(ctx));
}

/**
 * Xodim mavjud emas: faol suhbat tozalanadi, yuborilmay qolgan xabarlar keyingi tanlov uchun saqlanadi.
 * current — mijozning hozirgi xabari (bo'lsa): albomning keyingi qismlariga qayta javob yozilmaydi.
 * Mijozning boshqa faol suhbati qolgan bo'lsa (Reply orqali mavjud bo'lmagan xodimga yozgan), hozirgi xabar
 * saqlanmaydi — aks holda u keyingi xabar bilan faol suhbatdagi boshqa xodimga so'ralmasdan ketib qolardi.
 * relayed — navbatdagi xabarlarning bir qismi xodimga allaqachon yetkazilgan (bildirishnoma — eng yaxshi urinish).
 */
async function onStaffUnavailable(
  ctx: Context,
  client: Client,
  conv: Conversation,
  rest: HeldItem[],
  current?: HeldItem,
  relayed = false,
): Promise<void> {
  if (client.active_conversation_id === conv.id) {
    await setClientActiveConversation(client.tg_user_id, null);
    client.active_conversation_id = null;
  }
  const holdCurrent = client.active_conversation_id == null;
  const toHold = holdCurrent ? rest : rest.filter((it) => it !== current);
  let saved = false;
  if (toHold.length) {
    const held = await holdMessages(client.tg_user_id, toHold);
    saved = held.saved;
    const albumPart =
      holdCurrent && !!current?.group && held.saved && held.count > toHold.length && held.prev?.group === current.group;
    if (albumPart) return;
  }
  let note = '';
  if (current && rest.includes(current) && !holdCurrent) note = T.notSentNote;
  else if (toHold.length) note = saved ? T.heldNote : T.resendNote;
  // Xabarlar saqlangan (yoki bir qismi yetkazilgan) bo'lsa — «qayta urinib ko'ring» takror xabarga olib keladi
  await afterIf(ctx, saved || relayed, "«xodim mavjud emas» izohi", () =>
    sendHtml(ctx, esc(relayErrorText('staff_unavailable')) + (note ? `\n\n${note}` : ''), markup([roleRow()]), current?.msgId),
  );
}

/** Tanlangan xodim bilan suhbatni faollashtirish. */
async function pickStaff(ctx: Context, staff: Staff): Promise<void> {
  const client = clientOf(ctx);
  // Mijoz xodimga yozishni tanladi — ochiq shikoyat drafti (bo'lsa) bekor qilinadi (keyingi xabar xodimga boradi)
  await dropComplaintDraft(ctx, client.tg_user_id);
  const conv = await getOrCreateConversation(client.tg_user_id, staff.id);
  await setClientActiveConversation(client.tg_user_id, conv.id);
  client.active_conversation_id = conv.id;
  await answer(ctx, T.picked);

  // Xodim tanlanmaguncha yozilgan xabarlar — endi shu xodimga (avto-javob relay ichida, bir marta)
  const out = await deliverHeldOnSelect(ctx, client, conv);
  if (out?.unavailable) {
    await onStaffUnavailable(ctx, client, conv, out.rest, undefined, out.sent > 0);
    return;
  }
  const existing = conv.last_message_at != null;
  // Saqlangan xabarlar yetkazilgan bo'lsa — keyingi tasdiq eng yaxshi urinish (takror yuborishga undamaslik uchun)
  await afterIf(ctx, (out?.sent ?? 0) > 0, 'xodim tanlangani haqidagi xabar', async () => {
    if (existing) await markReadByClient(conv.id);
    // Eski doimiy klaviatura (bo'lsa) shu xabar bilan olib tashlanadi — shuning uchun inline tugma yo'q
    const text = pickedText({ staff, existing, heldSent: out?.sent ?? 0, undelivered: !!out?.undelivered });
    await sendHtml(ctx, text, REMOVE_KEYBOARD);
    await dropLegacyKeyboard(ctx, true);
  });
}

/**
 * Xodimning shaxsiy havolasi (/start <nom> yoki /start staff_<id>) orqali kirish: hech narsa tanlatmasdan shu xodim
 * bilan suhbat faol qilinadi, tanlovgacha saqlangan xabarlar unga yuboriladi va BITTA xabar — xodim rasmi +
 * "Siz … bilan bog'landingiz" izohi (tugmasiz; eski doimiy klaviatura olib tashlanadi).
 */
async function startWithStaff(ctx: Context, staff: Staff): Promise<void> {
  const client = clientOf(ctx);
  const conv = await getOrCreateConversation(client.tg_user_id, staff.id);
  const existing = conv.last_message_at != null;
  await setClientActiveConversation(client.tg_user_id, conv.id);
  client.active_conversation_id = conv.id;

  // Xodim tanlanmaguncha yozilgan xabarlar — endi shu xodimga (avto-javob relay ichida, bir marta).
  // takeHeld shu suhbatni "botda aniq tanlangan" deb belgilaydi (keyingi xabarda "boshqa xodimga ketdi" izohi chiqmaydi).
  const out = await deliverHeldOnSelect(ctx, client, conv);
  if (out?.unavailable) {
    await onStaffUnavailable(ctx, client, conv, out.rest, undefined, out.sent > 0);
    return;
  }

  // Saqlangan xabarlar yetkazilgan bo'lsa — rasm/izoh eng yaxshi urinish (takror yuborishga undamaslik uchun)
  await afterIf(ctx, (out?.sent ?? 0) > 0, 'havola orqali ulanish xabari', async () => {
    if (existing) await markReadByClient(conv.id);
    const caption = linkWelcomeCaption({
      clientName: client.first_name,
      staff,
      existing,
      heldSent: out?.sent ?? 0,
      undelivered: !!out?.undelivered,
    });
    try {
      await withStaffPhoto(
        staff,
        (media) => ctx.replyWithPhoto(media, { caption, parse_mode: 'HTML', reply_markup: REMOVE_KEYBOARD }),
        () => showUploadAction(ctx),
      );
    } catch (e) {
      if (tgErrorCode(e) === 403) throw e;
      console.error(`[client] xodim #${staff.id} rasmini yuborib bo'lmadi, matn yuboriladi:`, tgErrorDescription(e));
      await sendHtml(ctx, caption, REMOVE_KEYBOARD);
    }
    await dropLegacyKeyboard(ctx, true);
  });
}

/** /start payload: `staff_<id>` (eski havolalar) yoki xodimning havola nomi (katta-kichik harf farqsiz). */
async function staffFromStartPayload(payload: string): Promise<Staff | null> {
  const code = normalizeLinkCode(payload);
  const legacy = /^staff_(\d{1,15})$/.exec(code);
  if (legacy) return getStaff(Number(legacy[1]));
  return getStaffByLinkCode(code);
}

// ───────────────────────────── Xabarlarni yo'naltirish ─────────────────────────────

/** Qo'llab-quvvatlanmaydigan, lekin foydalanuvchi yuborgan mazmun (servis xabarlar emas). */
const UNSUPPORTED_USER_CONTENT = [
  'poll',
  'dice',
  'game',
  'story',
  'paid_media',
  'live_photo',
  'rich_message',
  'checklist',
  'invoice',
  'giveaway',
  'passport_data',
] as const;

function isUnsupportedUserContent(msg: TgMessage): boolean {
  const rec = msg as unknown as Record<string, unknown>;
  return UNSUPPORTED_USER_CONTENT.some((k) => rec[k] != null);
}

/** Telegram buyrug'i ko'rinishidagi matn: /cmd yoki /cmd@bot (keyin bo'sh joy yoki oxiri). */
const COMMAND_RE = /^\/[A-Za-z0-9_]{1,64}(?:@[A-Za-z0-9_]{1,64})?(?:\s|$)/;

interface Resolution {
  conv: Conversation | null;
  /** Suhbat Reply qilingan xabardan aniqlandi (faol suhbat shunga almashadi). */
  viaReply: boolean;
  /**
   * Mijoz botning xabariga Reply qildi, lekin u qaysi xodimga tegishli ekanini aniqlab bo'lmadi. Bunday xabar
   * HECH QACHON faol suhbatga taxminan yuborilmaydi (boshqa xodimga ketib qolishi mumkin) — mijozdan so'raladi.
   */
  unresolvedReply: boolean;
}

/** Bot xabaridagi tugmalardan aniqlangan suhbat (faqat shu mijozniki; xodim kartasi — mavjud xodim bo'lsa). */
async function conversationFromBotMessage(client: Client, replyTo: TgMessage, botId: number): Promise<Conversation | null> {
  const target = targetFromBotMessage(replyTo, botId);
  if (!target) return null;
  if ('conversationId' in target) {
    const conv = await getConversation(target.conversationId);
    return conv && conv.client_id === client.tg_user_id ? conv : null;
  }
  // Xodim kartasiga javob — "shu xodimga yozish" (✍️ Yozish bilan bir xil); mavjud bo'lmasa taxmin qilinmaydi
  const staff = await getStaff(target.staffId);
  if (!isStaffAvailable(staff)) return null;
  return getOrCreateConversation(client.tg_user_id, staff.id);
}

/**
 * Tugmasiz bot xabari (havola orqali ulanish xabari, «✍️ Yozish» tasdig'i, /start dagi "Siz … bilan suhbatdasiz"):
 * undagi qalin xodim ismi bo'yicha shu mijozning suhbati — faqat xodim hozir mavjud bo'lsa (aks holda taxmin yo'q).
 */
async function conversationFromNamedMessage(client: Client, replyTo: TgMessage, botId: number): Promise<Conversation | null> {
  const convId = await conversationFromNamedStaff(client.tg_user_id, replyTo, botId);
  if (convId == null) return null;
  const conv = await getConversation(convId);
  if (!conv || conv.client_id !== client.tg_user_id) return null;
  return isStaffAvailable(await getStaff(conv.staff_id)) ? conv : null;
}

/**
 * Xabar qaysi suhbatga:
 *  1) Reply qilingan xabar (xodim xabari, uning sarlavhasi/bo'laklari, mijozning o'z xabari, avto-javob);
 *  2) Reply qilingan bot xabarining tugmalari (transkript, xodim kartasi, «↩️ … ga yozish» bildirishnomasi);
 *  2b) tugmasiz bot xabari (havola orqali ulanish, «✍️ Yozish» tasdig'i) — undagi qalin xodim ismi bo'yicha;
 *  3) bot xabariga Reply, lekin aniqlab bo'lmadi — faol suhbatga YUBORILMAYDI (unresolvedReply);
 *  4) Reply'siz (yoki mijozning o'z bog'lanmagan xabariga Reply) — faol suhbat.
 */
async function resolveConversation(client: Client, msg: TgMessage, botId: number): Promise<Resolution> {
  const replyTo = msg.reply_to_message;
  if (replyTo) {
    const conv = await findConversationByClientReply(client.tg_user_id, replyTo.message_id);
    if (conv) return { conv, viaReply: true, unresolvedReply: false };
    if (replyTo.from?.id === botId) {
      const byButtons = await conversationFromBotMessage(client, replyTo, botId);
      if (byButtons) return { conv: byButtons, viaReply: true, unresolvedReply: false };
      const byName = await conversationFromNamedMessage(client, replyTo, botId);
      if (byName) return { conv: byName, viaReply: true, unresolvedReply: false };
      return { conv: null, viaReply: false, unresolvedReply: true };
    }
  }
  if (client.active_conversation_id != null) {
    const active = await getConversation(client.active_conversation_id);
    if (active && active.client_id === client.tg_user_id) return { conv: active, viaReply: false, unresolvedReply: false };
  }
  return { conv: null, viaReply: false, unresolvedReply: false };
}

/**
 * «❓ Bu xabar kimga?» — bot xabariga Reply qilingan, lekin qabul qiluvchini aniqlab bo'lmagan xabar saqlab
 * qo'yiladi va mijoz bir bosishda tanlaydi (`to:` — saqlangan xabar o'sha xodimga ketadi). Faol suhbat birinchi.
 * Albomning keyingi qismlariga qayta so'ralmaydi.
 */
async function askRecipient(ctx: Context, client: Client, item: HeldItem): Promise<void> {
  const held = await holdMessages(client.tg_user_id, [item]);
  if (held.saved && item.group && held.count > 1 && held.prev?.group === item.group) return;
  // Xabar saqlangan bo'lsa — so'rov eng yaxshi urinish (qayta yuborilsa, u ikki marta saqlanib, ikki marta ketardi)
  await afterIf(ctx, held.saved, '«Bu xabar kimga?» so\'rovi', async () => {
    const choices: Array<{ conversationId: number; staff: Staff }> = [];
    if (client.active_conversation_id != null) {
      const activeStaff = await conversationStaff(client.active_conversation_id, client.tg_user_id);
      if (isStaffAvailable(activeStaff)) choices.push({ conversationId: client.active_conversation_id, staff: activeStaff });
    }
    for (const r of await recentContacts(client.tg_user_id)) {
      if (choices.length >= 4) break;
      if (isStaffAvailable(r.staff) && !choices.some((c) => c.conversationId === r.conversationId)) choices.push(r);
    }
    const rows: Rows = choices.map((c) => [writeToButton(c.conversationId, staffName(c.staff))]);
    rows.push(roleRow());
    await sendHtml(ctx, held.saved ? T.askRecipient : T.askRecipientFull, markup(rows), item.msgId);
  });
}

/**
 * Xodim tanlanmagan: xabar saqlab qo'yiladi (tanlov bilan birga yuboriladi) va tanlash taklif qilinadi.
 * Albomning keyingi qismlariga qayta javob yozilmaydi.
 */
async function holdMessage(ctx: Context, client: Client, item: HeldItem): Promise<void> {
  const held = await holdMessages(client.tg_user_id, [item]);
  const kb = markup([roleRow()]);
  if (!held.saved) {
    await sendHtml(ctx, T.chooseFirstFull, kb, item.msgId);
    return;
  }
  if (held.count > 1) {
    if (item.group && held.prev?.group === item.group) return;
    await afterSuccess(ctx, '«saqlandi» izohi', () => sendHtml(ctx, T.chooseFirstMore, kb, item.msgId));
    return;
  }
  // Xabar saqlandi — izoh eng yaxshi urinish (qayta yuborilsa, u ikki marta saqlanib, ikki marta ketardi).
  await afterSuccess(ctx, '«saqlandi» izohi', async () => {
    // Oxirgi xodimi endi mavjud emas (uzilgan/o'chirilgan) — sababini aytamiz.
    // Avval yozishgan va hali mavjud xodim bo'lsa — unga bir bosishda yozish tugmasi (saqlangan xabar ham ketadi).
    const recent = await recentContacts(client.tg_user_id);
    const last = recent[0];
    const text = last && !isStaffAvailable(last.staff) ? staffGoneText(staffName(last.staff)) : T.chooseFirst;
    const rows: Rows = [];
    const quick = recent.find((r) => isStaffAvailable(r.staff));
    if (quick) rows.push([writeToButton(quick.conversationId, staffName(quick.staff))]);
    rows.push(roleRow());
    await sendHtml(ctx, text, markup(rows), item.msgId);
  });
}

/**
 * Bot chatidan xodimga yuborish chastotasi (Mini App dagi cheklovdan alohida va ancha keng — albom yoki bir nechta
 * xabarni forward qilish oddiy holat). Bitta mijoz to'xtovsiz yozib, barcha xodimlar uchun umumiy xodimlar botining
 * Telegram limitini tugatmasin. Holat Postgres da (rate_limits); jadval bo'lmasa — cheklovsiz (fail-open).
 */
const BOT_SEND_RULES: readonly RateRule[] = [
  { windowSec: 60, max: 60 },
  { windowSec: 3600, max: 1200 },
];
/** Cheklov haqidagi ogohlantirish daqiqasiga ko'pi bilan bir marta (har bir xabarga javob yozilmaydi). */
const FLOOD_NOTICE_RULES: readonly RateRule[] = [{ windowSec: 60, max: 1 }];

/** Limitdan oshsa false: xabar yuborilmaydi va saqlanmaydi, mijoz (daqiqada bir marta) ogohlantiriladi. */
async function withinBotRate(ctx: Context, client: Client, msgId: number): Promise<boolean> {
  const verdict = await hitRateLimit(`c:${client.tg_user_id}:bot`, BOT_SEND_RULES);
  if (verdict.allowed) return true;
  console.warn(`[client] ${client.tg_user_id}: chastota limiti — xabar xodimga yuborilmadi`);
  const notice = await hitRateLimit(`c:${client.tg_user_id}:bot-notice`, FLOOD_NOTICE_RULES);
  if (notice.allowed) await sendHtml(ctx, tooFastText(verdict.retryAfterSec), undefined, msgId);
  return false;
}

/**
 * Shikoyatdan (yoki shikoyat oynasi yopilgandan) keyin darhol shikoyat qilingan xodimga yozilgan xabar: unga
 * yuborilmaydi. Yuborilgan shikoyat bo'lsa — matni (izohi) shikoyatga qo'shiladi va rahbariyat xabardor qilinadi;
 * mijozga izoh + «↩️ … ga yozish» tugmasi (bosilsa himoya olib tashlanadi). Albomning qolgan qismlari jimgina
 * ushlanadi (interceptComplaint, cmpAlbum).
 */
async function guardedFollowUp(
  ctx: Context,
  client: Client,
  conv: Conversation,
  msg: TgMessage,
  guard: ComplaintGuard,
): Promise<void> {
  const clientId = client.tg_user_id;
  if (msg.media_group_id) await markComplaintAlbum(clientId, msg.media_group_id);
  if (guard.id == null) {
    console.log(`[client] mijoz ${clientId}: shikoyat oynasi yopilayotganda kelgan xabar xodim #${conv.staff_id} ga yuborilmadi`);
    await afterSuccess(ctx, 'parallel xabar izohi', () => sendHtml(ctx, CT.raced, undefined, msg.message_id));
    return;
  }
  const body = (msg.text ?? msg.caption ?? '').trim();
  let added: ComplaintView | null = null;
  if (body) {
    const verdict = await hitRateLimit(`c:${clientId}:complaint-add`, COMPLAINT_ADD_RULES);
    if (verdict.allowed) added = await appendComplaintText(guard.id, clientId, body);
  }
  console.log(
    `[client] mijoz ${clientId}: shikoyatdan keyingi xabar xodim #${conv.staff_id} ga yuborilmadi` +
      (added ? ` (shikoyat #${added.id} ga qo'shildi)` : ''),
  );
  // Bu yerdan pastda hammasi eng yaxshi urinish (matn shikoyatga allaqachon qo'shilgan)
  if (added) {
    try {
      await notifyComplaintAddition(added, body);
    } catch (e) {
      console.warn(`[client] shikoyat #${added.id} qo'shimchasi bildirishnomasi:`, describeError(e));
    }
  }
  await afterSuccess(ctx, 'shikoyatdan keyingi xabar izohi', async () => {
    const staff = await getStaff(conv.staff_id);
    const name = staffName(staff);
    const kb = isStaffAvailable(staff) ? markup([[writeToButton(conv.id, name)]]) : undefined;
    await sendHtml(ctx, complaintFollowUpText(name, added ? added.id : null), kb, msg.message_id);
  });
}

async function routeClientMessage(ctx: Context): Promise<void> {
  const msg = ctx.message;
  if (!msg) return;
  const client = clientOf(ctx);

  if (msg.text !== undefined && COMMAND_RE.test(msg.text)) {
    await sendHtml(ctx, T.unknownCommand);
    return;
  }

  const content = extractContent(msg);
  if (!content) {
    // Foydalanuvchi mazmuni (so'rovnoma, o'yin...) — aytamiz; servis xabarlar (avto-o'chirish taymeri...) — e'tiborsiz
    if (isUnsupportedUserContent(msg)) await sendHtml(ctx, T.unsupported, undefined, msg.message_id);
    return;
  }
  const item = heldItemFrom(msg, content);

  // 0) Chastota cheklovi (hech narsa saqlanmaydi va xodimga yuborilmaydi)
  if (!(await withinBotRate(ctx, client, msg.message_id))) return;

  // 1) Qaysi suhbat + yo'naltirish konteksti (oxirgi ko'rsatilgan xabar, saqlangan xabarlar) — parallel
  const [{ conv, viaReply, unresolvedReply }, info] = await Promise.all([
    resolveConversation(client, msg, ctx.me.id),
    loadRouteInfo(client.tg_user_id),
  ]);
  if (unresolvedReply) {
    await askRecipient(ctx, client, item);
    return;
  }
  // Shikoyatdan keyingi himoya: shikoyat qilingan xodimga ketayotgan xabar unga YUBORILMAYDI (shikoyatga qo'shiladi)
  if (conv && guardApplies(info.cmpGuard, conv.staff_id, msg.message_id)) {
    await guardedFollowUp(ctx, client, conv, msg, info.cmpGuard);
    return;
  }
  if (!conv) {
    await holdMessage(ctx, client, item);
    return;
  }
  // Reply orqali aniqlangan bo'lsa — xodimda ham o'sha xabar iqtibos bilan ko'rinadi
  if (viaReply && msg.reply_to_message) item.replyTo = msg.reply_to_message.message_id;

  // 2) Xodimga yetkazish: avval saqlab qo'yilgan xabarlar (tartib saqlanadi), keyin joriy xabar.
  //    Avto-javob relay ichida, suhbatdagi birinchi xabarda (bir marta).
  const held = info.hasHeld ? await takeHeld(client.tg_user_id, null) : [];
  const out = await relayQueue(client, conv, [...held, item], botErrorReporter(ctx));
  if (out.unavailable) {
    await onStaffUnavailable(ctx, client, conv, out.rest, item, out.sent > 0);
    return;
  }
  if (!out.sent) return; // xatolar xabarma-xabar aytildi

  // ── Bu yerdan pastda hammasi eng yaxshi urinish: xabar(lar) xodimga allaqachon yetkazilgan (saqlangan).
  //    Xato xato chegarasiga chiqsa, mijoz «qayta urinib ko'ring» ni ko'rib, xabarini qayta yuboradi — xodim uni
  //    ikki marta oladi.

  // Mijoz yozdi — demak shu suhbatdagi xabarlarni ko'rgan (keraksiz yozuvdan qochamiz)
  if (conv.unread_client > 0) {
    await markReadByClient(conv.id).catch((e) => console.warn('[client] markReadByClient:', describeError(e)));
  }

  // 3) Reply orqali boshqa suhbatga yozgan bo'lsa — endi shu suhbat faol
  let switched = false;
  if (viaReply && client.active_conversation_id !== conv.id) {
    const previous = client.active_conversation_id;
    const changed = await afterSuccess(ctx, 'faol suhbatni almashtirish', async () => {
      await setClientActiveConversation(client.tg_user_id, conv.id);
      return true;
    });
    if (changed) {
      client.active_conversation_id = conv.id;
      switched = previous != null;
    }
  }

  // 4) Bildirishnomalar (bitta xabarda): o'tish, saqlangan xabarlar, "boshqa xodimga ketdi", yetkazilmadi
  const sentIds = new Set(out.sentMsgIds);
  const heldSent = held.filter((h) => sentIds.has(h.msgId)).length;
  // Chatdagi oxirgi xabar boshqa xodimniki, mijoz esa Reply qilmasdan yozdi — xabar kimga ketganini aytamiz
  const redirected =
    !viaReply && !held.length && sentIds.has(item.msgId) && isUnexpectedTarget(info, conv.id);
  // Tanlov belgisi ishlatildi: endi chatdagi oxirgi xabar shu suhbatniki
  if (info.selConvId != null && sentIds.has(item.msgId)) {
    await clearSelection(client.tg_user_id, info.selConvId).catch((e) => console.warn('[client] clearSelection:', describeError(e)));
  }
  if (!switched && !heldSent && !redirected && !out.undelivered) return;

  await afterSuccess(ctx, 'yetkazishdan keyingi izoh', async () => {
    const staff = await getStaff(conv.staff_id);
    const name = staffName(staff);
    const parts: string[] = [];
    const rows: Rows = [];
    if (switched) parts.push(switchedNote(name));
    if (heldSent) parts.push(heldSentLine(heldSent, name));
    if (redirected && info.lastConvId != null) {
      const prev = await conversationStaff(info.lastConvId, client.tg_user_id);
      const canWriteBack = isStaffAvailable(prev);
      parts.push(redirectedNote(name, staffName(prev), canWriteBack));
      if (canWriteBack) rows.push([writeToButton(info.lastConvId, staffName(prev))]);
    }
    if (out.undelivered) {
      parts.push(undeliveredNote(name));
      rows.push(roleRow());
    }
    await sendHtml(ctx, parts.join('\n\n'), rows.length ? markup(rows) : undefined, msg.message_id);
  });
}

// ───────────────────────────── Shikoyat (/shikoyat) ─────────────────────────────
// Mijoz xodimni tanlagach (draft), keyingi matnli xabari shikoyat bo'ladi. Draft bor paytda kelgan xabar HECH QACHON
// xodimga yuborilmaydi: u saqlangan xabarlar, yo'naltirish va relay dan OLDIN ushlanadi. Tahrirlari ham yetib
// bormaydi (xabar bazada yo'q — src/edits.ts uni topmaydi).

/** Eski doimiy pastki klaviatura yorliqlari — buyruq kabi (shikoyat draftini bekor qiladi). */
const LEGACY_BUTTON_TEXTS: ReadonlySet<string> = new Set(Object.values(BTN));

/** Buyruq (/start, /help, …, noma'lum /buyruq ham) yoki eski pastki menyu tugmasi. */
function isCommandLike(msg: TgMessage): boolean {
  return msg.text !== undefined && (COMMAND_RE.test(msg.text) || LEGACY_BUTTON_TEXTS.has(msg.text));
}

/**
 * Draftning so'rov xabarini (✍️ … ustidan shikoyatingizni yozing + ✖️ Bekor qilish) yopish: matni almashtiriladi va
 * tugma olib tashlanadi — mijoz shikoyat oynasi yopilganini ko'radi. Eng yaxshi urinish (xatolar faqat logga).
 * except — shu xabar bo'lsa tegilmaydi (u chaqiruvchining o'zi tahrirlaydigan xabar).
 */
async function closeComplaintPrompt(ctx: Context, clientId: number, html: string, except?: number): Promise<void> {
  try {
    const { promptMsgId } = await getComplaintMarks(clientId);
    if (promptMsgId == null || promptMsgId === except) return;
    await ctx.api.editMessageText(ctx.chat?.id ?? clientId, promptMsgId, html, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  } catch (e) {
    if (!isNotModified(e)) console.warn('[client] shikoyat so\'rovi xabarini yopib bo\'lmadi:', tgErrorDescription(e));
  }
}

/** Mijozning shikoyat draftini (bo'lsa, eskirganini ham) jimgina bekor qilish; so'rov xabari yopiladi. */
async function dropComplaintDraft(ctx: Context, clientId: number, except?: number): Promise<boolean> {
  // Odatdagi holat (draft yo'q) — faqat yengil o'qish so'rovi
  if (!(await hasComplaintDraft(clientId))) return false;
  const cancelled = await cancelComplaintDrafts(clientId);
  if (cancelled) await closeComplaintPrompt(ctx, clientId, CT.cancelled, except);
  return cancelled;
}

/** /shikoyat (/complaint): mijozning xabari bor suhbatlari — kim ustidan shikoyat qilishini tanlaydi. */
async function showComplaintPicker(ctx: Context): Promise<void> {
  await dropLegacyKeyboard(ctx, false);
  const client = clientOf(ctx);
  // Xabarsiz suhbatlar (last_message_at null) ro'yxat oxirida — shuning uchun birinchi 10 tasi yetarli
  const convs = await listClientConversations(client.tg_user_id, 10);
  const view = renderComplaintPicker(convs);
  await sendHtml(ctx, view.text, view.markup);
}

/**
 * Har bir kiruvchi xabar uchun ENG AVVAL: shikoyat drafti bo'lsa, xabar shikoyat sifatida qayta ishlanadi (true —
 * boshqa hech narsa qilinmaydi). Buyruqlar draftni jimgina bekor qiladi va odatdagidek ishlaydi (false).
 */
async function interceptComplaint(ctx: Context): Promise<boolean> {
  const msg = ctx.message;
  if (!msg) return false;
  const clientId = clientOf(ctx).tg_user_id;
  if (isCommandLike(msg)) {
    await dropComplaintDraft(ctx, clientId);
    return false;
  }

  const group = msg.media_group_id;
  // Odatdagi holat (draft yo'q) — bitta yengil so'rov
  const latest = await complaintDraftInfo(clientId);
  if (latest === null) {
    // Shikoyat bo'lgan albomning qolgan qismlari (alohida update bo'lib keladi) — hech kimga yuborilmaydi.
    // Shikoyatdan keyin shikoyat qilingan xodimga yozilgan boshqa xabarlar — routeClientMessage dagi himoya (cmpGuard)
    return !!group && (await getComplaintMarks(clientId)).album === group;
  }
  const draftAge = latest.ageSec;
  const draft = await getActiveDraft(clientId);
  if (!draft && draftAge > COMPLAINT_ABANDONED_SEC) {
    // Uzoq (bir kundan ko'p) tashlab ketilgan draft: bu xabar endi shikoyat davomi emas — draft jimgina bekor
    // qilinadi (so'rov xabari yopiladi) va xabar odatdagidek xodimga boradi
    await dropComplaintDraft(ctx, clientId);
    return false;
  }
  if (!draft) {
    // Muddati o'tgan draft: mijoz "shikoyatingizni yozing" xabaridan keyin yozdi — xabar shikoyat bo'lishi mumkin,
    // shuning uchun xodimga YUBORILMAYDI. Draft o'chiriladi — keyingi xabarlar odatdagidek xodimga boradi.
    // Himoya va albom belgisi draft o'chirilishidan OLDIN yoziladi: parallel kelgan albom qismi yoki xabar draftni
    // topmasa ham ushlanadi (xodimga ketmaydi). Himoya izoh xabarigacha yozilgan xabarlar bilan chegaralanadi —
    // izohni o'qib qayta yuborilgan xabar odatdagidek xodimga boradi.
    const staffId = latest.staffId;
    await setComplaintGuard(clientId, { id: null, staff: staffId, until: Date.now() + COMPLAINT_RACE_GUARD_SEC * 1000 }, group);
    await dropComplaintDraft(ctx, clientId);
    // Draft endi yo'q: «qayta urinib ko'ring» dan keyin qayta yuborilgan (shikoyat) matni xodimga ketib qolardi
    const note = await afterSuccess(ctx, 'shikoyat muddati tugagani haqidagi izoh', () =>
      sendHtml(ctx, CT.expired, undefined, msg.message_id),
    );
    if (note) await afterSuccess(ctx, 'shikoyat himoyasi chegarasi', () => boundComplaintGuard(clientId, staffId, note.message_id));
    return true;
  }

  const body = (msg.text ?? msg.caption ?? '').trim();
  if (!body) {
    // Servis xabarlar (avto-o'chirish taymeri va h.k.) — e'tiborsiz; draft saqlanadi
    if (!extractContent(msg) && !isUnsupportedUserContent(msg)) return true;
    if (group) {
      // Albomga bir marta javob yoziladi
      if ((await getComplaintMarks(clientId)).album === group) return true;
      await markComplaintAlbum(clientId, group);
    }
    await sendHtml(ctx, CT.textOnly, undefined, msg.message_id);
    return true;
  }

  // Albom: izohli qismi shikoyat bo'ladi, qolgan qismlari (keyinroq keladi) — hech kimga yuborilmaydi.
  // Shikoyatdan keyingi himoya ham shikoyat yuborilishidan OLDIN (shu draft id si bilan — u shikoyat id si bo'ladi):
  // keyingi xabarlar (Telegram bo'lib yuborgan uzun matnning davomi, izohsiz isbot rasmi, parallel xabar) shikoyat
  // qilingan xodimga ketmaydi.
  await setComplaintGuard(
    clientId,
    { id: draft.id, staff: draft.staff_id, until: Date.now() + COMPLAINT_FOLLOWUP_SEC * 1000 },
    group,
  );

  const verdict = await hitRateLimit(`c:${clientId}:complaint`, COMPLAINT_RATE_RULES);
  if (!verdict.allowed) {
    console.warn(`[client] ${clientId}: shikoyatlar chastotasi limiti — shikoyat qabul qilinmadi`);
    // Shikoyat yo'q: faqat parallel kelgan xabarlar uchun qisqa himoya (izohdan keyin qayta yuborilgani — xodimga)
    await setComplaintGuard(clientId, {
      id: null,
      staff: draft.staff_id,
      until: Date.now() + COMPLAINT_RACE_GUARD_SEC * 1000,
    });
    await dropComplaintDraft(ctx, clientId);
    const note = await afterSuccess(ctx, 'shikoyatlar limiti izohi', () => sendHtml(ctx, CT.tooMany, undefined, msg.message_id));
    if (note) {
      await afterSuccess(ctx, 'shikoyat himoyasi chegarasi', () => boundComplaintGuard(clientId, draft.staff_id, note.message_id));
    }
    return true;
  }

  const view = await submitComplaint(draft.id, clientId, body);
  if (!view) {
    await afterSuccess(ctx, 'shikoyat topilmadi izohi', () => sendHtml(ctx, CT.gone, undefined, msg.message_id));
    return true;
  }
  console.log(`[client] mijoz ${clientId}: shikoyat #${view.id} (xodim #${view.staff_id})`);
  try {
    await notifyNewComplaint(view);
  } catch (e) {
    console.warn(`[client] shikoyat #${view.id} bildirishnomasi:`, describeError(e));
  }
  // Shikoyat qabul qilindi (draft yopildi) — tasdiq eng yaxshi urinish: «qayta urinib ko'ring» dan keyin qayta
  // yuborilgan shikoyat matni endi shikoyat emas, oddiy xabar bo'lib o'sha xodimning o'ziga ketib qolardi
  await afterSuccess(ctx, 'shikoyat qabul qilingani haqidagi tasdiq', () =>
    sendHtml(ctx, complaintAcceptedText(view.id), undefined, msg.message_id),
  );
  await closeComplaintPrompt(ctx, clientId, complaintSentPromptText(view.staff_full_name, view.id));
  return true;
}

// ───────────────────────────── Xatolar ─────────────────────────────

async function handleError(ctx: Context, e: unknown): Promise<void> {
  const code = tgErrorCode(e);
  if (code !== undefined) {
    // Telegram xatosi: to'liq payload (mijoz matni) ni logga yozmaymiz
    const method = (e as { method?: string }).method ?? '?';
    console.error(`[client] update #${ctx.update.update_id}: ${method} -> ${code} ${tgErrorDescription(e)}`);
  } else {
    console.error(`[client] update #${ctx.update.update_id} xatosi:`, e);
  }
  if (code === 403) {
    // Foydalanuvchi botni bloklagan — javob yozib bo'lmaydi
    if (ctx.from) await setClientBlocked(ctx.from.id, true).catch(() => {});
    await answer(ctx);
    return;
  }
  if (ctx.callbackQuery && !answeredCallbacks.has(ctx)) {
    await answer(ctx, T.error, true);
    return;
  }
  if (ctx.chat) {
    try {
      await ctx.reply(T.error);
    } catch (err) {
      console.error('[client] xato xabarini yuborib bo\'lmadi:', tgErrorDescription(err));
    }
  }
}

// ───────────────────────────── Bot ─────────────────────────────

function parseId(s: string | undefined): number {
  const n = Number(s);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

function createClientBot(): Bot {
  const bot = new Bot(config.clientBotToken, { client: { apiRoot: config.telegramApiRoot } });
  bot.api.config.use(retryOnFlood);

  // Xatolar chegarasi + har bir callback query ga javob kafolati
  bot.use(async (ctx, next) => {
    try {
      await next();
    } catch (e) {
      await handleError(ctx, e);
    }
    await answer(ctx);
  });

  // Faqat shaxsiy chatlar
  bot.use(async (ctx, next) => {
    if (ctx.chat?.type !== 'private') return;
    await next();
  });

  // Bot bloklandi / blokdan chiqarildi
  bot.on('my_chat_member', async (ctx) => {
    const status = ctx.myChatMember.new_chat_member.status;
    const userId = ctx.myChatMember.from.id;
    if (status === 'kicked') await setClientBlocked(userId, true);
    else if (status === 'member') await setClientBlocked(userId, false);
  });

  // Har bir update: mijozni yaratish/yangilash
  bot.use(async (ctx, next) => {
    const from = ctx.from;
    if (!from || from.is_bot) return;
    const client = await upsertClient(from);
    ctxClients.set(ctx, client);
    await next();
  });

  // Shikoyat drafti bo'lsa — xabar ENG AVVAL shikoyat sifatida qayta ishlanadi (xodimga hech qachon yuborilmaydi).
  // Buyruqlar draftni jimgina bekor qiladi va odatdagidek ishlaydi.
  bot.on('message', async (ctx, next) => {
    if (await interceptComplaint(ctx)) return;
    await next();
  });

  // ── Buyruqlar ──
  // /start <nom> — xodimning shaxsiy havolasi: darhol shu xodim bilan chat. Oddiy /start — bitta xabar + tanlash.
  bot.command('start', async (ctx) => {
    const payload = (typeof ctx.match === 'string' ? ctx.match : '').trim();
    if (!payload) {
      await sendStart(ctx);
      return;
    }
    const staff = await staffFromStartPayload(payload);
    if (isStaffAvailable(staff)) {
      await startWithStaff(ctx, staff);
      return;
    }
    await sendStart(ctx, T.linkNotFound);
  });

  bot.command('menu', (ctx) => sendStart(ctx));
  bot.command('help', (ctx) => sendHelp(ctx));
  bot.command(['shikoyat', 'complaint'], (ctx) => showComplaintPicker(ctx));
  // Endi ko'rsatilmaydigan (eski) buyruqlar — ishlashda davom etadi
  bot.command('operators', (ctx) => legacyStaffList(ctx, 'operator'));
  bot.command('managers', (ctx) => legacyStaffList(ctx, 'manager'));
  bot.command('chats', (ctx) => legacyChats(ctx));

  // ── Eski doimiy klaviatura yorliqlari (endi yuborilmaydi; bosilsa ishlaydi va eski menyu olib tashlanadi) ──
  bot.hears(BTN.operators, (ctx) => legacyStaffList(ctx, 'operator'));
  bot.hears(BTN.managers, (ctx) => legacyStaffList(ctx, 'manager'));
  bot.hears(BTN.chats, (ctx) => legacyChats(ctx));
  bot.hears(BTN.help, (ctx) => sendHelp(ctx));

  // ── Inline tugmalar ──
  bot.callbackQuery('noop', (ctx) => answer(ctx));

  bot.callbackQuery(/^ls:(operator|manager)(?::(\d{1,4}))?$/, async (ctx) => {
    await answer(ctx);
    await showStaffList(ctx, ctx.match[1] as Role, parseId(ctx.match[2]), 'edit');
  });

  bot.callbackQuery(/^card:(\d{1,15})$/, async (ctx) => {
    const staff = await getStaff(parseId(ctx.match[1]));
    if (!isStaffAvailable(staff)) return answer(ctx, T.staffUnavailable, true);
    await answer(ctx);
    await sendStaffCard(ctx, staff);
  });

  bot.callbackQuery(/^nav:(\d{1,15}):(prev|next)$/, async (ctx) => {
    const current = await getStaff(parseId(ctx.match[1]));
    if (!current) return answer(ctx, T.staffUnavailable, true);
    const list = await listAvailableStaff(current.role);
    const target = neighbour(list, current, ctx.match[2] === 'prev' ? 'prev' : 'next');
    if (!target) return answer(ctx, T.staffUnavailable, true);
    await answer(ctx);

    const index = list.findIndex((s) => s.id === target.id);
    const caption = staffCaption(target);
    const kb = cardMarkup(target, index, list.length);
    try {
      await withStaffPhoto(
        target,
        (media) =>
          ctx.editMessageMedia(InputMediaBuilder.photo(media, { caption, parse_mode: 'HTML' }), {
            reply_markup: kb,
          }),
        () => showUploadAction(ctx),
      );
    } catch (e) {
      if (tgErrorCode(e) === 403) throw e;
      console.warn('[client] kartani tahrirlab bo\'lmadi, yangisi yuboriladi:', tgErrorDescription(e));
      await ctx.deleteMessage().catch(() => {});
      await sendStaffCard(ctx, target);
    }
  });

  bot.callbackQuery(/^pick:(\d{1,15})$/, async (ctx) => {
    const staff = await getStaff(parseId(ctx.match[1]));
    if (!isStaffAvailable(staff)) return answer(ctx, T.staffUnavailable, true);
    await pickStaff(ctx, staff);
  });

  bot.callbackQuery(/^chats(?::(\d{1,4}))?$/, async (ctx) => {
    await answer(ctx);
    await showChats(ctx, parseId(ctx.match[1]), 'edit');
  });

  bot.callbackQuery('choose', async (ctx) => {
    await answer(ctx);
    const view = renderChoose();
    await editOrSend(ctx, view.text, view.markup);
  });

  bot.callbackQuery(/^conv:(\d{1,15})$/, async (ctx) => {
    const client = clientOf(ctx);
    const conv = await getConversation(parseId(ctx.match[1]));
    if (!conv || conv.client_id !== client.tg_user_id) return answer(ctx, T.convNotFound, true);
    const staff = await getStaff(conv.staff_id);
    const rawName = staffName(staff);
    const name = esc(rawName);

    if (isStaffAvailable(staff)) {
      await dropComplaintDraft(ctx, client.tg_user_id);
      await setClientActiveConversation(client.tg_user_id, conv.id);
      client.active_conversation_id = conv.id;
      await answer(ctx, T.convSelected);
      // Saqlab qo'yilgan xabarlar — transkriptdan oldin, u ularni ham ko'rsatadi
      const out = await deliverHeldOnSelect(ctx, client, conv);
      if (out?.unavailable) {
        await onStaffUnavailable(ctx, client, conv, out.rest, undefined, out.sent > 0);
        return;
      }
      // Saqlangan xabarlar yetkazilgan bo'lsa — transkript eng yaxshi urinish
      await afterIf(ctx, (out?.sent ?? 0) > 0, 'suhbat transkripti', async () => {
        await markReadByClient(conv.id);
        const footer: string[] = [];
        if (out && out.sent > 0) footer.push(heldSentLine(out.sent, rawName));
        footer.push(`✍️ Endi xabarlaringiz <b>${name}</b>${dativeSuffix(rawName)} yuboriladi.`);
        if (out?.undelivered) footer.push(undeliveredNote(rawName));
        await sendTranscript(ctx, conv, staff, 0, {
          footer: footer.join('\n'),
          extraRows: out?.undelivered ? [roleRow()] : undefined,
        });
      });
      return;
    }

    // Xodim endi mavjud emas: tarixni ko'rsatamiz, lekin yozib bo'lmaydi
    if (client.active_conversation_id === conv.id) {
      await setClientActiveConversation(client.tg_user_id, null);
      client.active_conversation_id = null;
    }
    await answer(ctx);
    await markReadByClient(conv.id);
    await sendTranscript(ctx, conv, staff, 0, {
      footer:
        `⚠️ <b>${name}</b> hozir mavjud emas — bu suhbatga yangi xabar yuborib bo'lmaydi. ` +
        'Boshqa xodimni tanlang 👇',
      extraRows: [roleRow()],
    });
  });

  bot.callbackQuery(/^hist:(\d{1,15}):(\d{1,15})$/, async (ctx) => {
    const client = clientOf(ctx);
    const conv = await getConversation(parseId(ctx.match[1]));
    if (!conv || conv.client_id !== client.tg_user_id) return answer(ctx, T.convNotFound, true);
    await answer(ctx);
    const beforeId = parseId(ctx.match[2]);
    const staff = await getStaff(conv.staff_id);
    if (beforeId === 0) await markReadByClient(conv.id);
    await sendTranscript(ctx, conv, staff, beforeId);
  });

  // «↩️ Javob berish» (xodim xabari ostida) / «↩️ … ga yozish»: shu suhbatni faol qilish
  bot.callbackQuery(/^to:(\d{1,15})$/, async (ctx) => {
    const client = clientOf(ctx);
    const conv = await getConversation(parseId(ctx.match[1]));
    if (!conv || conv.client_id !== client.tg_user_id) return answer(ctx, T.convNotFound, true);
    const staff = await getStaff(conv.staff_id);
    if (!isStaffAvailable(staff)) {
      if (client.active_conversation_id === conv.id) {
        await setClientActiveConversation(client.tg_user_id, null);
        client.active_conversation_id = null;
      }
      return answer(ctx, T.staffUnavailable, true);
    }
    const name = staffName(staff);
    await dropComplaintDraft(ctx, client.tg_user_id);
    await setClientActiveConversation(client.tg_user_id, conv.id);
    client.active_conversation_id = conv.id;
    await answer(ctx, activeChosenToast(name));

    const out = await deliverHeldOnSelect(ctx, client, conv);
    if (out?.unavailable) {
      await onStaffUnavailable(ctx, client, conv, out.rest, undefined, out.sent > 0);
      return;
    }
    const replyTo = ctx.callbackQuery.message?.message_id;
    // Saqlangan xabarlar yetkazilgan bo'lsa — tasdiq eng yaxshi urinish
    await afterIf(ctx, (out?.sent ?? 0) > 0, 'faol suhbat tasdig\'i', async () => {
      await markReadByClient(conv.id);
      const parts: string[] = [];
      if (out && out.sent > 0) parts.push(heldSentLine(out.sent, name));
      parts.push(activeChosenText(name));
      if (out?.undelivered) parts.push(undeliveredNote(name));
      await sendHtml(ctx, parts.join('\n\n'), out?.undelivered ? markup([roleRow()]) : undefined, replyTo);
    });
  });

  // ── Shikoyat ──
  // «✖️ Bekor qilish» (tanlash ro'yxatida ham, shikoyat so'rovida ham)
  bot.callbackQuery('cmp:x', async (ctx) => {
    const clientId = clientOf(ctx).tg_user_id;
    const here = ctx.callbackQuery.message?.message_id;
    const [draft, marks] = await Promise.all([getActiveDraft(clientId), getComplaintMarks(clientId)]);
    if (draft && marks.promptMsgId != null && here != null && marks.promptMsgId !== here) {
      // Eski xabardagi tugma: boshqa xabardagi joriy shikoyatga tegmaymiz. Eski xabar matni ham almashtiriladi —
      // faqat tugmasi olib tashlansa, undagi QALIN xodim ismi Reply orqali yo'naltirishda (conversationFromNamedStaff)
      // manzil bo'lib qolardi va keyinroq unga Reply qilingan (shikoyat) matn o'sha xodimga ketib qolishi mumkin edi
      await answer(ctx, CT.staleCancel);
      await ctx
        .editMessageText(CT.stalePrompt, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
        .catch(() => ctx.editMessageReplyMarkup().catch(() => {}));
      return;
    }
    await cancelComplaintDrafts(clientId);
    await answer(ctx);
    await editOrSend(ctx, CT.cancelled);
  });

  // Xodimni tanlash: draft ochiladi, xabar "shikoyatingizni yozing" so'roviga almashadi
  bot.callbackQuery(/^cmp:(\d{1,15})$/, async (ctx) => {
    const clientId = clientOf(ctx).tg_user_id;
    const target = await complaintTarget(clientId, parseId(ctx.match[1]));
    if (!target) return answer(ctx, CT.notYours, true);
    const staffId = parseId(ctx.match[1]);
    const here = ctx.callbackQuery.message?.message_id;
    // Boshqa xabardagi eski draft (bo'lsa) yopiladi; so'rov xabari id si draftdan OLDIN yoziladi
    await dropComplaintDraft(ctx, clientId, here);
    if (here != null) await setComplaintPrompt(clientId, here);
    await startComplaintDraft(clientId, staffId);
    await answer(ctx);
    let shown: number | undefined;
    try {
      shown = await editOrSend(ctx, complaintPromptText(complaintStaffName(target.staffFullName)), complaintCancelMarkup());
    } catch (e) {
      // So'rov ko'rsatilmagan bo'lishi mumkin (mijoz «shikoyatingizni yozing» ni ko'rmadi) — yoki ko'rsatilgan
      // (javob kelmay qolgan). Draft «muddati o'tgan» qilinadi: keyingi xabar na shikoyat bo'lib rahbariyatga
      // (operatorga mo'ljallangan xabar), na xodimga (shikoyat matni) ketadi — hech kimga yuborilmaydi (CT.expired)
      if (tgErrorCode(e) === 403) await cancelComplaintDrafts(clientId).catch(() => false);
      else await expireComplaintDrafts(clientId).catch((err) => console.warn('[client] expireComplaintDrafts:', describeError(err)));
      throw e;
    }
    if (shown != null && shown !== here) await setComplaintPrompt(clientId, shown);
    // Ikki xodim tugmasi bir vaqtda bosilgan bo'lsa: so'rovdagi ism amaldagi (oxirgi) draftnikiga moslanadi —
    // shikoyat so'rovda ko'rsatilgan odamdan boshqasi ustidan yozilib qolmasin
    const promptMsg = shown ?? here;
    await afterSuccess(ctx, "shikoyat so'rovini draftga moslash", async () => {
      const d = await getActiveDraft(clientId);
      if (!d || d.staff_id === staffId || promptMsg == null) return;
      const actual = await complaintTarget(clientId, d.staff_id);
      if (!actual) return;
      await ctx.api
        .editMessageText(ctx.chat!.id, promptMsg, complaintPromptText(complaintStaffName(actual.staffFullName)), {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: complaintCancelMarkup(),
        })
        .catch((err) => {
          if (!isNotModified(err)) throw err;
        });
    });
  });

  // Noma'lum/eskirgan tugmalar
  bot.on('callback_query', (ctx) => answer(ctx, T.staleButton));

  // ── Boshqa barcha xabarlar: tanlangan xodimga yetkaziladi ──
  bot.on('message', (ctx) => routeClientMessage(ctx));

  return bot;
}

let botInstance: Bot | null = null;
let botReady: Promise<Bot> | null = null;

/** Mijozlar boti (bir marta yaratiladi va init qilinadi; init xato bersa keyingi chaqiruvda qayta uriniladi). */
export async function getClientBot(): Promise<Bot> {
  if (!botReady) {
    const bot = botInstance ?? (botInstance = createClientBot());
    botReady = bot.init().then(
      () => bot,
      (e: unknown) => {
        botReady = null;
        throw e;
      },
    );
  }
  return botReady;
}

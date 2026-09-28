// Mijozlar boti (@uzgroww_bot): operator/menejer tanlash, ular bilan bot orqali yozishish, suhbatlar tarixi.
import { Bot, InputMediaBuilder, type Context } from 'grammy';
import type {
  ForceReply,
  InlineKeyboardMarkup,
  Message as TgMessage,
  ReplyKeyboardMarkup,
  ReplyKeyboardRemove,
  ReplyParameters,
} from 'grammy/types';
import { config } from '../config.js';
import { getWebAppUrl } from '../links.js';
import { relayErrorText } from '../relay.js';
import {
  findConversationByClientReply,
  getConversation,
  getOrCreateConversation,
  getStaff,
  isStaffAvailable,
  listAvailableStaff,
  listClientConversations,
  listMessages,
  markReadByClient,
  setClientActiveConversation,
  setClientBlocked,
  upsertClient,
} from '../repo.js';
import { welcomeText } from '../texts.js';
import { extractContent, retryOnFlood } from '../tg.js';
import type { Client, Conversation, Role, Staff } from '../types.js';
import { hitRateLimit, type RateRule } from '../webapp/guards.js';
import { dativeSuffix, esc, isNotModified, roleLabel, tgErrorCode, tgErrorDescription, truncate } from '../util.js';
import { withStaffPhoto } from './client/photo.js';
import {
  clearSelection,
  conversationStaff,
  heldItemFrom,
  holdMessages,
  isUnexpectedTarget,
  loadRouteInfo,
  recentContacts,
  relayQueue,
  takeHeld,
  targetFromBotMessage,
  type ErrorReporter,
  type HeldItem,
  type QueueOutcome,
} from './client/routing.js';
import {
  BTN,
  HISTORY_PAGE_SIZE,
  T,
  activeChosenText,
  activeChosenToast,
  cardMarkup,
  cb,
  heldSentLine,
  helpText,
  mainKeyboard,
  markup,
  neighbour,
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
  webAppBtn,
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
 */
async function editOrSend(ctx: Context, text: string, replyMarkup: InlineKeyboardMarkup): Promise<void> {
  if (ctx.callbackQuery?.message) {
    if (callbackMessageHasMedia(ctx)) {
      await ctx.deleteMessage().catch(() => {});
    } else {
      try {
        await ctx.editMessageText(text, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: replyMarkup,
        });
        return;
      } catch (e) {
        if (isNotModified(e)) return;
        if (tgErrorCode(e) === 403) throw e;
        console.warn('[client] editMessageText bajarilmadi, yangi xabar yuboriladi:', tgErrorDescription(e));
      }
    }
  }
  await sendHtml(ctx, text, replyMarkup);
}

async function showUploadAction(ctx: Context): Promise<void> {
  await ctx.replyWithChatAction('upload_photo').catch(() => {});
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

// ───────────────────────────── Ekranlar ─────────────────────────────

/** Asosiy menyu xabari (inline): Mini App + rollar. */
async function sendMenu(ctx: Context, variant: 'start' | 'menu', note?: string): Promise<void> {
  const url = await getWebAppUrl();
  let text: string;
  if (variant === 'menu') text = T.menu;
  else text = url ? T.startMenuWithApp : T.startMenuNoApp;
  if (note) text = `${note}\n\n${text}`;
  const rows: Rows = [];
  if (url) rows.push([webAppBtn('📱 Menyuni ochish', url)]);
  rows.push(roleRow());
  if (variant === 'menu') rows.push([cb(BTN.chats, 'chats')]);
  await sendHtml(ctx, text, markup(rows));
}

async function sendHelp(ctx: Context): Promise<void> {
  const url = await getWebAppUrl();
  await sendHtml(ctx, helpText(!!url), mainKeyboard());
}

async function showStaffList(ctx: Context, role: Role, page: number, mode: 'send' | 'edit'): Promise<void> {
  const [staff, url] = await Promise.all([listAvailableStaff(role), getWebAppUrl()]);
  const view = renderStaffList(role, staff, page, url);
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
  const [convs, available, url] = await Promise.all([
    listClientConversations(client.tg_user_id, 200),
    listAvailableStaff(),
    getWebAppUrl(),
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
  const view = renderChats(visible, client.active_conversation_id, availableIds, page, url);
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
  const held = await takeHeld(client.tg_user_id, conv.id);
  if (!held.length) return null;
  return relayQueue(client, conv, held, botErrorReporter(ctx));
}

/**
 * Xodim mavjud emas: faol suhbat tozalanadi, yuborilmay qolgan xabarlar keyingi tanlov uchun saqlanadi.
 * current — mijozning hozirgi xabari (bo'lsa): albomning keyingi qismlariga qayta javob yozilmaydi.
 * Mijozning boshqa faol suhbati qolgan bo'lsa (Reply orqali mavjud bo'lmagan xodimga yozgan), hozirgi xabar
 * saqlanmaydi — aks holda u keyingi xabar bilan faol suhbatdagi boshqa xodimga so'ralmasdan ketib qolardi.
 */
async function onStaffUnavailable(
  ctx: Context,
  client: Client,
  conv: Conversation,
  rest: HeldItem[],
  current?: HeldItem,
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
  await sendHtml(
    ctx,
    esc(relayErrorText('staff_unavailable')) + (note ? `\n\n${note}` : ''),
    markup([roleRow()]),
    current?.msgId,
  );
}

/** Tanlangan xodim bilan suhbatni faollashtirish. */
async function pickStaff(ctx: Context, staff: Staff): Promise<void> {
  const client = clientOf(ctx);
  const conv = await getOrCreateConversation(client.tg_user_id, staff.id);
  await setClientActiveConversation(client.tg_user_id, conv.id);
  client.active_conversation_id = conv.id;
  await answer(ctx, T.picked);

  // Xodim tanlanmaguncha yozilgan xabarlar — endi shu xodimga (avto-javob relay ichida, bir marta)
  const out = await deliverHeldOnSelect(ctx, client, conv);
  if (out?.unavailable) {
    await onStaffUnavailable(ctx, client, conv, out.rest);
    return;
  }
  const heldSent = out?.sent ?? 0;

  const name = staffName(staff);
  const who = `<b>${esc(name)}</b> (${roleLabel(staff.role)})`;
  let text: string;
  const rows: Rows = [];
  if (conv.last_message_at) {
    await markReadByClient(conv.id);
    text = `✅ Siz yana ${who} bilan bog'landingiz — suhbatingiz davom etadi.`;
    rows.push([cb('📜 Suhbat tarixi', `hist:${conv.id}:0`)]);
  } else {
    text = `✅ Siz endi ${who} bilan bog'landingiz.`;
  }
  if (heldSent > 0) {
    text += `\n\n${heldSentLine(heldSent, name)} Javob shu chatga keladi.`;
  } else if (conv.last_message_at) {
    text += "\n\n✍️ Xabaringizni yozing — u to'g'ridan-to'g'ri unga yetkaziladi.";
  } else {
    text +=
      "\n\n✍️ Savolingizni yozing — xabaringiz to'g'ridan-to'g'ri unga yetkaziladi. " +
      'Matn, rasm, video, fayl, ovozli xabar yuborishingiz mumkin.';
  }
  // Birinchi xabar yuborilgan bo'lsa, oflayn izohi avto-javobning o'zida bor
  if (!staff.is_online && !(heldSent > 0 && !conv.last_message_at)) {
    text += "\n\n⚪️ <i>Hozir oflayn — xabaringiz saqlanadi va imkon qadar tezroq javob beriladi.</i>";
  }
  if (out?.undelivered) {
    text += `\n\n${undeliveredNote(name)}`;
    rows.push(roleRow());
  }
  await sendHtml(ctx, text, rows.length ? markup(rows) : undefined);
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
 * Xabar qaysi suhbatga:
 *  1) Reply qilingan xabar (xodim xabari, uning sarlavhasi/bo'laklari, mijozning o'z xabari, avto-javob);
 *  2) Reply qilingan bot xabarining tugmalari (transkript, xodim kartasi, «↩️ … ga yozish» bildirishnomasi);
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
    await sendHtml(ctx, T.chooseFirstMore, kb, item.msgId);
    return;
  }
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
    await onStaffUnavailable(ctx, client, conv, out.rest, item);
    return;
  }
  if (!out.sent) return; // xatolar xabarma-xabar aytildi

  // Mijoz yozdi — demak shu suhbatdagi xabarlarni ko'rgan (keraksiz yozuvdan qochamiz)
  if (conv.unread_client > 0) {
    await markReadByClient(conv.id).catch((e) => console.warn('[client] markReadByClient:', e));
  }

  // 3) Reply orqali boshqa suhbatga yozgan bo'lsa — endi shu suhbat faol
  let switched = false;
  if (viaReply && client.active_conversation_id !== conv.id) {
    const previous = client.active_conversation_id;
    await setClientActiveConversation(client.tg_user_id, conv.id);
    client.active_conversation_id = conv.id;
    switched = previous != null;
  }

  // 4) Bildirishnomalar (bitta xabarda): o'tish, saqlangan xabarlar, "boshqa xodimga ketdi", yetkazilmadi
  const sentIds = new Set(out.sentMsgIds);
  const heldSent = held.filter((h) => sentIds.has(h.msgId)).length;
  // Chatdagi oxirgi xabar boshqa xodimniki, mijoz esa Reply qilmasdan yozdi — xabar kimga ketganini aytamiz
  const redirected =
    !viaReply && !held.length && sentIds.has(item.msgId) && isUnexpectedTarget(info, conv.id);
  // Tanlov belgisi ishlatildi: endi chatdagi oxirgi xabar shu suhbatniki
  if (info.selConvId != null && sentIds.has(item.msgId)) {
    await clearSelection(client.tg_user_id, info.selConvId).catch((e) => console.warn('[client] clearSelection:', e));
  }
  if (!switched && !heldSent && !redirected && !out.undelivered) return;

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

  // ── Buyruqlar ──
  bot.command('start', async (ctx) => {
    const client = clientOf(ctx);
    const payload = (typeof ctx.match === 'string' ? ctx.match : '').trim();
    await sendHtml(ctx, esc(await welcomeText(client)), mainKeyboard());

    const deep = /^staff_(\d{1,15})$/.exec(payload);
    if (deep) {
      const staff = await getStaff(Number(deep[1]));
      if (isStaffAvailable(staff)) {
        await sendStaffCard(ctx, staff);
        return;
      }
      await sendMenu(ctx, 'start', T.deepLinkMissing);
      return;
    }
    await sendMenu(ctx, 'start');
  });

  bot.command('menu', (ctx) => sendMenu(ctx, 'menu'));
  bot.command('operators', (ctx) => showStaffList(ctx, 'operator', 0, 'send'));
  bot.command('managers', (ctx) => showStaffList(ctx, 'manager', 0, 'send'));
  bot.command('chats', (ctx) => showChats(ctx, 0, 'send'));
  bot.command('help', (ctx) => sendHelp(ctx));

  // ── Pastki klaviatura ──
  bot.hears(BTN.operators, (ctx) => showStaffList(ctx, 'operator', 0, 'send'));
  bot.hears(BTN.managers, (ctx) => showStaffList(ctx, 'manager', 0, 'send'));
  bot.hears(BTN.chats, (ctx) => showChats(ctx, 0, 'send'));
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
      await setClientActiveConversation(client.tg_user_id, conv.id);
      client.active_conversation_id = conv.id;
      await answer(ctx, T.convSelected);
      // Saqlab qo'yilgan xabarlar — transkriptdan oldin, u ularni ham ko'rsatadi
      const out = await deliverHeldOnSelect(ctx, client, conv);
      if (out?.unavailable) {
        await onStaffUnavailable(ctx, client, conv, out.rest);
        return;
      }
      await markReadByClient(conv.id);
      const footer: string[] = [];
      if (out && out.sent > 0) footer.push(heldSentLine(out.sent, rawName));
      footer.push(`✍️ Endi xabarlaringiz <b>${name}</b>${dativeSuffix(rawName)} yuboriladi.`);
      if (out?.undelivered) footer.push(undeliveredNote(rawName));
      await sendTranscript(ctx, conv, staff, 0, {
        footer: footer.join('\n'),
        extraRows: out?.undelivered ? [roleRow()] : undefined,
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
    await setClientActiveConversation(client.tg_user_id, conv.id);
    client.active_conversation_id = conv.id;
    await answer(ctx, activeChosenToast(name));

    const out = await deliverHeldOnSelect(ctx, client, conv);
    if (out?.unavailable) {
      await onStaffUnavailable(ctx, client, conv, out.rest);
      return;
    }
    await markReadByClient(conv.id);
    const parts: string[] = [];
    if (out && out.sent > 0) parts.push(heldSentLine(out.sent, name));
    parts.push(activeChosenText(name));
    if (out?.undelivered) parts.push(undeliveredNote(name));
    await sendHtml(
      ctx,
      parts.join('\n\n'),
      out?.undelivered ? markup([roleRow()]) : undefined,
      ctx.callbackQuery.message?.message_id,
    );
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

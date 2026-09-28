// Xabar almashinuvining yadrosi: mijoz <-> xodim. Bot va Mini App ikkalasi ham shu funksiyalardan foydalanadi.
//
// Yetkazish kafolatlari:
//  - Mijoz xabari avval saqlanadi va shu chaqiruvga "band" qilinadi, keyin xodimga yuboriladi. Yuborib bo'lmasa
//    (xodim botni to'xtatgan, Telegram 429/5xx, tarmoq, vaqt tugashi) xabar navbatda qoladi va keyingi imkoniyatda
//    (xodimga keyingi xabar kelganda, xodim botga qaytganda/yozganda) tartib bilan qayta yetkaziladi.
//    Telegram 429 va 5xx da har bir alohida chaqiruv avval bir marta darhol qayta urinib ko'riladi (src/tg.ts
//    retryOnFlood) — navbatga faqat ikkinchi urinish ham muvaffaqiyatsiz bo'lsa tushadi.
//  - Xodim botni bloklagan bo'lsa (403) — u mijozlarga oflayn ko'rinadi va adminlar bir marta ogohlantiriladi.
//  - Qayta urinib bo'lmaydigan xatolar (fayl juda katta, 400) navbatdan chiqariladi va yuboruvchiga aytiladi.
//  - Har bir yuborilgan Telegram xabari (sarlavha, bo'laklar) saqlangan yozuvga bog'lanadi — Reply har doim
//    to'g'ri suhbatga boradi; Reply qilingan xabar boshqa tomonda ham iqtibos sifatida ko'rinadi.
import { InlineKeyboard } from 'grammy';
import { config } from './config.js';
import { remainingMs } from './deadline.js';
import {
  addMessageLinks,
  claimAutoReply,
  claimMessageDelivery,
  claimPendingForStaff,
  findMessageByClientChatMsg,
  findMessageByStaffChatMsg,
  getClient,
  getConversation,
  getMessage,
  getStaff,
  insertMessage,
  isStaffAvailable,
  markStaffReachable,
  markStaffUnreachable,
  releaseAutoReply,
  releaseDeliveryClaims,
  setClientBlocked,
  setDeliveryError,
  updateMessageDelivery,
} from './repo.js';
import { greetingText } from './texts.js';
import {
  FileTooBigError,
  MAX_DOWNLOAD_BYTES,
  clientApi,
  sendContent,
  staffApi,
  type SendOptions,
  type SendResult,
} from './tg.js';
import type { BotKind, Client, Content, Conversation, Message, MsgKind, Staff, Via } from './types.js';
import { clientName, describeError, esc, formatTime, roleIcon, roleLabel, tgErrorCode, tgErrorDescription, truncate } from './util.js';

export type RelayError =
  | 'staff_unavailable'
  /** Xodimning o'z profili o'chirib qo'yilgan/o'chirilgan — u mijozlarga yoza olmaydi (hech narsa saqlanmadi). */
  | 'staff_inactive'
  /** Xodim xodimlar botini to'xtatgan/bloklagan — (yuklash yo'lida) hech narsa saqlanmadi. */
  | 'staff_unreachable'
  | 'client_blocked'
  | 'client_not_found'
  | 'forbidden'
  | 'file_too_big'
  | 'send_failed'
  | 'empty';

/**
 * Xabar saqlandi, lekin hozircha yetkazilmadi — sababi:
 *  - 'staff_unreachable' — xodim xodimlar botini to'xtatgan/bloklagan (u qaytganda yetkaziladi);
 *  - 'transient' — vaqtinchalik Telegram/tarmoq xatosi (tez orada avtomatik qayta yetkaziladi);
 *  - 'no_staff_bot' — STAFF_BOT_TOKEN sozlanmagan.
 */
export type UndeliveredReason = 'staff_unreachable' | 'transient' | 'no_staff_bot';

export type RelayResult =
  | { ok: true; message: Message; delivered: boolean; autoReply?: Message; undeliveredReason?: UndeliveredReason }
  | { ok: false; error: RelayError; message?: Message };

/** Xodim botida mijoz xabari ostidagi tugma. */
export function staffMessageKeyboard(conversationId: number): InlineKeyboard {
  return new InlineKeyboard().text('↩️ Javob berish', `act:${conversationId}`);
}

/**
 * Mijoz botida xodim xabari ostidagi tugma: bosilsa shu suhbat faol bo'ladi (mijoz boti `to:<id>` ni
 * egalik va xodim mavjudligini tekshirib bajaradi). Bir nechta xodim bilan yozishayotgan mijoz Reply'siz ham
 * aniq kimga yozayotganini tanlay oladi.
 */
export function clientMessageKeyboard(conversationId: number): InlineKeyboard {
  return new InlineKeyboard().text('↩️ Javob berish', `to:${conversationId}`);
}

/** Xodimning o'z profili faolmi (o'chirib qo'yilgan/o'chirilgan xodim mijozlarga yoza olmaydi). */
function staffCanWrite(staff: Staff): boolean {
  return staff.is_active && !staff.deleted_at;
}

export function clientHeaderForStaff(client: Client): { header: string; headerSuffix?: string } {
  return {
    header: `👤 ${clientName(client)}`,
    headerSuffix: client.username ? ` · @${client.username}` : undefined,
  };
}

export function staffHeaderForClient(staff: Staff): { header: string } {
  return { header: `${roleIcon(staff.role)} ${staff.full_name}` };
}

function isEmpty(content: Content): boolean {
  if (content.kind === 'text') return !(content.text ?? '').trim();
  if (content.kind === 'location') return content.meta?.latitude == null || content.meta?.longitude == null;
  if (content.kind === 'contact') return !content.meta?.phone_number;
  return !content.fileId && !content.upload;
}

function tooBig(content: Content): boolean {
  return !!content.fileSize && content.fileSize > MAX_DOWNLOAD_BYTES;
}

const MEDIA_KINDS: ReadonlySet<MsgKind> = new Set<MsgKind>([
  'photo',
  'video',
  'animation',
  'document',
  'audio',
  'voice',
  'video_note',
  'sticker',
]);

/**
 * Yuklangan (Mini App) fayl qaysi tur sifatida saqlanadi: Telegram haqiqatda yetkazgan media turi (masalan, GIF
 * animatsiya bo'lib qaytadi) — saqlangan tur va file_id bir-biriga mos bo'lishi uchun. Media bo'lmasa — so'ralgan tur.
 */
function storedUploadKind(content: Content, res: SendResult): MsgKind {
  return res.sentKind && res.sentKind !== content.kind && MEDIA_KINDS.has(res.sentKind) && res.fileId ? res.sentKind : content.kind;
}

/** Saqlangan yozuvdan qayta yuboriladigan mazmun (file_id — chaqiruvchi tanlaydi). */
export function contentFromMessage(m: Message): Content {
  return {
    kind: m.kind,
    text: m.text ?? undefined,
    entities: m.entities ?? undefined,
    fileUniqueId: m.file_unique_id ?? undefined,
    fileName: m.file_name ?? undefined,
    mimeType: m.mime_type ?? undefined,
    fileSize: m.file_size ?? undefined,
    meta: m.meta ?? undefined,
  };
}

// ───────────────────────────── Xatolarni tasniflash ─────────────────────────────

/** Qayta urinishdan foyda yo'q (masalan, saqlangan faylni endi olib bo'lmaydi). */
class PermanentDeliveryError extends Error {}

type FailureKind = 'too_big' | 'unreachable' | 'permanent' | 'transient';

/** Xodimga yetkazish xatosini tasniflash. */
function classifyStaffFailure(e: unknown): FailureKind {
  if (e instanceof FileTooBigError) return 'too_big';
  if (e instanceof PermanentDeliveryError) return 'permanent';
  const code = tgErrorCode(e);
  const desc = tgErrorDescription(e);
  if (code === 403) return 'unreachable';
  if (code === 400) {
    // Chat yo'q (xodim botni hech ochmagan / akkaunt o'chirilgan) — xodim qaytganda yetkaziladi
    if (/chat not found|user not found|peer_id_invalid|can't initiate|deactivated/i.test(desc)) return 'unreachable';
    return 'permanent';
  }
  // Telegram fayl serveri 4xx — fayl endi mavjud emas
  if (code === undefined && /Faylni yuklab bo'lmadi: HTTP 4\d\d/.test(desc)) return 'permanent';
  return 'transient'; // 429, 5xx (transformerdagi qayta urinishdan keyin ham), tarmoq, vaqt tugashi
}

function logFailure(what: string, e: unknown): void {
  const code = tgErrorCode(e);
  console.error(`${what}:${code !== undefined ? ` ${code}` : ''} ${tgErrorDescription(e)}`);
}

// ───────────────────────────── Yetkazish yordamchilari ─────────────────────────────

/** Asosiy xabardan tashqari yuborilgan xabarlarni (sarlavha, bo'laklar) yozuvga bog'lash — xato relay ni buzmaydi. */
async function linkExtras(messageId: number, bot: BotKind, chatId: number, res: SendResult): Promise<void> {
  const extras = res.messageIds.filter((id) => id !== res.messageId);
  if (!extras.length) return;
  try {
    await addMessageLinks(messageId, bot, chatId, extras);
  } catch (e) {
    console.error(`message_links (#${messageId}) saqlanmadi:`, describeError(e));
  }
}

/** Mijoz xodimga yozgan xabarning xodim chatidagi yetkazilishini saqlash. */
async function recordStaffDelivery(message: Message, chatId: number, res: SendResult): Promise<Message> {
  const fileIdStaff = res.fileId ?? message.file_id_staff ?? null;
  await updateMessageDelivery(message.id, {
    staff_chat_id: chatId,
    staff_chat_msg_id: res.messageId,
    ...(fileIdStaff ? { file_id_staff: fileIdStaff } : {}),
  });
  await linkExtras(message.id, 'staff', chatId, res);
  return { ...message, staff_chat_id: chatId, staff_chat_msg_id: res.messageId, file_id_staff: fileIdStaff };
}

/** Xodim yozgan xabarning mijoz chatidagi yetkazilishini saqlash. */
async function recordClientDelivery(message: Message, chatId: number, res: SendResult): Promise<Message> {
  const fileIdClient = res.fileId ?? message.file_id_client ?? null;
  await updateMessageDelivery(message.id, {
    client_chat_msg_id: res.messageId,
    ...(fileIdClient ? { file_id_client: fileIdClient } : {}),
  });
  await linkExtras(message.id, 'client', chatId, res);
  return { ...message, client_chat_msg_id: res.messageId, file_id_client: fileIdClient };
}

/** Adminlarga (xodimlar boti orqali) xabar — xatolar e'tiborsiz (admin botni ochmagan bo'lishi mumkin). */
async function notifyAdmins(html: string, exceptTgId: number | null): Promise<void> {
  const api = staffApi();
  if (!api) return;
  await Promise.allSettled(
    config.adminIds
      .filter((id) => id !== exceptTgId)
      .map((id) => api.sendMessage(id, html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } })),
  );
}

/**
 * Xodimga xabar yetib bormayapti (u xodimlar botini bloklagan/to'xtatgan): u oflayn ko'rinadi, xabarlar navbatda
 * qoladi, adminlar (bir marta) ogohlantiriladi.
 */
export async function handleStaffUnreachable(staff: Staff): Promise<void> {
  const changed = await markStaffUnreachable(staff.id);
  if (!changed) return;
  console.warn(`[relay] xodim #${staff.id} xodimlar botini to'xtatgan — xabarlar navbatda qoladi`);
  await notifyAdmins(
    `⚠️ <b>${esc(truncate(staff.full_name, 64))}</b> (${roleLabel(staff.role)}) xodimlar botini to'xtatgan yoki bloklagan — ` +
      "mijozlarning xabarlari unga yetib bormayapti.\n\n" +
      "Xabarlar saqlanib turadi va u botga qaytib, /start bosishi bilan avtomatik yetkaziladi. " +
      "Shu vaqtgacha mijozlar uni ⚪️ oflayn ko'radi.\n\nIltimos, xodim bilan bog'laning.",
    staff.tg_user_id,
  );
}

/** Xodim xodimlar botiga qaytdi: belgini olib tashlash, adminlarga aytish va kutib turgan xabarlarni yetkazish. */
export async function handleStaffReachable(staff: Staff): Promise<number> {
  const back = await markStaffReachable(staff.id);
  const current = back ?? staff;
  if (back) {
    console.warn(`[relay] xodim #${staff.id} xodimlar botiga qaytdi`);
    await notifyAdmins(
      `✅ <b>${esc(truncate(current.full_name, 64))}</b> (${roleLabel(current.role)}) xodimlar botiga qaytdi — ` +
        'kutib turgan xabarlar unga yetkazilmoqda.',
      current.tg_user_id,
    );
  }
  return redeliverPendingToStaff({ ...current, bot_blocked: false });
}

/**
 * Saqlangan mijoz xabarini xodimga yuborish (qayta yetkazish / qo'lda qayta yuborish).
 * `delayed` — sarlavhaga asl vaqt qo'shiladi (🕐 14:05), xodim xabar kechikkanini ko'rsin.
 */
async function deliverClientRowToStaff(
  staff: Staff,
  client: Client,
  row: Message,
  opts: { isFirst: boolean; delayed: boolean },
): Promise<Message> {
  const content = contentFromMessage(row);
  let source: BotKind = 'client';
  if (MEDIA_KINDS.has(row.kind)) {
    if (row.file_id_staff) {
      content.fileId = row.file_id_staff;
      source = 'staff';
    } else if (row.file_id_client) {
      content.fileId = row.file_id_client;
    } else {
      throw new PermanentDeliveryError('Saqlangan xabarda fayl yo\'q');
    }
  }
  const header = clientHeaderForStaff(client);
  if (opts.isFirst) header.header = `🆕 ${header.header}`;
  if (opts.delayed) header.headerSuffix = `${header.headerSuffix ?? ''} · 🕐 ${formatTime(row.created_at)}`;
  const res = await sendContent('staff', staff.tg_user_id!, content, source, {
    ...header,
    replyMarkup: staffMessageKeyboard(row.conversation_id),
  });
  return recordStaffDelivery(row, staff.tg_user_id!, res);
}

/** Qayta yetkazish uchun zarur minimal vaqt (media qayta yuklash ham ulgurishi uchun). */
const REDELIVERY_MIN_MS = 20_000;

/**
 * Xodimga hali yetkazilmagan mijoz xabarlarini (eskisi birinchi, bir chaqiruvda ≤ limit ta) yetkazish.
 * Parallel chaqiruvlar bitta xabarni ikki marta yubormaydi (navbat "band" qilinadi). Yetkazilganlar sonini qaytaradi.
 */
export async function redeliverPendingToStaff(staff: Staff, opts: { limit?: number } = {}): Promise<number> {
  if (!staffApi() || !isStaffAvailable(staff) || staff.bot_blocked) return 0;
  if (remainingMs() < REDELIVERY_MIN_MS) return 0;
  const rows = await claimPendingForStaff(staff.id, opts.limit ?? 5);
  if (!rows.length) return 0;
  const clients = new Map<number, Client | null>();
  let delivered = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (remainingMs() < REDELIVERY_MIN_MS - 5_000) {
      await releaseDeliveryClaims(rows.slice(i).map((r) => r.id)).catch(() => {});
      break;
    }
    if (!clients.has(row.client_id)) clients.set(row.client_id, await getClient(row.client_id));
    const client = clients.get(row.client_id);
    if (!client) {
      await setDeliveryError(row.id, 'client_missing');
      continue;
    }
    try {
      await deliverClientRowToStaff(staff, client, row, { isFirst: row.is_first, delayed: true });
      delivered++;
    } catch (e) {
      logFailure(`[relay] xodimga (#${staff.id}) qayta yetkazib bo'lmadi (xabar #${row.id})`, e);
      const kind = classifyStaffFailure(e);
      if (kind === 'too_big') {
        await setDeliveryError(row.id, 'file_too_big');
        continue;
      }
      if (kind === 'permanent') {
        await setDeliveryError(row.id, truncate(`bad_request: ${tgErrorDescription(e)}`, 200));
        continue;
      }
      if (kind === 'unreachable') {
        await releaseDeliveryClaims(rows.slice(i).map((r) => r.id)).catch(() => {});
        await handleStaffUnreachable(staff);
      } else {
        // Vaqtinchalik xato: bu xabar ~2 daqiqadan keyin navbatga qaytadi, qolganlari darhol bo'shatiladi
        await releaseDeliveryClaims(rows.slice(i + 1).map((r) => r.id)).catch(() => {});
      }
      break;
    }
  }
  if (delivered) console.log(`[relay] xodim #${staff.id}: ${delivered} ta kutib turgan xabar yetkazildi`);
  return delivered;
}

/** Oldingi yetkazilmagan xabarlarni yangi xabardan OLDIN yetkazish (tartib saqlanadi). Xatolar relay ni to'xtatmaydi. */
async function flushPendingBefore(staff: Staff): Promise<void> {
  try {
    await redeliverPendingToStaff(staff);
  } catch (e) {
    console.error(`[relay] xodim #${staff.id} navbatini yetkazishda xato:`, e);
  }
}

/** Mijoz Reply qilgan xabarning xodim chatidagi nusxasi (iqtibos uchun). */
async function staffQuoteFor(client: Client, conversation: Conversation, staff: Staff, replyToClientMsgId: number): Promise<number | undefined> {
  try {
    const row = await findMessageByClientChatMsg(client.tg_user_id, replyToClientMsgId, { conversationId: conversation.id });
    if (!row || row.sender === 'bot' || row.staff_chat_msg_id == null) return undefined;
    // Xodim boshqa Telegram akkauntga ulangan bo'lsa, eski id yangi chatda boshqa xabarni ko'rsatib qo'ymasin
    if (row.staff_chat_id !== staff.tg_user_id) return undefined;
    return row.staff_chat_msg_id;
  } catch (e) {
    console.warn('[relay] iqtibosni aniqlab bo\'lmadi:', e);
    return undefined;
  }
}

/** Xodim Reply qilgan xabarning mijoz chatidagi nusxasi (iqtibos uchun). */
async function clientQuoteFor(staff: Staff, conversation: Conversation, staffChatId: number, replyToStaffMsgId: number): Promise<number | undefined> {
  try {
    const row = await findMessageByStaffChatMsg(staff.id, staffChatId, replyToStaffMsgId, { conversationId: conversation.id });
    return row?.client_chat_msg_id ?? undefined;
  } catch (e) {
    console.warn('[relay] iqtibosni aniqlab bo\'lmadi:', e);
    return undefined;
  }
}

// ───────────────────────────── Avto-javob ─────────────────────────────

/**
 * Bir martalik avto-javob (claimAutoReply bilan atomik band qilingandan keyin chaqiriladi).
 * Vaqtinchalik xatoda (tarmoq, 429, 5xx) belgi qaytariladi — mijozning keyingi xabarida qayta urinadi;
 * doimiy xatoda (400/403) band qolaveradi va (yuborilmagan) yozuv tarixda saqlanadi.
 */
async function sendAutoReply(staff: Staff, client: Client, conversation: Conversation): Promise<Message | undefined> {
  let text: string;
  try {
    text = await greetingText(staff, client);
  } catch (e) {
    await releaseAutoReply(conversation.id).catch(() => {});
    throw e;
  }
  let clientChatMsgId: number | null = null;
  try {
    const sent = await clientApi().sendMessage(client.tg_user_id, text, { link_preview_options: { is_disabled: true } });
    clientChatMsgId = sent.message_id;
  } catch (e) {
    const code = tgErrorCode(e);
    logFailure("Avto-javobni yuborib bo'lmadi", e);
    if (code === 403) {
      await setClientBlocked(client.tg_user_id, true);
    } else if (code === undefined || code === 429 || code >= 500) {
      await releaseAutoReply(conversation.id);
      return undefined;
    }
  }
  return insertMessage({
    conversation_id: conversation.id,
    sender: 'bot',
    kind: 'text',
    text,
    client_chat_msg_id: clientChatMsgId,
    via: 'bot',
  });
}

// ───────────────────────────── Mijoz -> xodim ─────────────────────────────

/**
 * Mijozdan xodimga xabar.
 * 1) saqlanadi (Mini App fayli — avval yuklanadi), 2) birinchi xabar bo'lsa — avto-javob yuboriladi,
 * 3) oldin yetkazilmay qolganlar, keyin shu xabar xodimga staff bot orqali yetkaziladi.
 * `replyToClientMsgId` — mijoz Reply qilgan (o'z chatidagi) xabar: xodimda o'sha xabar iqtibos qilinadi.
 */
export async function relayClientMessage(params: {
  client: Client;
  conversation: Conversation;
  content: Content;
  clientMsgId?: number;
  via: Via;
  replyToClientMsgId?: number;
}): Promise<RelayResult> {
  const { client, conversation, content, clientMsgId, via, replyToClientMsgId } = params;
  if (conversation.client_id !== client.tg_user_id) return { ok: false, error: 'forbidden' };
  if (isEmpty(content)) return { ok: false, error: 'empty' };
  if (tooBig(content)) return { ok: false, error: 'file_too_big' };

  let staff = await getStaff(conversation.staff_id);
  if (!isStaffAvailable(staff)) return { ok: false, error: 'staff_unavailable' };

  const isFirst = !conversation.auto_replied && !conversation.last_message_at;
  const sApi = staffApi();
  const header = clientHeaderForStaff(client);
  if (isFirst) header.header = `🆕 ${header.header}`;
  const sendOpts: SendOptions = { ...header, replyMarkup: staffMessageKeyboard(conversation.id) };
  if (replyToClientMsgId && sApi) {
    const quoted = await staffQuoteFor(client, conversation, staff, replyToClientMsgId);
    if (quoted) sendOpts.replyParameters = { message_id: quoted };
  }

  let message: Message;
  let delivered = false;
  let undeliveredReason: UndeliveredReason | undefined;

  if (content.upload) {
    // Mini App orqali yuklangan fayl: avval yetkazamiz (file_id olish uchun), keyin saqlaymiz
    if (!sApi) return { ok: false, error: 'send_failed' };
    if (!staff.bot_blocked) await flushPendingBefore(staff);
    let res: SendResult;
    try {
      res = await sendContent('staff', staff.tg_user_id!, content, 'client', sendOpts);
    } catch (e) {
      logFailure(`relayClientMessage: yuklangan faylni xodimga (#${staff.id}) yuborib bo'lmadi`, e);
      const kind = classifyStaffFailure(e);
      if (kind === 'unreachable') {
        await handleStaffUnreachable(staff);
        return { ok: false, error: 'staff_unreachable' };
      }
      return { ok: false, error: kind === 'too_big' ? 'file_too_big' : 'send_failed' };
    }
    if (!res.fileId) console.warn(`relayClientMessage: yuklangan ${content.kind} uchun file_id qaytmadi`);
    message = await insertMessage({
      conversation_id: conversation.id,
      sender: 'client',
      kind: storedUploadKind(content, res),
      text: content.text ?? null,
      entities: content.entities ?? null,
      file_id_staff: res.fileId ?? null,
      file_name: content.upload.fileName,
      mime_type: content.upload.mimeType,
      file_size: content.upload.data.byteLength,
      meta: content.meta ?? null,
      staff_chat_id: staff.tg_user_id,
      staff_chat_msg_id: res.messageId,
      via,
    });
    await linkExtras(message.id, 'staff', staff.tg_user_id!, res);
    delivered = true;
  } else {
    message = await insertMessage({
      conversation_id: conversation.id,
      sender: 'client',
      kind: content.kind,
      text: content.text ?? null,
      entities: content.entities ?? null,
      file_id_client: content.fileId ?? null,
      file_unique_id: content.fileUniqueId ?? null,
      file_name: content.fileName ?? null,
      mime_type: content.mimeType ?? null,
      file_size: content.fileSize ?? null,
      meta: content.meta ?? null,
      client_chat_msg_id: clientMsgId ?? null,
      via,
      // Shu chaqiruv yetkazadi — parallel qayta yetkazish uni ikkinchi marta yubormasin
      claimed: !!sApi,
    });
  }

  // Avto-javob (faqat birinchi marta, atomik)
  let autoReply: Message | undefined;
  try {
    if (await claimAutoReply(conversation.id)) autoReply = await sendAutoReply(staff, client, conversation);
  } catch (e) {
    console.error('Avto-javob xatosi:', e);
  }

  // Xodimga yetkazish (bot / Mini App matni)
  if (!content.upload) {
    if (!sApi) {
      undeliveredReason = 'no_staff_bot';
    } else {
      if (!staff.bot_blocked) await flushPendingBefore(staff);
      try {
        const res = await sendContent('staff', staff.tg_user_id!, content, 'client', sendOpts);
        message = await recordStaffDelivery(message, staff.tg_user_id!, res);
        delivered = true;
      } catch (e) {
        logFailure(`Xodimga (#${staff.id}) yetkazib bo'lmadi (xabar #${message.id})`, e);
        switch (classifyStaffFailure(e)) {
          case 'too_big':
            await setDeliveryError(message.id, 'file_too_big');
            return { ok: false, error: 'file_too_big', message };
          case 'permanent':
            await setDeliveryError(message.id, truncate(`bad_request: ${tgErrorDescription(e)}`, 200));
            return { ok: false, error: 'send_failed', message };
          case 'unreachable':
            // Xabar navbatda: xodim qaytganda darhol yetkaziladi
            await releaseDeliveryClaims([message.id]).catch(() => {});
            await handleStaffUnreachable(staff);
            undeliveredReason = 'staff_unreachable';
            break;
          default:
            // Vaqtinchalik: ~2 daqiqadan keyin keyingi imkoniyatda qayta yetkaziladi
            undeliveredReason = 'transient';
        }
      }
    }
  }

  // Xodim botga qaytgan (xabar yetib bordi), lekin belgisi hali turibdi — tozalaymiz va navbatni yetkazamiz
  if (delivered && staff.bot_blocked) {
    try {
      await handleStaffReachable(staff);
      staff = { ...staff, bot_blocked: false };
    } catch (e) {
      console.error(`[relay] xodim #${staff.id} holatini tiklashda xato:`, e);
    }
  }

  return { ok: true, message, delivered, autoReply, ...(undeliveredReason ? { undeliveredReason } : {}) };
}

// ───────────────────────────── Xodim -> mijoz ─────────────────────────────

/**
 * Xodimdan mijozga xabar. Saqlanadi va mijozga client bot orqali yetkaziladi.
 * `replyToStaffMsgId` — xodim Reply qilgan (o'z chatidagi) xabar: mijozda o'sha xabar iqtibos qilinadi.
 */
export async function relayStaffMessage(params: {
  staff: Staff;
  conversation: Conversation;
  content: Content;
  staffChatId?: number;
  staffMsgId?: number;
  via: Via;
  replyToStaffMsgId?: number;
}): Promise<RelayResult> {
  const { staff, conversation, content, staffChatId, staffMsgId, via, replyToStaffMsgId } = params;
  if (conversation.staff_id !== staff.id) return { ok: false, error: 'forbidden' };
  // O'chirib qo'yilgan xodimga mijozlar yoza olmaydi — u ham ularga yoza olmaydi (bot va Mini App bir xil)
  if (!staffCanWrite(staff)) return { ok: false, error: 'staff_inactive' };
  if (isEmpty(content)) return { ok: false, error: 'empty' };
  if (tooBig(content)) return { ok: false, error: 'file_too_big' };

  const client = await getClient(conversation.client_id);
  if (!client) return { ok: false, error: 'client_not_found' };

  const sendOpts: SendOptions = { ...staffHeaderForClient(staff), replyMarkup: clientMessageKeyboard(conversation.id) };
  if (replyToStaffMsgId && staffChatId != null) {
    const quoted = await clientQuoteFor(staff, conversation, staffChatId, replyToStaffMsgId);
    if (quoted) sendOpts.replyParameters = { message_id: quoted };
  }

  if (content.upload) {
    let res: SendResult;
    try {
      res = await sendContent('client', client.tg_user_id, content, 'staff', sendOpts);
    } catch (e) {
      logFailure('relayStaffMessage: yuklangan faylni mijozga yuborib bo\'lmadi', e);
      if (tgErrorCode(e) === 403) {
        await setClientBlocked(client.tg_user_id, true);
        return { ok: false, error: 'client_blocked' };
      }
      return { ok: false, error: e instanceof FileTooBigError ? 'file_too_big' : 'send_failed' };
    }
    if (!res.fileId) console.warn(`relayStaffMessage: yuklangan ${content.kind} uchun file_id qaytmadi`);
    const message = await insertMessage({
      conversation_id: conversation.id,
      sender: 'staff',
      kind: storedUploadKind(content, res),
      text: content.text ?? null,
      entities: content.entities ?? null,
      file_id_client: res.fileId ?? null,
      file_name: content.upload.fileName,
      mime_type: content.upload.mimeType,
      file_size: content.upload.data.byteLength,
      meta: content.meta ?? null,
      client_chat_msg_id: res.messageId,
      via,
    });
    await linkExtras(message.id, 'client', client.tg_user_id, res);
    if (client.bot_blocked) await setClientBlocked(client.tg_user_id, false);
    return { ok: true, message, delivered: true };
  }

  let message = await insertMessage({
    conversation_id: conversation.id,
    sender: 'staff',
    kind: content.kind,
    text: content.text ?? null,
    entities: content.entities ?? null,
    file_id_staff: content.fileId ?? null,
    file_unique_id: content.fileUniqueId ?? null,
    file_name: content.fileName ?? null,
    mime_type: content.mimeType ?? null,
    file_size: content.fileSize ?? null,
    meta: content.meta ?? null,
    staff_chat_id: staffChatId ?? null,
    staff_chat_msg_id: staffMsgId ?? null,
    via,
    claimed: true,
  });

  try {
    const res = await sendContent('client', client.tg_user_id, content, 'staff', sendOpts);
    message = await recordClientDelivery(message, client.tg_user_id, res);
    if (client.bot_blocked) await setClientBlocked(client.tg_user_id, false);
    return { ok: true, message, delivered: true };
  } catch (e) {
    logFailure(`Mijozga (${client.tg_user_id}) yetkazib bo'lmadi (xabar #${message.id})`, e);
    // Qo'lda qayta yuborish (retryStaffDelivery) darhol ishlashi uchun
    await releaseDeliveryClaims([message.id]).catch(() => {});
    if (tgErrorCode(e) === 403) {
      await setClientBlocked(client.tg_user_id, true);
      return { ok: false, error: 'client_blocked', message };
    }
    if (e instanceof FileTooBigError) return { ok: false, error: 'file_too_big', message };
    return { ok: false, error: 'send_failed', message };
  }
}

// ───────────────────────────── Qo'lda qayta yuborish ─────────────────────────────

/**
 * Saqlangan, lekin yetkazilmagan xabarni qayta yuborish (xodim botidagi «🔁 Qayta yuborish» tugmasi yoki
 * Mini App dagi ❗ belgisi). Yangi yozuv yaratilmaydi — tarixda takror bo'lmaydi.
 *  - requester 'staff': o'z xabarini mijozga (sender = 'staff', conversation.staff_id = staff.id);
 *  - requester 'client': o'z xabarini xodimga (sender = 'client', conversation.client_id = client).
 * Allaqachon yetkazilgan bo'lsa — ok (delivered: true), hech narsa yuborilmaydi.
 */
export async function retryDelivery(
  requester: { role: 'staff'; staff: Staff } | { role: 'client'; client: Client },
  messageId: number,
): Promise<RelayResult> {
  const msg = await getMessage(messageId);
  if (!msg) return { ok: false, error: 'forbidden' };
  const conversation = await getConversation(msg.conversation_id);
  if (!conversation) return { ok: false, error: 'forbidden' };

  if (requester.role === 'staff') {
    const { staff } = requester;
    if (conversation.staff_id !== staff.id || msg.sender !== 'staff') return { ok: false, error: 'forbidden' };
    if (msg.client_chat_msg_id != null) return { ok: true, message: msg, delivered: true };
    if (!staffCanWrite(staff)) return { ok: false, error: 'staff_inactive', message: msg };
    const client = await getClient(conversation.client_id);
    if (!client) return { ok: false, error: 'client_not_found' };
    const claimed = await claimMessageDelivery(msg.id, 'client');
    if (!claimed) {
      const now = await getMessage(msg.id);
      return now && now.client_chat_msg_id != null
        ? { ok: true, message: now, delivered: true }
        : { ok: false, error: 'send_failed', message: msg };
    }
    const content = contentFromMessage(claimed);
    let source: BotKind = 'staff';
    if (MEDIA_KINDS.has(claimed.kind)) {
      if (claimed.file_id_client) {
        content.fileId = claimed.file_id_client;
        source = 'client';
      } else if (claimed.file_id_staff) {
        content.fileId = claimed.file_id_staff;
      } else {
        await releaseDeliveryClaims([claimed.id]).catch(() => {});
        return { ok: false, error: 'send_failed', message: claimed };
      }
    }
    try {
      const res = await sendContent('client', client.tg_user_id, content, source, {
        ...staffHeaderForClient(staff),
        replyMarkup: clientMessageKeyboard(conversation.id),
      });
      const message = await recordClientDelivery(claimed, client.tg_user_id, res);
      if (client.bot_blocked) await setClientBlocked(client.tg_user_id, false);
      return { ok: true, message, delivered: true };
    } catch (e) {
      logFailure(`Qayta yuborish: mijozga (${client.tg_user_id}) yetkazib bo'lmadi (xabar #${claimed.id})`, e);
      await releaseDeliveryClaims([claimed.id]).catch(() => {});
      if (tgErrorCode(e) === 403) {
        await setClientBlocked(client.tg_user_id, true);
        return { ok: false, error: 'client_blocked', message: claimed };
      }
      return { ok: false, error: e instanceof FileTooBigError ? 'file_too_big' : 'send_failed', message: claimed };
    }
  }

  const { client } = requester;
  if (conversation.client_id !== client.tg_user_id || msg.sender !== 'client') return { ok: false, error: 'forbidden' };
  if (msg.staff_chat_msg_id != null) return { ok: true, message: msg, delivered: true };
  const staff = await getStaff(conversation.staff_id);
  if (!isStaffAvailable(staff)) return { ok: false, error: 'staff_unavailable', message: msg };
  if (!staffApi()) return { ok: true, message: msg, delivered: false, undeliveredReason: 'no_staff_bot' };
  const claimed = await claimMessageDelivery(msg.id, 'staff');
  if (!claimed) {
    const now = await getMessage(msg.id);
    return now && now.staff_chat_msg_id != null
      ? { ok: true, message: now, delivered: true }
      : { ok: true, message: msg, delivered: false, undeliveredReason: 'transient' };
  }
  try {
    const message = await deliverClientRowToStaff(staff, client, claimed, { isFirst: false, delayed: true });
    if (staff.bot_blocked) await handleStaffReachable(staff).catch((err) => console.error('[relay] handleStaffReachable:', err));
    return { ok: true, message, delivered: true };
  } catch (e) {
    logFailure(`Qayta yuborish: xodimga (#${staff.id}) yetkazib bo'lmadi (xabar #${claimed.id})`, e);
    switch (classifyStaffFailure(e)) {
      case 'too_big':
        await setDeliveryError(claimed.id, 'file_too_big');
        return { ok: false, error: 'file_too_big', message: claimed };
      case 'permanent':
        await setDeliveryError(claimed.id, truncate(`bad_request: ${tgErrorDescription(e)}`, 200));
        return { ok: false, error: 'send_failed', message: claimed };
      case 'unreachable':
        await releaseDeliveryClaims([claimed.id]).catch(() => {});
        await handleStaffUnreachable(staff);
        return { ok: true, message: claimed, delivered: false, undeliveredReason: 'staff_unreachable' };
      default:
        await releaseDeliveryClaims([claimed.id]).catch(() => {});
        return { ok: true, message: claimed, delivered: false, undeliveredReason: 'transient' };
    }
  }
}

// ───────────────────────────── Xato matnlari ─────────────────────────────

/**
 * Foydalanuvchiga tushunarli xato matni (oddiy matn — HTML da ishlatilsa esc() qiling).
 * `saved` — xabar bazada saqlangan (faqat yetkazilmagan) holat uchun aniqroq matn.
 */
export function relayErrorText(error: RelayError, opts: { saved?: boolean } = {}): string {
  switch (error) {
    case 'staff_unavailable':
      return '⚠️ Bu xodim hozir mavjud emas. Iltimos, boshqa operator yoki menejerni tanlang.';
    case 'staff_unreachable':
      return "⚠️ Xodimga hozircha xabar yetkazib bo'lmayapti. Birozdan keyin qayta urinib ko'ring yoki boshqa xodimni tanlang.";
    case 'staff_inactive':
      return "⛔ Profilingiz o'chirib qo'yilgan — mijozlarga xabar yuborib bo'lmaydi. Admin bilan bog'laning.";
    case 'client_blocked':
      return '⚠️ Mijoz botni bloklagan — xabar yetkazilmadi (lekin saqlandi).';
    case 'client_not_found':
      return '⚠️ Mijoz topilmadi.';
    case 'forbidden':
      return '⛔ Bu suhbatga ruxsatingiz yo\'q.';
    case 'file_too_big':
      return '⚠️ Fayl juda katta. 20 MB dan kichik fayl yuboring.';
    case 'empty':
      return '⚠️ Bo\'sh xabar yuborib bo\'lmaydi.';
    case 'send_failed':
    default:
      return opts.saved
        ? "⚠️ Xabar saqlandi, lekin hozircha yetkazilmadi. Birozdan keyin qayta yuborib ko'ring."
        : '⚠️ Xabarni yetkazib bo\'lmadi. Birozdan keyin qayta urinib ko\'ring.';
  }
}

// Xabar almashinuvining yadrosi: mijoz <-> xodim. Bot va Mini App ikkalasi ham shu funksiyalardan foydalanadi.
//
// Yetkazish kafolatlari:
//  - Mijoz xabari avval saqlanadi va shu chaqiruvga "band" qilinadi, keyin xodimga yuboriladi. Yuborib bo'lmasa
//    (xodim botni to'xtatgan, Telegram 429/5xx, tarmoq, vaqt tugashi) xabar navbatda qoladi va tartib bilan qayta
//    yetkaziladi: ANIQ yetkazilmagan vaqtinchalik xatoda (Telegram 429/5xx, ulanib bo'lmadi, faylni yuklab olish)
//    xabar "kutishga" o'tadi (messages.delivery_retry_at = retry_after yoki qisqa pauza) va aynan shu vaqtda fonda
//    (POST /api/redeliver, src/redeliver.ts) — suhbat jim bo'lsa ham — yetkaziladi; xodim botni to'xtatgan bo'lsa —
//    u qaytganda/yozganda. Telegram 429 va 5xx da har bir alohida chaqiruv avval bir marta darhol qayta urinib
//    ko'riladi (src/tg.ts retryOnFlood) — navbatga faqat ikkinchi urinish ham muvaffaqiyatsiz bo'lsa tushadi.
//  - Noaniq xato (so'rov yuborildi, javob kelmadi: taymaut, uzilish) — Telegram xabarni yetkazgan bo'lishi mumkin:
//    AVTOMATIK QAYTA YUBORILMAYDI ("ko'pi bilan bir marta"), navbatdan 'uncertain' bilan chiqariladi va yuboruvchiga
//    aytiladi (qo'lda qayta yuborish mumkin). Xuddi shunday, 2 daqiqadan ortiq "yuborilayotgan" holida qolib ketgan
//    xabar (chaqiruv to'xtab qolgan) ham qayta yuborilmaydi (repo.ts sweepStaleDeliveries).
//  - Suhbat ichida tartib: oldingi xabar hali yetkazilmagan bo'lsa, yangisi uni quvib o'tmaydi. Oldingisini hozir
//    boshqa chaqiruv yubormoqda bo'lsa (albom, tez-tez yozilgan xabarlar) — yangisi qisqa kutib, keyin o'zi (iqtibosi
//    bilan) darhol yuboriladi; oldingisi kutishda bo'lsa — navbatga, uning ortidan qo'yiladi va navbat ularni id
//    tartibida yetkazadi.
//  - Xodim botni bloklagan bo'lsa (403) — u mijozlarga oflayn ko'rinadi va adminlar bir marta ogohlantiriladi.
//  - Qayta urinib bo'lmaydigan xatolar (fayl juda katta, 400) navbatdan chiqariladi va yuboruvchiga aytiladi.
//  - Telegram yetkazgandan KEYINGI baza xatosi (yetkazilganlikni saqlash) hech qachon "yetkazilmadi" deb
//    tasniflanmaydi: qayta urinib ko'riladi (so'rovdan keyin ham — fonda), natija baribir "yetkazildi"; yozuv
//    saqlanmay qolsa ham xabar avtomatik qayta yuborilmaydi (eskirgan band — 'uncertain', yuqoriga qarang).
//    Yuklangan fayl yozuvini saqlashni qayta urinish takroriy yozuv yaratmaydi (findDeliveredMessage).
//  - Har bir yuborilgan Telegram xabari (sarlavha, bo'laklar) saqlangan yozuvga bog'lanadi — Reply har doim
//    to'g'ri suhbatga boradi; Reply qilingan xabar boshqa tomonda ham iqtibos sifatida ko'rinadi.
import { HttpError, InlineKeyboard } from 'grammy';
import { config } from './config.js';
import { remainingMs } from './deadline.js';
import { panelRecipients } from './roles.js';
import {
  addMessageLinks,
  claimAutoReply,
  claimMessageDelivery,
  claimPendingForStaff,
  clearDueRedelivery,
  DELIVERY_UNCERTAIN,
  findDeliveredMessage,
  findMessageByClientChatMsg,
  findMessageByStaffChatMsg,
  getClient,
  getConversation,
  getMessage,
  getStaff,
  insertMessage,
  isStaffAvailable,
  markRedeliveryScheduled,
  markStaffReachable,
  markStaffUnreachable,
  nextRedeliveryAt,
  parkDeliveries,
  pendingHeadBefore,
  relayPendingState,
  releaseAutoReply,
  releaseDeliveryClaims,
  setClientBlocked,
  setDeliveryError,
  updateMessageDelivery,
} from './repo.js';
import {
  REDELIVER_MARGIN_MS,
  REDELIVER_MAX_AHEAD_MS,
  REDELIVER_MAX_HOPS,
  REDELIVER_MAX_INLINE_WAIT_MS,
  requestRedelivery,
  vercelWaitUntil,
} from './redeliver.js';
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
import { clientName, describeError, esc, formatTime, roleIcon, roleLabel, sleep, tgErrorCode, tgErrorDescription, truncate } from './util.js';

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

/**
 * 'transient' — aniq yetkazilmagan vaqtinchalik xato (429, 5xx, ulanib bo'lmadi, faylni yuklab olish): qayta
 * urinish xavfsiz. 'ambiguous' — so'rov Telegramga ketgan, lekin javob kelmadi (taymaut, uzilish): xabar yetkazilgan
 * bo'lishi mumkin — avtomatik qayta yuborilmaydi.
 */
type FailureKind = 'too_big' | 'unreachable' | 'permanent' | 'transient' | 'ambiguous';

/** Ulanishning o'zi o'rnatilmagan (so'rov Telegramga yetib bormagan) tarmoq xatolari. */
const NOT_SENT_NET_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

function netErrorCode(e: unknown): string | undefined {
  for (let cur: unknown = e, depth = 0; cur && typeof cur === 'object' && depth < 4; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Yuborish (send*, copy/forward) chaqiruvi javobsiz qoldi: grammY HttpError (taymaut, uzilish, javob o'qilmadi).
 * Telegram so'rovni bajargan bo'lishi mumkin. getFile kabi yuborish bo'lmagan chaqiruvlar va ulanish umuman
 * o'rnatilmagan xatolar (ECONNREFUSED, DNS) — noaniq emas.
 */
export function isAmbiguousSendFailure(e: unknown): boolean {
  if (!(e instanceof HttpError)) return false;
  if (!/'(send[A-Za-z]*|copyMessages?|forwardMessages?)'/.test(e.message)) return false;
  const code = netErrorCode(e.error);
  return !(code && NOT_SENT_NET_CODES.has(code));
}

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
  if (code === undefined && isAmbiguousSendFailure(e)) return 'ambiguous';
  return 'transient'; // 429, 5xx (transformerdagi qayta urinishdan keyin ham), ulanib bo'lmadi, faylni yuklab olish
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

/** Telegram yetkazgandan keyingi baza yozuvini (so'rov ichida) qayta urinish oraliqlari (ms): jami 4 urinish. */
const AFTER_SEND_RETRY_MS = [250, 1_000, 2_500] as const;

/**
 * Xabar Telegramda ALLAQACHON yetkazilgandan keyingi baza yozuvi (yetkazilganlikni / yuklangan faylni saqlash):
 * vaqtinchalik baza xatosida (ECONNRESET, pooler, TLS) qisqa pauza bilan qayta uriniladi. Baribir bo'lmasa —
 * oxirgi xato tashlanadi (chaqiruvchi hal qiladi). Bu xato hech qachon "yetkazilmadi" deb tasniflanmasligi kerak:
 * aks holda xabar qayta yuboriladi (yoki «🔁 Qayta yuborish» taklif qilinadi) va boshqa tomonda IKKI marta ko'rinadi.
 * `write` ga urinish raqami (0 — birinchi) beriladi: INSERT kabi idempotent bo'lmagan yozuv qayta urinishda avval
 * oldingi urinish saqlab ulgurganini tekshirsin (javobi yo'qolgan bo'lishi mumkin).
 */
async function writeAfterSend<T>(what: string, write: (attempt: number) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await write(attempt);
    } catch (e) {
      const wait = AFTER_SEND_RETRY_MS[attempt];
      if (wait === undefined || remainingMs() < wait + 5_000) throw e;
      console.warn(`[relay] ${what}: baza xatosi, qayta urinish (${attempt + 1}):`, describeError(e));
      await sleep(wait);
    }
  }
}

/**
 * Yetkazilgan, lekin yetkazilganligi bazaga yozilmay qolgan xabarlar (shu instansiya xotirasida): yozuv fonda
 * (so'rovdan keyin ham — waitUntil) va keyingi navbat yetkazishidan OLDIN qayta uriniladi. Yozilmaguncha xabar
 * "yuborilayotgan" holida turadi va hech kim uni qayta yubormaydi; 2 daqiqadan keyin u eskirgan deb navbatdan
 * chiqariladi ('uncertain') — baribir avtomatik qayta yuborilmaydi.
 */
const unrecorded = new Map<number, { side: string; write: () => Promise<void> }>();
const UNRECORDED_MAX = 500;
/** Fondagi qayta urinish oraliqlari (ms). */
const UNRECORDED_RETRY_MS = [2_000, 5_000, 10_000, 20_000] as const;
let unrecordedLoop: Promise<void> | null = null;

function idleDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });
}

/** Yozilmay qolgan yetkazilganlik yozuvlarini bir martadan qayta urinish (xatolar jim). */
export async function flushUnrecordedDeliveries(): Promise<void> {
  if (!unrecorded.size) return;
  for (const [id, item] of [...unrecorded]) {
    try {
      await item.write();
      unrecorded.delete(id);
      console.warn(`[relay] xabar #${id} (${item.side}ga yetkazilgan) yetkazilganligi kechikib saqlandi`);
    } catch {
      /* keyingi urinishda */
    }
  }
}

function scheduleUnrecordedRetry(): void {
  if (unrecordedLoop) return;
  unrecordedLoop = (async () => {
    for (const wait of UNRECORDED_RETRY_MS) {
      await idleDelay(wait);
      await flushUnrecordedDeliveries();
      if (!unrecorded.size) return;
    }
  })().finally(() => {
    unrecordedLoop = null;
  });
  // Vercel: javob qaytgandan keyin ham funksiya shu ishni tugatsin
  try {
    vercelWaitUntil()?.(unrecordedLoop);
  } catch {
    /* e'tiborsiz */
  }
}

/** Yetkazilganlikni saqlash (xabar allaqachon yetkazilgan): xatolar log qilinadi, lekin tashlanmaydi. */
async function persistDelivery(messageId: number, side: 'xodim' | 'mijoz', write: () => Promise<void>): Promise<void> {
  try {
    await writeAfterSend(`xabar #${messageId} (${side}ga yetkazildi) ni saqlash`, () => write());
  } catch (e) {
    // Xabar yetkazilgan — "yetkazilmadi" demaymiz va qayta yubormaymiz. Yozuv fonda qayta uriniladi; yozilmasa ham
    // xabar avtomatik qayta yuborilmaydi (eskirgan band — 'uncertain', repo.ts sweepStaleDeliveries).
    console.error(`[relay] xabar #${messageId} ${side}ga yetkazildi, lekin bazaga yozib bo'lmadi (fonda qayta uriniladi):`, describeError(e));
    if (unrecorded.size < UNRECORDED_MAX) unrecorded.set(messageId, { side, write });
    scheduleUnrecordedRetry();
  }
}

/**
 * Yetkazilganlik yozuvi band / kutish / xato belgilarini ham tozalaydi: kechikib (fonda) saqlangan yozuv oldin
 * eskirgan deb 'uncertain' bilan belgilangan bo'lsa ham, xabar yetkazilgan deb ko'rinadi.
 */
const SETTLED = { delivery_claimed_at: null, delivery_retry_at: null, delivery_error: null } as const;

/**
 * Mijoz xodimga yozgan xabarning xodim chatidagi yetkazilishini saqlash. Hech qachon xato tashlamaydi (xabar
 * yetkazilgan — baza xatosi uni qayta yuborishga olib kelmasin).
 */
async function recordStaffDelivery(message: Message, chatId: number, res: SendResult): Promise<Message> {
  const fileIdStaff = res.fileId ?? message.file_id_staff ?? null;
  await persistDelivery(message.id, 'xodim', () =>
    updateMessageDelivery(message.id, {
      staff_chat_id: chatId,
      staff_chat_msg_id: res.messageId,
      ...(fileIdStaff ? { file_id_staff: fileIdStaff } : {}),
      ...SETTLED,
    }),
  );
  await linkExtras(message.id, 'staff', chatId, res);
  return { ...message, staff_chat_id: chatId, staff_chat_msg_id: res.messageId, file_id_staff: fileIdStaff };
}

/** Xodim yozgan xabarning mijoz chatidagi yetkazilishini saqlash. Hech qachon xato tashlamaydi (yuqoriga qarang). */
async function recordClientDelivery(message: Message, chatId: number, res: SendResult): Promise<Message> {
  const fileIdClient = res.fileId ?? message.file_id_client ?? null;
  await persistDelivery(message.id, 'mijoz', () =>
    updateMessageDelivery(message.id, {
      client_chat_msg_id: res.messageId,
      ...(fileIdClient ? { file_id_client: fileIdClient } : {}),
      ...SETTLED,
    }),
  );
  await linkExtras(message.id, 'client', chatId, res);
  return { ...message, client_chat_msg_id: res.messageId, file_id_client: fileIdClient };
}

/** Mijoz yana yetib boradi (yetkazildi) — "botni bloklagan" belgisini olib tashlash; xato relay ni buzmaydi. */
async function clearClientBlocked(client: Client): Promise<void> {
  if (!client.bot_blocked) return;
  await setClientBlocked(client.tg_user_id, false).catch((e) =>
    console.error(`[relay] mijoz ${client.tg_user_id} belgisini tozalab bo'lmadi:`, describeError(e)),
  );
}

/** Panel foydalanuvchilariga (developer, ROP, adminlar — xodimlar boti orqali) xabar — xatolar e'tiborsiz (admin botni ochmagan bo'lishi mumkin). */
async function notifyAdmins(html: string, exceptTgId: number | null): Promise<void> {
  const api = staffApi();
  if (!api) return;
  const recipients = await panelRecipients('panel').catch(() => config.adminIds);
  await Promise.allSettled(
    recipients
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
 * Boshqa botdan yuklab olib, qayta yuklanadigan media (file_id_staff yo'q) uchun zarur minimal vaqt: shundan kam
 * qolgan bo'lsa shu chaqiruvda urinilmaydi (keyingi, to'liq byudjetli chaqiruvga qoldiriladi) — qisqa byudjetda
 * yuklash taymautga uchrab, "noaniq" (yetkazilgan bo'lishi mumkin) holatga tushmasin.
 */
const REDELIVERY_UPLOAD_MIN_MS = 30_000;
/** Bir partiyada band qilinadigan xabarlar soni. */
const REDELIVERY_BATCH = 5;
/**
 * Telegram 429 dan keyin xabar ko'pi bilan shuncha (soniya) kutishga qo'yiladi: fon zanjiri (REDELIVER_MAX_AHEAD_MS
 * = 10 daqiqa ichida) uni aynan shu vaqtda uyg'ota olishi kerak. retry_after bundan uzun bo'lsa — shu vaqtda bir
 * marta tekshiriladi (Telegram yana 429 va qolgan vaqtni qaytaradi) va yana kutishga qo'yiladi.
 */
const MAX_FLOOD_PARK_SEC = 540;
/** Noaniq xatodan keyin partiyaning qolgan (yuborilmagan) xabarlari shuncha (soniya) kutishga qo'yiladi. */
const AMBIGUOUS_PAUSE_SEC = 20;

/** Telegram 429 javobidagi retry_after (soniya). */
function retryAfterSec(e: unknown): number | undefined {
  const params = (e as { parameters?: { retry_after?: unknown } } | null)?.parameters;
  const n = Number(params?.retry_after);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Vaqtinchalik xatodan keyin qayta urinishgacha kutish (soniya): 429 — Telegram aytgan retry_after (+1 s,
 * ≤ MAX_FLOOD_PARK_SEC); 5xx / ulanib bo'lmadi — xabar yoshiga qarab o'sadigan qisqa pauza (5 … 60 s).
 */
function transientRetryDelaySec(e: unknown, createdAt: Date | string | null | undefined): number {
  if (tgErrorCode(e) === 429) return Math.min(Math.ceil(retryAfterSec(e) ?? 5) + 1, MAX_FLOOD_PARK_SEC);
  const created = createdAt ? new Date(createdAt).getTime() : NaN;
  const ageSec = Number.isFinite(created) ? Math.max(0, (Date.now() - created) / 1000) : 0;
  return Math.round(Math.min(60, Math.max(5, ageSec / 2)));
}

/**
 * Fon yetkazishni `atMs` ga so'rash. requestRedelivery REDELIVER_MAX_AHEAD_MS dan uzoq vaqtni jimgina rad etadi —
 * shuning uchun undan uzog'i chegaraga qisqartiriladi (o'sha vaqtda zanjir navbatni qayta ko'rib, davom etadi).
 */
async function requestAt(staffId: number, atMs: number, hop: number): Promise<boolean> {
  const at = Math.min(atMs, Date.now() + REDELIVER_MAX_AHEAD_MS - 1_000);
  return requestRedelivery(staffId, at, { hop });
}

/** Kutishga qo'yilgan xabar(lar) uchun fon yetkazishni retry vaqtiga rejalashtirish. */
async function scheduleRetry(staffId: number, retryAt: Date | null, hop = 0): Promise<void> {
  if (retryAt) await requestAt(staffId, retryAt.getTime() + REDELIVER_MARGIN_MS, hop);
}

interface BatchResult {
  claimed: number;
  delivered: number;
  /**
   * Partiya nima uchun to'xtadi: 'unreachable' — xodim botni bloklagan (403); 'transient' — vaqtinchalik xato,
   * xabar(lar) kutishga qo'yildi (retryAt); 'budget' — so'rov vaqti tugayapti (qolganlari bo'shatildi).
   */
  stop?: 'unreachable' | 'transient' | 'budget';
  retryAt?: Date | null;
  /**
   * Telegram 429 (retry_after): zanjir "aylanmayapti" — Telegram aytgan vaqtni kutyapti. Shu kutish uchun fon
   * zanjiri hop hisobini noldan boshlaydi (uzoq flood kutishlari hop cheklovini tugatib qo'ymasin).
   */
  flood?: boolean;
}

/** Media qatorini yetkazish uchun boshqa botdan yuklab olib, qayta yuklash kerakmi. */
function needsUpload(row: Message): boolean {
  return MEDIA_KINDS.has(row.kind) && !row.file_id_staff;
}

/**
 * Xodimga hali yetkazilmagan mijoz xabarlarining bir partiyasini (eskisi birinchi, suhbat ichida tartib bilan) band
 * qilib yetkazish. Parallel chaqiruvlar bitta xabarni ikki marta yubormaydi. Rejalashtirmaydi — chaqiruvchi hal qiladi.
 */
async function redeliverBatch(staff: Staff, limit = REDELIVERY_BATCH): Promise<BatchResult> {
  if (!staffApi() || !isStaffAvailable(staff) || staff.bot_blocked) return { claimed: 0, delivered: 0 };
  if (remainingMs() < REDELIVERY_MIN_MS) return { claimed: 0, delivered: 0, stop: 'budget' };
  // Avval shu instansiyada yozilmay qolgan "yetkazildi" yozuvlari (aks holda ular eskirgan deb chiqarilardi)
  await flushUnrecordedDeliveries();
  const rows = await claimPendingForStaff(staff.id, limit);
  const out: BatchResult = { claimed: rows.length, delivered: 0 };
  const clients = new Map<number, Client | null>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (remainingMs() < REDELIVERY_MIN_MS - 5_000 || (needsUpload(row) && remainingMs() < REDELIVERY_UPLOAD_MIN_MS)) {
      await releaseDeliveryClaims(rows.slice(i).map((r) => r.id)).catch(() => {});
      out.stop = 'budget';
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
      out.delivered++;
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
      const rest = rows.slice(i + 1).map((r) => r.id);
      if (kind === 'unreachable') {
        await releaseDeliveryClaims(rows.slice(i).map((r) => r.id)).catch(() => {});
        await handleStaffUnreachable(staff);
        out.stop = 'unreachable';
      } else if (kind === 'ambiguous') {
        // Noaniq (so'rov ketdi, javob kelmadi): xodim xabarni olgan bo'lishi mumkin — avtomatik qayta yuborilmaydi,
        // navbatdan chiqariladi (qo'lda qayta yuborish mumkin). Qolganlari aniq yuborilmagan — qisqa kutishga.
        await setDeliveryError(row.id, DELIVERY_UNCERTAIN).catch((err) =>
          console.error(`[relay] xabar #${row.id} ni 'uncertain' deb belgilab bo'lmadi:`, describeError(err)),
        );
        out.retryAt = await parkDeliveries(rest, AMBIGUOUS_PAUSE_SEC).catch(() => null);
        out.stop = 'transient';
      } else {
        // Aniq yetkazilmagan vaqtinchalik xato: xabar band holicha kutishga o'tadi (aynan retry vaqtida qayta olinadi;
        // suhbatining keyingi xabarlari uning ortida turadi). 429 — xodimning chati "to'lgan": qolganlari ham
        // (hammasi o'sha chatga ketadi) kutishga o'tadi; boshqa xatolarda qolganlari darhol bo'shatiladi.
        const flood = tgErrorCode(e) === 429;
        const parked = flood ? [row.id, ...rest] : [row.id];
        out.retryAt = await parkDeliveries(parked, transientRetryDelaySec(e, row.created_at)).catch(() => null);
        if (!flood) await releaseDeliveryClaims(rest).catch(() => {});
        out.stop = 'transient';
        out.flood = flood;
      }
      break;
    }
  }
  if (out.delivered) console.log(`[relay] xodim #${staff.id}: ${out.delivered} ta kutib turgan xabar yetkazildi`);
  return out;
}

/** Partiyadan keyin navbatda yana xabar qolgan bo'lsa — fon yetkazishni rejalashtirish (xatolar jim). */
async function scheduleAfterBatch(staffId: number, r: BatchResult, limit: number, hop: number): Promise<void> {
  try {
    if (r.stop === 'unreachable') return;
    if (r.stop === 'transient') {
      if (r.retryAt) return scheduleRetry(staffId, r.retryAt, r.flood ? 0 : hop);
    } else if (r.stop !== 'budget' && r.claimed < limit) {
      return; // partiya to'lmadi — hozir olinadigan boshqa xabar yo'q (kutishdagilarni ularni qo'ygan rejalashtirgan)
    }
    const next = await nextRedeliveryAt(staffId);
    if (next) await requestAt(staffId, next.getTime() + REDELIVER_MARGIN_MS, hop);
  } catch (e) {
    console.error(`[relay] xodim #${staffId}: fon yetkazishni rejalashtirishda xato:`, describeError(e));
  }
}

/**
 * Xodimga hali yetkazilmagan mijoz xabarlarini (eskisi birinchi, bir chaqiruvda ≤ limit ta) yetkazish.
 * Parallel chaqiruvlar bitta xabarni ikki marta yubormaydi (navbat "band" qilinadi). Navbatda yana xabar qolsa
 * (partiya to'ldi, vaqtinchalik xato yoki vaqt tugadi) — fon yetkazish rejalashtiriladi. Yetkazilganlar sonini qaytaradi.
 */
export async function redeliverPendingToStaff(staff: Staff, opts: { limit?: number; hop?: number } = {}): Promise<number> {
  const limit = opts.limit ?? REDELIVERY_BATCH;
  const r = await redeliverBatch(staff, limit);
  if (staffApi() && isStaffAvailable(staff) && !staff.bot_blocked) await scheduleAfterBatch(staff.id, r, limit, opts.hop ?? 0);
  return r.delivered;
}

/**
 * Fon yetkazish (POST /api/redeliver, notBefore kelgandan keyin): xodimning navbatini partiyalab, tartib bilan
 * yetkazadi. Qisqa kutish (keyingi retry vaqti) byudjetga sig'sa — shu chaqiruvda kutadi, aks holda keyingi fon
 * chaqiruvini rejalashtiradi (hop + 1; Telegram 429 kutishi uchun — hop 0). Yetkazilganlar sonini qaytaradi.
 */
export async function runScheduledRedelivery(staffId: number, hop = 0): Promise<number> {
  const staff = await getStaff(staffId);
  if (!staffApi() || !isStaffAvailable(staff) || staff.bot_blocked) {
    await clearDueRedelivery(staffId).catch(() => {});
    return 0;
  }
  await clearDueRedelivery(staffId);
  // Zanjirning oxirgi bo'g'ini davom etolmaydi (hop cheklovi) — u fon belgisini egallamasin: aks holda shu oraliqda
  // kelgan yangi hodisaning (hop 0) so'rovi "allaqachon rejalashtirilgan" deb rad etilib, ishi yo'qolardi
  const lastHop = hop >= REDELIVER_MAX_HOPS;
  let delivered = 0;
  // Keyingi bo'g'in: shu chaqiruvda navbat siljigan (yetkazildi) yoki Telegram 429 ni kutyapti — hop noldan (zanjir
  // "aylanmayapti"; uzoq navbat / flood hop cheklovini tugatib, keyingi ishni yo'qotib qo'ymasin)
  const nextHop = (flood: boolean): number => (flood || delivered > 0 ? 0 : hop + 1);
  let flood = false;
  for (let round = 0; round < 40; round++) {
    const r = await redeliverBatch(staff);
    delivered += r.delivered;
    if (r.stop === 'unreachable') return delivered;
    if (r.stop === 'budget') break;
    if (!r.stop && r.claimed > 0) continue; // navbatda yana bo'lishi mumkin
    flood = !!r.flood;
    // Hozir olinadigan xabar qolmadi (yoki kutishga qo'yildi): keyingisi qachon?
    const next = await nextRedeliveryAt(staffId);
    if (!next) return delivered;
    const delay = Math.max(0, next.getTime() + REDELIVER_MARGIN_MS - Date.now());
    if (delay <= REDELIVER_MAX_INLINE_WAIT_MS && remainingMs() - delay >= REDELIVERY_MIN_MS + 2_000) {
      // Shu chaqiruvda kutamiz — boshqa chaqiruvlar takrorlanmasin (belgi); boshqasi ertaroqqa rejalashtirgan bo'lsa, u hal qiladi
      if (delay > 0) {
        if (!lastHop && !(await markRedeliveryScheduled(staffId, new Date(Date.now() + delay)))) return delivered;
        await sleep(delay);
        await clearDueRedelivery(staffId);
      }
      continue;
    }
    await requestAt(staffId, next.getTime() + REDELIVER_MARGIN_MS, nextHop(flood));
    return delivered;
  }
  const next = await nextRedeliveryAt(staffId).catch(() => null);
  if (next) await requestAt(staffId, next.getTime() + REDELIVER_MARGIN_MS, nextHop(flood));
  return delivered;
}

/**
 * Oldingi yetkazilmagan xabarlarni yangi xabardan OLDIN yetkazish (tartib saqlanadi). Xatolar relay ni to'xtatmaydi.
 * Partiya natijasini qaytaradi (xato bo'lsa null).
 */
async function flushPendingBefore(staff: Staff): Promise<BatchResult | null> {
  try {
    const r = await redeliverBatch(staff);
    await scheduleAfterBatch(staff.id, r, REDELIVERY_BATCH, 0);
    return r;
  } catch (e) {
    console.error(`[relay] xodim #${staff.id} navbatini yetkazishda xato:`, e);
    return null;
  }
}

/**
 * Xodim "botni bloklagan" deb belgilangan, lekin navbatda xabarlar bor: eng eskisini yuborib ko'ramiz — yetib borsa,
 * xodim qaytgan (belgi olinadi, adminlar xabardor qilinadi, navbat yetkaziladi); 403 bo'lsa — belgi qoladi.
 * Shu tariqa tartib buzilmaydi (yangi xabar eskilaridan oldin ketmaydi). Yangilangan xodim holatini qaytaradi.
 */
async function probeBlockedStaff(staff: Staff): Promise<{ staff: Staff; unreachable: boolean }> {
  try {
    const r = await redeliverBatch({ ...staff, bot_blocked: false });
    if (r.delivered > 0) {
      await handleStaffReachable(staff);
      return { staff: { ...staff, bot_blocked: false }, unreachable: false };
    }
    return { staff, unreachable: r.stop === 'unreachable' };
  } catch (e) {
    console.error(`[relay] xodim #${staff.id} (bloklangan) navbatini tekshirishda xato:`, e);
    return { staff, unreachable: false };
  }
}

/**
 * Yangi (saqlangan, shu chaqiruvga band qilingan) mijoz xabarini yuborishdan oldin: xodimning navbatini yetkazish va
 * shu suhbatda undan oldingi xabar hali yetkazilmay qolgan-qolmaganini aniqlash. Qolgan bo'lsa — `queuedUntil`
 * (navbat boshi qachon yana olinadi): yangi xabar yuborilmaydi, ularning ortidan navbatga qo'yiladi.
 * Oldingi xabarni hozir boshqa (tirik) chaqiruv yubormoqda bo'lsa (albom qismlari, ketma-ket yuborilgan xabarlar
 * parallel keladi) — shu chaqiruvda qisqa kutiladi: u yetkazilishi bilan yangi xabar darhol, asl ko'rinishida
 * (iqtibosi bilan, 🕐 siz) yuboriladi. Faqat oldingisi kutishda/eskirgan bo'lsa yoki kutish vaqti tugasa — navbatga.
 * `unreachable` — shu chaqiruvda xodimga yuborish 403 bilan qaytdi (o'z xabarini yuborib ko'rish shart emas).
 */
async function prepareOrderedDelivery(
  staff: Staff,
  message: Message,
): Promise<{ staff: Staff; queuedUntil: Date | null; unreachable: boolean }> {
  let current = staff;
  let unreachable = false;
  const state = await relayPendingState(staff.id, message.conversation_id, message.id);
  if (state.flushable) {
    if (current.bot_blocked) {
      ({ staff: current, unreachable } = await probeBlockedStaff(current));
    } else {
      const r = await flushPendingBefore(current);
      if (r?.stop === 'unreachable') {
        current = { ...current, bot_blocked: true };
        unreachable = true;
      }
    }
  }
  if (!state.older) return { staff: current, queuedUntil: null, unreachable };
  const started = Date.now();
  let step = QUEUE_POLL_FIRST_MS;
  for (;;) {
    const head = await pendingHeadBefore(message.conversation_id, message.id);
    if (!head) return { staff: current, queuedUntil: null, unreachable };
    const canWait =
      head.in_flight &&
      !unreachable &&
      !current.bot_blocked &&
      Date.now() - started + step <= QUEUE_WAIT_MAX_MS &&
      remainingMs() - step >= QUEUE_WAIT_MIN_LEFT_MS;
    if (!canWait) return { staff: current, queuedUntil: new Date(head.next_at), unreachable };
    await sleep(step);
    step = Math.min(QUEUE_POLL_MAX_MS, Math.round(step * 1.5));
  }
}

/** Oldingi xabar yuborilayotganda (in_flight) yangi xabar shu chaqiruvda ko'pi bilan shuncha kutadi. */
const QUEUE_WAIT_MAX_MS = 20_000;
/** Kutishdan keyin o'z xabarini yuborish uchun so'rovda kamida shuncha vaqt qolishi kerak. */
const QUEUE_WAIT_MIN_LEFT_MS = 25_000;
/** Navbat boshini tekshirish oralig'i: 120 ms dan boshlab 600 ms gacha o'sadi. */
const QUEUE_POLL_FIRST_MS = 120;
const QUEUE_POLL_MAX_MS = 600;

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
    const upload = content.upload;
    const sent = res;
    const staffChatId = staff.tg_user_id!;
    // Fayl allaqachon yetkazilgan: vaqtinchalik baza xatosi qayta urinib ko'riladi (aks holda foydalanuvchi uni
    // qayta yuklab, xodim ikki marta oladi). Qayta urinishda — avval oldingi urinish saqlab ulgurganmi (javobi
    // yo'qolgan bo'lishi mumkin): takroriy yozuv yaratilmaydi.
    message = await writeAfterSend('yuklangan fayl (xodimga yetkazildi) ni saqlash', async (attempt) =>
      (attempt > 0
        ? await findDeliveredMessage(conversation.id, 'client', { staffChatId, staffChatMsgId: sent.messageId })
        : null) ??
      insertMessage({
        conversation_id: conversation.id,
        sender: 'client',
        kind: storedUploadKind(content, sent),
        text: content.text ?? null,
        entities: content.entities ?? null,
        file_id_staff: sent.fileId ?? null,
        file_name: upload.fileName,
        mime_type: upload.mimeType,
        file_size: upload.data.byteLength,
        meta: content.meta ?? null,
        staff_chat_id: staffChatId,
        staff_chat_msg_id: sent.messageId,
        via,
      }),
    );
    await linkExtras(message.id, 'staff', staffChatId, res);
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
      // Avval navbat (eskisi birinchi); shu suhbatda oldingi xabar hali yetkazilmagan bo'lsa — yangisi uning ortidan
      const before: Staff = staff;
      const order = await prepareOrderedDelivery(before, message).catch((e: unknown) => {
        // Navbatni tekshirib bo'lmadi (baza xatosi) — xabarni yo'qotmaslik uchun oddiygidek yuboramiz
        console.error(`[relay] xodim #${before.id} navbatini tekshirishda xato:`, describeError(e));
        return { staff: before, queuedUntil: null, unreachable: false };
      });
      staff = order.staff;
      if (order.queuedUntil || order.unreachable) {
        // Band bo'shatiladi: navbat (fon yetkazish / xodim qaytishi) ularni id tartibida yetkazadi
        await releaseDeliveryClaims([message.id]).catch(() => {});
        undeliveredReason = staff.bot_blocked ? 'staff_unreachable' : 'transient';
        if (!staff.bot_blocked && order.queuedUntil) {
          await requestAt(staff.id, order.queuedUntil.getTime() + REDELIVER_MARGIN_MS, 0);
        }
      } else {
        let res: SendResult | null = null;
        try {
          res = await sendContent('staff', staff.tg_user_id!, content, 'client', sendOpts);
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
            case 'ambiguous':
              // So'rov ketdi, javob kelmadi (taymaut/uzilish) — xodim xabarni olgan bo'lishi mumkin: avtomatik qayta
              // yuborilmaydi (takror bo'lmasin). Navbatdan chiqariladi (keyingilarini to'smaydi); yuboruvchiga aytiladi —
              // kerak bo'lsa o'zi qayta yuboradi (Mini App: ❗ qayta yuborish).
              await setDeliveryError(message.id, DELIVERY_UNCERTAIN).catch((err) =>
                console.error(`[relay] xabar #${message.id} ni 'uncertain' deb belgilab bo'lmadi:`, describeError(err)),
              );
              return { ok: false, error: 'send_failed', message: { ...message, delivery_error: DELIVERY_UNCERTAIN } };
            default: {
              // Aniq yetkazilmagan vaqtinchalik xato (429 retry_after, 5xx, ulanib bo'lmadi): xabar kutishga o'tadi va
              // aynan retry vaqtida fonda (suhbat jim bo'lsa ham) qayta yetkaziladi; shu suhbatning keyingi xabarlari
              // uning ortidan navbatda turadi.
              undeliveredReason = 'transient';
              const retryAt = await parkDeliveries([message.id], transientRetryDelaySec(e, message.created_at)).catch((err) => {
                console.error(`[relay] xabar #${message.id} ni kutishga qo'yib bo'lmadi:`, describeError(err));
                return null;
              });
              await scheduleRetry(staff.id, retryAt);
            }
          }
        }
        if (res) {
          // Yetkazildi. Saqlash xatosi (baza) endi "yetkazilmadi" deb tasniflanmaydi — aks holda xabar kutishga
          // qo'yilib, qayta yetkazishda xodimga IKKINCHI marta borardi (recordStaffDelivery xato tashlamaydi).
          message = await recordStaffDelivery(message, staff.tg_user_id!, res);
          delivered = true;
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
    const upload = content.upload;
    const sent = res;
    // Fayl mijozga allaqachon yetkazilgan: vaqtinchalik baza xatosi qayta urinib ko'riladi — aks holda xodim
    // umumiy xatoni ko'rib faylni qayta yuklaydi va mijoz uni ikki marta oladi. Qayta urinishda takroriy yozuv
    // yaratilmaydi (oldingi INSERT bajarilgan, lekin javobi yo'qolgan bo'lishi mumkin).
    const message = await writeAfterSend('yuklangan fayl (mijozga yetkazildi) ni saqlash', async (attempt) =>
      (attempt > 0 ? await findDeliveredMessage(conversation.id, 'staff', { clientChatMsgId: sent.messageId }) : null) ??
      insertMessage({
        conversation_id: conversation.id,
        sender: 'staff',
        kind: storedUploadKind(content, sent),
        text: content.text ?? null,
        entities: content.entities ?? null,
        file_id_client: sent.fileId ?? null,
        file_name: upload.fileName,
        mime_type: upload.mimeType,
        file_size: upload.data.byteLength,
        meta: content.meta ?? null,
        client_chat_msg_id: sent.messageId,
        via,
      }),
    );
    await linkExtras(message.id, 'client', client.tg_user_id, res);
    await clearClientBlocked(client);
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

  let res: SendResult;
  try {
    res = await sendContent('client', client.tg_user_id, content, 'staff', sendOpts);
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
  // Mijoz xabarni oldi. Bundan keyingi baza xatosi "send_failed" (va «🔁 Qayta yuborish») bo'lmasligi kerak —
  // bosilsa mijoz xabarni ikkinchi marta oladi. Ikkala yordamchi ham xato tashlamaydi.
  message = await recordClientDelivery(message, client.tg_user_id, res);
  await clearClientBlocked(client);
  return { ok: true, message, delivered: true };
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
    let res: SendResult;
    try {
      res = await sendContent('client', client.tg_user_id, content, source, {
        ...staffHeaderForClient(staff),
        replyMarkup: clientMessageKeyboard(conversation.id),
      });
    } catch (e) {
      logFailure(`Qayta yuborish: mijozga (${client.tg_user_id}) yetkazib bo'lmadi (xabar #${claimed.id})`, e);
      await releaseDeliveryClaims([claimed.id]).catch(() => {});
      if (tgErrorCode(e) === 403) {
        await setClientBlocked(client.tg_user_id, true);
        return { ok: false, error: 'client_blocked', message: claimed };
      }
      return { ok: false, error: e instanceof FileTooBigError ? 'file_too_big' : 'send_failed', message: claimed };
    }
    // Yetkazildi — saqlash xatosi qayta yuborishga (takrorga) olib kelmasin
    const message = await recordClientDelivery(claimed, client.tg_user_id, res);
    await clearClientBlocked(client);
    return { ok: true, message, delivered: true };
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
      case 'ambiguous':
        // Javobsiz qoldi — yetkazilgan bo'lishi mumkin: navbatga qaytarilmaydi (avtomatik takror bo'lmasin)
        await setDeliveryError(claimed.id, DELIVERY_UNCERTAIN).catch(() => {});
        return { ok: false, error: 'send_failed', message: { ...claimed, delivery_error: DELIVERY_UNCERTAIN } };
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
      return "🚫 Profilingiz bloklangan — mijozlarga xabar yuborib bo'lmaydi. Admin bilan bog'laning.";
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

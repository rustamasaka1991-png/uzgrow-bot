// Telegram Bot API yordamchilari: ikkala bot uchun Api obyektlari, fayllarni botlar o'rtasida ko'chirish,
// sarlavha (header) bilan istalgan turdagi xabarni yuborish va tahrirlash.
import { Api, InputFile, type Transformer } from 'grammy';
import type { InlineKeyboardMarkup, Message as TgMessage, MessageEntity, ReplyParameters } from 'grammy/types';
import { config } from './config.js';
import { callBudgetMs, canRetryAfter, remainingMs } from './deadline.js';
import type { BotKind, Content, MessageMeta, MsgKind } from './types.js';
import { isNotModified, sleep, tgErrorDescription } from './util.js';

/** Oddiy (JSON) Bot API chaqiruvi uchun maksimal vaqt. */
const JSON_CALL_CAP_MS = 15_000;
/** Fayl yuklanadigan (multipart) chaqiruv uchun maksimal vaqt — 20 MB gacha fayl syd1 dan ham ulgurishi kerak. */
const UPLOAD_CALL_CAP_MS = 40_000;
/** Telegram fayl serveridan yuklab olish uchun maksimal vaqt. */
const DOWNLOAD_CAP_MS = 30_000;
/** grammY ning o'z taymauti (zaxira; asosiy chegaralar yuqoridagi transformer da). */
const CLIENT_TIMEOUT_SECONDS = 50;
/** Telegram 5xx (vaqtinchalik nosozlik) bo'lganda qayta urinishdan oldingi pauza. */
const SERVER_ERROR_RETRY_DELAY_MS = 1_000;

/** Payload ichida yuklanadigan fayl (InputFile) bormi — masalan, sendPhoto, editMessageMedia, sendMediaGroup. */
function hasInputFile(value: unknown, depth = 0): boolean {
  if (value instanceof InputFile) return true;
  if (depth >= 3 || value === null || typeof value !== 'object') return false;
  const values = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  return values.some((v) => hasInputFile(v, depth + 1));
}

/** Telegram server tomonidagi xato (5xx) — odatda vaqtinchalik, qayta urinish mumkin. */
function isServerError(code: number | undefined): boolean {
  return typeof code === 'number' && code >= 500 && code <= 599;
}

function timedSignal(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Barcha Api/Bot obyektlariga o'rnatiladigan himoya (nomi tarixiy):
 *  1) Har bir chaqiruvga vaqt chegarasi: JSON ≤ 15 s, fayl yuklash ≤ 40 s va hech qachon so'rov byudjetidan
 *     (src/deadline.ts) oshmaydi — Vercel funksiyani o'ldirishidan oldin xato qaytadi va foydalanuvchiga
 *     xato matni yuborishga ulguriladi.
 *  2) Telegram 429 (Too Many Requests): qisqa (≤ 10 s) va so'rov vaqti yetsa — kutib, bir marta qayta urinish.
 *     Aks holda xato chaqiruvchiga qaytadi.
 *  3) Telegram 5xx (Bad Gateway, Internal Server Error va h.k. — Telegram tomonidagi vaqtinchalik nosozlik):
 *     1 s kutib, so'rov vaqti yetsa — bir marta qayta urinish. Qayta urinish shu yerda, alohida chaqiruv
 *     darajasida: ko'p qismli yuborishda (sarlavha + fayl, bo'laklangan matn) avval muvaffaqiyatli ketgan
 *     qismlar takrorlanmaydi. Tarmoq xatosi / taymaut (HttpError) bu yerga `res` sifatida kelmaydi va qayta
 *     yuborilmaydi — Telegram so'rovni allaqachon bajargan bo'lishi mumkin (xabar ikki marta ketmasin).
 * Har bir chaqiruv uchun ko'pi bilan bitta qayta urinish.
 */
export const retryOnFlood: Transformer = async (prev, method, payload, signal) => {
  const cap = hasInputFile(payload) ? UPLOAD_CALL_CAP_MS : JSON_CALL_CAP_MS;
  // grammY signal turini abort-controller shim orqali e'lon qiladi; native AbortSignal ish vaqtida mos keladi
  const outer = signal as unknown as AbortSignal | undefined;
  const call = () => prev(method, payload, timedSignal(outer, callBudgetMs(cap)) as unknown as typeof signal);
  const res = await call();
  if (res.ok || outer?.aborted) return res;
  if (res.error_code === 429) {
    const wait = Math.max(1, Number(res.parameters?.retry_after ?? 1));
    if (wait <= 10 && wait * 1000 + 5_000 < remainingMs()) {
      await sleep(wait * 1000);
      return call();
    }
  } else if (isServerError(res.error_code) && canRetryAfter(SERVER_ERROR_RETRY_DELAY_MS)) {
    await sleep(SERVER_ERROR_RETRY_DELAY_MS);
    return call();
  }
  return res;
};

/** Alias: aniqroq nom bilan (vaqt chegarasi + flood himoyasi). */
export const apiGuard = retryOnFlood;

let clientApiInstance: Api | null = null;
let staffApiInstance: Api | null = null;

function createApi(token: string): Api {
  const api = new Api(token, { apiRoot: config.telegramApiRoot, timeoutSeconds: CLIENT_TIMEOUT_SECONDS });
  api.config.use(retryOnFlood);
  return api;
}

export function clientApi(): Api {
  if (!clientApiInstance) clientApiInstance = createApi(config.clientBotToken);
  return clientApiInstance;
}

/** Xodimlar boti. STAFF_BOT_TOKEN bo'lmasa null. */
export function staffApi(): Api | null {
  if (!config.hasStaffBot) return null;
  if (!staffApiInstance) staffApiInstance = createApi(config.staffBotToken);
  return staffApiInstance;
}

export function apiFor(bot: BotKind): Api | null {
  return bot === 'client' ? clientApi() : staffApi();
}

function tokenFor(bot: BotKind): string {
  return bot === 'client' ? config.clientBotToken : config.staffBotToken;
}

/** Bot API getFile orqali yuklab olish limiti (20 MB). */
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

export class FileTooBigError extends Error {
  constructor() {
    super('Fayl juda katta (20 MB dan oshmasligi kerak)');
  }
}

/** Faylni berilgan botning file_id si orqali yuklab olish (vaqt chegarasi bilan). */
export async function downloadFile(bot: BotKind, fileId: string): Promise<{ data: Uint8Array; filePath: string }> {
  const api = apiFor(bot);
  if (!api) throw new Error(`${bot} boti sozlanmagan`);
  let file;
  try {
    file = await api.getFile(fileId); // vaqt chegarasi — retryOnFlood transformer ida
  } catch (e) {
    // Bot API 20 MB dan katta fayl uchun getFile da 400 "file is too big" qaytaradi
    if (/file is too big/i.test(tgErrorDescription(e))) throw new FileTooBigError();
    throw e;
  }
  if (!file.file_path) throw new FileTooBigError();
  if (file.file_size && file.file_size > MAX_DOWNLOAD_BYTES) throw new FileTooBigError();
  // Signal javob tanasini o'qishni (arrayBuffer) ham qamraydi
  const res = await fetch(fileUrl(bot, file.file_path), { signal: AbortSignal.timeout(callBudgetMs(DOWNLOAD_CAP_MS)) });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`Faylni yuklab bo'lmadi: HTTP ${res.status}`);
  }
  const data = new Uint8Array(await res.arrayBuffer());
  if (data.byteLength > MAX_DOWNLOAD_BYTES) throw new FileTooBigError();
  return { data, filePath: file.file_path };
}

/** Faylga server tomonidan murojaat qilish uchun URL (TOKENNI O'Z ICHIGA OLADI — hech qachon mijozga bermang). */
export function fileUrl(bot: BotKind, filePath: string): string {
  return `${config.telegramApiRoot}/file/bot${tokenFor(bot)}/${filePath}`;
}

/** Telegram xabaridan saqlanadigan mazmunni ajratib olish. Qo'llab-quvvatlanmasa null. */
export function extractContent(msg: TgMessage): Content | null {
  const caption = msg.caption ?? undefined;
  const captionEntities = msg.caption_entities ?? undefined;
  if (msg.text !== undefined) {
    return { kind: 'text', text: msg.text, entities: msg.entities };
  }
  if (msg.photo && msg.photo.length) {
    const p = msg.photo[msg.photo.length - 1]!;
    return {
      kind: 'photo',
      text: caption,
      entities: captionEntities,
      fileId: p.file_id,
      fileUniqueId: p.file_unique_id,
      fileSize: p.file_size,
      mimeType: 'image/jpeg',
      meta: { width: p.width, height: p.height },
    };
  }
  if (msg.animation) {
    const a = msg.animation;
    return {
      kind: 'animation',
      text: caption,
      entities: captionEntities,
      fileId: a.file_id,
      fileUniqueId: a.file_unique_id,
      fileName: a.file_name,
      mimeType: a.mime_type,
      fileSize: a.file_size,
      meta: { width: a.width, height: a.height, duration: a.duration },
    };
  }
  if (msg.video) {
    const v = msg.video;
    return {
      kind: 'video',
      text: caption,
      entities: captionEntities,
      fileId: v.file_id,
      fileUniqueId: v.file_unique_id,
      fileName: v.file_name,
      mimeType: v.mime_type,
      fileSize: v.file_size,
      meta: { width: v.width, height: v.height, duration: v.duration },
    };
  }
  if (msg.document) {
    const d = msg.document;
    return {
      kind: 'document',
      text: caption,
      entities: captionEntities,
      fileId: d.file_id,
      fileUniqueId: d.file_unique_id,
      fileName: d.file_name,
      mimeType: d.mime_type,
      fileSize: d.file_size,
    };
  }
  if (msg.audio) {
    const a = msg.audio;
    return {
      kind: 'audio',
      text: caption,
      entities: captionEntities,
      fileId: a.file_id,
      fileUniqueId: a.file_unique_id,
      fileName: a.file_name ?? ([a.performer, a.title].filter(Boolean).join(' - ') || undefined),
      mimeType: a.mime_type,
      fileSize: a.file_size,
      meta: { duration: a.duration },
    };
  }
  if (msg.voice) {
    const v = msg.voice;
    return {
      kind: 'voice',
      text: caption,
      entities: captionEntities,
      fileId: v.file_id,
      fileUniqueId: v.file_unique_id,
      mimeType: v.mime_type ?? 'audio/ogg',
      fileSize: v.file_size,
      meta: { duration: v.duration },
    };
  }
  if (msg.video_note) {
    const v = msg.video_note;
    return {
      kind: 'video_note',
      fileId: v.file_id,
      fileUniqueId: v.file_unique_id,
      mimeType: 'video/mp4',
      fileSize: v.file_size,
      meta: { duration: v.duration, width: v.length, height: v.length },
    };
  }
  if (msg.sticker) {
    const s = msg.sticker;
    return {
      kind: 'sticker',
      fileId: s.file_id,
      fileUniqueId: s.file_unique_id,
      mimeType: s.is_video ? 'video/webm' : s.is_animated ? 'application/x-tgsticker' : 'image/webp',
      fileSize: s.file_size,
      meta: { emoji: s.emoji, width: s.width, height: s.height, sticker_animated: s.is_animated || s.is_video },
    };
  }
  if (msg.location || msg.venue) {
    const loc = msg.venue?.location ?? msg.location!;
    return {
      kind: 'location',
      text: msg.venue ? [msg.venue.title, msg.venue.address].filter(Boolean).join(', ') : undefined,
      meta: { latitude: loc.latitude, longitude: loc.longitude },
    };
  }
  if (msg.contact) {
    const c = msg.contact;
    return {
      kind: 'contact',
      meta: {
        phone_number: c.phone_number,
        contact_name: [c.first_name, c.last_name].filter(Boolean).join(' '),
      },
    };
  }
  return null;
}

export interface SendOptions {
  /** Qalin (bold) sarlavha, masalan "👤 Ali Valiyev". Bo'sh bo'lsa sarlavhasiz yuboriladi. */
  header?: string;
  /** Sarlavhadan keyin oddiy matn (masalan " · @username") */
  headerSuffix?: string;
  replyMarkup?: InlineKeyboardMarkup;
  /** Birinchi yuboriladigan xabar shu xabarga "reply" (iqtibos) bo'ladi. allow_sending_without_reply doim qo'shiladi. */
  replyParameters?: ReplyParameters;
}

export interface SendResult {
  /** Asosiy (mazmunli) xabarning message_id si — reply orqali yo'naltirish uchun */
  messageId: number;
  /**
   * Shu mazmun uchun yuborilgan BARCHA xabarlar (tartib bilan): alohida sarlavha, uzun matn bo'laklari,
   * uzun izoh davomi va asosiy xabar. Har biriga Reply qilinsa ham to'g'ri suhbat topilishi uchun saqlanadi.
   */
  messageIds: number[];
  /** Maqsad botdagi yangi file_id (media bo'lsa) */
  fileId?: string;
  /** Telegram haqiqatda yetkazgan tur (masalan, hujjat audio sifatida qaytishi mumkin). */
  sentKind?: MsgKind;
}

export const TEXT_LIMIT = 4096;
export const CAPTION_LIMIT = 1024;

/** Izoh (caption) qo'yib bo'lmaydigan turlar: sarlavha alohida xabar bo'lib, mazmun unga reply qilinadi. */
const STANDALONE_HEADER_KINDS: readonly MsgKind[] = ['location', 'contact', 'sticker', 'video_note'];
/** Izohli media turlari (editMessageCaption bilan tahrirlanadi). */
export const CAPTIONED_KINDS: readonly MsgKind[] = ['photo', 'video', 'animation', 'audio', 'voice', 'document'];

function utf16Len(s: string): number {
  return s.length;
}

/** Sarlavha + matnni entity lar bilan birlashtirish (HTML parse_mode ishlatilmaydi — xavfsiz). */
export function withHeader(
  header: string | undefined,
  headerSuffix: string | undefined,
  body: string,
  bodyEntities: MessageEntity[] | undefined,
): { text: string; entities: MessageEntity[] } {
  if (!header) return { text: body, entities: bodyEntities ?? [] };
  const head = header + (headerSuffix ?? '');
  const prefix = body ? head + '\n' : head;
  const entities: MessageEntity[] = [{ type: 'bold', offset: 0, length: utf16Len(header) }];
  const shift = utf16Len(prefix);
  for (const e of bodyEntities ?? []) entities.push({ ...e, offset: e.offset + shift });
  return { text: prefix + body, entities };
}

/**
 * Relay qilingan mazmun bitta Telegram xabariga sig'adimi (ya'ni joyida tahrirlash mumkinmi):
 * matn — sarlavha bilan ≤ 4096, izohli media — sarlavha bilan ≤ 1024. Aks holda u bo'laklab yuborilgan.
 */
export function fitsSingleMessage(
  kind: MsgKind,
  text: string | null | undefined,
  entities: MessageEntity[] | null | undefined,
  header?: string,
  headerSuffix?: string,
): boolean {
  const merged = withHeader(header, headerSuffix, text ?? '', entities ?? undefined);
  if (kind === 'text') return merged.text.length <= TEXT_LIMIT;
  if (CAPTIONED_KINDS.includes(kind)) return merged.text.length <= CAPTION_LIMIT;
  return false;
}

function lastPhotoId(m: TgMessage): string | undefined {
  return m.photo?.[m.photo.length - 1]?.file_id;
}

/** Yuborilgan xabar turi (Telegram yuklangan faylni boshqa tur sifatida qaytarishi mumkin). */
function sentKindOf(m: TgMessage): MsgKind | undefined {
  if (m.photo?.length) return 'photo';
  if (m.animation) return 'animation';
  if (m.video) return 'video';
  if (m.video_note) return 'video_note';
  if (m.voice) return 'voice';
  if (m.audio) return 'audio';
  if (m.sticker) return 'sticker';
  if (m.document) return 'document';
  if (m.location) return 'location';
  if (m.contact) return 'contact';
  if (m.text !== undefined) return 'text';
  return undefined;
}

/**
 * Yuborilgan xabardagi yangi file_id: avval so'ralgan turdagi maydon, keyin — fayl tashiydigan istalgan maydon
 * (masalan, yuklangan .mp3 hujjat audio, WEBP esa stiker bo'lib qaytishi mumkin). Aks holda file_id yo'qolardi.
 */
function fileIdOf(kind: MsgKind, m: TgMessage): string | undefined {
  let preferred: string | undefined;
  switch (kind) {
    case 'photo':
      preferred = lastPhotoId(m);
      break;
    case 'video':
      preferred = m.video?.file_id;
      break;
    case 'animation':
      preferred = m.animation?.file_id ?? m.document?.file_id;
      break;
    case 'document':
      preferred = m.document?.file_id;
      break;
    case 'audio':
      preferred = m.audio?.file_id;
      break;
    case 'voice':
      preferred = m.voice?.file_id;
      break;
    case 'video_note':
      preferred = m.video_note?.file_id;
      break;
    case 'sticker':
      preferred = m.sticker?.file_id;
      break;
    default:
      return undefined;
  }
  return (
    preferred ??
    m.document?.file_id ??
    m.animation?.file_id ??
    m.video?.file_id ??
    m.audio?.file_id ??
    m.voice?.file_id ??
    m.video_note?.file_id ??
    m.sticker?.file_id ??
    lastPhotoId(m)
  );
}

/**
 * Multipart sarlavhasi uchun xavfsiz fayl nomi. grammY nomni qo'shtirnoqsiz yozadi (\r/\n bo'lsa xato beradi),
 * shuning uchun boshqaruv belgilari, qo'shtirnoq, nuqtali vergul va yo'l ajratgichlari almashtiriladi.
 */
export function safeFileName(name: string | null | undefined): string {
  let n = String(name ?? '')
    .split(/[\\/]/)
    .pop()!
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}"<>|:*?;=]/gu, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^\.+$/.test(n)) n = '';
  const chars = Array.from(n);
  if (chars.length > 120) {
    const dot = n.lastIndexOf('.');
    const ext = dot > 0 && n.length - dot <= 10 ? n.slice(dot) : '';
    n = Array.from(ext ? n.slice(0, dot) : n).slice(0, 120 - ext.length).join('') + ext;
  }
  return n;
}

function defaultFileName(kind: MsgKind, content: Content): string {
  const given = safeFileName(content.fileName);
  if (given) return given;
  const ext: Partial<Record<MsgKind, string>> = {
    photo: 'jpg',
    video: 'mp4',
    animation: 'mp4',
    voice: 'ogg',
    video_note: 'mp4',
    audio: 'mp3',
    sticker: content.mimeType === 'video/webm' ? 'webm' : content.mimeType === 'application/x-tgsticker' ? 'tgs' : 'webp',
    document: 'bin',
  };
  return `${kind}.${ext[kind] ?? 'bin'}`;
}

type Extra = Record<string, unknown>;

function quoteOf(messageId: number): { reply_parameters: ReplyParameters } {
  return { reply_parameters: { message_id: messageId, allow_sending_without_reply: true } };
}

/**
 * Mazmunni `target` bot orqali `chatId` ga yuborish.
 * - Agar content.upload bo'lsa — shu fayl yuklanadi.
 * - Aks holda, agar `sourceBot` === `target` bo'lsa — file_id to'g'ridan-to'g'ri ishlatiladi,
 *   aks holda fayl manba botdan yuklab olinib, maqsad botga qayta yuklanadi.
 *
 * Har bir yuborilgan xabar o'z-o'zidan kimniki ekanini ko'rsatadi (parallel yozayotgan mijozlar xabarlari
 * aralashib ketsa ham): izoh qo'yib bo'lmaydigan turlar (stiker, video-xabar, joylashuv, kontakt) sarlavha
 * xabariga reply qilib yuboriladi; uzun matnda sarlavha birinchi bo'lak bilan birga, keyingi bo'laklar esa
 * birinchisiga reply; uzun izoh davomi media xabarga reply. Klaviatura (replyMarkup) asosiy xabarda,
 * chaqiruvchi iqtibosi (replyParameters) esa birinchi yuborilgan xabarda.
 */
export async function sendContent(
  target: BotKind,
  chatId: number,
  content: Content,
  sourceBot: BotKind,
  opts: SendOptions = {},
): Promise<SendResult> {
  const api = apiFor(target);
  if (!api) throw new Error(`${target} boti sozlanmagan`);
  const { header, headerSuffix, replyMarkup, replyParameters } = opts;
  const keyboard: Extra = replyMarkup ? { reply_markup: replyMarkup } : {};
  const callerQuote: Extra = replyParameters
    ? { reply_parameters: { ...replyParameters, allow_sending_without_reply: true } }
    : {};
  const ids: number[] = [];

  // ── Matn ──
  if (content.kind === 'text') {
    const merged = withHeader(header, headerSuffix, content.text ?? '', content.entities);
    if (merged.text.length <= TEXT_LIMIT) {
      const m = await api.sendMessage(chatId, merged.text, {
        entities: merged.entities,
        link_preview_options: { is_disabled: false },
        ...keyboard,
        ...callerQuote,
      });
      return { messageId: m.message_id, messageIds: [m.message_id], sentKind: 'text' };
    }
    // Juda uzun: sarlavha birinchi bo'lak bilan birga; keyingi bo'laklar birinchisiga reply (formatlash saqlanadi)
    const chunkIds = await sendChunks(api, chatId, merged.text, merged.entities, {
      first: callerQuote,
      last: keyboard,
      threadToFirst: true,
    });
    return { messageId: chunkIds[chunkIds.length - 1]!, messageIds: chunkIds, sentKind: 'text' };
  }

  // ── Izoh qo'yib bo'lmaydigan turlar: sarlavha alohida, mazmun unga reply ──
  let contentQuote: Extra = callerQuote;
  if (STANDALONE_HEADER_KINDS.includes(content.kind)) {
    const intro = content.kind === 'location' ? (content.text ?? '') : '';
    if (header || intro) {
      const h = withHeader(header, headerSuffix, intro, undefined);
      const hm = await api.sendMessage(chatId, h.text, {
        entities: h.entities,
        link_preview_options: { is_disabled: true },
        ...callerQuote,
      });
      ids.push(hm.message_id);
      contentQuote = quoteOf(hm.message_id);
    }
  }

  // ── Joylashuv ──
  if (content.kind === 'location') {
    const meta = content.meta ?? {};
    const m = await api.sendLocation(chatId, meta.latitude ?? 0, meta.longitude ?? 0, { ...keyboard, ...contentQuote });
    ids.push(m.message_id);
    return { messageId: m.message_id, messageIds: ids, sentKind: 'location' };
  }

  // ── Kontakt ──
  if (content.kind === 'contact') {
    const meta = content.meta ?? {};
    const m = await api.sendContact(chatId, meta.phone_number ?? '', meta.contact_name || 'Kontakt', {
      ...keyboard,
      ...contentQuote,
    });
    ids.push(m.message_id);
    return { messageId: m.message_id, messageIds: ids, sentKind: 'contact' };
  }

  // ── Media ──
  let media: string | InputFile;
  if (content.upload) {
    media = new InputFile(content.upload.data, content.upload.fileName);
  } else if (content.fileId && sourceBot === target) {
    media = content.fileId;
  } else if (content.fileId) {
    const { data } = await downloadFile(sourceBot, content.fileId);
    media = new InputFile(data, defaultFileName(content.kind, content));
  } else {
    throw new Error('Media fayl topilmadi');
  }

  let cap: Extra = {};
  let overflow = false;
  if (!STANDALONE_HEADER_KINDS.includes(content.kind)) {
    const merged = withHeader(header, headerSuffix, content.text ?? '', content.entities);
    if (merged.text.length <= CAPTION_LIMIT) {
      if (merged.text) cap = { caption: merged.text, caption_entities: merged.entities };
    } else {
      // Izoh juda uzun: media faqat sarlavha bilan, izoh esa media xabarga reply qilingan alohida matn(lar)
      const h = withHeader(header, headerSuffix, '', undefined);
      if (h.text) cap = { caption: h.text, caption_entities: h.entities };
      overflow = true;
    }
  }
  const extra: Extra = { ...cap, ...keyboard, ...contentQuote };

  let sent: TgMessage;
  switch (content.kind) {
    case 'photo':
      sent = await api.sendPhoto(chatId, media, extra);
      break;
    case 'video':
      sent = await api.sendVideo(chatId, media, { ...extra, supports_streaming: true });
      break;
    case 'animation':
      sent = await api.sendAnimation(chatId, media, extra);
      break;
    case 'audio':
      sent = await api.sendAudio(chatId, media, extra);
      break;
    case 'voice':
      sent = await api.sendVoice(chatId, media, extra);
      break;
    case 'video_note':
      sent = await api.sendVideoNote(chatId, media, extra);
      break;
    case 'sticker':
      try {
        sent = await api.sendSticker(chatId, media, extra);
      } catch (e) {
        // Ba'zi stikerlarni boshqa botga ko'chirib bo'lmaydi — emoji bilan almashtiramiz
        console.warn('sendSticker xatosi, emoji yuborilmoqda:', tgErrorDescription(e));
        sent = await api.sendMessage(chatId, `${content.meta?.emoji ?? '🎨'} (stiker)`, extra);
      }
      break;
    case 'document':
    default:
      // Hujjat hujjatligicha qolsin: Telegram yuklangan .mp3/.mp4 ni audio/video ga aylantirmasin
      // (aks holda saqlangan tur va file_id mos kelmay qoladi). file_id bilan yuborishda bayroq ta'sir qilmaydi.
      sent = await api.sendDocument(chatId, media, { ...extra, disable_content_type_detection: true });
      break;
  }
  ids.push(sent.message_id);

  if (overflow && content.text) {
    const extraIds = await sendChunks(api, chatId, content.text, content.entities, { all: quoteOf(sent.message_id) });
    ids.push(...extraIds);
  }

  const fileId = fileIdOf(content.kind, sent);
  if (!fileId && !(content.kind === 'sticker' && sent.text !== undefined)) {
    console.warn(`sendContent: ${content.kind} yuborildi, lekin javobda file_id topilmadi (${sentKindOf(sent) ?? '?'})`);
  }
  return { messageId: sent.message_id, messageIds: ids, fileId, sentKind: sentKindOf(sent) ?? content.kind };
}

/**
 * Uzun matnni bo'laklab yuborish; har bir bo'lakka unga tegishli entity lar (siljitilgan) beriladi.
 * first — faqat birinchi bo'lakka (masalan, chaqiruvchi iqtibosi), last — faqat oxirgisiga (klaviatura),
 * all — hammasiga; threadToFirst — 2-bo'lakdan boshlab birinchi bo'lakka reply (kimniki ekani ko'rinsin).
 * Barcha yuborilgan xabarlar id lari qaytadi.
 */
async function sendChunks(
  api: Api,
  chatId: number,
  text: string,
  entities: MessageEntity[] | undefined,
  opts: { first?: Extra; last?: Extra; all?: Extra; threadToFirst?: boolean } = {},
): Promise<number[]> {
  const ranges = splitRanges(text, TEXT_LIMIT);
  const ids: number[] = [];
  for (let i = 0; i < ranges.length; i++) {
    const [start, end] = ranges[i]!;
    const chunkEntities = sliceEntities(entities, start, end);
    let reply: Extra = { ...opts.all };
    if (i === 0) reply = { ...reply, ...opts.first };
    else if (opts.threadToFirst) reply = quoteOf(ids[0]!);
    const m = await api.sendMessage(chatId, text.slice(start, end), {
      ...(chunkEntities.length ? { entities: chunkEntities } : {}),
      ...reply,
      ...(i === ranges.length - 1 ? opts.last : {}),
    });
    ids.push(m.message_id);
  }
  return ids;
}

export type EditOutcome = 'edited' | 'unchanged';

/** Relay qilingan xabarni joyida tahrirlab bo'lmaydi (turi, uzunligi) — chaqiruvchi yangi xabar yuborsin. */
export class NotEditableError extends Error {
  constructor(reason: string) {
    super(`Xabarni joyida tahrirlab bo'lmaydi: ${reason}`);
  }
}

/**
 * Oldin sendContent bilan yuborilgan (bitta xabarga sig'gan) matn yoki media izohini joyida tahrirlash —
 * xuddi o'sha sarlavha va klaviatura bilan. "message is not modified" → 'unchanged'.
 * Joyida tahrirlab bo'lmasa NotEditableError, Telegram xatolari esa o'zicha tashlanadi.
 * Muhim: klaviaturani saqlash uchun replyMarkup qayta berilishi kerak (bermaslik uni o'chiradi).
 */
export async function editRelayed(
  target: BotKind,
  chatId: number,
  messageId: number,
  content: Pick<Content, 'kind' | 'text' | 'entities'>,
  opts: Pick<SendOptions, 'header' | 'headerSuffix' | 'replyMarkup'> = {},
): Promise<EditOutcome> {
  const api = apiFor(target);
  if (!api) throw new Error(`${target} boti sozlanmagan`);
  const merged = withHeader(opts.header, opts.headerSuffix, content.text ?? '', content.entities);
  const keyboard = opts.replyMarkup ? { reply_markup: opts.replyMarkup } : {};
  if (content.kind === 'text') {
    if (!merged.text.trim()) throw new NotEditableError("bo'sh matn");
    if (merged.text.length > TEXT_LIMIT) throw new NotEditableError('matn juda uzun');
  } else if (CAPTIONED_KINDS.includes(content.kind)) {
    if (merged.text.length > CAPTION_LIMIT) throw new NotEditableError('izoh juda uzun');
  } else {
    throw new NotEditableError(`${content.kind} turini tahrirlab bo'lmaydi`);
  }
  try {
    if (content.kind === 'text') {
      await api.editMessageText(chatId, messageId, merged.text, {
        entities: merged.entities,
        link_preview_options: { is_disabled: false },
        ...keyboard,
      });
    } else {
      await api.editMessageCaption(chatId, messageId, {
        caption: merged.text,
        ...(merged.text ? { caption_entities: merged.entities } : {}),
        ...keyboard,
      });
    }
    return 'edited';
  } catch (e) {
    if (isNotModified(e)) return 'unchanged';
    throw e;
  }
}

/** [start, end) oralig'iga tushadigan entity lar, bo'lak boshiga nisbatan. */
export function sliceEntities(entities: MessageEntity[] | undefined, start: number, end: number): MessageEntity[] {
  const out: MessageEntity[] = [];
  for (const e of entities ?? []) {
    const s = Math.max(e.offset, start);
    const t = Math.min(e.offset + e.length, end);
    if (t > s) out.push({ ...e, offset: s - start, length: t - s });
  }
  return out;
}

/**
 * Matnni limitdan oshmaydigan [start, end) bo'laklarga bo'lish (iloji bo'lsa qator yoki so'z oxirida).
 * Bo'laklar orasidagi bitta yangi qator / bo'sh joy tashlab yuboriladi; surrogate juftlar bo'linmaydi.
 */
export function splitRanges(text: string, limit: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let pos = 0;
  while (text.length - pos > limit) {
    const rest = text.slice(pos, pos + limit + 1);
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit);
    if (cut < limit * 0.5) cut = limit;
    // Surrogate juftni bo'lib yubormaslik
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    out.push([pos, pos + cut]);
    pos += cut;
    if (text[pos] === '\n' || text[pos] === ' ') pos += 1;
  }
  if (pos < text.length || !out.length) out.push([pos, text.length]);
  return out;
}

/** Matnni limitdan oshmaydigan bo'laklarga bo'lish (iloji bo'lsa qator oxirida). */
export function splitText(text: string, limit: number): string[] {
  return splitRanges(text, limit).map(([s, e]) => text.slice(s, e));
}

/** Xabarlarga reaksiya qo'yish (xatoni e'tiborsiz qoldiradi). */
export async function react(bot: BotKind, chatId: number, messageId: number, emoji: '👍' | '👌' | '✍' = '👍'): Promise<void> {
  const api = apiFor(bot);
  if (!api) return;
  try {
    await api.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji }]);
  } catch {
    /* reaksiya muhim emas */
  }
}

export type { MessageMeta };

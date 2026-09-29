// Mini App backend: POST /api/app
// So'rov: JSON { initData, action, ...params } yoki multipart/form-data (fayl yuklash uchun: initData, action, ..., file).
// Javob: { ok: true, ...data } yoki { ok: false, error: <kod>, message: <o'zbekcha matn> }.
// Mini App faqat xodimlar (va admin) uchun: mijozlar boti orqali ochilgan initData bilan har qanday amal
// 403 client_app_disabled qaytaradi (mijozlar faqat bot chatida yozadi). Mijoz tomonidagi eski kod yo'llari
// (ClientCtx) endi ishlatilmaydi, lekin umumiy funksiyalar bilan chambarchas bog'liq bo'lgani uchun qoldirilgan.
import { createHash } from 'node:crypto';
import { InputFile } from 'grammy';
import { verifyInitData, type WebAppAuth, type WebAppUser } from '../auth.js';
import { isAdmin } from '../config.js';
import { json } from '../http.js';
import {
  contentFromMessage,
  relayClientMessage,
  relayErrorText,
  relayStaffMessage,
  retryDelivery,
  staffMessageKeyboard,
  type RelayError,
  type RelayResult,
} from '../relay.js';
import {
  addMessageLinks,
  countStaffConversations,
  createStaff,
  deleteSetting,
  getClient,
  getConversation,
  getConversationView,
  getMessage,
  getOrCreateConversation,
  getSetting,
  isValidLinkCode,
  getStaff,
  getStaffByLinkCode,
  getStaffByTgId,
  getStats,
  isStaffAvailable,
  listAllStaff,
  listAvailableStaff,
  listMessages,
  listStaffConversations,
  markReadByClient,
  normalizeLinkCode,
  markReadByStaff,
  regenerateInvite,
  setClientActiveConversation,
  setClientBlocked,
  setSetting,
  setStaffLinkCode,
  setStaffPhoto,
  softDeleteStaff,
  unlinkStaff,
  updateMessageDelivery,
  updateStaff,
  updateStaffUsername,
  type StaffEditableField,
} from '../repo.js';
import { DEFAULT_GREETING, DEFAULT_OFFLINE_NOTE, DEFAULT_WELCOME, SETTING_KEYS, STAFF_NOTICE } from '../texts.js';
import { FileTooBigError, apiFor, clientApi, sendContent, staffApi } from '../tg.js';
import type { BotKind, Client, Content, Conversation, Message, Sender, Staff } from '../types.js';
import { clientName, dativeSuffix, describeError, esc, oneLine, tgErrorCode, tgErrorDescription, truncate } from '../util.js';
import { deliverHeldToConversation } from '../bots/client/routing.js';
import { mainKeyboard } from '../bots/staff/ui.js';
import { ensureSchema } from '../setup.js';
import {
  MEDIA_KINDS,
  adminStaffDTO,
  clientConvSummary,
  clientRowFrom,
  messageDTO,
  safeClientBotUsername,
  safeClientLink,
  staffCardDTO,
  staffConvSummary,
  staffProfileDTO,
  type ConvSummaryDTO,
  type MessageDTO,
} from './dto.js';
import { MAX_UPLOAD_BYTES, classifyUpload, extForMime, redact, sniffImage } from './files.js';
import { claimSend, completeSend, hitRateLimit, releaseSend, type RateRule } from './guards.js';
import {
  activeRouteStaff,
  deliveredAmong,
  listClientConvRows,
  listEditedMessages,
  searchStaffConvRows,
  sumStaffUnread,
} from './queries.js';

// ───────────────────────────── Umumiy ─────────────────────────────

type Params = Record<string, unknown>;
type Data = Record<string, unknown>;

/** So'rov tanasining maksimal hajmi: 4 MB fayl + maydonlar uchun zaxira. */
const MAX_BODY_BYTES = MAX_UPLOAD_BYTES + 512 * 1024;
/** JSON so'rovlar kichik bo'ladi. */
const MAX_JSON_CHARS = 256 * 1024;
const TEXT_MAX = 4096;
const CAPTION_MAX = 1024;
const SETTING_MAX = 2000;
const PAGE_DEFAULT = 50;
const PAGE_MAX = 100;
const SYNC_MAX = 100;
const STAFF_LIST_LIMIT = 100;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Javobga qo'shiladigan maydonlar (masalan retry_after) va HTTP sarlavhalar (masalan Retry-After) */
    readonly extra: { data?: Data; headers?: Record<string, string> } = {},
  ) {
    super(message);
  }
}

const MSG = {
  unauthorized: 'Sessiya eskirgan. Mini App ni qayta oching.',
  clientAppDisabled: 'Bu ilova faqat xodimlar uchun. Iltimos, bot chatiga qayting va shu yerda yozing.',
  linkInvalid: "Havola nomi 2–32 ta lotin harfi, raqam yoki _ bo'lishi kerak",
  linkTaken: 'Bu havola nomi band',
  notStaff: "⛔ Siz xodimlar ro'yxatida yo'qsiz. Admin bergan taklif havolasi orqali xodimlar botiga ulaning.",
  badRequest: "⚠️ Noto'g'ri so'rov.",
  noAction: "⚠️ So'rovda amal (action) ko'rsatilmagan.",
  unknownAction: "⚠️ Noma'lum amal.",
  methodNotAllowed: "Faqat POST so'rovlar qabul qilinadi.",
  fileTooBig: '⚠️ Fayl hajmi 4 MB dan oshmasligi kerak.',
  noFile: '⚠️ Fayl tanlanmagan.',
  emptyFile: "⚠️ Fayl bo'sh.",
  convNotFound: '⚠️ Suhbat topilmadi.',
  msgNotFound: '⚠️ Xabar topilmadi.',
  staffNotFound: '⚠️ Xodim topilmadi.',
  adminOnly: '⛔ Bu amal faqat admin uchun.',
  staffOnly: '⛔ Bu amal faqat xodimlar uchun.',
  clientOnly: '⛔ Bu amal faqat mijozlar uchun.',
  invalidId: "⚠️ Noto'g'ri identifikator.",
  textRequired: '⚠️ Xabar matnini kiriting.',
  textTooLong: `⚠️ Xabar juda uzun (ko'pi bilan ${TEXT_MAX} belgi).`,
  captionTooLong: `⚠️ Izoh juda uzun (ko'pi bilan ${CAPTION_MAX} belgi).`,
  badStatus: "⚠️ Holat noto'g'ri ko'rsatilgan.",
  badImage: '⚠️ Faqat JPG, PNG yoki WEBP rasm yuklang.',
  imageRejected: "⚠️ Telegram bu rasmni qabul qilmadi. Boshqa rasm (JPG yoki PNG) yuklab ko'ring.",
  adminChatUnavailable: '⚠️ Rasmni saqlash uchun avval xodimlar botiga /start yozing.',
  staffBotMissing: '⚠️ Xodimlar boti sozlanmagan.',
  chatUnavailable: "⚠️ Faylni yuborib bo'lmadi: avval botga /start yozing.",
  fileMissing: "⚠️ Bu xabarda yuboriladigan fayl yo'q.",
  fileTooBigForBot: "⚠️ Fayl juda katta (20 MB dan ortiq) — uni botga ko'chirib bo'lmaydi.",
  sendFailed: "⚠️ Yuborib bo'lmadi. Birozdan keyin qayta urinib ko'ring.",
  internal: "⚠️ Xatolik yuz berdi. Iltimos, qayta urinib ko'ring.",
  noPatch: "⚠️ O'zgartirish uchun maydon ko'rsatilmagan.",
  inProgress: "⏳ Bu xabar hali yuborilmoqda — bir necha soniyada chatda paydo bo'ladi.",
  uploadClientBlocked: '⚠️ Mijoz botni bloklagan — fayl yuborilmadi va saqlanmadi.',
  uploadStaffUnreachable: "⚠️ Xodimga hozir fayl yetkazib bo'lmaydi. Savolingizni matn bilan yozing yoki boshqa xodimni tanlang.",
  uploadFailedClient:
    "⚠️ Faylni xodimga yuborib bo'lmadi, u saqlanmadi. Birozdan keyin qayta urinib ko'ring yoki savolingizni matn bilan yozing.",
  uploadFailedStaff: "⚠️ Faylni mijozga yuborib bo'lmadi, u saqlanmadi. Birozdan keyin qayta urinib ko'ring.",
} as const;

/** Relay xato kodlari -> HTTP holat. Noma'lum (yangi qo'shilgan) kod -> 500. */
const RELAY_STATUS: Readonly<Record<string, number>> = {
  staff_unavailable: 404,
  staff_inactive: 403,
  staff_unreachable: 409,
  client_blocked: 409,
  client_not_found: 404,
  forbidden: 403,
  file_too_big: 413,
  send_failed: 502,
  empty: 400,
};

function bad(code: string, message: string): ApiError {
  return new ApiError(400, code, message);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isBlob(v: unknown): v is File {
  return typeof v === 'object' && v !== null && typeof (v as Blob).arrayBuffer === 'function' && typeof (v as Blob).size === 'number';
}

// ───────────────────────────── Parametrlarni tekshirish ─────────────────────────────

function asId(v: unknown): number | null {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v > 0 ? v : null;
  if (typeof v === 'string' && /^\s*\d{1,15}\s*$/.test(v)) {
    const n = Number(v.trim());
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  return null;
}

function reqId(v: unknown): number {
  const n = asId(v);
  if (n == null) throw bad('invalid_id', MSG.invalidId);
  return n;
}

/** Ixtiyoriy id: berilmagan / null / "" / 0 -> undefined. */
function optId(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '' || v === 0 || v === '0') return undefined;
  return reqId(v);
}

/** Ixtiyoriy manfiy bo'lmagan butun son. */
function optNonNegInt(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'string' && /^\s*\d{1,15}\s*$/.test(v) ? Number(v.trim()) : v;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw bad('invalid_id', MSG.invalidId);
  return n;
}

function asBool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === '1' || v === 'true') return true;
  if (v === 0 || v === '0' || v === 'false') return false;
  return null;
}

function pageLimit(v: unknown): number {
  if (v === undefined || v === null || v === '') return PAGE_DEFAULT;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return PAGE_DEFAULT;
  return Math.min(Math.max(Math.trunc(n), 1), PAGE_MAX);
}

// ───────────────────────────── Chastota cheklovi (rate limit) ─────────────────────────────

type RateBucket = 'send' | 'upload' | 'resend' | 'route';

/**
 * Telegram limitlari (xodimlar boti hamma uchun bitta) va bazani himoya qilish uchun cheklovlar.
 * Oddiy yozishmada sezilmaydi; skript yoki xato tufayli to'xtovsiz so'rovlarni to'xtatadi.
 * Holat Postgres da (rate_limits): serverless nusxalar xotirani bo'lishmaydi.
 *  - send   — matn yuborish va yetkazilmagan xabarni qayta yuborish (retry);
 *  - upload — fayl yuklash (har biri Telegramga bir necha MB);
 *  - resend — "📥 Botda ochish" (20 MB gacha faylni botlar orasida ko'chirish);
 *  - route  — bot chatiga "🔁 Endi xabarlaringiz ..." xabarnomasi (yumshoq: oshsa, faqat xabarnoma o'tkazib yuboriladi).
 */
const RATE_RULES: Record<'client' | 'staff', Record<RateBucket, readonly RateRule[]>> = {
  client: {
    send: [
      { windowSec: 60, max: 20 },
      { windowSec: 3600, max: 300 },
    ],
    upload: [
      { windowSec: 60, max: 10 },
      { windowSec: 3600, max: 100 },
    ],
    resend: [
      { windowSec: 60, max: 10 },
      { windowSec: 3600, max: 60 },
    ],
    route: [
      { windowSec: 60, max: 10 },
      { windowSec: 3600, max: 100 },
    ],
  },
  staff: {
    send: [
      { windowSec: 60, max: 60 },
      { windowSec: 3600, max: 1500 },
    ],
    upload: [
      { windowSec: 60, max: 20 },
      { windowSec: 3600, max: 300 },
    ],
    resend: [
      { windowSec: 60, max: 15 },
      { windowSec: 3600, max: 150 },
    ],
    route: [
      { windowSec: 60, max: 10 },
      { windowSec: 3600, max: 100 },
    ],
  },
};

function waitText(sec: number): string {
  return sec <= 90 ? `${sec} soniyadan` : `${Math.ceil(sec / 60)} daqiqadan`;
}

/** Cheklov kaliti: rol + shaxs (mijoz Telegram ID si / xodim profili / profilsiz admin Telegram ID si). */
function rateKey(ctx: Ctx, bucket: RateBucket): string {
  const actor = ctx.role === 'client' ? `c:${ctx.client.tg_user_id}` : ctx.me ? `s:${ctx.me.id}` : `u:${ctx.user.id}`;
  return `${actor}:${bucket}`;
}

/**
 * Qat'iy cheklov: limitdan oshsa 429 (rate_limited) — so'rov bajarilmaydi, hech narsa saqlanmaydi va
 * Telegramga murojaat qilinmaydi. Javobda `retry_after` (soniya) va Retry-After sarlavhasi bor.
 */
async function enforceRate(ctx: Ctx, bucket: Exclude<RateBucket, 'route'>): Promise<void> {
  const verdict = await hitRateLimit(rateKey(ctx, bucket), RATE_RULES[ctx.role][bucket]);
  if (verdict.allowed) return;
  const sec = verdict.retryAfterSec;
  const message =
    bucket === 'resend'
      ? `⏳ Juda ko'p so'rov. Iltimos, ${waitText(sec)} keyin qayta urinib ko'ring.`
      : `⏳ Juda tez yuboryapsiz. Iltimos, ${waitText(sec)} keyin qayta urinib ko'ring.`;
  throw new ApiError(429, 'rate_limited', message, {
    data: { retry_after: sec },
    headers: { 'retry-after': String(sec) },
  });
}

/** Yumshoq cheklov: limitdan oshsa false — asosiy amal bajariladi, faqat ixtiyoriy qo'shimcha (xabarnoma) o'tkaziladi. */
async function withinRate(ctx: Ctx, bucket: RateBucket): Promise<boolean> {
  const verdict = await hitRateLimit(rateKey(ctx, bucket), RATE_RULES[ctx.role][bucket]);
  if (!verdict.allowed) console.warn(`[app] ${rateKey(ctx, bucket)}: chastota limiti — qo'shimcha xabarnoma o'tkazib yuborildi`);
  return verdict.allowed;
}

// ───────────────────────────── Idempotentlik ─────────────────────────────

/** Mini App har bir yuborish uchun bir marta yaratadigan kalit (UUID); qayta urinishda o'zgarmaydi. */
const NONCE_RE = /^[A-Za-z0-9_-]{8,64}$/;

function readNonce(params: Params): string | null {
  const raw = params.clientNonce ?? params.client_nonce ?? params.nonce;
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !NONCE_RE.test(raw)) throw bad('bad_nonce', MSG.badRequest);
  return raw;
}

// ───────────────────────────── So'rovni o'qish ─────────────────────────────

interface ParsedRequest {
  initData: string;
  action: string;
  params: Params;
  file: File | null;
}

function headerInitData(req: Request): string {
  const direct = req.headers.get('x-telegram-init-data');
  if (direct) return direct;
  const auth = req.headers.get('authorization') ?? '';
  return /^tma\s+/i.test(auth) ? auth.replace(/^tma\s+/i, '') : '';
}

async function parseRequest(req: Request): Promise<ParsedRequest> {
  const contentType = (req.headers.get('content-type') ?? '').toLowerCase();
  const declared = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new ApiError(413, 'file_too_big', MSG.fileTooBig);
  }

  let params: Params = {};
  let file: File | null = null;

  if (contentType.startsWith('multipart/form-data')) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw bad('bad_request', MSG.badRequest);
    }
    form.forEach((value, key) => {
      if (typeof value === 'string') {
        if (!(key in params)) params[key] = value;
      } else if (key === 'file' && !file && isBlob(value)) {
        file = value;
      }
    });
  } else {
    const text = await req.text();
    if (text.length > MAX_JSON_CHARS) throw new ApiError(413, 'too_large', MSG.badRequest);
    if (text.trim()) {
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw bad('bad_request', MSG.badRequest);
      }
      if (!isObject(body)) throw bad('bad_request', MSG.badRequest);
      params = { ...body };
    }
  }

  const initData = (typeof params.initData === 'string' ? params.initData : '') || headerInitData(req);
  const action = typeof params.action === 'string' ? params.action.trim() : '';
  delete params.initData;
  delete params.action;
  return { initData, action, params, file };
}

// ───────────────────────────── Kontekst ─────────────────────────────

interface ClientCtx {
  role: 'client';
  user: WebAppUser;
  client: Client;
  params: Params;
  file: File | null;
}

interface StaffCtx {
  role: 'staff';
  user: WebAppUser;
  me: Staff | null;
  admin: boolean;
  params: Params;
  file: File | null;
}

type Ctx = ClientCtx | StaffCtx;

/**
 * initData ni tekshirish. Mijozlar boti orqali ochilgan Mini App — 403 client_app_disabled: mijozlar uchun
 * ilova o'chirilgan (ular bot chatida yozadi). Bazaga hech narsa yozilmaydi va murojaat ham qilinmaydi.
 */
function authenticate(parsed: ParsedRequest): WebAppAuth {
  if (!parsed.initData) throw new ApiError(401, 'unauthorized', MSG.unauthorized);
  const auth = verifyInitData(parsed.initData);
  if (!auth) throw new ApiError(401, 'unauthorized', MSG.unauthorized);
  if (auth.bot !== 'staff') throw new ApiError(403, 'client_app_disabled', MSG.clientAppDisabled);
  return auth;
}

/** Xodim/admin konteksti (faqat xodimlar boti initData si bilan — authenticate() dan keyin). */
async function buildContext(auth: WebAppAuth, parsed: ParsedRequest): Promise<Ctx> {
  const { user } = auth;
  const me = await getStaffByTgId(user.id);
  const admin = isAdmin(user.id);
  if (!me && !admin) throw new ApiError(403, 'not_staff', MSG.notStaff);
  return { role: 'staff', user, me, admin, params: parsed.params, file: parsed.file };
}

function requireClient(ctx: Ctx): ClientCtx {
  if (ctx.role !== 'client') throw new ApiError(403, 'client_only', MSG.clientOnly);
  return ctx;
}

function requireStaffMe(ctx: Ctx): StaffCtx & { me: Staff } {
  if (ctx.role !== 'staff' || !ctx.me) throw new ApiError(403, 'staff_only', MSG.staffOnly);
  return ctx as StaffCtx & { me: Staff };
}

function requireAdmin(ctx: Ctx): StaffCtx {
  if (ctx.role !== 'staff' || !ctx.admin) throw new ApiError(403, 'admin_only', MSG.adminOnly);
  return ctx;
}

/** Suhbatni yuklash va egalikni tekshirish (maxfiylik: faqat o'z suhbatlari). */
async function ownConversation(ctx: Ctx, id: number): Promise<Conversation> {
  const conv = await getConversation(id);
  if (!conv) throw new ApiError(404, 'not_found', MSG.convNotFound);
  const owns =
    ctx.role === 'client' ? conv.client_id === ctx.client.tg_user_id : !!ctx.me && conv.staff_id === ctx.me.id;
  if (!owns) throw new ApiError(403, 'forbidden', relayErrorText('forbidden'));
  return conv;
}

function activeId(ctx: Ctx): number | null {
  return ctx.role === 'client' ? ctx.client.active_conversation_id : ctx.me?.active_conversation_id ?? null;
}

async function markRead(ctx: Ctx, conversationId: number): Promise<void> {
  if (ctx.role === 'client') await markReadByClient(conversationId);
  else await markReadByStaff(conversationId);
}

function unreadFor(ctx: Ctx, conv: Conversation): number {
  return ctx.role === 'client' ? conv.unread_client : conv.unread_staff;
}

function toDTOs(ctx: Ctx, messages: Message[]): MessageDTO[] {
  return messages.map((m) => messageDTO(m, ctx.role));
}

/** Suhbatlar ro'yxati (mijoz: xabari bor yoki aktiv suhbatlar; xodim: faqat o'zinikilar, 100 tagacha). */
async function listConversations(ctx: Ctx): Promise<ConvSummaryDTO[]> {
  if (ctx.role === 'client') {
    const active = ctx.client.active_conversation_id;
    const rows = await listClientConvRows(ctx.client.tg_user_id);
    return rows.filter((r) => r.last_message_at || r.id === active).map((r) => clientConvSummary(r, active));
  }
  if (!ctx.me) return [];
  const rows = await listStaffConversations(ctx.me.id, { limit: STAFF_LIST_LIMIT });
  return rows.map((r) => staffConvSummary(r, ctx.me!.active_conversation_id));
}

/** Oxirgi (yoki beforeId dan oldingi) xabarlar sahifasi. */
async function loadPage(
  conversationId: number,
  beforeId: number | undefined,
  limit: number,
): Promise<{ messages: Message[]; has_more: boolean }> {
  const rows = await listMessages(conversationId, { beforeId, limit: limit + 1 });
  const hasMore = rows.length > limit;
  return { messages: hasMore ? rows.slice(rows.length - limit) : rows, has_more: hasMore };
}

// ───────────────────────────── Mijoz amallari ─────────────────────────────

const ROLE_ORDER = { operator: 0, manager: 1 } as const;

async function clientBootstrap(ctx: ClientCtx): Promise<Data> {
  const { client } = ctx;
  const [staffList, rows] = await Promise.all([listAvailableStaff(), listClientConvRows(client.tg_user_id)]);
  const byStaff = new Map(rows.map((r) => [r.staff_id, r]));
  const staff = [...staffList]
    .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.sort_order - b.sort_order || a.id - b.id)
    .map((s) => {
      const row = byStaff.get(s.id);
      return staffCardDTO(s, row ? { id: row.id, unread: row.unread_client ?? 0 } : null);
    });
  const active = client.active_conversation_id;
  const conversations = rows
    .filter((r) => r.last_message_at || r.id === active)
    .map((r) => clientConvSummary(r, active));
  return {
    role: 'client',
    me: {
      id: client.tg_user_id,
      first_name: client.first_name,
      last_name: client.last_name,
      username: client.username,
      name: clientName(client),
    },
    staff,
    conversations,
    list_sig: listSignature(conversations),
    active_conversation_id: active,
  };
}

/**
 * Mijoz bot chatida yozadigan xabarlar endi boshqa xodimga borishini bot chatining o'zida bildirish
 * (Mini App dan almashtirilganda mijoz buni bot chatida ko'rishi shart). Ovozsiz; xatolar e'tiborsiz.
 */
async function notifyClientRoute(client: Client, staff: Staff | null): Promise<void> {
  if (client.bot_blocked) return;
  const raw = oneLine(staff?.full_name, 64) || 'Xodim';
  try {
    await clientApi().sendMessage(client.tg_user_id, `🔁 Endi xabarlaringiz <b>${esc(raw)}</b>${dativeSuffix(raw)} yuboriladi.`, {
      parse_mode: 'HTML',
      disable_notification: true,
    });
  } catch (e) {
    if (tgErrorCode(e) === 403) await setClientBlocked(client.tg_user_id, true).catch(() => {});
    else console.warn("[app] yo'nalish haqidagi xabar yuborilmadi:", redact(tgErrorDescription(e)));
  }
}

/**
 * Mijoz Mini App orqali shu suhbatga yozdi — bot chatidagi xabarlari ham endi shu suhbatga boradi
 * (bot chatida Reply orqali boshqa suhbatga yozilganda ham xuddi shunday). Almashsa — bot chatida ogohlantirish.
 * Xabar allaqachon yuborilgan: bu yerdagi xatolar yuborishni "muvaffaqiyatsiz" qilmasligi kerak.
 */
async function followConversation(ctx: ClientCtx, conversation: Conversation): Promise<void> {
  const previous = ctx.client.active_conversation_id;
  if (previous === conversation.id) return;
  try {
    await setClientActiveConversation(ctx.client.tg_user_id, conversation.id);
    ctx.client = { ...ctx.client, active_conversation_id: conversation.id };
    if (previous != null && (await withinRate(ctx, 'route'))) {
      await notifyClientRoute(ctx.client, await getStaff(conversation.staff_id));
    }
  } catch (e) {
    console.error('[app] aktiv suhbatni almashtirib bo\'lmadi:', e instanceof Error ? e.message : e);
  }
}

/**
 * Suhbatni ochish.
 * Mijoz: { staffId, activate? } — xodim mavjud bo'lishi shart; suhbat yaratiladi (bo'lmasa).
 *        { conversationId, activate? } — mavjud suhbat.
 *   Aktiv suhbat (bot chatidagi xabarlar qayerga borishi) faqat quyidagi hollarda shu suhbatga o'zgaradi:
 *   aktiv suhbat yo'q yoki uning xodimi endi mavjud emas; suhbat yangi/bo'sh ("✍️ Yozish"); `activate: true`
 *   (mijoz kartadagi "✍️ Yozish" ni bosdi). Eski suhbatni shunchaki ko'rish yo'naltirishni o'zgartirmaydi —
 *   aks holda bot chatidagi xabarlar jimgina boshqa xodimga ketardi. Aks holda almashtirish shu suhbatga birinchi
 *   yozilganda bo'ladi (`send`/`upload`). Almashganda bot chatiga "🔁 Endi xabarlaringiz ..." yuboriladi.
 * Xodim: { conversationId } — faqat o'qish (aktiv suhbat o'zgartirilmaydi, bot chatidagi yo'naltirish buzilmasin).
 */
async function conversationOpen(ctx: Ctx): Promise<Data> {
  const limit = PAGE_DEFAULT;

  if (ctx.role === 'staff') {
    const { me } = requireStaffMe(ctx);
    const conv = await ownConversation(ctx, reqId(ctx.params.conversationId));
    const [view, page] = await Promise.all([getConversationView(conv.id), loadPage(conv.id, undefined, limit)]);
    if (!view) throw new ApiError(404, 'not_found', MSG.convNotFound);
    if (view.unread_staff > 0) await markReadByStaff(conv.id);
    const conversation = staffConvSummary({ ...view, unread_staff: 0 }, me.active_conversation_id);
    return { conversation, messages: toDTOs(ctx, page.messages), has_more: page.has_more, server_time: new Date().toISOString() };
  }

  const { client } = ctx;
  let conv: Conversation;
  let staff: Staff | null;
  const staffId = asId(ctx.params.staffId);
  if (staffId != null) {
    staff = await getStaff(staffId);
    if (!isStaffAvailable(staff)) {
      throw new ApiError(404, 'staff_unavailable', relayErrorText('staff_unavailable'));
    }
    conv = await getOrCreateConversation(client.tg_user_id, staff.id);
  } else if (ctx.params.conversationId !== undefined) {
    conv = await ownConversation(ctx, reqId(ctx.params.conversationId));
    staff = await getStaff(conv.staff_id);
    if (!staff) throw new ApiError(404, 'not_found', MSG.convNotFound);
  } else {
    throw bad('invalid_id', MSG.invalidId);
  }

  let active = client.active_conversation_id;
  const tasks: Promise<unknown>[] = [];
  if (isStaffAvailable(staff) && active !== conv.id) {
    // Hozir bot chatidagi xabarlar kimga boradi (null — hech kimga: aktiv yo'q yoki xodim mavjud emas)
    const routeStaff = active != null ? await activeRouteStaff(client.tg_user_id, active) : null;
    const explicit = asBool(ctx.params.activate) === true;
    if (!routeStaff || explicit || !conv.last_message_at) {
      await setClientActiveConversation(client.tg_user_id, conv.id);
      ctx.client = { ...client, active_conversation_id: conv.id };
      active = conv.id;
      // Xabarnoma bot chatiga ketadi (mijozlar boti limiti) — tez-tez almashtirishda o'tkazib yuboriladi
      if (routeStaff && (await withinRate(ctx, 'route'))) await notifyClientRoute(ctx.client, staff);
      // Xodim tanlanmaguncha bot chatida yozib qo'yilgan xabarlar — endi tanlangan xodimga (bot chatida
      // "📨 … yuborildi" izohi bilan). Saqlangan xabar bo'lmasa — bitta arzon so'rov.
      try {
        const sent = await deliverHeldToConversation(ctx.client, conv);
        if (sent > 0) conv = (await getConversation(conv.id)) ?? conv;
      } catch (e) {
        console.error("[app] saqlangan xabarlarni yuborib bo'lmadi:", e instanceof Error ? redact(e.message) : e);
      }
    }
  }
  if (conv.unread_client > 0) tasks.push(markReadByClient(conv.id));
  const [page] = await Promise.all([loadPage(conv.id, undefined, limit), ...tasks]);

  const conversation = clientConvSummary(clientRowFrom({ ...conv, unread_client: 0 }, staff), active);
  return {
    conversation,
    messages: toDTOs(ctx, page.messages),
    has_more: page.has_more,
    active_conversation_id: active,
    server_time: new Date().toISOString(),
  };
}

// ───────────────────────────── Xodim amallari ─────────────────────────────

async function staffBootstrap(ctx: StaffCtx): Promise<Data> {
  const { me, admin, user } = ctx;
  const base = {
    role: 'staff',
    is_admin: admin,
    user: { id: user.id, first_name: user.first_name ?? '', username: user.username ?? null },
    // Mijozlar boti username i: shaxsiy havolalar prefiksi (t.me/<client_bot>?start=...), '' — aniqlanmagan
    client_bot: await safeClientBotUsername(),
  };
  if (!me) return { ...base, me: null, conversations: [], total: 0, has_more: false, active_conversation_id: null };

  const username = user.username ?? null;
  const [rows, total, totalUnread] = await Promise.all([
    listStaffConversations(me.id, { limit: STAFF_LIST_LIMIT }),
    countStaffConversations(me.id),
    sumStaffUnread(me.id),
    username !== me.tg_username
      ? updateStaffUsername(me.id, username).catch((e) => console.error('updateStaffUsername:', e))
      : Promise.resolve(),
  ]);
  const conversations = rows.map((r) => staffConvSummary(r, me.active_conversation_id));
  return {
    ...base,
    me: await staffProfileDTO({ ...me, tg_username: username }, totalUnread),
    conversations,
    list_sig: listSignature(conversations),
    total,
    // Ro'yxat oxirgi STAFF_LIST_LIMIT ta suhbat bilan cheklangan; qolganlari 'conversations' amali orqali
    // (offset: next_offset) yoki server qidiruvi bilan yuklanadi
    has_more: total > conversations.length,
    next_offset: conversations.length,
    active_conversation_id: me.active_conversation_id,
  };
}

async function statusSet(ctx: Ctx): Promise<Data> {
  const { me } = requireStaffMe(ctx);
  const online = asBool(ctx.params.online);
  if (online === null) throw bad('bad_status', MSG.badStatus);
  const updated = online === me.is_online ? me : await updateStaff(me.id, { is_online: online });
  if (!updated) throw new ApiError(404, 'staff_not_found', MSG.staffNotFound);
  return { me: await staffProfileDTO(updated, await sumStaffUnread(updated.id)) };
}

const CONV_PAGE = 50;
const CONV_OFFSET_MAX = 100_000;
const CONV_SEARCH_MAX = 64;

/**
 * Xodim suhbatlari sahifalab va server tomonida qidiruv bilan: { offset?, search? } -> { conversations, has_more }.
 * bootstrap/sync faqat oxirgi 100 ta suhbatni qaytaradi; eski mijozlar shu amal orqali topiladi.
 * Faqat o'z suhbatlari (maxfiylik).
 */
async function staffConversationsAction(ctx: Ctx): Promise<Data> {
  const { me } = requireStaffMe(ctx);
  const offset = Math.min(optNonNegInt(ctx.params.offset) ?? 0, CONV_OFFSET_MAX);
  const raw = ctx.params.search ?? ctx.params.q;
  if (raw !== undefined && raw !== null && typeof raw !== 'string') throw bad('bad_request', MSG.badRequest);
  const search = Array.from((raw ?? '').replace(/\s+/g, ' ').trim())
    .slice(0, CONV_SEARCH_MAX)
    .join('');
  const rows = await searchStaffConvRows(me.id, { limit: CONV_PAGE + 1, offset, search });
  const page = rows.slice(0, CONV_PAGE);
  return {
    conversations: page.map((r) => staffConvSummary(r, me.active_conversation_id)),
    has_more: rows.length > CONV_PAGE,
    offset,
    next_offset: offset + page.length,
    search,
  };
}

// ───────────────────────────── Umumiy amallar ─────────────────────────────

async function messagesAction(ctx: Ctx): Promise<Data> {
  const conv = await ownConversation(ctx, reqId(ctx.params.conversationId));
  const beforeId = optId(ctx.params.beforeId);
  const limit = pageLimit(ctx.params.limit);
  const [page] = await Promise.all([
    loadPage(conv.id, beforeId, limit),
    beforeId === undefined && unreadFor(ctx, conv) > 0 ? markRead(ctx, conv.id) : Promise.resolve(),
  ]);
  return { messages: toDTOs(ctx, page.messages), has_more: page.has_more, server_time: new Date().toISOString() };
}

/** Tahrirlarni qidirishda soatlar farqi va kechikkan tranzaksiyalar uchun ustma-ust oyna (takrorlar zararsiz). */
const EDIT_OVERLAP_MS = 10_000;
/** Juda eski `editedSince` so'rovni og'irlashtirmasin. */
const EDIT_LOOKBACK_MAX_MS = 24 * 60 * 60 * 1000;
/** Bir sync da yetkazilganligi tekshiriladigan xabarlar soni. */
const UNDELIVERED_CHECK_MAX = 50;

/** `editedSince` (ISO): shundan keyin tahrirlangan xabarlar qaytariladi. Noto'g'ri qiymat — e'tiborsiz. */
function editedSinceParam(v: unknown): Date | null {
  if (typeof v !== 'string' || v.length > 40) return null;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return null;
  const floor = Date.now() - EDIT_LOOKBACK_MAX_MS;
  return new Date(Math.max(t - EDIT_OVERLAP_MS, floor));
}

/** Yetkazilganligi tekshiriladigan xabar id lari (mijozning ❗ belgili xabarlari). */
function idListParam(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  for (const x of v.slice(0, UNDELIVERED_CHECK_MAX)) {
    const n = asId(x);
    if (n != null) out.push(n);
  }
  return out;
}

/** Mini App yuborgan ro'yxat imzosi (`listSig`): list_sig bilan bir xil format. Noto'g'ri qiymat — e'tiborsiz. */
const LIST_SIG_RE = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Suhbatlar ro'yxatining imzosi: javobdagi DTO larning to'liq JSON ko'rinishidan (ko'rinish, o'qilmaganlar, aktivlik,
 * suhbatdosh ismi/holati/rasmi — hammasi hisobga olinadi). DTO lar bir xil funksiyalar bilan bir xil tartibda
 * yasaladi, shuning uchun o'zgarmagan ro'yxat har doim bir xil imzo beradi.
 */
function listSignature(conversations: readonly ConvSummaryDTO[]): string {
  return createHash('sha1').update(JSON.stringify(conversations)).digest('base64url');
}

/**
 * sync: ro'yxat + ochiq chatning yangi xabarlari (Mini App ~3 soniyada chaqiradi — arzon bo'lishi kerak).
 * Ro'yxat bo'yicha (ixtiyoriy, eski frontendlar uchun ham mos):
 *  - `listSig` — oldingi javobdagi `list_sig`: ro'yxat o'zgarmagan bo'lsa `conversations: null` qaytadi
 *    (40 KB gacha JSON qayta yuborilmaydi). `list_sig` har doim qaytariladi (ro'yxat so'ralgan bo'lsa).
 *  - `list: false` — ro'yxat umuman so'ralmaydi (bazaga so'rov ham yo'q): `conversations: null`, `list_sig` yo'q.
 *    Ochiq chatda ro'yxatni har N-chi so'rovda olish uchun.
 * Ochiq chat uchun qo'shimcha:
 *  - `editedSince` berilsa — shundan keyin tahrirlangan xabarlar (`updated`), pufaklar joyida yangilanadi;
 *  - `undelivered: [id...]` berilsa — ulardan endi yetkazilganlari (`updated`, delivered: true).
 * `server_time` — keyingi so'rovdagi `editedSince` uchun.
 */
async function syncAction(ctx: Ctx): Promise<Data> {
  const conversationId = optId(ctx.params.conversationId);
  const afterId = optNonNegInt(ctx.params.afterId);
  const wantList = asBool(ctx.params.list) !== false;
  const knownSig = typeof ctx.params.listSig === 'string' && LIST_SIG_RE.test(ctx.params.listSig) ? ctx.params.listSig : null;
  const serverTime = new Date().toISOString();
  const [conversations, conv] = await Promise.all([
    wantList ? listConversations(ctx) : Promise.resolve(null),
    conversationId !== undefined ? ownConversation(ctx, conversationId) : Promise.resolve(null),
  ]);

  let messages: MessageDTO[] = [];
  let updated: MessageDTO[] = [];
  if (conv) {
    const since = editedSinceParam(ctx.params.editedSince);
    const checkIds = idListParam(ctx.params.undelivered);
    // afterId berilmasa — oxirgi sahifa; aks holda faqat yangi xabarlar
    const [rows, edited, nowDelivered] = await Promise.all([
      afterId === undefined
        ? loadPage(conv.id, undefined, PAGE_DEFAULT).then((p) => p.messages)
        : listMessages(conv.id, { afterId, limit: SYNC_MAX }),
      since ? listEditedMessages(conv.id, since) : Promise.resolve([] as Message[]),
      deliveredAmong(conv.id, checkIds),
    ]);
    // Faqat suhbatdoshdan yangi xabar kelgan yoki o'qilmagan bo'lsa yozamiz (so'rov har ~3 soniyada keladi)
    const peer = ctx.role === 'client' ? 'staff' : 'client';
    if (unreadFor(ctx, conv) > 0 || rows.some((m) => m.sender === peer)) {
      await markRead(ctx, conv.id);
      // Imzo shu o'zgarishdan KEYIN hisoblanadi — Mini App dagi ro'yxat bilan mos bo'lsin
      if (conversations) for (const c of conversations) if (c.id === conv.id) c.unread = 0;
    }
    messages = toDTOs(ctx, rows);
    const fresh = new Set(rows.map((m) => m.id));
    const byId = new Map<number, Message>();
    for (const m of [...edited, ...nowDelivered]) if (!fresh.has(m.id)) byId.set(m.id, m);
    updated = toDTOs(ctx, [...byId.values()]);
  }

  let list: { conversations: ConvSummaryDTO[] | null; list_sig?: string } = { conversations: null };
  if (conversations) {
    const sig = listSignature(conversations);
    list = { conversations: sig === knownSig ? null : conversations, list_sig: sig };
  }
  return { ...list, messages, updated, active_conversation_id: activeId(ctx), server_time: serverTime };
}

/**
 * Saqlangan, lekin yetkazilmagan O'Z xabarini qayta yuborish (Mini App dagi ❗ belgisi): { messageId }.
 * Yangi yozuv yaratilmaydi (tarixda takror bo'lmaydi), parallel bosishlar bitta yuborishga aylanadi (relay da'vosi).
 */
async function retryAction(ctx: Ctx): Promise<Data> {
  const id = reqId(ctx.params.messageId);
  const msg = await getMessage(id);
  if (!msg) throw new ApiError(404, 'message_not_found', MSG.msgNotFound);
  await ownConversation(ctx, msg.conversation_id);
  if (msg.sender !== ctx.role) throw new ApiError(403, 'forbidden', relayErrorText('forbidden'));
  await enforceRate(ctx, 'send');
  const result =
    ctx.role === 'client'
      ? await retryDelivery({ role: 'client', client: ctx.client }, id)
      : await retryDelivery({ role: 'staff', staff: requireStaffMe(ctx).me }, id);
  if (!result.ok && (result.error === 'staff_inactive' || result.error === 'staff_unavailable' || result.error === 'forbidden')) {
    if (result.error === 'staff_unavailable' && ctx.role === 'client' && ctx.client.active_conversation_id === msg.conversation_id) {
      await setClientActiveConversation(ctx.client.tg_user_id, null).catch((e) => console.error('setClientActiveConversation:', e));
      ctx.client = { ...ctx.client, active_conversation_id: null };
    }
    throw new ApiError(RELAY_STATUS[result.error] ?? 500, result.error, relayErrorText(result.error));
  }
  return relayResponse(ctx, result);
}

/**
 * Fayl yuklash xatosi matni. Yuklash yo'lida relay avval yetkazadi, keyin saqlaydi — xato bo'lsa hech narsa
 * saqlanmagan, shuning uchun "(lekin saqlandi)" deyish noto'g'ri bo'lardi.
 */
function uploadErrorText(role: Sender, error: string): string {
  switch (error) {
    case 'client_blocked':
      return MSG.uploadClientBlocked;
    case 'staff_unreachable':
      return MSG.uploadStaffUnreachable;
    case 'send_failed':
      return role === 'client' ? MSG.uploadFailedClient : MSG.uploadFailedStaff;
    default:
      return relayErrorText(error as RelayError);
  }
}

/**
 * Xabar saqlandi, lekin (hozircha) yetkazilmadi — foydalanuvchiga aniq izoh. Vaqtinchalik xatoda ('transient')
 * xabar bir necha daqiqada o'zi yetkaziladi — ogohlantirish shart emas (pufakda holat belgisi bor).
 */
function undeliveredWarning(reason: string | undefined): string | null {
  switch (reason) {
    case 'staff_unreachable':
      return "ℹ️ Xabaringiz saqlandi, lekin xodimga hozircha yetkazib bo'lmadi — u qaytishi bilan yetkaziladi. Shoshilinch bo'lsa, boshqa xodimni tanlang.";
    case 'no_staff_bot':
      return "ℹ️ Xabaringiz saqlandi, lekin hozircha xodimga yetkazib bo'lmaydi. Birozdan keyin qayta urinib ko'ring.";
    default:
      return null;
  }
}

/** Relay natijasini javobga aylantirish. */
function relayResponse(ctx: Ctx, result: RelayResult, upload = false): Data {
  const route = ctx.role === 'client' ? { active_conversation_id: ctx.client.active_conversation_id } : {};
  if (result.ok) {
    const warning = result.delivered ? null : undeliveredWarning(result.undeliveredReason);
    return {
      message: messageDTO(result.message, ctx.role),
      ...(result.autoReply ? { auto_reply: messageDTO(result.autoReply, ctx.role) } : {}),
      delivered: result.delivered,
      ...(result.undeliveredReason ? { undelivered_reason: result.undeliveredReason } : {}),
      ...(warning ? { warning } : {}),
      ...route,
    };
  }
  if (result.message) {
    // Xabar saqlandi, lekin yetkazilmadi (masalan, mijoz botni bloklagan)
    return {
      message: messageDTO(result.message, ctx.role),
      delivered: false,
      warning: relayErrorText(result.error, { saved: true }),
      ...route,
    };
  }
  const code: string = result.error;
  const text = upload ? uploadErrorText(ctx.role, code) : relayErrorText(result.error);
  throw new ApiError(RELAY_STATUS[code] ?? 500, code, text);
}

/** Takroriy so'rov (xuddi shu clientNonce): xabar qayta yuborilmaydi, saqlangan xabar qaytariladi. */
async function duplicateResponse(ctx: Ctx, conv: Conversation, messageId: number): Promise<Data | null> {
  const msg = await getMessage(messageId);
  if (!msg || msg.conversation_id !== conv.id || msg.sender !== ctx.role) return null;
  const delivered = ctx.role === 'client' ? msg.staff_chat_msg_id != null : msg.client_chat_msg_id != null;
  return {
    message: messageDTO(msg, ctx.role),
    delivered,
    duplicate: true,
    ...(ctx.role === 'client' ? { active_conversation_id: ctx.client.active_conversation_id } : {}),
  };
}

/**
 * Xabarni yuborish (send/upload uchun umumiy): idempotentlik -> chastota cheklovi -> relay.
 * `clientNonce` berilsa: javob yo'qolib, Mini App qayta yuborsa — xabar ikkinchi marta yetkazilmaydi,
 * birinchi saqlangan xabar qaytariladi; birinchi so'rov hali bajarilayotgan bo'lsa — 409 in_progress.
 */
async function deliver(
  ctx: Ctx,
  conv: Conversation,
  bucket: 'send' | 'upload',
  run: () => Promise<RelayResult>,
): Promise<Data> {
  const nonce = readNonce(ctx.params);
  const sender: Sender = ctx.role;
  let claimed = false;
  if (nonce) {
    const claim = await claimSend(conv.id, sender, nonce);
    if (claim.state === 'pending') throw new ApiError(409, 'in_progress', MSG.inProgress);
    if (claim.state === 'done') {
      const dup = await duplicateResponse(ctx, conv, claim.messageId);
      if (dup) return dup;
      console.warn(`[app] nonce #${claim.messageId} xabariga mos kelmadi — oddiy yuborish`);
    }
    claimed = claim.state === 'claimed';
  }
  let saved = false;
  try {
    await enforceRate(ctx, bucket);
    const result = await run();
    if (result.message) {
      saved = true;
      if (claimed) await completeSend(conv.id, sender, nonce!, result.message.id);
    }
    return relayResponse(ctx, result, bucket === 'upload');
  } finally {
    // Hech narsa saqlanmadi (xato, limit, yetkazilmagan fayl) — haqiqiy qayta urinish o'tishi uchun da'voni bo'shatamiz
    if (claimed && !saved) await releaseSend(conv.id, sender, nonce!);
  }
}

async function relay(ctx: Ctx, conversation: Conversation, content: Content): Promise<RelayResult> {
  if (ctx.role === 'client') {
    const result = await relayClientMessage({ client: ctx.client, conversation, content, via: 'webapp' });
    if (!result.ok && result.error === 'staff_unavailable' && ctx.client.active_conversation_id === conversation.id) {
      await setClientActiveConversation(ctx.client.tg_user_id, null).catch((e) =>
        console.error('setClientActiveConversation:', e),
      );
      ctx.client = { ...ctx.client, active_conversation_id: null };
    }
    if (result.message) await followConversation(ctx, conversation);
    return result;
  }
  const { me } = requireStaffMe(ctx);
  return relayStaffMessage({ staff: me, conversation, content, via: 'webapp' });
}

async function sendAction(ctx: Ctx): Promise<Data> {
  if (ctx.role === 'staff') requireStaffMe(ctx);
  const conv = await ownConversation(ctx, reqId(ctx.params.conversationId));
  const raw = ctx.params.text;
  if (typeof raw !== 'string') throw bad('empty', MSG.textRequired);
  const text = raw.replace(/\r\n?/g, '\n').trim();
  if (!text) throw bad('empty', MSG.textRequired);
  if (text.length > TEXT_MAX) throw bad('text_too_long', MSG.textTooLong);
  return deliver(ctx, conv, 'send', () => relay(ctx, conv, { kind: 'text', text }));
}

async function readUpload(file: File | null): Promise<Uint8Array> {
  if (!file) throw bad('no_file', MSG.noFile);
  if (file.size > MAX_UPLOAD_BYTES) throw new ApiError(413, 'file_too_big', MSG.fileTooBig);
  if (file.size === 0) throw bad('empty_file', MSG.emptyFile);
  const data = new Uint8Array(await file.arrayBuffer());
  if (data.byteLength === 0) throw bad('empty_file', MSG.emptyFile);
  if (data.byteLength > MAX_UPLOAD_BYTES) throw new ApiError(413, 'file_too_big', MSG.fileTooBig);
  return data;
}

async function uploadAction(ctx: Ctx): Promise<Data> {
  if (ctx.role === 'staff') requireStaffMe(ctx);
  const conv = await ownConversation(ctx, reqId(ctx.params.conversationId));
  const rawCaption = ctx.params.caption;
  if (rawCaption !== undefined && rawCaption !== null && typeof rawCaption !== 'string') {
    throw bad('bad_request', MSG.badRequest);
  }
  const caption = (rawCaption ?? '').replace(/\r\n?/g, '\n').trim();
  if (caption.length > CAPTION_MAX) throw bad('caption_too_long', MSG.captionTooLong);

  const file = ctx.file;
  const data = await readUpload(file);
  const cls = classifyUpload(data, file!.type, file!.name);
  const content: Content = {
    kind: cls.kind,
    text: caption || undefined,
    fileName: cls.fileName,
    mimeType: cls.mimeType,
    fileSize: data.byteLength,
    upload: { data, fileName: cls.fileName, mimeType: cls.mimeType },
  };

  return deliver(ctx, conv, 'upload', async () => {
    const result = await relay(ctx, conv, content);
    // Telegram rasm/animatsiyani qabul qilmasa (o'lcham/nisbat cheklovlari) — hujjat sifatida qayta urinamiz.
    // Yuklash yo'lida relay xatoda hech narsa saqlamaydi va avto-javob yubormaydi, shuning uchun takrorlash xavfsiz.
    if (!result.ok && !result.message && result.error === 'send_failed' && content.kind !== 'document') {
      const mimeType = cls.sourceMime;
      return relay(ctx, conv, { ...content, kind: 'document', mimeType, upload: { data, fileName: cls.fileName, mimeType } });
    }
    return result;
  });
}

/** Faylni so'rovchining o'z bot chatiga yuborish ("📥 Botda ochish"). */
async function resendAction(ctx: Ctx): Promise<Data> {
  if (ctx.role === 'staff') requireStaffMe(ctx);
  const msg = await getMessage(reqId(ctx.params.messageId));
  if (!msg) throw new ApiError(404, 'message_not_found', MSG.msgNotFound);
  const conv = await ownConversation(ctx, msg.conversation_id);

  const target: BotKind = ctx.role;
  if (!apiFor(target)) throw new ApiError(503, 'staff_bot_missing', MSG.staffBotMissing);
  const chatId = ctx.role === 'client' ? ctx.client.tg_user_id : ctx.user.id;

  const content = contentFromMessage(msg);
  let source: BotKind = target;
  const ownFileId = target === 'client' ? msg.file_id_client : msg.file_id_staff;
  const otherBot: BotKind = target === 'client' ? 'staff' : 'client';
  const otherFileId = target === 'client' ? msg.file_id_staff : msg.file_id_client;
  if (MEDIA_KINDS.has(msg.kind)) {
    if (ownFileId) {
      content.fileId = ownFileId;
    } else if (otherFileId && apiFor(otherBot)) {
      content.fileId = otherFileId;
      source = otherBot;
    } else {
      throw new ApiError(404, 'file_missing', MSG.fileMissing);
    }
  }

  // Sarlavha: qaysi suhbatdan ekanini ko'rsatadi; xodimga "↩️ Javob berish" tugmasi ham qo'shiladi
  let header: string;
  if (ctx.role === 'client') {
    const staff = await getStaff(conv.staff_id);
    header = `📥 ${staff?.full_name ?? 'Xodim'} bilan suhbatdan`;
  } else {
    const client = await getClient(conv.client_id);
    header = `📥 ${clientName(client)} bilan suhbatdan`;
  }

  await enforceRate(ctx, 'resend');
  let sent;
  try {
    sent = await sendContent(target, chatId, content, source, {
      header: truncate(header, 200),
      ...(target === 'staff' ? { replyMarkup: staffMessageKeyboard(conv.id) } : {}),
    });
  } catch (e) {
    if (e instanceof FileTooBigError) throw new ApiError(413, 'file_too_big', MSG.fileTooBigForBot);
    const code = tgErrorCode(e);
    const desc = tgErrorDescription(e);
    console.error(`resend (${target}) xatosi:`, redact(desc));
    if (code === 403 || /chat not found|user not found|peer_id_invalid/i.test(desc)) {
      throw new ApiError(400, 'chat_unavailable', MSG.chatUnavailable);
    }
    throw new ApiError(502, 'send_failed', MSG.sendFailed);
  }

  // Yangi file_id ni keshlaymiz; xabar hali bu chatga bog'lanmagan bo'lsa — reply orqali javob berish ham ishlasin
  const patch: Parameters<typeof updateMessageDelivery>[1] = {};
  if (sent.fileId && !ownFileId) {
    if (target === 'client') patch.file_id_client = sent.fileId;
    else patch.file_id_staff = sent.fileId;
  }
  if (target === 'client' && msg.client_chat_msg_id == null) patch.client_chat_msg_id = sent.messageId;
  if (target === 'staff' && msg.staff_chat_msg_id == null) {
    patch.staff_chat_id = chatId;
    patch.staff_chat_msg_id = sent.messageId;
  }
  await updateMessageDelivery(msg.id, patch).catch((e) => console.error('resend updateMessageDelivery:', describeError(e)));
  // Nusxaning (sarlavhasi, bo'laklari bilan) har bir Telegram xabariga Reply qilinsa ham to'g'ri suhbat topilsin
  const linkIds = sent.messageIds.filter((id) => id !== patch.client_chat_msg_id && id !== patch.staff_chat_msg_id);
  await addMessageLinks(msg.id, target, chatId, linkIds).catch((e) => console.error('resend message_links:', describeError(e)));
  return {};
}

// ───────────────────────────── Admin amallari ─────────────────────────────

type StaffPatch = Partial<Pick<Staff, StaffEditableField>>;

function strField(v: unknown, label: string): string {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'string') throw bad('validation', `⚠️ ${label} matn bo'lishi kerak.`);
  return v;
}

/** Xodim maydonlarini tekshirish (bot bilan bir xil cheklovlar). Noma'lum maydonlar e'tiborsiz qoldiriladi. */
function validateStaffFields(src: Record<string, unknown>, creating: boolean): StaffPatch {
  const out: StaffPatch = {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined;

  if (has('full_name') || creating) {
    const v = strField(src.full_name, 'Ism').replace(/\s+/g, ' ').trim();
    if (v.length < 2 || v.length > 64) throw bad('validation', "⚠️ Ism 2 dan 64 belgigacha bo'lishi kerak.");
    out.full_name = v;
  }
  if (has('position')) {
    const v = strField(src.position, 'Lavozim').replace(/\s+/g, ' ').trim();
    if (v.length > 100) throw bad('validation', '⚠️ Lavozim 100 belgidan oshmasligi kerak.');
    out.position = v;
  }
  if (has('description')) {
    const v = strField(src.description, 'Tavsif').replace(/\r\n?/g, '\n').trim();
    if (v.length > 700) throw bad('validation', '⚠️ Tavsif 700 belgidan oshmasligi kerak.');
    out.description = v;
  }
  if (has('greeting')) {
    const v = strField(src.greeting, 'Avto-javob').replace(/\r\n?/g, '\n').trim();
    if (v.length > 1000) throw bad('validation', '⚠️ Avto-javob matni 1000 belgidan oshmasligi kerak.');
    out.greeting = v || null;
  }
  if (has('role') || creating) {
    if (src.role !== 'operator' && src.role !== 'manager') {
      throw bad('validation', "⚠️ Rol noto'g'ri: operator yoki menejer bo'lishi kerak.");
    }
    out.role = src.role;
  }
  if (has('is_active')) {
    const v = asBool(src.is_active);
    if (v === null) throw bad('validation', "⚠️ Faollik holati noto'g'ri.");
    out.is_active = v;
  }
  if (has('is_online')) {
    const v = asBool(src.is_online);
    if (v === null) throw bad('validation', "⚠️ Onlayn holati noto'g'ri.");
    out.is_online = v;
  }
  if (has('sort_order')) {
    const raw = src.sort_order;
    const n = typeof raw === 'string' && /^\s*-?\d{1,9}\s*$/.test(raw) ? Number(raw.trim()) : raw;
    if (typeof n !== 'number' || !Number.isInteger(n) || Math.abs(n) > 1_000_000) {
      throw bad('validation', "⚠️ Tartib raqami butun son bo'lishi kerak.");
    }
    out.sort_order = n;
  }
  return out;
}

/**
 * Xodimni xodimlar boti orqali xabardor qilish (bot admin paneli bilan bir xil). `resetKeyboard` — u endi xodim
 * emas: eski "💬 Chatlar / 🔄 Holat" klaviaturasi olib tashlanadi (admin bo'lsa — admin klaviaturasi).
 * Javobdan oldin kutiladi: Vercel funksiyasi javobdan keyin muzlatilishi mumkin. Xatolar e'tiborsiz.
 */
async function notifyStaffUser(tgUserId: number | null, text: string, resetKeyboard: boolean): Promise<void> {
  const api = staffApi();
  if (!api || !tgUserId) return;
  try {
    await api.sendMessage(tgUserId, text, {
      parse_mode: 'HTML',
      ...(resetKeyboard ? { reply_markup: mainKeyboard(null, isAdmin(tgUserId)) } : {}),
    });
  } catch (e) {
    console.warn(`[app/admin] ${tgUserId} ga xabarnoma yuborilmadi:`, redact(tgErrorDescription(e)));
  }
}

async function loadStaffForAdmin(id: number): Promise<Staff> {
  const s = await getStaff(id);
  if (!s || s.deleted_at) throw new ApiError(404, 'staff_not_found', MSG.staffNotFound);
  return s;
}

async function adminStaffList(): Promise<Data> {
  const [list, clientBot] = await Promise.all([listAllStaff(), safeClientBotUsername()]);
  return { staff: await Promise.all(list.map((s) => adminStaffDTO(s))), client_bot: clientBot };
}

function linkInvalid(): ApiError {
  return new ApiError(400, 'link_invalid', MSG.linkInvalid);
}

function linkTaken(): ApiError {
  return new ApiError(409, 'link_taken', MSG.linkTaken);
}

/**
 * `link_code` (mijozlar uchun havola nomi): berilmagan — undefined; aks holda normallashtirilgan to'g'ri nom
 * (2–32 ta lotin harfi, raqam yoki _; katta harflar kichikka o'giriladi). Noto'g'ri — 400 link_invalid.
 */
function linkCodeParam(src: Record<string, unknown>): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(src, 'link_code') || src.link_code === undefined) return undefined;
  const code = typeof src.link_code === 'string' ? normalizeLinkCode(src.link_code) : '';
  if (!isValidLinkCode(code)) throw linkInvalid();
  return code;
}

/**
 * Yangi xodim: ixtiyoriy `link_code` yaratilgandan keyin qo'llanadi. Bo'sh / berilmagan — ismdan avtomatik nom
 * qoladi. Noto'g'ri yoki band bo'lsa ham xodim yaratiladi: avtomatik nom qoladi va javobda `warning` qaytadi.
 */
async function adminStaffCreate(ctx: StaffCtx): Promise<Data> {
  const fields = validateStaffFields(ctx.params, true);
  const rawLink = ctx.params.link_code;
  const wantLink = rawLink !== undefined && rawLink !== null && !(typeof rawLink === 'string' && !rawLink.trim());
  let staff = await createStaff({
    role: fields.role!,
    full_name: fields.full_name!,
    position: fields.position ?? '',
    description: fields.description ?? '',
    greeting: fields.greeting ?? null,
  });
  const extra: StaffPatch = {};
  if (fields.is_active !== undefined) extra.is_active = fields.is_active;
  if (fields.is_online !== undefined) extra.is_online = fields.is_online;
  if (fields.sort_order !== undefined) extra.sort_order = fields.sort_order;
  if (Object.keys(extra).length) staff = (await updateStaff(staff.id, extra)) ?? staff;

  let linkWarning: { warning: string; warning_code: 'link_invalid' | 'link_taken' } | null = null;
  if (wantLink) {
    const code = typeof rawLink === 'string' ? normalizeLinkCode(rawLink) : '';
    if (code !== (staff.link_code ?? '').toLowerCase()) {
      const res = isValidLinkCode(code) ? await setStaffLinkCode(staff.id, code) : null;
      if (res?.ok) staff = res.staff;
      else {
        const auto = staff.link_code ? ` Avtomatik nom qoldirildi: ${staff.link_code}` : '';
        linkWarning =
          res?.reason === 'taken'
            ? { warning: `⚠️ Xodim qo'shildi, lekin «${code}» havola nomi band.${auto}`, warning_code: 'link_taken' }
            : {
                warning: `⚠️ Xodim qo'shildi, lekin havola nomi noto'g'ri (2–32 ta lotin harfi, raqam yoki _ bo'lishi kerak).${auto}`,
                warning_code: 'link_invalid',
              };
      }
    }
  }
  return { staff: await adminStaffDTO(staff), ...(linkWarning ?? {}) };
}

async function adminStaffUpdate(ctx: StaffCtx): Promise<Data> {
  const id = reqId(ctx.params.id);
  let src: Record<string, unknown>;
  if (isObject(ctx.params.patch)) src = ctx.params.patch;
  else if (ctx.params.patch === undefined) {
    const { id: _id, ...rest } = ctx.params;
    src = rest;
  } else throw bad('bad_request', MSG.badRequest);
  const patch = validateStaffFields(src, false);
  const linkCode = linkCodeParam(src);
  if (!Object.keys(patch).length && linkCode === undefined) throw bad('no_patch', MSG.noPatch);
  const before = await loadStaffForAdmin(id);
  // Havola nomi band bo'lsa — boshqa maydonlar ham o'zgartirilmaydi (admin formani tuzatib qayta yuboradi)
  const linkChanged = linkCode !== undefined && linkCode !== (before.link_code ?? '').toLowerCase();
  if (linkChanged) {
    const holder = await getStaffByLinkCode(linkCode);
    if (holder && holder.id !== id) throw linkTaken();
  }
  let updated: Staff | null = before;
  if (Object.keys(patch).length) {
    updated = await updateStaff(id, patch);
    if (!updated) throw new ApiError(404, 'staff_not_found', MSG.staffNotFound);
  }
  // Havola nomi boshqa maydonlardan keyin qo'llanadi (setStaffLinkCode — yagona indeks bilan poyga ham tekshiriladi)
  if (linkChanged) {
    const res = await setStaffLinkCode(id, linkCode);
    if (!res.ok) {
      if (res.reason === 'taken') throw linkTaken();
      if (res.reason === 'invalid') throw linkInvalid();
      throw new ApiError(404, 'staff_not_found', MSG.staffNotFound);
    }
    updated = res.staff;
  }
  // Faollashtirildi / o'chirib qo'yildi — xodimga xabar (o'zini o'zgartirgan admin uchun emas, bot bilan bir xil)
  if (updated.is_active !== before.is_active && updated.tg_user_id && updated.tg_user_id !== ctx.user.id) {
    await notifyStaffUser(updated.tg_user_id, updated.is_active ? STAFF_NOTICE.activated : STAFF_NOTICE.deactivated, false);
  }
  // Havola nomi o'zgardi — xodim eski havolani mijozlarga bergan bo'lishi mumkin: yangisini bilsin (bot bilan bir xil)
  if (linkChanged && updated.tg_user_id && updated.tg_user_id !== ctx.user.id) {
    const link = await safeClientLink(updated);
    if (link) await notifyStaffUser(updated.tg_user_id, STAFF_NOTICE.linkChanged(link), false);
  }
  return { staff: await adminStaffDTO(updated) };
}

async function adminStaffPhoto(ctx: StaffCtx): Promise<Data> {
  const id = reqId(ctx.params.id);
  const staff = await loadStaffForAdmin(id);
  const data = await readUpload(ctx.file);
  const mime = sniffImage(data);
  if (!mime || mime === 'image/gif') throw bad('bad_image', MSG.badImage);
  const api = staffApi();
  if (!api) throw new ApiError(503, 'staff_bot_missing', MSG.staffBotMissing);

  let sent;
  try {
    sent = await api.sendPhoto(ctx.user.id, new InputFile(data, `staff_${id}.${extForMime(mime)}`), {
      caption: `🖼 <b>${esc(truncate(staff.full_name, 100))}</b> uchun rasm yangilandi`,
      parse_mode: 'HTML',
    });
  } catch (e) {
    const code = tgErrorCode(e);
    const desc = tgErrorDescription(e);
    console.error('admin.staff.photo sendPhoto xatosi:', redact(desc));
    if (code === 403 || /chat not found|user not found|peer_id_invalid|can't initiate/i.test(desc)) {
      throw new ApiError(400, 'admin_chat_unavailable', MSG.adminChatUnavailable);
    }
    if (code === 400) throw bad('bad_image', MSG.imageRejected);
    throw new ApiError(502, 'send_failed', MSG.sendFailed);
  }
  const largest = sent.photo?.[sent.photo.length - 1];
  if (!largest) throw new ApiError(502, 'send_failed', MSG.sendFailed);
  const updated = await setStaffPhoto(id, largest.file_id, largest.file_unique_id);
  if (!updated) throw new ApiError(404, 'staff_not_found', MSG.staffNotFound);
  return { staff: await adminStaffDTO(updated) };
}

async function adminStaffPhotoRemove(ctx: StaffCtx): Promise<Data> {
  const id = reqId(ctx.params.id);
  await loadStaffForAdmin(id);
  const updated = await setStaffPhoto(id, null, null);
  if (!updated) throw new ApiError(404, 'staff_not_found', MSG.staffNotFound);
  return { staff: await adminStaffDTO(updated) };
}

async function adminStaffInvite(ctx: StaffCtx): Promise<Data> {
  const id = reqId(ctx.params.id);
  await loadStaffForAdmin(id);
  const updated = await regenerateInvite(id);
  if (!updated) throw new ApiError(404, 'staff_not_found', MSG.staffNotFound);
  const dto = await adminStaffDTO(updated);
  return { staff: dto, invite_link: dto.invite_link };
}

async function adminStaffUnlink(ctx: StaffCtx): Promise<Data> {
  const id = reqId(ctx.params.id);
  const before = await loadStaffForAdmin(id);
  const updated = await unlinkStaff(id);
  if (!updated) throw new ApiError(404, 'staff_not_found', MSG.staffNotFound);
  // Uzilgan odamni xabardor qilish va xodim klaviaturasini olib tashlash (o'zini uzgan admin ham — bot bilan bir xil)
  if (before.tg_user_id) await notifyStaffUser(before.tg_user_id, STAFF_NOTICE.unlinked(before.full_name), true);
  return { staff: await adminStaffDTO(updated) };
}

async function adminStaffDelete(ctx: StaffCtx): Promise<Data> {
  const id = reqId(ctx.params.id);
  const before = await loadStaffForAdmin(id);
  const deleted = await softDeleteStaff(id);
  if (!deleted) throw new ApiError(404, 'staff_not_found', MSG.staffNotFound);
  if (before.tg_user_id) await notifyStaffUser(before.tg_user_id, STAFF_NOTICE.deleted(before.full_name), true);
  return { deleted: true, id };
}

const SETTING_FIELDS = {
  welcome: { key: SETTING_KEYS.welcome, def: DEFAULT_WELCOME },
  greeting: { key: SETTING_KEYS.greeting, def: DEFAULT_GREETING },
  offline_note: { key: SETTING_KEYS.offlineNote, def: DEFAULT_OFFLINE_NOTE },
} as const;

type SettingField = keyof typeof SETTING_FIELDS;
const SETTING_NAMES = Object.keys(SETTING_FIELDS) as SettingField[];

async function adminSettingsGet(): Promise<Data> {
  const values = await Promise.all(SETTING_NAMES.map((f) => getSetting(SETTING_FIELDS[f].key)));
  const out: Data = {};
  const defaults: Record<string, string> = {};
  SETTING_NAMES.forEach((f, i) => {
    out[f] = values[i] || null;
    defaults[f] = SETTING_FIELDS[f].def;
  });
  return { ...out, defaults };
}

async function adminSettingsSet(ctx: StaffCtx): Promise<Data> {
  const ops: Array<() => Promise<void>> = [];
  for (const f of SETTING_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(ctx.params, f) || ctx.params[f] === undefined) continue;
    const raw = ctx.params[f];
    if (raw !== null && typeof raw !== 'string') throw bad('validation', MSG.badRequest);
    const value = (raw ?? '').replace(/\r\n?/g, '\n').trim();
    if (value.length > SETTING_MAX) {
      throw bad('validation', `⚠️ Matn ${SETTING_MAX} belgidan oshmasligi kerak.`);
    }
    const key = SETTING_FIELDS[f].key;
    ops.push(value ? () => setSetting(key, value) : () => deleteSetting(key));
  }
  if (!ops.length) throw bad('no_patch', MSG.noPatch);
  for (const op of ops) await op();
  return adminSettingsGet();
}

async function adminStats(): Promise<Data> {
  const stats = await getStats();
  return { ...stats, stats };
}

// ───────────────────────────── Marshrutlash ─────────────────────────────

async function dispatch(action: string, ctx: Ctx): Promise<Data> {
  switch (action) {
    case 'bootstrap':
      return ctx.role === 'client' ? clientBootstrap(ctx) : staffBootstrap(ctx);
    case 'conversation.open':
      return conversationOpen(ctx);
    case 'status.set':
      return statusSet(ctx);
    case 'messages':
      return messagesAction(ctx);
    case 'sync':
      return syncAction(ctx);
    case 'send':
      return sendAction(ctx);
    case 'upload':
      return uploadAction(ctx);
    case 'resend':
      return resendAction(ctx);
    case 'retry':
      return retryAction(ctx);
    case 'conversations':
      return staffConversationsAction(ctx);
    case 'admin.staff.list':
      requireAdmin(ctx);
      return adminStaffList();
    case 'admin.staff.create':
      return adminStaffCreate(requireAdmin(ctx));
    case 'admin.staff.update':
      return adminStaffUpdate(requireAdmin(ctx));
    case 'admin.staff.photo':
      return adminStaffPhoto(requireAdmin(ctx));
    case 'admin.staff.photo.remove':
      return adminStaffPhotoRemove(requireAdmin(ctx));
    case 'admin.staff.invite':
      return adminStaffInvite(requireAdmin(ctx));
    case 'admin.staff.unlink':
      return adminStaffUnlink(requireAdmin(ctx));
    case 'admin.staff.delete':
      return adminStaffDelete(requireAdmin(ctx));
    case 'admin.settings.get':
      requireAdmin(ctx);
      return adminSettingsGet();
    case 'admin.settings.set':
      return adminSettingsSet(requireAdmin(ctx));
    case 'admin.stats':
      requireAdmin(ctx);
      return adminStats();
    default:
      throw new ApiError(400, 'unknown_action', MSG.unknownAction);
  }
}

function errorResponse(e: ApiError): Response {
  return json({ ...(e.extra.data ?? {}), ok: false, error: e.code, message: e.message }, e.status, e.extra.headers ?? {});
}

/** Vercel funksiyasi (api/app.ts) shu funksiyani chaqiradi. */
export async function handleAppRequest(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return json({ ok: false, error: 'method_not_allowed', message: MSG.methodNotAllowed }, 405, { allow: 'POST' });
  }
  let action = '';
  try {
    const parsed = await parseRequest(req);
    action = parsed.action;
    // Imzo tekshiruvi va mijozlar uchun taqiq — bazaga murojaatdan oldin
    const auth = authenticate(parsed);
    // Deploy migratsiyadan oldin chiqib qolgan bo'lsa — sxema shu yerda (instansiyada bir marta) yangilanadi
    await ensureSchema();
    const ctx = await buildContext(auth, parsed);
    if (!action) throw bad('bad_request', MSG.noAction);
    const data = await dispatch(action, ctx);
    return json({ ...data, ok: true });
  } catch (e) {
    if (e instanceof ApiError) return errorResponse(e);
    console.error(`[app] "${action.slice(0, 40)}" amalida xato:`, e instanceof Error ? redact(e.stack ?? e.message) : e);
    return json({ ok: false, error: 'internal', message: MSG.internal }, 500);
  }
}

// amoCRM Chats API (amojo) integratsiyasi: mijoz yozishmalari amoCRM chatlarida ham ko'rinadi va
// operator amoCRM dan javob bera oladi. Telegram dagi xodim boti avvalgidek ishlayveradi (ikkala tomondan javob mumkin).
// Sozlamalar (.env / Vercel): AMOCRM_CHANNEL_ID, AMOCRM_CHANNEL_SECRET, AMOCRM_AMOJO_ID, AMOCRM_BOT_ID.
// Hujjat: https://www.amocrm.ru/developers/content/chats/chat-api-reference
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { signMediaToken } from './auth.js';
import { db } from './db.js';
import { getAppUrl } from './links.js';
import { vercelWaitUntil } from './redeliver.js';
import { deleteSetting, getSetting, getStaff, setSetting } from './repo.js';
import type { Client, Content, Message, Staff } from './types.js';
import { clientName, describeError, sleep } from './util.js';

const AMOJO = 'https://amojo.amocrm.ru';
const TIMEOUT_MS = 8000;

function env(name: string): string {
  return (process.env[name] ?? '').trim();
}

export const amo = {
  get enabled(): boolean {
    return !!(env('AMOCRM_CHANNEL_ID') && env('AMOCRM_CHANNEL_SECRET') && env('AMOCRM_AMOJO_ID'));
  },
  get channelId(): string {
    return env('AMOCRM_CHANNEL_ID');
  },
  get secret(): string {
    return env('AMOCRM_CHANNEL_SECRET');
  },
  get amojoId(): string {
    return env('AMOCRM_AMOJO_ID');
  },
  get botId(): string {
    return env('AMOCRM_BOT_ID');
  },
  /** REST API (lid/kontakt yaratish, javobgar biriktirish) uchun: AMOCRM_DOMAIN + AMOCRM_TOKEN (uzoq muddatli). */
  get restEnabled(): boolean {
    return !!(env('AMOCRM_DOMAIN') && env('AMOCRM_TOKEN'));
  },
};

/** amoCRM dagi chat <-> bizdagi suhbat (conversations.id). */
export const amoConversationId = (conversationId: number): string => `uzg-conv-${conversationId}`;
export function parseAmoConversationId(s: string | undefined): number | null {
  const m = /^uzg-conv-(\d+)$/.exec(s ?? '');
  return m ? Number(m[1]) : null;
}

function rfc2822(d: Date): string {
  return d.toUTCString().replace(/GMT$/, '+0000');
}

/** amojo so'rov imzosi: HMAC-SHA1(METHOD\nmd5\ncontent-type\ndate\npath, secret). */
export function signRequest(method: string, path: string, body: string, secret: string, date: Date = new Date()) {
  const md5 = createHash('md5').update(body).digest('hex');
  const dateStr = rfc2822(date);
  const contentType = 'application/json';
  const signature = createHmac('sha1', secret)
    .update([method.toUpperCase(), md5, contentType, dateStr, path].join('\n'))
    .digest('hex');
  return { Date: dateStr, 'Content-Type': contentType, 'Content-MD5': md5, 'X-Signature': signature };
}

/** amoCRM dan kelgan hook imzosi: HMAC-SHA1(body, secret). */
export function verifyHookSignature(body: string, signature: string | null, secret: string): boolean {
  if (!signature || !secret) return false;
  const expected = createHmac('sha1', secret).update(body).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature.trim().toLowerCase());
  return a.length === b.length && timingSafeEqual(a, b);
}

async function amojoPost(path: string, payload: unknown): Promise<unknown> {
  const body = JSON.stringify(payload);
  const res = await fetch(AMOJO + path, {
    method: 'POST',
    headers: signRequest('POST', path, body, amo.secret),
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`amojo ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const SCOPE_KEY = 'amocrm_scope_id';

/** Kanalni akkauntga ulash (scope_id olinadi va saqlanadi). Integratsiya qayta o'rnatilsa — qayta chaqiriladi. */
export async function connectAmoChannel(): Promise<string> {
  const r = (await amojoPost(`/v2/origin/custom/${amo.channelId}/connect`, {
    account_id: amo.amojoId,
    title: 'UzGrow Telegram',
    hook_api_version: 'v2',
  })) as { scope_id?: string };
  if (!r?.scope_id) throw new Error('amojo connect: scope_id qaytmadi');
  await setSetting(SCOPE_KEY, r.scope_id);
  return r.scope_id;
}

let scopeCache: string | null = null;
async function scopeId(): Promise<string> {
  if (scopeCache) return scopeCache;
  scopeCache = (await getSetting(SCOPE_KEY)) ?? (await connectAmoChannel());
  return scopeCache;
}

function clientParticipant(client: Client) {
  return {
    id: `uzg-client-${client.tg_user_id}`,
    name: clientName(client),
    ...(client.username ? { profile_link: `https://t.me/${client.username}` } : {}),
  };
}

const AMO_MEDIA_TYPE: Partial<Record<Content['kind'], string>> = {
  photo: 'picture',
  video: 'video',
  animation: 'video',
  document: 'file',
  audio: 'audio',
  voice: 'voice',
  video_note: 'video',
  sticker: 'picture',
};

/** Bizdagi xabar -> amoCRM xabar obyekti. Fayl — imzolangan vaqtinchalik havola (/api/media), amoCRM o'zi yuklab oladi. */
async function amoMessage(m: Message): Promise<Record<string, unknown>> {
  const type = AMO_MEDIA_TYPE[m.kind];
  if (!type) return { type: 'text', text: m.text || `[${m.kind}]` };
  const media = `${await getAppUrl()}/api/media?t=${encodeURIComponent(signMediaToken(m.id, 24 * 60 * 60))}`;
  return {
    type,
    text: m.text ?? '',
    media,
    file_name: m.file_name || `${m.kind}-${m.id}`,
    file_size: m.file_size ?? 0,
  };
}

async function amoRest(path: string, payload: unknown): Promise<unknown> {
  const res = await fetch(`https://${env('AMOCRM_DOMAIN')}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('AMOCRM_TOKEN')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`amoCRM ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/** Bot xodimi -> amoCRM foydalanuvchisi (settings: amo_user:<staffId> = amoCRM user id). */
export const amoUserKey = (staffId: number): string => `amo_user:${staffId}`;

const CYR: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'x', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sh',
  ъ: '', ы: 'i', ь: '', э: 'e', ю: 'yu', я: 'ya', ў: 'o', қ: 'q', ғ: 'g', ҳ: 'h',
};

/** Ismni solishtirish uchun: lotinga o'giriladi, belgilar olib tashlanadi, so'zlar tartibi ahamiyatsiz. */
export function nameKey(name: string): string {
  return [...name.toLowerCase()]
    .map((ch) => CYR[ch] ?? ch)
    .join('')
    .replace(/kh/g, 'x')
    .replace(/[^a-z\s]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

let usersCache: { at: number; users: { id: number; key: string }[] } | null = null;

/**
 * Xodim hali bog'lanmagan bo'lsa — amoCRM dagi faol foydalanuvchilar ichidan ismi bir xil (kirill/lotin, so'z
 * tartibi farqi hisobga olinmaydi) BITTA foydalanuvchi topilsa, avtomatik bog'lanadi va saqlanadi.
 */
async function amoUserFor(staffId: number): Promise<number | null> {
  const saved = Number(await getSetting(amoUserKey(staffId)));
  if (saved) return saved;
  const staff = await getStaff(staffId);
  if (!staff) return null;
  if (!usersCache || Date.now() - usersCache.at > 10 * 60_000) {
    const res = await fetch(`https://${env('AMOCRM_DOMAIN')}/api/v4/users?limit=250`, {
      headers: { Authorization: `Bearer ${env('AMOCRM_TOKEN')}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`amoCRM /api/v4/users: HTTP ${res.status}`);
    const j = (await res.json()) as { _embedded?: { users?: { id: number; name: string; rights?: { is_active?: boolean } }[] } };
    usersCache = {
      at: Date.now(),
      users: (j._embedded?.users ?? []).filter((u) => u.rights?.is_active !== false).map((u) => ({ id: u.id, key: nameKey(u.name) })),
    };
  }
  const key = nameKey(staff.full_name);
  const found = usersCache.users.filter((u) => u.key === key);
  if (found.length !== 1) return null; // topilmadi yoki bir xil ismli bir nechta — qo'lda bog'lanadi
  await setSetting(amoUserKey(staffId), String(found[0]!.id));
  return found[0]!.id;
}
const chatKey = (conversationId: number): string => `amo_chat:${conversationId}`;
const PENDING = 'pending';

/**
 * Suhbatning birinchi xabaridan OLDIN: amoCRM da chat yaratiladi, xodimga (javobgar) biriktirilgan kontakt + lid
 * ochiladi va chat kontaktga bog'lanadi — xabar «Неразобранное» ga emas, to'g'ridan-to'g'ri operator lidiga tushadi.
 * Xodim amoCRM foydalanuvchisiga bog'lanmagan bo'lsa (yoki xato) — oddiygidek «Неразобранное» ga tushadi.
 * shortcut: har suhbat (mijoz+operator) uchun alohida kontakt/lid; bitta mijoz 2 operatorga yozsa — 2 ta kontakt.
 */
async function ensureAssignedChat(conversationId: number, client: Client, staffId: number, scope: string): Promise<void> {
  if (!amo.restEnabled) return;
  const key = chatKey(conversationId);
  const existing = await getSetting(key);
  if (existing && existing !== PENDING) return;
  const amoUser = await amoUserFor(staffId).catch((e) => {
    console.error(`[amocrm] xodim #${staffId} uchun amoCRM foydalanuvchisini topib bo'lmadi:`, describeError(e));
    return null;
  });
  if (!amoUser) return;
  // Parallel xabarlar bitta lid ochsin: birinchisi «band qiladi», qolganlari tayyor bo'lishini qisqa kutadi
  const claimed = await db()`
    insert into settings (key, value, updated_at) values (${key}, ${PENDING}, now()) on conflict (key) do nothing returning key`;
  if (!claimed.length) {
    for (let i = 0; i < 10 && (await getSetting(key)) === PENDING; i++) await sleep(500);
    return;
  }
  try {
    const chat = (await amojoPost(`/v2/origin/custom/${scope}/chats`, {
      conversation_id: amoConversationId(conversationId),
      user: clientParticipant(client),
    })) as { id: string };
    const name = clientName(client);
    const [lead] = (await amoRest('/api/v4/leads/complex', [
      {
        name: `Telegram: ${name}${client.username ? ` (@${client.username})` : ''}`,
        responsible_user_id: amoUser,
        _embedded: { contacts: [{ name, responsible_user_id: amoUser }] },
      },
    ])) as { id: number; contact_id: number }[];
    if (!lead?.contact_id) throw new Error('leads/complex: contact_id qaytmadi');
    await amoRest('/api/v4/contacts/chats', [{ chat_id: chat.id, contact_id: lead.contact_id }]);
    await setSetting(key, JSON.stringify({ chat: chat.id, lead: lead.id, contact: lead.contact_id }));
  } catch (e) {
    await deleteSetting(key).catch(() => {});
    console.error(`[amocrm] suhbat #${conversationId}: lidni operatorga biriktirib bo'lmadi:`, describeError(e));
  }
}

async function sendToAmo(m: Message, client: Client, staff: Staff | null, staffId: number): Promise<void> {
  const scope = await scopeId();
  await ensureAssignedChat(m.conversation_id, client, staffId, scope);
  const t = m.created_at instanceof Date ? m.created_at.getTime() : Date.now();
  const payload: Record<string, unknown> = {
    timestamp: Math.floor(t / 1000),
    msec_timestamp: t,
    msgid: `uzg-msg-${m.id}`,
    conversation_id: amoConversationId(m.conversation_id),
    message: await amoMessage(m),
    silent: false,
  };
  if (staff) {
    // Telegram dagi xodim javobi: amoCRM da kanal boti nomidan chiquvchi xabar sifatida (xodim ismi bilan)
    payload.sender = { id: `uzg-staff-${staff.id}`, name: staff.full_name, ref_id: amo.botId };
    payload.receiver = clientParticipant(client);
    payload.silent = true;
  } else {
    payload.sender = clientParticipant(client);
  }
  await amojoPost(`/v2/origin/custom/${scope}`, { event_type: 'new_message', payload });
}

/**
 * Xabarni amoCRM ga nusxalash (fonda, xatolar faqat logga — Telegram oqimini hech qachon buzmaydi).
 * staff berilsa — xodimning Telegram dagi javobi; aks holda mijoz xabari.
 */
export function mirrorToAmo(m: Message, client: Client, staffId: number, staff: Staff | null = null): Promise<void> {
  if (!amo.enabled) return Promise.resolve();
  if (staff && !amo.botId) return Promise.resolve();
  const work = sendToAmo(m, client, staff, staffId).catch((e) =>
    console.error(`[amocrm] xabar #${m.id} ni amoCRM ga yuborib bo'lmadi:`, describeError(e)),
  );
  const waitUntil = vercelWaitUntil();
  if (waitUntil) {
    waitUntil(work);
    return Promise.resolve();
  }
  return work;
}

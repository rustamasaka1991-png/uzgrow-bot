/**
 * tests/e2e.test.ts — to'liq end-to-end test (`npm test`).
 *
 * Haqiqiy webhook handlerlari (api/client-bot.ts, api/staff-bot.ts), Mini App backend (api/app.ts) va media
 * proksi (api/media.ts) soxta Telegram serveri (tests/fake-telegram.ts) va ALOHIDA Postgres sxemasi (e2e_test)
 * ustida ishga tushiriladi. Production ma'lumotlariga (public sxema) tegilmaydi: ulanish search_path=e2e_test
 * bilan ochiladi, sxema test boshida yangidan yaratiladi va oxirida (finally) albatta o'chiriladi.
 *
 * Muhim: env o'zgaruvchilari ilova modullari import qilinishidan OLDIN o'rnatiladi (modullar dinamik import
 * qilinadi) — grammY/Api obyektlari apiRoot ni birinchi ishlatilganda eslab qoladi.
 */
import { inspect } from 'node:util';
import type { Message, Update } from 'grammy/types';
import {
  bytesEqual,
  fakeJpeg,
  fakeWebp,
  findButton,
  startFakeTelegram,
  type ChatMessage,
  type IncomingFields,
  type RecordedCall,
} from './fake-telegram.js';

// ───────────────────────────── Konstantalar ─────────────────────────────

const CLIENT = '111111:CLIENTTOKEN';
const STAFF = '222222:STAFFTOKEN';
const SCHEMA: string = 'e2e_test';
const ORIGIN = 'https://example.test';

type Kind = 'client' | 'staff';
interface TUser {
  id: number;
  is_bot: false;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

const ADMIN: TUser = { id: 9000000900, is_bot: false, first_name: 'Admin', username: 'boss_admin' };
const OP1: TUser = { id: 7001, is_bot: false, first_name: 'Aziza', username: 'aziza_op' };
const MGR: TUser = { id: 7002, is_bot: false, first_name: 'Bobur', username: 'bobur_mgr' };
const OP2: TUser = { id: 7003, is_bot: false, first_name: 'Sardor' };
const STRANGER: TUser = { id: 6666, is_bot: false, first_name: 'Begona' };
const C1: TUser = { id: 5001, is_bot: false, first_name: 'Ali', last_name: 'Valiyev', username: 'ali_v', language_code: 'uz' };
const C2: TUser = { id: 5002, is_bot: false, first_name: 'Vali' };
const C3: TUser = { id: 5003, is_bot: false, first_name: 'Guli <3' };
/** Oxirgi qadamlar uchun: xodim tanlamasdan oldin yozadigan yangi mijoz va 120+ suhbatli xodim. */
const C4: TUser = { id: 5004, is_bot: false, first_name: 'Nilufar', username: 'nilu_f' };
const OP3: TUser = { id: 7004, is_bot: false, first_name: 'Nodira' };
/** Avto-javob Telegram 5xx da yuborilmay qolganini tekshirish uchun (hali hech kimga yozmagan) yangi mijoz. */
const C5: TUser = { id: 5005, is_bot: false, first_name: 'Olim' };
/** Salomlashuv sozlamasini tekshirish uchun — faol suhbati yo'q mijoz (HTML belgilar bilan ism). */
const C6: TUser = { id: 5006, is_bot: false, first_name: 'Lola <3' };
/** Xodimning shaxsiy havolasi (/start <nom>) orqali kiradigan yangi mijozlar. */
const C7: TUser = { id: 5007, is_bot: false, first_name: 'Kamola', username: 'kamola_k' };
const C8: TUser = { id: 5008, is_bot: false, first_name: 'Jasur' };
/** Mijozlar Mini App i o'chirilgan: bazada yo'q mijoz bootstrap qilsa ham yozuv yaratilmasligi kerak. */
const C9: TUser = { id: 5009, is_bot: false, first_name: 'Yangi' };

const AZIZA_JPEG = fakeJpeg({ width: 800, height: 800, size: 6000, seed: 11 });
const SARDOR_JPEG = fakeJpeg({ width: 640, height: 640, size: 5000, seed: 22 });
const CLIENT_JPEG = fakeJpeg({ width: 1280, height: 960, size: 9000, seed: 33 });
const STAFF_JPEG = fakeJpeg({ width: 1024, height: 768, size: 7000, seed: 44 });
const UPLOAD_JPEG = fakeJpeg({ width: 900, height: 700, size: 8000, seed: 55 });

// ───────────────────────────── Muhit (env) — importlardan OLDIN ─────────────────────────────

const rawDbUrl = (process.env.DATABASE_URL ?? '').trim();
if (!rawDbUrl) {
  console.error('❌ DATABASE_URL topilmadi. Testni `npm test` orqali (.env bilan) ishga tushiring.');
  process.exit(1);
}

const tg = await startFakeTelegram({
  bots: [
    { token: CLIENT, username: 'uzgroww_bot', first_name: 'Uzgrow' },
    { token: STAFF, username: 'uzgrow_staff_bot', first_name: 'Uzgrow Xodimlar' },
  ],
  strictChats: true,
});

Object.assign(process.env, {
  TELEGRAM_API_ROOT: tg.url,
  CLIENT_BOT_TOKEN: CLIENT,
  STAFF_BOT_TOKEN: STAFF,
  WEBHOOK_SECRET: 'e2e-test-webhook-secret-0123456789',
  // HTTP orqali sozlash uchun alohida kalit (kamida 16 belgi, WEBHOOK_SECRET dan farqli)
  SETUP_KEY: 'e2e-test-setup-key-abcdef0123456789',
  ADMIN_IDS: String(ADMIN.id),
  APP_URL: ORIGIN,
  // Supavisor session pooler (5432): search_path startup parametri saqlanadi
  DATABASE_URL: rawDbUrl.replace(':6543/', ':5432/'),
  DATABASE_SEARCH_PATH: SCHEMA,
});
delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
// /api/setup preview deploymentida ishlamaydi — test muhiti production kabi
delete process.env.VERCEL_ENV;
delete process.env.MEDIA_SECRET;

// ───────────────────────────── Ilova modullari (dinamik) ─────────────────────────────

const { db, closeDb } = await import('../src/db.js');
const { migrate, runSetup } = await import('../src/setup.js');
const auth = await import('../src/auth.js');
const tgmod = await import('../src/tg.js');
const { placeholderJpeg } = await import('../src/placeholder.js');
const texts = await import('../src/texts.js');
const clientHook = (await import('../api/client-bot.js')).default;
const staffHook = (await import('../api/staff-bot.js')).default;
const appApi = (await import('../api/app.js')).default;
const mediaApi = (await import('../api/media.js')).default;
const setupApi = (await import('../api/setup.js')).default;
const guards = await import('../src/webapp/guards.js');
const util = await import('../src/util.js');
const { SCHEMA_VERSION } = await import('../src/schema.js');

const sql = db();

// ───────────────────────────── Kichik test freymvorki ─────────────────────────────

class AssertionError extends Error {}

function ok(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new AssertionError(msg);
}

function eq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new AssertionError(`${msg}: kutilgan ${JSON.stringify(expected)}, olingan ${JSON.stringify(actual)}`);
  }
}

function includes(haystack: string | null | undefined, needle: string, msg: string): void {
  if (!(haystack ?? '').includes(needle)) {
    throw new AssertionError(`${msg}: ${JSON.stringify(needle)} topilmadi ichida ${JSON.stringify(truncateForLog(haystack ?? ''))}`);
  }
}

function excludes(haystack: string | null | undefined, needle: string, msg: string): void {
  if ((haystack ?? '').includes(needle)) {
    throw new AssertionError(`${msg}: ${JSON.stringify(needle)} bo'lmasligi kerak edi: ${JSON.stringify(truncateForLog(haystack ?? ''))}`);
  }
}

function truncateForLog(s: string, n = 400): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

let passed = 0;
let failed = 0;
const failedNames: string[] = [];

/** Har doim ruxsat etilgan (zararsiz, ilova e'tiborsiz qoldiradigan) Telegram xatolari. */
function benign(c: RecordedCall): boolean {
  return /message is not modified/i.test(c.error?.description ?? '');
}

/**
 * Bitta test qadami. Oxirida umumiy invariantlar tekshiriladi:
 *  - shu qadamda yuborilgan har bir callback query ga javob berilgan;
 *  - kutilmagan Telegram API xatolari yo'q (noto'g'ri HTML, begona file_id, callback_data > 64 bayt va h.k.).
 * Ilova loglari yig'iladi va faqat qadam muvaffaqiyatsiz bo'lsa chiqariladi.
 */
async function step(
  name: string,
  fn: () => Promise<void>,
  opts: { allowFailedCalls?: (c: RecordedCall) => boolean } = {},
): Promise<void> {
  const callStart = tg.calls.length;
  const unansweredBefore = new Set(tg.unansweredCallbacks());
  const logs: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const capture =
    (tag: string) =>
    (...args: unknown[]) =>
      logs.push(`${tag} ${args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 3 }))).join(' ')}`);
  console.log = capture('log');
  console.warn = capture('warn');
  console.error = capture('error');
  const t0 = Date.now();
  try {
    await fn();
    const unanswered = tg.unansweredCallbacks().filter((id) => !unansweredBefore.has(id));
    ok(unanswered.length === 0, `javobsiz qolgan callback query lar: ${unanswered.join(', ')}`);
    const bad = tg.calls
      .slice(callStart)
      .filter((c) => !c.ok && !benign(c) && !(opts.allowFailedCalls?.(c) ?? false));
    ok(
      bad.length === 0,
      `kutilmagan Telegram API xatolari: ${bad.map((c) => `${c.method} → ${c.error?.error_code} ${c.error?.description}`).join(' | ')}`,
    );
    Object.assign(console, orig);
    passed++;
    console.log(`✅ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    Object.assign(console, orig);
    failed++;
    failedNames.push(name);
    console.log(`❌ ${name}`);
    console.log(`   ${e instanceof AssertionError ? e.message : inspect(e)}`);
    if (logs.length) {
      console.log('   ── ilova loglari ──');
      for (const l of logs.slice(-25)) console.log('   ' + truncateForLog(l, 600).replace(/\n/g, '\n   '));
    }
  }
}

// ───────────────────────────── Telegram yordamchilari ─────────────────────────────

const tokenOf = (k: Kind): string => (k === 'client' ? CLIENT : STAFF);

async function postUpdate(kind: Kind, update: unknown, secret?: string): Promise<Response> {
  const handler = kind === 'client' ? clientHook : staffHook;
  return handler.fetch(
    new Request(`${ORIGIN}/api/${kind}-bot`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': secret ?? auth.webhookSecretFor(kind),
      },
      body: JSON.stringify(update),
    }),
  );
}

/** Foydalanuvchi botga xabar yozadi. Qaytaradi: foydalanuvchi xabari (message_id bilan). */
async function say(kind: Kind, user: TUser, fields: string | IncomingFields): Promise<Message> {
  const f: IncomingFields = typeof fields === 'string' ? { text: fields } : fields;
  const upd = tg.messageUpdate(tokenOf(kind), user, f);
  const res = await postUpdate(kind, upd);
  eq(res.status, 200, 'webhook javobi');
  return (upd as { message: Message }).message;
}

/** Xabardagi tugmani bosish (matn/callback_data bo'yicha). Qaytaradi: callback query id. */
async function press(kind: Kind, user: TUser, target: ChatMessage | undefined, match: string | RegExp): Promise<string> {
  ok(target, `tugma (${String(match)}) bosiladigan xabar topilmadi`);
  const upd = tg.pressButton(tokenOf(kind), user, target, match);
  const res = await postUpdate(kind, upd);
  eq(res.status, 200, 'webhook javobi');
  return (upd as { callback_query: { id: string } }).callback_query.id;
}

/** Soxta (qo'lda yasalgan) callback_data bilan tugma bosish — egalik tekshiruvlari uchun. */
async function forge(kind: Kind, user: TUser, target: ChatMessage | number, data: string): Promise<string> {
  const upd = tg.callbackUpdate(tokenOf(kind), user, target, data);
  await postUpdate(kind, upd);
  return (upd as { callback_query: { id: string } }).callback_query.id;
}

/** Foydalanuvchi o'z xabarini tahrirlaydi (edited_message update). */
async function edit(kind: Kind, user: TUser, messageId: number, fields: IncomingFields): Promise<void> {
  const res = await postUpdate(kind, tg.editedMessageUpdate(tokenOf(kind), user, messageId, fields));
  eq(res.status, 200, 'webhook javobi (tahrir)');
}

/**
 * «⬆️ Oldingi» tugmasini (`re` ga mos callback) oxirigacha bosib borish. Qaytaradi: ochilgan oldingi sahifalar
 * (eng eskisi oxirida). Tugma bo'lmasa — bo'sh ro'yxat.
 */
async function olderPages(kind: Kind, user: TUser, first: ChatMessage | undefined, re: RegExp, max = 25): Promise<ChatMessage[]> {
  const pages: ChatMessage[] = [];
  let cur = first;
  for (let i = 0; i < max; i++) {
    const btn = findButton(cur, re);
    if (!btn?.callback_data) return pages;
    const before = mark(kind, user.id);
    await press(kind, user, cur, btn.callback_data);
    const next = botMsgsSince(kind, user.id, before).pop();
    ok(next, `oldingi sahifa yuborilmadi (${btn.callback_data})`);
    pages.push(next);
    cur = next;
  }
  throw new AssertionError(`oldingi sahifalar ${max} tadan oshdi`);
}

/** Chatdagi oxirgi xabar id si (keyingi yangi xabarlarni ajratish uchun). */
function mark(kind: Kind, chatId: number): number {
  const all = tg.chatMessages(tokenOf(kind), chatId, { includeDeleted: true });
  return all.length ? all[all.length - 1]!.id : 0;
}

/** `since` dan keyin bot yuborgan (o'chirilmagan) xabarlar. */
function botMsgsSince(kind: Kind, chatId: number, since: number): ChatMessage[] {
  return tg.sent(tokenOf(kind), chatId).filter((m) => m.id > since);
}

/** `since` dan keyin bot yuborgan barcha xabarlar matni (bitta satr). */
function textsSince(kind: Kind, chatId: number, since: number): string {
  return botMsgsSince(kind, chatId, since)
    .map((m) => m.text)
    .join('\n');
}

function lastBot(kind: Kind, chatId: number): ChatMessage | undefined {
  return tg.lastSent(tokenOf(kind), chatId);
}

function answerOf(queryId: string): { text?: string; show_alert?: boolean } {
  return (tg.callbackAnswer(queryId) ?? {}) as { text?: string; show_alert?: boolean };
}

function entitiesOf(m: ChatMessage | undefined): Array<{ type: string; offset: number; length: number }> {
  const msg = (m?.message ?? {}) as { entities?: unknown; caption_entities?: unknown };
  return ((msg.entities ?? msg.caption_entities ?? []) as Array<{ type: string; offset: number; length: number }>).slice();
}

function hasBold(m: ChatMessage | undefined, offset: number, length: number): boolean {
  return entitiesOf(m).some((e) => e.type === 'bold' && e.offset === offset && e.length === length);
}

function callsSince(start: number, token?: string, method?: string): RecordedCall[] {
  return tg.calls
    .slice(start)
    .filter((c) => (!token || c.token === token) && (!method || c.method.toLowerCase() === method.toLowerCase()));
}

function largestPhotoId(sizes: Array<{ file_id: string }>): string {
  return sizes[sizes.length - 1]!.file_id;
}

// ───────────────────────────── Mini App / media yordamchilari ─────────────────────────────

interface AppResult {
  status: number;
  body: any;
}

const initDataCache = new Map<string, string>();
function initData(kind: Kind, user: TUser): string {
  const key = `${kind}:${user.id}`;
  let v = initDataCache.get(key);
  if (!v) {
    const { is_bot: _b, ...u } = user;
    v = auth.buildInitData(tokenOf(kind), u);
    initDataCache.set(key, v);
  }
  return v;
}

async function app(kind: Kind, user: TUser | null, action: string, params: Record<string, unknown> = {}, rawInit?: string): Promise<AppResult> {
  const init = rawInit ?? (user ? initData(kind, user) : '');
  const res = await appApi.fetch(
    new Request(`${ORIGIN}/api/app`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initData: init, action, ...params }),
    }),
  );
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function appUpload(
  kind: Kind,
  user: TUser,
  action: string,
  fields: Record<string, string | number>,
  file: { bytes: Uint8Array; name: string; type: string } | null,
): Promise<AppResult> {
  const fd = new FormData();
  fd.append('initData', initData(kind, user));
  fd.append('action', action);
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  if (file) fd.append('file', new Blob([file.bytes as BlobPart], { type: file.type }), file.name);
  const res = await appApi.fetch(new Request(`${ORIGIN}/api/app`, { method: 'POST', body: fd }));
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function mediaGet(path: string, method = 'GET'): Promise<{ status: number; headers: Headers; bytes: Uint8Array }> {
  const res = await mediaApi.fetch(new Request(`${ORIGIN}${path}`, { method }));
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, bytes };
}

function expectApi(r: AppResult, status: number, what: string): any {
  if (r.status !== status) {
    throw new AssertionError(`${what}: HTTP ${status} kutilgan, olingan ${r.status}: ${JSON.stringify(r.body)?.slice(0, 400)}`);
  }
  if (status === 200) eq(r.body?.ok, true, `${what}: ok`);
  else eq(r.body?.ok, false, `${what}: ok=false`);
  return r.body;
}

// ───────────────────────────── DB yordamchilari ─────────────────────────────

async function staffRow(id: number): Promise<any> {
  return (await sql`select * from staff where id = ${id}`)[0];
}
async function clientRow(id: number): Promise<any> {
  return (await sql`select * from clients where tg_user_id = ${id}`)[0];
}
async function convRow(id: number): Promise<any> {
  return (await sql`select * from conversations where id = ${id}`)[0];
}
async function convOf(clientId: number, staffId: number): Promise<any> {
  return (await sql`select * from conversations where client_id = ${clientId} and staff_id = ${staffId}`)[0];
}
async function countMessages(convId: number, sender?: string): Promise<number> {
  const rows = sender
    ? await sql<{ n: number }[]>`select count(*)::int as n from messages where conversation_id = ${convId} and sender = ${sender}`
    : await sql<{ n: number }[]>`select count(*)::int as n from messages where conversation_id = ${convId}`;
  return rows[0]!.n;
}

// ───────────────────────────── Test holati ─────────────────────────────

const ids = { aziza: 0, bobur: 0, sardor: 0, adminMgr: 0 };
const convs = { c1aziza: 0, c2aziza: 0, c1bobur: 0, c3aziza: 0, c2sardor: 0, c3admin: 0, c7aziza: 0, c7bobur: 0 };
const invites = { aziza: '', bobur: '', sardor: '', adminMgr: '' };
/** Xodim chatidagi (staff bot) relay qilingan mijoz xabarlari id lari. */
const relayed = { c1first: 0, c1second: 0, c2first: 0, c1photo: 0, c3admin: 0 };
/** Mijoz chatidagi (client bot) xodim xabarlari id lari. */
const inClient = { azizaReply: 0, boburReply: 0, c1photoOwn: 0 };
/** Xodim chatidagi (staff bot) xodimning O'Z xabarlari id lari. */
const inStaff = { azizaReplyOwn: 0, op2Unsent: 0 };
let uploadedPhotoMsgId = 0;
let uploadedPhotoUrl = '';

const HEADER_C1 = '👤 Ali Valiyev';
const HEADER_AZIZA = '👨‍💻 Aziza Karimova';

// ── Mijozlar boti v2: shaxsiy havolalar, sodda /start, mijozlar uchun Mini App yo'q ──
const CLIENT_BOT_LINK = 'https://t.me/uzgroww_bot?start=';
const LINK_NOT_FOUND = "⚠️ Bu havola bo'yicha xodim topilmadi yoki u hozir ishlamayapti.";
const CLIENT_APP_DISABLED = 'Bu ilova faqat xodimlar uchun. Iltimos, bot chatiga qayting va shu yerda yozing.';
const OFFLINE_LINE = '🕐 Hozir oflayn — imkon qadar tezroq javob beradi.';
const LINK_HINT = 'Shu havolani mijozlaringizga bering — ular kirishi bilan siz bilan chat boshlanadi.';
const HELP_TEXT =
  'ℹ️ Botdan qanday foydalaniladi?\n\n' +
  "✍️ Savolingizni shu chatga yozing — matn, rasm, fayl yoki ovozli xabar bo'lishi mumkin.\n" +
  '💬 Xodimning javobi ham shu yerga keladi.\n' +
  '🔄 Boshqa xodim tanlash uchun: /start';
const UNKNOWN_COMMAND_TEXT =
  "🤔 Bunday buyruq yo'q — xabaringiz xodimga yuborilmadi.\n\n" +
  '✍️ Savolingizni oddiy xabar qilib yozing.\n' +
  '/start — xodim tanlash\n' +
  '/help — yordam';
/** v1 dagi standart salomlashuv (sozlamada qolgan bo'lsa — mijozga yangi qisqa standart matn ko'rsatiladi). */
const LEGACY_DEFAULT_WELCOME =
  'Assalomu alaykum, {name}! 👋\n\n' +
  "Botimizga xush kelibsiz. Bu yerda siz o'zingizga kerakli operator yoki menejerni tanlab, " +
  "u bilan to'g'ridan-to'g'ri yozishishingiz mumkin.\n\n" +
  '👨‍💻 Operatorlar — savollar va texnik yordam\n' +
  '👔 Menejerlar — buyurtma, hamkorlik va takliflar\n\n' +
  '👇 Pastdagi tugmalardan tanlang yoki «📱 Menyu» ni oching.';

function clientLink(code: string): string {
  return `${CLIENT_BOT_LINK}${code}`;
}

/** Mijozlar havolasini ulashish (t.me/share) havolasi. */
function shareUrlFor(link: string): string {
  return `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent("Men bilan shu havola orqali bog'laning")}`;
}

/** Standart salomlashuv (oddiy /start, faol suhbat yo'q). */
function welcomeFor(name: string): string {
  return texts.fill(texts.DEFAULT_WELCOME, { name });
}

/** Shaxsiy havola orqali kirgandagi yagona xabar izohi (oddiy matn ko'rinishi). */
function linkCaption(o: {
  client: string;
  staff: string;
  role: string;
  existing?: boolean;
  offline?: boolean;
  last?: string;
}): string {
  const lines = [
    o.client ? `👋 Assalomu alaykum, ${o.client}!` : '👋 Assalomu alaykum!',
    '',
    o.existing ? `Siz yana ${o.staff} bilan suhbatdasiz.` : `Siz ${o.staff} bilan bog'landingiz.`,
    o.role,
  ];
  if (o.offline) lines.push(OFFLINE_LINE);
  lines.push('', o.last ?? '✍️ Savolingizni shu yerga yozing.');
  return lines.join('\n');
}

/** Xabarning inline klaviaturasi — aynan bitta qator [👨‍💻 Operatorlar ls:operator] [👔 Menejerlar ls:manager]. */
function isRoleRowOnly(m: ChatMessage | undefined): boolean {
  const rows = (m?.markup?.inline_keyboard ?? []) as Array<Array<{ text?: string; callback_data?: string }>>;
  const flat = JSON.stringify(rows.map((r) => r.map((b) => [b.text, b.callback_data])));
  return (
    flat === JSON.stringify([[['👨‍💻 Operatorlar', 'ls:operator'], ['👔 Menejerlar', 'ls:manager']]]) &&
    m?.markup?.keyboard === undefined &&
    !JSON.stringify(m?.markup ?? {}).includes('web_app')
  );
}

/** Havola orqali kirish / «✍️ Yozish» xabari: faqat eski klaviaturani olib tashlash, inline tugmalarsiz. */
function isRemoveKeyboardOnly(m: ChatMessage | undefined): boolean {
  return JSON.stringify(m?.markup) === JSON.stringify({ remove_keyboard: true }) && m?.buttons.length === 0;
}

/** Matndagi `name` qalin (bold) yozilganmi. */
function boldName(m: ChatMessage | undefined, name: string): boolean {
  const at = m?.text.indexOf(name) ?? -1;
  return at >= 0 && hasBold(m, at, name.length);
}

function inviteCodeFrom(text: string): string {
  const m = /start=inv_([A-Za-z0-9]+)/.exec(text);
  ok(m, `taklif havolasi topilmadi: ${truncateForLog(text)}`);
  return m[1]!;
}

// ═════════════════════════════ Testlar ═════════════════════════════

async function unitTests(): Promise<void> {
  await step('unit: verifyInitData — to\'g\'ri, soxtalashtirilgan, eskirgan, begona bot', async () => {
    const user = { id: 5001, first_name: 'Ali' };
    const c = auth.verifyInitData(auth.buildInitData(CLIENT, user));
    eq(c?.bot, 'client', 'mijoz boti initData');
    eq(c?.user.id, 5001, 'user.id');
    const s = auth.verifyInitData(auth.buildInitData(STAFF, user));
    eq(s?.bot, 'staff', 'xodimlar boti initData');

    const good = auth.buildInitData(CLIENT, user);
    const tampered = good.replace(encodeURIComponent('"Ali"'), encodeURIComponent('"Vali"'));
    ok(tampered !== good, 'soxtalashtirish ishlamadi');
    eq(auth.verifyInitData(tampered), null, 'soxtalashtirilgan initData');

    const old = auth.buildInitData(CLIENT, user, Math.floor(Date.now() / 1000) - 3 * 24 * 3600);
    eq(auth.verifyInitData(old), null, 'eskirgan initData');
    eq(auth.verifyInitData(auth.buildInitData('333333:OTHERTOKEN', user)), null, 'begona bot initData');
    eq(auth.verifyInitData(''), null, "bo'sh initData");
    eq(auth.verifyInitData('hash=abc&user=%7B%7D'), null, 'buzilgan initData');
    const noHash = new URLSearchParams(good);
    noHash.delete('hash');
    eq(auth.verifyInitData(noHash.toString()), null, 'hash siz initData');
  });

  await step('unit: signMediaToken / verifyMediaToken', async () => {
    const now = Math.floor(Date.now() / 1000);
    const t = auth.signMediaToken(42);
    eq(auth.verifyMediaToken(t), 42, "to'g'ri token");
    const last = t.slice(-1);
    const tampered = t.slice(0, -1) + (last === 'A' ? 'B' : 'A');
    eq(auth.verifyMediaToken(tampered), null, 'imzo buzilgan');
    eq(auth.verifyMediaToken(t.replace(/^42\./, '43.')), null, 'boshqa xabar id si');
    eq(auth.verifyMediaToken(auth.signMediaToken(42, 60, now - 3600)), null, 'muddati o\'tgan');
    eq(auth.verifyMediaToken(t, now + 7 * 3600), null, '6 soatdan keyin');
    eq(auth.verifyMediaToken('abc'), null, 'buzilgan format');
    eq(auth.verifyMediaToken(''), null, "bo'sh token");
  });

  await step('unit: splitText / splitRanges / sliceEntities (UTF-16, surrogate)', async () => {
    eq(JSON.stringify(tgmod.splitText('qisqa', 4096)), JSON.stringify(['qisqa']), 'qisqa matn');
    const lines = Array.from({ length: 400 }, (_, i) => `${i}: ${'x'.repeat(20)}`).join('\n');
    const parts = tgmod.splitText(lines, 4096);
    ok(parts.length >= 2, "bo'laklarga bo'linmadi");
    ok(parts.every((p) => p.length <= 4096), 'bo\'lak limitdan oshdi');
    eq(parts.join('\n'), lines, 'qator bo\'yicha bo\'lingan matn tiklanmadi');

    const emoji = '😀'.repeat(5000); // 10000 UTF-16
    const eParts = tgmod.splitText(emoji, 4096);
    ok(eParts.every((p) => p.length <= 4096), 'emoji bo\'lak limitdan oshdi');
    for (const p of eParts) {
      const first = p.charCodeAt(0);
      const lastC = p.charCodeAt(p.length - 1);
      ok(!(first >= 0xdc00 && first <= 0xdfff), 'bo\'lak past surrogate bilan boshlandi');
      ok(!(lastC >= 0xd800 && lastC <= 0xdbff), 'bo\'lak yuqori surrogate bilan tugadi');
    }
    eq(eParts.join(''), emoji, 'emoji matn tiklanmadi');

    const text = 'A'.repeat(4000) + ' ' + 'B'.repeat(1500);
    const ranges = tgmod.splitRanges(text, 4096);
    eq(JSON.stringify(ranges), JSON.stringify([[0, 4000], [4001, 5501]]), "so'z chegarasida bo'linish");
    const ents = [{ type: 'bold' as const, offset: 3995, length: 10 }];
    eq(JSON.stringify(tgmod.sliceEntities(ents, 0, 4000)), JSON.stringify([{ type: 'bold', offset: 3995, length: 5 }]), '1-bo\'lak entity');
    eq(JSON.stringify(tgmod.sliceEntities(ents, 4001, 5501)), JSON.stringify([{ type: 'bold', offset: 0, length: 4 }]), '2-bo\'lak entity');
    eq(tgmod.safeFileName('a"b;c\r\n.pdf'), 'a_b_c__.pdf', 'fayl nomi tozalanmadi');
    eq(tgmod.safeFileName('../../etc/passwd'), 'passwd', "yo'l olib tashlanmadi");
  });

  await step("unit: dativeSuffix / dative — jo'nalish kelishigi (lotin, kirill, katta harf, tutuq belgisi)", async () => {
    const cases: Array<[string, string]> = [
      ['Otabek', 'ka'],
      ['Ortiq', 'qa'],
      ['Malika', 'ga'],
      ["Ulug'", 'ga'],
      ['Ulugʻ', 'ga'],
      ['Ulugʼ', 'ga'],
      ['Ulug’', 'ga'],
      ['Отабек', 'ка'],
      ['Ортиқ', 'қа'],
      ['Малика', 'га'],
      ['OTABEK', 'KA'],
      ['ORTIQ', 'QA'],
      ["ULUG'", 'GA'],
      ['ОТАБЕК', 'КА'],
      ['Ali 🌟', 'ga'],
      ['Mijoz 7', 'ga'],
      ['', 'ga'],
      ['Bobur Aliyev', 'ga'],
      ['Aziza Karimova', 'ga'],
    ];
    for (const [word, sfx] of cases) eq(util.dativeSuffix(word), sfx, `dativeSuffix(${JSON.stringify(word)})`);
    eq(util.dativeSuffix(null), 'ga', 'null');
    eq(util.dative('Otabek '), 'Otabekka', "dative: oxiridagi bo'shliq olib tashlanadi");
    eq(util.dative('Bobur Aliyev'), 'Bobur Aliyevga', "dative: ikki so'zli ism");
    eq(util.dative('Ортиқ'), 'Ортиққа', 'dative: kirill');
  });

  await step('unit: sendContent — sarlavha entity siljishi (emoji, UTF-16), uzun izoh/matn formatlash bilan', async () => {
    const chat = 424242;
    tg.knowChat(STAFF, chat);
    const body = 'Salom 😀 dunyo';
    const header = '👤 Ali 🙂';
    const suffix = ' · @ali';
    const r = await tgmod.sendContent('staff', chat, { kind: 'text', text: body, entities: [{ type: 'italic', offset: 9, length: 5 }] }, 'staff', {
      header,
      headerSuffix: suffix,
    });
    const m = tg.message(STAFF, chat, r.messageId);
    const prefix = header + suffix + '\n';
    eq(m?.text, prefix + body, 'yuborilgan matn');
    ok(hasBold(m, 0, header.length), `sarlavha bold entity: ${JSON.stringify(entitiesOf(m))}`);
    ok(
      entitiesOf(m).some((e) => e.type === 'italic' && e.offset === prefix.length + 9 && e.length === 5),
      `italic entity siljimadi: ${JSON.stringify(entitiesOf(m))}`,
    );
    eq(m?.text.slice(prefix.length + 9, prefix.length + 14), 'dunyo', 'entity to\'g\'ri so\'zga tushmadi');

    // Uzun izoh (sarlavha + izoh > 1024): rasm faqat sarlavha bilan, izoh — alohida matn, formatlash saqlanadi
    const caption = 'C'.repeat(1015) + ' oxiri'; // sarlavha bilan 1024 dan oshadi
    const photoId = tg.makeFileId(STAFF, 'photo');
    const before = mark('staff', chat);
    await tgmod.sendContent(
      'staff',
      chat,
      { kind: 'photo', text: caption, entities: [{ type: 'bold', offset: 1016, length: 5 }], fileId: photoId },
      'staff',
      { header },
    );
    const sent = botMsgsSince('staff', chat, before);
    eq(sent.length, 2, 'rasm + izoh matni');
    eq(sent[0]!.kind, 'photo', 'birinchisi rasm');
    eq(sent[0]!.text, header, 'rasm izohi faqat sarlavha');
    eq(sent[1]!.text, caption, 'izoh alohida yuborildi');
    ok(hasBold(sent[1], 1016, 5), `izoh formatlashi saqlanmadi: ${JSON.stringify(entitiesOf(sent[1]))}`);
    eq((sent[1]!.message as any)?.reply_to_message?.message_id, sent[0]!.id, 'izoh davomi rasmga reply');

    // Juda uzun matn (> 4096): bo'laklarga bo'linadi, har bir bo'lak o'z entity lari bilan
    const long = 'A'.repeat(4000) + ' ' + 'B'.repeat(1500);
    const before2 = mark('staff', chat);
    await tgmod.sendContent('staff', chat, { kind: 'text', text: long, entities: [{ type: 'bold', offset: 3995, length: 10 }] }, 'staff', {});
    const chunks = botMsgsSince('staff', chat, before2);
    eq(chunks.length, 2, 'ikki bo\'lak');
    ok(hasBold(chunks[0], 3995, 5) && hasBold(chunks[1], 0, 4), `bo\'laklardagi entity lar: ${JSON.stringify(chunks.map(entitiesOf))}`);

    // 429 (flood limit): qisqa kutib, bir marta qayta urinadi — xabar yo'qolmaydi
    tg.failNext(STAFF, 'sendMessage', { error_code: 429, description: 'Too Many Requests: retry after 1', parameters: { retry_after: 1 } });
    const s429 = tg.calls.length;
    const r429 = await tgmod.sendContent('staff', chat, { kind: 'text', text: 'qayta urinish' }, 'staff', {});
    eq(tg.message(STAFF, chat, r429.messageId)?.text, 'qayta urinish', '429 dan keyin yuborildi');
    eq(callsSince(s429, STAFF, 'sendMessage').length, 2, 'bitta qayta urinish');
  }, { allowFailedCalls: (c) => c.error?.error_code === 429 });
}

async function setupTests(): Promise<void> {
  await step("setup: runSetup — webhook, buyruqlar (admin scope), menyu tugmalari (mijoz — buyruqlar, xodim — Mini App)", async () => {
    const setupStart = tg.calls.length;
    const report = await runSetup(ORIGIN);
    ok(report.bots.client?.ok, `client setup: ${report.bots.client?.error}`);
    ok(report.bots.staff?.ok, `staff setup: ${report.bots.staff?.error}`);
    const wc = tg.webhook(CLIENT);
    eq(wc?.url, `${ORIGIN}/api/client-bot`, 'client webhook url');
    eq(wc?.secret_token, auth.webhookSecretFor('client'), 'client webhook secret');
    eq(tg.webhook(STAFF)?.url, `${ORIGIN}/api/staff-bot`, 'staff webhook url');
    ok(tg.webhook(STAFF)?.secret_token !== wc?.secret_token, 'botlar secret lari har xil bo\'lishi kerak');
    const staffCmds = tg.commands(STAFF).map((c: any) => c.command);
    ok(staffCmds.includes('chats') && !staffCmds.includes('admin'), `umumiy xodim buyruqlari: ${staffCmds}`);
    // Mijozlar boti sodda: faqat /start va /help; Mini App yo'q — menyu tugmasi buyruqlar ro'yxati
    eq(
      JSON.stringify(tg.commands(CLIENT).map((c: any) => [c.command, c.description])),
      JSON.stringify([['start', '🔄 Boshlash / xodim tanlash'], ['help', 'ℹ️ Yordam']]),
      'mijoz buyruqlari',
    );
    const mbCall = callsSince(setupStart, CLIENT, 'setChatMenuButton')[0];
    ok(mbCall?.ok, 'mijoz menyu tugmasi aniq o\'rnatildi');
    const mbParam = mbCall!.params.menu_button;
    eq(
      JSON.stringify(typeof mbParam === 'string' ? JSON.parse(mbParam) : mbParam),
      JSON.stringify({ type: 'commands' }),
      'mijoz menyu tugmasi — buyruqlar',
    );
    const mb = tg.menuButton(CLIENT);
    eq(mb.type, 'commands', 'mijoz menyu tugmasi turi');
    eq(mb.web_app, undefined, "mijozlarda Mini App yo'q");
    const smb = tg.menuButton(STAFF);
    eq(smb.type, 'web_app', 'xodim menyu tugmasi turi');
    eq(smb.text, '💬 Chatlar', 'xodim menyu tugmasi matni');
    eq(smb.web_app?.url, `${ORIGIN}/app/`, 'Mini App manzili (xodimlar)');
    const saved = (await sql`select value from settings where key = 'app_url'`)[0];
    eq(saved?.value, ORIGIN, 'app_url sozlamasi');
  }, {
    // Admin xodimlar botini hali ochmagan — chat scope buyruqlari keyinroq (/start da) o'rnatiladi
    allowFailedCalls: (c) => c.method === 'setMyCommands' && /chat not found/.test(c.error?.description ?? ''),
  });

  await step('setup: /api/setup — faqat POST, kalit faqat «Authorization: Bearer <SETUP_KEY>» da', async () => {
    const setupKey = process.env.SETUP_KEY!;
    const webhookSecret = process.env.WEBHOOK_SECRET!;
    const call = (init: { method?: string; query?: string; auth?: string; headers?: Record<string, string> } = {}) =>
      setupApi.fetch(
        new Request(`${ORIGIN}/api/setup${init.query ?? ''}`, {
          method: init.method ?? 'POST',
          headers: { ...(init.auth !== undefined ? { authorization: init.auth } : {}), ...(init.headers ?? {}) },
        }),
      );
    const start = tg.calls.length;

    // GET (hatto to'g'ri kalit bilan ham) — 405, kalit URL da hech qachon qabul qilinmaydi
    const get = await call({ method: 'GET', query: `?key=${encodeURIComponent(setupKey)}` });
    eq(get.status, 405, 'GET ?key=<to\'g\'ri>');
    eq(get.headers.get('allow'), 'POST', 'Allow sarlavhasi');
    eq((await call({ method: 'GET', query: `?key=${encodeURIComponent(webhookSecret)}` })).status, 405, 'GET ?key=<WEBHOOK_SECRET>');

    const unauthorized: Array<[string, Parameters<typeof call>[0]]> = [
      ['sarlavhasiz', {}],
      ['POST ?key=<to\'g\'ri>, sarlavhasiz', { query: `?key=${encodeURIComponent(setupKey)}` }],
      ["noto'g'ri Bearer", { auth: 'Bearer wrong' }],
      ['WEBHOOK_SECRET Bearer sifatida', { auth: `Bearer ${webhookSecret}` }],
      ['Bearer so\'zisiz', { auth: setupKey }],
      ['X-Setup-Key sarlavhasi', { headers: { 'x-setup-key': setupKey } }],
      ['kalitning boshi', { auth: `Bearer ${setupKey.slice(0, -1)}` }],
    ];
    for (const [what, init] of unauthorized) {
      const r = await call(init);
      eq(r.status, 401, what);
      eq(((await r.json()) as any).error, 'unauthorized', `${what}: kod`);
    }
    eq(callsSince(start).length, 0, "ruxsatsiz so'rovlar Telegramga murojaat qilmaydi");

    // To'g'ri kalit (sxema katta-kichik harfga sezgir emas) — sozlash bajariladi
    const good = await call({ auth: `bearer ${setupKey}` });
    const body = (await good.json()) as any;
    eq(good.status, 200, `to'g'ri kalit: ${JSON.stringify(body)?.slice(0, 300)}`);
    eq(body.ok, true, 'setup ok');
    ok(callsSince(start, CLIENT, 'setWebhook').length === 1, 'webhook qayta o\'rnatildi');
    eq(tg.webhook(CLIENT)?.secret_token, auth.webhookSecretFor('client'), 'webhook secret o\'zgarmadi');

    // Noto'g'ri sozlangan kalitlar: WEBHOOK_SECRET bilan bir xil yoki juda qisqa — 500, bo'sh — o'chirilgan (404)
    try {
      process.env.SETUP_KEY = webhookSecret;
      const same = await call({ auth: `Bearer ${webhookSecret}` });
      eq(same.status, 500, 'SETUP_KEY == WEBHOOK_SECRET');
      eq(((await same.json()) as any).error, 'misconfigured', 'kod');
      process.env.SETUP_KEY = 'short-key';
      eq((await call({ auth: 'Bearer short-key' })).status, 500, 'qisqa SETUP_KEY');
      process.env.SETUP_KEY = '';
      const off = await call({ auth: `Bearer ${setupKey}` });
      eq(off.status, 404, "SETUP_KEY bo'sh — endpoint o'chirilgan");
      eq(((await off.json()) as any).error, 'setup_disabled', 'kod');
    } finally {
      process.env.SETUP_KEY = setupKey;
    }
  }, { allowFailedCalls: (c) => c.method === 'setMyCommands' });

  await step('webhook: maxfiy token, metodlar, buzilgan JSON', async () => {
    const upd = tg.messageUpdate(CLIENT, C1, { text: 'salom' });
    eq((await postUpdate('client', upd, 'wrong-secret')).status, 401, "noto'g'ri secret");
    eq((await postUpdate('staff', upd, auth.webhookSecretFor('client'))).status, 401, 'boshqa botning secret i');
    const noSecret = await clientHook.fetch(new Request(`${ORIGIN}/api/client-bot`, { method: 'POST', body: '{}' }));
    eq(noSecret.status, 401, 'secret yo\'q');
    const get = await clientHook.fetch(new Request(`${ORIGIN}/api/client-bot`));
    eq(get.status, 200, 'GET');
    const put = await clientHook.fetch(new Request(`${ORIGIN}/api/client-bot`, { method: 'PUT' }));
    eq(put.status, 405, 'PUT');
    const garbage = await clientHook.fetch(
      new Request(`${ORIGIN}/api/client-bot`, {
        method: 'POST',
        headers: { 'x-telegram-bot-api-secret-token': auth.webhookSecretFor('client') },
        body: 'not json',
      }),
    );
    eq(garbage.status, 200, 'buzilgan JSON — 200 (Telegram qayta yubormasin)');

    // Bot ishga tushmasa (getMe xatosi) — 503 va update belgisi olib tashlanadi (Telegram qayta yuboradi)
    const { createWebhookHandler } = await import('../src/http.js');
    const failing = createWebhookHandler('client', async () => {
      throw new Error('init failed');
    });
    const lost = { update_id: 987654321, message: { message_id: 1, date: 1, chat: { id: 1, type: 'private' }, text: 'x' } };
    const r503 = await failing(
      new Request(`${ORIGIN}/api/client-bot`, {
        method: 'POST',
        headers: { 'x-telegram-bot-api-secret-token': auth.webhookSecretFor('client') },
        body: JSON.stringify(lost),
      }),
    );
    eq(r503.status, 503, 'init xatosi — 503');
    eq((await sql`select count(*)::int as n from processed_updates where update_id = 987654321`)[0]!.n, 0, 'update belgisi olib tashlandi');
    eq(botMsgsSince('client', C1.id, 0).length, 0, "rad etilgan update lar qayta ishlanmasligi kerak");
    eq((await sql`select count(*)::int as n from clients`)[0]!.n, 0, 'rad etilgan update mijoz yaratmasligi kerak');
  });
}

async function adminFlowTests(): Promise<void> {
  await step('xodimlar boti: begona foydalanuvchi — faqat xodimlar uchun', async () => {
    await say('staff', STRANGER, '/start');
    const m = lastBot('staff', STRANGER.id);
    includes(m?.text, 'faqat xodimlar uchun', '/start javobi');
    ok(m?.markup?.remove_keyboard === true, 'klaviatura olib tashlanishi kerak');
    await say('staff', STRANGER, 'salom');
    includes(lastBot('staff', STRANGER.id)?.text, 'faqat xodimlar uchun', 'oddiy xabar javobi');
    const q = await forge('staff', STRANGER, lastBot('staff', STRANGER.id)!, 'adm:home');
    eq(answerOf(q).show_alert, true, 'begona adm: tugmasi — alert');
    await say('staff', STRANGER, '⚙️ Admin panel');
    includes(lastBot('staff', STRANGER.id)?.text, 'faqat xodimlar uchun', 'admin panel tugmasi');
  });

  await step('admin: /start — admin klaviaturasi va /admin buyrug\'i (chat scope)', async () => {
    await say('staff', ADMIN, '/start');
    const m = lastBot('staff', ADMIN.id);
    includes(m?.text, 'admin', 'admin salomlashuvi');
    const kb = JSON.stringify(tg.keyboard(STAFF, ADMIN.id));
    includes(kb, '⚙️ Admin panel', 'admin klaviaturasi');
    const cmds = tg.commands(STAFF, { type: 'chat', chat_id: ADMIN.id }).map((c: any) => c.command);
    ok(cmds.includes('admin'), `admin chatidagi buyruqlar: ${cmds}`);
  });

  await step('admin: operator qo\'shish (6 qadam, xato kiritish, o\'tkazish, rasm) → taklif havolasi', async () => {
    await say('staff', ADMIN, '⚙️ Admin panel');
    const home = lastBot('staff', ADMIN.id);
    includes(home?.text, 'Admin panel', 'admin panel');
    let q = await press('staff', ADMIN, home, 'adm:add');
    ok(answerOf(q), 'callback javobi');
    let prompt = tg.message(STAFF, ADMIN.id, home!.id);
    includes(prompt?.text, '1/6', 'rol so\'rovi (tahrir)');
    await press('staff', ADMIN, prompt, 'adm:addrole:operator');
    prompt = tg.message(STAFF, ADMIN.id, home!.id);
    includes(prompt?.text, '2/6', 'ism so\'rovi');

    await say('staff', ADMIN, 'A');
    includes(lastBot('staff', ADMIN.id)?.text, 'Ism juda qisqa', 'qisqa ism rad etiladi');
    await say('staff', ADMIN, { photo: tg.photo(STAFF, fakeJpeg()) });
    includes(lastBot('staff', ADMIN.id)?.text, 'matn ko\'rinishida', 'ism o\'rniga rasm rad etiladi');
    await say('staff', ADMIN, '  Aziza   Karimova ');
    includes(lastBot('staff', ADMIN.id)?.text, '3/6', 'lavozim so\'rovi');
    await say('staff', ADMIN, 'Katta operator');
    includes(lastBot('staff', ADMIN.id)?.text, '4/6', 'tavsif so\'rovi');
    await say('staff', ADMIN, "Buyurtma <b>va</b> to'lov & yetkazish");
    const greetPrompt = lastBot('staff', ADMIN.id);
    includes(greetPrompt?.text, '5/6', 'avto-javob so\'rovi');
    includes(greetPrompt?.text, '{name}', "o'rinbosarlar haqida izoh");
    await press('staff', ADMIN, greetPrompt, /O'tkazib yuborish/);
    const photoPrompt = tg.message(STAFF, ADMIN.id, greetPrompt!.id);
    includes(photoPrompt?.text, '6/6', 'rasm so\'rovi');
    // Rasm bo'lmagan fayl, qo'llab-quvvatlanmaydigan rasm turi (GIF) va rasm deb nomlangan, lekin rasm bo'lmagan
    // fayl rad etiladi (JPG/PNG/WebP rasm-fayllar qabul qilinadi — pastdagi tahrir qadamida tekshiriladi)
    await say('staff', ADMIN, { document: tg.document(STAFF, new TextEncoder().encode('%PDF-1.4'), { file_name: 'a.pdf', mime_type: 'application/pdf' }) });
    includes(lastBot('staff', ADMIN.id)?.text, 'rasm yoki rasm-fayl yuboring', 'PDF rad etiladi');
    await say('staff', ADMIN, { document: tg.document(STAFF, new TextEncoder().encode('GIF89a....'), { file_name: 'a.gif', mime_type: 'image/gif' }) });
    includes(lastBot('staff', ADMIN.id)?.text, 'Faqat JPG, PNG yoki WebP', 'GIF rad etiladi');
    await say('staff', ADMIN, { document: tg.document(STAFF, new TextEncoder().encode('bu rasm emas'), { file_name: 'x.jpg', mime_type: 'image/jpeg' }) });
    includes(lastBot('staff', ADMIN.id)?.text, 'Faqat JPG, PNG yoki WebP', 'baytlari rasm bo\'lmagan «jpg» rad etiladi');
    eq((await sql`select count(*)::int as n from staff where full_name = 'Aziza Karimova'`)[0]!.n, 0, 'rad etilgan fayllardan keyin xodim hali yaratilmagan');
    const sizes = tg.photo(STAFF, AZIZA_JPEG);
    const before = mark('staff', ADMIN.id);
    await say('staff', ADMIN, { photo: sizes });
    const card = botMsgsSince('staff', ADMIN.id, before).pop();
    eq(card?.kind, 'photo', 'xodim kartasi rasm bilan');
    eq(card?.fileId, largestPhotoId(sizes), 'kartada staff bot file_id ishlatiladi');
    includes(card?.text, 'Aziza Karimova', 'karta ismi');
    includes(card?.text, "Yangi xodim qo'shildi", 'bildirishnoma');
    invites.aziza = inviteCodeFrom(card!.text);
    includes(card?.text, `https://t.me/uzgrow_staff_bot?start=inv_${invites.aziza}`, 'taklif havolasi');
    includes(card?.text, "📨 Taklif havolasi — xodimning o'ziga", 'taklif havolasi sarlavhasi (mijozlar havolasidan farqli)');
    ok(findButton(card, /Havolani ulashish/), 'ulashish tugmasi');
    // Mijozlar uchun shaxsiy havola: ismdan avtomatik nom ("Aziza Karimova" → aziza), akkaunt hali ulanmagan
    includes(card?.text, 'Mijozlar uchun havolasi ham tayyor', "bildirishnomada mijozlar havolasi haqida");
    includes(card?.text, `🔗 Mijozlar uchun havola: ${clientLink('aziza')} (akkaunt ulangandan keyin ishlaydi)`, 'mijozlar havolasi');

    const row = (await sql`select * from staff where full_name = 'Aziza Karimova'`)[0];
    ok(row, 'bazada xodim');
    ids.aziza = row.id;
    eq(row.link_code, 'aziza', 'havola nomi ismdan');
    eq(findButton(card, `adm:e:${ids.aziza}:link_code`)?.text, '✏️ Havola nomi', '«✏️ Havola nomi» tugmasi');
    eq(findButton(card, /Mijozlarga ulashish/)?.url, shareUrlFor(clientLink('aziza')), 'mijozlar havolasini ulashish tugmasi');
    eq(row.role, 'operator', 'rol');
    eq(row.position, 'Katta operator', 'lavozim');
    eq(row.description, "Buyurtma <b>va</b> to'lov & yetkazish", 'tavsif xom holda saqlanadi');
    eq(row.greeting, null, 'avto-javob standart');
    eq(row.photo_file_id, largestPhotoId(sizes), 'eng katta rasm file_id');
    eq(row.tg_user_id, null, 'hali ulanmagan');
    eq((await sql`select count(*)::int as n from user_state where bot = 'staff'`)[0]!.n, 0, 'admin holati tozalangan');
  });

  await step('admin: menejer qo\'shish (rasmsiz, shaxsiy avto-javob, «-» bilan o\'tkazish)', async () => {
    await say('staff', ADMIN, '/admin');
    const home = lastBot('staff', ADMIN.id);
    await press('staff', ADMIN, home, 'adm:add');
    await press('staff', ADMIN, tg.message(STAFF, ADMIN.id, home!.id), 'adm:addrole:manager');
    await say('staff', ADMIN, 'Bobur Aliyev');
    await say('staff', ADMIN, '-');
    includes(lastBot('staff', ADMIN.id)?.text, '4/6', "«-» lavozimni o'tkazadi");
    await say('staff', ADMIN, 'Hamkorlik va ulgurji savdo');
    await say('staff', ADMIN, 'Salom {name}! Men {staff}, tez orada javob beraman.');
    includes(lastBot('staff', ADMIN.id)?.text, '6/6', 'rasm so\'rovi');
    await say('staff', ADMIN, '-');
    const card = lastBot('staff', ADMIN.id);
    eq(card?.kind, 'text', 'rasmsiz karta — matn');
    includes(card?.text, 'Bobur Aliyev', 'karta');
    invites.bobur = inviteCodeFrom(card!.text);
    const row = (await sql`select * from staff where full_name = 'Bobur Aliyev'`)[0];
    ids.bobur = row.id;
    eq(row.role, 'manager', 'rol');
    eq(row.position, '', "lavozim bo'sh");
    eq(row.greeting, 'Salom {name}! Men {staff}, tez orada javob beraman.', 'shaxsiy avto-javob');
    eq(row.photo_file_id, null, "rasm yo'q");
    eq(row.link_code, 'bobur', 'havola nomi ismdan');
    includes(card?.text, `🔗 Mijozlar uchun havola: ${clientLink('bobur')} (akkaunt ulangandan keyin ishlaydi)`, 'kartada mijozlar havolasi');
  });

  await step('admin (Mini App): xodim yaratish, validatsiya, rasm yuklash, ro\'yxat', async () => {
    const bad = await app('staff', ADMIN, 'admin.staff.create', { role: 'boss', full_name: 'X' });
    eq(expectApi(bad, 400, 'noto\'g\'ri rol').error, 'validation', 'xato kodi');
    const r = expectApi(
      await app('staff', ADMIN, 'admin.staff.create', {
        role: 'operator',
        full_name: 'Sardor Qodirov',
        position: 'Operator',
        description: 'Texnik yordam',
      }),
      200,
      'admin.staff.create',
    );
    ids.sardor = r.staff.id;
    ok(typeof r.staff.invite_link === 'string' && r.staff.invite_link.startsWith('https://t.me/uzgrow_staff_bot?start=inv_'), `invite_link: ${r.staff.invite_link}`);
    invites.sardor = inviteCodeFrom(r.staff.invite_link);
    eq(r.staff.linked, false, 'linked');
    eq(r.staff.link_code, 'sardor', 'link_code (ismdan)');
    eq(r.staff.client_link, clientLink('sardor'), 'client_link');
    eq(r.warning, undefined, "havola nomi berilmagan — ogohlantirish yo'q");

    const before = callsSince(0, STAFF, 'sendPhoto').length;
    const p = expectApi(
      await appUpload('staff', ADMIN, 'admin.staff.photo', { id: ids.sardor }, { bytes: SARDOR_JPEG, name: 'sardor.jpg', type: 'image/jpeg' }),
      200,
      'admin.staff.photo',
    );
    ok(typeof p.staff.photo_url === 'string' && p.staff.photo_url.startsWith(`/api/media?staff=${ids.sardor}&v=`), `photo_url: ${p.staff.photo_url}`);
    const photoCalls = callsSince(0, STAFF, 'sendPhoto');
    eq(photoCalls.length, before + 1, 'rasm admin chatiga yuborildi');
    const call = photoCalls[photoCalls.length - 1]!;
    eq(Number(call.params.chat_id), ADMIN.id, 'admin chati');
    ok(call.multipart && bytesEqual(tg.fileBytes(call.uploaded[0]!), SARDOR_JPEG), 'yuklangan baytlar');
    eq((await staffRow(ids.sardor)).photo_file_id, call.uploaded[0], 'staff.photo_file_id');

    const notImage = await appUpload('staff', ADMIN, 'admin.staff.photo', { id: ids.sardor }, { bytes: new TextEncoder().encode('salom'), name: 'x.jpg', type: 'image/jpeg' });
    eq(expectApi(notImage, 400, 'rasm bo\'lmagan fayl').error, 'bad_image', 'xato kodi');

    const list = expectApi(await app('staff', ADMIN, 'admin.staff.list'), 200, 'admin.staff.list');
    eq(list.staff.length, 3, 'xodimlar soni');
    ok(list.staff.every((s: any) => s.linked === false && typeof s.invite_link === 'string'), 'hammasi ulanmagan, havola bor');
    eq(list.client_bot, 'uzgroww_bot', 'client_bot (havola prefiksi uchun)');
    eq(
      JSON.stringify(list.staff.map((s: any) => [s.link_code, s.client_link]).sort()),
      JSON.stringify(['aziza', 'bobur', 'sardor'].map((c) => [c, clientLink(c)])),
      'har bir xodimda link_code va client_link',
    );
  });

  await step('admin (bot): xodim rasmini rasm-fayl (hujjat) sifatida almashtirish — rasm sifatida qayta yuklanadi', async () => {
    await say('staff', ADMIN, '/admin');
    const home = lastBot('staff', ADMIN.id);
    await press('staff', ADMIN, home, 'adm:list');
    await press('staff', ADMIN, tg.message(STAFF, ADMIN.id, home!.id), `adm:s:${ids.sardor}`);
    const card = lastBot('staff', ADMIN.id);
    eq(card?.kind, 'photo', 'karta rasm bilan');
    await press('staff', ADMIN, card, `adm:e:${ids.sardor}:photo`);
    const oldId = (await staffRow(ids.sardor)).photo_file_id as string;
    const start = tg.calls.length;
    const before = mark('staff', ADMIN.id);
    const doc = tg.document(STAFF, SARDOR_JPEG, { file_name: 'sardor-original.jpg', mime_type: 'image/jpeg' });
    await say('staff', ADMIN, { document: doc });
    const uploads = callsSince(start, STAFF, 'sendPhoto').filter((c) => c.multipart);
    eq(uploads.length, 1, 'rasm-fayl bir marta rasm sifatida yuklandi');
    ok(bytesEqual(tg.fileBytes(uploads[0]!.uploaded[0]!), SARDOR_JPEG), 'yuklangan baytlar — asl fayl');
    const row = await staffRow(ids.sardor);
    eq(row.photo_file_id, uploads[0]!.uploaded[0], 'rasm (photo) file_id saqlandi');
    ok(row.photo_file_id !== doc.file_id && row.photo_file_id !== oldId, 'hujjat file_id si saqlanmadi, rasm yangilandi');
    eq(row.client_photo_file_id, null, 'mijoz botidagi kesh tozalandi');
    const texts2 = botMsgsSince('staff', ADMIN.id, before).map((m) => m.text).join('\n');
    includes(texts2, 'Rasm qabul qilindi', 'tasdiq');
    includes(texts2, 'Sardor Qodirov', 'yangilangan karta');
    eq((await sql`select count(*)::int as n from user_state where bot = 'staff'`)[0]!.n, 0, 'admin holati tozalandi');
  });

  await step('taklif havolalari: ulash, xatolar, admin xabardor qilinadi', async () => {
    const adminBefore = mark('staff', ADMIN.id);
    const opBefore = mark('staff', OP1.id);
    await say('staff', OP1, `/start inv_${invites.aziza}`);
    const linked = botMsgsSince('staff', OP1.id, opBefore);
    includes(linked[0]?.text, 'Tabriklaymiz', 'ulash xabari');
    includes(linked[0]?.text, 'Aziza Karimova', 'profil nomi');
    // Mijozlar uchun shaxsiy havola va bir qatorli izoh (nusxalash/ulashish — «👤 Profilim» da)
    includes(linked[0]?.text, `🔗 Mijozlar uchun havolangiz:\n${clientLink('aziza')}\n${LINK_HINT}`, 'ulash xabarida mijozlar havolasi');
    includes(linked[0]?.text, '📋 Nusxalash va ulashish — «👤 Profilim» da.', 'profilga ishora');
    ok(!linked[0]!.buttons.some((b) => b.callback_data), "ulash xabarida inline tugma yo'q");
    ok(linked[1]?.buttons.some((b) => b.web_app?.url === `${ORIGIN}/app/`), 'Mini App tugmasi (📱 Chatlarni ochish)');
    includes(JSON.stringify(tg.keyboard(STAFF, OP1.id)), '💬 Chatlar', 'xodim klaviaturasi');
    excludes(JSON.stringify(tg.keyboard(STAFF, OP1.id)), 'Admin panel', 'oddiy xodimda admin tugmasi yo\'q');
    const note = botMsgsSince('staff', ADMIN.id, adminBefore).map((x) => x.text).join('\n');
    includes(note, 'akkauntini ulab oldi', 'admin bildirishnomasi');
    includes(note, '@aziza_op', 'username');

    await say('staff', OP1, `/start inv_${invites.bobur}`);
    includes(lastBot('staff', OP1.id)?.text, 'boshqa xodim profiliga ulangan', 'already_linked_other');
    await say('staff', STRANGER, `/start inv_${invites.aziza}`);
    includes(lastBot('staff', STRANGER.id)?.text, "noto'g'ri yoki eskirgan", 'ishlatilgan havola');
    await say('staff', STRANGER, '/start inv_bad!!code');
    includes(lastBot('staff', STRANGER.id)?.text, "noto'g'ri yoki eskirgan", "noto'g'ri kod");

    await say('staff', MGR, `/start inv_${invites.bobur}`);
    includes(textsSince('staff', MGR.id, 0), 'Tabriklaymiz', 'menejer ulandi');
    await say('staff', OP2, `/start inv_${invites.sardor}`);
    includes(textsSince('staff', OP2.id, 0), 'Tabriklaymiz', 'Sardor ulandi');

    eq((await staffRow(ids.aziza)).tg_user_id, OP1.id, 'Aziza tg_user_id');
    eq((await staffRow(ids.aziza)).tg_username, 'aziza_op', 'username');
    eq((await staffRow(ids.bobur)).tg_user_id, MGR.id, 'Bobur tg_user_id');
    eq((await staffRow(ids.sardor)).tg_user_id, OP2.id, 'Sardor tg_user_id');
  });

  await step("admin (bot): mijozlar havolasi nomini o'zgartirish — noto'g'ri / band nom qayta so'raladi, to'liq havola qabul qilinadi, xodim xabardor qilinadi", async () => {
    await say('staff', ADMIN, '/admin');
    const home = lastBot('staff', ADMIN.id)!;
    await press('staff', ADMIN, home, 'adm:list');
    await press('staff', ADMIN, tg.message(STAFF, ADMIN.id, home.id), `adm:s:${ids.aziza}`);
    const card = lastBot('staff', ADMIN.id);
    includes(card?.text, `🔗 Mijozlar uchun havola: ${clientLink('aziza')}`, 'ulangan xodim kartasida mijozlar havolasi');
    excludes(card?.text, 'akkaunt ulangandan keyin', 'ulangan va faol — izohsiz');
    eq(findButton(card, /Mijozlarga ulashish/)?.url, shareUrlFor(clientLink('aziza')), 'ulashish tugmasi');

    await press('staff', ADMIN, card, `adm:e:${ids.aziza}:link_code`);
    const prompt = lastBot('staff', ADMIN.id);
    includes(prompt?.text, "havola nomini o'zgartirish", "so'rov sarlavhasi");
    includes(prompt?.text, 'Hozirgi nom: aziza', 'hozirgi nom');
    includes(prompt?.text, `Havola: ${clientLink('aziza')}`, 'hozirgi havola');
    includes(prompt?.text, '✍️ Yangi nomni yuboring: 2–32 ta lotin harfi, raqam yoki _; masalan: aziza', 'qoidalar');
    includes(prompt?.text, "⚠️ Nom o'zgarsa, eski havola ishlamay qoladi.", 'ogohlantirish');
    ok(findButton(prompt, 'adm:cancel'), '✖️ Bekor qilish');

    const opMark = mark('staff', OP1.id);
    // Noto'g'ri nomlar: qoida bilan qayta so'raladi, holat saqlanadi, bazada o'zgarish yo'q
    let lastPrompt = prompt!;
    for (const bad of ['Bad Name!', 'a', 'staff_12', 'Азиза', 'x'.repeat(33)]) {
      const b = mark('staff', ADMIN.id);
      await say('staff', ADMIN, bad);
      const re = botMsgsSince('staff', ADMIN.id, b);
      eq(re.length, 1, `${bad}: bitta qayta so'rov`);
      includes(re[0]!.text, "❌ Bu nom to'g'ri emas — 2–32 ta lotin harfi, raqam yoki _; masalan: aziza", `${bad}: xato matni`);
      eq(tg.message(STAFF, ADMIN.id, lastPrompt.id)!.buttons.length, 0, `${bad}: eski so'rov tugmalari olib tashlandi`);
      lastPrompt = re[0]!;
    }
    await say('staff', ADMIN, { photo: tg.photo(STAFF, fakeJpeg({ seed: 71 })) });
    includes(lastBot('staff', ADMIN.id)?.text, "❌ Iltimos, nomni matn ko'rinishida yuboring", 'rasm — matn so\'raladi');
    eq((await staffRow(ids.aziza)).link_code, 'aziza', "noto'g'ri kiritishlardan keyin o'zgarmadi");
    eq((await sql`select count(*)::int as n from user_state where bot = 'staff'`)[0]!.n, 1, 'holat saqlanib turibdi');

    // Band nom (katta-kichik harf farqsiz) — holat saqlanadi, keyingi matn yana havola nomi sifatida olinadi
    await say('staff', ADMIN, 'BOBUR');
    includes(lastBot('staff', ADMIN.id)?.text, '❌ Bu nom band, boshqasini yozing', 'band nom');
    eq((await staffRow(ids.aziza)).link_code, 'aziza', "band nom saqlanmadi");
    eq((await sql`select count(*)::int as n from user_state where bot = 'staff'`)[0]!.n, 1, 'holat saqlandi (band)');

    // To'g'ri nom — normallashtiriladi, yangi karta, xodim yangi havola haqida xabardor qilinadi
    let b = mark('staff', ADMIN.id);
    await say('staff', ADMIN, 'Aziza_Op');
    eq((await staffRow(ids.aziza)).link_code, 'aziza_op', 'kichik harflarda saqlandi');
    eq((await sql`select count(*)::int as n from user_state where bot = 'staff'`)[0]!.n, 0, 'holat tozalandi');
    const saved = botMsgsSince('staff', ADMIN.id, b).pop();
    includes(saved?.text, '✅ Havola nomi saqlandi. Eski havola endi ishlamaydi.', 'saqlandi');
    includes(saved?.text, clientLink('aziza_op'), 'kartada yangi havola');
    let note = botMsgsSince('staff', OP1.id, opMark);
    eq(note.length, 1, 'xodimga bitta xabarnoma');
    includes(note[0]!.text, `🔗 Admin mijozlar uchun havolangizni o'zgartirdi:\n${clientLink('aziza_op')}`, 'xabarnoma: yangi havola');
    includes(note[0]!.text, 'Eski havola endi ishlamaydi — mijozlaringizga yangisini bering.', 'xabarnoma: eski havola');

    // To'liq havola yuborilsa — nom ajratib olinadi (katta harf ham)
    await press('staff', ADMIN, saved, `adm:e:${ids.aziza}:link_code`);
    b = mark('staff', ADMIN.id);
    await say('staff', ADMIN, 'https://t.me/uzgroww_bot?start=Aziza');
    eq((await staffRow(ids.aziza)).link_code, 'aziza', "to'liq havoladan nom olindi");
    includes(botMsgsSince('staff', ADMIN.id, b).pop()?.text, 'Havola nomi saqlandi', 'saqlandi (2)');
    note = botMsgsSince('staff', OP1.id, opMark);
    eq(note.length, 2, 'xodimga ikkinchi xabarnoma');
    includes(note[1]!.text, clientLink('aziza'), 'xabarnomada tiklangan havola');

    // Xuddi shu nom — «✅ Saqlandi.», xodimga xabarnoma yo'q
    await press('staff', ADMIN, lastBot('staff', ADMIN.id), `adm:e:${ids.aziza}:link_code`);
    b = mark('staff', ADMIN.id);
    await say('staff', ADMIN, 'AZIZA');
    includes(botMsgsSince('staff', ADMIN.id, b).pop()?.text, '✅ Saqlandi.', "o'zgarmagan nom");
    eq(botMsgsSince('staff', OP1.id, opMark).length, 2, "o'zgarmagan nom — xabarnoma yo'q");

    // Bekor qilish — karta qaytadi, holat tozalanadi
    await press('staff', ADMIN, lastBot('staff', ADMIN.id), `adm:e:${ids.aziza}:link_code`);
    await press('staff', ADMIN, lastBot('staff', ADMIN.id), 'adm:cancel');
    includes(lastBot('staff', ADMIN.id)?.text, 'Aziza Karimova', 'bekor qilish — karta');
    eq((await sql`select count(*)::int as n from user_state where bot = 'staff'`)[0]!.n, 0, 'holat tozalandi (bekor)');

    // Admin yordami mijozlar havolasini tushuntiradi
    await say('staff', ADMIN, '/help');
    includes(lastBot('staff', ADMIN.id)?.text, 'mijozlar uchun shaxsiy havolasi', 'admin yordami');
    includes(lastBot('staff', ADMIN.id)?.text, '«✏️ Havola nomi»', 'admin yordami (tugma)');
  });

  await step("migratsiya: havola nomi yo'q eski xodimlarga ismidan nom beriladi (band — raqam bilan, kirill, tutuq, emoji), o'chirilganlarga — yo'q", async () => {
    const legacy = ['Aziza Eski', 'Азиза Кириллча', "Ulug'bek Saidov", '🌟 Yulduz'];
    const allNames = [...legacy, 'Eski Ochirilgan'];
    try {
      // v1 dagi kabi: link_code ustunisiz yaratilgan xodimlar (createStaff emas — nom berilmagan)
      await sql`
        insert into staff (role, full_name)
        values ('operator', ${legacy[0]!}), ('operator', ${legacy[1]!}), ('manager', ${legacy[2]!}), ('operator', ${legacy[3]!})`;
      await sql`insert into staff (role, full_name, is_active, deleted_at) values ('operator', 'Eski Ochirilgan', false, now())`;
      const before = await sql`select link_code from staff where full_name = any(${sql.array(allNames)}::text[])`;
      ok(before.length === 5 && before.every((r: any) => r.link_code === null), 'boshida havola nomi yo\'q');
      await sql`update settings set value = 'eski' where key = 'schema_version'`;

      await migrate();

      const rows = await sql`select full_name, link_code from staff where full_name = any(${sql.array(legacy)}::text[]) order by id`;
      eq(
        JSON.stringify(rows.map((r: any) => r.link_code)),
        JSON.stringify(['aziza2', 'aziza3', 'ulugbek', 'xodim']),
        "berilgan nomlar (aziza band — aziza2, kirill — lotinlashtirildi, tutuq olib tashlandi, emoji — xodim)",
      );
      eq((await sql`select link_code from staff where full_name = 'Eski Ochirilgan'`)[0]?.link_code, null, "o'chirilgan xodimga nom berilmadi");
      eq((await sql`select value from settings where key = 'schema_version'`)[0]?.value, SCHEMA_VERSION, 'sxema versiyasi yozildi');
      // Mavjud xodimlarning nomlari o'zgarmadi
      eq((await staffRow(ids.aziza)).link_code, 'aziza', "mavjud nom o'zgarmadi");
      eq((await staffRow(ids.bobur)).link_code, 'bobur', "mavjud nom o'zgarmadi (bobur)");
    } finally {
      await sql`delete from staff where full_name = any(${sql.array(allNames)}::text[])`;
    }
  });
}

async function clientBotTests(): Promise<void> {
  await step("mijoz: /start — BITTA xabar (qisqa salomlashuv + [Operatorlar] [Menejerlar]), doimiy klaviatura va Mini App yo'q", async () => {
    const before = mark('client', C1.id);
    await say('client', C1, '/start');
    const msgs = botMsgsSince('client', C1.id, before);
    eq(msgs.length, 1, 'bitta xabar');
    eq(msgs[0]!.text, "Assalomu alaykum, Ali! 👋\n\nKim bilan bog'lanmoqchisiz? Quyidan tanlang 👇", 'salomlashuv');
    eq(msgs[0]!.text, welcomeFor('Ali'), 'DEFAULT_WELCOME');
    ok(isRoleRowOnly(msgs[0]), `faqat rol tugmalari: ${JSON.stringify(msgs[0]!.markup)}`);
    ok(!msgs[0]!.buttons.some((b) => b.web_app), "web_app tugmasi yo'q");
    eq(tg.keyboard(CLIENT, C1.id), null, "doimiy (reply) klaviatura yuborilmadi");
    const row = await clientRow(C1.id);
    eq(row?.first_name, 'Ali', 'mijoz bazada');
    eq(row?.username, 'ali_v', 'username');
    eq(row?.legacy_keyboard, false, "yangi mijozda eski menyu belgisi yo'q");
  });

  await step('mijoz: /help, /menu, noma\'lum buyruq, guruh chatlari e\'tiborsiz', async () => {
    let before = mark('client', C1.id);
    await say('client', C1, '/help');
    const help = botMsgsSince('client', C1.id, before);
    eq(help.length, 1, 'bitta yordam xabari');
    eq(help[0]!.text, HELP_TEXT, 'qisqa yordam');
    includes(help[0]!.text, 'Botdan qanday foydalaniladi', 'yordam');
    ok(isRemoveKeyboardOnly(help[0]), `yordam — klaviaturasiz (remove_keyboard): ${JSON.stringify(help[0]!.markup)}`);
    before = mark('client', C1.id);
    await say('client', C1, 'ℹ️ Yordam');
    includes(textsSince('client', C1.id, before), 'Botdan qanday foydalaniladi', 'eski «ℹ️ Yordam» tugmasi ham ishlaydi');
    before = mark('client', C1.id);
    await say('client', C1, '/menu');
    const menuMsgs = botMsgsSince('client', C1.id, before);
    eq(menuMsgs.length, 1, '/menu — bitta xabar');
    const menu = menuMsgs[0];
    eq(menu?.text, welcomeFor('Ali'), '/menu — /start bilan bir xil');
    excludes(menu?.text, 'Asosiy menyu', "eski «Asosiy menyu» yo'q");
    ok(isRoleRowOnly(menu), `/menu tugmalari: ${JSON.stringify(menu?.markup)}`);
    ok(!findButton(menu, 'chats'), "«💬 Suhbatlarim» tugmasi yo'q");
    before = mark('client', C1.id);
    const cmdStart = tg.calls.length;
    const cmdMsgs = (await sql`select count(*)::int as n from messages`)[0]!.n;
    await say('client', C1, '/foo bar');
    const cmd = botMsgsSince('client', C1.id, before);
    eq(cmd.length, 1, "noma'lum buyruq — bitta javob");
    eq(cmd[0]!.text, UNKNOWN_COMMAND_TEXT, "noma'lum buyruq matni");
    eq(cmd[0]!.markup, undefined, "noma'lum buyruq — tugmasiz");
    eq(callsSince(cmdStart, STAFF).length, 0, 'buyruq xodimga yuborilmadi');
    eq((await sql`select count(*)::int as n from messages`)[0]!.n, cmdMsgs, 'buyruq saqlanmadi');
    eq((await sql`select count(*)::int as n from user_state where bot = 'client' and tg_user_id = ${C1.id}`)[0]!.n, 0, 'buyruq saqlab qo\'yilmadi');
    before = mark('client', C1.id);
    await say('client', C1, 'Hali hech kimni tanlamadim');
    const chooseText = textsSince('client', C1.id, before);
    includes(chooseText, 'Avval kim bilan yozishmoqchi ekaningizni tanlang', 'tanlanmagan');
    includes(chooseText, "saqlab qo'yildi", 'xabar tanlovgacha saqlab qo\'yildi');
    // Saqlangan xabar 30 daqiqa amal qiladi (HELD_TTL). Muddatini o'tkazib yuboramiz: keyingi tanlovda u
    // yuborilmasligi kerak (tanlovda yetkazish alohida qadamda — yangi mijoz bilan tekshiriladi)
    const heldRows = await sql`
      update user_state set updated_at = now() - interval '31 minutes'
      where bot = 'client' and tg_user_id = ${C1.id} and jsonb_typeof(state -> 'held') = 'array'
      returning 1`;
    eq(heldRows.length, 1, 'saqlangan xabar user_state da');

    const groupUser: TUser = { id: 5999, is_bot: false, first_name: 'Guruh' };
    const group = { id: -1001234567, type: 'supergroup', title: 'Guruh' };
    const start = tg.calls.length;
    await say('client', groupUser, { text: '/start', chat: group });
    await say('staff', groupUser, { text: '/start', chat: group });
    eq(callsSince(start).filter((c) => /^send|^edit/i.test(c.method)).length, 0, 'guruhga javob yuborilmadi');
    eq(await clientRow(groupUser.id), undefined, 'guruhdagi foydalanuvchi mijoz sifatida yozilmadi');
  });

  await step('mijoz: operatorlar ro\'yxati (HTML escape), menejerlarga o\'tish (tahrir)', async () => {
    await say('client', C1, '👨‍💻 Operatorlar');
    const list = lastBot('client', C1.id);
    includes(list?.text, 'Operatorlarimiz', 'sarlavha');
    includes(list?.text, 'Aziza Karimova — Katta operator', 'Aziza');
    includes(list?.text, "Buyurtma <b>va</b> to'lov & yetkazish", 'tavsif escape qilingan');
    includes(list?.text, 'Sardor Qodirov', 'Sardor');
    excludes(list?.text, 'Bobur', 'menejer operatorlar ro\'yxatida emas');
    ok(findButton(list, `card:${ids.aziza}`) && findButton(list, `card:${ids.sardor}`), 'karta tugmalari');
    ok(!list!.buttons.some((b) => b.web_app), "«📱 Menyuda ko'rish» (web_app) tugmasi yo'q");
    // ls:<role> callback (asosiy menyu tugmasi) shu xabarning o'zida tahrirlanadi
    await forge('client', C1, list!, 'ls:manager');
    const edited = tg.message(CLIENT, C1.id, list!.id);
    includes(edited?.text, 'Menejerlarimiz', 'joyida tahrirlandi');
    includes(edited?.text, 'Bobur Aliyev', 'Bobur');
    ok(findButton(edited, `card:${ids.bobur}`), 'Bobur kartasi tugmasi');
  });

  await step('mijoz: rasm kartasi — staff bot rasmi mijoz botiga qayta yuklanadi va keshlanadi', async () => {
    await say('client', C1, '/operators');
    const list = lastBot('client', C1.id);
    const start = tg.calls.length;
    await press('client', C1, list, `card:${ids.aziza}`);
    const card = lastBot('client', C1.id);
    eq(card?.kind, 'photo', 'rasmli karta');
    includes(card?.text, 'Aziza Karimova', 'ism');
    includes(card?.text, '👨‍💻 Operator · Katta operator', 'rol va lavozim');
    includes(card?.text, "Buyurtma <b>va</b> to'lov & yetkazish", 'tavsif (escape)');
    includes(card?.text, 'Onlayn', 'holat');
    const send = callsSince(start, CLIENT, 'sendPhoto')[0];
    ok(send?.multipart, 'birinchi marta — fayl yuklanadi (multipart)');
    ok(bytesEqual(tg.fileBytes(send!.uploaded[0]!), AZIZA_JPEG), 'yuklangan baytlar staff rasmi bilan bir xil');
    eq(callsSince(start, STAFF, 'getFile').length, 1, 'staff botdan yuklab olindi');
    const cached = (await staffRow(ids.aziza)).client_photo_file_id;
    eq(cached, send!.uploaded[0], 'client_photo_file_id keshlandi');
    ok(String(cached).startsWith('F_111111_'), 'mijoz botining file_id si');
    ok(findButton(card, `nav:${ids.aziza}:prev`) && findButton(card, `nav:${ids.aziza}:next`), 'karusel tugmalari');
    ok(findButton(card, '1/2'), 'hisoblagich 1/2');
    ok(findButton(card, `pick:${ids.aziza}`) && findButton(card, 'ls:operator'), 'Yozish va Ro\'yxat');

    const start2 = tg.calls.length;
    await press('client', C1, list, `card:${ids.aziza}`);
    const send2 = callsSince(start2, CLIENT, 'sendPhoto')[0];
    ok(send2 && !send2.multipart && send2.params.photo === cached, 'ikkinchi marta — keshlangan file_id');
    eq(callsSince(start2, STAFF, 'getFile').length, 0, 'qayta yuklab olinmadi');
  });

  await step('mijoz: yaroqsiz keshlangan file_id — tozalanadi va qayta yuklanadi', async () => {
    const bogus = 'F_111111_999999';
    await sql`update staff set client_photo_file_id = ${bogus} where id = ${ids.aziza}`;
    const list = lastBot('client', C1.id);
    const start = tg.calls.length;
    await say('client', C1, '/operators');
    await press('client', C1, lastBot('client', C1.id), `card:${ids.aziza}`);
    const photos = callsSince(start, CLIENT, 'sendPhoto');
    eq(photos.length, 2, 'avval kesh, keyin yuklash');
    eq(photos[0]!.ok, false, 'yaroqsiz file_id rad etildi');
    ok(photos[1]!.ok && photos[1]!.multipart, 'qayta yuklandi');
    const now = (await staffRow(ids.aziza)).client_photo_file_id;
    ok(now && now !== bogus && now === photos[1]!.uploaded[0], 'yangi file_id keshlandi');
    ok(list, 'ro\'yxat');
  }, { allowFailedCalls: (c) => c.method === 'sendPhoto' && c.params.photo === 'F_111111_999999' });

  await step('mijoz: rasmsiz xodim — standart avatar yuklanadi va sozlamada keshlanadi', async () => {
    await say('client', C1, '/managers');
    const list = lastBot('client', C1.id);
    const start = tg.calls.length;
    await press('client', C1, list, `card:${ids.bobur}`);
    const send = callsSince(start, CLIENT, 'sendPhoto')[0];
    ok(send?.ok && send.multipart, 'avatar yuklandi');
    ok(bytesEqual(tg.fileBytes(send!.uploaded[0]!), placeholderJpeg()), 'standart avatar baytlari');
    const setting = (await sql`select value from settings where key = ${texts.SETTING_KEYS.placeholderPhoto}`)[0];
    eq(setting?.value, send!.uploaded[0], 'avatar file_id sozlamada');
    const card = lastBot('client', C1.id);
    ok(!findButton(card, '1/1'), 'yagona menejer — karusel qatori yo\'q');
    includes(card?.text, '👔 Menejer', 'rol');

    const start2 = tg.calls.length;
    await press('client', C1, list, `card:${ids.bobur}`);
    const send2 = callsSince(start2, CLIENT, 'sendPhoto')[0];
    ok(send2?.ok && !send2.multipart && send2.params.photo === setting.value, 'keshlangan avatar ishlatildi');
  });

  await step('mijoz: karusel (editMessageMedia, aylanma) va tahrir xatosida yangi karta', async () => {
    await say('client', C1, '/operators');
    await press('client', C1, lastBot('client', C1.id), `card:${ids.aziza}`);
    const card = lastBot('client', C1.id)!;
    let start = tg.calls.length;
    await press('client', C1, card, `nav:${ids.aziza}:next`);
    const edit = callsSince(start, CLIENT, 'editMessageMedia')[0];
    ok(edit?.ok, 'editMessageMedia');
    let now = tg.message(CLIENT, C1.id, card.id);
    includes(now?.text, 'Sardor Qodirov', 'keyingi xodim');
    ok(findButton(now, '2/2'), 'hisoblagich 2/2');
    ok(edit!.multipart, 'Sardor rasmi birinchi marta yuklandi');
    ok(bytesEqual(tg.fileBytes(edit!.uploaded[0]!), SARDOR_JPEG), 'Sardor rasmi baytlari');

    start = tg.calls.length;
    await press('client', C1, now, `nav:${ids.sardor}:next`);
    now = tg.message(CLIENT, C1.id, card.id);
    includes(now?.text, 'Aziza Karimova', 'aylanib birinchisiga qaytdi');
    ok(findButton(now, '1/2'), 'hisoblagich 1/2');
    ok(!callsSince(start, CLIENT, 'editMessageMedia')[0]!.multipart, 'keshlangan rasm');
    await press('client', C1, now, `nav:${ids.aziza}:prev`);
    includes(tg.message(CLIENT, C1.id, card.id)?.text, 'Sardor Qodirov', 'orqaga ham aylanadi');

    tg.failNext(CLIENT, 'editMessageMedia', { error_code: 400, description: 'Bad Request: message to edit not found' });
    const before = mark('client', C1.id);
    await press('client', C1, tg.message(CLIENT, C1.id, card.id), `nav:${ids.sardor}:next`);
    const fresh = botMsgsSince('client', C1.id, before);
    eq(fresh.length, 1, 'yangi karta yuborildi');
    includes(fresh[0]!.text, 'Aziza Karimova', 'yangi kartada keyingi xodim');
  }, { allowFailedCalls: (c) => c.method === 'editMessageMedia' });

  await step("mijoz: «✍️ Yozish» — suhbat yaratiladi va aktiv bo'ladi; tasdiq qisqa, tugmasiz, eski klaviatura olib tashlanadi", async () => {
    const card = lastBot('client', C1.id);
    const before = mark('client', C1.id);
    const q = await press('client', C1, card, `pick:${ids.aziza}`);
    eq(answerOf(q).text, '✅ Tanlandi', 'callback javobi');
    const got = botMsgsSince('client', C1.id, before);
    eq(got.length, 1, 'bitta tasdiq xabari');
    const m = got[0];
    eq(m?.text, "✅ Siz Aziza Karimova (Operator) bilan bog'landingiz.\n✍️ Savolingizni yozing.", 'tanlash xabari');
    ok(boldName(m, 'Aziza Karimova'), 'xodim ismi qalin');
    ok(isRemoveKeyboardOnly(m), `remove_keyboard, inline tugmasiz («📜 Suhbat tarixi» yo'q): ${JSON.stringify(m?.markup)}`);
    const conv = await convOf(C1.id, ids.aziza);
    ok(conv, 'suhbat yaratildi');
    convs.c1aziza = conv.id;
    eq((await clientRow(C1.id)).active_conversation_id, conv.id, 'aktiv suhbat');
    eq(conv.last_message_at, null, 'hali xabar yo\'q');
  });

  await step('birinchi xabar: avto-javob bir marta, xodimga 🆕 sarlavha va «↩️ Javob berish» bilan', async () => {
    const clientBefore = mark('client', C1.id);
    const staffBefore = mark('staff', OP1.id);
    const text = 'Salom! Buyurtmam qayerda? <tag> & 😀';
    await say('client', C1, text);
    const toClient = botMsgsSince('client', C1.id, clientBefore);
    eq(toClient.length, 1, 'mijozga faqat avto-javob');
    const expectedGreeting = texts.fill(texts.DEFAULT_GREETING, { name: 'Ali', staff: 'Aziza Karimova' });
    eq(toClient[0]!.text, expectedGreeting, 'avto-javob matni');
    const toStaff = botMsgsSince('staff', OP1.id, staffBefore);
    eq(toStaff.length, 1, 'xodimga bitta xabar');
    const head = `🆕 ${HEADER_C1}`;
    eq(toStaff[0]!.text, `${head} · @ali_v\n${text}`, 'xodimdagi matn');
    ok(hasBold(toStaff[0], 0, head.length), `sarlavha bold (UTF-16): ${JSON.stringify(entitiesOf(toStaff[0]))}`);
    ok(findButton(toStaff[0], `act:${convs.c1aziza}`), '«↩️ Javob berish» tugmasi');
    relayed.c1first = toStaff[0]!.id;
    const conv = await convRow(convs.c1aziza);
    eq(conv.auto_replied, true, 'auto_replied');
    eq(conv.unread_staff, 1, 'unread_staff');
    eq(conv.last_sender, 'client', 'last_sender');
    eq(await countMessages(convs.c1aziza, 'bot'), 1, 'bitta avto-javob saqlandi');
    const saved = (await sql`select * from messages where conversation_id = ${convs.c1aziza} and sender = 'client'`)[0];
    eq(saved.text, text, 'mijoz xabari saqlandi');
    eq(Number(saved.staff_chat_id), OP1.id, 'staff_chat_id');
    eq(Number(saved.staff_chat_msg_id), relayed.c1first, 'staff_chat_msg_id');
  });

  await step('ikkinchi xabar: avto-javob qayta yuborilmaydi, 🆕 yo\'q', async () => {
    const clientBefore = mark('client', C1.id);
    const staffBefore = mark('staff', OP1.id);
    await say('client', C1, 'Yana bir savol');
    eq(botMsgsSince('client', C1.id, clientBefore).length, 0, 'mijozga hech narsa yuborilmadi');
    const toStaff = botMsgsSince('staff', OP1.id, staffBefore);
    eq(toStaff.length, 1, 'xodimga yetkazildi');
    eq(toStaff[0]!.text, `${HEADER_C1} · @ali_v\nYana bir savol`, 'matn (🆕 siz)');
    relayed.c1second = toStaff[0]!.id;
    eq(await countMessages(convs.c1aziza, 'bot'), 1, 'avto-javob hali ham bitta');
    eq((await convRow(convs.c1aziza)).unread_staff, 2, 'unread_staff = 2');
  });

  await step('xodim Reply orqali javob beradi — to\'g\'ri mijozga, sarlavha bilan, 👍 reaksiya', async () => {
    const clientBefore = mark('client', C1.id);
    const reply = "Buyurtmangiz yo'lda 🚚 <b>ertaga</b>";
    const msg = await say('staff', OP1, { text: reply, replyTo: relayed.c1first });
    inStaff.azizaReplyOwn = msg.message_id;
    const toClient = botMsgsSince('client', C1.id, clientBefore);
    eq(toClient.length, 1, 'mijozga bitta xabar');
    eq(toClient[0]!.text, `${HEADER_AZIZA}\n${reply}`, 'mijozdagi matn');
    ok(hasBold(toClient[0], 0, HEADER_AZIZA.length), 'xodim sarlavhasi bold');
    inClient.azizaReply = toClient[0]!.id;
    ok(tg.reactions(STAFF, OP1.id, msg.message_id).includes('👍'), '👍 reaksiya');
    eq((await staffRow(ids.aziza)).active_conversation_id, convs.c1aziza, 'Reply suhbatni aktiv qiladi');
    const conv = await convRow(convs.c1aziza);
    eq(conv.unread_staff, 0, 'xodim javob berdi — unread_staff = 0');
    eq(conv.unread_client, 1, 'unread_client = 1');
    const saved = (await sql`select * from messages where conversation_id = ${convs.c1aziza} and sender = 'staff'`)[0];
    eq(Number(saved.client_chat_msg_id), inClient.azizaReply, 'client_chat_msg_id');
  });

  await step('xodim «↩️ Javob berish» tugmasi va aktiv suhbat orqali yozadi', async () => {
    const relayedMsg = tg.message(STAFF, OP1.id, relayed.c1second);
    const q = await press('staff', OP1, relayedMsg, `act:${convs.c1aziza}`);
    eq(answerOf(q).text, '✍️ Endi javobingiz shu mijozga boradi', 'callback javobi');
    const note = lastBot('staff', OP1.id);
    includes(note?.text, 'Aktiv suhbat: Ali Valiyev', 'aktiv suhbat xabari');
    eq((note?.message as any)?.reply_to_message?.message_id, relayed.c1second, 'tugma xabariga reply');
    const clientBefore = mark('client', C1.id);
    await say('staff', OP1, 'Yana nimadir kerakmi?');
    const toClient = botMsgsSince('client', C1.id, clientBefore);
    eq(toClient.length, 1, 'mijozga yetkazildi');
    eq(toClient[0]!.text, `${HEADER_AZIZA}\nYana nimadir kerakmi?`, 'matn');
  });

  await step("ikkinchi mijoz: eski deep link (/start staff_<id>) — tanlovsiz darhol suhbat; izolyatsiya — Reply faqat o'sha mijozga boradi", async () => {
    const before = mark('client', C2.id);
    await say('client', C2, `/start staff_${ids.aziza}`);
    const msgs = botMsgsSince('client', C2.id, before);
    eq(msgs.length, 1, 'bitta xabar (salomlashuv va menyusiz)');
    eq(msgs[0]!.kind, 'photo', 'xodim rasmi bilan');
    eq(
      msgs[0]!.text,
      linkCaption({ client: 'Vali', staff: 'Aziza Karimova', role: '👨‍💻 Operator · Katta operator' }),
      'izoh',
    );
    ok(isRemoveKeyboardOnly(msgs[0]), `remove_keyboard, tugmasiz: ${JSON.stringify(msgs[0]!.markup)}`);
    const c2conv = await convOf(C2.id, ids.aziza);
    ok(c2conv, 'suhbat darhol yaratildi');
    eq((await clientRow(C2.id)).active_conversation_id, c2conv.id, 'aktiv suhbat (tanlovsiz)');
    const staffBefore = mark('staff', OP1.id);
    const c2Before = mark('client', C2.id);
    await say('client', C2, 'Men Vali, salom');
    const auto = botMsgsSince('client', C2.id, c2Before);
    eq(auto.length, 1, 'C2 ga avto-javob');
    ok(auto[0]!.text.startsWith('Assalomu alaykum, Vali!'), 'C2 avto-javobi');
    const toStaff = botMsgsSince('staff', OP1.id, staffBefore);
    eq(toStaff[0]?.text, '🆕 👤 Vali\nMen Vali, salom', 'xodimga C2 xabari');
    relayed.c2first = toStaff[0]!.id;
    convs.c2aziza = (await convOf(C2.id, ids.aziza)).id;
    ok(findButton(toStaff[0], `act:${convs.c2aziza}`), 'C2 act tugmasi');

    const c1Mark = mark('client', C1.id);
    const c2Mark = mark('client', C2.id);
    await say('staff', OP1, { text: 'Ali uchun javob', replyTo: relayed.c1second });
    eq(botMsgsSince('client', C1.id, c1Mark).map((m) => m.text).join('|'), `${HEADER_AZIZA}\nAli uchun javob`, 'C1 oldi');
    eq(botMsgsSince('client', C2.id, c2Mark).length, 0, 'C2 hech narsa olmadi');

    const c1Mark2 = mark('client', C1.id);
    await say('staff', OP1, { text: 'Vali uchun javob', replyTo: relayed.c2first });
    eq(botMsgsSince('client', C2.id, c2Mark).map((m) => m.text).join('|'), `${HEADER_AZIZA}\nVali uchun javob`, 'C2 oldi');
    eq(botMsgsSince('client', C1.id, c1Mark2).length, 0, 'C1 hech narsa olmadi');
    eq((await staffRow(ids.aziza)).active_conversation_id, convs.c2aziza, 'aktiv — C2');
    await say('staff', OP1, 'Vali, yana savol bormi?');
    eq(botMsgsSince('client', C2.id, c2Mark).length, 2, 'aktiv suhbat — C2 ga');
    eq(botMsgsSince('client', C1.id, c1Mark2).length, 0, 'C1 ga emas');
  });

  await step('xodimlar boti: «💬 Chatlar», suhbatni ochish (transkript), mijoz haqida', async () => {
    await say('staff', OP1, '💬 Chatlar');
    const list = lastBot('staff', OP1.id);
    includes(list?.text, 'Chatlaringiz (2)', 'sarlavha');
    includes(list?.text, 'Aktiv: Vali', 'aktiv mijoz');
    ok(findButton(list, `open:${convs.c1aziza}`) && findButton(list, `open:${convs.c2aziza}`), 'suhbat tugmalari');
    const q = await press('staff', OP1, list, `open:${convs.c1aziza}`);
    ok(answerOf(q), 'callback javobi');
    const tr = lastBot('staff', OP1.id);
    includes(tr?.text, 'Ali Valiyev', 'mijoz ismi');
    includes(tr?.text, 'Salom! Buyurtmam qayerda? <tag> & 😀', 'mijoz xabari (escape)');
    includes(tr?.text, '🤖 Avto-javob', 'avto-javob belgisi');
    includes(tr?.text, 'Siz', 'xodim xabarlari');
    includes(tr?.text, 'Endi yozgan xabarlaringiz Ali Valiyevga yuboriladi', 'footer');
    eq((await staffRow(ids.aziza)).active_conversation_id, convs.c1aziza, 'open — aktiv');
    eq((await convRow(convs.c1aziza)).unread_staff, 0, "o'qildi");
    await press('staff', OP1, tr, `cinfo:${convs.c1aziza}`);
    const info = lastBot('staff', OP1.id);
    includes(info?.text, 'Telegram ID: 5001', 'Telegram ID');
    includes(info?.text, '@ali_v', 'username');
    includes(info?.text, 'Xabarlar:', 'xabarlar soni');
    await press('staff', OP1, info, 'chats:0');
    includes(tg.message(STAFF, OP1.id, info!.id)?.text, 'Chatlaringiz', 'chats:0 — joyida tahrir');
  });

  await step('maxfiylik (bot): boshqa xodim/mijoz begona suhbatni ko\'ra olmaydi va yoza olmaydi', async () => {
    const msgCount = (await sql`select count(*)::int as n from messages`)[0]!.n;
    const anchor = lastBot('staff', OP2.id)!;
    const before = mark('staff', OP2.id);
    for (const data of [`open:${convs.c1aziza}`, `shist:${convs.c1aziza}:0`, `cinfo:${convs.c1aziza}`, `act:${convs.c1aziza}`]) {
      const q = await forge('staff', OP2, anchor, data);
      const a = answerOf(q);
      eq(a.show_alert, true, `${data}: alert`);
      includes(a.text, 'sizga tegishli emas', `${data}: rad etildi`);
    }
    const leaked = botMsgsSince('staff', OP2.id, before).map((m) => m.text).join('\n');
    excludes(leaked, 'Ali', 'begona suhbat mazmuni ko\'rinmasligi kerak');
    eq((await staffRow(ids.sardor)).active_conversation_id, null, 'OP2 aktiv suhbati o\'zgarmadi');
    inStaff.op2Unsent = (await say('staff', OP2, 'test xabar')).message_id;
    includes(lastBot('staff', OP2.id)?.text, 'Kimga javob berayotganingizni tanlang', 'aktiv suhbatsiz');
    eq((await sql`select count(*)::int as n from messages`)[0]!.n, msgCount, 'hech narsa saqlanmadi/yuborilmadi');

    const c2Anchor = lastBot('client', C2.id)!;
    const c2Before = mark('client', C2.id);
    for (const data of [`conv:${convs.c1aziza}`, `hist:${convs.c1aziza}:0`]) {
      const q = await forge('client', C2, c2Anchor, data);
      eq(answerOf(q).show_alert, true, `mijoz ${data}: alert`);
    }
    eq(botMsgsSince('client', C2.id, c2Before).length, 0, 'C2 ga transkript yuborilmadi');
    eq((await clientRow(C2.id)).active_conversation_id, convs.c2aziza, 'C2 aktiv suhbati o\'zgarmadi');

    const q = await forge('staff', OP1, lastBot('staff', OP1.id)!, `adm:s:${ids.aziza}`);
    eq(answerOf(q).show_alert, true, 'oddiy xodim admin tugmasini bosa olmaydi');
  });

  await step('media: mijoz → xodim (rasm qayta yuklanadi, file_id qayta ishlatilmaydi), hujjat, ovoz, stiker, joylashuv, kontakt', async () => {
    const sizes = tg.photo(CLIENT, CLIENT_JPEG);
    let start = tg.calls.length;
    let before = mark('staff', OP1.id);
    const photoMsg = await say('client', C1, { photo: sizes, caption: 'Mana chek' });
    inClient.c1photoOwn = photoMsg.message_id;
    const photoCall = callsSince(start, STAFF, 'sendPhoto')[0];
    ok(photoCall?.ok && photoCall.multipart, 'staff botga yuklandi (multipart)');
    ok(photoCall!.params.photo !== largestPhotoId(sizes), 'mijoz file_id si ishlatilmadi');
    ok(bytesEqual(tg.fileBytes(photoCall!.uploaded[0]!), CLIENT_JPEG), 'baytlar bir xil');
    const got = botMsgsSince('staff', OP1.id, before).pop();
    eq(got?.text, `${HEADER_C1} · @ali_v\nMana chek`, 'izoh + sarlavha');
    relayed.c1photo = got!.id;
    const saved = (await sql`select * from messages where conversation_id = ${convs.c1aziza} and kind = 'photo'`)[0];
    eq(saved.file_id_client, largestPhotoId(sizes), 'file_id_client');
    eq(saved.file_id_staff, photoCall!.uploaded[0], 'file_id_staff');

    start = tg.calls.length;
    await say('client', C1, {
      document: tg.document(CLIENT, new TextEncoder().encode('%PDF-1.4 test'), { file_name: 'hisobot "2026";.pdf', mime_type: 'application/pdf' }),
    });
    const doc = callsSince(start, STAFF, 'sendDocument')[0];
    ok(doc?.ok && doc.multipart, 'hujjat yuklandi');
    // Hujjat hujjatligicha qolsin (Telegram .mp3/.mp4 ni audio/video ga aylantirmasin)
    eq(doc!.params.disable_content_type_detection, true, 'disable_content_type_detection');
    const part = Object.values(doc!.files)[0];
    eq(part?.filename, 'hisobot _2026__.pdf', 'fayl nomi xavfsiz');

    start = tg.calls.length;
    await say('client', C1, { voice: tg.media(CLIENT, 'voice') });
    ok(callsSince(start, STAFF, 'sendVoice')[0]?.ok, 'ovozli xabar');

    start = tg.calls.length;
    await say('client', C1, { sticker: tg.media(CLIENT, 'sticker', fakeWebp(), { emoji: '😀' }) });
    ok(callsSince(start, STAFF, 'sendSticker')[0]?.ok, 'stiker');

    start = tg.calls.length;
    before = mark('staff', OP1.id);
    await say('client', C1, { location: { latitude: 41.311, longitude: 69.279 } });
    const loc = callsSince(start, STAFF, 'sendLocation')[0];
    ok(loc?.ok && Number(loc.params.latitude) === 41.311, 'joylashuv');
    eq(botMsgsSince('staff', OP1.id, before)[0]?.text, `${HEADER_C1} · @ali_v`, 'joylashuv sarlavhasi');

    start = tg.calls.length;
    await say('client', C1, { contact: { phone_number: '+998901234567', first_name: 'Karim' } });
    const contact = callsSince(start, STAFF, 'sendContact')[0];
    ok(contact?.ok && contact.params.phone_number === '+998901234567', 'kontakt');

    const cBefore = mark('client', C1.id);
    start = tg.calls.length;
    await say('client', C1, { poll: { id: 'p1', question: 'Qaysi?', options: [{ text: 'A', voter_count: 0 }], total_voter_count: 0, is_closed: false, is_anonymous: true, type: 'regular', allows_multiple_answers: false } });
    includes(botMsgsSince('client', C1.id, cBefore)[0]?.text, "Bu turdagi xabarni yuborib bo'lmaydi", 'so\'rovnoma qo\'llab-quvvatlanmaydi');
    eq(callsSince(start, STAFF).length, 0, 'xodimga hech narsa ketmadi');
    const kinds = (await sql`select kind from messages where conversation_id = ${convs.c1aziza} and sender = 'client' order by id`).map((r: any) => r.kind);
    for (const k of ['photo', 'document', 'voice', 'sticker', 'location', 'contact']) ok(kinds.includes(k), `${k} saqlandi`);
  });

  await step('media: xodim → mijoz (rasm mijoz botiga qayta yuklanadi)', async () => {
    const sizes = tg.photo(STAFF, STAFF_JPEG);
    const start = tg.calls.length;
    const before = mark('client', C1.id);
    await say('staff', OP1, { photo: sizes, caption: 'Qabul qilindi', replyTo: relayed.c1photo });
    const call = callsSince(start, CLIENT, 'sendPhoto')[0];
    ok(call?.ok && call.multipart, 'mijoz botiga yuklandi');
    ok(bytesEqual(tg.fileBytes(call!.uploaded[0]!), STAFF_JPEG), 'baytlar bir xil');
    eq(botMsgsSince('client', C1.id, before)[0]?.text, `${HEADER_AZIZA}\nQabul qilindi`, 'izoh');
  });

  await step("uzun xabar (sarlavha + matn > 4096): sarlavha 1-bo'lak bilan, keyingisi unga reply, formatlash saqlanadi", async () => {
    const body = 'A'.repeat(4000) + ' ' + 'B'.repeat(89);
    const before = mark('client', C1.id);
    await say('staff', OP1, { text: body, entities: [{ type: 'bold', offset: 4001, length: 89 }], replyTo: relayed.c1photo });
    const got = botMsgsSince('client', C1.id, before);
    eq(got.length, 2, "ikki bo'lak");
    eq(got[0]!.text, `${HEADER_AZIZA}\n${'A'.repeat(4000)}`, "1-bo'lak: sarlavha + matn boshi");
    ok(hasBold(got[0], 0, HEADER_AZIZA.length), `sarlavha bold: ${JSON.stringify(entitiesOf(got[0]))}`);
    eq(got[1]!.text, 'B'.repeat(89), "2-bo'lak (so'z chegarasida)");
    ok(hasBold(got[1], 0, 89), `formatlash saqlandi: ${JSON.stringify(entitiesOf(got[1]))}`);
    eq((got[1]!.message as any)?.reply_to_message?.message_id, got[0]!.id, "2-bo'lak 1-bo'lakka reply");
    eq(`${got[0]!.text.slice(HEADER_AZIZA.length + 1)} ${got[1]!.text}`, body, "matn to'liq");
    // Xodim mijoz rasmining nusxasiga Reply qildi — mijozda uning ASL rasmi iqtibos qilinadi (1-bo'lakda)
    eq((got[0]!.message as any)?.reply_to_message?.message_id, inClient.c1photoOwn, "1-bo'lak mijozning asl rasmini iqtibos qiladi");
  });

  await step("tahrir (xodim): matn va izoh mijozdagi nusxada yangilanadi; juda uzun / yetkazilmagan tahrir — ✏️ izoh; tahrirlangan buyruq qayta bajarilmaydi", async () => {
    // a) Matn: mijozdagi nusxa sarlavha va «↩️ Javob berish» tugmasi bilan joyida tahrirlanadi, ✍ reaksiya
    let before = mark('client', C1.id);
    const m = await say('staff', OP1, { text: 'Tahrir oldidan', replyTo: relayed.c1second });
    const cm = botMsgsSince('client', C1.id, before)[0];
    eq(cm?.text, `${HEADER_AZIZA}\nTahrir oldidan`, 'yetkazildi');
    let start = tg.calls.length;
    await edit('staff', OP1, m.message_id, { text: 'Tahrirdan keyin' });
    const cm2 = tg.message(CLIENT, C1.id, cm!.id);
    eq(cm2?.text, `${HEADER_AZIZA}\nTahrirdan keyin`, 'mijozdagi nusxa yangilandi');
    eq(cm2?.edits, 1, 'bir marta tahrirlandi');
    ok(hasBold(cm2, 0, HEADER_AZIZA.length), `sarlavha bold: ${JSON.stringify(entitiesOf(cm2))}`);
    ok(findButton(cm2, `to:${convs.c1aziza}`), '«↩️ Javob berish» tugmasi saqlandi');
    eq(callsSince(start, CLIENT).filter((c) => /^send/i.test(c.method)).length, 0, 'mijozga yangi xabar yuborilmadi');
    eq(botMsgsSince('client', C1.id, before).length, 1, "mijoz chatida yangi xabar yo'q");
    const row = (await sql`
      select text, edited_at from messages
      where sender = 'staff' and staff_chat_id = ${OP1.id} and staff_chat_msg_id = ${m.message_id}`)[0];
    eq(row?.text, 'Tahrirdan keyin', 'bazada yangilandi');
    ok(row?.edited_at, 'edited_at');
    ok(tg.reactions(STAFF, OP1.id, m.message_id).includes('✍'), '✍ reaksiya');

    // b) Izoh: editMessageCaption (rasm o'zgarmagan)
    before = mark('client', C1.id);
    const p = await say('staff', OP1, { photo: tg.photo(STAFF, STAFF_JPEG), caption: 'Izoh 1', replyTo: relayed.c1photo });
    const cp = botMsgsSince('client', C1.id, before)[0];
    eq(cp?.kind, 'photo', 'rasm yetkazildi');
    eq(cp?.text, `${HEADER_AZIZA}\nIzoh 1`, 'izoh');
    start = tg.calls.length;
    await edit('staff', OP1, p.message_id, { caption: 'Izoh 2' });
    eq(callsSince(start, CLIENT, 'editMessageCaption').length, 1, 'bitta editMessageCaption');
    eq(callsSince(start, CLIENT, 'editMessageMedia').length, 0, 'rasm qayta yuklanmadi');
    eq(tg.message(CLIENT, C1.id, cp!.id)?.text, `${HEADER_AZIZA}\nIzoh 2`, 'izoh yangilandi');
    ok(findButton(tg.message(CLIENT, C1.id, cp!.id), `to:${convs.c1aziza}`), 'tugma saqlandi');

    // c) Juda uzun tahrir (sarlavha bilan > 4096): mijozdagi nusxa o'zgarmaydi, xodimga izoh
    const clientTextBefore = tg.message(CLIENT, C1.id, cm!.id)?.text;
    let sb = mark('staff', OP1.id);
    start = tg.calls.length;
    await edit('staff', OP1, m.message_id, { text: 'x'.repeat(4096) });
    const longNote = botMsgsSince('staff', OP1.id, sb);
    eq(longNote.length, 1, 'bitta izoh');
    includes(longNote[0]!.text, 'matn juda uzun', 'uzun tahrir izohi');
    eq((longNote[0]!.message as any)?.reply_to_message?.message_id, m.message_id, 'izoh tahrirlangan xabarga reply');
    eq(tg.message(CLIENT, C1.id, cm!.id)?.text, clientTextBefore, "mijozdagi nusxa o'zgarmadi");
    eq(callsSince(start, CLIENT).length, 0, "mijoz botiga murojaat yo'q");
    eq((await sql`select text from messages where sender = 'staff' and staff_chat_id = ${OP1.id} and staff_chat_msg_id = ${m.message_id}`)[0]?.text, 'Tahrirdan keyin', "bazadagi matn o'zgarmadi");

    // d) Mijozga umuman yuborilmagan xabar (OP2 ning «test xabar»i) tahrirlandi — hech kimga yetkazilmaydi
    ok(inStaff.op2Unsent > 0, "OP2 ning saqlanmagan xabari");
    const op2Mark = mark('staff', OP2.id);
    start = tg.calls.length;
    await edit('staff', OP2, inStaff.op2Unsent, { text: 'test xabar (tahrir)' });
    includes(botMsgsSince('staff', OP2.id, op2Mark)[0]?.text, 'Tahrir hech kimga yetkazilmadi', 'saqlanmagan xabar tahriri');
    eq(callsSince(start, CLIENT).length, 0, 'mijozlarga hech narsa ketmadi');

    // e) Tahrirlangan buyruq / menyu tugmasi qayta bajarilmaydi
    const chats = await say('staff', OP1, '💬 Chatlar');
    includes(lastBot('staff', OP1.id)?.text, 'Chatlaringiz', "chatlar ro'yxati");
    sb = mark('staff', OP1.id);
    start = tg.calls.length;
    await edit('staff', OP1, chats.message_id, { text: '💬 Chatlar' });
    await edit('staff', OP1, chats.message_id, { text: '/start' });
    eq(botMsgsSince('staff', OP1.id, sb).length, 0, 'tahrirlangan buyruq qayta bajarilmadi');
    eq(callsSince(start).filter((c) => /^(send|edit|copy|forward)/i.test(c.method)).length, 0, "hech qaysi botga yuborish/tahrir yo'q");
    eq((await staffRow(ids.aziza)).active_conversation_id, convs.c1aziza, "aktiv suhbat o'zgarmadi");
  });

  await step("tahrir (mijoz): xodimdagi nusxa joyida (tugmasi bilan) yangilanadi; takror — o'zgarishsiz; uzun asl xabar — ✏️ bildirishnoma; jonli joylashuv — e'tiborsiz", async () => {
    // a) Oddiy matn: joyida tahrir, ikkinchi avto-javob yo'q, o'qilmaganlar oshmaydi
    let sb = mark('staff', OP1.id);
    const orig = await say('client', C1, 'Asl matn');
    const S = botMsgsSince('staff', OP1.id, sb)[0];
    eq(S?.text, `${HEADER_C1} · @ali_v\nAsl matn`, 'xodimga yetkazildi');
    const unreadBefore = (await convRow(convs.c1aziza)).unread_staff as number;
    let start = tg.calls.length;
    await edit('client', C1, orig.message_id, { text: 'Tuzatilgan matn' });
    const S2 = tg.message(STAFF, OP1.id, S!.id);
    eq(S2?.text, `${HEADER_C1} · @ali_v\nTuzatilgan matn`, 'xodimdagi nusxa yangilandi');
    eq(S2?.edits, 1, 'bir marta tahrirlandi');
    ok(hasBold(S2, 0, HEADER_C1.length), `sarlavha bold: ${JSON.stringify(entitiesOf(S2))}`);
    ok(findButton(S2, `act:${convs.c1aziza}`), '«↩️ Javob berish» tugmasi saqlandi');
    eq(botMsgsSince('staff', OP1.id, sb).length, 1, "xodimga yangi xabar yo'q");
    eq(callsSince(start, CLIENT).filter((c) => /^send/i.test(c.method)).length, 0, "mijozga hech narsa (ikkinchi avto-javob yo'q)");
    const row = (await sql`
      select text, edited_at from messages
      where conversation_id = ${convs.c1aziza} and sender = 'client' and client_chat_msg_id = ${orig.message_id}`)[0];
    eq(row?.text, 'Tuzatilgan matn', 'bazada yangilandi');
    ok(row?.edited_at, 'edited_at');
    eq((await convRow(convs.c1aziza)).unread_staff, unreadBefore, "o'qilmaganlar soni oshmadi");

    // b) Xuddi shu tahrir yana — o'zgarishsiz (Telegramga murojaat yo'q)
    start = tg.calls.length;
    await edit('client', C1, orig.message_id, { text: 'Tuzatilgan matn' });
    eq(tg.message(STAFF, OP1.id, S!.id)?.edits, 1, 'qayta tahrirlanmadi');
    eq(callsSince(start, STAFF).length, 0, "xodimlar botiga murojaat yo'q");
    eq(botMsgsSince('staff', OP1.id, sb).length, 1, "xodimga yangi xabar yo'q");

    // c) Uzun asl xabar (bo'laklab yuborilgan) — joyida emas, asl nusxaga reply qilingan ✏️ bildirishnoma
    sb = mark('staff', OP1.id);
    const longOrig = await say('client', C1, 'L'.repeat(4090));
    const chunks = botMsgsSince('staff', OP1.id, sb);
    eq(chunks.length, 2, "ikki bo'lak");
    const lrow = (await sql`
      select staff_chat_msg_id from messages
      where conversation_id = ${convs.c1aziza} and sender = 'client' and client_chat_msg_id = ${longOrig.message_id}`)[0];
    ok(lrow?.staff_chat_msg_id, 'yetkazilgan');
    sb = mark('staff', OP1.id);
    await edit('client', C1, longOrig.message_id, { text: 'L'.repeat(4000) + ' qisqa' });
    const notice = botMsgsSince('staff', OP1.id, sb);
    eq(notice.length, 1, 'bitta bildirishnoma');
    ok(notice[0]!.text.startsWith(`✏️ ${HEADER_C1}`), `bildirishnoma sarlavhasi: ${notice[0]!.text.slice(0, 60)}`);
    includes(notice[0]!.text, 'xabar tahrirlandi', 'bildirishnoma');
    ok(notice[0]!.text.endsWith(' qisqa'), 'yangi matn');
    eq((notice[0]!.message as any)?.reply_to_message?.message_id, Number(lrow.staff_chat_msg_id), 'asl nusxaga reply');
    ok(findButton(notice[0], `act:${convs.c1aziza}`), 'bildirishnomada «↩️ Javob berish»');
    ok(chunks.every((c) => tg.message(STAFF, OP1.id, c.id)?.edits === 0), "asl bo'laklar tahrirlanmadi");

    // d) Jonli joylashuv yangilanishi — tahrir emas: xodimga hech narsa, bazada o'zgarish yo'q
    const live = await say('client', C1, { location: { latitude: 41.3, longitude: 69.2, live_period: 60 } });
    const liveBefore = (await sql`
      select meta, edited_at from messages
      where conversation_id = ${convs.c1aziza} and sender = 'client' and client_chat_msg_id = ${live.message_id}`)[0];
    ok(liveBefore, 'joylashuv saqlandi');
    start = tg.calls.length;
    await edit('client', C1, live.message_id, { location: { latitude: 41.31, longitude: 69.21, live_period: 60 } });
    eq(callsSince(start, STAFF).length, 0, "jonli joylashuv — xodimga hech narsa ketmadi");
    const liveAfter = (await sql`
      select meta, edited_at from messages
      where conversation_id = ${convs.c1aziza} and sender = 'client' and client_chat_msg_id = ${live.message_id}`)[0];
    eq(JSON.stringify(liveAfter?.meta), JSON.stringify(liveBefore.meta), "meta o'zgarmadi");
    eq(liveAfter?.edited_at, null, 'edited_at yozilmadi');
  });

  await step("xodim: alohida sarlavhaga Reply — o'sha mijozga (aktivga emas); aniqlanmagan Reply — «❓ Bu xabar kimga?»", async () => {
    eq((await staffRow(ids.aziza)).active_conversation_id, convs.c1aziza, "boshlang'ich aktiv suhbat — C1");

    // 1) C2 stiker yuboradi: xodim chatida sarlavha ALOHIDA matn xabari (tugmasiz), stiker unga reply
    let staffBefore = mark('staff', OP1.id);
    await say('client', C2, { sticker: tg.media(CLIENT, 'sticker', fakeWebp(), { emoji: '🙂' }) });
    const c2Sticker = botMsgsSince('staff', OP1.id, staffBefore);
    const c2Header = c2Sticker.find((m) => m.kind === 'text');
    eq(c2Header?.text, '👤 Vali', 'stiker sarlavhasi');
    eq(c2Header!.buttons.length, 0, "sarlavhada tugma yo'q (faqat message_links orqali topiladi)");
    ok(c2Sticker.some((m) => m.kind === 'sticker' && findButton(m, `act:${convs.c2aziza}`)), 'stiker «↩️ Javob berish» bilan');

    // 2) Aktiv suhbat C1, lekin C2 sarlavhasiga Reply — faqat C2 ga
    let c1Mark = mark('client', C1.id);
    let c2Mark = mark('client', C2.id);
    const r1 = await say('staff', OP1, { text: 'Vali, stikeringiz yetib keldi', replyTo: c2Header!.id });
    eq(botMsgsSince('client', C2.id, c2Mark).map((m) => m.text).join('|'), `${HEADER_AZIZA}\nVali, stikeringiz yetib keldi`, 'C2 oldi');
    eq(botMsgsSince('client', C1.id, c1Mark).length, 0, 'C1 (aktiv) hech narsa olmadi');
    ok(tg.reactions(STAFF, OP1.id, r1.message_id).includes('👍'), '👍 reaksiya');
    eq((await staffRow(ids.aziza)).active_conversation_id, convs.c2aziza, 'aktiv — C2');

    // 3) C1 joylashuv yuboradi; aktiv — C2, lekin C1 joylashuv sarlavhasiga Reply — faqat C1 ga
    staffBefore = mark('staff', OP1.id);
    await say('client', C1, { location: { latitude: 41.3, longitude: 69.2 } });
    const c1Header = botMsgsSince('staff', OP1.id, staffBefore).find((m) => m.kind === 'text');
    eq(c1Header?.text, `${HEADER_C1} · @ali_v`, 'joylashuv sarlavhasi');
    eq(c1Header!.buttons.length, 0, "sarlavhada tugma yo'q");
    c1Mark = mark('client', C1.id);
    c2Mark = mark('client', C2.id);
    await say('staff', OP1, { text: 'Ali, manzilingizni oldim', replyTo: c1Header!.id });
    eq(botMsgsSince('client', C1.id, c1Mark).map((m) => m.text).join('|'), `${HEADER_AZIZA}\nAli, manzilingizni oldim`, 'C1 oldi');
    eq(botMsgsSince('client', C2.id, c2Mark).length, 0, 'C2 (aktiv) hech narsa olmadi');
    eq((await staffRow(ids.aziza)).active_conversation_id, convs.c1aziza, 'aktiv — C1');

    // 4) Hech bir suhbatga bog'lanmagan bot xabariga Reply — hech kimga yuborilmaydi va saqlanmaydi, so'raladi
    const welcome = tg.sent(STAFF, OP1.id).find((m) => m.text.includes('Tabriklaymiz'));
    ok(welcome && !welcome.buttons.some((b) => b.callback_data), 'tugmasiz bot xabari');
    const msgCount = (await sql`select count(*)::int as n from messages`)[0]!.n;
    const start = tg.calls.length;
    const orphan = await say('staff', OP1, { text: 'Bu javob kimga ketadi?', replyTo: welcome!.id });
    eq(callsSince(start, CLIENT).filter((c) => /^(send|copy|forward)/i.test(c.method)).length, 0, 'mijozlarga hech narsa yuborilmadi');
    eq((await sql`select count(*)::int as n from messages`)[0]!.n, msgCount, 'hech narsa saqlanmadi');
    eq(tg.reactions(STAFF, OP1.id, orphan.message_id).length, 0, "👍 yo'q");
    const ask = lastBot('staff', OP1.id);
    includes(ask?.text, 'Bu xabar kimga?', "so'rov");
    eq((ask?.message as any)?.reply_to_message?.message_id, orphan.message_id, "so'rov xodim xabariga reply");
    ok(findButton(ask, `to:${convs.c1aziza}`) && findButton(ask, `to:${convs.c2aziza}`), 'nomzodlar');
    eq((await staffRow(ids.aziza)).active_conversation_id, convs.c1aziza, "aktiv suhbat o'zgarmadi");

    // 5) Tanlov: xabar aynan tanlangan C2 ga ketadi; tasdiq xabari shu suhbatga bog'lanadi (✖️ Aktivni yopish)
    c1Mark = mark('client', C1.id);
    c2Mark = mark('client', C2.id);
    const q = await press('staff', OP1, ask, `to:${convs.c2aziza}`);
    eq(answerOf(q).text, '✅ Yuborildi', 'callback javobi');
    eq(botMsgsSince('client', C2.id, c2Mark).map((m) => m.text).join('|'), `${HEADER_AZIZA}\nBu javob kimga ketadi?`, 'tanlangan mijoz oldi');
    eq(botMsgsSince('client', C1.id, c1Mark).length, 0, 'C1 olmadi');
    const confirm = tg.message(STAFF, OP1.id, ask!.id);
    includes(confirm?.text, 'yuborildi', 'tasdiq');
    ok(findButton(confirm, `deact:${convs.c2aziza}`), "tasdiq suhbatga bog'langan");

    // 6) Aktivni C1 ga qaytaramiz, keyin tasdiq xabariga Reply — aktiv C1 bo'lsa ham C2 ga
    await say('staff', OP1, { text: 'Ali, yana bir savol', replyTo: c1Header!.id });
    eq((await staffRow(ids.aziza)).active_conversation_id, convs.c1aziza, 'aktiv — C1');
    c1Mark = mark('client', C1.id);
    c2Mark = mark('client', C2.id);
    await say('staff', OP1, { text: 'Vali, tasdiqqa javob', replyTo: confirm!.id });
    eq(botMsgsSince('client', C2.id, c2Mark).map((m) => m.text).join('|'), `${HEADER_AZIZA}\nVali, tasdiqqa javob`, 'tasdiq orqali — C2');
    eq(botMsgsSince('client', C1.id, c1Mark).length, 0, 'C1 olmadi');
    eq((await staffRow(ids.aziza)).active_conversation_id, convs.c2aziza, 'aktiv — C2');
  });

  await step("xodim: uzun izoh davomiga va uzun matnning 1-bo'lagiga Reply — o'sha mijozga (aktivga emas)", async () => {
    eq((await staffRow(ids.aziza)).active_conversation_id, convs.c2aziza, "boshlang'ich aktiv — C2");

    // a) Rasm + ~1020 belgili izoh: rasm faqat sarlavha bilan, izoh — rasmga reply qilingan alohida matn
    let sb = mark('staff', OP1.id);
    await say('client', C1, { photo: tg.photo(CLIENT, CLIENT_JPEG), caption: 'D'.repeat(1020) });
    const ov = botMsgsSince('staff', OP1.id, sb);
    eq(ov.length, 2, 'rasm + izoh davomi');
    eq(ov[0]!.kind, 'photo', 'birinchisi rasm');
    eq(ov[0]!.text, `${HEADER_C1} · @ali_v`, 'rasm izohi — faqat sarlavha');
    eq(ov[1]!.kind, 'text', 'ikkinchisi matn');
    eq(ov[1]!.text, 'D'.repeat(1020), 'izoh davomi');
    eq((ov[1]!.message as any)?.reply_to_message?.message_id, ov[0]!.id, 'izoh davomi rasmga reply');
    let c1Mark = mark('client', C1.id);
    let c2Mark = mark('client', C2.id);
    await say('staff', OP1, { text: 'Ali, izohni oldim', replyTo: ov[1]!.id });
    eq(botMsgsSince('client', C1.id, c1Mark).map((m) => m.text).join('|'), `${HEADER_AZIZA}\nAli, izohni oldim`, 'C1 oldi');
    eq(botMsgsSince('client', C2.id, c2Mark).length, 0, 'C2 (aktiv) hech narsa olmadi');
    eq((await staffRow(ids.aziza)).active_conversation_id, convs.c1aziza, 'aktiv — C1');

    // b) Aktivni C2 ga qaytaramiz; C1 ning juda uzun matni — 1-bo'lak sarlavha bilan (tugmasiz), tugma oxirgisida
    await say('staff', OP1, { text: 'Vali, yana', replyTo: relayed.c2first });
    eq((await staffRow(ids.aziza)).active_conversation_id, convs.c2aziza, 'aktiv — C2');
    sb = mark('staff', OP1.id);
    await say('client', C1, 'E'.repeat(4090));
    const ch = botMsgsSince('staff', OP1.id, sb);
    eq(ch.length, 2, "ikki bo'lak");
    ok(ch[0]!.text.startsWith(`${HEADER_C1} · @ali_v\n`), `1-bo'lak sarlavha bilan: ${ch[0]!.text.slice(0, 40)}`);
    eq(ch[0]!.buttons.length, 0, "1-bo'lakda tugma yo'q");
    ok(findButton(ch[1], `act:${convs.c1aziza}`), "oxirgi bo'lakda «↩️ Javob berish»");
    c1Mark = mark('client', C1.id);
    c2Mark = mark('client', C2.id);
    await say('staff', OP1, { text: 'Ali, uzun xabaringizni oldim', replyTo: ch[0]!.id });
    eq(botMsgsSince('client', C1.id, c1Mark).map((m) => m.text).join('|'), `${HEADER_AZIZA}\nAli, uzun xabaringizni oldim`, "1-bo'lakka Reply — C1 oldi");
    eq(botMsgsSince('client', C2.id, c2Mark).length, 0, 'C2 hech narsa olmadi');
    eq((await staffRow(ids.aziza)).active_conversation_id, convs.c1aziza, 'aktiv — C1');
  });

  await step("ikki mijoz bir vaqtda yozadi: har bir joylashuv/kontakt o'z mijozining sarlavhasiga reply", async () => {
    eq((await clientRow(C1.id)).active_conversation_id, convs.c1aziza, 'C1 aktiv — Aziza');
    eq((await clientRow(C2.id)).active_conversation_id, convs.c2aziza, 'C2 aktiv — Aziza');
    const sb = mark('staff', OP1.id);
    await Promise.all([
      say('client', C1, { location: { latitude: 41.2, longitude: 69.1 } }),
      say('client', C2, { contact: { phone_number: '+998900000002', first_name: 'Vali' } }),
    ]);
    const got = botMsgsSince('staff', OP1.id, sb);
    eq(got.length, 4, 'ikki sarlavha + joylashuv + kontakt');
    const loc = got.find((m) => m.kind === 'location');
    const con = got.find((m) => m.kind === 'contact');
    ok(loc && con, 'joylashuv va kontakt yetib keldi');
    ok(String((loc!.message as any)?.reply_to_message?.text ?? '').startsWith(HEADER_C1), 'joylashuv — C1 sarlavhasiga reply');
    ok(String((con!.message as any)?.reply_to_message?.text ?? '').startsWith('👤 Vali'), 'kontakt — C2 sarlavhasiga reply');
    ok(findButton(loc, `act:${convs.c1aziza}`), 'joylashuvda C1 tugmasi');
    ok(findButton(con, `act:${convs.c2aziza}`), 'kontaktda C2 tugmasi');
  });

  await step("xodim: aktiv suhbatdan keyin boshqa mijoz yozgan — Reply'siz xabar hech kimga ketmaydi, «❓ Bu xabar kimga?» (undan keyin)", async () => {
    // a) Aktiv — C1 (tugma orqali aniq tanlandi)
    await forge('staff', OP1, lastBot('staff', OP1.id)!, `act:${convs.c1aziza}`);
    eq((await staffRow(ids.aziza)).active_conversation_id, convs.c1aziza, 'aktiv — C1');
    // b) Shundan keyin C2 yozadi
    await say('client', C2, 'Vali: yana bitta savol');
    // c) Reply'siz xabar: hech kimga yuborilmaydi va saqlanmaydi, so'raladi
    const msgCount = (await sql`select count(*)::int as n from messages`)[0]!.n;
    const start = tg.calls.length;
    let c1m = mark('client', C1.id);
    let c2m = mark('client', C2.id);
    const plain = await say('staff', OP1, 'Kimga ketishi noaniq xabar');
    eq(callsSince(start, CLIENT).filter((c) => /^(send|copy|forward)/i.test(c.method)).length, 0, 'mijozlarga hech narsa yuborilmadi');
    eq((await sql`select count(*)::int as n from messages`)[0]!.n, msgCount, 'hech narsa saqlanmadi');
    eq(tg.reactions(STAFF, OP1.id, plain.message_id).length, 0, "👍 yo'q");
    const ask = lastBot('staff', OP1.id);
    includes(ask?.text, 'Bu xabar kimga?', "so'rov");
    includes(ask?.text, 'undan keyin', 'sababi: aktivdan keyin boshqa mijoz yozgan');
    includes(ask?.text, 'Ali Valiyev', 'aktiv suhbat nomi');
    eq((ask?.message as any)?.reply_to_message?.message_id, plain.message_id, "so'rov xodim xabariga reply");
    ok(findButton(ask, `to:${convs.c1aziza}`) && findButton(ask, `to:${convs.c2aziza}`), 'aktiv va kutayotgan nomzodlar');
    eq((await staffRow(ids.aziza)).active_conversation_id, convs.c1aziza, "aktiv o'zgarmadi");
    // d) Tanlov: aynan C2 ga ketadi
    const q = await press('staff', OP1, ask, `to:${convs.c2aziza}`);
    eq(answerOf(q).text, '✅ Yuborildi', 'callback javobi');
    eq(botMsgsSince('client', C2.id, c2m).map((m) => m.text).join('|'), `${HEADER_AZIZA}\nKimga ketishi noaniq xabar`, 'C2 oldi');
    eq(botMsgsSince('client', C1.id, c1m).length, 0, 'C1 olmadi');
    eq((await staffRow(ids.aziza)).active_conversation_id, convs.c2aziza, 'aktiv — C2');
    // e) Endi C2 ga javob berilgan — keyingi Reply'siz xabar so'rovsiz C2 ga
    c1m = mark('client', C1.id);
    c2m = mark('client', C2.id);
    const sb = mark('staff', OP1.id);
    await say('staff', OP1, 'Vali, yana bir narsa');
    eq(botMsgsSince('client', C2.id, c2m).map((m) => m.text).join('|'), `${HEADER_AZIZA}\nVali, yana bir narsa`, 'C2 oldi (so\'rovsiz)');
    eq(botMsgsSince('client', C1.id, c1m).length, 0, 'C1 olmadi');
    eq(botMsgsSince('staff', OP1.id, sb).length, 0, "so'rov yo'q");
  });

  await step('xato logi: Telegram xatosida (transkript yuborish) mijoz yozishmasi logga yozilmaydi', async () => {
    const logs: string[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    const tap =
      (fn: (...a: unknown[]) => void) =>
      (...a: unknown[]) => {
        logs.push(a.map((x) => (typeof x === 'string' ? x : inspect(x, { depth: 8 }))).join(' '));
        fn(...a);
      };
    const start = tg.calls.length;
    console.log = tap(orig.log);
    console.warn = tap(orig.warn);
    console.error = tap(orig.error);
    try {
      tg.failNext(STAFF, 'sendMessage', { error_code: 400, description: 'Bad Request: e2e soxta xato' }, {
        when: (p) => String(p.text ?? '').includes('Endi yozgan xabarlaringiz'),
      });
      await forge('staff', OP1, lastBot('staff', OP1.id)!, `open:${convs.c1aziza}`);
    } finally {
      Object.assign(console, orig);
    }
    const failedCall = callsSince(start, STAFF, 'sendMessage').find((c) => !c.ok);
    ok(failedCall, 'transkript yuborilmadi (soxta 400)');
    const payload = String(failedCall.params.text ?? '').replace(/<[^>]+>/g, '');
    includes(payload, 'Ali, manzilingizni oldim', 'transkriptda mijoz yozishmasi bor edi');
    const all = logs.join('\n');
    includes(all, 'sendMessage -> 400', 'xato qisqa ko\'rinishda logga yozildi');
    const lines = payload.split('\n').map((l) => l.trim()).filter((l) => l.length >= 12);
    ok(lines.length >= 5, `transkript qatorlari: ${lines.length}`);
    for (const l of lines) excludes(all, l, 'logda transkript qatori');
    includes(lastBot('staff', OP1.id)?.text, 'Xatolik yuz berdi', 'xodimga xato haqida xabar');
  }, { allowFailedCalls: (c) => c.method === 'sendMessage' && c.error?.error_code === 400 });

  await step('takroriy update (bir xil update_id) faqat bir marta qayta ishlanadi', async () => {
    const upd = tg.messageUpdate(CLIENT, C1, { text: 'Dublikat test' });
    const before = mark('staff', OP1.id);
    eq((await postUpdate('client', upd)).status, 200, '1-marta');
    eq((await postUpdate('client', upd)).status, 200, '2-marta');
    eq(botMsgsSince('staff', OP1.id, before).length, 1, 'xodim bir marta oldi');
    eq((await sql`select count(*)::int as n from messages where text = 'Dublikat test'`)[0]!.n, 1, 'bir marta saqlandi');
  });

  await step('mijoz: «💬 Suhbatlarim», suhbatni tanlash, tarix sahifalari', async () => {
    await say('client', C1, '💬 Suhbatlarim');
    const list = lastBot('client', C1.id);
    includes(list?.text, 'Suhbatlaringiz', 'sarlavha');
    ok(findButton(list, `conv:${convs.c1aziza}`), 'suhbat tugmasi');
    const q = await press('client', C1, list, `conv:${convs.c1aziza}`);
    ok(answerOf(q), 'javob');
    const tr = lastBot('client', C1.id);
    includes(tr?.text, 'Aziza Karimova', 'transkript');
    includes(tr?.text, 'Endi xabarlaringiz Aziza Karimovaga yuboriladi', 'footer');
    const older = findButton(tr, /^hist:/);
    ok(older, '«⬆️ Oldingi xabarlar» tugmasi (10 dan ko\'p xabar)');
    // Sahifalar oxirigacha: har biri «oldingi xabarlar», eng eskisida suhbatning birinchi xabari
    const pages = await olderPages('client', C1, tr, /^hist:/);
    ok(pages.length >= 1, 'kamida bitta oldingi sahifa');
    for (const pg of pages) includes(pg.text, 'oldingi xabarlar', 'oldingi sahifa');
    const oldest = pages[pages.length - 1]!;
    ok(!findButton(oldest, /^hist:/), "eng eski sahifada «⬆️» yo'q");
    includes(pages.map((pg) => pg.text).join('\n'), 'Avtomatik javob', 'avto-javob belgisi');
    includes(oldest.text, 'Salom! Buyurtmam qayerda? <tag> & 😀', 'eng birinchi xabar (escape)');
  });
}

async function miniAppTests(): Promise<void> {
  await step('Mini App: autentifikatsiya va umumiy xatolar', async () => {
    const r401 = await app('client', null, 'bootstrap', {}, 'hash=deadbeef&user=%7B%22id%22%3A1%7D&auth_date=1');
    eq(expectApi(r401, 401, 'soxta initData').error, 'unauthorized', 'kod');
    includes(r401.body.message, 'Sessiya eskirgan', 'xabar');
    const expired = auth.buildInitData(CLIENT, { id: C1.id, first_name: 'Ali' }, Math.floor(Date.now() / 1000) - 2 * 86400);
    expectApi(await app('client', null, 'bootstrap', {}, expired), 401, 'eskirgan initData');
    const notStaff = await app('staff', STRANGER, 'bootstrap');
    eq(expectApi(notStaff, 403, 'xodim emas').error, 'not_staff', 'kod');
    eq(expectApi(await app('staff', OP1, 'no.such.action'), 400, "noma'lum amal").error, 'unknown_action', 'kod');
    const get = await appApi.fetch(new Request(`${ORIGIN}/api/app`));
    eq(get.status, 405, 'GET');
    eq(expectApi(await app('client', C1, 'admin.stats'), 403, 'mijoz admin amali').error, 'client_app_disabled', 'kod');
    eq(expectApi(await app('staff', OP1, 'admin.stats'), 403, 'xodim admin amali').error, 'admin_only', 'kod');
    eq(expectApi(await app('staff', ADMIN, 'status.set', { online: false }), 403, 'profilsiz admin status.set').error, 'staff_only', 'kod');
  });

  await step("Mini App (mijoz): o'chirilgan — har qanday amal 403 client_app_disabled, bazaga yozuv va Telegramga murojaatsiz", async () => {
    const start = tg.calls.length;
    const counts = async () =>
      JSON.stringify(
        (await sql`
          select (select count(*)::int from clients) as clients, (select count(*)::int from messages) as messages,
                 (select count(*)::int from conversations) as conversations, (select count(*)::int from user_state) as states`)[0],
      );
    const countsBefore = await counts();
    const activeBefore = (await clientRow(C1.id)).active_conversation_id;
    const cases: Array<[string, Record<string, unknown>]> = [
      ['bootstrap', {}],
      ['sync', {}],
      ['sync', { conversationId: convs.c1aziza, afterId: 0 }],
      ['conversation.open', { staffId: ids.bobur, activate: true }],
      ['send', { conversationId: convs.c1aziza, text: 'Mini App dan' }],
      ['messages', { conversationId: convs.c1aziza }],
      ['resend', { messageId: 1 }],
      ['retry', { messageId: 1 }],
      ['conversations', {}],
      ['status.set', { online: false }],
      ['admin.stats', {}],
      ['no.such.action', {}],
      ['', {}],
    ];
    for (const [action, params] of cases) {
      const r = await app('client', C1, action, params);
      const what = `mijoz ${action || "(bo'sh amal)"}`;
      eq(expectApi(r, 403, what).error, 'client_app_disabled', `${what}: kod`);
      eq(r.body.message, CLIENT_APP_DISABLED, `${what}: matn`);
    }
    const up = await appUpload('client', C1, 'upload', { conversationId: convs.c1aziza }, { bytes: UPLOAD_JPEG, name: 'r.jpg', type: 'image/jpeg' });
    eq(expectApi(up, 403, 'mijoz upload').error, 'client_app_disabled', 'upload: kod');
    // Bazada yo'q mijoz Mini App ni ochdi — yozuv yaratilmaydi
    const fresh = await app('client', C9, 'bootstrap');
    eq(expectApi(fresh, 403, 'yangi mijoz bootstrap').error, 'client_app_disabled', 'kod');
    eq(await clientRow(C9.id), undefined, "yangi mijoz bazaga yozilmadi");
    eq(await counts(), countsBefore, "bazada hech narsa o'zgarmadi");
    eq((await clientRow(C1.id)).active_conversation_id, activeBefore, "aktiv suhbat o'zgarmadi");
    eq(callsSince(start).length, 0, "Telegramga murojaat yo'q");
    // initData siz — avvalgidek 401
    expectApi(await app('client', null, 'bootstrap', {}, ''), 401, "initData siz");
  });

  await step("mijoz: xodimning shaxsiy havolasi (/start bobur) — darhol Bobur bilan suhbat (faol suhbat almashadi), birinchi xabar — shaxsiy avto-javob", async () => {
    eq((await clientRow(C1.id)).active_conversation_id, convs.c1aziza, "boshlang'ich aktiv — Aziza");
    const placeholder = (await sql`select value from settings where key = ${texts.SETTING_KEYS.placeholderPhoto}`)[0]?.value;
    const start = tg.calls.length;
    let before = mark('client', C1.id);
    await say('client', C1, '/start bobur');
    const msgs = botMsgsSince('client', C1.id, before);
    eq(msgs.length, 1, 'bitta xabar');
    eq(msgs[0]!.kind, 'photo', 'rasmli (rasmsiz xodim — standart avatar)');
    eq(callsSince(start, CLIENT, 'sendPhoto')[0]?.params.photo, placeholder, 'keshlangan standart avatar');
    eq(msgs[0]!.text, linkCaption({ client: 'Ali', staff: 'Bobur Aliyev', role: '👔 Menejer' }), 'izoh');
    ok(boldName(msgs[0], 'Bobur Aliyev'), 'xodim ismi qalin');
    ok(isRemoveKeyboardOnly(msgs[0]), `remove_keyboard, tugmasiz: ${JSON.stringify(msgs[0]!.markup)}`);
    const conv = await convOf(C1.id, ids.bobur);
    ok(conv, 'suhbat yaratildi');
    convs.c1bobur = conv.id;
    eq((await clientRow(C1.id)).active_conversation_id, convs.c1bobur, 'aktiv — Bobur');

    const staffBefore = mark('staff', MGR.id);
    const opBefore = mark('staff', OP1.id);
    before = mark('client', C1.id);
    await say('client', C1, 'Bot orqali salom');
    eq(
      botMsgsSince('client', C1.id, before).map((m) => m.text).join('|'),
      'Salom Ali! Men Bobur Aliyev, tez orada javob beraman.',
      "mijozga faqat shaxsiy avto-javob (boshqa izoh yo'q)",
    );
    const toStaff = botMsgsSince('staff', MGR.id, staffBefore);
    eq(toStaff.length, 1, 'menejerga bitta xabar');
    eq(toStaff[0]?.text, `🆕 ${HEADER_C1} · @ali_v\nBot orqali salom`, 'menejerga yetkazildi');
    eq(botMsgsSince('staff', OP1.id, opBefore).length, 0, 'Aziza hech narsa olmadi');
    eq(await countMessages(convs.c1bobur, 'bot'), 1, 'bitta avto-javob');

    const inClientBefore = mark('client', C1.id);
    await say('staff', MGR, { text: 'Salom Ali, qanday yordam kerak?', replyTo: toStaff[0]!.id });
    const reply = botMsgsSince('client', C1.id, inClientBefore);
    eq(reply.map((m) => m.text).join('|'), `👔 Bobur Aliyev\nSalom Ali, qanday yordam kerak?`, 'mijozga javob');
    inClient.boburReply = reply[0]!.id;
    eq((await staffRow(ids.bobur)).active_conversation_id, convs.c1bobur, 'Boburning aktiv suhbati — C1');
  });

  await step('mijoz boti: Reply orqali boshqa suhbatga yozish (aktiv almashadi, ogohlantirish)', async () => {
    const staffBefore = mark('staff', OP1.id);
    const before = mark('client', C1.id);
    await say('client', C1, { text: 'Aziza, rahmat!', replyTo: inClient.azizaReply });
    eq(botMsgsSince('staff', OP1.id, staffBefore)[0]?.text, `${HEADER_C1} · @ali_v\nAziza, rahmat!`, 'Azizaga ketdi (Bobur emas)');
    // Mijoz xodim javobining nusxasiga Reply qildi — xodimda uning O'Z asl xabari iqtibos qilinadi
    ok(inStaff.azizaReplyOwn > 0, 'xodimning asl javobi id si');
    eq(
      (botMsgsSince('staff', OP1.id, staffBefore)[0]?.message as any)?.reply_to_message?.message_id,
      inStaff.azizaReplyOwn,
      "xodimda o'z javobi iqtibos qilindi",
    );
    includes(botMsgsSince('client', C1.id, before)[0]?.text, 'Endi xabarlaringiz Aziza Karimovaga yuboriladi', 'almashish haqida xabar');
    eq((await clientRow(C1.id)).active_conversation_id, convs.c1aziza, 'aktiv suhbat almashdi');
  });

  await step("mijoz: xodim stikeri sarlavhasiga Reply — o'sha xodimga; aniqlanmagan Reply — «❓ Bu xabar kimga?» (tanlovgacha hech kimga)", async () => {
    eq((await clientRow(C1.id)).active_conversation_id, convs.c1aziza, "boshlang'ich aktiv — Aziza");
    eq((await staffRow(ids.bobur)).active_conversation_id, convs.c1bobur, 'Boburning aktiv suhbati — C1');

    // 1) Bobur stiker yuboradi: mijoz chatida sarlavha ALOHIDA matn xabari, stiker unga reply
    let before = mark('client', C1.id);
    await say('staff', MGR, { sticker: tg.media(STAFF, 'sticker', fakeWebp(), { emoji: '👍' }) });
    const got = botMsgsSince('client', C1.id, before);
    const header = got.find((m) => m.kind === 'text');
    eq(header?.text, '👔 Bobur Aliyev', 'stiker sarlavhasi');
    ok(got.some((m) => m.kind === 'sticker'), 'stiker yetib keldi');

    // 2) Aktiv — Aziza, lekin Bobur sarlavhasiga Reply — faqat Boburga
    let mgrMark = mark('staff', MGR.id);
    let opMark = mark('staff', OP1.id);
    before = mark('client', C1.id);
    await say('client', C1, { text: 'Bobur, stiker uchun rahmat', replyTo: header!.id });
    eq(botMsgsSince('staff', MGR.id, mgrMark).map((m) => m.text).join('|'), `${HEADER_C1} · @ali_v\nBobur, stiker uchun rahmat`, 'Bobur oldi');
    eq(botMsgsSince('staff', OP1.id, opMark).length, 0, 'Aziza (aktiv) hech narsa olmadi');
    includes(textsSince('client', C1.id, before), 'Endi xabarlaringiz Bobur Aliyevga yuboriladi', 'almashish haqida xabar');
    eq((await clientRow(C1.id)).active_conversation_id, convs.c1bobur, 'aktiv — Bobur');

    // 3) Hech bir suhbatga bog'lanmagan bot xabariga (salomlashuv) Reply — hech kimga yuborilmaydi, so'raladi
    // Salomlashuvda faqat rol tanlash (ls:) tugmalari bor — ular hech bir xodimga ishora qilmaydi, qalin ism ham yo'q
    const welcome = tg.sent(CLIENT, C1.id)[0];
    ok(
      welcome?.text.startsWith('Assalomu alaykum, Ali! 👋') &&
        !welcome.buttons.some((b) => b.callback_data && !/^ls:/.test(b.callback_data)) &&
        entitiesOf(welcome).every((e) => e.type !== 'bold'),
      'faqat rol tugmali salomlashuv xabari',
    );
    const msgCount = (await sql`select count(*)::int as n from messages`)[0]!.n;
    const start = tg.calls.length;
    const orphan = await say('client', C1, { text: 'Bu savol kimga?', replyTo: welcome!.id });
    eq(callsSince(start, STAFF).filter((c) => /^(send|copy|forward)/i.test(c.method)).length, 0, 'xodimlarga hech narsa yuborilmadi');
    eq((await sql`select count(*)::int as n from messages`)[0]!.n, msgCount, "hech narsa saqlanmadi (faqat tanlov kutmoqda)");
    const ask = lastBot('client', C1.id);
    includes(ask?.text, 'Bu xabar kimga?', "so'rov");
    eq((ask?.message as any)?.reply_to_message?.message_id, orphan.message_id, "so'rov mijoz xabariga reply");
    ok(findButton(ask, `to:${convs.c1bobur}`) && findButton(ask, `to:${convs.c1aziza}`), 'nomzodlar');
    eq((await clientRow(C1.id)).active_conversation_id, convs.c1bobur, "aktiv o'zgarmadi");

    // 4) Aziza tanlanadi (aktiv emas) — saqlangan xabar aynan Azizaga ketadi
    mgrMark = mark('staff', MGR.id);
    opMark = mark('staff', OP1.id);
    await press('client', C1, ask, `to:${convs.c1aziza}`);
    eq(botMsgsSince('staff', OP1.id, opMark).map((m) => m.text).join('|'), `${HEADER_C1} · @ali_v\nBu savol kimga?`, 'Aziza oldi');
    eq(botMsgsSince('staff', MGR.id, mgrMark).length, 0, 'Bobur olmadi');
    eq((await clientRow(C1.id)).active_conversation_id, convs.c1aziza, 'aktiv — Aziza');
  });

  await step("mijoz: chatdagi oxirgi xabar boshqa xodimniki, Reply'siz yozdi — aktivga ketadi va «✉️ Xabaringiz …ga yuborildi» (to: tugmasi bilan)", async () => {
    await clearRates();
    eq((await clientRow(C1.id)).active_conversation_id, convs.c1aziza, "boshlang'ich aktiv — Aziza");
    // 1) Bobur (aktiv emas) Mini App orqali yozadi: mijoz chatidagi oxirgi xabar — Boburniki, «↩️ Javob berish» (to:) bilan
    expectApi(await app('staff', MGR, 'send', { conversationId: convs.c1bobur, text: 'Bobur: yangi taklif' }), 200, 'Bobur yozdi');
    const relayedMsg = lastBot('client', C1.id);
    includes(relayedMsg?.text, 'Bobur: yangi taklif', 'mijozga yetdi');
    ok(findButton(relayedMsg, `to:${convs.c1bobur}`), 'xodim xabarida to: tugmasi');

    // 2) Mijoz Reply qilmasdan yozadi — aktiv suhbatga (Aziza), Boburga emas; bildirishnoma to:<Bobur> tugmasi bilan
    let opMark = mark('staff', OP1.id);
    let mgrMark = mark('staff', MGR.id);
    let before = mark('client', C1.id);
    const sent = await say('client', C1, 'Reply qilmasdan yozdim');
    includes(textsSince('staff', OP1.id, opMark), 'Reply qilmasdan yozdim', 'Aziza oldi');
    eq(botMsgsSince('staff', MGR.id, mgrMark).length, 0, 'Bobur olmadi');
    const note = botMsgsSince('client', C1.id, before).find((m) => m.text.includes('Xabaringiz'));
    includes(note?.text, 'Xabaringiz Aziza Karimovaga yuborildi', 'qayerga ketgani aytildi');
    eq((note?.message as any)?.reply_to_message?.message_id, sent.message_id, 'bildirishnoma mijoz xabariga reply');
    const back = findButton(note, `to:${convs.c1bobur}`);
    ok(back, '«↩️ Bobur Aliyevga yozish» tugmasi');
    eq(back!.text, '↩️ Bobur Aliyevga yozish', 'tugma matni');
    eq((await clientRow(C1.id)).active_conversation_id, convs.c1aziza, "aktiv o'zgarmadi");

    // 3) Takror yozsa — endi chatdagi oxirgi xabar shu suhbatniki: bildirishnoma yo'q
    before = mark('client', C1.id);
    await say('client', C1, 'Yana Azizaga');
    excludes(textsSince('client', C1.id, before), 'Xabaringiz', 'bildirishnoma takrorlanmaydi');

    // 4) Tugma bosiladi — Bobur aktiv; aniq tanlovdan keyingi xabarga bildirishnoma yo'q
    await press('client', C1, note, `to:${convs.c1bobur}`);
    eq((await clientRow(C1.id)).active_conversation_id, convs.c1bobur, 'aktiv — Bobur');
    mgrMark = mark('staff', MGR.id);
    opMark = mark('staff', OP1.id);
    before = mark('client', C1.id);
    await say('client', C1, 'Endi Boburga');
    includes(textsSince('staff', MGR.id, mgrMark), 'Endi Boburga', 'Bobur oldi');
    eq(botMsgsSince('staff', OP1.id, opMark).length, 0, 'Aziza olmadi');
    excludes(textsSince('client', C1.id, before), 'Xabaringiz', "aniq tanlovdan keyin bildirishnoma yo'q");

    // Keyingi qadamlar uchun holatni tiklaymiz (aktiv — Aziza, tanlov belgisi yo'q)
    await sql`update clients set active_conversation_id = ${convs.c1aziza} where tg_user_id = ${C1.id}`;
    await sql`delete from user_state where bot = 'client' and tg_user_id = ${C1.id}`;
  });

  await step('media proksi: mijoz bot chatida yuborgan rasm va hujjat (imzolangan token), xodim rasmi', async () => {
    eq((await clientRow(C1.id)).active_conversation_id, convs.c1aziza, 'aktiv — Aziza');
    const start = tg.calls.length;
    await say('client', C1, { photo: tg.photo(CLIENT, UPLOAD_JPEG), caption: 'Rasm' });
    const call = callsSince(start, STAFF, 'sendPhoto')[0];
    ok(call?.ok && call.multipart && bytesEqual(tg.fileBytes(call.uploaded[0]!), UPLOAD_JPEG), 'xodimga yuklandi');
    includes(tg.lastSent(STAFF, OP1.id)?.text, 'Rasm', 'xodim izohni oldi');
    const photoRow = (await sql`
      select id from messages where conversation_id = ${convs.c1aziza} and sender = 'client' and kind = 'photo'
      order by id desc limit 1`)[0];
    ok(photoRow, 'rasm saqlandi');
    uploadedPhotoMsgId = Number(photoRow.id);
    // Xodimning Mini App i rasmni imzolangan token bilan ko'rsatadi
    const page = expectApi(await app('staff', OP1, 'messages', { conversationId: convs.c1aziza }), 200, 'xodim messages');
    const dto = page.messages.find((m: any) => m.id === uploadedPhotoMsgId);
    eq(dto?.kind, 'photo', 'rasm sifatida');
    eq(dto?.text, 'Rasm', 'izoh');
    eq(dto?.media?.inline, true, 'inline');
    ok(String(dto?.media?.url).startsWith('/api/media?t='), `media.url: ${dto?.media?.url}`);
    uploadedPhotoUrl = dto.media.url;

    const media = await mediaGet(uploadedPhotoUrl);
    eq(media.status, 200, 'media GET');
    eq(media.headers.get('content-type'), 'image/jpeg', 'content-type');
    eq(media.headers.get('x-content-type-options'), 'nosniff', 'nosniff');
    ok(bytesEqual(media.bytes, UPLOAD_JPEG), 'media baytlari');
    const head = await mediaGet(uploadedPhotoUrl, 'HEAD');
    eq(head.status, 200, 'HEAD');
    eq(head.bytes.byteLength, 0, 'HEAD — tanasiz');
    const token = decodeURIComponent(uploadedPhotoUrl.split('t=')[1]!);
    const tampered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    eq((await mediaGet(`/api/media?t=${encodeURIComponent(tampered)}`)).status, 403, 'buzilgan token');
    const expired = auth.signMediaToken(uploadedPhotoMsgId, 60, Math.floor(Date.now() / 1000) - 3600);
    eq((await mediaGet(`/api/media?t=${encodeURIComponent(expired)}`)).status, 403, 'eskirgan token');
    eq((await mediaGet('/api/media?t=garbage')).status, 403, 'noto\'g\'ri token');
    eq((await mediaGet('/api/media')).status, 404, 'parametrsiz');
    const tokenFile = (await mediaGet(uploadedPhotoUrl)).headers.get('content-disposition');
    eq(tokenFile, 'inline', 'rasm — inline');

    // Hujjat (bot chatidan): media proksi uni «attachment» sifatida beradi
    const docBytes = new TextEncoder().encode('eslatma matni');
    const docStart = tg.calls.length;
    await say('client', C1, { document: tg.document(CLIENT, docBytes, { file_name: 'notes.txt', mime_type: 'text/plain' }) });
    const docCall = callsSince(docStart, STAFF, 'sendDocument')[0];
    ok(docCall?.ok, 'hujjat xodimga yuborildi');
    eq(Object.values(docCall!.files)[0]?.filename, 'notes.txt', 'xodimga fayl nomi bilan');
    const docRow = (await sql`
      select id from messages where conversation_id = ${convs.c1aziza} and kind = 'document' and file_name = 'notes.txt'
      order by id desc limit 1`)[0];
    ok(docRow, 'hujjat saqlandi');
    const docDto = expectApi(await app('staff', OP1, 'messages', { conversationId: convs.c1aziza }), 200, 'xodim messages (hujjat)')
      .messages.find((m: any) => m.id === Number(docRow.id));
    eq(docDto?.media?.inline, false, 'hujjat inline emas');
    eq(docDto?.media?.file_name, 'notes.txt', 'fayl nomi');
    const docMedia = await mediaGet(`/api/media?t=${encodeURIComponent(auth.signMediaToken(Number(docRow.id)))}`);
    eq(docMedia.status, 200, 'hujjat media');
    includes(docMedia.headers.get('content-disposition'), 'attachment', 'rasm bo\'lmagan fayl — attachment');
    ok(bytesEqual(docMedia.bytes, docBytes), 'hujjat baytlari');

    // Xodimning ochiq rasmi (admin ro'yxatidagi photo_url)
    const adminList = expectApi(await app('staff', ADMIN, 'admin.staff.list'), 200, 'admin.staff.list');
    const v = String(adminList.staff.find((s: any) => s.id === ids.aziza)?.photo_url);
    ok(v.startsWith(`/api/media?staff=${ids.aziza}&v=`), `photo_url: ${v}`);
    const photo = await mediaGet(v);
    eq(photo.status, 200, 'xodim rasmi');
    ok(bytesEqual(photo.bytes, AZIZA_JPEG), 'xodim rasmi baytlari');
    includes(photo.headers.get('cache-control'), 'immutable', 'uzoq kesh');
    includes(photo.headers.get('vercel-cdn-cache-control'), 'max-age=21600', 'CDN keshi cheklangan (6 soat)');
    // Kanonik bo'lmagan har qanday ko'rinish Telegramga murojaatsiz kanonik URL ga yo'naltiriladi (keshni chetlab
    // o'tib, xodimlar botining limitini sarflab bo'lmaydi)
    const noTg = tg.calls.length;
    for (const [what, path] of [
      ['eski versiya', `/api/media?staff=${ids.aziza}&v=eski`],
      ['v siz', `/api/media?staff=${ids.aziza}`],
      ['ortiqcha parametr', `${v}&x=1`],
      ['boshqa tartib', `/api/media?v=${encodeURIComponent(new URL(v, ORIGIN).searchParams.get('v')!)}&staff=${ids.aziza}`],
      ['id oldida 0', `/api/media?staff=0${ids.aziza}&v=eski`],
    ] as const) {
      const r = await mediaGet(path);
      eq(r.status, 302, `${what}: 302`);
      eq(r.headers.get('location'), v, `${what}: kanonik URL ga`);
      eq(r.headers.get('cache-control'), 'public, max-age=60', `${what}: qisqa kesh`);
      eq(r.bytes.byteLength, 0, `${what}: tanasiz`);
    }
    eq(callsSince(noTg).length, 0, "yo'naltirishlar Telegramga murojaat qilmaydi");
    eq((await mediaGet(`/api/media?staff=${ids.bobur}&v=x`)).status, 404, 'rasmsiz xodim');
    eq((await mediaGet('/api/media?staff=999999&v=x')).status, 404, 'yo\'q xodim');
    eq((await mediaGet('/api/media?staff=abc&v=x')).status, 404, "noto'g'ri id");
  });

  await step('Mini App (xodim): bootstrap (faqat o\'z suhbatlari), yuborish, status, messages', async () => {
    const b = expectApi(await app('staff', OP1, 'bootstrap'), 200, 'bootstrap');
    eq(b.role, 'staff', 'rol');
    eq(b.is_admin, false, 'admin emas');
    eq(b.me.full_name, 'Aziza Karimova', 'me');
    eq(b.total, 2, 'jami suhbatlar');
    const idsList = b.conversations.map((c: any) => c.id).sort();
    eq(JSON.stringify(idsList), JSON.stringify([convs.c1aziza, convs.c2aziza].sort()), 'faqat o\'z suhbatlari');
    const c1 = b.conversations.find((c: any) => c.id === convs.c1aziza);
    eq(c1.peer.name, 'Ali Valiyev', 'peer');
    eq(c1.peer.subtitle, '@ali_v', 'username');
    eq(c1.peer.is_online, null, 'mijoz onlayn holati yo\'q');

    const before = mark('client', C1.id);
    const sent = expectApi(await app('staff', OP1, 'send', { conversationId: convs.c1aziza, text: 'Mini App dan javob' }), 200, 'send');
    eq(sent.message.outgoing, true, 'outgoing');
    eq(sent.message.sender, 'staff', 'sender');
    eq(sent.delivered, true, 'delivered');
    eq(botMsgsSince('client', C1.id, before)[0]?.text, `${HEADER_AZIZA}\nMini App dan javob`, 'mijozga yetkazildi');

    const msgs = expectApi(await app('staff', OP1, 'messages', { conversationId: convs.c1aziza }), 200, 'messages');
    const photoMsg = msgs.messages.find((m: any) => m.id === uploadedPhotoMsgId);
    ok(photoMsg && photoMsg.outgoing === false && photoMsg.media?.inline === true, 'xodim uchun mijoz rasmi kiruvchi, inline');
    eq((await convRow(convs.c1aziza)).unread_staff, 0, "messages — o'qildi");

    const off = expectApi(await app('staff', OP1, 'status.set', { online: false }), 200, 'status.set');
    eq(off.me.is_online, false, 'oflayn');
    eq((await staffRow(ids.aziza)).is_online, false, 'bazada oflayn');
    eq(expectApi(await app('staff', OP1, 'status.set', { online: 'maybe' }), 400, "noto'g'ri holat").error, 'bad_status', 'kod');
  });

  await step('Mini App (xodim): rasm yuklash (xodim → mijoz), resend, bot transkripti sahifalari', async () => {
    const jpeg = fakeJpeg({ width: 500, height: 500, size: 4000, seed: 77 });
    let start = tg.calls.length;
    const before = mark('client', C1.id);
    const up = expectApi(
      await appUpload('staff', OP1, 'upload', { conversationId: convs.c1aziza, caption: 'Hisob-faktura' }, { bytes: jpeg, name: 'faktura.png', type: 'image/png' }),
      200,
      'xodim upload',
    );
    eq(up.message.kind, 'photo', 'rasm');
    eq(up.message.outgoing, true, 'xodim uchun chiquvchi');
    eq(up.delivered, true, 'yetkazildi');
    const call = callsSince(start, CLIENT, 'sendPhoto')[0];
    ok(call?.ok && call.multipart && bytesEqual(tg.fileBytes(call.uploaded[0]!), jpeg), 'mijoz botiga yuklandi');
    const got = botMsgsSince('client', C1.id, before)[0];
    eq(got?.text, `${HEADER_AZIZA}\nHisob-faktura`, 'mijoz izohi');
    const row = (await sql`select * from messages where id = ${up.message.id}`)[0];
    eq(Number(row.client_chat_msg_id), got!.id, 'client_chat_msg_id (mijoz Reply qila oladi)');
    eq(row.mime_type, 'image/jpeg', 'MIME baytlar bo\'yicha aniqlandi (brauzer png degan)');

    // Xodim mijoz rasmini botda ochadi: staff botdagi file_id to'g'ridan-to'g'ri, «↩️ Javob berish» tugmasi bilan
    const clientPhoto = (await sql`select id, file_id_staff from messages where conversation_id = ${convs.c1aziza} and kind = 'photo' and sender = 'client' order by id limit 1`)[0];
    start = tg.calls.length;
    expectApi(await app('staff', OP1, 'resend', { messageId: clientPhoto.id }), 200, 'xodim resend');
    const rs = callsSince(start, STAFF, 'sendPhoto')[0];
    ok(rs?.ok && !rs.multipart && rs.params.photo === clientPhoto.file_id_staff, 'staff file_id ishlatildi');
    const resent = tg.lastSent(STAFF, OP1.id);
    includes(resent?.text, '📥 Ali Valiyev bilan suhbatdan', 'sarlavha');
    ok(findButton(resent, `act:${convs.c1aziza}`), 'Javob berish tugmasi');

    // Bot ichidagi tarix: 15 dan ko'p xabar — «⬆️ Oldingi» sahifasi.
    // answerCallbackQuery rad etilsa ham (eskirgan query) suhbat baribir ochiladi va transkript yuboriladi.
    tg.failNext(STAFF, 'answerCallbackQuery', {
      error_code: 400,
      description: 'Bad Request: query is too old and response timeout expired or query ID is invalid',
    });
    const qOpen = await forge('staff', OP1, lastBot('staff', OP1.id)!, `open:${convs.c1aziza}`);
    eq(answerOf(qOpen).text, undefined, 'javob Telegramda rad etildi');
    ok(tg.expireCallback(qOpen), 'rad etilgan query eskirdi (Telegram uni unutadi)');
    const tr = lastBot('staff', OP1.id);
    includes(tr?.text, 'Ali Valiyev', 'answerCallbackQuery xatosiga qaramay transkript yuborildi');
    eq((await staffRow(ids.aziza)).active_conversation_id, convs.c1aziza, 'open — aktiv');
    // «💬 Chatlar» (chats:0:n) transkript ostida: transkript joyida qoladi, ro'yxat YANGI xabarda
    const trText = tr!.text;
    const cb = mark('staff', OP1.id);
    const s0 = tg.calls.length;
    await press('staff', OP1, tr, 'chats:0:n');
    eq(tg.message(STAFF, OP1.id, tr!.id)?.text, trText, "transkript o'zgarmadi");
    ok(!tg.message(STAFF, OP1.id, tr!.id)?.deleted, "transkript o'chirilmadi");
    eq(callsSince(s0, STAFF, 'deleteMessage').length, 0, "deleteMessage yo'q");
    includes(botMsgsSince('staff', OP1.id, cb).pop()?.text, 'Chatlaringiz', "ro'yxat yangi xabarda");
    // «⬆️ Oldingi» ni oxirigacha bosib borish: har sahifa yangi (takrorlanmaydi), oxirida eng birinchi xabar
    let pageMsg = tr;
    let older = findButton(pageMsg, /^shist:/);
    ok(older, '«⬆️ Oldingi» tugmasi');
    const seenCursors = new Set<string>();
    let firstPage: string | undefined;
    for (let i = 0; older && i < 30; i++) {
      ok(!seenCursors.has(older.callback_data!), `sahifa kursori takrorlanmaydi (${older.callback_data})`);
      seenCursors.add(older.callback_data!);
      await press('staff', OP1, pageMsg, older.callback_data!);
      pageMsg = lastBot('staff', OP1.id);
      includes(pageMsg?.text, 'oldingi xabarlar', 'oldingi sahifa sarlavhasi');
      firstPage = pageMsg?.text;
      older = findButton(pageMsg, /^shist:/);
    }
    ok(!older, "oxirgi sahifada «⬆️ Oldingi» yo'q");
    includes(firstPage, 'Salom! Buyurtmam qayerda? <tag> & 😀', 'eng birinchi xabar (oxirgi sahifada)');
  }, { allowFailedCalls: (c) => c.method === 'answerCallbackQuery' && c.error?.error_code === 400 });

  await step("Mini App (xodim): hujjat va GIF yuklash (xodim → mijoz), katta fayl, faylsiz; resend — boshqa botdan qayta yuklab keshlanadi", async () => {
    // Hujjat hujjatligicha qolsin (Telegram .mp3/.mp4 ni audio/video ga aylantirmasin)
    const doc = expectApi(
      await appUpload('staff', OP1, 'upload', { conversationId: convs.c1aziza }, { bytes: new TextEncoder().encode('eslatma matni'), name: 'notes.txt', type: 'text/plain' }),
      200,
      'upload (hujjat)',
    );
    eq(doc.message.kind, 'document', 'hujjat');
    eq(doc.message.media?.inline, false, 'inline emas');
    eq(doc.message.media?.url, null, "url yo'q");
    eq(doc.message.media?.file_name, 'notes.txt', 'fayl nomi');
    const docCall = tg.lastCall(CLIENT, 'sendDocument');
    eq(Object.values(docCall!.files)[0]?.filename, 'notes.txt', 'mijozga fayl nomi bilan');
    eq(docCall!.params.disable_content_type_detection, true, 'disable_content_type_detection (Mini App hujjati)');

    // GIF — animatsiya sifatida yuboriladi va saqlanadi (Telegram uni MPEG-4 ga aylantiradi), inline emas
    const gif = new Uint8Array([...new TextEncoder().encode('GIF89a'), ...new Uint8Array(40)]);
    const gifStart = tg.calls.length;
    const g = expectApi(
      await appUpload('staff', OP1, 'upload', { conversationId: convs.c1aziza }, { bytes: gif, name: 'a.gif', type: 'image/gif' }),
      200,
      'upload (gif)',
    );
    eq(g.message.kind, 'animation', 'GIF — animatsiya');
    eq(g.message.media?.inline, false, 'animatsiya inline emas');
    eq(g.message.media?.url, null, "animatsiyada url yo'q");
    eq(g.message.media?.mime_type, 'video/mp4', 'saqlangan MIME — video/mp4');
    eq(callsSince(gifStart, CLIENT, 'sendAnimation').length, 1, 'sendAnimation');
    eq(callsSince(gifStart, CLIENT, 'sendDocument').length, 0, 'hujjat sifatida yuborilmadi');

    const big = await appUpload('staff', OP1, 'upload', { conversationId: convs.c1aziza }, { bytes: new Uint8Array(4 * 1024 * 1024 + 10), name: 'big.bin', type: 'application/octet-stream' });
    eq(expectApi(big, 413, 'katta fayl').error, 'file_too_big', 'kod');
    eq(expectApi(await appUpload('staff', OP1, 'upload', { conversationId: convs.c1aziza }, null), 400, 'faylsiz').error, 'no_file', 'kod');

    // resend: xodim Mini App dan yuklagan rasm faqat mijoz botida bor — xodimlar botiga qayta yuklanadi, keyin keshlanadi
    const jpeg = fakeJpeg({ width: 300, height: 300, size: 3000, seed: 78 });
    const up = expectApi(
      await appUpload('staff', OP1, 'upload', { conversationId: convs.c1aziza, caption: 'Resend uchun' }, { bytes: jpeg, name: 'r.jpg', type: 'image/jpeg' }),
      200,
      'upload (rasm)',
    );
    let s2 = tg.calls.length;
    expectApi(await app('staff', OP1, 'resend', { messageId: up.message.id }), 200, 'resend');
    const r1 = callsSince(s2, STAFF, 'sendPhoto')[0];
    ok(r1?.ok && r1.multipart && bytesEqual(tg.fileBytes(r1.uploaded[0]!), jpeg), 'xodimlar botiga qayta yuklandi');
    includes(tg.lastSent(STAFF, OP1.id)?.text, '📥 Ali Valiyev bilan suhbatdan', 'resend sarlavhasi');
    const row = (await sql`select * from messages where id = ${up.message.id}`)[0];
    eq(row.file_id_staff, r1!.uploaded[0], 'file_id_staff keshlandi');
    s2 = tg.calls.length;
    expectApi(await app('staff', OP1, 'resend', { messageId: up.message.id }), 200, 'resend (2)');
    const r2 = callsSince(s2, STAFF, 'sendPhoto')[0];
    ok(r2?.ok && !r2.multipart && r2.params.photo === row.file_id_staff, 'ikkinchi marta — file_id');
    eq(expectApi(await app('staff', OP1, 'resend', { messageId: 99999999 }), 404, "yo'q xabar").error, 'message_not_found', 'kod');
  });

  await step("oflayn xodim: havola orqali kirishda va avto-javobda oflayn izohi; bot orqali onlaynga qaytish; profil va yordamda mijozlar havolasi", async () => {
    const before = mark('client', C3.id);
    await say('client', C3, `/start staff_${ids.aziza}`);
    const msgs = botMsgsSince('client', C3.id, before);
    eq(msgs.length, 1, 'bitta rasmli xabar');
    eq(msgs[0]!.kind, 'photo', 'rasm bilan');
    eq(
      msgs[0]!.text,
      linkCaption({ client: 'Guli <3', staff: 'Aziza Karimova', role: '👨‍💻 Operator · Katta operator', offline: true }),
      'izohda oflayn holati (ism escape qilingan)',
    );
    ok(isRemoveKeyboardOnly(msgs[0]), 'tugmasiz');
    eq((await clientRow(C3.id)).active_conversation_id, (await convOf(C3.id, ids.aziza))?.id, 'darhol aktiv suhbat');
    const b2 = mark('client', C3.id);
    const staffBefore = mark('staff', OP1.id);
    await say('client', C3, 'Salom');
    const auto = botMsgsSince('client', C3.id, b2)[0]?.text ?? '';
    ok(auto.startsWith('Assalomu alaykum, Guli <3!'), `avto-javob: ${auto.slice(0, 50)}`);
    includes(auto, 'Hozirda Aziza Karimova ish joyida emas', 'oflayn izohi');
    eq(botMsgsSince('staff', OP1.id, staffBefore)[0]?.text, '🆕 👤 Guli <3\nSalom', 'xodimga (HTML belgilar bilan ism)');
    convs.c3aziza = (await convOf(C3.id, ids.aziza)).id;

    await say('staff', OP1, '🔄 Holat');
    includes(lastBot('staff', OP1.id)?.text, 'onlayn', 'onlayn bo\'ldi');
    eq((await staffRow(ids.aziza)).is_online, true, 'bazada onlayn');
    await say('staff', OP1, '/profile');
    const prof = lastBot('staff', OP1.id);
    eq(prof?.kind, 'photo', 'profil — rasm bilan');
    includes(prof?.text, 'Aziza Karimova', 'profil');
    includes(prof?.text, 'Profilni admin tahrirlaydi', 'izoh');
    // Mijozlar uchun shaxsiy havola: nusxalash (copy_text) va ulashish (t.me/share) tugmalari
    includes(prof?.text, `🔗 Mijozlar uchun havolangiz: ${clientLink('aziza')}`, 'profilda mijozlar havolasi');
    includes(prof?.text, 'Mijoz shu havola orqali kirsa, darhol siz bilan chat boshlanadi.', 'havola izohi');
    const copy = prof?.buttons.find((b) => b.text === '📋 Nusxalash');
    eq((copy as any)?.copy_text?.text, clientLink('aziza'), '«📋 Nusxalash» — havola');
    eq(prof?.buttons.find((b) => b.text === '📤 Ulashish')?.url, shareUrlFor(clientLink('aziza')), '«📤 Ulashish» — t.me/share');
    eq(copy?.row, 0, 'havola tugmalari birinchi qatorda');
    eq(findButton(prof, 'chats:0:n')?.row, 1, '«💬 Chatlar» ikkinchi qatorda');
    // Profil kartasidagi «💬 Chatlar» (chats:0:n): rasmli karta o'chirilmaydi, ro'yxat yangi xabarda
    const s0 = tg.calls.length;
    await press('staff', OP1, prof, 'chats:0:n');
    eq(callsSince(s0, STAFF, 'deleteMessage').length, 0, "profil kartasi o'chirilmadi");
    ok(!tg.message(STAFF, OP1.id, prof!.id)?.deleted, 'profil kartasi joyida');
    eq(tg.message(STAFF, OP1.id, prof!.id)?.kind, 'photo', "profil kartasi o'zgarmadi");
    includes(lastBot('staff', OP1.id)?.text, 'Chatlaringiz', "ro'yxat yangi xabarda");
    await say('staff', OP1, 'ℹ️ Yordam');
    includes(lastBot('staff', OP1.id)?.text, 'Javob berishning 3 usuli', 'yordam');
    includes(lastBot('staff', OP1.id)?.text, `🔗 Shaxsiy havolangiz: ${clientLink('aziza')}`, 'yordamda shaxsiy havola');
    includes(lastBot('staff', OP1.id)?.text, 'havola orqali kirgan mijoz hech narsa tanlamasdan darhol siz bilan yozishadi', 'yordamda izoh');
  });

  await step('maxfiylik (Mini App): begona suhbatlar — 403', async () => {
    for (const [action, params] of [
      ['messages', { conversationId: convs.c1aziza }],
      ['send', { conversationId: convs.c1aziza, text: 'hack' }],
      ['sync', { conversationId: convs.c1aziza }],
      ['conversation.open', { conversationId: convs.c1aziza }],
      ['resend', { messageId: uploadedPhotoMsgId }],
    ] as const) {
      const r = await app('staff', OP2, action, params);
      eq(expectApi(r, 403, `OP2 ${action}`).error, 'forbidden', `OP2 ${action} kodi`);
    }
    const ob = expectApi(await app('staff', OP2, 'bootstrap'), 200, 'OP2 bootstrap');
    eq(ob.conversations.length, 0, 'OP2 da begona suhbatlar yo\'q');
    // Mijozlar uchun Mini App umuman yopiq — begona suhbatga ham, o'ziga ham
    for (const [action, params] of [
      ['messages', { conversationId: convs.c1aziza }],
      ['conversation.open', { conversationId: convs.c1aziza }],
      ['send', { conversationId: convs.c1aziza, text: 'hack' }],
    ] as const) {
      eq(expectApi(await app('client', C2, action, params), 403, `C2 ${action}`).error, 'client_app_disabled', `C2 ${action} kodi`);
    }
    const adminRead = await app('staff', ADMIN, 'messages', { conversationId: convs.c1aziza });
    eq(adminRead.status, 403, 'admin ham suhbat mazmunini ko\'ra olmaydi');
    eq(expectApi(await app('staff', OP2, 'messages', { conversationId: 99999999 }), 404, "yo'q suhbat").error, 'not_found', 'kod');
    eq(expectApi(await app('staff', OP2, 'messages', { conversationId: 'abc' }), 400, "noto'g'ri id").error, 'invalid_id', 'kod');
  });

  await step('Mini App (admin): bootstrap, statistika, sozlamalar (escape), xodimni tahrirlash', async () => {
    const b = expectApi(await app('staff', ADMIN, 'bootstrap'), 200, 'admin bootstrap');
    eq(b.me, null, 'admin xodim emas');
    eq(b.is_admin, true, 'is_admin');
    eq(b.client_bot, 'uzgroww_bot', 'client_bot (profilsiz admin ham)');
    const st = expectApi(await app('staff', ADMIN, 'admin.stats'), 200, 'admin.stats');
    eq(st.clients, 3, 'mijozlar');
    eq(st.staff_total, 3, 'xodimlar');
    eq(st.staff_linked, 3, 'ulanganlar');
    eq(st.stats?.clients, 3, 'stats ichma-ich');
    ok(st.messages > 10, 'xabarlar soni');

    const g = expectApi(await app('staff', ADMIN, 'admin.settings.get'), 200, 'settings.get');
    eq(g.welcome, null, 'standart');
    eq(g.defaults.welcome, texts.DEFAULT_WELCOME, 'defaults');
    const setRes = expectApi(await app('staff', ADMIN, 'admin.settings.set', { welcome: 'Xush kelibsiz, {name}! <b> & co' }), 200, 'settings.set');
    eq(setRes.welcome, 'Xush kelibsiz, {name}! <b> & co', 'saqlandi');
    // Mavjud xodim bilan faol suhbati bor mijoz: /start — salomlashuv emas, "Siz … bilan suhbatdasiz" (+ rol tugmalari)
    let before = mark('client', C3.id);
    await say('client', C3, '/start');
    const c3Start = botMsgsSince('client', C3.id, before);
    eq(c3Start.length, 1, 'bitta xabar');
    eq(c3Start[0]!.text, '👋 Siz Aziza Karimova bilan suhbatdasiz — savolingizni shu yerga yozavering.', 'faol suhbat haqida');
    ok(boldName(c3Start[0], 'Aziza Karimova'), 'xodim ismi qalin');
    ok(isRoleRowOnly(c3Start[0]), 'boshqa xodim tanlash uchun rol tugmalari');
    // Faol suhbati yo'q mijoz — sozlangan salomlashuv (HTML escape)
    before = mark('client', C6.id);
    await say('client', C6, '/start');
    const c6Start = botMsgsSince('client', C6.id, before);
    eq(c6Start.length, 1, 'bitta xabar (yangi mijoz)');
    eq(c6Start[0]?.text, 'Xush kelibsiz, Lola <3! <b> & co', 'yangi salomlashuv (escape)');
    ok(isRoleRowOnly(c6Start[0]), 'rol tugmalari');
    const reset = expectApi(await app('staff', ADMIN, 'admin.settings.set', { welcome: '' }), 200, 'settings reset');
    eq(reset.welcome, null, 'standartga qaytdi');
    eq(expectApi(await app('staff', ADMIN, 'admin.settings.set', { welcome: 'x'.repeat(2001) }), 400, 'uzun sozlama').error, 'validation', 'kod');
    eq(expectApi(await app('staff', ADMIN, 'admin.settings.set', {}), 400, "bo'sh").error, 'no_patch', 'kod');

    const up = expectApi(await app('staff', ADMIN, 'admin.staff.update', { id: ids.sardor, patch: { position: 'Bosh operator' } }), 200, 'staff.update');
    eq(up.staff.position, 'Bosh operator', 'lavozim yangilandi');
    eq(expectApi(await app('staff', ADMIN, 'admin.staff.update', { id: ids.sardor, patch: { full_name: 'A' } }), 400, 'qisqa ism').error, 'validation', 'kod');
    eq(expectApi(await app('staff', ADMIN, 'admin.staff.update', { id: ids.sardor, patch: {} }), 400, "bo'sh patch").error, 'no_patch', 'kod');
    eq(expectApi(await app('staff', ADMIN, 'admin.staff.update', { id: 999999, patch: { position: 'x' } }), 404, "yo'q xodim").error, 'staff_not_found', 'kod');
  });

  await step("admin (Mini App): havola nomi — 400 link_invalid, 409 link_taken (boshqa maydonlar saqlanmaydi), 200 (normallashtirish, xodim xabardor), create bilan", async () => {
    const upd = (patch: Record<string, unknown>) => app('staff', ADMIN, 'admin.staff.update', { id: ids.sardor, patch });
    eq((await staffRow(ids.sardor)).link_code, 'sardor', "boshlang'ich nom");
    for (const bad of ['a b', null, '', '   ', 'a', 'staff_12', 'Азиза', 'x'.repeat(33), 'bad!name', 42]) {
      const r = await upd({ link_code: bad });
      eq(expectApi(r, 400, `link_code ${JSON.stringify(bad)}`).error, 'link_invalid', `${JSON.stringify(bad)}: kod`);
      eq(r.body.message, "Havola nomi 2–32 ta lotin harfi, raqam yoki _ bo'lishi kerak", `${JSON.stringify(bad)}: matn`);
    }
    // Band nom (katta-kichik harf farqsiz): 409 va shu patch dagi boshqa maydonlar ham saqlanmaydi
    const taken = await upd({ link_code: 'BOBUR', position: 'Yangi lavozim' });
    eq(expectApi(taken, 409, 'band nom').error, 'link_taken', 'kod');
    eq(taken.body.message, 'Bu havola nomi band', 'matn');
    let row = await staffRow(ids.sardor);
    eq(row.link_code, 'sardor', "nom o'zgarmadi");
    eq(row.position, 'Bosh operator', 'boshqa maydon ham saqlanmadi');

    // To'g'ri nom: trim, @ va katta harflar normallashtiriladi; ulangan xodim (OP2) xabardor qilinadi
    let opMark = mark('staff', OP2.id);
    const okr = expectApi(await upd({ link_code: '  @Sardor_Op ' }), 200, "to'g'ri nom");
    eq(okr.staff.link_code, 'sardor_op', 'link_code');
    eq(okr.staff.client_link, clientLink('sardor_op'), 'client_link');
    eq((await staffRow(ids.sardor)).link_code, 'sardor_op', 'bazada');
    let note = botMsgsSince('staff', OP2.id, opMark);
    eq(note.length, 1, 'xodimga bitta xabarnoma');
    includes(note[0]!.text, `🔗 Admin mijozlar uchun havolangizni o'zgartirdi:\n${clientLink('sardor_op')}`, 'xabarnoma');
    // Xuddi shu nom — o'zgarishsiz, xabarnoma yo'q
    opMark = mark('staff', OP2.id);
    eq(expectApi(await upd({ link_code: 'SARDOR_OP' }), 200, 'xuddi shu nom').staff.link_code, 'sardor_op', 'o\'zgarmadi');
    eq(botMsgsSince('staff', OP2.id, opMark).length, 0, "o'zgarmagan nom — xabarnoma yo'q");
    // patch siz (yuqori darajadagi link_code) ham qabul qilinadi; boshqa maydon bilan birga
    const top = expectApi(await app('staff', ADMIN, 'admin.staff.update', { id: ids.sardor, link_code: 'sardor' }), 200, 'patch siz');
    eq(top.staff.link_code, 'sardor', 'qaytarildi');
    eq(botMsgsSince('staff', OP2.id, opMark).length, 1, 'qaytarishda ham xabarnoma');
    const both = expectApi(await upd({ position: 'Bosh operator', link_code: 'sardor' }), 200, 'lavozim + o\'sha nom');
    eq(both.staff.position, 'Bosh operator', 'lavozim');
    eq(expectApi(await upd({}), 400, "bo'sh patch").error, 'no_patch', 'kod');
    eq(
      expectApi(await app('staff', ADMIN, 'admin.staff.update', { id: 999999, patch: { link_code: 'yangi_nom' } }), 404, "yo'q xodim").error,
      'staff_not_found',
      'kod',
    );
    eq(
      expectApi(await app('staff', OP1, 'admin.staff.update', { id: ids.sardor, patch: { link_code: 'x_1' } }), 403, 'oddiy xodim').error,
      'admin_only',
      'kod',
    );
    row = await staffRow(ids.sardor);
    eq(row.link_code, 'sardor', 'yakuniy nom');

    // Yangi xodim: ixtiyoriy link_code; band/noto'g'ri bo'lsa ham xodim qo'shiladi, avtomatik nom qoladi + ogohlantirish
    const created: number[] = [];
    try {
      const create = async (params: Record<string, unknown>) => {
        const r = expectApi(await app('staff', ADMIN, 'admin.staff.create', params), 200, `create ${JSON.stringify(params)}`);
        created.push(r.staff.id);
        return r;
      };
      const t1 = await create({ role: 'operator', full_name: 'Aziza Ikkinchi', link_code: 'AZIZA' });
      eq(t1.staff.link_code, 'aziza2', 'band — avtomatik nom qoldi');
      eq(t1.staff.client_link, clientLink('aziza2'), 'client_link');
      eq(t1.warning_code, 'link_taken', 'warning_code');
      eq(t1.warning, "⚠️ Xodim qo'shildi, lekin «aziza» havola nomi band. Avtomatik nom qoldirildi: aziza2", 'warning');
      const t2 = await create({ role: 'manager', full_name: 'Bobur Boss', link_code: '  @Bobur_Boss ' });
      eq(t2.staff.link_code, 'bobur_boss', "o'z nomi (normallashtirilgan)");
      eq(t2.warning, undefined, "ogohlantirish yo'q");
      const t3 = await create({ role: 'operator', full_name: 'Test Xato', link_code: 'a b' });
      eq(t3.staff.link_code, 'test', "noto'g'ri — avtomatik nom qoldi");
      eq(t3.warning_code, 'link_invalid', 'warning_code');
      eq(
        t3.warning,
        "⚠️ Xodim qo'shildi, lekin havola nomi noto'g'ri (2–32 ta lotin harfi, raqam yoki _ bo'lishi kerak). Avtomatik nom qoldirildi: test",
        'warning',
      );
      const t4 = await create({ role: 'operator', full_name: 'Omad Yangi', link_code: '' });
      eq(t4.staff.link_code, 'omad', "bo'sh — avtomatik nom");
      eq(t4.warning, undefined, "bo'sh — ogohlantirish yo'q");
      const t5 = await create({ role: 'operator', full_name: 'Omad Boshqa', link_code: null });
      eq(t5.staff.link_code, 'omad2', 'null — avtomatik nom (band — raqam bilan)');
      eq(t5.warning, undefined, "null — ogohlantirish yo'q");
    } finally {
      for (const id of created) await sql`delete from staff where id = ${id}`;
    }
  });
}

async function adminBotSettingsTests(): Promise<void> {
  await step('admin (bot): umumiy matnlar (saqlash, standartga qaytarish), /cancel, statistika', async () => {
    await say('staff', ADMIN, '/admin');
    const home = lastBot('staff', ADMIN.id)!;
    await press('staff', ADMIN, home, 'adm:set:welcome');
    includes(tg.message(STAFF, ADMIN.id, home.id)?.text, 'Salomlashuv matni', 'sozlama so\'rovi');
    let before = mark('staff', ADMIN.id);
    await say('staff', ADMIN, 'Salom {name}, xush kelibsiz! <3');
    const saved = botMsgsSince('staff', ADMIN.id, before).pop();
    includes(saved?.text, 'saqlandi', 'saqlandi');
    includes(saved?.text, 'Salom Aziz, xush kelibsiz! <3', 'namuna (escape)');
    eq((await sql`select value from settings where key = ${texts.SETTING_KEYS.welcome}`)[0]?.value, 'Salom {name}, xush kelibsiz! <3', 'bazada');
    const c6Before = mark('client', C6.id);
    await say('client', C6, '/start');
    eq(botMsgsSince('client', C6.id, c6Before)[0]?.text, 'Salom Lola <3, xush kelibsiz! <3', 'mijoz yangi matnni oldi');

    await press('staff', ADMIN, saved, 'adm:set:welcome');
    await press('staff', ADMIN, tg.message(STAFF, ADMIN.id, saved!.id), 'adm:reset:welcome');
    // O'zgartirilgan matn qaytarib bo'lmas darajada o'chadi — avval tasdiqlash so'raladi
    const confirmReset = tg.message(STAFF, ADMIN.id, saved!.id);
    includes(confirmReset?.text, 'qaytarilsinmi', "tasdiqlash so'raldi");
    includes(confirmReset?.text, 'Salom {name}, xush kelibsiz! <3', "joriy matn ko'rsatildi");
    eq((await sql`select count(*)::int as n from settings where key = ${texts.SETTING_KEYS.welcome}`)[0]!.n, 1, "tasdiqlashgacha o'chirilmadi");
    await press('staff', ADMIN, confirmReset, 'adm:resetok:welcome');
    const resetDone = tg.message(STAFF, ADMIN.id, saved!.id);
    includes(resetDone?.text, 'standart holatga qaytarildi', 'standartga qaytdi');
    includes(resetDone?.text, 'Salom {name}, xush kelibsiz! <3', 'oldingi matn nusxa olish uchun ko\'rsatildi');
    eq((await sql`select count(*)::int as n from settings where key = ${texts.SETTING_KEYS.welcome}`)[0]!.n, 0, 'sozlama o\'chirildi');

    await say('staff', ADMIN, '/admin');
    const home2 = lastBot('staff', ADMIN.id)!;
    await press('staff', ADMIN, home2, 'adm:set:offline');
    before = mark('staff', ADMIN.id);
    await say('staff', ADMIN, '/cancel');
    includes(textsSince('staff', ADMIN.id, before), 'Bekor qilindi', '/cancel');
    eq((await sql`select count(*)::int as n from user_state where bot = 'staff'`)[0]!.n, 0, 'admin holati tozalandi (/cancel)');
    before = mark('staff', ADMIN.id);
    await say('staff', ADMIN, 'Bu oddiy matn');
    eq(
      (await sql`select count(*)::int as n from settings where key = ${texts.SETTING_KEYS.offlineNote}`)[0]!.n,
      0,
      'bekor qilingandan keyin matn sozlama sifatida saqlanmadi',
    );

    // Muddati o'tgan (15 daqiqadan eski) kiritish: matn sozlama sifatida saqlanmaydi, so'rov tugmalari olinadi
    await say('staff', ADMIN, '/admin');
    const h3 = lastBot('staff', ADMIN.id)!;
    await press('staff', ADMIN, h3, 'adm:set:offline');
    ok(tg.message(STAFF, ADMIN.id, h3.id)!.buttons.length > 0, "so'rov tugmalari bor");
    await sql`update user_state set updated_at = now() - interval '20 minutes' where bot = 'staff' and tg_user_id = ${ADMIN.id}`;
    before = mark('staff', ADMIN.id);
    await say('staff', ADMIN, 'Eskirgan kiritish matni');
    eq(
      (await sql`select count(*)::int as n from settings where key = ${texts.SETTING_KEYS.offlineNote}`)[0]!.n,
      0,
      "muddati o'tgan kiritish saqlanmadi",
    );
    includes(textsSince('staff', ADMIN.id, before), "muddati o'tgani uchun bekor qilindi", 'ogohlantirish');
    eq(tg.message(STAFF, ADMIN.id, h3.id)!.buttons.length, 0, "so'rov tugmalari olib tashlandi");
    eq((await sql`select count(*)::int as n from user_state where bot = 'staff'`)[0]!.n, 0, "holat o'chirildi");

    // So'rov xabarining tugmalari bekor qilishda olib tashlangan — statistika tugmasini shu xabar ustida bosamiz
    await forge('staff', ADMIN, home2, 'adm:stats');
    const stats = tg.message(STAFF, ADMIN.id, home2.id);
    includes(stats?.text, 'Statistika', 'statistika');
    // C1, C2, C3 va salomlashuvni tekshirgan C6 (Mini App ni ochgan C9 bazaga yozilmagan)
    includes(stats?.text, 'Mijozlar: 4', 'mijozlar soni');
    includes(stats?.text, 'Aziza Karimova', 'xodimlar bo\'yicha');
    ok(!findButton(stats, 'noop') && !findButton(stats, 'adm:stats:1'), "bitta sahifa — sahifa tugmalari yo'q");

    // 30 dan ko'p xodim — statistika sahifalanadi (⬅️ n/N ➡️), «🔄 Yangilash» joriy sahifada qoladi
    try {
      await sql`insert into staff (role, full_name) select 'operator', 'Stat ' || lpad(g::text, 2, '0') from generate_series(1, 31) g`;
      const n = (await sql`select count(*)::int as n from staff where deleted_at is null`)[0]!.n;
      const pages = Math.ceil(n / 30);
      eq(pages, 2, 'ikki sahifa');
      await forge('staff', ADMIN, home2, 'adm:stats');
      let s = tg.message(STAFF, ADMIN.id, home2.id)!;
      includes(s.text, `1–30 / ${n}`, '1-sahifa diapazoni');
      ok(findButton(s, 'adm:stats:1'), '➡️ tugmasi');
      ok(s.buttons.some((b) => b.text === `1/${pages}` && b.callback_data === 'noop'), 'sahifa belgisi');
      ok(!s.buttons.some((b) => b.text === '⬅️'), "1-sahifada ⬅️ (oldingi sahifa) yo'q");
      await press('staff', ADMIN, s, 'adm:stats:1');
      s = tg.message(STAFF, ADMIN.id, home2.id)!;
      includes(s.text, `31–${n} / ${n}`, '2-sahifa diapazoni');
      ok(findButton(s, 'adm:stats:0'), '⬅️ tugmasi');
      ok(s.buttons.some((b) => b.text === `2/${pages}`), 'sahifa belgisi 2/N');
      const refresh = s.buttons.find((b) => b.text === '🔄 Yangilash');
      eq(refresh?.callback_data, 'adm:stats:1', 'Yangilash sahifani saqlaydi');
      await press('staff', ADMIN, s, '🔄 Yangilash');
      includes(tg.message(STAFF, ADMIN.id, home2.id)?.text, `31–${n} / ${n}`, 'yangilangandan keyin ham 2-sahifa');
    } finally {
      await sql`delete from staff where full_name like 'Stat %' and tg_user_id is null`;
    }
  });

  await step("sozlamalar: bazada to'g'ridan-to'g'ri o'zgartirilgan salomlashuv /start da darhol ko'rinadi (instansiya keshi yo'q)", async () => {
    // Kesh bo'lganida — shu yerda «isiydi»
    await say('client', C6, '/start');
    try {
      await sql`
        insert into settings (key, value) values (${texts.SETTING_KEYS.welcome}, 'DB {name}')
        on conflict (key) do update set value = excluded.value, updated_at = now()`;
      const b = mark('client', C6.id);
      await say('client', C6, '/start');
      eq(botMsgsSince('client', C6.id, b)[0]?.text, 'DB Lola <3', 'bazadagi yangi matn darhol ishlatildi');
      // v1 dagi standart matn («📱 Menyu», pastki tugmalar) sozlamada qolgan bo'lsa — yangi qisqa standart ko'rsatiladi
      await sql`update settings set value = ${LEGACY_DEFAULT_WELCOME} where key = ${texts.SETTING_KEYS.welcome}`;
      const bl = mark('client', C6.id);
      await say('client', C6, '/start');
      eq(botMsgsSince('client', C6.id, bl)[0]?.text, welcomeFor('Lola <3'), 'eski standart matn — yangi standart bilan almashtirildi');
    } finally {
      await sql`delete from settings where key = ${texts.SETTING_KEYS.welcome}`;
    }
    const b2 = mark('client', C6.id);
    await say('client', C6, '/start');
    const w = botMsgsSince('client', C6.id, b2)[0]?.text ?? '';
    eq(w, welcomeFor('Lola <3'), "o'chirilgandan keyin standart matn");
  });

  await step("admin (bot): albom (3 ta rasm) lavozim bosqichida — faqat BITTA qayta so'rov", async () => {
    await say('staff', ADMIN, '/admin');
    const h = lastBot('staff', ADMIN.id)!;
    await press('staff', ADMIN, h, 'adm:add');
    await press('staff', ADMIN, tg.message(STAFF, ADMIN.id, h.id), 'adm:addrole:operator');
    await say('staff', ADMIN, 'Albom Sinov');
    includes(lastBot('staff', ADMIN.id)?.text, '3/6', "lavozim so'rovi");
    const b = mark('staff', ADMIN.id);
    for (let i = 0; i < 3; i++) {
      await say('staff', ADMIN, { photo: tg.photo(STAFF, fakeJpeg({ seed: 90 + i })), media_group_id: 'e2e-album-1' });
    }
    const re = botMsgsSince('staff', ADMIN.id, b);
    eq(re.length, 1, "albomga bitta qayta so'rov");
    includes(re[0]!.text, 'matn yuboring', "qayta so'rov matni");
    includes(re[0]!.text, '3/6', "o'sha bosqich");
    await say('staff', ADMIN, 'Lavozim OK');
    includes(lastBot('staff', ADMIN.id)?.text, '4/6', 'albomdan keyin matn qabul qilindi');
    await say('staff', ADMIN, '/cancel');
    eq((await sql`select count(*)::int as n from user_state where bot = 'staff'`)[0]!.n, 0, 'holat tozalandi');
    eq((await sql`select count(*)::int as n from staff where full_name = 'Albom Sinov'`)[0]!.n, 0, 'xodim yaratilmadi');
  });

  await step("admin (bot): createStaff xatosi — qoralama rasm bosqichida saqlanadi, qayta urinishda xodim qo'shiladi", async () => {
    const fn = `${SCHEMA}.e2e_fail_staff`;
    await sql.unsafe(
      `create or replace function ${fn}() returns trigger language plpgsql as $$ begin raise exception 'e2e: createStaff xatosi'; end $$`,
    );
    await sql.unsafe(
      `create trigger e2e_fail_staff before insert on ${SCHEMA}.staff for each row when (new.full_name = 'Xato Sinov') execute function ${fn}()`,
    );
    let triggerOn = true;
    try {
      await say('staff', ADMIN, '/admin');
      const h = lastBot('staff', ADMIN.id)!;
      await press('staff', ADMIN, h, 'adm:add');
      await press('staff', ADMIN, tg.message(STAFF, ADMIN.id, h.id), 'adm:addrole:manager');
      await say('staff', ADMIN, 'Xato Sinov');
      await say('staff', ADMIN, '-');
      await say('staff', ADMIN, '-');
      const greetPrompt = lastBot('staff', ADMIN.id);
      includes(greetPrompt?.text, '5/6', "avto-javob so'rovi");
      await press('staff', ADMIN, greetPrompt, 'adm:skip:greeting');
      const photoPrompt = tg.message(STAFF, ADMIN.id, greetPrompt!.id);
      includes(photoPrompt?.text, '6/6', "rasm so'rovi");
      const q = await press('staff', ADMIN, photoPrompt, 'adm:skip:photo');
      eq(answerOf(q).show_alert, true, 'xato — alert');
      includes(answerOf(q).text, 'Saqlanmadi', 'xato matni');
      eq((await sql`select count(*)::int as n from staff where full_name = 'Xato Sinov'`)[0]!.n, 0, 'xodim yaratilmadi');
      const st = (await sql`select state from user_state where bot = 'staff' and tg_user_id = ${ADMIN.id}`)[0]?.state as any;
      eq(st?.step, 'add', 'qoralama saqlandi (step)');
      eq(st?.stage, 'photo', 'rasm bosqichida');
      eq(st?.draft?.full_name, 'Xato Sinov', 'qoralama ismi');
      includes(tg.message(STAFF, ADMIN.id, greetPrompt!.id)?.text, '6/6', "so'rov joyida qoldi");

      await sql.unsafe(`drop trigger e2e_fail_staff on ${SCHEMA}.staff`);
      triggerOn = false;
      const q2 = await press('staff', ADMIN, tg.message(STAFF, ADMIN.id, greetPrompt!.id), 'adm:skip:photo');
      includes(answerOf(q2).text, "Xodim qo'shildi", 'qayta urinish muvaffaqiyatli');
      const row = (await sql`select * from staff where full_name = 'Xato Sinov'`)[0];
      ok(row, 'xodim yaratildi');
      eq(row.role, 'manager', 'rol qoralamadan');
      eq((await sql`select count(*)::int as n from user_state where bot = 'staff'`)[0]!.n, 0, 'holat tozalandi');
    } finally {
      if (triggerOn) await sql.unsafe(`drop trigger if exists e2e_fail_staff on ${SCHEMA}.staff`).catch(() => {});
      await sql.unsafe(`drop function if exists ${fn}()`).catch(() => {});
      // Keyingi qadamlar xodimlar ro'yxatini aniq tekshiradi
      await sql`delete from staff where full_name = 'Xato Sinov'`;
      await sql`delete from user_state where bot = 'staff' and tg_user_id = ${ADMIN.id}`;
    }
  });
}

/** Xodimning shaxsiy havolasi (/start <nom>) orqali kirish va sodda mijozlar boti (v2). */
async function linkEntryTests(): Promise<void> {
  await step("havola: yangi mijoz /start aziza — tanlovsiz darhol suhbat, BITTA rasmli xabar (tugmasiz, remove_keyboard); birinchi xabar — bitta avto-javob va Azizaga", async () => {
    const aziza = await staffRow(ids.aziza);
    ok(aziza.is_online && !aziza.bot_blocked, 'Aziza onlayn');
    const start = tg.calls.length;
    const before = mark('client', C7.id);
    await say('client', C7, '/start aziza');
    const msgs = botMsgsSince('client', C7.id, before);
    eq(msgs.length, 1, "bitta xabar (salomlashuv va menyu yo'q)");
    const m = msgs[0]!;
    eq(m.kind, 'photo', 'xodim rasmi bilan');
    eq(m.text, linkCaption({ client: 'Kamola', staff: 'Aziza Karimova', role: '👨‍💻 Operator · Katta operator' }), 'izoh');
    ok(boldName(m, 'Aziza Karimova'), 'xodim ismi qalin');
    ok(isRemoveKeyboardOnly(m), `remove_keyboard, inline tugmasiz: ${JSON.stringify(m.markup)}`);
    excludes(m.text, "Kim bilan bog'lanmoqchisiz", "salomlashuv matni yo'q");
    eq(tg.keyboard(CLIENT, C7.id), null, "doimiy klaviatura yo'q");
    eq(callsSince(start, CLIENT, 'sendPhoto')[0]?.params.photo, aziza.client_photo_file_id, 'keshlangan rasm (mijoz boti file_id)');
    eq(callsSince(start, CLIENT, 'sendMessage').length, 0, "matnli xabar yuborilmadi");
    const conv = await convOf(C7.id, ids.aziza);
    ok(conv, 'suhbat yaratildi');
    convs.c7aziza = conv.id;
    eq(conv.last_message_at, null, "hali xabar yo'q");
    eq((await clientRow(C7.id)).active_conversation_id, conv.id, 'aktiv suhbat');

    const cb = mark('client', C7.id);
    const sb = mark('staff', OP1.id);
    await say('client', C7, 'Salom, havola orqali keldim');
    const toClient = botMsgsSince('client', C7.id, cb);
    eq(toClient.length, 1, "mijozga faqat avto-javob («boshqa xodimga ketdi» izohi yo'q)");
    eq(toClient[0]!.text, texts.fill(texts.DEFAULT_GREETING, { name: 'Kamola', staff: 'Aziza Karimova' }), 'avto-javob');
    const toStaff = botMsgsSince('staff', OP1.id, sb);
    eq(toStaff.length, 1, 'xodimga bitta xabar');
    eq(toStaff[0]!.text, '🆕 👤 Kamola · @kamola_k\nSalom, havola orqali keldim', 'Azizaga yetkazildi');
    ok(findButton(toStaff[0], `act:${conv.id}`), '«↩️ Javob berish»');
    eq(await countMessages(conv.id, 'bot'), 1, 'bitta avto-javob');
    eq(await countMessages(conv.id, 'client'), 1, 'mijoz xabari saqlandi');

    const cb2 = mark('client', C7.id);
    await say('client', C7, 'Yana bir savol');
    eq(botMsgsSince('client', C7.id, cb2).length, 0, 'ikkinchi xabarga javob yo\'q');
    eq(await countMessages(conv.id, 'bot'), 1, 'avto-javob takrorlanmadi');
  });

  await step("havola: katta harf (/start AZIZA — «Siz yana …»), /start STAFF_<id> (rasmsiz — avatar); oddiy /start va /menu — «Siz … bilan suhbatdasiz» + faqat rol tugmalari", async () => {
    let before = mark('client', C7.id);
    await say('client', C7, '/start AZIZA');
    let msgs = botMsgsSince('client', C7.id, before);
    eq(msgs.length, 1, 'bitta xabar');
    eq(msgs[0]!.kind, 'photo', 'rasm');
    eq(
      msgs[0]!.text,
      linkCaption({ client: 'Kamola', staff: 'Aziza Karimova', role: '👨‍💻 Operator · Katta operator', existing: true }),
      'mavjud suhbat — «Siz yana … bilan suhbatdasiz»',
    );
    ok(isRemoveKeyboardOnly(msgs[0]), 'tugmasiz');
    eq((await clientRow(C7.id)).active_conversation_id, convs.c7aziza, 'aktiv — Aziza');

    const placeholder = (await sql`select value from settings where key = ${texts.SETTING_KEYS.placeholderPhoto}`)[0]?.value;
    const start = tg.calls.length;
    before = mark('client', C7.id);
    await say('client', C7, `/start STAFF_${ids.bobur}`);
    msgs = botMsgsSince('client', C7.id, before);
    eq(msgs.length, 1, 'bitta xabar (STAFF_<id>)');
    eq(msgs[0]!.kind, 'photo', 'standart avatar bilan');
    eq(callsSince(start, CLIENT, 'sendPhoto')[0]?.params.photo, placeholder, 'keshlangan standart avatar');
    eq(msgs[0]!.text, linkCaption({ client: 'Kamola', staff: 'Bobur Aliyev', role: '👔 Menejer' }), 'izoh (menejer, lavozimsiz)');
    const c7bobur = await convOf(C7.id, ids.bobur);
    ok(c7bobur, 'Bobur bilan suhbat');
    convs.c7bobur = c7bobur.id;
    eq((await clientRow(C7.id)).active_conversation_id, convs.c7bobur, 'aktiv — Bobur');

    for (const cmd of ['/start', '/menu']) {
      before = mark('client', C7.id);
      await say('client', C7, cmd);
      msgs = botMsgsSince('client', C7.id, before);
      eq(msgs.length, 1, `${cmd}: bitta xabar`);
      eq(msgs[0]!.text, '👋 Siz Bobur Aliyev bilan suhbatdasiz — savolingizni shu yerga yozavering.', `${cmd}: faol suhbat`);
      ok(boldName(msgs[0], 'Bobur Aliyev'), `${cmd}: ism qalin`);
      ok(isRoleRowOnly(msgs[0]), `${cmd}: faqat rol tugmalari: ${JSON.stringify(msgs[0]!.markup)}`);
      excludes(msgs[0]!.text, 'Asosiy menyu', `${cmd}: eski menyu yo'q`);
    }
    eq(tg.keyboard(CLIENT, C7.id), null, "doimiy klaviatura hech qachon yuborilmadi");
    eq((await clientRow(C7.id)).active_conversation_id, convs.c7bobur, "/start faol suhbatni o'zgartirmaydi");
  });

  await step("havola: tugmasiz bot xabarlariga Reply (havola xabari, «suhbatdasiz», «✍️ Yozish» tasdig'i) — qalin ism bo'yicha o'sha xodimga, so'rovsiz", async () => {
    const sent = tg.sent(CLIENT, C7.id);
    const azizaCard = [...sent].reverse().find((m) => m.kind === 'photo' && m.text.includes('Siz yana Aziza Karimova'));
    const boburCard = [...sent].reverse().find((m) => m.kind === 'photo' && m.text.includes('Siz Bobur Aliyev'));
    const startMsg = [...sent].reverse().find((m) => m.text.includes('bilan suhbatdasiz — savolingizni'));
    ok(azizaCard && boburCard && startMsg, 'bot xabarlari topildi');

    // 1) Aktiv — Bobur, lekin Aziza havola xabariga Reply — Azizaga, aktiv almashadi
    let cb = mark('client', C7.id);
    let op = mark('staff', OP1.id);
    let mg = mark('staff', MGR.id);
    await say('client', C7, { text: 'Azizaga Reply orqali', replyTo: azizaCard!.id });
    eq(textsSince('staff', OP1.id, op), '👤 Kamola · @kamola_k\nAzizaga Reply orqali', 'Aziza oldi');
    eq(botMsgsSince('staff', MGR.id, mg).length, 0, 'Bobur olmadi');
    let toClient = textsSince('client', C7.id, cb);
    excludes(toClient, 'Bu xabar kimga', "so'rov yo'q");
    includes(toClient, 'Endi xabarlaringiz Aziza Karimovaga yuboriladi', 'faol suhbat almashdi');
    eq((await clientRow(C7.id)).active_conversation_id, convs.c7aziza, 'aktiv — Aziza');

    // 2) «Siz Bobur Aliyev bilan suhbatdasiz» (faqat rol tugmali) xabariga Reply — Boburga (birinchi xabar: avto-javob)
    cb = mark('client', C7.id);
    op = mark('staff', OP1.id);
    mg = mark('staff', MGR.id);
    await say('client', C7, { text: 'Boburga Reply orqali', replyTo: startMsg!.id });
    eq(textsSince('staff', MGR.id, mg), '🆕 👤 Kamola · @kamola_k\nBoburga Reply orqali', 'Bobur oldi');
    eq(botMsgsSince('staff', OP1.id, op).length, 0, 'Aziza olmadi');
    toClient = textsSince('client', C7.id, cb);
    excludes(toClient, 'Bu xabar kimga', "so'rov yo'q");
    includes(toClient, 'Salom Kamola! Men Bobur Aliyev, tez orada javob beraman.', 'Boburning avto-javobi');
    includes(toClient, 'Endi xabarlaringiz Bobur Aliyevga yuboriladi', 'faol suhbat almashdi');
    eq((await clientRow(C7.id)).active_conversation_id, convs.c7bobur, 'aktiv — Bobur');

    // 3) «✍️ Yozish» (tanlov) — suhbat davom etmoqda; keyin Bobur havola xabariga Reply; so'ng tasdiqqa Reply — Azizaga
    await say('client', C7, '/operators');
    await press('client', C7, lastBot('client', C7.id), `card:${ids.aziza}`);
    cb = mark('client', C7.id);
    await press('client', C7, lastBot('client', C7.id), `pick:${ids.aziza}`);
    const picked = botMsgsSince('client', C7.id, cb);
    eq(picked.length, 1, 'bitta tasdiq');
    eq(
      picked[0]!.text,
      "✅ Siz yana Aziza Karimova (Operator) bilan bog'landingiz — suhbat davom etmoqda.\n✍️ Savolingizni yozing.",
      'tasdiq (mavjud suhbat)',
    );
    ok(isRemoveKeyboardOnly(picked[0]), 'tasdiq tugmasiz');
    mg = mark('staff', MGR.id);
    await say('client', C7, { text: 'Yana Boburga', replyTo: boburCard!.id });
    eq(textsSince('staff', MGR.id, mg), '👤 Kamola · @kamola_k\nYana Boburga', 'Bobur havola xabari orqali — Bobur');
    eq((await clientRow(C7.id)).active_conversation_id, convs.c7bobur, 'aktiv — Bobur');
    op = mark('staff', OP1.id);
    cb = mark('client', C7.id);
    await say('client', C7, { text: 'Tasdiqqa Reply', replyTo: picked[0]!.id });
    eq(textsSince('staff', OP1.id, op), '👤 Kamola · @kamola_k\nTasdiqqa Reply', 'tasdiq orqali — Aziza');
    excludes(textsSince('client', C7.id, cb), 'Bu xabar kimga', "so'rov yo'q");
    eq((await clientRow(C7.id)).active_conversation_id, convs.c7aziza, 'aktiv — Aziza');
  });

  await step("havola: noma'lum / yaroqsiz kod — izoh + oddiy /start (salomlashuv va rol tugmalari), suhbat yaratilmaydi; eskirgan tugma; bo'sh «Suhbatlarim»", async () => {
    for (const payload of ['nobody', 'inv_x', 'staff_999999', 'a', 'Aziza Karimova', 'aziza_op']) {
      const before = mark('client', C8.id);
      await say('client', C8, `/start ${payload}`);
      const msgs = botMsgsSince('client', C8.id, before);
      eq(msgs.length, 1, `${payload}: bitta xabar`);
      eq(msgs[0]!.text, `${LINK_NOT_FOUND}\n\n${welcomeFor('Jasur')}`, `${payload}: izoh + salomlashuv`);
      ok(isRoleRowOnly(msgs[0]), `${payload}: rol tugmalari`);
    }
    eq((await sql`select count(*)::int as n from conversations where client_id = ${C8.id}`)[0]!.n, 0, "suhbat yaratilmadi");
    eq((await clientRow(C8.id)).active_conversation_id, null, "aktiv suhbat yo'q");
    // Bo'sh «Suhbatlarim» (eski tugma) — Mini App tugmasisiz
    await say('client', C8, '💬 Suhbatlarim');
    const empty = lastBot('client', C8.id);
    includes(empty?.text, "Sizda hali suhbatlar yo'q", "bo'sh ro'yxat");
    ok(isRoleRowOnly(empty), "faqat rol tugmalari (📱 Menyuni ochish yo'q)");
    // Eskirgan / noma'lum tugma — /start ga ishora
    const q = await forge('client', C8, lastBot('client', C8.id)!, 'eski:tugma');
    eq(answerOf(q).text, "Bu tugma eskirgan. /start buyrug'ini yuboring.", 'eskirgan tugma javobi');
  });

  await step("eski (v1) mijoz: doimiy pastki menyu bir marta olib tashlanadi (/start), «✍️ Yozish» va havola orqali — jimgina", async () => {
    // v1 mijozlarida pastki klaviatura qolgan (migratsiyada belgi true)
    await sql`update clients set legacy_keyboard = true where tg_user_id = ${C8.id}`;
    let before = mark('client', C8.id);
    await say('client', C8, '/start');
    let msgs = botMsgsSince('client', C8.id, before);
    eq(msgs.length, 2, 'bir martalik izoh + /start javobi');
    eq(msgs[0]!.text, '✨ Bot yangilandi — endi yanada sodda. Pastdagi eski menyu olib tashlandi.', 'izoh');
    ok(isRemoveKeyboardOnly(msgs[0]), 'izoh — remove_keyboard bilan');
    eq(msgs[1]!.text, welcomeFor('Jasur'), 'keyin odatdagi salomlashuv');
    ok(isRoleRowOnly(msgs[1]), 'rol tugmalari');
    eq((await clientRow(C8.id)).legacy_keyboard, false, 'belgi olib tashlandi');
    before = mark('client', C8.id);
    await say('client', C8, '/start');
    eq(botMsgsSince('client', C8.id, before).length, 1, 'ikkinchi /start — bitta xabar');

    // «✍️ Yozish»: tasdiqning o'zi remove_keyboard bilan — qo'shimcha izoh yo'q
    await say('client', C8, '/operators');
    await press('client', C8, lastBot('client', C8.id), `card:${ids.aziza}`);
    await sql`update clients set legacy_keyboard = true where tg_user_id = ${C8.id}`;
    before = mark('client', C8.id);
    const q = await press('client', C8, lastBot('client', C8.id), `pick:${ids.aziza}`);
    eq(answerOf(q).text, '✅ Tanlandi', 'callback javobi');
    msgs = botMsgsSince('client', C8.id, before);
    eq(msgs.length, 1, 'faqat tasdiq');
    eq(msgs[0]!.text, "✅ Siz Aziza Karimova (Operator) bilan bog'landingiz.\n✍️ Savolingizni yozing.", 'tasdiq (yangi suhbat)');
    ok(isRemoveKeyboardOnly(msgs[0]), 'tasdiq — remove_keyboard, tugmasiz');
    eq((await clientRow(C8.id)).legacy_keyboard, false, 'belgi jimgina olib tashlandi');
    eq((await clientRow(C8.id)).active_conversation_id, (await convOf(C8.id, ids.aziza))?.id, 'aktiv — Aziza');

    // Havola orqali kirish ham remove_keyboard bilan — qo'shimcha izoh yo'q
    await sql`update clients set legacy_keyboard = true where tg_user_id = ${C8.id}`;
    before = mark('client', C8.id);
    await say('client', C8, '/start bobur');
    msgs = botMsgsSince('client', C8.id, before);
    eq(msgs.length, 1, 'faqat havola xabari');
    ok(isRemoveKeyboardOnly(msgs[0]), 'remove_keyboard');
    eq((await clientRow(C8.id)).legacy_keyboard, false, 'belgi jimgina olib tashlandi (havola)');
  });
}

/**
 * Qadam yarim yo'lda yiqilsa ham keyingi qadamlar uchun Aziza (OP1) yana yetib boriladigan bo'lsin: chat blokdan
 * chiqariladi va «member» update i yuboriladi (belgi olinadi, navbat yetkaziladi).
 */
async function restoreAzizaReachable(): Promise<void> {
  const blocked = tg.isBlocked(STAFF, OP1.id) || !!(await staffRow(ids.aziza).catch(() => null))?.bot_blocked;
  if (blocked) await postUpdate('staff', tg.myChatMemberUpdate(STAFF, OP1, 'member')).catch(() => {});
}

function restoringAziza(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    try {
      await fn();
    } finally {
      await restoreAzizaReachable();
    }
  };
}

/** Xodimga yetkazish kafolatlari: xodim botni bloklagan/to'xtatgan, Telegram 429/5xx, avto-javob 5xx. */
async function staffPresenceTests(): Promise<void> {
  await step("xodim botni bloklagan (403, my_chat_member kelmagan): mijozga izoh bir marta, oflayn, adminlar bir marta, Mini App ogohlantirishi; qaytganda navbat tartib bilan", restoringAziza(async () => {
    await clearRates();
    await sql`update clients set active_conversation_id = ${convs.c2aziza} where tg_user_id = ${C2.id}`;
    const start0 = await staffRow(ids.aziza);
    eq(start0.bot_blocked, false, "boshlang'ich holat — bloklanmagan");
    const onlineBefore = start0.is_online as boolean;

    // Xodim botni bloklaydi, lekin my_chat_member update i yetib kelmaydi — relay 403 ni o'zi aniqlashi kerak
    tg.myChatMemberUpdate(STAFF, OP1, 'kicked');
    ok(tg.isBlocked(STAFF, OP1.id), 'chat bloklandi');
    const adminMark = mark('staff', ADMIN.id);
    const opMark = mark('staff', OP1.id);
    let before = mark('client', C2.id);
    await say('client', C2, 'Bloklangan Azizaga 1');
    const r = await staffRow(ids.aziza);
    eq(r.bot_blocked, true, '403 → bot_blocked');
    eq(r.is_online, false, "mijozlarga oflayn ko'rinadi");
    const note = botMsgsSince('client', C2.id, before);
    eq(note.length, 1, 'mijozga bitta izoh');
    includes(note[0]!.text, "hozircha yetkazib bo'lmadi", 'yetkazilmadi izohi');
    ok(findButton(note[0], 'ls:operator'), 'boshqa xodimni tanlash tugmalari');

    before = mark('client', C2.id);
    await say('client', C2, 'Bloklangan Azizaga 2');
    excludes(textsSince('client', C2.id, before), "hozircha yetkazib bo'lmadi", 'izoh ketma-ket takrorlanmaydi');
    before = mark('client', C2.id);
    await say('client', C2, 'Bloklangan Azizaga 3');
    excludes(textsSince('client', C2.id, before), "hozircha yetkazib bo'lmadi", 'izoh uchinchi xabarda ham takrorlanmaydi');

    // Havola orqali kirgan mijoz ham xodimni oflayn ko'radi; Mini App (admin) ro'yxatida — oflayn
    const offBefore = mark('client', C6.id);
    await say('client', C6, '/start aziza');
    includes(botMsgsSince('client', C6.id, offBefore)[0]?.text, OFFLINE_LINE, 'havola xabarida oflayn izohi (bloklangan)');
    const adminList = expectApi(await app('staff', ADMIN, 'admin.staff.list'), 200, 'admin.staff.list');
    eq(adminList.staff.find((x: any) => x.id === ids.aziza)?.is_online, false, 'Mini App (admin): xodim oflayn');

    eq(textsSince('staff', ADMIN.id, adminMark).split("to'xtatgan yoki bloklagan").length - 1, 1, 'admin bir marta ogohlantirildi');
    eq(botMsgsSince('staff', OP1.id, opMark).length, 0, 'xodimga hech narsa yetmadi');
    eq(
      (await sql`select count(*)::int as n from messages where conversation_id = ${convs.c2aziza} and text like 'Bloklangan Azizaga%' and staff_chat_msg_id is null`)[0]!.n,
      3,
      'uchala xabar navbatda',
    );

    // Xodim qaytdi (my_chat_member → member): belgi olinadi, onlayn holati tiklanadi, navbat tartib bilan yetkaziladi
    const opBack = mark('staff', OP1.id);
    await postUpdate('staff', tg.myChatMemberUpdate(STAFF, OP1, 'member'));
    const back = await staffRow(ids.aziza);
    eq(back.bot_blocked, false, 'belgi olindi');
    eq(back.is_online, onlineBefore, 'onlayn holati tiklandi');
    includes(textsSince('staff', ADMIN.id, adminMark), 'xodimlar botiga qaytdi', 'admin xabardor qilindi (qaytdi)');
    const got = botMsgsSince('staff', OP1.id, opBack);
    eq(got.length, 3, 'uchala xabar yetkazildi');
    for (let i = 0; i < 3; i++) {
      ok(got[i]!.text.endsWith(`Bloklangan Azizaga ${i + 1}`), `${i + 1}-xabar tartib bilan: ${got[i]!.text.slice(-40)}`);
      includes(got[i]!.text, '🕐', `${i + 1}-xabar — kechikkan sarlavha`);
      ok(findButton(got[i], `act:${convs.c2aziza}`), `${i + 1}-xabar «↩️ Javob berish» bilan`);
    }
    eq(
      (await sql`select count(*)::int as n from messages where conversation_id = ${convs.c2aziza} and text like 'Bloklangan Azizaga%' and staff_chat_msg_id is null`)[0]!.n,
      0,
      'hammasi yetkazildi',
    );
  }), { allowFailedCalls: (c) => c.token === STAFF && c.error?.error_code === 403 });

  await step("xodim botni to'xtatdi (my_chat_member kicked): navbat, izoh bir marta, adminlar bir marta; «member» yoki /start bilan qaytganda navbat bir marta, tartib bilan", restoringAziza(async () => {
    eq((await clientRow(C3.id)).active_conversation_id, convs.c3aziza, 'C3 aktiv — Aziza');
    eq((await staffRow(ids.aziza)).is_online, true, 'Aziza onlayn');
    let adm = mark('staff', ADMIN.id);
    await postUpdate('staff', tg.myChatMemberUpdate(STAFF, OP1, 'kicked'));
    let row = await staffRow(ids.aziza);
    eq(row.bot_blocked, true, 'kicked → bot_blocked');
    eq(row.is_online, false, 'oflayn');
    const warnCount = () => textsSince('staff', ADMIN.id, adm).split("xodimlar botini to'xtatgan").length - 1;
    eq(warnCount(), 1, 'admin ogohlantirildi');

    const cb = mark('client', C3.id);
    await say('client', C3, 'navbat 1');
    await say('client', C3, 'navbat 2');
    const toClient = botMsgsSince('client', C3.id, cb);
    eq(toClient.length, 1, 'mijozga faqat bitta izoh');
    includes(toClient[0]!.text, "hozircha yetkazib bo'lmadi", 'yetkazilmadi izohi');
    eq(warnCount(), 1, 'admin faqat bir marta ogohlantirildi');
    const queued = await sql`
      select text, staff_chat_msg_id from messages
      where conversation_id = ${convs.c3aziza} and text in ('navbat 1', 'navbat 2') order by id`;
    eq(queued.length, 2, 'ikkala xabar saqlandi');
    ok(queued.every((q: any) => q.staff_chat_msg_id == null), 'ikkalasi ham navbatda');
    const adminList = expectApi(await app('staff', ADMIN, 'admin.staff.list'), 200, 'admin.staff.list');
    eq(adminList.staff.find((x: any) => x.id === ids.aziza)?.is_online, false, 'Mini App (admin): xodim oflayn');

    // Qaytish: my_chat_member → member
    let sb = mark('staff', OP1.id);
    await postUpdate('staff', tg.myChatMemberUpdate(STAFF, OP1, 'member'));
    const re = botMsgsSince('staff', OP1.id, sb);
    eq(re.length, 2, 'ikkala xabar yetkazildi');
    ok(re[0]!.text.endsWith('navbat 1') && re[1]!.text.endsWith('navbat 2'), `tartib: ${re.map((m) => m.text.slice(-8)).join(' | ')}`);
    ok(re.every((m) => m.text.includes('🕐')), 'kechikkan sarlavha (🕐)');
    ok(re.every((m) => findButton(m, `act:${convs.c3aziza}`)), '«↩️ Javob berish» tugmalari');
    includes(textsSince('staff', ADMIN.id, adm), 'xodimlar botiga qaytdi', 'admin: qaytdi');
    row = await staffRow(ids.aziza);
    eq(row.bot_blocked, false, 'belgi olindi');
    eq(row.is_online, true, 'onlayn holati tiklandi');
    // Keyingi /start — hech narsa qayta yuborilmaydi
    sb = mark('staff', OP1.id);
    await say('staff', OP1, '/start');
    excludes(textsSince('staff', OP1.id, sb), 'navbat', 'navbat qayta yetkazilmadi');
    // Xodim /start: mijozlar uchun shaxsiy havola va izoh
    includes(textsSince('staff', OP1.id, sb), `🔗 Mijozlar uchun havolangiz: ${clientLink('aziza')}\n${LINK_HINT}`, '/start da mijozlar havolasi');

    // Qisqa variant: «member» kelmagan, xodim shunchaki /start bosadi
    adm = mark('staff', ADMIN.id);
    await postUpdate('staff', tg.myChatMemberUpdate(STAFF, OP1, 'kicked'));
    eq((await staffRow(ids.aziza)).bot_blocked, true, 'yana bloklandi');
    await say('client', C3, 'navbat 3');
    eq(
      (await sql`select staff_chat_msg_id from messages where conversation_id = ${convs.c3aziza} and text = 'navbat 3'`)[0]?.staff_chat_msg_id,
      null,
      'navbat 3 kutmoqda',
    );
    tg.unblockChat(STAFF, OP1.id);
    sb = mark('staff', OP1.id);
    await say('staff', OP1, '/start');
    const re3 = botMsgsSince('staff', OP1.id, sb);
    eq(re3.filter((m) => m.text.includes('navbat 3')).length, 1, 'navbat 3 bir marta yetkazildi');
    const iQueued = re3.findIndex((m) => m.text.endsWith('navbat 3'));
    const iWelcome = re3.findIndex((m) => m.text.includes('Assalomu alaykum'));
    ok(iQueued >= 0 && iWelcome > iQueued, `navbat /start javobidan oldin yetkazildi (${iQueued}, ${iWelcome})`);
    row = await staffRow(ids.aziza);
    eq(row.bot_blocked, false, '/start — belgi olindi');
    eq(row.is_online, true, '/start — onlayn holati tiklandi');
    includes(textsSince('staff', ADMIN.id, adm), 'xodimlar botiga qaytdi', 'admin: qaytdi (/start)');
  }), { allowFailedCalls: (c) => c.token === STAFF && c.error?.error_code === 403 });

  await step("Telegram 429 (retry_after 30): xabar jimgina navbatda qoladi va keyingi xabardan OLDIN tartib bilan yetkaziladi", async () => {
    tg.failNext(
      STAFF,
      'sendMessage',
      { error_code: 429, description: 'Too Many Requests: retry after 30', parameters: { retry_after: 30 } },
      { when: (p) => Number(p.chat_id) === OP1.id },
    );
    const cb = mark('client', C3.id);
    const sb = mark('staff', OP1.id);
    const start = tg.calls.length;
    await say('client', C3, 'flood 1');
    eq(callsSince(start, STAFF, 'sendMessage').length, 1, '30 s kutilmaydi — shu so\'rovda qayta urinish yo\'q');
    eq(botMsgsSince('staff', OP1.id, sb).length, 0, 'xodimga hali yetmadi');
    eq(botMsgsSince('client', C3.id, cb).length, 0, "vaqtinchalik xato — mijozga izoh yo'q");
    const row = (await sql`
      select id, staff_chat_msg_id, delivery_claimed_at from messages
      where conversation_id = ${convs.c3aziza} and text = 'flood 1'`)[0];
    ok(row, 'saqlandi');
    eq(row.staff_chat_msg_id, null, 'yetkazilmagan');
    ok(row.delivery_claimed_at, "band qilingan (~2 daqiqadan keyin navbatga qaytadi)");
    // Band qilish muddati (2 daqiqa) o'tdi
    await sql`update messages set delivery_claimed_at = now() - interval '3 minutes' where id = ${row.id}`;
    await say('client', C3, 'flood 2');
    const got = botMsgsSince('staff', OP1.id, sb);
    eq(got.length, 2, 'ikkalasi yetkazildi');
    ok(got[0]!.text.endsWith('flood 1') && got[0]!.text.includes('🕐'), `1-si — kechikkan «flood 1»: ${got[0]!.text}`);
    ok(got[1]!.text.endsWith('flood 2') && !got[1]!.text.includes('🕐'), `2-si — «flood 2»: ${got[1]!.text}`);
    ok(got[0]!.id < got[1]!.id, 'tartib saqlandi');
    eq(botMsgsSince('client', C3.id, cb).length, 0, "mijozga hech narsa yuborilmadi");
    eq(
      (await sql`select count(*)::int as n from messages where conversation_id = ${convs.c3aziza} and text like 'flood %' and staff_chat_msg_id is null`)[0]!.n,
      0,
      'navbat bo\'sh',
    );
  }, { allowFailedCalls: (c) => c.token === STAFF && c.error?.error_code === 429 });

  await step("Telegram 5xx (502): xodimga yuborish bir marta darhol qayta urinadi — xabar bir marta yetadi, mijozga izoh yo'q", async () => {
    tg.failNext(STAFF, 'sendMessage', { error_code: 502, description: 'Bad Gateway' }, { when: (p) => String(p.text ?? '').includes('502 test') });
    const start = tg.calls.length;
    const sb = mark('staff', OP1.id);
    const cb = mark('client', C3.id);
    await say('client', C3, '502 test');
    const attempts = callsSince(start, STAFF, 'sendMessage').filter((c) => String(c.params.text ?? '').includes('502 test'));
    eq(attempts.length, 2, 'bitta qayta urinish');
    eq(attempts[0]!.error?.error_code, 502, '1-urinish — 502');
    ok(attempts[1]!.ok, '2-urinish muvaffaqiyatli');
    const got = botMsgsSince('staff', OP1.id, sb);
    eq(got.length, 1, 'xodimga bir marta');
    eq(got[0]!.text, '👤 Guli <3\n502 test', 'matn');
    eq(botMsgsSince('client', C3.id, cb).length, 0, "mijozga izoh yo'q");
    const saved = (await sql`select staff_chat_msg_id, delivery_claimed_at from messages where conversation_id = ${convs.c3aziza} and text = '502 test'`)[0];
    eq(saved?.staff_chat_msg_id, got[0]!.id, 'yetkazilgan deb saqlandi');
  }, { allowFailedCalls: (c) => c.token === STAFF && c.error?.error_code === 502 });

  await step("avto-javob Telegram 5xx da yuborilmadi — belgi qaytariladi, keyingi xabarda bir marta yuboriladi", async () => {
    let before = mark('client', C5.id);
    await say('client', C5, `/start staff_${ids.aziza}`);
    const linkMsgs = botMsgsSince('client', C5.id, before);
    eq(linkMsgs.length, 1, 'havola — bitta xabar');
    includes(linkMsgs[0]?.text, "Siz Aziza Karimova bilan bog'landingiz.", 'havola xabari');
    eq((await clientRow(C5.id)).active_conversation_id, (await convOf(C5.id, ids.aziza))?.id, 'tanlovsiz aktiv suhbat');
    // Avto-javob ikkala urinishda ham 500 (transformer bir marta qayta urinadi)
    tg.failNext(CLIENT, 'sendMessage', { error_code: 500, description: 'Internal Server Error' }, { times: 2, when: (p) => Number(p.chat_id) === C5.id });
    const sb = mark('staff', OP1.id);
    before = mark('client', C5.id);
    await say('client', C5, 'birinchi');
    eq(botMsgsSince('client', C5.id, before).length, 0, 'avto-javob yuborilmadi');
    eq(textsSince('staff', OP1.id, sb), '🆕 👤 Olim\nbirinchi', 'xodim xabarni oldi');
    const conv = await convOf(C5.id, ids.aziza);
    ok(conv, 'suhbat');
    eq(conv.auto_replied, false, 'avto-javob belgisi qaytarildi');
    eq(await countMessages(conv.id, 'bot'), 0, "bot yozuvi yo'q");

    before = mark('client', C5.id);
    await say('client', C5, 'ikkinchi');
    const toClient = botMsgsSince('client', C5.id, before);
    eq(toClient.length, 1, 'faqat avto-javob');
    ok(toClient[0]!.text.startsWith('Assalomu alaykum, Olim!'), `avto-javob: ${toClient[0]!.text.slice(0, 50)}`);
    eq((await convRow(conv.id)).auto_replied, true, 'auto_replied');
    eq(await countMessages(conv.id, 'bot'), 1, 'bitta avto-javob yozuvi');
    includes(textsSince('staff', OP1.id, sb), 'ikkinchi', 'xodim ikkinchisini ham oldi');

    before = mark('client', C5.id);
    await say('client', C5, 'uchinchi');
    eq(botMsgsSince('client', C5.id, before).length, 0, 'avto-javob qayta yuborilmadi');
  }, { allowFailedCalls: (c) => c.token === CLIENT && c.error?.error_code === 500 });
}

async function blockedAndLifecycleTests(): Promise<void> {
  await step('mijoz botni bloklagan: xodimga «Mijoz botni bloklagan», xabar saqlanadi', async () => {
    await postUpdate('client', tg.myChatMemberUpdate(CLIENT, C1, 'kicked'));
    eq((await clientRow(C1.id)).bot_blocked, true, 'my_chat_member kicked → bot_blocked');
    const reply = await say('staff', OP1, { text: 'Bloklangan mijozga javob', replyTo: relayed.c1photo });
    const warn = lastBot('staff', OP1.id);
    includes(warn?.text, 'Mijoz botni bloklagan', 'ogohlantirish');
    eq((warn?.message as any)?.reply_to_message?.message_id, reply.message_id, 'xodim xabariga reply');
    eq((await sql`select count(*)::int as n from messages where text = 'Bloklangan mijozga javob'`)[0]!.n, 1, 'xabar saqlandi');
    // Yetkazilmagan xabar tahrirlandi — mijozga hech narsa, xodimga ✏️ izoh
    const eb = mark('staff', OP1.id);
    const es = tg.calls.length;
    await edit('staff', OP1, reply.message_id, { text: 'Bloklangan mijozga javob (tahrir)' });
    const editNote = botMsgsSince('staff', OP1.id, eb);
    eq(editNote.length, 1, 'bitta izoh');
    includes(editNote[0]!.text, 'asl xabar ham mijozga yetkazilmagan', 'yetkazilmagan xabar tahriri');
    eq((editNote[0]!.message as any)?.reply_to_message?.message_id, reply.message_id, 'izoh tahrirlangan xabarga reply');
    eq(callsSince(es, CLIENT).length, 0, "mijoz botiga murojaat yo'q");
    const r = expectApi(await app('staff', OP1, 'send', { conversationId: convs.c1aziza, text: 'Mini App: bloklangan' }), 200, 'send');
    eq(r.delivered, false, 'yetkazilmadi');
    includes(r.warning, 'bloklagan', 'warning');
    // Mijozlar Mini App i o'chirilgan: so'rov rad etiladi va bot_blocked belgisini tiklamaydi
    eq(expectApi(await app('client', C1, 'bootstrap'), 403, 'mijoz Mini App').error, 'client_app_disabled', 'kod');
    eq((await clientRow(C1.id)).bot_blocked, true, 'Mini App ochilishi bloklash belgisini o\'zgartirmaydi');
    await postUpdate('client', tg.myChatMemberUpdate(CLIENT, C1, 'member'));
    eq((await clientRow(C1.id)).bot_blocked, false, 'member → blokdan chiqdi');
  }, { allowFailedCalls: (c) => c.token === CLIENT && c.error?.error_code === 403 });

  await step('admin ham xodim: kutilayotgan admin amali mijozga yo\'naltirishdan ustun', async () => {
    const created = expectApi(await app('staff', ADMIN, 'admin.staff.create', { role: 'manager', full_name: 'Admin Menejer' }), 200, 'create');
    ids.adminMgr = created.staff.id;
    invites.adminMgr = inviteCodeFrom(created.staff.invite_link);
    const adminLink = mark('staff', ADMIN.id);
    await say('staff', ADMIN, `/start inv_${invites.adminMgr}`);
    includes(textsSince('staff', ADMIN.id, adminLink), 'Tabriklaymiz', 'admin xodim sifatida ulandi');
    includes(JSON.stringify(tg.keyboard(STAFF, ADMIN.id)), '⚙️ Admin panel', 'admin-xodim klaviaturasi');

    const before = mark('client', C3.id);
    await say('client', C3, `/start staff_${ids.adminMgr}`);
    const linkMsgs = botMsgsSince('client', C3.id, before);
    eq(linkMsgs.length, 1, 'havola — bitta xabar');
    eq(linkMsgs[0]!.text, linkCaption({ client: 'Guli <3', staff: 'Admin Menejer', role: '👔 Menejer' }), 'havola xabari');
    const staffBefore = mark('staff', ADMIN.id);
    await say('client', C3, 'Admin, salom');
    const rel = botMsgsSince('staff', ADMIN.id, staffBefore)[0];
    includes(rel?.text, 'Admin, salom', 'adminga yetkazildi');
    relayed.c3admin = rel!.id;
    convs.c3admin = (await convOf(C3.id, ids.adminMgr)).id;

    await say('staff', ADMIN, '/admin');
    const home = lastBot('staff', ADMIN.id);
    await press('staff', ADMIN, home, 'adm:list');
    await press('staff', ADMIN, tg.message(STAFF, ADMIN.id, home!.id), `adm:s:${ids.adminMgr}`);
    const cardMsg = lastBot('staff', ADMIN.id);
    includes(cardMsg?.text, 'Admin Menejer', 'karta');
    await press('staff', ADMIN, cardMsg, `adm:e:${ids.adminMgr}:position`);
    includes(lastBot('staff', ADMIN.id)?.text, 'lavozimni', 'tahrir so\'rovi');

    const c3Before = mark('client', C3.id);
    const count = await countMessages(convs.c3admin);
    await say('staff', ADMIN, { text: 'Bu mijozga ketmasligi kerak', replyTo: relayed.c3admin });
    includes(lastBot('staff', ADMIN.id)?.text, 'tugallanmagan admin amali', 'ogohlantirish');
    ok(findButton(lastBot('staff', ADMIN.id), `to:${convs.c3admin}`), 'Reply qilingan mijozga yuborish tugmasi');
    // Hech bir suhbatga bog'lanmagan bot xabariga Reply — «yuborish» taklif qilinmaydi (aktiv suhbatga taxmin yo'q)
    const adminFirst = tg.sent(STAFF, ADMIN.id)[0]!;
    await say('staff', ADMIN, { text: "Noma'lum xabarga javob", replyTo: adminFirst.id });
    const warn2 = lastBot('staff', ADMIN.id);
    includes(warn2?.text, 'tugallanmagan admin amali', 'ogohlantirish (2)');
    ok(!warn2!.buttons.some((b) => /^to:/.test(b.callback_data ?? '')), "aniqlanmagan Reply — mijozga yuborish tugmasi yo'q");
    ok(findButton(warn2, /^adm:save:/), 'admin amali uchun saqlash tugmasi');
    await say('staff', ADMIN, 'Bosh menejer');
    eq((await staffRow(ids.adminMgr)).position, 'Bosh menejer', 'lavozim saqlandi');
    eq(botMsgsSince('client', C3.id, c3Before).length, 0, 'mijozga hech narsa ketmadi');
    eq(await countMessages(convs.c3admin), count, 'suhbatga hech narsa saqlanmadi');

    await say('staff', ADMIN, { text: 'Endi mijozga', replyTo: relayed.c3admin });
    eq(botMsgsSince('client', C3.id, c3Before).map((m) => m.text).join('|'), '👔 Admin Menejer\nEndi mijozga', 'holat yo\'q — mijozga yetkazildi');
  });

  await step('admin (bot): xodimni o\'chirib qo\'yish — mijoz yoza olmaydi, ro\'yxatda ko\'rinmaydi', async () => {
    const before = mark('client', C2.id);
    await say('client', C2, '/operators');
    await press('client', C2, lastBot('client', C2.id), `card:${ids.sardor}`);
    await press('client', C2, lastBot('client', C2.id), `pick:${ids.sardor}`);
    const opBefore = mark('staff', OP2.id);
    await say('client', C2, 'Sardor, salom');
    const sardorRel = botMsgsSince('staff', OP2.id, opBefore)[0];
    includes(sardorRel?.text, 'Sardor, salom', 'Sardorga yetkazildi');
    convs.c2sardor = (await convOf(C2.id, ids.sardor)).id;
    ok(botMsgsSince('client', C2.id, before).length > 0, 'C2 xabarlari');

    await say('staff', ADMIN, '/admin');
    const home = lastBot('staff', ADMIN.id);
    await press('staff', ADMIN, home, 'adm:list');
    const list = tg.message(STAFF, ADMIN.id, home!.id);
    includes(list?.text, 'Xodimlar', 'ro\'yxat');
    await press('staff', ADMIN, list, `adm:s:${ids.sardor}`);
    const card = lastBot('staff', ADMIN.id);
    eq(card?.kind, 'photo', 'Sardor kartasi rasm bilan');
    const opNote = mark('staff', OP2.id);
    const q = await press('staff', ADMIN, card, `adm:act:${ids.sardor}`);
    includes(answerOf(q).text, "O'chirib qo'yildi", 'javob');
    includes(botMsgsSince('staff', OP2.id, opNote)[0]?.text, "o'chirib qo'yildi", 'xodim xabardor qilindi');
    eq((await staffRow(ids.sardor)).is_active, false, 'bazada o\'chirilgan');
    eq((await clientRow(C2.id)).active_conversation_id, null, 'deaktivatsiyada darhol tozalandi (updateStaff)');

    // «💬 Suhbatlarim»: o'chirilgan xodim 🚫 bilan, «✅ — faol suhbat» izohi yo'q
    await say('client', C2, '💬 Suhbatlarim');
    let chats = lastBot('client', C2.id);
    includes(chats?.text, '🚫 — xodim hozir mavjud emas', '🚫 izohi');
    excludes(chats?.text, 'faol suhbat', "✅ izohi yo'q");
    ok(findButton(chats, `conv:${convs.c2sardor}`)?.text.startsWith('🚫'), 'Sardor tugmasi 🚫 bilan');
    const azBtn = findButton(chats, `conv:${convs.c2aziza}`);
    ok(azBtn && !azBtn.text.startsWith('🚫') && !azBtn.text.startsWith('✅'), 'Aziza tugmasi belgisiz');
    // Eskirgan aktiv suhbat (xodimi mavjud emas) ro'yxat ko'rsatilganda tozalanadi
    await sql`update clients set active_conversation_id = ${convs.c2sardor} where tg_user_id = ${C2.id}`;
    await say('client', C2, '💬 Suhbatlarim');
    chats = lastBot('client', C2.id);
    eq((await clientRow(C2.id)).active_conversation_id, null, 'eskirgan aktiv suhbat tozalandi');
    excludes(chats?.text, 'faol suhbat', "✅ izohi yo'q (eskirgan aktiv)");
    ok(findButton(chats, `conv:${convs.c2sardor}`)?.text.startsWith('🚫'), 'Sardor tugmasi 🚫 bilan (2)');

    // O'chirib qo'yilgan xodim (OP2) mijozga yoza olmaydi: bot (Reply va Reply'siz) va Mini App — hech narsa saqlanmaydi
    const sardorCount = await countMessages(convs.c2sardor);
    const c2Silent = mark('client', C2.id);
    const inactStart = tg.calls.length;
    const viaReply = await say('staff', OP2, { text: 'Men hali shu yerdaman', replyTo: sardorRel!.id });
    let inact = lastBot('staff', OP2.id);
    includes(inact?.text, "Profilingiz o'chirib qo'yilgan", 'INACTIVE_TEXT (Reply)');
    eq((inact?.message as any)?.reply_to_message?.message_id, viaReply.message_id, 'xodim xabariga reply');
    const plain = await say('staff', OP2, "Reply'siz xabar");
    inact = lastBot('staff', OP2.id);
    includes(inact?.text, "Profilingiz o'chirib qo'yilgan", "INACTIVE_TEXT (Reply'siz)");
    eq((inact?.message as any)?.reply_to_message?.message_id, plain.message_id, "xodim xabariga reply (Reply'siz)");
    const inactApp = await app('staff', OP2, 'send', { conversationId: convs.c2sardor, text: 'Mini App dan' });
    eq(expectApi(inactApp, 403, "o'chirilgan xodim send").error, 'staff_inactive', 'kod');
    eq(await countMessages(convs.c2sardor), sardorCount, 'hech narsa saqlanmadi');
    eq(botMsgsSince('client', C2.id, c2Silent).length, 0, 'mijoz hech narsa olmadi');
    eq(callsSince(inactStart, CLIENT).length, 0, "mijoz botiga murojaat yo'q");

    const c2Before = mark('client', C2.id);
    await say('client', C2, 'Yana salom');
    const warn = botMsgsSince('client', C2.id, c2Before)[0];
    includes(warn?.text, 'Sardor Qodirov hozir mavjud emas', 'staff_unavailable');
    includes(warn?.text, "saqlab qo'yildi", 'xabar keyingi tanlov uchun saqlandi');
    ok(findButton(warn, 'ls:operator'), 'rol tugmalari');
    eq((await clientRow(C2.id)).active_conversation_id, null, 'aktiv suhbat tozalandi');
    await say('client', C2, '/operators');
    excludes(lastBot('client', C2.id)?.text, 'Sardor', 'ro\'yxatda yo\'q');
    // O'chirib qo'yilgan xodimning shaxsiy havolasi ishlamaydi: izoh + oddiy /start (faol suhbat yo'q — salomlashuv)
    for (const payload of ['sardor', `staff_${ids.sardor}`]) {
      const nb = mark('client', C2.id);
      await say('client', C2, `/start ${payload}`);
      const nf = botMsgsSince('client', C2.id, nb);
      eq(nf.length, 1, `${payload}: bitta xabar`);
      eq(nf[0]!.text, `${LINK_NOT_FOUND}\n\n${welcomeFor('Vali')}`, `${payload}: izoh + salomlashuv`);
      ok(isRoleRowOnly(nf[0]), `${payload}: rol tugmalari`);
    }
    eq((await clientRow(C2.id)).active_conversation_id, null, "havola aktiv suhbat yaratmadi");
    const q2 = await forge('client', C2, lastBot('client', C2.id)!, `pick:${ids.sardor}`);
    eq(answerOf(q2).show_alert, true, 'o\'chirilgan xodimni tanlab bo\'lmaydi');
  });

  await step('admin (bot): akkauntni uzish — mijoz yoza olmaydi, aktiv suhbatlar tozalanadi, shaxsiy havola ishlamaydi', async () => {
    const activeBefore = (await clientRow(C1.id)).active_conversation_id;
    ok(activeBefore != null && activeBefore !== convs.c1bobur, 'aktiv — boshqa (mavjud) xodim');
    // Mijoz Boburning shaxsiy havolasi orqali qaytadi: suhbat bor — «Siz yana …», Bobur aktiv bo'ladi
    const routeBefore = mark('client', C1.id);
    await say('client', C1, '/start BOBUR');
    const back = botMsgsSince('client', C1.id, routeBefore);
    eq(back.length, 1, 'bitta xabar');
    eq(back[0]!.kind, 'photo', 'rasmli');
    eq(back[0]!.text, linkCaption({ client: 'Ali', staff: 'Bobur Aliyev', role: '👔 Menejer', existing: true }), 'mavjud suhbat izohi');
    eq((await clientRow(C1.id)).active_conversation_id, convs.c1bobur, 'aktiv — Bobur');

    await say('staff', ADMIN, '/admin');
    const home = lastBot('staff', ADMIN.id);
    await press('staff', ADMIN, home, 'adm:list');
    await press('staff', ADMIN, tg.message(STAFF, ADMIN.id, home!.id), `adm:s:${ids.bobur}`);
    const card = lastBot('staff', ADMIN.id);
    await press('staff', ADMIN, card, `adm:unl:${ids.bobur}`);
    const confirm = lastBot('staff', ADMIN.id);
    includes(confirm?.text, 'akkauntini uzasizmi', 'tasdiqlash');
    // Uzishdan oldin Mini App so'rovi (poller) ishlaydi
    expectApi(await app('staff', MGR, 'sync'), 200, 'sync (ulangan xodim)');
    const mgrBefore = mark('staff', MGR.id);
    await press('staff', ADMIN, confirm, `adm:unlok:${ids.bobur}`);
    includes(botMsgsSince('staff', MGR.id, mgrBefore)[0]?.text, 'uzildi', 'xodim xabardor qilindi');
    const row = await staffRow(ids.bobur);
    eq(row.tg_user_id, null, 'uzildi');
    ok(row.invite_code, 'yangi taklif kodi');
    eq((await clientRow(C1.id)).active_conversation_id, null, 'mijozning aktiv suhbati tozalandi');

    // Akkaunti uzilgan xodimning havolasi ishlamaydi (nom saqlanadi — qayta ulanganda yana ishlaydi)
    eq((await staffRow(ids.bobur)).link_code, 'bobur', 'havola nomi saqlanib qoldi');
    const nb = mark('client', C1.id);
    await say('client', C1, '/start bobur');
    const nf = botMsgsSince('client', C1.id, nb);
    eq(nf.length, 1, 'bitta xabar');
    eq(nf[0]!.text, `${LINK_NOT_FOUND}\n\n${welcomeFor('Ali')}`, 'izoh + salomlashuv (faol suhbat yo\'q)');
    ok(isRoleRowOnly(nf[0]), 'rol tugmalari');
    eq(await convOf(C1.id, ids.bobur).then((c) => c?.id), convs.c1bobur, "yangi suhbat yaratilmadi");
    const before = mark('client', C1.id);
    await say('client', C1, { text: 'Bobur, javob bering', replyTo: inClient.boburReply });
    includes(botMsgsSince('client', C1.id, before)[0]?.text, 'Bu xodim hozir mavjud emas', "Reply orqali ham yozib bo'lmaydi");
    includes(botMsgsSince('client', C1.id, before)[0]?.text, "saqlab qo'yildi", 'xabar keyingi tanlov uchun saqlandi');
    const b2 = mark('client', C1.id);
    await say('client', C1, 'Kimga ketadi?');
    includes(botMsgsSince('client', C1.id, b2)[0]?.text, 'Avval kim bilan yozishmoqchi ekaningizni tanlang', 'aktiv suhbatsiz');
    await say('staff', MGR, 'salom');
    includes(lastBot('staff', MGR.id)?.text, 'faqat xodimlar uchun', 'uzilgan akkaunt endi xodim emas');
    eq(expectApi(await app('staff', MGR, 'bootstrap'), 403, 'uzilgan xodim Mini App').error, 'not_staff', 'kod');
    // Ochiq Mini App ning davriy sync so'rovi ham 403 not_staff oladi (frontend kirishni yopadi)
    eq(expectApi(await app('staff', MGR, 'sync'), 403, 'uzilgan xodim sync').error, 'not_staff', 'kod (sync)');
    eq(
      expectApi(await app('staff', MGR, 'sync', { conversationId: convs.c1bobur, afterId: 0 }), 403, 'uzilgan xodim sync (ochiq chat)').error,
      'not_staff',
      'kod (sync, ochiq chat)',
    );
  });

  await step('admin: xodimni o\'chirish (Mini App va bot), ro\'yxat va media', async () => {
    // Sardor (o'chirib qo'yilgan, lekin akkaunti ulangan) — o'chirilganda xabardor qilinadi, xodim klaviaturasi olinadi
    const op2Mark = mark('staff', OP2.id);
    const del = expectApi(await app('staff', ADMIN, 'admin.staff.delete', { id: ids.sardor }), 200, 'delete');
    eq(del.deleted, true, 'deleted');
    const delNote = botMsgsSince('staff', OP2.id, op2Mark);
    eq(delNote.length, 1, 'xodimga bitta xabarnoma');
    includes(delNote[0]!.text, "profili o'chirildi", "xabarnoma (profil o'chirildi)");
    ok(delNote[0]!.markup?.remove_keyboard === true, 'xodim klaviaturasi olib tashlandi');
    eq((await mediaGet(`/api/media?staff=${ids.sardor}&v=x`)).status, 404, 'o\'chirilgan xodim rasmi');
    eq(expectApi(await app('staff', ADMIN, 'admin.staff.delete', { id: ids.sardor }), 404, 'qayta o\'chirish').error, 'staff_not_found', 'kod');
    eq(botMsgsSince('staff', OP2.id, op2Mark).length, 1, "qayta o'chirish (404) — yangi xabarnoma yo'q");

    await say('staff', ADMIN, '/admin');
    const home = lastBot('staff', ADMIN.id);
    await press('staff', ADMIN, home, 'adm:list');
    await press('staff', ADMIN, tg.message(STAFF, ADMIN.id, home!.id), `adm:s:${ids.bobur}`);
    // Uzilgan xodim uchun yangi taklif havolasi: eski havola ishlamay qoladi
    const oldCode = (await staffRow(ids.bobur)).invite_code as string;
    const qi = await press('staff', ADMIN, lastBot('staff', ADMIN.id), `adm:inv:${ids.bobur}`);
    includes(answerOf(qi).text, 'Yangi havola', 'javob');
    const newCode = (await staffRow(ids.bobur)).invite_code as string;
    ok(newCode && newCode !== oldCode, 'kod yangilandi');
    includes(lastBot('staff', ADMIN.id)?.text, `inv_${newCode}`, 'kartada yangi havola');
    await say('staff', STRANGER, `/start inv_${oldCode}`);
    includes(lastBot('staff', STRANGER.id)?.text, "noto'g'ri yoki eskirgan", 'eski havola ishlamaydi');
    await press('staff', ADMIN, lastBot('staff', ADMIN.id), `adm:del:${ids.bobur}`);
    const confirm = lastBot('staff', ADMIN.id);
    includes(confirm?.text, "o'chirasizmi", 'tasdiqlash');
    // Callback javobi Telegramda rad etilsa ham (eskirgan query) o'chirish oxirigacha bajariladi
    tg.failNext(STAFF, 'answerCallbackQuery', {
      error_code: 400,
      description: 'Bad Request: query is too old and response timeout expired or query ID is invalid',
    });
    const qDel = await press('staff', ADMIN, confirm, `adm:delok:${ids.bobur}`);
    eq(answerOf(qDel).text, undefined, 'javob Telegramda rad etildi');
    ok(tg.expireCallback(qDel), 'rad etilgan query eskirdi (Telegram uni unutadi)');
    includes(lastBot('staff', ADMIN.id)?.text, "o'chirildi", 'natija');
    ok((await staffRow(ids.bobur)).deleted_at, 'bazada o\'chirilgan');
    const list = expectApi(await app('staff', ADMIN, 'admin.staff.list'), 200, 'list');
    eq(JSON.stringify(list.staff.map((s: any) => s.id).sort()), JSON.stringify([ids.aziza, ids.adminMgr].sort()), 'qolgan xodimlar');
    eq(await countMessages(convs.c1bobur) > 0, true, 'suhbat tarixi saqlanib qoladi');
    // Tarix bot chatida o'qiladi («💬 Suhbatlarim»), lekin xodimga yozib bo'lmaydi
    await say('client', C1, '💬 Suhbatlarim');
    const chats = lastBot('client', C1.id);
    ok(findButton(chats, `conv:${convs.c1bobur}`)?.text.startsWith('🚫'), "o'chirilgan xodim 🚫 bilan");
    await press('client', C1, chats, `conv:${convs.c1bobur}`);
    const hist = lastBot('client', C1.id);
    includes(hist?.text, 'Endi Boburga', "o'chirilgan xodim bilan tarix o'qiladi");
    includes(hist?.text, 'hozir mavjud emas', "yozib bo'lmasligi aytildi");

    // O'chirilgan xodimlarning havola nomlari bo'shatiladi: havolalar ishlamaydi, nomni boshqa xodim olishi mumkin
    eq((await staffRow(ids.bobur)).link_code, null, "Bobur nomi bo'shatildi");
    eq((await staffRow(ids.sardor)).link_code, null, "Sardor nomi bo'shatildi");
    for (const payload of ['bobur', `staff_${ids.bobur}`, 'SARDOR']) {
      const nb = mark('client', C1.id);
      await say('client', C1, `/start ${payload}`);
      const nf = botMsgsSince('client', C1.id, nb);
      eq(nf.length, 1, `${payload}: bitta xabar`);
      ok(nf[0]!.text.startsWith(`${LINK_NOT_FOUND}\n\n`), `${payload}: izoh`);
    }
    const adminCode = (await staffRow(ids.adminMgr)).link_code as string;
    ok(adminCode, 'Admin Menejer havola nomi');
    const reuse = expectApi(await app('staff', ADMIN, 'admin.staff.update', { id: ids.adminMgr, patch: { link_code: 'bobur' } }), 200, "bo'shagan nom");
    eq(reuse.staff.link_code, 'bobur', "bo'shagan nomni boshqa xodim oldi");
    const restore = expectApi(await app('staff', ADMIN, 'admin.staff.update', { id: ids.adminMgr, patch: { link_code: adminCode } }), 200, 'qaytarish');
    eq(restore.staff.link_code, adminCode, 'nom qaytarildi');
  }, { allowFailedCalls: (c) => c.method === 'answerCallbackQuery' && c.error?.error_code === 400 });

  await step('admin (Mini App): akkauntni uzish, taklifni yangilash, rasmni olib tashlash', async () => {
    eq((await clientRow(C3.id)).active_conversation_id, convs.c3admin, 'C3 aktiv — Admin Menejer');
    const adminMark = mark('staff', ADMIN.id);
    const unl = expectApi(await app('staff', ADMIN, 'admin.staff.unlink', { id: ids.adminMgr }), 200, 'unlink');
    eq(unl.staff.linked, false, 'uzildi');
    // O'zini uzgan admin ham xabardor qilinadi; klaviatura — admin klaviaturasi (xodim tugmalarisiz)
    const unlNote = botMsgsSince('staff', ADMIN.id, adminMark);
    eq(unlNote.length, 1, 'bitta xabarnoma');
    includes(unlNote[0]!.text, 'uzildi', 'xabarnoma (akkaunt uzildi)');
    const adminKb = JSON.stringify(tg.keyboard(STAFF, ADMIN.id));
    includes(adminKb, '⚙️ Admin panel', 'admin klaviaturasi qoldi');
    excludes(adminKb, '💬 Chatlar', "xodim tugmalari yo'q");
    ok(String(unl.staff.invite_link).startsWith('https://t.me/uzgrow_staff_bot?start=inv_'), 'yangi taklif havolasi');
    eq((await clientRow(C3.id)).active_conversation_id, null, 'mijozning aktiv suhbati tozalandi');
    const inv = expectApi(await app('staff', ADMIN, 'admin.staff.invite', { id: ids.adminMgr }), 200, 'invite');
    ok(inv.invite_link && inv.invite_link !== unl.staff.invite_link, 'havola yangilandi');
    eq(expectApi(await app('staff', ADMIN, 'bootstrap'), 200, 'bootstrap').me, null, 'admin endi xodim emas');
    // Profilsiz admin — sync 200 (not_staff emas): Mini App ildiz ekranini qayta quradi, kirishni yopmaydi
    const adminSync = expectApi(await app('staff', ADMIN, 'sync'), 200, 'admin (xodim profilisiz) sync');
    ok(Array.isArray(adminSync.conversations) || adminSync.conversations === null, 'admin-only sync javobi');
    eq((adminSync.conversations ?? []).length, 0, "profilsiz admin — suhbatlar yo'q");

    const rm = expectApi(await app('staff', ADMIN, 'admin.staff.photo.remove', { id: ids.aziza }), 200, 'photo.remove');
    eq(rm.staff.photo_url, null, 'photo_url');
    const row = await staffRow(ids.aziza);
    ok(row.photo_file_id === null && row.client_photo_file_id === null, 'rasm va kesh tozalandi');
    eq((await mediaGet(`/api/media?staff=${ids.aziza}&v=x`)).status, 404, 'media 404');
    await say('client', C1, '/operators');
    const start = tg.calls.length;
    await press('client', C1, lastBot('client', C1.id), `card:${ids.aziza}`);
    const send = callsSince(start, CLIENT, 'sendPhoto')[0];
    const placeholder = (await sql`select value from settings where key = ${texts.SETTING_KEYS.placeholderPhoto}`)[0]?.value;
    ok(send?.ok && send.params.photo === placeholder, 'rasmsiz — standart avatar');
  });
}

// ───────────────────────────── Chastota cheklovi yordamchilari ─────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Qat'iy (fixed-window) hisoblagichning joriy oynasida kamida `needSec` soniya qolishini ta'minlash — aks holda
 * keyingi oyna boshlanishini kutamiz (oyna chegarasida hisoblagich nolga tushib, test beqaror bo'lmasin).
 */
async function roomInWindow(windowSec: number, needSec: number): Promise<void> {
  const left = windowSec - ((Date.now() / 1000) % windowSec);
  if (left < needSec) await sleep(Math.ceil((left + 0.5) * 1000));
}

/** Hisoblagichni src/webapp/guards.ts dagi kalit/oyna formatida to'g'ridan-to'g'ri o'rnatish (sekin DB da tez test). */
async function seedRate(key: string, windowSec: number, count: number): Promise<void> {
  const windowStart = new Date(Math.floor(Date.now() / 1000 / windowSec) * windowSec * 1000);
  await sql`
    insert into rate_limits (key, window_start, count) values (${`${key}:${windowSec}`}, ${windowStart}, ${count})
    on conflict (key, window_start) do update set count = excluded.count`;
}

async function clearRates(): Promise<void> {
  await sql`delete from rate_limits`;
}

async function rawApp(kind: Kind, user: TUser, action: string, params: Record<string, unknown>): Promise<{ status: number; headers: Headers; body: any }> {
  const res = await appApi.fetch(
    new Request(`${ORIGIN}/api/app`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initData: initData(kind, user), action, ...params }),
    }),
  );
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
}

async function webappSyncTests(): Promise<void> {
  await step("Mini App: sync — ro'yxat imzosi (listSig): o'zgarmagan ro'yxat qayta yuborilmaydi, list:false", async () => {
    // C2 yana Aziza bilan yozishadi (oldingi qadamda Sardor o'chirib qo'yilib, aktiv suhbati tozalangan edi)
    await sql`update clients set active_conversation_id = ${convs.c2aziza} where tg_user_id = ${C2.id}`;
    await sql`delete from user_state where bot = 'client' and tg_user_id = ${C2.id}`;
    // Xodim (Aziza)
    const s1 = expectApi(await app('staff', OP1, 'sync'), 200, 'sync (imzosiz)');
    ok(Array.isArray(s1.conversations) && s1.conversations.length >= 2, "to'liq ro'yxat");
    ok(typeof s1.list_sig === 'string' && s1.list_sig.length >= 8, `list_sig: ${s1.list_sig}`);
    const boot = expectApi(await app('staff', OP1, 'bootstrap'), 200, 'bootstrap');
    eq(boot.list_sig, s1.list_sig, 'bootstrap va sync imzosi bir xil');
    const s2 = expectApi(await app('staff', OP1, 'sync', { listSig: s1.list_sig }), 200, 'sync (imzo bilan)');
    eq(s2.conversations, null, "o'zgarmagan ro'yxat qayta yuborilmadi");
    eq(s2.list_sig, s1.list_sig, 'imzo qaytarildi');
    const noList = expectApi(await app('staff', OP1, 'sync', { list: false }), 200, 'sync (list:false)');
    eq(noList.conversations, null, "list:false — ro'yxat yo'q");
    eq(noList.list_sig, undefined, "list:false — imzo yo'q");
    const bad = expectApi(await app('staff', OP1, 'sync', { listSig: 'x' }), 200, "sync (noto'g'ri imzo)");
    ok(Array.isArray(bad.conversations), "noto'g'ri imzo e'tiborsiz — to'liq ro'yxat");

    // Yangi xabar (ko'rinish va o'qilmaganlar o'zgaradi) — ro'yxat yangi imzo bilan qaytadi
    const unreadBefore = (await convRow(convs.c2aziza)).unread_staff as number;
    const sb = mark('staff', OP1.id);
    await say('client', C2, 'Imzo tekshiruvi uchun xabar');
    includes(textsSince('staff', OP1.id, sb), 'Imzo tekshiruvi uchun xabar', 'C2 bot orqali yozdi');
    const s3 = expectApi(await app('staff', OP1, 'sync', { listSig: s1.list_sig }), 200, 'sync (yangi xabardan keyin)');
    ok(Array.isArray(s3.conversations) && s3.list_sig !== s1.list_sig, "ro'yxat yangi imzo bilan qaytdi");
    const row = s3.conversations.find((c: any) => c.id === convs.c2aziza);
    eq(row?.last_message_preview, 'Imzo tekshiruvi uchun xabar', "yangi ko'rinish");
    eq(row?.unread, unreadBefore + 1, "o'qilmaganlar");

    // Ochiq chat: sync o'qilgan deb belgilaydi; imzo SHU o'zgarishdan keyin hisoblanadi
    const s4 = expectApi(await app('staff', OP1, 'sync', { conversationId: convs.c2aziza, afterId: 0, listSig: s3.list_sig }), 200, 'sync (ochiq chat)');
    ok(Array.isArray(s4.conversations), "o'qilganlar o'zgardi — ro'yxat qaytdi");
    eq(s4.conversations.find((c: any) => c.id === convs.c2aziza)?.unread, 0, "ochiq chat — o'qildi");
    eq((await convRow(convs.c2aziza)).unread_staff, 0, "bazada o'qildi");
    const s5 = expectApi(await app('staff', OP1, 'sync', { listSig: s4.list_sig }), 200, 'sync (ochiq chatdan keyin)');
    eq(s5.conversations, null, "imzo bazadagi holatga mos — ro'yxat qayta yuborilmadi");

    // Xodimning o'z holati (onlayn/oflayn) — status.set javobidagi profil (havola maydonlari bilan)
    try {
      const off = expectApi(await app('staff', OP1, 'status.set', { online: false }), 200, 'oflayn');
      eq(off.me.is_online, false, 'oflayn');
      eq(off.me.link_code, 'aziza', 'status.set: me.link_code');
      eq(off.me.client_link, clientLink('aziza'), 'status.set: me.client_link');
    } finally {
      expectApi(await app('staff', OP1, 'status.set', { online: true }), 200, 'onlayn');
    }
    // Mijozlar uchun sync ham yopiq
    eq(expectApi(await app('client', C2, 'sync'), 403, 'mijoz sync').error, 'client_app_disabled', 'kod');
  });
}

async function rateLimitTests(): Promise<void> {
  await step("chastota cheklovi (Mini App): send/upload/resend/retry → 429 rate_limited, hech narsa saqlanmaydi va yuborilmaydi", async () => {
    await clearRates();
    // Parallel so'rovlar: hisoblagich atomik — aniq `max` tasiga ruxsat beriladi
    await roomInWindow(60, 15);
    const verdicts = await Promise.all(
      Array.from({ length: 12 }, () => guards.hitRateLimit('e2e:atomic', [{ windowSec: 60, max: 5 }])),
    );
    eq(verdicts.filter((v) => v.allowed).length, 5, "parallel 12 so'rovdan 5 tasi o'tdi");
    ok(verdicts.filter((v) => !v.allowed).every((v) => v.retryAfterSec >= 1 && v.retryAfterSec <= 60), 'retryAfterSec');

    // Xodim send: 60/daqiqa — 60-chisi o'tadi, 61-chisi 429 (Telegramga murojaat yo'q, xabar saqlanmaydi)
    await roomInWindow(60, 25);
    await seedRate(`s:${ids.aziza}:send`, 60, 59);
    expectApi(await app('staff', OP1, 'send', { conversationId: convs.c2aziza, text: 'Limit ichida (60-xabar)' }), 200, '60-xabar');
    const count = await countMessages(convs.c2aziza);
    const start = tg.calls.length;
    const nonce = 'e2e-nonce-limit-0001';
    const r = await rawApp('staff', OP1, 'send', { conversationId: convs.c2aziza, text: 'Limitdan oshdi', clientNonce: nonce });
    eq(r.status, 429, '61-xabar — 429');
    eq(r.body?.ok, false, 'ok=false');
    eq(r.body?.error, 'rate_limited', 'kod');
    ok(Number.isInteger(r.body?.retry_after) && r.body.retry_after >= 1 && r.body.retry_after <= 60, `retry_after: ${r.body?.retry_after}`);
    eq(r.headers.get('retry-after'), String(r.body.retry_after), 'Retry-After sarlavhasi');
    includes(r.body.message, 'Juda tez yuboryapsiz', 'xabar matni');
    eq(await countMessages(convs.c2aziza), count, 'xabar saqlanmadi');
    eq(callsSince(start).length, 0, "Telegramga murojaat yo'q");
    // Mijozning bot chatidagi hisoblagichi alohida — C2 yozishda davom etadi
    const sb = mark('staff', OP1.id);
    await say('client', C2, 'Mijoz limiti alohida');
    includes(textsSince('staff', OP1.id, sb), 'Mijoz limiti alohida', 'mijoz xabari yetkazildi');
    // Limit tugagach xuddi shu nonce bilan qayta urinish o'tadi (limitda da'vo bo'shatilgan)
    await clearRates();
    const countAfterClient = await countMessages(convs.c2aziza);
    const again = expectApi(await app('staff', OP1, 'send', { conversationId: convs.c2aziza, text: 'Limitdan oshdi', clientNonce: nonce }), 200, 'qayta urinish');
    ok(!again.duplicate, 'yangi yuborish (takror emas)');
    eq(await countMessages(convs.c2aziza), countAfterClient + 1, 'endi saqlandi');

    // Soatlik limit ham ishlaydi
    await seedRate(`s:${ids.aziza}:send`, 3600, 1500);
    eq(expectApi(await app('staff', OP1, 'send', { conversationId: convs.c2aziza, text: 'soatlik' }), 429, 'soatlik limit').error, 'rate_limited', 'kod');
    await clearRates();

    // upload: 20/daqiqa
    await roomInWindow(60, 20);
    await seedRate(`s:${ids.aziza}:upload`, 60, 20);
    const c1Count = await countMessages(convs.c1aziza);
    const upStart = tg.calls.length;
    const up = await appUpload('staff', OP1, 'upload', { conversationId: convs.c1aziza }, { bytes: UPLOAD_JPEG, name: 'r.jpg', type: 'image/jpeg' });
    eq(expectApi(up, 429, 'upload').error, 'rate_limited', 'kod');
    eq(callsSince(upStart).length, 0, 'fayl yuklanmadi');
    eq(await countMessages(convs.c1aziza), c1Count, 'saqlanmadi');

    // resend («📥 Botda ochish»): 15/daqiqa
    await seedRate(`s:${ids.aziza}:resend`, 60, 15);
    const rsStart = tg.calls.length;
    const rs = await app('staff', OP1, 'resend', { messageId: uploadedPhotoMsgId });
    eq(expectApi(rs, 429, 'resend').error, 'rate_limited', 'kod');
    includes(rs.body.message, "Juda ko'p so'rov", 'xabar matni');
    eq(callsSince(rsStart).length, 0, 'bot chatiga yuborilmadi');

    // retry (yetkazilmagan xabarni qayta yuborish) send hisoblagichidan foydalanadi
    await seedRate(`s:${ids.aziza}:send`, 60, 60);
    const own = (await sql`select id from messages where conversation_id = ${convs.c1aziza} and sender = 'staff' order by id desc limit 1`)[0];
    eq(expectApi(await app('staff', OP1, 'retry', { messageId: own.id }), 429, 'retry').error, 'rate_limited', 'kod');
    await clearRates();
  });

  await step("chastota cheklovi: media proksi (fayl bo'yicha) va mijozlar boti (xabar yuborilmaydi, ogohlantirish bir marta)", async () => {
    await clearRates();
    // Media: bitta fayl uchun Telegramga (getFile + yuklab olish) murojaatlar 60/daqiqa
    await roomInWindow(60, 25);
    const url = `/api/media?t=${encodeURIComponent(auth.signMediaToken(uploadedPhotoMsgId))}`;
    eq((await mediaGet(url)).status, 200, 'limit ichida');
    await seedRate(`media:msg:${uploadedPhotoMsgId}`, 60, 60);
    const start = tg.calls.length;
    const limited = await mediaGet(url);
    eq(limited.status, 429, '61-murojaat — 429');
    ok(Number(limited.headers.get('retry-after')) >= 1, 'Retry-After');
    eq(limited.headers.get('cache-control'), 'no-store', 'keshlanmaydi');
    eq(callsSince(start).length, 0, "Telegramga murojaat yo'q");
    const other = (await sql`select id from messages where conversation_id = ${convs.c1aziza} and kind = 'photo' and id <> ${uploadedPhotoMsgId} order by id limit 1`)[0];
    eq((await mediaGet(`/api/media?t=${encodeURIComponent(auth.signMediaToken(other.id))}`)).status, 200, "boshqa fayl — o'z hisoblagichi");
    await clearRates();

    // Mijozlar boti: limitdan oshsa xabar xodimga yuborilmaydi va saqlanmaydi, ogohlantirish daqiqasiga bir marta
    await roomInWindow(60, 30);
    await seedRate(`c:${C2.id}:bot`, 60, 60);
    const count = await countMessages(convs.c2aziza);
    const botStart = tg.calls.length;
    let before = mark('client', C2.id);
    const m1 = await say('client', C2, 'Juda tez 1');
    const warn = botMsgsSince('client', C2.id, before);
    eq(warn.length, 1, 'bitta ogohlantirish');
    includes(warn[0]!.text, 'Juda tez yozyapsiz', 'ogohlantirish matni');
    eq((warn[0]!.message as any)?.reply_to_message?.message_id, m1.message_id, 'xabarga reply');
    before = mark('client', C2.id);
    await say('client', C2, 'Juda tez 2');
    eq(botMsgsSince('client', C2.id, before).length, 0, 'ikkinchi marta ogohlantirilmaydi');
    eq(callsSince(botStart, STAFF).filter((c) => /^(send|copy|forward)/i.test(c.method)).length, 0, 'xodimga hech narsa yuborilmadi');
    eq(await countMessages(convs.c2aziza), count, 'saqlanmadi');
    await clearRates();
    const opBefore = mark('staff', OP1.id);
    await say('client', C2, 'Endi odatdagidek');
    includes(textsSince('staff', OP1.id, opBefore), 'Endi odatdagidek', 'limit tugagach yetkaziladi');
  });
}

async function idempotencyTests(): Promise<void> {
  await step("Mini App (xodim): clientNonce — takroriy send/upload bir marta yetkaziladi, in_progress (409), eskirgan da'vo, noto'g'ri nonce, yuboruvchi bo'yicha alohida", async () => {
    await clearRates();
    try {
      // send: xuddi shu nonce bilan qayta yuborish — o'sha xabar qaytadi, qayta yetkazilmaydi
      const n = 'e2e-idem-send-0001';
      const c0 = await countMessages(convs.c2aziza);
      const s = tg.calls.length;
      const r1 = expectApi(await app('staff', OP1, 'send', { conversationId: convs.c2aziza, text: 'Idem 1', clientNonce: n }), 200, 'send (1)');
      ok(!r1.duplicate, '1-yuborish takror emas');
      eq(r1.delivered, true, 'yetkazildi');
      const r2 = expectApi(await app('staff', OP1, 'send', { conversationId: convs.c2aziza, text: 'Idem 1', clientNonce: n }), 200, 'send (takror)');
      eq(r2.duplicate, true, 'takror');
      eq(r2.message.id, r1.message.id, "o'sha xabar qaytdi");
      eq(r2.delivered, true, 'yetkazilgan holati');
      eq(await countMessages(convs.c2aziza), c0 + 1, 'bitta yozuv');
      eq(callsSince(s, CLIENT, 'sendMessage').length, 1, 'mijozga bir marta');

      // upload: xuddi shunday (fayl qayta yuklanmaydi)
      const n2 = 'e2e-idem-upload-0001';
      const s2 = tg.calls.length;
      const file = { bytes: UPLOAD_JPEG, name: 'i.jpg', type: 'image/jpeg' };
      const u1 = expectApi(await appUpload('staff', OP1, 'upload', { conversationId: convs.c1aziza, clientNonce: n2 }, file), 200, 'upload (1)');
      ok(!u1.duplicate, '1-yuklash takror emas');
      const u2 = expectApi(await appUpload('staff', OP1, 'upload', { conversationId: convs.c1aziza, clientNonce: n2 }, file), 200, 'upload (takror)');
      eq(u2.duplicate, true, 'takror (upload)');
      eq(u2.message.id, u1.message.id, "o'sha xabar (upload)");
      eq(callsSince(s2, CLIENT, 'sendPhoto').length, 1, 'fayl bir marta yuklandi');

      // Birinchi so'rov hali bajarilmoqda (da'vo bor, xabar yo'q) — 409 in_progress, hech narsa qilinmaydi
      const pending = 'e2e-idem-pending-01';
      await sql`insert into webapp_sends (conversation_id, sender, nonce) values (${convs.c2aziza}, 'staff', ${pending})`;
      const c1 = await countMessages(convs.c2aziza);
      const s3 = tg.calls.length;
      const busy = await app('staff', OP1, 'send', { conversationId: convs.c2aziza, text: 'Idem kutilmoqda', clientNonce: pending });
      eq(expectApi(busy, 409, 'in_progress').error, 'in_progress', 'kod');
      eq(await countMessages(convs.c2aziza), c1, 'saqlanmadi');
      eq(callsSince(s3).length, 0, "Telegramga murojaat yo'q");

      // Da'vo eskirgan (so'rov yarim yo'lda to'xtagan) — yangi so'rov uni oladi va yuboradi
      await sql`update webapp_sends set created_at = now() - interval '4 minutes' where conversation_id = ${convs.c2aziza} and nonce = ${pending}`;
      const stale = expectApi(await app('staff', OP1, 'send', { conversationId: convs.c2aziza, text: 'Idem kutilmoqda', clientNonce: pending }), 200, "eskirgan da'vo");
      ok(!stale.duplicate, 'yangi yuborish');
      eq(await countMessages(convs.c2aziza), c1 + 1, 'saqlandi');
      const again = expectApi(await app('staff', OP1, 'send', { conversationId: convs.c2aziza, text: 'Idem kutilmoqda', clientNonce: pending }), 200, "eskirgan da'vo (takror)");
      eq(again.duplicate, true, 'endi takror');
      eq(again.message.id, stale.message.id, "o'sha xabar");

      // Noto'g'ri nonce — 400 bad_nonce
      const bad = await app('staff', OP1, 'send', { conversationId: convs.c2aziza, text: 'x', clientNonce: 'bad!' });
      eq(expectApi(bad, 400, "noto'g'ri nonce").error, 'bad_nonce', 'kod');
      eq(await countMessages(convs.c2aziza), c1 + 1, "noto'g'ri nonce — saqlanmadi");

      // Nonce yuboruvchiga bog'langan: xuddi shu nonce bilan boshqa yuboruvchining (v1 dagi mijoz Mini App i)
      // bajarilayotgan da'vosi xodimga ta'sir qilmaydi — mustaqil yangi xabar
      const shared = 'e2e-idem-shared-01';
      await sql`insert into webapp_sends (conversation_id, sender, nonce) values (${convs.c2aziza}, 'client', ${shared})`;
      const staffSend = expectApi(await app('staff', OP1, 'send', { conversationId: convs.c2aziza, text: 'Idem xodim', clientNonce: shared }), 200, "xodim (o'sha nonce)");
      ok(!staffSend.duplicate, 'xodim uchun takror emas');
      eq(staffSend.message.sender, 'staff', 'xodim xabari');
      ok(staffSend.message.id !== r1.message.id && staffSend.message.id !== stale.message.id, 'boshqa xabar');
      eq(await countMessages(convs.c2aziza), c1 + 2, 'saqlandi');
    } finally {
      await clearRates();
    }
  });
}

async function heldAndPagingTests(): Promise<void> {
  await step("mijoz: xodim tanlanmasdan yozilgan xabarlar saqlanadi va shaxsiy havola (/start AZIZA) orqali kirganda tartib bilan yetkaziladi (avto-javob bir marta)", async () => {
    await say('client', C4, '/start');
    let before = mark('client', C4.id);
    await say('client', C4, 'Oldindan savol: narxlar qanday?');
    includes(textsSince('client', C4.id, before), "saqlab qo'yildi", '1-xabar saqlandi');
    before = mark('client', C4.id);
    await say('client', C4, 'Yana: yetkazib berish bormi?');
    includes(textsSince('client', C4.id, before), 'ham saqlandi', '2-xabar ham saqlandi');
    eq((await sql`select count(*)::int as n from conversations where client_id = ${C4.id}`)[0]!.n, 0, "hali suhbat yo'q");

    // Shaxsiy havola (katta harf bilan): saqlangan xabarlar /start ning o'zida xodimga ketadi, tanlov kerak emas
    const staffBefore = mark('staff', OP1.id);
    before = mark('client', C4.id);
    await say('client', C4, '/start AZIZA');
    const toStaff = botMsgsSince('staff', OP1.id, staffBefore);
    eq(
      JSON.stringify(toStaff.map((m) => m.text)),
      JSON.stringify(['🆕 👤 Nilufar · @nilu_f\nOldindan savol: narxlar qanday?', '👤 Nilufar · @nilu_f\nYana: yetkazib berish bormi?']),
      'xodimga tartib bilan, 🆕 faqat birinchisida',
    );
    const got = botMsgsSince('client', C4.id, before);
    const greeting = texts.fill(texts.DEFAULT_GREETING, { name: 'Nilufar', staff: 'Aziza Karimova' });
    eq(got.length, 2, 'mijozga: avto-javob + havola xabari');
    eq(got[0]!.text, greeting, 'avval avto-javob (bir marta)');
    eq(got[1]!.kind, 'photo', 'keyin rasmli havola xabari');
    eq(
      got[1]!.text,
      linkCaption({
        client: 'Nilufar',
        staff: 'Aziza Karimova',
        role: '👨‍💻 Operator · Katta operator',
        last: '📨 Avvalroq yozgan 2 ta xabaringiz Aziza Karimovaga yuborildi. Javob shu yerga keladi.',
      }),
      "havola xabarida saqlangan xabarlar yuborilgani haqida (✍️ qatori o'rniga)",
    );
    includes(got[1]!.text, '2 ta xabaringiz', 'saqlangan xabarlar yuborilgani haqida');
    ok(isRemoveKeyboardOnly(got[1]), 'tugmasiz');
    const conv = await convOf(C4.id, ids.aziza);
    eq(await countMessages(conv.id, 'client'), 2, 'ikkala xabar saqlandi');
    eq(await countMessages(conv.id, 'bot'), 1, 'bitta avto-javob');
    eq((await clientRow(C4.id)).active_conversation_id, conv.id, 'aktiv suhbat');

    // Yetkazilgan saqlangan xabarga xodim Reply qiladi — aynan shu mijozga
    before = mark('client', C4.id);
    await say('staff', OP1, { text: 'Nilufar, narxlar ilovada', replyTo: toStaff[0]!.id });
    eq(textsSince('client', C4.id, before), `${HEADER_AZIZA}\nNilufar, narxlar ilovada`, 'C4 oldi');
    // Mijoz tanlangan suhbatga yozadi — tanlov belgisi (user_state) tozalanadi
    await say('client', C4, 'Rahmat!');
    eq((await sql`select count(*)::int as n from user_state where bot = 'client' and tg_user_id = ${C4.id}`)[0]!.n, 0, 'tanlov belgisi tozalandi');
  });

  await step("Mini App (xodim): 'conversations' — 120+ suhbat sahifalab, server qidiruvi, faqat o'z suhbatlari", async () => {
    const created = expectApi(await app('staff', ADMIN, 'admin.staff.create', { role: 'operator', full_name: 'Nodira Test' }), 200, 'create');
    const sid = created.staff.id as number;
    await sql`update staff set tg_user_id = ${OP3.id}, invite_code = null where id = ${sid}`;
    const BASE = 8_000_000;
    try {
      await sql`
        insert into clients (tg_user_id, first_name, last_name, username)
        select ${BASE}::bigint + g, case when g = 117 then 'Zulfiya' else 'Mijoz' end, 'N' || lpad(g::text, 3, '0'),
               case when g = 117 then 'zulfiya_q' when g % 10 = 0 then 'mijoz_' || g else null end
        from generate_series(1, 125) g`;
      await sql`
        insert into conversations (client_id, staff_id, last_message_at, last_message_preview, last_sender)
        select ${BASE}::bigint + g, ${sid}, now() - make_interval(mins => g),
               case when g = 117 then 'maxsus buyurtma raqami 777' else 'Xabar ' || g end, 'client'
        from generate_series(1, 125) g`;
      // Xabarsiz suhbat (ro'yxatda ko'rinmaydi) va BOSHQA xodimning (Aziza) «Zulfiya» mijozi
      await sql`insert into clients (tg_user_id, first_name) values (${BASE + 500}, 'Bo''sh'), (${BASE + 600}, 'Zulfiya Boshqa')`;
      await sql`insert into conversations (client_id, staff_id) values (${BASE + 500}, ${sid})`;
      await sql`
        insert into conversations (client_id, staff_id, last_message_at, last_message_preview, last_sender)
        values (${BASE + 600}, ${ids.aziza}, now(), 'Zulfiya Aziza bilan', 'client')`;

      const boot = expectApi(await app('staff', OP3, 'bootstrap'), 200, 'bootstrap');
      eq(boot.total, 125, 'jami (xabarsiz suhbat hisoblanmaydi)');
      eq(boot.conversations.length, 100, 'bootstrap — oxirgi 100 ta');
      eq(boot.has_more, true, 'has_more');
      eq(boot.next_offset, 100, 'next_offset');
      eq(boot.conversations[0].client_id, BASE + 1, 'eng yangisi birinchi');

      const all: any[] = [];
      let offset = 0;
      for (let i = 0; i < 5; i++) {
        const p = expectApi(await app('staff', OP3, 'conversations', { offset }), 200, `sahifa ${i}`);
        eq(p.offset, offset, 'offset');
        all.push(...p.conversations);
        if (!p.has_more) {
          eq(p.next_offset, 125, 'oxirgi next_offset');
          break;
        }
        eq(p.conversations.length, 50, 'sahifa hajmi');
        offset = p.next_offset;
      }
      eq(all.length, 125, 'barcha suhbatlar');
      eq(new Set(all.map((c) => c.id)).size, 125, 'takrorsiz');
      ok(all.every((c) => c.staff_id === sid), "faqat o'z suhbatlari");
      eq(JSON.stringify(all.slice(0, 100).map((c) => c.id)), JSON.stringify(boot.conversations.map((c: any) => c.id)), 'tartib bootstrap bilan bir xil');
      const tail = expectApi(await app('staff', OP3, 'conversations', { offset: 120 }), 200, 'offset 120');
      eq(tail.conversations.length, 5, 'oxirgi 5 ta');
      eq(tail.has_more, false, "boshqa yo'q");

      const search = async (q: string, offset2 = 0) =>
        expectApi(await app('staff', OP3, 'conversations', { search: q, offset: offset2 }), 200, `qidiruv «${q}»`);
      const only117 = async (q: string, what: string) =>
        eq(JSON.stringify((await search(q)).conversations.map((c: any) => c.client_id)), JSON.stringify([BASE + 117]), what);
      await only117('zulfiya', "ism bo'yicha (katta-kichik harf farqsiz), boshqa xodimniki emas");
      await only117('@zulfiya_q', "@username bo'yicha");
      await only117('buyurtma raqami 777', "oxirgi xabar ko'rinishi bo'yicha");
      await only117(String(BASE + 117), "Telegram ID bo'yicha");
      await only117('  Zulfiya   N117 ', "ortiqcha bo'shliqlar");
      // Ko'p natija: qidiruv ham 50 tadan sahifalanadi (124 ta «Mijoz» = 50 + 50 + 24)
      const found: any[] = [];
      let sOffset = 0;
      const sizes: number[] = [];
      for (let i = 0; i < 5; i++) {
        const pg = await search('Mijoz', sOffset);
        found.push(...pg.conversations);
        sizes.push(pg.conversations.length);
        if (!pg.has_more) break;
        sOffset = pg.next_offset;
      }
      eq(JSON.stringify(sizes), JSON.stringify([50, 50, 24]), 'qidiruv sahifalari');
      eq(new Set(found.map((c) => c.id)).size, 124, 'jami 124 ta «Mijoz», takrorsiz');
      ok(!found.some((c) => c.client_id === BASE + 117), "«Zulfiya» «Mijoz» qidiruvida yo'q");
      eq((await search('%')).conversations.length, 0, '% — oddiy belgi sifatida');
      eq((await search('Ali')).conversations.length, 0, "boshqa xodimning mijozlari (Ali Valiyev) ko'rinmaydi");
      const az = expectApi(await app('staff', OP1, 'conversations', { search: 'Zulfiya' }), 200, 'Aziza qidiruvi');
      eq(JSON.stringify(az.conversations.map((c: any) => c.client_id)), JSON.stringify([BASE + 600]), "Aziza faqat o'z mijozini ko'radi");

      // Mini App admin: faollik o'zgarsa xodim (xodimlar boti orqali) xabardor qilinadi; boshqa maydonlar — yo'q
      tg.knowChat(STAFF, OP3.id); // Nodira xodimlar botini ochgan
      let m3 = mark('staff', OP3.id);
      expectApi(await app('staff', ADMIN, 'admin.staff.update', { id: sid, patch: { position: 'X' } }), 200, 'lavozim');
      eq(botMsgsSince('staff', OP3.id, m3).length, 0, "lavozim o'zgarishi — xabarnoma yo'q");
      expectApi(await app('staff', ADMIN, 'admin.staff.update', { id: sid, patch: { is_active: false } }), 200, "o'chirib qo'yish");
      const offNote = botMsgsSince('staff', OP3.id, m3);
      eq(offNote.length, 1, 'bitta xabarnoma (deaktivatsiya)');
      includes(offNote[0]!.text, "o'chirib qo'yildi", 'xabarnoma matni (deaktivatsiya)');
      m3 = mark('staff', OP3.id);
      expectApi(await app('staff', ADMIN, 'admin.staff.update', { id: sid, patch: { is_active: false } }), 200, "o'chirib qo'yish (takror)");
      eq(botMsgsSince('staff', OP3.id, m3).length, 0, "o'zgarmagan faollik — xabarnoma yo'q");
      expectApi(await app('staff', ADMIN, 'admin.staff.update', { id: sid, patch: { is_active: true } }), 200, 'faollashtirish');
      const onNote = botMsgsSince('staff', OP3.id, m3);
      eq(onNote.length, 1, 'bitta xabarnoma (faollashtirish)');
      includes(onNote[0]!.text, 'faollashtirildi', 'xabarnoma matni (faollashtirish)');

      eq(expectApi(await app('client', C1, 'conversations'), 403, 'mijoz').error, 'client_app_disabled', 'kod');
      eq(expectApi(await app('staff', ADMIN, 'conversations'), 403, 'profilsiz admin').error, 'staff_only', 'kod');
      eq(expectApi(await app('staff', OP3, 'conversations', { offset: 'abc' }), 400, "noto'g'ri offset").error, 'invalid_id', 'kod');
      eq(expectApi(await app('staff', OP3, 'conversations', { search: 5 }), 400, "noto'g'ri qidiruv").error, 'bad_request', 'kod');
    } finally {
      await sql`delete from conversations where staff_id = ${sid} or client_id between ${BASE} and ${BASE + 1000}`;
      await sql`delete from clients where tg_user_id between ${BASE} and ${BASE + 1000}`;
      await sql`delete from staff where id = ${sid}`;
    }
  });
}

async function finalInvariants(): Promise<void> {
  await step('yakuniy invariantlar: barcha callback larga javob berilgan, begona file_id ishlatilmagan', async () => {
    eq(tg.unansweredCallbacks().length, 0, 'javobsiz callback query lar');
    const foreign = tg.calls.filter((c) => /wrong file identifier/.test(c.error?.description ?? '') && c.params.photo !== 'F_111111_999999');
    eq(foreign.length, 0, `begona file_id bilan chaqiruvlar: ${foreign.map((c) => c.method).join(', ')}`);
    const parseErrors = tg.calls.filter((c) => /can't parse entities/.test(c.error?.description ?? ''));
    eq(parseErrors.length, 0, 'HTML parse xatolari');
    const tooLong = tg.calls.filter((c) => /too long|BUTTON_DATA_INVALID/i.test(c.error?.description ?? ''));
    eq(tooLong.length, 0, `limitdan oshgan chaqiruvlar: ${tooLong.map((c) => `${c.method}: ${c.error?.description}`).join(' | ')}`);
    // Xodimlar botidagi (admin) kutilayotgan kiritish holatlari qolmasligi kerak. Mijozlar botidagi holatlar
    // (tanlovgacha saqlangan xabarlar, tanlov belgisi) — mahsulot qoidasi bo'yicha qolishi mumkin.
    const leftovers = (await sql`select count(*)::int as n from user_state where bot = 'staff'`)[0]!.n;
    eq(leftovers, 0, 'tugallanmagan admin holatlari');
  });
}

// ═════════════════════════════ Ishga tushirish ═════════════════════════════

async function prepareSchema(): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/.test(SCHEMA) || SCHEMA === 'public') throw new Error('Xavfli sxema nomi');
  await sql.unsafe(`drop schema if exists ${SCHEMA} cascade`);
  await sql.unsafe(`create schema ${SCHEMA}`);
  const cur = (await sql`select current_schema() as s`)[0]?.s;
  if (cur !== SCHEMA) throw new Error(`search_path izolyatsiyasi ishlamadi (current_schema=${cur}) — test to'xtatildi`);
  await migrate();
  const tables = (await sql`select table_name from information_schema.tables where table_schema = ${SCHEMA}`).map((r: any) => r.table_name);
  for (const t of ['staff', 'clients', 'conversations', 'messages', 'processed_updates', 'user_state', 'settings']) {
    if (!tables.includes(t)) throw new Error(`migratsiya: ${SCHEMA}.${t} yaratilmadi`);
  }
}

let exitCode = 1;
const t0 = Date.now();
try {
  console.log(`🧪 e2e: soxta Telegram ${tg.url}, sxema ${SCHEMA}`);
  await prepareSchema();
  await unitTests();
  await setupTests();
  await adminFlowTests();
  await clientBotTests();
  await miniAppTests();
  await adminBotSettingsTests();
  await linkEntryTests();
  await staffPresenceTests();
  await blockedAndLifecycleTests();
  await webappSyncTests();
  await rateLimitTests();
  await idempotencyTests();
  await heldAndPagingTests();
  await finalInvariants();
  exitCode = failed === 0 ? 0 : 1;
} catch (e) {
  console.error('💥 Test ishga tushmadi:', e);
  exitCode = 1;
} finally {
  try {
    await sql.unsafe(`drop schema if exists ${SCHEMA} cascade`);
  } catch (e) {
    console.error(`⚠️ ${SCHEMA} sxemasini o'chirib bo'lmadi:`, e);
    exitCode = 1;
  }
  await closeDb().catch(() => {});
  await tg.close().catch(() => {});
}

console.log('');
console.log(`${failed === 0 && exitCode === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
if (failedNames.length) console.log('Muvaffaqiyatsiz:\n' + failedNames.map((n) => `  - ${n}`).join('\n'));
process.exit(exitCode);

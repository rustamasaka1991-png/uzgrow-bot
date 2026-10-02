// Boshqaruv paneli (xodimlar boti ichida): developer (ADMIN_IDS env), ROP va adminlar (panel_roles, src/roles.ts).
// Hamma rollar: xodim qo'shish / tahrirlash / bloklash / o'chirish, taklif havolalari, akkauntni uzish, umumiy matnlar,
// statistika va 📣 mijozlarga xabar (./panel/broadcast.ts).
// ROP va developer: ⚠️ shikoyatlar (./panel/complaints.ts) ham.
// Developer: 🛠 developer paneli (./panel/developer.ts). Huquq har bir update da qayta tekshiriladi (ctx.panelRole).
// Holat mashinasi user_state jadvalida saqlanadi (./panel/state.ts); kutilayotgan panel holati xodim xabarlarini
// mijozga yo'naltirishdan USTUN turadi (panelga kiritilgan matn hech qachon mijozga ketib qolmaydi).
import { Composer, InlineKeyboard, InputFile, type NextFunction } from 'grammy';
import type { Document, Message as TgMessage } from 'grammy/types';
import { countComplaints } from '../complaints.js';
import { db } from '../db.js';
import { getWebAppUrl, inviteLink } from '../links.js';
import {
  clearState,
  createStaff,
  deleteSetting,
  getSetting,
  getStaff,
  getStats,
  isValidLinkCode,
  listAllStaff,
  normalizeLinkCode,
  regenerateInvite,
  setSetting,
  setState,
  setStaffLinkCode,
  setStaffPhoto,
  softDeleteStaff,
  unlinkStaff,
  updateStaff,
} from '../repo.js';
import { ROLE_TITLES, can, getPanelRole, type PanelRole } from '../roles.js';
import { DEFAULT_GREETING, DEFAULT_OFFLINE_NOTE, DEFAULT_WELCOME, SETTING_KEYS, STAFF_NOTICE, fill } from '../texts.js';
import { normalizeChannel } from '../subscribe.js';
import { FileTooBigError, downloadFile } from '../tg.js';
import type { Role, Staff } from '../types.js';
import { dative, dativeSuffix, esc, oneLine, roleIcon, roleLabel, tgErrorCode, tgErrorDescription, truncate } from '../util.js';
import { requirePerm } from './panel/access.js';
import { broadcastComposer, handleBroadcastInput, startBroadcast } from './panel/broadcast.js';
import { complaintsComposer } from './panel/complaints.js';
import { devHomeView, developerComposer, handleDevAddInput } from './panel/developer.js';
import { subscribeComposer } from './panel/subscribe.js';
import { watchComposer } from './panel/watch.js';
import {
  EDIT_FIELDS,
  casState,
  enterState,
  finishState,
  isSettingName,
  loadState,
  loadStateRow,
  statePerm,
  takeState,
  takeStateRow,
  withoutGroup,
  type AddStage,
  type AddState,
  type AdminState,
  type Draft,
  type EditField,
  type EditState,
  type InputState,
  type SettingName,
  type SettingState,
  type StateRow,
  type TextField,
} from './panel/state.js';
import { clientNameOf, ownActiveConversation, ownConversationView, resolveReplyConversation } from './staff/conv.js';
import {
  BLOCK_NOTICE,
  BTN,
  CAPTION_LIMIT,
  NO_ACCESS_TEXT,
  PANEL_CALLBACK_RE,
  STALE_BUTTON_TEXT,
  TEXT_LIMIT,
  afterSuccess,
  callbackMessage,
  clientLinkOf,
  fmtNum,
  isCommandMessage,
  isMainButton,
  logError,
  mainKeyboard,
  parseId,
  render,
  sendHtml,
  shareUrl,
  stripKeyboard,
  type StaffContext,
  type View,
} from './staff/ui.js';

const STAGE_NO: Record<AddStage, number> = { role: 1, name: 2, position: 3, description: 4, greeting: 5, photo: 6 };

/** Shu fayldagi (xodim va matnlar) kiritma holatlari; ommaviy xabar va developer holatlari — ./panel/*. */
type CoreInputState = AddState | EditState | SettingState;

// ───────────────────────────── Matnlar va qoidalar ─────────────────────────────

const SETTING_MAX = 2000;

const SETTINGS: Record<SettingName, { key: string; title: string; about: string; placeholders: string; def: string }> = {
  welcome: {
    key: SETTING_KEYS.welcome,
    title: '👋 Salomlashuv matni',
    about: 'Mijoz botni ishga tushirganda (/start) yuboriladi.',
    placeholders: '<code>{name}</code> — mijoz ismi',
    def: DEFAULT_WELCOME,
  },
  greeting: {
    key: SETTING_KEYS.greeting,
    title: '🤖 Avto-javob matni',
    about:
      "Mijoz xodimga birinchi marta yozganda avtomatik yuboriladi. Xodimning shaxsiy avto-javobi bo'lsa, o'shanisi ishlatiladi.",
    placeholders: '<code>{name}</code> — mijoz ismi, <code>{staff}</code> — xodim ismi',
    def: DEFAULT_GREETING,
  },
  offline: {
    key: SETTING_KEYS.offlineNote,
    title: '🕐 Oflayn izohi',
    about: "Xodim oflayn bo'lsa, avto-javob oxiriga qo'shiladi.",
    placeholders: '<code>{name}</code> — mijoz ismi, <code>{staff}</code> — xodim ismi',
    def: DEFAULT_OFFLINE_NOTE,
  },
  subchannel: {
    key: SETTING_KEYS.subChannel,
    title: '📢 Obuna kanali',
    about: "Mijoz obuna bo'lishi shart bo'lgan ochiq kanal: @kanal, -100... ID yoki t.me/kanal. Maxfiy taklif havolasi (t.me/+...) bo'lmaydi — uni «🔗 Tugma havolasi» ga yozing.",
    placeholders: 'masalan: @uzgrow_news',
    def: '',
  },
  suburl: {
    key: SETTING_KEYS.subUrl,
    title: '🔗 Obuna tugmasi havolasi',
    about: "«➕ Obuna bo'lish» tugmasi havolasi. Bo'sh bo'lsa kanaldan olinadi.",
    placeholders: 'masalan: https://t.me/+xxxx',
    def: '',
  },
};

const RULES: Record<TextField, { min: number; max: number; multiline: boolean; hint: string }> = {
  full_name: { min: 2, max: 64, multiline: false, hint: "Ism 2 dan 64 belgigacha bo'lishi kerak." },
  position: { min: 1, max: 100, multiline: false, hint: 'Lavozim 100 belgidan oshmasligi kerak.' },
  description: { min: 1, max: 700, multiline: true, hint: 'Tavsif 700 belgidan oshmasligi kerak.' },
  greeting: { min: 1, max: 1000, multiline: true, hint: 'Avto-javob 1000 belgidan oshmasligi kerak.' },
};

const FIELD_TITLES: Record<EditField, string> = {
  full_name: 'ism',
  position: 'lavozim',
  description: 'tavsif',
  greeting: 'avto-javob',
  photo: 'rasm',
  link_code: 'havola nomi',
};

/** Havola nomi qoidalari (so'rov va xato matnlarida). */
const LINK_RULES = "2–32 ta lotin harfi, raqam yoki _; masalan: aziza";
const LINK_INVALID = `Bu nom to'g'ri emas — ${LINK_RULES}`;
const LINK_TAKEN = 'Bu nom band, boshqasini yozing';
const LINK_TEXT_ONLY = `Iltimos, nomni matn ko'rinishida yuboring (${LINK_RULES})`;

/**
 * Admin yozgan havola nomi: to'liq havola yuborilsa ham (…?start=aziza) nom ajratib olinadi, keyin
 * normalizeLinkCode (kichik harf, bo'sh joylarsiz).
 */
function linkCodeInput(text: string): string {
  const t = text.trim();
  const m = /[?&]start=([^\s&#]+)/i.exec(t);
  return normalizeLinkCode(m ? m[1]! : t);
}

const CANCEL_KB = () => new InlineKeyboard().text('✖️ Bekor qilish', 'adm:cancel');
const DROPPED_TEXT = 'ℹ️ Tugallanmagan admin amali bekor qilindi.';
const EXPIRED_TEXT = "ℹ️ Tugallanmagan admin amali muddati o'tgani uchun bekor qilindi.";

/**
 * Admin ham xodim bo'lsa va aktiv suhbati bo'lsa: so'rov shundan eskiroq bo'lsa, Reply'siz yozilgan xabar
 * admin kiritmasimi yoki mijozga javobmi — taxmin qilinmaydi, so'raladi.
 */
const ASK_AFTER_SEC = 2 * 60;

/** Rasm-fayl (hujjat) sifatida yuborilgan xodim rasmi: qabul qilinadigan turlar va hajm (sendPhoto limiti). */
const PHOTO_DOC_MIMES = new Set(['image/jpeg', 'image/jpg', 'image/pjpeg', 'image/png', 'image/webp']);
const PHOTO_DOC_MAX = 10 * 1024 * 1024;
const PHOTO_FORMAT_ERROR = "Faqat JPG, PNG yoki WebP rasm qabul qilinadi (GIF, HEIC va boshqa turlar emas).";

function normalizeText(raw: string, multiline: boolean): string {
  const t = raw.replace(/\r\n?/g, '\n');
  if (!multiline) return t.replace(/\s+/g, ' ').trim();
  return t
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

type Validation = { ok: true; value: string } | { ok: false; error: string };

function validateText(field: TextField, raw: string): Validation {
  const r = RULES[field];
  const v = normalizeText(raw, r.multiline);
  if (v.length < r.min) {
    return { ok: false, error: field === 'full_name' ? 'Ism juda qisqa — kamida 2 belgi.' : "Matn bo'sh bo'lmasligi kerak." };
  }
  if (v.length > r.max) {
    return { ok: false, error: `Matn juda uzun: ${v.length}/${r.max} belgi. Qisqartirib, qayta yuboring.` };
  }
  return { ok: true, value: v };
}

function parseRoleText(text: string | undefined): Role | null {
  const t = (text ?? '').trim().toLowerCase().replace(/^[^a-zа-я]+/i, '');
  if (/^(operator|оператор)$/.test(t)) return 'operator';
  if (/^(menejer|menedjer|manager|менеджер|менежер)$/.test(t)) return 'manager';
  return null;
}

type PhotoRef = { fileId: string; uniqueId: string };

function largestPhoto(msg: Pick<TgMessage, 'photo'>): PhotoRef | null {
  const p = msg.photo?.[msg.photo.length - 1];
  return p ? { fileId: p.file_id, uniqueId: p.file_unique_id } : null;
}

/** Rasm-fayl (hujjat): mime turi image/* bo'lgan document. */
function imageDocument(msg: TgMessage): Document | null {
  const d = msg.document;
  return d && (d.mime_type ?? '').toLowerCase().startsWith('image/') ? d : null;
}

function photoError(msg: TgMessage, allowRemove: boolean): string {
  if (imageDocument(msg)) return PHOTO_FORMAT_ERROR;
  return allowRemove
    ? "Iltimos, rasm yoki rasm-fayl yuboring, rasmni olib tashlash uchun esa «-» yuboring."
    : "Iltimos, rasm yoki rasm-fayl yuboring yoki «O'tkazib yuborish» tugmasini bosing.";
}

/** Baytlar bo'yicha rasm turi (faylning o'zi aytgan turga ishonmaymiz). */
function sniffPhoto(b: Uint8Array): 'jpg' | 'png' | 'webp' | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (
    b.length >= 12 &&
    String.fromCharCode(b[0]!, b[1]!, b[2]!, b[3]!) === 'RIFF' &&
    String.fromCharCode(b[8]!, b[9]!, b[10]!, b[11]!) === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

type PhotoResult = { ok: true; photo: PhotoRef } | { ok: false; error: string };

/**
 * Fayl sifatida yuborilgan rasm (sifat saqlanishi uchun ko'p yuboriladi): yuklab olinib, shu chatga oddiy rasm
 * sifatida qayta yuboriladi va o'sha rasmning (staff bot) file_id si olinadi. Hujjatning o'z file_id si hech qachon
 * saqlanmaydi — xodim kartasi, mijoz boti va Mini App rasm (photo) file_id sini kutadi.
 */
async function photoFromDocument(ctx: StaffContext, doc: Document): Promise<PhotoResult> {
  const mime = (doc.mime_type ?? '').split(';')[0]!.trim().toLowerCase();
  if (!PHOTO_DOC_MIMES.has(mime)) return { ok: false, error: PHOTO_FORMAT_ERROR };
  const tooBig = "Rasm-fayl juda katta — 10 MB gacha bo'lishi kerak. Kichikroq rasm yuboring.";
  if (doc.file_size && doc.file_size > PHOTO_DOC_MAX) return { ok: false, error: tooBig };
  let data: Uint8Array;
  try {
    ({ data } = await downloadFile('staff', doc.file_id));
  } catch (e) {
    if (e instanceof FileTooBigError) return { ok: false, error: tooBig };
    logError('rasm-faylni yuklab olish', e);
    return { ok: false, error: "Faylni yuklab olib bo'lmadi. Qayta yuboring yoki oddiy rasm sifatida yuboring." };
  }
  if (data.byteLength > PHOTO_DOC_MAX) return { ok: false, error: tooBig };
  const ext = sniffPhoto(data);
  if (!ext) return { ok: false, error: PHOTO_FORMAT_ERROR };
  let sent: TgMessage;
  try {
    sent = await ctx.replyWithPhoto(new InputFile(data, `staff.${ext}`), { caption: '🖼 Rasm qabul qilindi' });
  } catch (e) {
    if (tgErrorCode(e) === 400) {
      logError('rasm-faylni rasm sifatida yuborish', e);
      return {
        ok: false,
        error: "Rasmni qayta ishlab bo'lmadi: eni va bo'yi yig'indisi 10 000 px dan, tomonlar nisbati 20:1 dan oshmasin.",
      };
    }
    throw e;
  }
  const p = largestPhoto(sent);
  return p ? { ok: true, photo: p } : { ok: false, error: "Rasmni qayta ishlab bo'lmadi. Oddiy rasm sifatida yuboring." };
}

/** Bir nechta qisqartirish darajasini sinab, limitga sig'adigan birinchi variant. */
function fit(build: (a: number, b: number) => string, sizes: Array<[number, number]>, limit: number): string | null {
  for (const [a, b] of sizes) {
    const t = build(a, b);
    if (t.length <= limit) return t;
  }
  return null;
}

// ───────────────────────────── Holat ─────────────────────────────

/**
 * Tugallanmagan admin amalini bekor qilish (/start, /cancel): holat o'chiriladi va so'rov xabaridagi tugmalar
 * olib tashlanadi (eski «♻️ Standartga qaytarish», «⏭ O'tkazib yuborish» va h.k. bosilib qolmasin).
 * Amaldagi admin amali bo'lgan bo'lsa true.
 */
export async function dropAdminState(ctx: StaffContext): Promise<boolean> {
  if (!ctx.from) return false;
  const r = await takeStateRow(ctx.from.id);
  if (!r || r.st.step === 'group') return false;
  await stripKeyboard(ctx, r.st.promptMsgId);
  return r.fresh;
}

// ───────────────────────────── Ko'rinishlar ─────────────────────────────

async function homeView(role: PanelRole, notice?: string): Promise<View> {
  const complaints = can(role, 'complaints');
  const [all, url, newComplaints] = await Promise.all([
    listAllStaff(),
    getWebAppUrl(),
    complaints ? countComplaints('new') : Promise.resolve(0),
  ]);
  const ops = all.filter((s) => s.role === 'operator').length;
  const unlinked = all.filter((s) => s.tg_user_id == null).length;
  const blocked = all.filter((s) => !s.is_active).length;
  const lines: string[] = [];
  if (notice) lines.push(notice, '');
  lines.push(
    `⚙️ <b>Admin panel</b> · ${ROLE_TITLES[role]}`,
    '',
    `👥 Xodimlar: <b>${all.length}</b> (👨‍💻 ${ops} · 👔 ${all.length - ops})`,
  );
  if (unlinked) lines.push(`⏳ Akkaunti ulanmaganlar: ${unlinked}`);
  if (blocked) lines.push(`🚫 Bloklanganlar: ${blocked}`);
  if (complaints && newComplaints) lines.push(`⚠️ Yangi shikoyatlar: <b>${newComplaints}</b>`);
  lines.push('', "Kerakli bo'limni tanlang 👇");
  const kb = new InlineKeyboard()
    .text("➕ Xodim qo'shish", 'adm:add')
    .text('👥 Xodimlar', 'adm:list')
    .row()
    .text('📊 Statistika', 'adm:stats')
    .row()
    .text('👋 Salomlashuv matni', 'adm:set:welcome')
    .text('🤖 Avto-javob matni', 'adm:set:greeting')
    .row()
    .text('🕐 Oflayn izohi', 'adm:set:offline')
    .row()
    .text('👁 Chatlar kuzatuvi', 'wtch:list:0')
    .text('📢 Majburiy obuna', 'sub:home')
    .row();
  if (can(role, 'broadcast') || complaints) {
    if (can(role, 'broadcast')) kb.text('📣 Mijozlarga xabar', 'adm:bc');
    if (complaints) kb.text(`⚠️ Shikoyatlar (${newComplaints})`, 'cmpl:new:0');
    kb.row();
  }
  if (can(role, 'developer')) kb.text('🛠 Developer panel', 'dev:home').row();
  if (url) kb.webApp('📱 Mini App da boshqarish', url);
  return { text: lines.join('\n'), keyboard: kb };
}

const LIST_PAGE_SIZE = 20;

function staffStateIcon(s: Pick<Staff, 'tg_user_id' | 'is_active'>): string {
  return s.tg_user_id != null ? (s.is_active ? '🟢' : '🚫') : '⏳';
}

async function listView(page: number, notice?: string): Promise<View> {
  const all = await listAllStaff();
  const pages = Math.max(1, Math.ceil(all.length / LIST_PAGE_SIZE));
  const p = Math.min(Math.max(0, Math.trunc(page) || 0), pages - 1);
  const ops = all.filter((s) => s.role === 'operator').length;
  const lines: string[] = [];
  if (notice) lines.push(notice, '');
  lines.push(
    `👥 <b>Xodimlar</b> (${all.length})`,
    `👨‍💻 Operatorlar: ${ops} · 👔 Menejerlar: ${all.length - ops}`,
    '',
    '🟢 faol · 🚫 bloklangan · ⏳ akkaunt ulanmagan',
  );
  if (all.some((s) => s.bot_blocked && s.tg_user_id != null)) lines.push("⚠️ — xodimlar botini to'xtatgan (xabarlar unga yetib bormayapti)");
  if (!all.length) lines.push('', "Hozircha xodimlar yo'q. «➕ Qo'shish» tugmasini bosib, birinchi xodimni qo'shing.");
  else lines.push('', 'Xodimni tanlang 👇');

  const kb = new InlineKeyboard();
  for (const s of all.slice(p * LIST_PAGE_SIZE, (p + 1) * LIST_PAGE_SIZE)) {
    const warn = s.bot_blocked && s.tg_user_id != null ? ' ⚠️' : '';
    kb.text(`${staffStateIcon(s)} ${roleIcon(s.role)} ${oneLine(s.full_name, 40)}${warn}`, `adm:s:${s.id}`).row();
  }
  if (pages > 1) {
    if (p > 0) kb.text('⬅️', `adm:list:${p - 1}`);
    kb.text(`${p + 1}/${pages}`, 'noop');
    if (p < pages - 1) kb.text('➡️', `adm:list:${p + 1}`);
    kb.row();
  }
  kb.text("➕ Qo'shish", 'adm:add').text('⬅️ Orqaga', 'adm:home');
  return { text: lines.join('\n'), keyboard: kb };
}

async function cardView(s: Staff, notice?: string): Promise<View> {
  const linked = s.tg_user_id != null;
  let link: string | null = null;
  if (!linked && s.invite_code) {
    try {
      link = await inviteLink(s.invite_code);
    } catch (e) {
      // Bot username ni aniqlab bo'lmadi (tarmoq) — kamida kodni ko'rsatamiz
      console.warn('[staff/admin] inviteLink xatosi:', tgErrorDescription(e));
      link = `inv_${s.invite_code}`;
    }
  }
  // Mijozlar uchun shaxsiy havola (taklif havolasidan farqli: u xodimning o'zi uchun, bu — mijozlar uchun)
  const clientLink = await clientLinkOf(s);
  const clientLinkLine = clientLink
    ? `🔗 Mijozlar uchun havola: ${esc(clientLink)}` +
      (!linked ? ' (akkaunt ulangandan keyin ishlaydi)' : !s.is_active ? ' (xodim blokdan chiqarilgach ishlaydi)' : '')
    : `🔗 Mijozlar uchun havola nomi: <code>${esc(s.link_code ?? `staff_${s.id}`)}</code>`;

  const build = (descMax: number, greetMax: number): string => {
    const lines: string[] = [];
    if (notice) lines.push(notice, '');
    lines.push(
      `${roleIcon(s.role)} <b>${esc(s.full_name)}</b> · #${s.id}`,
      `🏷 Rol: <b>${roleLabel(s.role)}</b>`,
      `💼 Lavozim: ${s.position ? esc(s.position) : '—'}`,
      `📝 Tavsif: ${s.description ? esc(truncate(s.description, descMax)) : '—'}`,
      `📶 Holat: ${s.is_active ? '✅ faol' : '🚫 bloklangan'} · ${s.is_online ? '🟢 onlayn' : '⚪️ oflayn'}`,
    );
    const account = linked
      ? s.tg_username
        ? `@${esc(s.tg_username)} (ID: <code>${s.tg_user_id}</code>)`
        : `ID: <code>${s.tg_user_id}</code>`
      : '⏳ ulanmagan';
    lines.push(`👤 Akkaunt: ${account}`);
    if (linked && s.bot_blocked) {
      lines.push(
        "⚠️ <b>Xodimlar botini to'xtatgan yoki bloklagan</b> — mijozlarning xabarlari unga yetib bormayapti " +
          "(saqlanib turadi va u botga qaytib /start bosishi bilan yetkaziladi). Mijozlar uni ⚪️ oflayn ko'radi.",
      );
    }
    lines.push(`🖼 Rasm: ${s.photo_file_id ? 'bor' : "yo'q (standart rasm ko'rsatiladi)"}`);
    lines.push(
      s.greeting
        ? `🤖 Avto-javob:\n<blockquote>${esc(truncate(s.greeting, greetMax))}</blockquote>`
        : '🤖 Avto-javob: <i>standart</i>',
    );
    lines.push('', clientLinkLine);
    if (link) {
      lines.push(
        '',
        "📨 <b>Taklif havolasi</b> — xodimning o'ziga (bosib nusxalang):",
        `<code>${esc(link)}</code>`,
        "Havolani xodimga yuboring — u bosib, Telegram akkauntini ulaydi. Havola bir martalik.",
      );
    } else if (!linked) {
      lines.push('', "📨 Taklif havolasi yo'q — «🔗 Yangi havola» tugmasini bosing.");
    }
    if (linked && !s.is_active) {
      lines.push('', "ℹ️ Xodim bloklangan: mijozlar uni menyuda ko'rmaydi va unga yoza olmaydi, u ham mijozlarga yoza olmaydi.");
    }
    return lines.join('\n');
  };

  const id = s.id;
  const kb = new InlineKeyboard()
    .text('✏️ Ism', `adm:e:${id}:full_name`)
    .text('✏️ Lavozim', `adm:e:${id}:position`)
    .row()
    .text('✏️ Tavsif', `adm:e:${id}:description`)
    .text('✏️ Avto-javob', `adm:e:${id}:greeting`)
    .row()
    .text('🖼 Rasm', `adm:e:${id}:photo`)
    .text(`🔄 Rol: ${roleLabel(s.role)}`, `adm:role:${id}`)
    .row()
    .text('✏️ Havola nomi', `adm:e:${id}:link_code`);
  if (clientLink) kb.url('📤 Mijozlarga ulashish', shareUrl(clientLink));
  kb.row()
    .text(s.is_active ? '🚫 Bloklash' : '✅ Blokdan chiqarish', `adm:act:${id}`);
  if (!linked) kb.text('🔗 Yangi havola', `adm:inv:${id}`);
  kb.row();
  if (link && link.startsWith('https://')) {
    const shareText = `${s.full_name}, ushbu havola orqali xodimlar botiga ulaning 👆`;
    kb.url('📤 Havolani ulashish', shareUrl(link, shareText)).copyText('📋 Nusxalash', link).row();
  }
  if (linked) kb.text('🔌 Akkauntni uzish', `adm:unl:${id}`);
  kb.text("🗑 O'chirish", `adm:del:${id}`).row();
  kb.text("⬅️ Ro'yxat", 'adm:list');

  const text = fit(build, [[700, 1000], [300, 300], [80, 80]], TEXT_LIMIT) ?? build(40, 40);
  const caption = s.photo_file_id ? fit(build, [[250, 250], [120, 120], [40, 40]], CAPTION_LIMIT) : null;
  return {
    text,
    keyboard: kb,
    ...(s.photo_file_id && caption ? { photo: { fileId: s.photo_file_id, caption } } : {}),
  };
}

async function addPromptView(st: AddState, error?: string): Promise<View> {
  const d = st.draft;
  const lines = [`➕ <b>Yangi xodim</b> · ${STAGE_NO[st.stage]}/6-qadam`];
  const summary: string[] = [];
  if (d.role) summary.push(`${roleIcon(d.role)} Rol: <b>${roleLabel(d.role)}</b>`);
  if (d.full_name) summary.push(`👤 Ism: <b>${esc(d.full_name)}</b>`);
  if (d.position !== undefined) summary.push(`💼 Lavozim: ${d.position ? esc(d.position) : '—'}`);
  if (d.description !== undefined) summary.push(`📝 Tavsif: ${d.description ? esc(truncate(d.description, 150)) : '—'}`);
  if (d.greeting !== undefined) summary.push(`🤖 Avto-javob: ${d.greeting ? esc(truncate(d.greeting, 150)) : '<i>standart</i>'}`);
  if (summary.length) lines.push('', ...summary);
  lines.push('');
  if (error) lines.push(`⚠️ ${esc(error)}`, '');

  switch (st.stage) {
    case 'role':
      lines.push('Xodim <b>rolini</b> tanlang:', '👨‍💻 Operator — savollar va texnik yordam', '👔 Menejer — buyurtma, hamkorlik va takliflar');
      break;
    case 'name':
      lines.push("✍️ Xodimning <b>ismi va familiyasini</b> yuboring (2–64 belgi).", 'Masalan: <i>Aziza Karimova</i>');
      break;
    case 'position':
      lines.push(
        '💼 <b>Lavozimini</b> yuboring (100 belgigacha).',
        "Masalan: <i>Katta operator</i> yoki <i>Savdo bo'limi menejeri</i>",
      );
      break;
    case 'description':
      lines.push(
        "📝 Qisqacha <b>tavsif</b> yuboring — mijozlar menyuda ko'radi (700 belgigacha).",
        "Masalan: <i>Buyurtma, yetkazib berish va to'lov bo'yicha yordam beraman.</i>",
      );
      break;
    case 'greeting': {
      const def = (await getSetting(SETTING_KEYS.greeting)) || DEFAULT_GREETING;
      lines.push(
        "🤖 <b>Avto-javob</b> matnini yuboring (1000 belgigacha). Mijoz bu xodimga birinchi marta yozganda bot shu matnni avtomatik yuboradi, keyin xodim o'zi javob beradi.",
        '',
        "🔤 O'rinbosarlar: <code>{name}</code> — mijoz ismi, <code>{staff}</code> — xodim ismi.",
        '',
        "«O'tkazib yuborish» bosilsa, umumiy standart matn ishlatiladi:",
        `<blockquote expandable>${esc(truncate(def, 1200))}</blockquote>`,
      );
      break;
    }
    case 'photo':
      lines.push(
        "🖼 Xodimning <b>rasmini</b> yuboring — mijozlar menyuda ko'radi.",
        "Oddiy rasm yoki rasm-fayl (JPG/PNG/WebP, 10 MB gacha) bo'lishi mumkin. Yuzi aniq ko'rinadigan, kvadratga yaqin rasm tavsiya etiladi.",
      );
      break;
  }
  if (st.stage !== 'role' && st.stage !== 'name') lines.push('', "<i>O'tkazib yuborish uchun «-» yuborishingiz ham mumkin.</i>");

  const kb = new InlineKeyboard();
  if (st.stage === 'role') kb.text('👨‍💻 Operator', 'adm:addrole:operator').text('👔 Menejer', 'adm:addrole:manager').row();
  if (st.stage !== 'role' && st.stage !== 'name') kb.text("⏭ O'tkazib yuborish", `adm:skip:${st.stage}`).row();
  kb.text('✖️ Bekor qilish', 'adm:cancel');
  return { text: lines.join('\n'), keyboard: kb };
}

async function editPromptView(s: Staff, field: EditField, error?: string): Promise<View> {
  const lines = [`✏️ <b>${esc(s.full_name)}</b> — ${FIELD_TITLES[field]}ni o'zgartirish`, ''];
  switch (field) {
    case 'link_code': {
      const link = await clientLinkOf(s);
      lines.push(
        `Hozirgi nom: ${s.link_code ? `<code>${esc(s.link_code)}</code>` : '—'}`,
        ...(link ? [`Havola: ${esc(link)}`] : []),
        '',
        `✍️ Yangi nomni yuboring: ${esc(LINK_RULES)}`,
        "⚠️ Nom o'zgarsa, eski havola ishlamay qoladi.",
      );
      if (error) lines.push('', `❌ ${esc(error)}`);
      return { text: lines.join('\n'), keyboard: CANCEL_KB() };
    }
    case 'full_name':
      lines.push(`Hozirgi ism: <code>${esc(s.full_name)}</code>`, '', 'Yangi ismni yuboring (2–64 belgi).');
      break;
    case 'position':
      lines.push(
        `Hozirgi lavozim: ${s.position ? `<code>${esc(s.position)}</code>` : '—'}`,
        '',
        'Yangi lavozimni yuboring (100 belgigacha). Tozalash uchun «-» yuboring.',
      );
      break;
    case 'description':
      lines.push(
        'Hozirgi tavsif:',
        s.description ? `<blockquote expandable>${esc(s.description)}</blockquote>` : '—',
        '',
        'Yangi tavsifni yuboring (700 belgigacha). Tozalash uchun «-» yuboring.',
      );
      break;
    case 'greeting':
      lines.push(
        'Hozirgi avto-javob:',
        s.greeting ? `<blockquote expandable>${esc(s.greeting)}</blockquote>` : "<i>standart (umumiy matn ishlatilmoqda)</i>",
        '',
        'Yangi avto-javob matnini yuboring (1000 belgigacha).',
        "🔤 O'rinbosarlar: <code>{name}</code> — mijoz ismi, <code>{staff}</code> — xodim ismi.",
        "♻️ Standart (umumiy) matnga qaytarish uchun «-» yuboring.",
      );
      break;
    case 'photo':
      lines.push(
        `Hozirgi rasm: ${s.photo_file_id ? 'bor' : "yo'q"}`,
        '',
        '🖼 Yangi rasm yuboring — oddiy rasm yoki rasm-fayl (JPG/PNG/WebP, 10 MB gacha).',
        s.photo_file_id ? "Rasmni olib tashlash uchun «-» yuboring." : '',
      );
      break;
  }
  if (error) lines.push('', `⚠️ ${esc(error)}`);
  return { text: lines.join('\n').replace(/\n+$/, ''), keyboard: CANCEL_KB() };
}

async function settingView(name: SettingName, error?: string): Promise<View> {
  const meta = SETTINGS[name];
  const current = await getSetting(meta.key);
  const shown = current ?? meta.def;
  const build = (max: number): string => {
    const lines = [
      `<b>${meta.title}</b>`,
      esc(meta.about),
      '',
      current ? "✏️ Hozirgi matn (o'zgartirilgan):" : '📄 Hozirgi matn (standart):',
      `<blockquote expandable>${esc(truncate(shown, max))}</blockquote>`,
      '',
      `🔤 O'rinbosarlar: ${meta.placeholders}`,
      '',
    ];
    if (error) lines.push(`⚠️ ${esc(error)}`, '');
    lines.push(
      current
        ? `✍️ Yangi matnni yuboring (${SETTING_MAX} belgigacha). Standartga qaytarish uchun «-» yuboring yoki tugmani bosing.`
        : `✍️ Yangi matnni yuboring (${SETTING_MAX} belgigacha).`,
    );
    return lines.join('\n');
  };
  const text = fit((a) => build(a), [[SETTING_MAX, 0], [1000, 0], [300, 0]], TEXT_LIMIT) ?? build(100);
  const kb = new InlineKeyboard();
  // Standart matn ishlatilayotgan bo'lsa, qaytaradigan narsa yo'q — tugma ko'rsatilmaydi
  if (current) kb.text('♻️ Standartga qaytarish', `adm:reset:${name}`).row();
  kb.text('✖️ Bekor qilish', 'adm:cancel');
  return { text, keyboard: kb };
}

/** Statistika sahifasidagi xodimlar soni (matn 4096 belgidan oshmasligi uchun). */
const STATS_PAGE_SIZE = 30;

async function statsView(page: number, role: PanelRole): Promise<View> {
  const sql = db();
  const perPage = (p: number) => sql<
    {
      id: number;
      full_name: string;
      role: Role;
      tg_user_id: number | null;
      is_active: boolean;
      is_online: boolean;
      chats: number;
      unread: number;
      total: number;
    }[]
  >`
    select s.id, s.full_name, s.role, s.tg_user_id, s.is_active, s.is_online,
           count(c.id) filter (where c.last_message_at is not null)::int as chats,
           coalesce(sum(c.unread_staff), 0)::int as unread,
           count(*) over ()::int as total
    from staff s
    left join conversations c on c.staff_id = s.id
    where s.deleted_at is null
    group by s.id
    order by chats desc, s.sort_order asc, s.id asc
    limit ${STATS_PAGE_SIZE} offset ${p * STATS_PAGE_SIZE}`;

  let p = Math.max(0, Math.trunc(page) || 0);
  const complaints = can(role, 'complaints');
  const [st, first, cNew, cAll] = await Promise.all([
    getStats(),
    perPage(p),
    complaints ? countComplaints('new') : Promise.resolve(0),
    complaints ? countComplaints('all') : Promise.resolve(0),
  ]);
  let per = first;
  // Sahifa endi mavjud emas (xodimlar o'chirilgan) — oxirgi sahifani ko'rsatamiz
  if (!per.length && p > 0) {
    const all = await sql<{ n: number }[]>`select count(*)::int as n from staff where deleted_at is null`;
    p = Math.max(0, Math.ceil((all[0]?.n ?? 0) / STATS_PAGE_SIZE) - 1);
    per = await perPage(p);
  }
  const total = per[0]?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / STATS_PAGE_SIZE));

  const lines = [
    '📊 <b>Statistika</b>',
    '',
    `👥 Mijozlar: <b>${fmtNum(st.clients)}</b> (so'nggi 24 soatda +${fmtNum(st.clients_today)})`,
    `💬 Suhbatlar: <b>${fmtNum(st.conversations)}</b>`,
    `✉️ Xabarlar: <b>${fmtNum(st.messages)}</b> (so'nggi 24 soatda +${fmtNum(st.messages_today)})`,
    `🧑‍💼 Xodimlar: <b>${fmtNum(st.staff_total)}</b> (akkaunti ulangan: ${fmtNum(st.staff_linked)})`,
  ];
  if (complaints) lines.push(`⚠️ Shikoyatlar: ${fmtNum(cNew)} yangi / ${fmtNum(cAll)} jami`);
  if (per.length) {
    const range = pages > 1 ? ` — ${fmtNum(p * STATS_PAGE_SIZE + 1)}–${fmtNum(p * STATS_PAGE_SIZE + per.length)} / ${fmtNum(total)}` : '';
    lines.push('', `<b>Xodimlar bo'yicha</b> (chatlar · o'qilmagan)${range}:`);
    for (const s of per) {
      const icon = s.tg_user_id != null ? (s.is_active ? (s.is_online ? '🟢' : '⚪️') : '🚫') : '⏳';
      const unread = s.unread ? ` · 🔴 ${fmtNum(s.unread)}` : '';
      lines.push(`${icon} ${roleIcon(s.role)} ${esc(oneLine(s.full_name, 32))} — ${fmtNum(s.chats)}${unread}`);
    }
  }
  const kb = new InlineKeyboard();
  if (pages > 1) {
    if (p > 0) kb.text('⬅️', `adm:stats:${p - 1}`);
    kb.text(`${p + 1}/${pages}`, 'noop');
    if (p < pages - 1) kb.text('➡️', `adm:stats:${p + 1}`);
    kb.row();
  }
  kb.text('🔄 Yangilash', `adm:stats:${p}`).text('⬅️ Orqaga', 'adm:home');
  return { text: lines.join('\n'), keyboard: kb };
}

// ───────────────────────────── Composer ─────────────────────────────

export const adminComposer = new Composer<StaffContext>();

// Panel roli bo'lmaganlar (oddiy xodimlar, huquqi olib tashlanganlar) uchun panel kirish nuqtalari yopiq
const guest = adminComposer.filter((ctx) => !ctx.admin);
// Huquqi olib tashlangan foydalanuvchining tugallanmagan panel amali bekor qilinadi — xabar odatdagidek
// (xodim xabari sifatida) qayta ishlanadi
guest.on('message', dropForbiddenState);
guest.command('admin', denyEntry);
guest.hears(BTN.admin, denyEntry);
guest.callbackQuery(PANEL_CALLBACK_RE, (ctx) => ctx.answerCallbackQuery({ text: NO_ACCESS_TEXT, show_alert: true }));

const adminOnly = adminComposer.filter((ctx) => ctx.admin);
// 1) Kutilayotgan holat bo'lsa — xabarni shu yerda "yeb qo'yamiz" (mijozga ketmaydi)
adminOnly.on('message', onPendingInput);
// 2) Xodim sifatida boshqa chatga o'tsa — tugallanmagan admin amali bekor qilinadi
adminOnly.callbackQuery(/^(act|open):/, dropStateOnChatSwitch);
// 3) Kirish nuqtalari
adminOnly.command('admin', (ctx) => showHome(ctx, 'new'));
adminOnly.hears(BTN.admin, (ctx) => showHome(ctx, 'new'));
adminOnly.callbackQuery(/^adm:/, onAdminCallback);
// 4) ROP/developer: shikoyatlar va ommaviy xabar; developer: developer paneli (har biri o'z huquqini tekshiradi)
adminOnly.use(complaintsComposer);
adminOnly.use(broadcastComposer);
adminOnly.use(watchComposer);
adminOnly.use(subscribeComposer);
adminOnly.use(developerComposer);

async function showHome(ctx: StaffContext, mode: 'edit' | 'new', notice?: string): Promise<void> {
  await render(ctx, await homeView(ctx.panelRole!, notice), mode);
}

/** Panel roli yo'q foydalanuvchi /admin yoki «⚙️ Admin panel» ni bosdi (eski klaviatura) — klaviatura yangilanadi. */
async function denyEntry(ctx: StaffContext): Promise<void> {
  await sendHtml(ctx, NO_ACCESS_TEXT, { markup: mainKeyboard(ctx.staff, false) });
}

const FORBIDDEN_DROPPED_TEXT = "ℹ️ Tugallanmagan admin amali bekor qilindi — endi bu amal uchun ruxsatingiz yo'q.";

/** Panel huquqi yo'q (yoki yetmaydigan) foydalanuvchining holati: bekor qilinadi, xabar keyingi handlerlarga o'tadi. */
async function dropForbiddenState(ctx: StaffContext, next: NextFunction): Promise<void> {
  const uid = ctx.from!.id;
  const row = await loadStateRow(uid);
  if (row && (await casState(uid, row.st, null)) && row.st.step !== 'group' && row.fresh) {
    await stripKeyboard(ctx, row.st.promptMsgId);
    await sendHtml(ctx, FORBIDDEN_DROPPED_TEXT);
  }
  return next();
}

async function stale(ctx: StaffContext): Promise<void> {
  await ctx.answerCallbackQuery({ text: STALE_BUTTON_TEXT });
}

async function onPendingInput(ctx: StaffContext, next: NextFunction): Promise<void> {
  const uid = ctx.from!.id;
  const row = await loadStateRow(uid);
  if (!row) return next();
  const { st } = row;
  const msg = ctx.message!;

  // Muddati o'tgan amal: bekor qilinadi, xabar esa odatdagidek qayta ishlanadi (hech qachon admin kiritmasi bo'lmaydi)
  if (!row.fresh) {
    if ((await casState(uid, st, null)) && st.step !== 'group') {
      await stripKeyboard(ctx, st.promptMsgId);
      await sendHtml(ctx, EXPIRED_TEXT);
    }
    return next();
  }

  if (st.step === 'group') {
    // Qabul qilingan albomning qolgan rasmlari — jimgina e'tiborsiz
    if (msg.media_group_id && msg.media_group_id === st.mediaGroupId) return;
    await casState(uid, st, null);
    return next();
  }

  // Rol o'zgargan (masalan, ROP → admin): bu amalga endi ruxsat yo'q — bekor qilinadi, xabar odatdagidek qayta ishlanadi
  if (!can(ctx.panelRole, statePerm(st))) {
    if (await casState(uid, st, null)) {
      await stripKeyboard(ctx, st.promptMsgId);
      await sendHtml(ctx, FORBIDDEN_DROPPED_TEXT);
    }
    return next();
  }

  // Albomning qolgan elementlari: so'rov bir marta qayta ko'rsatilgan (yoki albomdagi rasm-fayl allaqachon
  // qayta ishlanmoqda) — jimgina e'tiborsiz. Faqat rasm qadamida albomdagi oddiy rasm baribir qabul qilinadi
  // (masalan, rasm+video albomida video oldin kelgan bo'lsa, rasm yo'qolmasin).
  if (st.ignoreGroup && msg.media_group_id === st.ignoreGroup && !(isPhotoStep(st) && msg.photo)) return;

  // Buyruq yoki asosiy menyu tugmasi — amal bekor qilinadi va buyruq odatdagidek bajariladi
  if (isCommandMessage(msg) || isMainButton(msg.text)) {
    const dropped = await takeState(uid);
    if (dropped && dropped.step !== 'group') {
      await stripKeyboard(ctx, dropped.promptMsgId);
      const toAdmin = msg.text === BTN.admin || /^\/admin(@\w+)?(\s|$)/i.test(msg.text ?? '');
      if (!toAdmin) await sendHtml(ctx, DROPPED_TEXT);
    }
    return next();
  }

  // Admin ham xodim: xabar admin kiritmasimi yoki mijozga javobmi — taxmin qilinmaydi.
  if (ctx.staff && (await askSaveOrSend(ctx, msg, row))) return;

  return handleInput(ctx, msg, st);
}

function isPhotoStep(st: InputState): boolean {
  return (st.step === 'add' && st.stage === 'photo') || (st.step === 'edit' && st.field === 'photo');
}

function handleInput(ctx: StaffContext, msg: TgMessage, st: InputState): Promise<void> {
  switch (st.step) {
    case 'add':
      return handleAddInput(ctx, msg, st);
    case 'edit':
      return handleEditInput(ctx, msg, st);
    case 'setting':
      return handleSettingInput(ctx, msg, st);
    case 'broadcast':
    case 'broadcast_confirm':
      return handleBroadcastInput(ctx, msg, st);
    case 'dev_add':
      return handleDevAddInput(ctx, msg, st);
  }
}

/** Kutilayotgan amalning qisqa nomi (ogohlantirishlar uchun). */
function stateLabel(st: InputState): string {
  switch (st.step) {
    case 'add':
      return `➕ yangi xodim, ${STAGE_NO[st.stage]}/6-qadam`;
    case 'edit':
      return st.field === 'link_code' ? '✏️ xodim havola nomi' : `✏️ xodim ${FIELD_TITLES[st.field]}i`;
    case 'setting':
      return SETTINGS[st.key].title;
    case 'broadcast':
    case 'broadcast_confirm':
      return '📣 mijozlarga xabar';
    case 'dev_add':
      return st.role === 'rop' ? "➕ ROP qo'shish" : "➕ admin qo'shish";
  }
}

/** Holatning qisqa belgisi: «💾 Saqlash» tugmasi faqat o'sha qadam uchun ishlaydi (ikki marta bosish xavfsiz). */
function stateTag(st: InputState): string {
  switch (st.step) {
    case 'add':
      return `a${STAGE_NO[st.stage]}`;
    case 'edit':
      return `e${st.staffId}.${EDIT_FIELDS.indexOf(st.field)}`;
    case 'setting':
      return `s${st.key}`;
    case 'broadcast':
      return 'b';
    case 'broadcast_confirm':
      return `bc${st.srcMsgId}`;
    case 'dev_add':
      return `d${st.role}`;
  }
}

/**
 * Admin ham xodim bo'lsa: Reply so'rov xabarining o'ziga emas, boshqa xabarga qilingan bo'lsa, yoki aktiv
 * suhbati bor va so'rov ASK_AFTER_SEC dan eski bo'lsa — xabar na saqlanadi, na mijozga yuboriladi; tanlov
 * so'raladi. Tugmalar asl xabarni shu ogohlantirishning `reply_to_message` idan oladi (hech narsa saqlanmaydi).
 * So'ralgan bo'lsa true.
 */
async function askSaveOrSend(ctx: StaffContext, msg: TgMessage, row: StateRow): Promise<boolean> {
  const me = ctx.staff!;
  const st = row.st as InputState;
  const replyTo = msg.reply_to_message;
  if (replyTo && replyTo.message_id === st.promptMsgId) return false;

  let target: { id: number; name: string } | null = null;
  if (replyTo) {
    const conv = await resolveReplyConversation(me, ctx.chat!.id, ctx.me.id, replyTo);
    const v = conv ? await ownConversationView(me, conv.id) : null;
    if (v) target = { id: v.id, name: clientNameOf(v) };
  } else {
    if (row.ageSec < ASK_AFTER_SEC || !me.active_conversation_id) return false;
    const v = await ownActiveConversation(me);
    if (!v) return false;
    target = { id: v.id, name: clientNameOf(v) };
  }

  const lines = [
    `⚠️ Sizda tugallanmagan admin amali bor (${esc(stateLabel(st))}), shuning uchun bu xabar hozircha na saqlandi, na mijozga <b>yuborilmadi</b>.`,
    '',
  ];
  if (target) lines.push(`Bu — <b>${esc(oneLine(target.name, 40))}</b>${dativeSuffix(oneLine(target.name, 40))} javobmi yoki admin amali uchun matnmi? Tanlang 👇`);
  else lines.push('Bu xabarni admin amali uchun saqlaysizmi? Tanlang 👇');
  lines.push('', "<i>💡 Admin amali uchun so'rov xabarining o'ziga Reply qilsangiz, so'ralmaydi.</i>");

  const kb = new InlineKeyboard();
  if (target) kb.text(`✉️ ${dative(oneLine(target.name, 28))} yuborish`, `to:${target.id}`).row();
  kb.text('💾 Admin amali uchun saqlash', `adm:save:${stateTag(st)}`).row();
  kb.text('✖️ Amalni bekor qilish', 'adm:cancel');
  await sendHtml(ctx, lines.join('\n'), { replyTo: msg.message_id, markup: kb });
  return true;
}

/** `adm:save:<tag>` — ogohlantirilgan xabarni admin kiritmasi sifatida qabul qilish. */
async function onSaveChoice(ctx: StaffContext, tag: string | undefined): Promise<void> {
  const uid = ctx.from!.id;
  const st = await loadState(uid);
  const prompt = callbackMessage(ctx);
  const orig = prompt?.reply_to_message as TgMessage | undefined;
  if (!st || st.step === 'group' || stateTag(st) !== tag || !orig || orig.from?.id !== uid) {
    await stale(ctx);
    if (prompt) await stripKeyboard(ctx, prompt.message_id);
    return;
  }
  // Rol o'zgargan (masalan, ROP → admin): bu amalga endi ruxsat yo'q — holat bekor qilinadi
  if (!can(ctx.panelRole, statePerm(st))) {
    if (await casState(uid, st, null)) await stripKeyboard(ctx, st.promptMsgId);
    if (prompt) await stripKeyboard(ctx, prompt.message_id);
    await ctx.answerCallbackQuery({ text: NO_ACCESS_TEXT, show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  await stripKeyboard(ctx, prompt!.message_id);
  await handleInput(ctx, orig, st);
}

async function dropStateOnChatSwitch(ctx: StaffContext, next: NextFunction): Promise<void> {
  if (ctx.staff) {
    const dropped = await takeState(ctx.from!.id);
    if (dropped && dropped.step !== 'group') {
      await stripKeyboard(ctx, dropped.promptMsgId);
      await sendHtml(ctx, DROPPED_TEXT);
    }
  }
  return next();
}

async function onAdminCallback(ctx: StaffContext): Promise<void> {
  const data = ctx.callbackQuery?.data ?? '';
  const [, action = '', a1, a2] = data.split(':');
  const uid = ctx.from!.id;

  // ROP/developer bo'limi: huquq yetmasa — kutilayotgan kiritmaga tegilmaydi
  if (action === 'bc' && !(await requirePerm(ctx, 'broadcast'))) return;

  // Oddiy navigatsiya tugmalari kutilayotgan kiritishni bekor qiladi
  // (aks holda keyingi xabar kutilmaganda admin kiritmasi bo'lib qolishi mumkin).
  const keepsState = ['addrole', 'skip', 'cancel', 'add', 'e', 'set', 'save'].includes(action);
  if (!keepsState) await clearState('staff', uid);

  switch (action) {
    case 'home':
      await ctx.answerCallbackQuery();
      await showHome(ctx, 'edit');
      return;
    case 'add':
      return startAdd(ctx);
    case 'addrole':
      return onAddRole(ctx, a1);
    case 'skip':
      return onSkip(ctx, a1);
    case 'cancel':
      return onCancelFlow(ctx);
    case 'list':
      await ctx.answerCallbackQuery();
      await render(ctx, await listView(Number(a1 ?? 0) || 0));
      return;
    case 's':
      return showCard(ctx, parseId(a1));
    case 'e':
      return startEdit(ctx, parseId(a1), a2);
    case 'role':
      return toggleRole(ctx, parseId(a1));
    case 'act':
      return toggleActive(ctx, parseId(a1));
    case 'inv':
      return newInvite(ctx, parseId(a1));
    case 'unl':
      return confirmUnlink(ctx, parseId(a1));
    case 'unlok':
      return doUnlink(ctx, parseId(a1));
    case 'del':
      return confirmDelete(ctx, parseId(a1));
    case 'delok':
      return doDelete(ctx, parseId(a1));
    case 'save':
      return onSaveChoice(ctx, a1);
    case 'set':
      return showSetting(ctx, a1);
    case 'reset':
      return confirmReset(ctx, a1);
    case 'resetok':
      return doResetSetting(ctx, a1);
    case 'stats':
      await ctx.answerCallbackQuery();
      await render(ctx, await statsView(Number(a1 ?? 0) || 0, ctx.panelRole!));
      return;
    case 'bc':
      return startBroadcast(ctx);
    default:
      return stale(ctx);
  }
}

/** Callback dagi xodimni yuklash; topilmasa ro'yxatni ko'rsatadi va null qaytaradi. */
async function loadStaffOr(ctx: StaffContext, id: number | null): Promise<Staff | null> {
  const s = id ? await getStaff(id) : null;
  if (s && !s.deleted_at) return s;
  await ctx.answerCallbackQuery({ text: "Xodim topilmadi (o'chirilgan bo'lishi mumkin)", show_alert: true });
  await render(ctx, await listView(0));
  return null;
}

async function notifyUser(ctx: StaffContext, tgUserId: number | null, text: string, keyboard = false): Promise<void> {
  if (!tgUserId) return;
  try {
    // Xodim profili uzildi/o'chirildi: klaviatura — panel roli bo'lsa admin klaviaturasi, aks holda olib tashlanadi
    const panel = keyboard ? !!(await getPanelRole(tgUserId).catch(() => null)) : false;
    await ctx.api.sendMessage(tgUserId, text, {
      parse_mode: 'HTML',
      ...(keyboard ? { reply_markup: mainKeyboard(null, panel) } : {}),
    });
  } catch (e) {
    console.warn(`[staff/admin] ${tgUserId} ga xabar yuborilmadi:`, tgErrorDescription(e));
  }
}

// ── Karta ──

async function showCard(ctx: StaffContext, id: number | null, notice?: string): Promise<void> {
  const s = await loadStaffOr(ctx, id);
  if (!s) return;
  await ctx.answerCallbackQuery();
  await render(ctx, await cardView(s, notice));
}

// ── Qo'shish ──

async function startAdd(ctx: StaffContext): Promise<void> {
  const st: AddState = { step: 'add', stage: 'role', draft: {} };
  await ctx.answerCallbackQuery();
  await enterState(ctx, st, await addPromptView(st), 'edit');
}

async function onAddRole(ctx: StaffContext, role: string | undefined): Promise<void> {
  const st = await loadState(ctx.from!.id);
  if (!st || st.step !== 'add' || st.stage !== 'role' || (role !== 'operator' && role !== 'manager')) return stale(ctx);
  await advanceAdd(ctx, st, { ...st.draft, role }, 'name', true);
}

async function onSkip(ctx: StaffContext, stage: string | undefined): Promise<void> {
  const st = await loadState(ctx.from!.id);
  if (!st || st.step !== 'add' || st.stage !== stage) return stale(ctx);
  switch (st.stage) {
    case 'position':
      return advanceAdd(ctx, st, { ...st.draft, position: '' }, 'description', true);
    case 'description':
      return advanceAdd(ctx, st, { ...st.draft, description: '' }, 'greeting', true);
    case 'greeting':
      return advanceAdd(ctx, st, { ...st.draft, greeting: null }, 'photo', true);
    case 'photo':
      return finishAdd(ctx, st, null, true);
    default:
      return stale(ctx);
  }
}

async function advanceAdd(ctx: StaffContext, st: AddState, draft: Draft, stage: AddStage, viaCallback: boolean): Promise<void> {
  const uid = ctx.from!.id;
  const next: AddState = { step: 'add', stage, draft };
  if (!(await casState(uid, st, next))) {
    // Parallel kelgan boshqa xabar/tugma allaqachon qayta ishladi
    if (viaCallback) await stale(ctx);
    return;
  }
  if (viaCallback) await ctx.answerCallbackQuery();
  else await stripKeyboard(ctx, st.promptMsgId);
  const msgId = await render(ctx, await addPromptView(next), viaCallback ? 'edit' : 'new');
  await casState(uid, next, { ...next, promptMsgId: msgId });
}

/**
 * Albomdagi rasm uchun: holatni yakunlash (CAS). Albomning boshqa (noto'g'ri turdagi) elementi shu orada
 * so'rovni qayta ko'rsatib, holatga `ignoreGroup` belgisini qo'ygan bo'lsa — yangilangan holat bilan bir marta
 * qayta urinamiz (rasm yo'qolib qolmasin). Yakunlangan holat (yoki null) qaytadi.
 */
async function finishStateForAlbum<T extends AddState | EditState>(
  uid: number,
  st: T,
  msg: TgMessage | null,
  same: (cur: AdminState) => cur is T,
): Promise<T | null> {
  if (await finishState(uid, st, msg)) return st;
  if (!msg?.media_group_id) return null;
  const cur = await loadState(uid);
  if (!cur || !same(cur) || cur.ignoreGroup !== msg.media_group_id) return null;
  return (await finishState(uid, cur, msg)) ? cur : null;
}

async function finishAdd(
  ctx: StaffContext,
  st: AddState,
  photo: PhotoRef | null,
  viaCallback: boolean,
  msg: TgMessage | null = null,
): Promise<void> {
  const uid = ctx.from!.id;
  const d = st.draft;
  if (!d.role || !d.full_name) {
    await clearState('staff', uid);
    if (viaCallback) await ctx.answerCallbackQuery();
    await sendHtml(ctx, "⚠️ Ma'lumotlar to'liq emas. Iltimos, xodim qo'shishni qaytadan boshlang.", {
      markup: new InlineKeyboard().text("➕ Xodim qo'shish", 'adm:add'),
    });
    return;
  }
  // Birinchi yozuv — parallel bosish/albom rasmlari bitta xodimni ikki marta yaratmasligi uchun kafolat
  const done = await finishStateForAlbum(
    uid,
    st,
    msg,
    (cur): cur is AddState => cur.step === 'add' && cur.stage === st.stage,
  );
  if (!done) {
    if (viaCallback) await stale(ctx);
    return;
  }
  const role = d.role;
  const fullName = d.full_name;

  let s: Staff;
  try {
    s = await createStaff({
      role,
      full_name: fullName,
      position: d.position ?? '',
      description: d.description ?? '',
      greeting: d.greeting ?? null,
      photo_file_id: photo?.fileId ?? null,
      photo_unique_id: photo?.uniqueId ?? null,
    });
  } catch (e) {
    logError('createStaff xatosi', e);
    // Qoralama yo'qolmasin: holatni tiklaymiz — admin shu qadamdan qayta urina oladi
    await setState('staff', uid, done).catch((err) => logError('holatni tiklash', err));
    if (viaCallback) {
      await ctx.answerCallbackQuery({ text: "⚠️ Saqlanmadi, qayta urinib ko'ring", show_alert: true });
    } else {
      await reprompt(ctx, done, "Saqlanmadi (server xatosi). Rasmni qayta yuboring yoki «O'tkazib yuborish» ni bosing.", null);
    }
    return;
  }
  if (viaCallback) await ctx.answerCallbackQuery({ text: "✅ Xodim qo'shildi" });
  else await stripKeyboard(ctx, done.promptMsgId);

  const notice =
    "✅ <b>Yangi xodim qo'shildi!</b>\n" +
    "📨 Taklif havolasini xodimga yuboring — u havolani bosib, Telegram akkauntini ulaydi. Shundan so'ng mijozlar uni menyuda ko'radi.\n" +
    "🔗 Mijozlar uchun havolasi ham tayyor (quyida) — mijoz shu havola orqali kirsa, darhol shu xodim bilan chat boshlanadi.";
  // Xodim allaqachon yaratilgan: karta chiqmasa ham «qayta urinib ko'ring» ko'rsatilmaydi (admin uni ikkinchi marta
  // qo'shib yubormasin) — o'rniga qisqa tasdiq va karta tugmasi
  await afterSuccess(
    'yangi xodim kartasi',
    async () => render(ctx, await cardView(s, notice), viaCallback ? 'edit' : 'new'),
    () =>
      sendHtml(ctx, `✅ <b>${esc(s.full_name)}</b> (${roleLabel(s.role)}) qo'shildi.`, {
        markup: new InlineKeyboard().text('🧑‍💼 Xodim kartasi', `adm:s:${s.id}`),
      }),
  );
}

/**
 * Rasm qadamida kelgan xabardan rasm olish: oddiy rasm yoki rasm-fayl (yuklab olinib, rasmga aylantiriladi).
 * Albomdagi rasm-fayllar uchun avval albom "egallanadi" — qolgan elementlar og'ir ishni takrorlamaydi.
 * `null` — xabar bu yerda qayta ishlandi (xato ko'rsatildi yoki boshqa element egallagan).
 */
async function photoInput<T extends AddState | EditState>(
  ctx: StaffContext,
  msg: TgMessage,
  st: T,
  allowRemove: boolean,
): Promise<{ st: T; photo: PhotoRef } | null> {
  const direct = largestPhoto(msg);
  if (direct) return { st, photo: direct };
  const doc = imageDocument(msg);
  if (!doc) {
    await reprompt(ctx, st, photoError(msg, allowRemove), msg);
    return null;
  }
  let cur = st;
  const mgid = msg.media_group_id;
  if (mgid && cur.ignoreGroup !== mgid) {
    const claimed = { ...cur, ignoreGroup: mgid };
    if (!(await casState(ctx.from!.id, cur, claimed))) return null;
    cur = claimed;
  }
  const r = await photoFromDocument(ctx, doc);
  if (!r.ok) {
    await reprompt(ctx, cur, r.error, msg);
    return null;
  }
  return { st: cur, photo: r.photo };
}

async function handleAddInput(ctx: StaffContext, msg: TgMessage, st: AddState): Promise<void> {
  const text = msg.text;
  const isDash = text?.trim() === '-';
  switch (st.stage) {
    case 'role': {
      const role = parseRoleText(text);
      if (!role) return reprompt(ctx, st, 'Iltimos, quyidagi tugmalardan birini bosing: Operator yoki Menejer.', msg);
      return advanceAdd(ctx, st, { ...st.draft, role }, 'name', false);
    }
    case 'name': {
      if (text === undefined) {
        return reprompt(ctx, st, `Iltimos, ismni matn ko'rinishida yuboring. ${RULES.full_name.hint}`, msg);
      }
      const v = validateText('full_name', text);
      if (!v.ok) return reprompt(ctx, st, v.error, msg);
      return advanceAdd(ctx, st, { ...st.draft, full_name: v.value }, 'position', false);
    }
    case 'position':
    case 'description':
    case 'greeting': {
      const field = st.stage;
      if (text === undefined) {
        return reprompt(ctx, st, `Iltimos, matn yuboring yoki «O'tkazib yuborish» tugmasini bosing. ${RULES[field].hint}`, msg);
      }
      let value: string | null;
      if (isDash) {
        value = field === 'greeting' ? null : '';
      } else {
        const v = validateText(field, text);
        if (!v.ok) return reprompt(ctx, st, v.error, msg);
        value = v.value;
      }
      if (field === 'position') return advanceAdd(ctx, st, { ...st.draft, position: value ?? '' }, 'description', false);
      if (field === 'description') return advanceAdd(ctx, st, { ...st.draft, description: value ?? '' }, 'greeting', false);
      return advanceAdd(ctx, st, { ...st.draft, greeting: value }, 'photo', false);
    }
    case 'photo': {
      if (isDash) return finishAdd(ctx, st, null, false, msg);
      const got = await photoInput(ctx, msg, st, false);
      if (!got) return;
      return finishAdd(ctx, got.st, got.photo, false, msg);
    }
  }
}

/**
 * Noto'g'ri kiritishda: qoidani eslatib, so'rovni qayta ko'rsatish.
 * Albom (media group) bo'lsa — so'rov faqat bir marta: xabar yuborishdan OLDIN albom CAS bilan "egallanadi",
 * shuning uchun bir vaqtda kelgan elementlardan faqat bittasi so'rov yuboradi, qolganlari jimgina tugaydi.
 */
async function reprompt(ctx: StaffContext, st: CoreInputState, error: string, msg: TgMessage | null): Promise<void> {
  const uid = ctx.from!.id;
  let cur: CoreInputState = st;
  const mgid = msg?.media_group_id;
  if (mgid) {
    if (cur.ignoreGroup !== mgid) {
      const claimed: CoreInputState = { ...cur, ignoreGroup: mgid };
      if (!(await casState(uid, cur, claimed))) return;
      cur = claimed;
    }
  }
  let view: View;
  if (cur.step === 'add') {
    view = await addPromptView(cur, error);
  } else if (cur.step === 'edit') {
    const s = await getStaff(cur.staffId);
    if (!s || s.deleted_at) {
      await clearState('staff', uid);
      await stripKeyboard(ctx, cur.promptMsgId);
      await sendHtml(ctx, "⚠️ Xodim topilmadi — u o'chirilgan bo'lishi mumkin.", {
        markup: new InlineKeyboard().text("👥 Xodimlar ro'yxati", 'adm:list'),
      });
      return;
    }
    view = await editPromptView(s, cur.field, error);
  } else {
    view = await settingView(cur.key, error);
  }
  await stripKeyboard(ctx, cur.promptMsgId);
  const msgId = await render(ctx, view, 'new');
  // Albom bo'lmagan xabar — eski albom belgisi kerak emas
  const next = mgid ? { ...cur, promptMsgId: msgId } : { ...withoutGroup(cur), promptMsgId: msgId };
  await casState(uid, cur, next);
}

// ── Tahrirlash ──

async function startEdit(ctx: StaffContext, id: number | null, field: string | undefined): Promise<void> {
  if (!EDIT_FIELDS.includes(field as EditField)) {
    await clearState('staff', ctx.from!.id);
    return stale(ctx);
  }
  const s = await loadStaffOr(ctx, id);
  if (!s) {
    await clearState('staff', ctx.from!.id);
    return;
  }
  const st: EditState = { step: 'edit', staffId: s.id, field: field as EditField };
  await ctx.answerCallbackQuery();
  await enterState(ctx, st, await editPromptView(s, st.field), 'edit');
}

async function showUpdated(ctx: StaffContext, s: Staff | null, notice: string): Promise<void> {
  if (!s) {
    await sendHtml(ctx, "⚠️ Xodim topilmadi — u o'chirilgan bo'lishi mumkin.", {
      markup: new InlineKeyboard().text("👥 Xodimlar ro'yxati", 'adm:list'),
    });
    return;
  }
  // O'zgarish allaqachon saqlangan — karta eng yaxshi urinish
  await afterSuccess(
    'yangilangan xodim kartasi',
    async () => render(ctx, await cardView(s, notice), 'new'),
    () => sendHtml(ctx, notice, { markup: new InlineKeyboard().text('🧑‍💼 Xodim kartasi', `adm:s:${s.id}`) }),
  );
}

async function handleEditInput(ctx: StaffContext, msg: TgMessage, st: EditState): Promise<void> {
  const uid = ctx.from!.id;
  const s = await getStaff(st.staffId);
  if (!s || s.deleted_at) {
    await clearState('staff', uid);
    await stripKeyboard(ctx, st.promptMsgId);
    await showUpdated(ctx, null, '');
    return;
  }
  const isDash = msg.text?.trim() === '-';

  if (st.field === 'link_code') return handleLinkCodeInput(ctx, msg, st, s);

  if (st.field === 'photo') {
    if (isDash) {
      if (!(await casState(uid, st, null))) return;
      const u = await saveOrRestore(ctx, st, () => setStaffPhoto(s.id, null, null));
      if (u === undefined) return;
      await stripKeyboard(ctx, st.promptMsgId);
      return showUpdated(ctx, u, "🖼 Rasm olib tashlandi — mijozlar standart rasmni ko'radi.");
    }
    const got = await photoInput(ctx, msg, st, true);
    if (!got) return;
    const done = await finishStateForAlbum(
      uid,
      got.st,
      msg,
      (cur): cur is EditState => cur.step === 'edit' && cur.staffId === st.staffId && cur.field === 'photo',
    );
    if (!done) return;
    const u = await saveOrRestore(ctx, done, () => setStaffPhoto(s.id, got.photo.fileId, got.photo.uniqueId));
    if (u === undefined) return;
    await stripKeyboard(ctx, done.promptMsgId);
    return showUpdated(ctx, u, '✅ Rasm yangilandi.');
  }

  const field = st.field;
  if (msg.text === undefined) return reprompt(ctx, st, `Iltimos, matn yuboring. ${RULES[field].hint}`, msg);
  let patch: Partial<Pick<Staff, TextField>>;
  if (isDash && field !== 'full_name') {
    patch = field === 'greeting' ? { greeting: null } : field === 'position' ? { position: '' } : { description: '' };
  } else {
    const v = validateText(field, msg.text);
    if (!v.ok) return reprompt(ctx, st, v.error, msg);
    patch =
      field === 'full_name'
        ? { full_name: v.value }
        : field === 'position'
          ? { position: v.value }
          : field === 'description'
            ? { description: v.value }
            : { greeting: v.value };
  }
  if (!(await casState(uid, st, null))) return;
  const u = await saveOrRestore(ctx, st, () => updateStaff(s.id, patch));
  if (u === undefined) return;
  await stripKeyboard(ctx, st.promptMsgId);
  const notice =
    field === 'greeting' && patch.greeting === null ? '♻️ Avto-javob standart matnga qaytarildi.' : '✅ Saqlandi.';
  return showUpdated(ctx, u, notice);
}

/**
 * Mijozlar havolasi nomini o'zgartirish (`adm:e:<id>:link_code`). Noto'g'ri yoki band nom — so'rov qoida bilan
 * qayta ko'rsatiladi (holat saqlanib qoladi, admin boshqa nom yozadi); muvaffaqiyatli — yangilangan karta.
 */
async function handleLinkCodeInput(ctx: StaffContext, msg: TgMessage, st: EditState, s: Staff): Promise<void> {
  const uid = ctx.from!.id;
  if (msg.text === undefined) return reprompt(ctx, st, LINK_TEXT_ONLY, msg);
  const code = linkCodeInput(msg.text);
  if (!isValidLinkCode(code)) return reprompt(ctx, st, LINK_INVALID, msg);

  if (!(await casState(uid, st, null))) return;
  const r = await saveOrRestore(ctx, st, () => setStaffLinkCode(s.id, code));
  if (r === undefined) return;
  if (!r.ok) {
    if (r.reason === 'not_found') {
      await stripKeyboard(ctx, st.promptMsgId);
      return showUpdated(ctx, null, '');
    }
    // Band (yoki noto'g'ri) nom: holat qaytariladi — keyingi xabar yana havola nomi sifatida qabul qilinadi
    await setState('staff', uid, st);
    return reprompt(ctx, st, r.reason === 'taken' ? LINK_TAKEN : LINK_INVALID, null);
  }

  const u = r.staff;
  await stripKeyboard(ctx, st.promptMsgId);
  const changed = (s.link_code ?? '').toLowerCase() !== (u.link_code ?? '').toLowerCase();
  if (changed && u.tg_user_id && u.tg_user_id !== uid) {
    // Xodim eski havolani mijozlarga bergan bo'lishi mumkin — yangisini bilsin
    const link = await clientLinkOf(u);
    if (link) await notifyUser(ctx, u.tg_user_id, STAFF_NOTICE.linkChanged(link));
  }
  return showUpdated(ctx, u, changed ? "✅ Havola nomi saqlandi. Eski havola endi ishlamaydi." : '✅ Saqlandi.');
}

/**
 * Holat allaqachon (CAS bilan) olib tashlangandan keyingi yozuv. Baza xatosida holat tiklanadi va so'rov
 * qayta ko'rsatiladi — admin kiritgan qiymat qayta yuborilishi bilan saqlanadi. Xatoda `undefined`.
 */
async function saveOrRestore<R>(ctx: StaffContext, st: CoreInputState, write: () => Promise<R>): Promise<R | undefined> {
  try {
    return await write();
  } catch (e) {
    logError('admin amalini saqlash', e);
    const uid = ctx.from!.id;
    try {
      await setState('staff', uid, st);
      await reprompt(ctx, st, "Saqlanmadi (server xatosi). Iltimos, qayta yuboring.", null);
    } catch (err) {
      logError('holatni tiklash', err);
      throw e;
    }
    return undefined;
  }
}

// ── Rol, faollik, havola ──

async function toggleRole(ctx: StaffContext, id: number | null): Promise<void> {
  const s = await loadStaffOr(ctx, id);
  if (!s) return;
  const role: Role = s.role === 'operator' ? 'manager' : 'operator';
  const u = await updateStaff(s.id, { role });
  if (!u) {
    await loadStaffOr(ctx, null);
    return;
  }
  await ctx.answerCallbackQuery({ text: `🔄 Yangi rol: ${roleLabel(role)}` });
  // Rol allaqachon almashgan: «qayta urinib ko'ring» bo'yicha qayta bosish uni ortga qaytarardi
  await afterSuccess('rol almashgandan keyingi karta', async () => render(ctx, await cardView(u)));
}

async function toggleActive(ctx: StaffContext, id: number | null): Promise<void> {
  const s = await loadStaffOr(ctx, id);
  if (!s) return;
  const u = await updateStaff(s.id, { is_active: !s.is_active });
  if (!u) {
    await loadStaffOr(ctx, null);
    return;
  }
  await ctx.answerCallbackQuery({ text: u.is_active ? '✅ Blokdan chiqarildi' : '🚫 Bloklandi' });
  if (u.tg_user_id && u.tg_user_id !== ctx.from!.id) {
    await notifyUser(ctx, u.tg_user_id, u.is_active ? BLOCK_NOTICE.unblocked : BLOCK_NOTICE.blocked);
  }
  // Bloklash allaqachon bajarilgan: «qayta urinib ko'ring» bo'yicha qayta bosish uni ortga qaytarardi
  await afterSuccess('bloklashdan keyingi karta', async () => render(ctx, await cardView(u)));
}

async function newInvite(ctx: StaffContext, id: number | null): Promise<void> {
  const s = await loadStaffOr(ctx, id);
  if (!s) return;
  if (s.tg_user_id != null) {
    await ctx.answerCallbackQuery({ text: 'Bu xodimning akkaunti allaqachon ulangan.', show_alert: true });
    await render(ctx, await cardView(s));
    return;
  }
  const u = await regenerateInvite(s.id);
  if (!u) {
    await loadStaffOr(ctx, null);
    return;
  }
  await ctx.answerCallbackQuery({ text: '🔗 Yangi havola yaratildi' });
  await afterSuccess('yangi taklif havolasi kartasi', async () =>
    render(ctx, await cardView(u, '🔗 Yangi taklif havolasi yaratildi. Eski havola endi ishlamaydi.')),
  );
}

// ── Akkauntni uzish ──

async function confirmUnlink(ctx: StaffContext, id: number | null): Promise<void> {
  const s = await loadStaffOr(ctx, id);
  if (!s) return;
  if (s.tg_user_id == null) {
    await ctx.answerCallbackQuery({ text: 'Akkaunt ulanmagan' });
    await render(ctx, await cardView(s));
    return;
  }
  await ctx.answerCallbackQuery();
  const who = s.tg_username ? ` (@${esc(s.tg_username)})` : '';
  await render(ctx, {
    text:
      `🔌 <b>${esc(s.full_name)}</b>${who} akkauntini uzasizmi?\n\n` +
      "Xodim botdan foydalana olmaydi va mijozlar uni menyuda ko'rmaydi. Suhbatlar tarixi saqlanadi.\n" +
      'Qayta ulash uchun yangi taklif havolasi beriladi.',
    keyboard: new InlineKeyboard().text('✅ Ha, uzish', `adm:unlok:${s.id}`).text("❌ Yo'q", `adm:s:${s.id}`),
  });
}

async function doUnlink(ctx: StaffContext, id: number | null): Promise<void> {
  const s = await loadStaffOr(ctx, id);
  if (!s) return;
  if (s.tg_user_id == null) {
    await ctx.answerCallbackQuery({ text: 'Akkaunt allaqachon uzilgan' });
    await render(ctx, await cardView(s));
    return;
  }
  const oldTg = s.tg_user_id;
  const u = await unlinkStaff(s.id);
  if (!u) {
    await loadStaffOr(ctx, null);
    return;
  }
  await ctx.answerCallbackQuery({ text: '🔌 Akkaunt uzildi' });
  await notifyUser(ctx, oldTg, STAFF_NOTICE.unlinked(s.full_name), true);
  if (oldTg === ctx.from!.id) ctx.staff = null;
  await afterSuccess('akkaunt uzilgandan keyingi karta', async () =>
    render(ctx, await cardView(u, '🔌 Akkaunt uzildi. Qayta ulash uchun quyidagi yangi havolani yuboring.')),
  );
}

// ── O'chirish ──

async function confirmDelete(ctx: StaffContext, id: number | null): Promise<void> {
  const s = await loadStaffOr(ctx, id);
  if (!s) return;
  await ctx.answerCallbackQuery();
  await render(ctx, {
    text:
      `🗑 <b>${esc(s.full_name)}</b> (${roleLabel(s.role)}) ni o'chirasizmi?\n\n` +
      "Xodim ro'yxatdan olib tashlanadi va akkaunti uziladi. Suhbatlar tarixi bazada saqlanib qoladi.\n" +
      "⚠️ Bu amalni ortga qaytarib bo'lmaydi.",
    keyboard: new InlineKeyboard().text("✅ Ha, o'chirish", `adm:delok:${s.id}`).text("❌ Yo'q", `adm:s:${s.id}`),
  });
}

async function doDelete(ctx: StaffContext, id: number | null): Promise<void> {
  const s = id ? await getStaff(id) : null;
  if (!s || s.deleted_at) {
    await ctx.answerCallbackQuery({ text: "Xodim allaqachon o'chirilgan" });
    await render(ctx, await listView(0));
    return;
  }
  const oldTg = s.tg_user_id;
  const ok = await softDeleteStaff(s.id);
  await ctx.answerCallbackQuery({ text: ok ? "🗑 O'chirildi" : "Xodim allaqachon o'chirilgan" });
  if (ok && oldTg) {
    await notifyUser(ctx, oldTg, STAFF_NOTICE.deleted(s.full_name), true);
    if (oldTg === ctx.from!.id) ctx.staff = null;
  }
  await afterSuccess("o'chirilgandan keyingi ro'yxat", async () =>
    render(
      ctx,
      await listView(0, ok ? `🗑 <b>${esc(s.full_name)}</b> o'chirildi. Suhbatlar tarixi bazada saqlanib qoladi.` : undefined),
    ),
  );
}

// ── Umumiy matnlar ──

async function showSetting(ctx: StaffContext, name: string | undefined): Promise<void> {
  if (!isSettingName(name)) {
    await clearState('staff', ctx.from!.id);
    return stale(ctx);
  }
  const st: SettingState = { step: 'setting', key: name };
  await ctx.answerCallbackQuery();
  await enterState(ctx, st, await settingView(name), 'edit');
}

/** «♻️ Standartga qaytarish» — avval tasdiqlash (o'zgartirilgan matn qaytarib bo'lmas darajada o'chadi). */
async function confirmReset(ctx: StaffContext, name: string | undefined): Promise<void> {
  if (!isSettingName(name)) return stale(ctx);
  const meta = SETTINGS[name];
  const current = await getSetting(meta.key);
  if (current == null) {
    await ctx.answerCallbackQuery({ text: 'ℹ️ Hozir standart matn ishlatilmoqda' });
    return showSetting(ctx, name);
  }
  await ctx.answerCallbackQuery();
  const build = (max: number) =>
    `♻️ <b>${meta.title}</b> standart matnga qaytarilsinmi?\n\n` +
    "⚠️ Joriy (o'zgartirilgan) matn o'chadi:\n" +
    `<blockquote expandable>${esc(truncate(current, max))}</blockquote>`;
  const text = fit((a) => build(a), [[SETTING_MAX, 0], [1000, 0], [300, 0]], TEXT_LIMIT) ?? build(100);
  await render(ctx, {
    text,
    keyboard: new InlineKeyboard().text('✅ Ha, qaytarish', `adm:resetok:${name}`).text("❌ Yo'q", `adm:set:${name}`),
  });
}

/** Standart matn tiklangani haqidagi xabar; oldingi matn ham ko'rsatiladi (kerak bo'lsa nusxa olib, qayta yuborish mumkin). */
function resetDoneText(name: SettingName, old: string | null): string {
  const meta = SETTINGS[name];
  const build = (oldMax: number, defMax: number) => {
    const parts = [
      `♻️ <b>${meta.title}</b> standart holatga qaytarildi.`,
      '',
      '📄 Endi ishlatiladigan standart matn:',
      `<blockquote expandable>${esc(truncate(meta.def, defMax))}</blockquote>`,
    ];
    if (old) {
      parts.push(
        '',
        "📋 Oldingi matn (kerak bo'lsa nusxa olib, «✏️ O'zgartirish» orqali qayta yuboring):",
        `<blockquote expandable>${esc(truncate(old, oldMax))}</blockquote>`,
      );
    }
    return parts.join('\n');
  };
  return (
    fit(build, [[SETTING_MAX, SETTING_MAX], [SETTING_MAX, 600], [1500, 300], [600, 200]], TEXT_LIMIT) ?? build(200, 100)
  );
}

async function doResetSetting(ctx: StaffContext, name: string | undefined): Promise<void> {
  if (!isSettingName(name)) return stale(ctx);
  const meta = SETTINGS[name];
  const old = await getSetting(meta.key);
  await deleteSetting(meta.key);
  await ctx.answerCallbackQuery({ text: '♻️ Standart matn tiklandi' });
  await afterSuccess('standart matn tiklangani haqidagi xabar', () =>
    render(ctx, {
      text: resetDoneText(name, old),
      keyboard: new InlineKeyboard().text("✏️ O'zgartirish", `adm:set:${name}`).text('⬅️ Admin panel', 'adm:home'),
    }),
  );
}

async function handleSettingInput(ctx: StaffContext, msg: TgMessage, st: SettingState): Promise<void> {
  const uid = ctx.from!.id;
  const meta = SETTINGS[st.key];
  if (msg.text === undefined) return reprompt(ctx, st, 'Iltimos, matn yuboring.', msg);
  const value = msg.text.replace(/\r\n?/g, '\n').trim();
  const kb = new InlineKeyboard().text("✏️ Yana o'zgartirish", `adm:set:${st.key}`).text('⬅️ Admin panel', 'adm:home');

  if (value === '-') {
    if (!(await casState(uid, st, null))) return;
    let old: string | null = null;
    const ok = await saveOrRestore(ctx, st, async () => {
      old = await getSetting(meta.key);
      await deleteSetting(meta.key);
      return true;
    });
    if (ok === undefined) return;
    await stripKeyboard(ctx, st.promptMsgId);
    await afterSuccess('standart matn tiklangani haqidagi xabar', () => sendHtml(ctx, resetDoneText(st.key, old), { markup: kb }));
    return;
  }
  if (!value) return reprompt(ctx, st, "Matn bo'sh bo'lmasligi kerak.", msg);
  if (value.length > SETTING_MAX) {
    return reprompt(ctx, st, `Matn juda uzun: ${value.length}/${SETTING_MAX} belgi. Qisqartirib, qayta yuboring.`, msg);
  }
  // 📢 Majburiy obuna kanali: @kanal / -100... / t.me/... ko'rinishida normallashtiriladi
  if (st.key === 'subchannel') {
    const channel = normalizeChannel(value);
    if (!channel) {
      return reprompt(ctx, st, "Kanal noto'g'ri. Masalan: @uzgrow_news, -1001234567890 yoki https://t.me/uzgrow_news", msg);
    }
    if (!(await casState(uid, st, null))) return;
    const saved = await saveOrRestore(ctx, st, async () => {
      await setSetting(meta.key, channel);
      return true;
    });
    if (saved === undefined) return;
    await stripKeyboard(ctx, st.promptMsgId);
    await afterSuccess('obuna kanali saqlangani haqidagi tasdiq', () =>
      sendHtml(ctx, `✅ <b>${meta.title}</b> saqlandi: ${esc(channel)}\n\nEndi «📢 Majburiy obuna» bo'limidan «✅ Yoqish» ni bosing.`, { markup: kb }),
    );
    return;
  }
  if (st.key === 'suburl') {
    if (!/^https?:\/\/\S+$/i.test(value) && !/^t\.me\/\S+$/i.test(value)) {
      return reprompt(ctx, st, "Havola noto'g'ri. Masalan: https://t.me/+xxxx", msg);
    }
    const url = /^t\.me\//i.test(value) ? `https://${value}` : value;
    if (!(await casState(uid, st, null))) return;
    const saved = await saveOrRestore(ctx, st, async () => {
      await setSetting(meta.key, url);
      return true;
    });
    if (saved === undefined) return;
    await stripKeyboard(ctx, st.promptMsgId);
    await afterSuccess('obuna havolasi saqlangani haqidagi tasdiq', () =>
      sendHtml(ctx, `✅ <b>${meta.title}</b> saqlandi.`, { markup: kb }),
    );
    return;
  }
  if (!(await casState(uid, st, null))) return;
  const saved = await saveOrRestore(ctx, st, async () => {
    await setSetting(meta.key, value);
    return true;
  });
  if (saved === undefined) return;
  await stripKeyboard(ctx, st.promptMsgId);
  const sample = fill(value, { name: 'Aziz', staff: 'Dilnoza' });
  const build = (max: number) =>
    `✅ <b>${meta.title}</b> saqlandi.\n\n👀 Namuna (mijoz — Aziz, xodim — Dilnoza):\n` +
    `<blockquote expandable>${esc(truncate(sample, max))}</blockquote>`;
  const text = fit((a) => build(a), [[2500, 0], [1000, 0], [300, 0]], TEXT_LIMIT) ?? build(100);
  // Matn allaqachon saqlangan — tasdiq eng yaxshi urinish
  await afterSuccess('matn saqlangani haqidagi tasdiq', () => sendHtml(ctx, text, { markup: kb }));
}

// ── Bekor qilish ──

async function onCancelFlow(ctx: StaffContext): Promise<void> {
  // Muddati o'tgan holat ham o'chiriladi va uning so'rov tugmalari olib tashlanadi
  const st = (await takeStateRow(ctx.from!.id))?.st ?? null;
  await ctx.answerCallbackQuery({ text: '✖️ Bekor qilindi' });
  const here = callbackMessage(ctx)?.message_id;
  if (st?.promptMsgId && st.promptMsgId !== here) await stripKeyboard(ctx, st.promptMsgId);
  if (st?.step === 'edit') {
    const s = await getStaff(st.staffId);
    if (s && !s.deleted_at) {
      await render(ctx, await cardView(s));
      return;
    }
  }
  if (st?.step === 'dev_add' && can(ctx.panelRole, 'developer')) {
    await render(ctx, await devHomeView('✖️ Bekor qilindi.'));
    return;
  }
  await showHome(ctx, 'edit', '✖️ Bekor qilindi.');
}

// Mijozlar boti: tugmalar, matnlar va ro'yxat/transkript ko'rinishlari (sof funksiyalar — tarmoq/baza yo'q).
// Mijozlar botida Mini App (web_app) tugmalari ham, doimiy pastki klaviatura ham yo'q — faqat inline tugmalar.
import { InlineKeyboard } from 'grammy';
import type { InlineKeyboardButton, InlineKeyboardMarkup, ReplyKeyboardRemove } from 'grammy/types';
import type { ConversationView, Message, Role, Staff } from '../../types.js';
import {
  KIND_LABELS,
  dative,
  dativeSuffix,
  esc,
  formatTime,
  oneLine,
  roleIcon,
  roleLabel,
  statusIcon,
  truncate,
} from '../../util.js';

// ───────────────────────────── Limitlar ─────────────────────────────

export const TEXT_LIMIT = 4096;
export const CAPTION_LIMIT = 1024;
/** Ro'yxat (operatorlar/menejerlar) sahifasidagi xodimlar soni. */
export const LIST_PAGE_SIZE = 10;
/** "Suhbatlarim" sahifasidagi suhbatlar soni. */
export const CHATS_PAGE_SIZE = 10;
/** Transkript sahifasidagi xabarlar soni. */
export const HISTORY_PAGE_SIZE = 10;

// ───────────────────────────── Matnlar ─────────────────────────────

/**
 * Tugma matnlari. `chats`/`help` — eski doimiy klaviatura yorliqlari: endi ko'rsatilmaydi, lekin eski
 * klaviaturasi qolgan mijozlar uchun ular hali ham ishlaydi.
 */
export const BTN = {
  operators: '👨‍💻 Operatorlar',
  managers: '👔 Menejerlar',
  chats: '💬 Suhbatlarim',
  help: 'ℹ️ Yordam',
} as const;

/** Eski doimiy pastki klaviaturani olib tashlash (ulanish xabarlari va /help bilan yuboriladi). */
export const REMOVE_KEYBOARD: ReplyKeyboardRemove = { remove_keyboard: true };

export const T = {
  error: "⚠️ Xatolik yuz berdi. Iltimos, qayta urinib ko'ring.",
  staffUnavailable: 'Bu xodim hozir mavjud emas',
  convNotFound: '⛔ Bu suhbat topilmadi',
  picked: '✅ Tanlandi',
  convSelected: '✅ Suhbat tanlandi',
  staleButton: "Bu tugma eskirgan. /start buyrug'ini yuboring.",
  /** Eski mijozga bir marta: v1 dagi doimiy pastki menyu olib tashlandi (remove_keyboard bilan yuboriladi). */
  legacyKeyboardRemoved: '✨ Bot yangilandi — endi yanada sodda. Pastdagi eski menyu olib tashlandi.',
  /** Shaxsiy havola (/start <nom>) bo'yicha xodim topilmadi yoki u hozir mavjud emas. */
  linkNotFound: "⚠️ Bu havola bo'yicha xodim topilmadi yoki u hozir ishlamayapti.",
  /** Xodim tanlanmagan: xabar saqlandi (birinchi saqlangan xabar). */
  chooseFirst:
    'Avval kim bilan yozishmoqchi ekaningizni tanlang 👇\n\n' +
    "📝 <i>Xabaringiz saqlab qo'yildi — xodimni tanlashingiz bilan unga yuboriladi, qayta yozishingiz shart emas.</i>",
  /** Xodim tanlanmagan: navbatdagi xabar ham saqlandi. */
  chooseFirstMore: '📝 Bu xabaringiz ham saqlandi. Avval kim bilan yozishmoqchi ekaningizni tanlang 👇',
  /** Xodim tanlanmagan va saqlash limiti to'lgan. */
  chooseFirstFull:
    'Avval kim bilan yozishmoqchi ekaningizni tanlang 👇\n\n' +
    "<i>So'ng xabaringizni qayta yuboring.</i>",
  /** Xabar saqlandi (xodim mavjud bo'lmay qolganda). */
  heldNote: "📝 <i>Xabaringiz saqlab qo'yildi — boshqa xodimni tanlashingiz bilan unga yuboriladi.</i>",
  /** Xabar saqlanmadi (limit to'lgan) — qayta yuborish kerak. */
  resendNote: '<i>Boshqa xodimni tanlagach, xabaringizni qayta yuboring.</i>',
  /** Mijoz bot xabariga Reply qildi, lekin u qaysi xodimga tegishli ekanini aniqlab bo'lmadi — xabar saqlandi. */
  askRecipient:
    '❓ <b>Bu xabar kimga?</b>\n\n' +
    "Siz javob bergan xabardan kimga yozayotganingizni aniqlab bo'lmadi, shuning uchun xabaringiz hali hech kimga yuborilmadi.\n\n" +
    "📝 <i>U saqlab qo'yildi — pastdan xodimni tanlang, xabar o'shanga yuboriladi.</i>",
  /** Xuddi shunday, lekin saqlash limiti to'lgan. */
  askRecipientFull:
    '❓ <b>Bu xabar kimga?</b>\n\n' +
    "Siz javob bergan xabardan kimga yozayotganingizni aniqlab bo'lmadi, shuning uchun xabaringiz hech kimga yuborilmadi.\n\n" +
    "<i>Xodimni tanlang yoki uning xabariga javob (Reply) qilib, qayta yuboring.</i>",
  /** Reply orqali mavjud bo'lmagan xodimga yozildi, boshqa faol suhbat bor — xabar hech kimga yuborilmadi. */
  notSentNote: "<i>Xabaringiz hech kimga yuborilmadi. Kerak bo'lsa, uni boshqa xodimga qayta yuboring.</i>",
  unsupported:
    "⚠️ Bu turdagi xabarni yuborib bo'lmaydi.\n\n" +
    "Matn, rasm, video, GIF, fayl, audio, ovozli yoki video xabar, stiker, joylashuv yoki kontakt yuborishingiz mumkin.",
  /** Noma'lum /buyruq — qisqa yordam (xabar xodimga yuborilmaydi). */
  unknownCommand:
    "🤔 Bunday buyruq yo'q — xabaringiz xodimga yuborilmadi.\n\n" +
    '✍️ Savolingizni oddiy xabar qilib yozing.\n' +
    '/start — xodim tanlash\n' +
    '/help — yordam',
  choose: "🔄 <b>Boshqa xodim tanlash</b>\n\nKim bilan bog'lanmoqchisiz? 👇",
} as const;

/** /help — qisqa (klaviaturasiz). */
export function helpText(): string {
  return [
    'ℹ️ <b>Botdan qanday foydalaniladi?</b>',
    '',
    "✍️ Savolingizni shu chatga yozing — matn, rasm, fayl yoki ovozli xabar bo'lishi mumkin.",
    '💬 Xodimning javobi ham shu yerga keladi.',
    '🔄 Boshqa xodim tanlash uchun: /start',
    '⚠️ Xodim ustidan shikoyat: /shikoyat',
  ].join('\n');
}

// ───────────────────────────── Ulanish xabarlari ─────────────────────────────
// Nomlar xom (esc qilinmagan) holda beriladi — shu yerda esc() qilinadi.

/** Xodim hozir javob bera olmaydi: oflayn yoki xodimlar botini to'xtatgan (avto-javobdagi mezon bilan bir xil). */
export function isStaffOffline(s: Pick<Staff, 'is_online' | 'bot_blocked'>): boolean {
  return !s.is_online || s.bot_blocked === true;
}

export const OFFLINE_LINE = '🕐 Hozir oflayn — imkon qadar tezroq javob beradi.';

/** Rol qatori: "👨‍💻 Operator · Katta operator" (HTML). */
function roleLineHtml(s: Pick<Staff, 'role' | 'position'>): string {
  const position = oneLine(s.position, 150);
  return `${roleIcon(s.role)} ${roleLabel(s.role)}${position ? ` · ${esc(position)}` : ''}`;
}

export interface LinkWelcomeInput {
  /** Mijozning ismi (Telegram first_name). */
  clientName: string;
  staff: Pick<Staff, 'full_name' | 'role' | 'position' | 'is_online' | 'bot_blocked'>;
  /** Suhbatda avval xabarlar bo'lganmi ("Siz yana ... bilan suhbatdasiz"). */
  existing: boolean;
  /** Shu ulanishda yuborilgan saqlangan xabarlar soni. */
  heldSent?: number;
  /** Saqlangan xabar xodimga hozircha yetkazilmadi. */
  undelivered?: boolean;
}

/**
 * Shaxsiy havola (/start <nom>) orqali kirganda yagona xabar — xodim rasmi izohi (HTML, ≤ 1024 belgi):
 *   👋 Assalomu alaykum, Ali!
 *
 *   Siz <b>Aziza</b> bilan bog'landingiz.
 *   👨‍💻 Operator · Katta operator
 *   🕐 Hozir oflayn — imkon qadar tezroq javob beradi.   (oflayn bo'lsa)
 *
 *   ✍️ Savolingizni shu yerga yozing.
 */
export function linkWelcomeCaption(input: LinkWelcomeInput): string {
  const client = oneLine(input.clientName, 64);
  const name = esc(staffName(input.staff));
  const lines = [
    client ? `👋 Assalomu alaykum, ${esc(client)}!` : '👋 Assalomu alaykum!',
    '',
    input.existing ? `Siz yana <b>${name}</b> bilan suhbatdasiz.` : `Siz <b>${name}</b> bilan bog'landingiz.`,
    roleLineHtml(input.staff),
  ];
  if (isStaffOffline(input.staff)) lines.push(OFFLINE_LINE);
  lines.push('');
  if (input.heldSent && input.heldSent > 0) {
    lines.push(`${heldSentLine(input.heldSent, staffName(input.staff))} Javob shu yerga keladi.`);
    if (input.undelivered) lines.push('', undeliveredShortNote(staffName(input.staff)));
  } else {
    lines.push('✍️ Savolingizni shu yerga yozing.');
  }
  return lines.join('\n');
}

/** Oddiy /start (yoki /menu): mavjud xodim bilan faol suhbat bor. */
export function activeStartText(name: string): string {
  return `👋 Siz <b>${esc(name)}</b> bilan suhbatdasiz — savolingizni shu yerga yozavering.`;
}

export interface PickedInput {
  staff: Pick<Staff, 'full_name' | 'role' | 'is_online' | 'bot_blocked'>;
  existing: boolean;
  heldSent: number;
  undelivered: boolean;
}

/**
 * «✍️ Yozish» (pick:) tasdig'i:
 *   ✅ Siz <b>Aziza</b> (Operator) bilan bog'landingiz.
 *   ✍️ Savolingizni yozing.
 * Suhbatda xabarlar bo'lsa — "… bilan bog'landingiz — suhbat davom etmoqda.". Saqlangan xabarlar yuborilgan
 * bo'lsa ✍️ qatori o'rniga "📨 … yuborildi. Javob shu yerga keladi.".
 */
export function pickedText(input: PickedInput): string {
  const raw = staffName(input.staff);
  const who = `<b>${esc(raw)}</b> (${roleLabel(input.staff.role)})`;
  let text = input.existing
    ? `✅ Siz yana ${who} bilan bog'landingiz — suhbat davom etmoqda.`
    : `✅ Siz ${who} bilan bog'landingiz.`;
  text += input.heldSent > 0 ? `\n${heldSentLine(input.heldSent, raw)} Javob shu yerga keladi.` : '\n✍️ Savolingizni yozing.';
  // Yangi suhbatda birinchi xabar yuborilgan bo'lsa, oflayn izohi avto-javobning o'zida bor
  if (isStaffOffline(input.staff) && !(input.heldSent > 0 && !input.existing)) text += `\n\n${OFFLINE_LINE}`;
  if (input.undelivered) text += `\n\n${undeliveredShortNote(raw)}`;
  return text;
}

/** Saqlangan xabar xodimga hozircha yetkazilmadi — tugmasiz variant (ulanish xabarlari uchun). */
export function undeliveredShortNote(name: string): string {
  return (
    `ℹ️ Xabaringiz saqlandi, lekin <b>${esc(name)}</b>${dativeSuffix(name)} hozircha yetkazib bo'lmadi — ` +
    "javob biroz kechikishi mumkin. Shoshilinch bo'lsa, /start orqali boshqa xodimni tanlang."
  );
}

// ───────────────────────────── Yo'naltirish xabarlari ─────────────────────────────
// Nomlar xom (esc qilinmagan) holda beriladi — shu yerda esc() qilinadi.

/** Mijozning oxirgi xodimi endi mavjud emas (xabar saqlandi). */
export function staffGoneText(name: string): string {
  return (
    `⚠️ <b>${esc(name)}</b> hozir mavjud emas. Iltimos, boshqa xodimni tanlang 👇\n\n` +
    "📝 <i>Xabaringiz saqlab qo'yildi — xodimni tanlashingiz bilan unga yuboriladi.</i>"
  );
}

/** Saqlangan xabar(lar) tanlangan xodimga yuborildi. */
export function heldSentLine(count: number, name: string): string {
  const what = count > 1 ? `${count} ta xabaringiz` : 'xabaringiz';
  return `📨 Avvalroq yozgan ${what} <b>${esc(name)}</b>${dativeSuffix(name)} yuborildi.`;
}

/** Xabar saqlandi, lekin xodimga hozircha yetkazilmadi. */
/** Mijoz juda tez yozmoqda (bot chatidan xodimga yuborish chastotasi cheklovi) — xabar yuborilmadi. */
export function tooFastText(retryAfterSec: number): string {
  const sec = Math.max(1, Math.ceil(retryAfterSec));
  const wait = sec <= 90 ? `${sec} soniyadan` : `${Math.ceil(sec / 60)} daqiqadan`;
  return (
    '⏳ <b>Juda tez yozyapsiz.</b>\n\n' +
    `Oxirgi xabaringiz xodimga yuborilmadi. Iltimos, ${wait} keyin qayta yuboring.`
  );
}

export function undeliveredNote(name: string): string {
  return (
    `ℹ️ Xabaringiz saqlandi, lekin <b>${esc(name)}</b>${dativeSuffix(name)} hozircha yetkazib bo'lmadi — ` +
    "javob biroz kechikishi mumkin. Shoshilinch bo'lsa, boshqa xodimni tanlang 👇"
  );
}

/**
 * Xabar chatdagi oxirgi xabar egasiga emas, faol suhbatdagi xodimga ketdi.
 * canWriteBack — oldingi xodim hali mavjud (unga yozish tugmasi ko'rsatiladi).
 */
export function redirectedNote(toName: string, fromName: string, canWriteBack: boolean): string {
  const head = `✉️ Xabaringiz <b>${esc(toName)}</b>${dativeSuffix(toName)} yuborildi.`;
  if (!canWriteBack) return head;
  return (
    `${head}\n<i>${esc(dative(fromName))} yozish uchun uning xabariga javob (Reply) qiling ` +
    'yoki pastdagi ↩️ tugmani bosing.</i>'
  );
}

/** Reply orqali boshqa suhbatga o'tildi. */
export function switchedNote(name: string): string {
  return `🔁 Endi xabarlaringiz <b>${esc(name)}</b>${dativeSuffix(name)} yuboriladi.`;
}

/** «↩️ Javob berish» (to:) bosilganda yuboriladigan xabar. */
export function activeChosenText(name: string): string {
  return `✍️ Aktiv suhbat: <b>${esc(name)}</b>. Xabaringizni yozing.`;
}

/** «↩️ Javob berish» (to:) bosilganda callback javobi (oddiy matn, HTML emas). */
export function activeChosenToast(name: string): string {
  return `✍️ Endi xabaringiz ${dative(oneLine(name, 64))} boradi`;
}

// ───────────────────────────── Klaviaturalar ─────────────────────────────

export type Rows = InlineKeyboardButton[][];

/** Bo'sh qatorlarsiz inline klaviatura. */
export function markup(rows: Rows): InlineKeyboardMarkup {
  return { inline_keyboard: rows.filter((r) => r.length > 0) };
}

export function cb(text: string, data: string): InlineKeyboardButton {
  return InlineKeyboard.text(text, data);
}

/** [👨‍💻 Operatorlar `ls:operator`] [👔 Menejerlar `ls:manager`] */
export function roleRow(): InlineKeyboardButton[] {
  return [cb(BTN.operators, 'ls:operator'), cb(BTN.managers, 'ls:manager')];
}

/** Shu suhbatni faol qilib, unga yozish tugmasi (callback to:<convId>). */
export function writeToButton(conversationId: number, name: string): InlineKeyboardButton {
  return cb(`↩️ ${dative(oneLine(name, 40) || 'Xodim')} yozish`, `to:${conversationId}`);
}

/** Sahifalash qatori: [⬅️] [2/5] [➡️] (faqat mavjud yo'nalishlar). */
function pagerRow(prefix: string, page: number, pages: number): InlineKeyboardButton[] {
  if (pages <= 1) return [];
  const row: InlineKeyboardButton[] = [];
  if (page > 0) row.push(cb('⬅️', `${prefix}:${page - 1}`));
  row.push(cb(`${page + 1}/${pages}`, 'noop'));
  if (page < pages - 1) row.push(cb('➡️', `${prefix}:${page + 1}`));
  return row;
}

function clampPage(page: number, pages: number): number {
  if (!Number.isFinite(page) || page < 0) return 0;
  return Math.min(Math.floor(page), Math.max(pages - 1, 0));
}

// ───────────────────────────── Yordamchilar ─────────────────────────────

/**
 * HTML matnning Telegram hisoblaydigan (teglar va entity lardan keyingi) uzunligi.
 * Faqat biz yaratadigan HTML uchun: dinamik qismlar esc() dan o'tgan, demak har bir "<" — teg.
 */
export function visibleLength(html: string): number {
  return html.replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot|#\d+);/g, '_').length;
}

/** Xodimning bir qatorli ismi (esc qilinmagan). */
export function staffName(s: Pick<Staff, 'full_name'> | null | undefined): string {
  return oneLine(s?.full_name, 64) || 'Xodim';
}

export function roleTitle(role: Role): string {
  return role === 'manager' ? '👔 <b>Menejerlarimiz</b>' : '👨‍💻 <b>Operatorlarimiz</b>';
}

function rolePlural(role: Role): string {
  return role === 'manager' ? 'menejerlar' : 'operatorlar';
}

// ───────────────────────────── Xodimlar ro'yxati ─────────────────────────────

export function renderStaffList(
  role: Role,
  staff: Staff[],
  page: number,
): { text: string; markup: InlineKeyboardMarkup } {
  if (!staff.length) {
    const other: Role = role === 'manager' ? 'operator' : 'manager';
    const text =
      `${roleTitle(role)}\n\n` +
      `😔 Hozircha ${rolePlural(role)} yo'q. Birozdan keyin qayta urinib ko'ring.`;
    const otherBtn = other === 'manager' ? cb(BTN.managers, 'ls:manager') : cb(BTN.operators, 'ls:operator');
    return { text, markup: markup([[otherBtn]]) };
  }

  const pages = Math.ceil(staff.length / LIST_PAGE_SIZE);
  const p = clampPage(page, pages);
  const slice = staff.slice(p * LIST_PAGE_SIZE, (p + 1) * LIST_PAGE_SIZE);

  const build = (withDescription: boolean): string => {
    const entries = slice.map((s) => {
      const position = oneLine(s.position, 100);
      let line = `${statusIcon(s)} <b>${esc(staffName(s))}</b>${position ? ` — ${esc(position)}` : ''}`;
      const desc = withDescription ? oneLine(s.description, 90) : '';
      if (desc) line += `\n<i>${esc(desc)}</i>`;
      return line;
    });
    const head = `${roleTitle(role)}${pages > 1 ? ` <i>(${p + 1}/${pages})</i>` : ''}`;
    return (
      `${head}\n\n${entries.join('\n\n')}\n\n` +
      `🟢 onlayn · ⚪️ oflayn\n👇 Suhbatlashish uchun xodimni tanlang:`
    );
  };
  let text = build(true);
  if (visibleLength(text) > TEXT_LIMIT) text = build(false);

  const rows: Rows = slice.map((s) => [cb(`${statusIcon(s)} ${oneLine(s.full_name, 48) || 'Xodim'}`, `card:${s.id}`)]);
  rows.push(pagerRow(`ls:${role}`, p, pages));
  return { text, markup: markup(rows) };
}

// ───────────────────────────── Xodim kartasi ─────────────────────────────

/** Rasm izohi (HTML), ko'rinadigan uzunligi 1024 dan oshmaydi. */
export function staffCaption(s: Staff): string {
  const name = staffName(s);
  const position = oneLine(s.position, 150);
  const status = s.is_online ? '🟢 Onlayn' : '⚪️ Hozir oflayn';
  const roleLinePlain = `${roleIcon(s.role)} ${roleLabel(s.role)}${position ? ` · ${position}` : ''}`;
  const headPlain = `${statusIcon(s)} ${name}`;

  // Ko'rinadigan uzunlik: head + "\n" + roleLine + ["\n\n" + desc] + "\n\n" + status
  const fixed = headPlain.length + 1 + roleLinePlain.length + 2 + status.length;
  const budget = CAPTION_LIMIT - fixed - 2;
  const rawDesc = (s.description ?? '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const desc = rawDesc && budget >= 20 ? truncate(rawDesc, budget) : '';

  let html =
    `${statusIcon(s)} <b>${esc(name)}</b>\n` +
    `${roleIcon(s.role)} ${roleLabel(s.role)}${position ? ` · ${esc(position)}` : ''}`;
  if (desc) html += `\n\n${esc(desc)}`;
  html += `\n\n${status}`;
  return html;
}

/** Karta tugmalari: karusel, "Yozish", "Shikoyat", "Ro'yxat". index = -1 bo'lsa karusel qatori ko'rsatilmaydi. */
export function cardMarkup(s: Staff, index: number, total: number): InlineKeyboardMarkup {
  const rows: Rows = [];
  if (total > 1 && index >= 0) {
    rows.push([cb('◀️', `nav:${s.id}:prev`), cb(`${index + 1}/${total}`, 'noop'), cb('▶️', `nav:${s.id}:next`)]);
  }
  rows.push([cb('✍️ Yozish', `pick:${s.id}`)]);
  rows.push([cb('⚠️ Shikoyat qilish', `cmp:${s.id}`)]);
  rows.push([cb("📋 Ro'yxat", `ls:${s.role}`)]);
  return markup(rows);
}

/**
 * Karuselda qo'shni xodim (aylana bo'ylab).
 * Joriy xodim ro'yxatda bo'lmasa (o'chirilgan/rol o'zgargan) — tartib (sort_order, id) bo'yicha eng yaqini.
 */
export function neighbour(list: Staff[], current: Pick<Staff, 'id' | 'sort_order'>, dir: 'prev' | 'next'): Staff | null {
  const n = list.length;
  if (!n) return null;
  const idx = list.findIndex((s) => s.id === current.id);
  if (idx >= 0) return list[(idx + (dir === 'next' ? 1 : -1) + n) % n]!;
  const after = list.findIndex(
    (s) => s.sort_order > current.sort_order || (s.sort_order === current.sort_order && s.id > current.id),
  );
  if (dir === 'next') return after >= 0 ? list[after]! : list[0]!;
  const before = (after >= 0 ? after : n) - 1;
  return before >= 0 ? list[before]! : list[n - 1]!;
}

// ───────────────────────────── Suhbatlarim ─────────────────────────────

export function renderChats(
  convs: ConversationView[],
  activeId: number | null,
  availableStaffIds: Set<number>,
  page: number,
): { text: string; markup: InlineKeyboardMarkup } {
  if (!convs.length) {
    const text = "💬 Sizda hali suhbatlar yo'q.\n\nOperator yoki menejerni tanlang va unga yozing 👇";
    return { text, markup: markup([roleRow()]) };
  }

  const pages = Math.ceil(convs.length / CHATS_PAGE_SIZE);
  const p = clampPage(page, pages);
  const slice = convs.slice(p * CHATS_PAGE_SIZE, (p + 1) * CHATS_PAGE_SIZE);

  // 🚫 ✅ dan ustun: mavjud bo'lmagan xodimga xabar baribir yetib bormaydi
  const mark = (c: ConversationView): string =>
    !availableStaffIds.has(c.staff_id) ? '🚫 ' : c.id === activeId ? '✅ ' : '';

  const entries = slice.map((c) => {
    const time = c.last_message_at ? ` · <i>${esc(formatTime(c.last_message_at))}</i>` : '';
    const head = `${mark(c)}${roleIcon(c.staff_role)} <b>${esc(oneLine(c.staff_full_name, 48) || 'Xodim')}</b>${time}`;
    const preview = c.last_message_preview
      ? `${c.last_sender === 'client' ? 'Siz: ' : ''}${esc(oneLine(c.last_message_preview, 70))}`
      : "<i>Hozircha xabar yo'q</i>";
    return `${head}\n${preview}`;
  });

  const legend: string[] = [];
  if (activeId != null && convs.some((c) => c.id === activeId && availableStaffIds.has(c.staff_id))) {
    legend.push('✅ — faol suhbat: xabarlaringiz shu xodimga boradi');
  }
  if (convs.some((c) => !availableStaffIds.has(c.staff_id))) {
    legend.push('🚫 — xodim hozir mavjud emas');
  }
  legend.push('👇 Suhbatni tanlang:');

  const head = `💬 <b>Suhbatlaringiz</b> (${convs.length})${pages > 1 ? ` <i>· ${p + 1}/${pages}</i>` : ''}`;
  let body = entries.slice();
  let text = `${head}\n\n${body.join('\n\n')}\n\n${legend.join('\n')}`;
  // Nazariy jihatdan sig'masa — oxirgi yozuvlarni qisqartirish (tugmalar baribir hammasini ko'rsatadi)
  while (visibleLength(text) > TEXT_LIMIT && body.length > 1) {
    body = body.slice(0, -1);
    text = `${head}\n\n${body.join('\n\n')}\n…\n\n${legend.join('\n')}`;
  }

  const rows: Rows = slice.map((c) => [
    cb(`${mark(c)}${roleIcon(c.staff_role)} ${oneLine(c.staff_full_name, 48) || 'Xodim'}`, `conv:${c.id}`),
  ]);
  rows.push(pagerRow('chats', p, pages));
  rows.push([cb('🔄 Boshqa xodim tanlash', 'choose')]);
  return { text, markup: markup(rows) };
}

export function renderChoose(): { text: string; markup: InlineKeyboardMarkup } {
  return { text: T.choose, markup: markup([roleRow(), [cb('⬅️ Suhbatlarim', 'chats')]]) };
}

// ───────────────────────────── Suhbat tarixi (transkript) ─────────────────────────────

const MSG_TEXT_MAX = 800;
const CAPTION_TEXT_MAX = 500;

function messageBody(m: Message): string {
  const text = (m.text ?? '').trim();
  const label = `<i>${KIND_LABELS[m.kind] || '📎'}</i>`;
  const caption = text ? `\n${esc(truncate(text, CAPTION_TEXT_MAX))}` : '';
  switch (m.kind) {
    case 'text':
      return text ? esc(truncate(text, MSG_TEXT_MAX)) : "<i>(bo'sh xabar)</i>";
    case 'contact': {
      const parts = [m.meta?.contact_name, m.meta?.phone_number].filter(Boolean).map((x) => esc(oneLine(x, 64)));
      return parts.length ? `${label}: ${parts.join(', ')}` : label;
    }
    case 'sticker':
      return m.meta?.emoji ? `${label} ${esc(m.meta.emoji)}` : label;
    case 'location': {
      const lat = Number(m.meta?.latitude);
      const lon = Number(m.meta?.longitude);
      const link =
        Number.isFinite(lat) && Number.isFinite(lon)
          ? ` — <a href="https://maps.google.com/?q=${lat},${lon}">xaritada ko'rish</a>`
          : '';
      return `${label}${link}${caption}`;
    }
    case 'document':
    case 'audio':
      return `${label}${m.file_name ? `: ${esc(oneLine(m.file_name, 64))}` : ''}${caption}`;
    default:
      return `${label}${caption}`;
  }
}

function messageHeader(m: Message, staff: Pick<Staff, 'full_name' | 'role'> | null): string {
  const time = esc(formatTime(m.created_at));
  if (m.sender === 'client') return `<b>Siz</b> · ${time}`;
  if (m.sender === 'bot') return `🤖 <i>Avtomatik javob</i> · ${time}`;
  const icon = staff ? roleIcon(staff.role) : '👤';
  return `<b>${icon} ${esc(staffName(staff))}</b> · ${time}`;
}

export interface TranscriptInput {
  staff: Pick<Staff, 'full_name' | 'role'> | null;
  /** O'sish tartibida (eskisi birinchi). */
  messages: Message[];
  /** Bu sahifadan oldin yana xabarlar bormi. */
  hasMore: boolean;
  /** Oldingi (eski) sahifa ko'rsatilyaptimi. */
  older: boolean;
  footer?: string;
}

export interface TranscriptOutput {
  text: string;
  hasMore: boolean;
  /** Ko'rsatilgan eng eski xabar id si ("⬆️ Oldingi xabarlar" uchun). */
  oldestShownId: number | null;
}

export function renderTranscript(input: TranscriptInput): TranscriptOutput {
  const icon = input.staff ? roleIcon(input.staff.role) : '👤';
  const title =
    `📜 <b>${icon} ${esc(staffName(input.staff))}</b> bilan suhbat` + (input.older ? ' · <i>oldingi xabarlar</i>' : '');
  const footer = input.footer ? `\n\n${input.footer}` : '';

  if (!input.messages.length) {
    const empty = input.older ? "<i>Bundan oldingi xabarlar yo'q.</i>" : "<i>Hozircha xabarlar yo'q.</i>";
    return { text: `${title}\n\n${empty}${footer}`, hasMore: false, oldestShownId: null };
  }

  let msgs = input.messages.slice();
  let hasMore = input.hasMore;
  const blocks = msgs.map((m) => `${messageHeader(m, input.staff)}\n${messageBody(m)}`);
  const compose = (): string => `${title}\n\n${blocks.join('\n\n')}${footer}`;
  let text = compose();
  // 4096 dan oshsa — eng eski xabarlarni tashlab yuboramiz (ular "Oldingi xabarlar" orqali ko'rinadi)
  while (visibleLength(text) > TEXT_LIMIT && blocks.length > 1) {
    blocks.shift();
    msgs = msgs.slice(1);
    hasMore = true;
    text = compose();
  }
  return { text, hasMore, oldestShownId: msgs[0]!.id };
}

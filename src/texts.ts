// Umumiy (admin tahrirlay oladigan) matnlar va ularning standart qiymatlari.
import { getSetting, getSettings } from './repo.js';
import type { Client, Staff } from './types.js';
import { esc, truncate } from './util.js';

/**
 * Admin amallaridan keyin xodimga (xodimlar boti orqali) yuboriladigan xabarnomalar (HTML). Bot admin paneli
 * (src/bots/admin.ts) va Mini App admin bo'limi (src/webapp/api.ts) bir xil matnlarni ishlatadi.
 */
export const STAFF_NOTICE = {
  activated:
    "✅ Profilingiz admin tomonidan qayta <b>faollashtirildi</b> — mijozlar sizni yana menyuda ko'radi va siz ularga yoza olasiz.",
  deactivated:
    "⛔ Profilingiz admin tomonidan vaqtincha <b>o'chirib qo'yildi</b> — mijozlar sizni menyuda ko'rmaydi va sizga yoza olmaydi, " +
    'siz ham qayta faollashtirilguningizcha mijozlarga xabar yubora olmaysiz. Suhbatlar tarixi saqlanib qoladi.',
  unlinked: (name: string): string =>
    `🔌 Akkauntingiz <b>${esc(truncate(name, 100))}</b> xodim profilidan uzildi. Endi mijozlar xabarlari sizga kelmaydi.`,
  deleted: (name: string): string =>
    `🗑 <b>${esc(truncate(name, 100))}</b> xodim profili o'chirildi. Endi mijozlar xabarlari sizga kelmaydi.`,
  /** Admin xodimning mijozlar uchun havola nomini o'zgartirdi — eski havola endi ishlamaydi. */
  linkChanged: (link: string): string =>
    `🔗 Admin mijozlar uchun havolangizni o'zgartirdi:\n${esc(link)}\n\n` +
    'Eski havola endi ishlamaydi — mijozlaringizga yangisini bering.',
} as const;

export const SETTING_KEYS = {
  welcome: 'welcome_text',
  greeting: 'default_greeting',
  offlineNote: 'offline_note',
  appUrl: 'app_url',
  placeholderPhoto: 'placeholder_photo_file_id',
  /** 📢 Majburiy obuna: kanal (@username yoki -100... ID), tugma havolasi, yoqish ('1'). */
  subChannel: 'sub_channel',
  subUrl: 'sub_url',
  subEnabled: 'sub_enabled',
} as const;

/** Mijoz /start bosganda. {name} — mijoz ismi. Oddiy matn (HTML emas). */
export const DEFAULT_WELCOME =
  'Assalomu alaykum, {name}! 👋\n\n' +
  "Kim bilan bog'lanmoqchisiz? Quyidan tanlang 👇";

/**
 * Mijoz xodimga birinchi marta yozganda avtomatik javob. {name} — mijoz, {staff} — xodim ismi.
 * Avto-javob xodimga yetkazishdan OLDIN yuboriladi — shuning uchun "yetkazildi" deb va'da qilinmaydi.
 */
export const DEFAULT_GREETING =
  'Assalomu alaykum, {name}! 👋\n' +
  'Xabaringiz qabul qilindi — tez orada {staff} sizga shaxsan javob beradi. ' +
  'Iltimos, biroz kuting 🙏';

/** Xodim oflayn bo'lsa avto-javobga qo'shiladi. */
export const DEFAULT_OFFLINE_NOTE =
  '🕐 Hozirda {staff} ish joyida emas. Imkon qadar tezroq javob beradi.';

/** Telegram xabar matni limiti. */
const MESSAGE_LIMIT = 4096;

/** {key} ko'rinishidagi o'rinbosarlarni to'ldirish. */
export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k]! : m));
}

/**
 * v1 dagi standart salomlashuv (u «📱 Menyu» va pastki tugmalarni tilga oladi — v2 da ular yo'q). Admin uni aynan
 * shu ko'rinishda sozlamaga saqlagan bo'lsa ham, mijozga yangi standart matn ko'rsatiladi.
 */
const LEGACY_DEFAULT_WELCOME =
  'Assalomu alaykum, {name}! 👋\n\n' +
  "Botimizga xush kelibsiz. Bu yerda siz o'zingizga kerakli operator yoki menejerni tanlab, " +
  "u bilan to'g'ridan-to'g'ri yozishishingiz mumkin.\n\n" +
  '👨‍💻 Operatorlar — savollar va texnik yordam\n' +
  '👔 Menejerlar — buyurtma, hamkorlik va takliflar\n\n' +
  '👇 Pastdagi tugmalardan tanlang yoki «📱 Menyu» ni oching.';

export async function welcomeText(client: Pick<Client, 'first_name'>): Promise<string> {
  const saved = (await getSetting(SETTING_KEYS.welcome))?.replace(/\r\n?/g, '\n').trim();
  const tpl = saved && saved !== LEGACY_DEFAULT_WELCOME ? saved : DEFAULT_WELCOME;
  return truncate(fill(tpl, { name: client.first_name || 'mehmon' }), MESSAGE_LIMIT);
}

/**
 * Avto-javob matni: xodimning shaxsiy matni -> umumiy sozlama -> standart. Xodim oflayn bo'lsa (yoki xodimlar
 * botini to'xtatgan bo'lsa) izoh qo'shiladi. Natija har doim bitta xabarga sig'adi (≤ 4096): uzun shablonlar va
 * {name}/{staff} o'rinbosarlari bilan ham avto-javob "message is too long" xatosi bilan yo'qolmaydi —
 * kerak bo'lsa avval salomlashuv qismi qisqartiriladi. Sozlamalar bitta so'rovda o'qiladi.
 */
export async function greetingText(staff: Staff, client: Pick<Client, 'first_name'>): Promise<string> {
  const offline = !staff.is_online || staff.bot_blocked === true;
  const personal = staff.greeting?.trim() || '';
  const keys: string[] = [];
  if (!personal) keys.push(SETTING_KEYS.greeting);
  if (offline) keys.push(SETTING_KEYS.offlineNote);
  const settings = await getSettings(keys);
  const tpl = personal || settings[SETTING_KEYS.greeting] || DEFAULT_GREETING;
  const vars = { name: client.first_name || 'hurmatli mijoz', staff: staff.full_name };
  // Izoh xabarning yarmidan oshmaydi (2000 belgilik shablon o'rinbosarlari bilan ham to'liq sig'adi)
  const note = offline ? truncate(fill(settings[SETTING_KEYS.offlineNote] || DEFAULT_OFFLINE_NOTE, vars), MESSAGE_LIMIT / 2) : '';
  const budget = MESSAGE_LIMIT - (note ? note.length + 2 : 0);
  let text = truncate(fill(tpl, vars), Math.max(1, budget));
  if (note) text += '\n\n' + note;
  return truncate(text, MESSAGE_LIMIT);
}

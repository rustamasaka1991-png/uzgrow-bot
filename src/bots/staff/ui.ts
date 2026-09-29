// Xodimlar boti uchun umumiy: kontekst turi, doimiy klaviatura, HTML yuborish va "joyida tahrirlash" yordamchilari.
import { InlineKeyboard, Keyboard, type Context } from 'grammy';
import type { Message as TgMessage, ReplyKeyboardRemove } from 'grammy/types';
import { staffClientLink } from '../../links.js';
import type { Staff } from '../../types.js';
import { describeError, isNotModified, tgErrorDescription } from '../../util.js';

/**
 * Xatoni xavfsiz loglash. Telegram xatosida (GrammyError) faqat metod, kod va tavsif yoziladi —
 * uning `payload` i (mijoz yozishmalari, ismlar, ID lar) hech qachon logga tushmaydi.
 * Boshqa xatolarda faqat stack (tokenlarsiz) — obyektning o'zi emas (postgres xatolari so'rov parametrlarini saqlaydi).
 */
export function logError(where: string, e: unknown): void {
  console.error(`[staff] ${where}:`, describeError(e));
}

export interface StaffFlavor {
  /** Shu Telegram akkauntiga ulangan xodim profili (ulanmagan bo'lsa null). */
  staff: Staff | null;
  /** ADMIN_IDS ro'yxatidami. */
  admin: boolean;
}

/** `ctx.me` grammY da bot haqidagi ma'lumot — shuning uchun xodim `ctx.staff` da saqlanadi. */
export type StaffContext = Context & StaffFlavor;

/** Doimiy (reply) klaviatura tugmalari — aniq matnlar. */
export const BTN = {
  chats: '💬 Chatlar',
  status: '🔄 Holat',
  profile: '👤 Profilim',
  help: 'ℹ️ Yordam',
  admin: '⚙️ Admin panel',
} as const;

export const MAIN_BUTTONS: readonly string[] = Object.values(BTN);

export const ERROR_TEXT = "⚠️ Xatolik yuz berdi. Iltimos, qayta urinib ko'ring.";
export const NOT_STAFF_TEXT = '👋 Bu bot faqat xodimlar uchun. Admin bergan taklif havolasi orqali kiring.';
export const ADMIN_ONLY_TEXT = '⛔ Faqat admin uchun';
export const STALE_BUTTON_TEXT = '⚠️ Bu tugma eskirgan';
export const INACTIVE_TEXT =
  "⛔ Profilingiz o'chirib qo'yilgan — mijozlarga xabar yuborib bo'lmaydi. Admin bilan bog'laning.";

/** Telegram limitlari. */
export const TEXT_LIMIT = 4096;
export const CAPTION_LIMIT = 1024;

export function mainKeyboard(staff: Staff | null, admin: boolean): Keyboard | ReplyKeyboardRemove {
  if (staff) {
    const kb = new Keyboard().text(BTN.chats).text(BTN.status).row().text(BTN.profile).text(BTN.help);
    if (admin) kb.row().text(BTN.admin);
    return kb.resized().persistent();
  }
  if (admin) return new Keyboard().text(BTN.admin).row().text(BTN.help).resized().persistent();
  return { remove_keyboard: true };
}

/** Xabar botga buyruq bilan boshlanadimi (/start, /foo@bot ...). */
export function isCommandMessage(msg: Pick<TgMessage, 'text' | 'entities'>): boolean {
  if (msg.text === undefined) return false;
  if (msg.entities?.some((e) => e.type === 'bot_command' && e.offset === 0)) return true;
  return /^\/[A-Za-z0-9_]+(@\w+)?(\s|$)/.test(msg.text);
}

/** Asosiy klaviatura tugmasining matnimi. */
export function isMainButton(text: string | undefined): boolean {
  return text !== undefined && MAIN_BUTTONS.includes(text);
}

type ReplyMarkup = NonNullable<Parameters<Context['reply']>[1]>['reply_markup'];

export interface SendHtmlOptions {
  markup?: ReplyMarkup;
  /** Shu xabarga javob (reply) sifatida yuborish */
  replyTo?: number;
}

/** HTML parse_mode bilan yangi xabar (havola ko'rinishlari o'chirilgan). */
export async function sendHtml(ctx: Context, text: string, opts: SendHtmlOptions = {}): Promise<TgMessage> {
  return ctx.reply(text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...(opts.markup ? { reply_markup: opts.markup } : {}),
    ...(opts.replyTo ? { reply_parameters: { message_id: opts.replyTo, allow_sending_without_reply: true } } : {}),
  });
}

/** Ko'rinish: matn yoki (rasm bo'lsa) rasm + izoh. */
export interface View {
  /** HTML matn (≤ 4096). Rasm yuborib bo'lmasa ham shu ishlatiladi. */
  text: string;
  keyboard?: InlineKeyboard;
  /** Staff botdagi rasm file_id si va qisqa izoh (≤ 1024). */
  photo?: { fileId: string; caption: string };
}

/** Callback kelgan (va hali mavjud) xabar. */
export function callbackMessage(ctx: Context): TgMessage | undefined {
  const m = ctx.callbackQuery?.message;
  if (!m || m.date === 0) return undefined;
  return m as TgMessage;
}

/**
 * Ko'rinishni ko'rsatish.
 *  - mode 'edit' va callback ichida: joriy xabarni tahrirlaydi (matn→matn, rasm→rasm);
 *    turi mos kelmasa yoki tahrirlab bo'lmasa — eski xabarni o'chirib, yangisini yuboradi.
 *  - aks holda yangi xabar yuboradi.
 * Ko'rsatilgan xabarning message_id sini qaytaradi.
 */
export async function render(ctx: Context, view: View, mode: 'edit' | 'new' = 'edit'): Promise<number> {
  const current = mode === 'edit' ? callbackMessage(ctx) : undefined;
  if (current) {
    const isPhoto = !!current.photo;
    const isText = current.text !== undefined;
    if (view.photo && isPhoto) {
      try {
        await ctx.editMessageMedia(
          { type: 'photo', media: view.photo.fileId, caption: view.photo.caption, parse_mode: 'HTML' },
          { reply_markup: view.keyboard ?? new InlineKeyboard() },
        );
        return current.message_id;
      } catch (e) {
        if (isNotModified(e)) return current.message_id;
        console.warn('[staff] editMessageMedia xatosi:', tgErrorDescription(e));
      }
    } else if (!view.photo && isText) {
      try {
        await ctx.editMessageText(view.text, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: view.keyboard ?? new InlineKeyboard(),
        });
        return current.message_id;
      } catch (e) {
        if (isNotModified(e)) return current.message_id;
        console.warn('[staff] editMessageText xatosi:', tgErrorDescription(e));
      }
    }
    // Turi mos emas yoki tahrirlab bo'lmadi — eskisini o'chirib, yangisini yuboramiz
    await ctx.api.deleteMessage(current.chat.id, current.message_id).catch(() => {});
  }
  return sendView(ctx, view);
}

async function sendView(ctx: Context, view: View): Promise<number> {
  if (view.photo) {
    try {
      const m = await ctx.replyWithPhoto(view.photo.fileId, {
        caption: view.photo.caption,
        parse_mode: 'HTML',
        ...(view.keyboard ? { reply_markup: view.keyboard } : {}),
      });
      return m.message_id;
    } catch (e) {
      // file_id yaroqsiz bo'lishi mumkin — matn ko'rinishida ko'rsatamiz
      console.warn('[staff] rasm yuborilmadi, matn yuborilmoqda:', tgErrorDescription(e));
    }
  }
  const m = await sendHtml(ctx, view.text, view.keyboard ? { markup: view.keyboard } : {});
  return m.message_id;
}

/** Oldingi so'rov xabaridagi inline tugmalarni olib tashlash (xatolar e'tiborsiz). */
export async function stripKeyboard(ctx: Context, messageId: number | undefined): Promise<void> {
  if (!messageId || !ctx.chat) return;
  await ctx.api
    .editMessageReplyMarkup(ctx.chat.id, messageId, { reply_markup: new InlineKeyboard() })
    .catch(() => {});
}

/** Callback_data dagi musbat butun son. */
export function parseId(s: string | undefined): number | null {
  if (!s || !/^\d{1,15}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// ───────────────────────────── Mijozlar uchun shaxsiy havola ─────────────────────────────

/** Mijozlar havolasini ulashishda (t.me/share) qo'shiladigan matn. */
export const CLIENT_LINK_SHARE_TEXT = "Men bilan shu havola orqali bog'laning";

/** Mijozlar havolasi nima qilishi — bir qatorda (taklif havolasi muvaffaqiyati, profil, yordam). */
export const CLIENT_LINK_HINT = 'Shu havolani mijozlaringizga bering — ular kirishi bilan siz bilan chat boshlanadi.';

/** Telegram "ulashish" havolasi: https://t.me/share/url?url=<havola>&text=<matn> */
export function shareUrl(link: string, text: string = CLIENT_LINK_SHARE_TEXT): string {
  return `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;
}

/**
 * Xodimning mijozlar uchun havolasi (https://t.me/<mijoz_boti>?start=<link_code>). Mijozlar boti nomini aniqlab
 * bo'lmasa (tarmoq xatosi yoki bot sozlanmagan) — '' (hech qachon xato tashlamaydi: karta/profil baribir ko'rsatiladi).
 */
export async function clientLinkOf(s: Pick<Staff, 'id' | 'link_code'>): Promise<string> {
  try {
    const link = await staffClientLink(s);
    return link.startsWith('https://') ? link : '';
  } catch (e) {
    console.warn('[staff] mijozlar havolasini aniqlab bo\'lmadi:', tgErrorDescription(e));
    return '';
  }
}

/** Butun sonni 1 234 567 ko'rinishida. */
export function fmtNum(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

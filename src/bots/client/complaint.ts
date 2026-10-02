// Mijozlar boti: xodim ustidan shikoyat (/shikoyat) — matnlar, tugmalar va ro'yxat ko'rinishi (sof funksiyalar).
// Oqim: /shikoyat → xodimni tanlash (`cmp:<staffId>`) → keyingi matnli xabar shikoyat bo'ladi (xodimga YUBORILMAYDI)
// → rahbariyatga bildirishnoma (src/complaints.ts). `cmp:x` — bekor qilish.
import type { InlineKeyboardMarkup } from 'grammy/types';
import { COMPLAINT_DRAFT_TTL_MIN } from '../../complaints.js';
import type { ConversationView } from '../../types.js';
import type { RateRule } from '../../webapp/guards.js';
import { dativeSuffix, esc, oneLine, roleIcon } from '../../util.js';
import { cb, markup, roleRow, staffName, type Rows } from './ui.js';

/** Tanlash ro'yxatidagi suhbatlar soni (eng yangisi birinchi). */
export const COMPLAINT_PICK_MAX = 10;

/** Bitta mijoz soatiga ko'pi bilan 3 ta shikoyat (Postgres limiter, kalit `c:<id>:complaint`). */
export const COMPLAINT_RATE_RULES: readonly RateRule[] = [{ windowSec: 3600, max: 3 }];

/**
 * Muddati o'tgan draftdan keyingi birinchi xabar shikoyat bo'lishi mumkin — u hech kimga yuborilmaydi (CT.expired).
 * Draft shundan ham eski bo'lsa (mijoz uni bir kundan ko'p oldin tashlab ketgan) — xabar endi shikoyat davomi emas:
 * draft jimgina bekor qilinadi va xabar odatdagidek xodimga boradi.
 */
export const COMPLAINT_ABANDONED_SEC = 24 * 60 * 60;

/**
 * Shikoyat yuborilgandan keyin shu vaqt ichida SHIKOYAT QILINGAN xodimga ketayotgan xabarlar unga yuborilmaydi:
 * matni shikoyatga qo'shiladi (Telegram bo'lib yuborgan uzun matn, isbot izohi), izohsiz rasm — hech kimga.
 * Mijoz «↩️ … ga yozish» tugmasini bossa (yoki xodimni o'zi tanlasa) himoya darhol olib tashlanadi.
 */
export const COMPLAINT_FOLLOWUP_SEC = 180;

/**
 * Shikoyat oynasi yopilayotganda (muddati o'tgan / limit) parallel kelgan xabarlar uchun qisqa himoya — izoh
 * xabari yuborilgach u izohgacha yozilgan xabarlar bilan chegaralanadi (izohni o'qib qayta yuborilgani ketadi).
 */
export const COMPLAINT_RACE_GUARD_SEC = 15;

/** Shikoyatga qo'shimcha matn: 10 daqiqada ko'pi bilan 10 ta (har biri rahbariyatga bildirishnoma). */
export const COMPLAINT_ADD_RULES: readonly RateRule[] = [{ windowSec: 600, max: 10 }];

/** Bekor qilish tugmasi (tanlash ro'yxatida ham, shikoyat so'rovida ham). */
export const COMPLAINT_CANCEL_DATA = 'cmp:x';

export const CT = {
  pick: '⚠️ <b>Shikoyat</b>\n\nQaysi xodim ustidan shikoyat qilmoqchisiz?',
  noConversations: "Shikoyat qilish uchun avval biror xodim bilan yozishgan bo'lishingiz kerak.",
  cancelled: '✖️ Shikoyat bekor qilindi.',
  textOnly: "✍️ Iltimos, shikoyatingizni matn ko'rinishida yozing.",
  /**
   * Limit: draft o'chiriladi. «Qayta urinib ko'ring» deyilmaydi — draftsiz qayta yuborilgan shikoyat matni oddiy
   * xabar bo'lib ayblangan xodimning o'ziga ketardi.
   */
  tooMany:
    "⏳ Juda ko'p shikoyat yuborildi (soatiga ko'pi bilan 3 ta), shuning uchun bu xabar hech kimga yuborilmadi.\n\n" +
    '⚠️ Keyinroq shikoyat qilish uchun: /shikoyat\n' +
    "❗️ Xabarni shunchaki qayta yuborsangiz, u xodimga boradi.",
  /** Shikoyat oynasi yopilayotgan paytda parallel kelgan xabar — hech kimga yuborilmadi. */
  raced:
    '⚠️ Bu xabar hech kimga yuborilmadi: u shikoyat oynasi yopilayotgan paytda yozildi.\n\n' +
    "✍️ Xodimga yozmoqchi bo'lsangiz, xabaringizni qayta yuboring. Shikoyat qilish uchun: /shikoyat",
  /** cmp:<staffId> — mijozning bu xodim bilan (xabarli) suhbati yo'q (callback alert, oddiy matn). */
  notYours: '⛔ Bu xodim bilan suhbatingiz topilmadi',
  /** Eski xabardagi «✖️ Bekor qilish» — hozirgi (boshqa xabardagi) shikoyatga tegilmaydi (callback toast). */
  staleCancel: 'Bu tugma eskirgan. Shikoyatni qayta boshlash uchun: /shikoyat',
  /** Eskirgan tanlash/so'rov xabari (boshqa xabarda shikoyat yozilmoqda) — tugmasiz, xodim ismisiz matn. */
  stalePrompt: '⚠️ Bu shikoyat oynasi eskirgan.',
  /**
   * Shikoyat drafti muddati (30 daqiqa) o'tib ketgan: bu xabar shikoyat bo'lishi mumkin edi — xodimga yuborilmaydi
   * (draft o'chiriladi, keyingi xabarlar odatdagidek xodimga boradi).
   */
  expired:
    `⌛️ Shikoyat yozish vaqti (${COMPLAINT_DRAFT_TTL_MIN} daqiqa) tugagan edi, shuning uchun bu xabar hech kimga yuborilmadi.\n\n` +
    '⚠️ Shikoyat qilish uchun: /shikoyat\n' +
    "✍️ Xodimga yozmoqchi bo'lsangiz, xabaringizni qayta yuboring.",
  /** Draft shu orada yo'qolgan (masalan, ikki xabar bir vaqtda kelgan) — xabar hech kimga yuborilmadi. */
  gone:
    '⚠️ Shikoyat bekor qilingan yoki allaqachon yuborilgan — bu xabar hech kimga yuborilmadi.\n\n' +
    'Yana shikoyat qilish uchun: /shikoyat',
} as const;

/** Xodim tanlangandan keyin: shikoyat matnini so'rash (name — xom ism, shu yerda esc qilinadi). */
export function complaintPromptText(name: string): string {
  return (
    `✍️ <b>${esc(name)}</b> ustidan shikoyatingizni bitta xabarda yozing.\n\n` +
    "🔒 Shikoyat xodimga ko'rinmaydi — uni faqat rahbariyat ko'radi."
  );
}

/**
 * Shikoyatdan keyin darhol shikoyat qilingan xodimga yozilgan xabar unga YUBORILMADI (name — xom ism).
 * addedTo — matni shu shikoyatga qo'shildi; null — xabar hech kimga yuborilmadi (izohsiz rasm va h.k.).
 */
export function complaintFollowUpText(name: string, addedTo: number | null): string {
  const n = oneLine(name, 64) || 'Xodim';
  const head =
    addedTo != null
      ? `📎 Bu xabar #${addedTo}-sonli shikoyatingizga qo'shildi — ${esc(n)}${dativeSuffix(n)} yuborilmadi.`
      : `🔒 Bu xabar ${esc(n)}${dativeSuffix(n)} yuborilmadi: u shikoyatingizdan keyin darhol yozildi.`;
  return `${head}\n\n✍️ Xodimning o'ziga yozmoqchi bo'lsangiz — pastdagi tugmani bosing va xabaringizni qayta yuboring.`;
}

/** Shikoyat qabul qilindi. */
export function complaintAcceptedText(id: number): string {
  return `✅ Shikoyatingiz qabul qilindi (#${id}). Rahbariyat tez orada ko'rib chiqadi. Rahmat!`;
}

/**
 * Shikoyat yuborilgach so'rov xabari shu matnga almashtiriladi (tugma olib tashlanadi). Ism ataylab QALIN emas:
 * bu xabarga Reply qilingan xabar ism bo'yicha o'sha xodimga yo'naltirilmasligi kerak (routing.ts).
 */
export function complaintSentPromptText(name: string, id: number): string {
  return `⚠️ ${esc(oneLine(name, 64) || 'Xodim')} ustidan shikoyat — ✅ yuborildi (#${id}).`;
}

export function complaintCancelMarkup(): InlineKeyboardMarkup {
  return markup([[cb('✖️ Bekor qilish', COMPLAINT_CANCEL_DATA)]]);
}

/**
 * /shikoyat: mijozning xabari bor suhbatlari (eng yangisi birinchi, ko'pi bilan 10 ta) — har biri `cmp:<staffId>`.
 * Suhbat bo'lmasa — izoh + [👨‍💻 Operatorlar] [👔 Menejerlar].
 */
export function renderComplaintPicker(convs: ConversationView[]): { text: string; markup: InlineKeyboardMarkup } {
  const withMessages = convs.filter((c) => c.last_message_at != null).slice(0, COMPLAINT_PICK_MAX);
  if (!withMessages.length) return { text: CT.noConversations, markup: markup([roleRow()]) };
  const seen = new Set<number>();
  const rows: Rows = [];
  for (const c of withMessages) {
    if (seen.has(c.staff_id)) continue;
    seen.add(c.staff_id);
    rows.push([cb(`${roleIcon(c.staff_role)} ${oneLine(c.staff_full_name, 48) || 'Xodim'}`, `cmp:${c.staff_id}`)]);
  }
  rows.push([cb('✖️ Bekor qilish', COMPLAINT_CANCEL_DATA)]);
  return { text: CT.pick, markup: markup(rows) };
}

/** Shikoyat so'rovidagi ism (xom): suhbat ko'rinishidagi xodim ismi. */
export function complaintStaffName(fullName: string | null | undefined): string {
  return staffName({ full_name: fullName ?? '' });
}

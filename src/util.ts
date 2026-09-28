import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import type { Client, MsgKind, Role, Staff } from './types.js';

/** HTML parse_mode uchun matnni xavfsiz qilish. */
export function esc(s: string | null | undefined): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Matnni belgilangan uzunlikkacha qisqartirish (surrogate juftlarni buzmasdan). */
export function truncate(s: string | null | undefined, max: number): string {
  const str = s ?? '';
  if (str.length <= max) return str;
  const chars = Array.from(str);
  let out = '';
  for (const ch of chars) {
    if (out.length + ch.length > max - 1) break;
    out += ch;
  }
  return out + '…';
}

/** Bir qatorli qisqa ko'rinish (tugmalar va ro'yxatlar uchun). */
export function oneLine(s: string | null | undefined, max: number): string {
  return truncate((s ?? '').replace(/\s+/g, ' ').trim(), max);
}

export function randomCode(len = 16): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: config.timezone,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const dateFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: config.timezone,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

/** "14:05" yoki "12.03.2026 14:05" (bugun bo'lmasa). */
export function formatTime(d: Date | string | null | undefined): string {
  if (!d) return '';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return '';
  const today = dateFmt.format(new Date());
  const day = dateFmt.format(date).replace(/\//g, '.');
  const time = timeFmt.format(date);
  return dateFmt.format(date) === today ? time : `${day} ${time}`;
}

export function clientName(c: Pick<Client, 'first_name' | 'last_name'> | null | undefined): string {
  if (!c) return 'Mijoz';
  const name = [c.first_name, c.last_name].filter(Boolean).join(' ').trim();
  return name || 'Mijoz';
}

export function roleLabel(role: Role): string {
  return role === 'manager' ? 'Menejer' : 'Operator';
}

export function roleIcon(role: Role): string {
  return role === 'manager' ? '👔' : '👨‍💻';
}

export function statusIcon(s: Pick<Staff, 'is_online'>): string {
  return s.is_online ? '🟢' : '⚪️';
}

export const KIND_LABELS: Record<MsgKind, string> = {
  text: '',
  photo: '📷 Rasm',
  video: '🎬 Video',
  animation: '🎞 GIF',
  document: '📎 Fayl',
  audio: '🎵 Audio',
  voice: '🎤 Ovozli xabar',
  video_note: '📹 Video xabar',
  sticker: '🎨 Stiker',
  location: '📍 Joylashuv',
  contact: '👤 Kontakt',
};

/** Xabarning qisqa ko'rinishi (chatlar ro'yxati uchun). */
export function previewOf(kind: MsgKind, text: string | null | undefined): string {
  const t = oneLine(text, 80);
  if (kind === 'text') return t;
  const label = KIND_LABELS[kind] ?? '📎';
  return t ? `${label}: ${t}` : label;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Telegram API xatosining kodi (403 = bot bloklangan va h.k.). */
export function tgErrorCode(e: unknown): number | undefined {
  const err = e as { error_code?: number } | null;
  return typeof err?.error_code === 'number' ? err.error_code : undefined;
}

export function tgErrorDescription(e: unknown): string {
  const err = e as { description?: string; message?: string } | null;
  return err?.description ?? err?.message ?? String(e);
}

/** "Xabar o'zgartirilmadi" xatosini e'tiborsiz qoldirish uchun. */
export function isNotModified(e: unknown): boolean {
  return /message is not modified/i.test(tgErrorDescription(e));
}

/** Tutuq belgisining (apostrof) barcha shakllari: ' ʻ ʼ ’ ‘ ` */
const APOSTROPHES = new Set(["'", 'ʻ', 'ʼ', '’', '‘', '`']);
const CYRILLIC_RE = /[Ѐ-ӿ]/;
const LETTER_RE = /\p{L}/u;

/**
 * O'zbek tilidagi jo'nalish kelishigi qo'shimchasi (imlo qoidasi bo'yicha; Mini App dagi dative() bilan bir xil):
 *  • so'z k bilan tugasa — "ka", q bilan — "qa", qolgan barcha holatlarda (g' ham) — "ga":
 *    Otabek → Otabekka, Ortiq → Ortiqqa, Malika → Malikaga, Ulug' → Ulug'ga;
 *  • kirill yozuvidagi so'zga kirillcha qo'shimcha: Отабек → Отабекка, Ортиқ → Ортиққа, Малика → Маликага;
 *  • butunlay katta harfda yozilgan so'zga katta harfli qo'shimcha: OTABEK → OTABEKKA;
 *  • so'z harf bilan tugamasa (emoji, raqam, "…") — oddiy "ga" (Mini App bunday holda qo'shimchasiz ibora
 *    ishlatadi; bot matnlarida ism <b>…</b> ichida turgani uchun "ga" o'qilishi tushunarli).
 * HTML da: `<b>${esc(name)}</b>${dativeSuffix(name)}`.
 */
export function dativeSuffix(word: string | null | undefined): string {
  const chars = Array.from((word ?? '').trim());
  const last = chars[chars.length - 1];
  if (last === undefined) return 'ga';
  const w = chars.join('');
  const upper = w === w.toUpperCase() && w !== w.toLowerCase();
  const sfx = (s: string): string => (upper ? s.toUpperCase() : s);
  // g' (tutuq belgisining istalgan shakli bilan) — "ga": bog'ga, Ulug'ga, ULUG'GA
  if (APOSTROPHES.has(last)) {
    const prev = chars[chars.length - 2];
    return prev === 'g' || prev === 'G' ? sfx('ga') : 'ga';
  }
  if (!LETTER_RE.test(last)) return 'ga';
  const lc = last.toLowerCase();
  if (CYRILLIC_RE.test(last)) return sfx(lc === 'к' ? 'ка' : lc === 'қ' ? 'қа' : 'га');
  if (lc === 'k') return sfx('ka');
  if (lc === 'q') return sfx('qa');
  return sfx('ga');
}

/** So'z + jo'nalish kelishigi qo'shimchasi (oddiy matn uchun): "Otabek" → "Otabekka". */
export function dative(word: string): string {
  const w = word.trimEnd();
  return w + dativeSuffix(w);
}

/** Log yozuvlaridan bot tokenlarini olib tashlash. */
export function redactTokens(s: string): string {
  return s.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot<token>').replace(/\d{5,}:[A-Za-z0-9_-]{20,}/g, '<token>');
}

/**
 * Xatoning logga yozish uchun xavfsiz tavsifi. Telegram xatosida (GrammyError) faqat metod, kod va tavsif —
 * uning `payload` i (mijoz yozishmalari, ismlar) hech qachon logga tushmaydi. grammY BotError bo'lsa — ichidagi
 * asl xato olinadi (ctx obyekti ham yozilmaydi). Boshqa xatolarda — tokenlarsiz stack (obyektning o'zi emas:
 * postgres xatolari so'rov parametrlarini saqlaydi).
 */
export function describeError(e: unknown): string {
  const inner = e && typeof e === 'object' && 'ctx' in e && 'error' in e ? (e as { error: unknown }).error : e;
  const code = tgErrorCode(inner);
  if (code !== undefined) {
    const method = (inner as { method?: unknown }).method;
    return `${typeof method === 'string' ? method : '?'} -> ${code} ${redactTokens(tgErrorDescription(inner))}`;
  }
  if (inner instanceof Error) return redactTokens(inner.stack ?? `${inner.name}: ${inner.message}`);
  return redactTokens(String(inner));
}

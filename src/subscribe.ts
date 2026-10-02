// 📢 Majburiy obuna: mijoz botdan foydalanishdan oldin kanalga obuna bo'lishi shart.
// Sozlama paneldan (admin/ROP/developer — «📢 Majburiy obuna») boshqariladi:
//   sub_enabled — '1' bo'lsa yoqilgan;
//   sub_channel — kanal (@username yoki -100... ID yoki t.me/... havola);
//   sub_url     — «➕ Obuna bo'lish» tugmasi uchun havola (bo'sh bo'lsa kanaldan olinadi).
// Tekshiruv mijozlar boti orqali getChatMember bilan. Tarmoq/sozlama xatosida
// fail-open (bot ishlamay qolmaydi) — xato logga yoziladi.
import { getSetting, getSettings } from './repo.js';
import { SETTING_KEYS } from './texts.js';
import { clientApi } from './tg.js';

export interface SubConfig {
  enabled: boolean;
  /** Tekshiruv uchun chat_id (@username yoki raqamli ID). */
  channel: string;
  /** Tugma uchun havola. */
  url: string;
}

/** t.me/xxx, https://t.me/xxx, @xxx, -100... ko'rinishlarini normallashtirish. */
export function normalizeChannel(raw: string): string {
  const t = (raw ?? '').trim();
  if (!t) return '';
  // Private taklif havolalari (t.me/+hash, t.me/joinchat/...) a'zolik tekshiruvi uchun
  // chat_id bo'la olmaydi — ularni kanal sifatida qabul qilmaymiz (tugma havolasi sifatida ishlatiladi).
  if (/t\.me\/(?:\+|joinchat\/)/i.test(t)) return '';
  const m = /t\.me\/([A-Za-z0-9_]+)/i.exec(t);
  const name = m ? m[1]! : t;
  if (/^-?\d+$/.test(name)) return name;
  const clean = name.replace(/^@/, '');
  if (/^[A-Za-z0-9_]{5,}$/.test(clean)) return `@${clean}`;
  return '';
}

export async function getSubConfig(): Promise<SubConfig> {
  const s = await getSettings([SETTING_KEYS.subEnabled, SETTING_KEYS.subChannel, SETTING_KEYS.subUrl]);
  const enabled = (s[SETTING_KEYS.subEnabled] ?? '').trim() === '1';
  const channel = normalizeChannel(s[SETTING_KEYS.subChannel] ?? '');
  let url = (s[SETTING_KEYS.subUrl] ?? '').trim();
  if (!url && channel) {
    if (channel.startsWith('@')) url = `https://t.me/${channel.slice(1)}`;
    else if (/^https?:\/\//i.test(channel)) url = channel;
  }
  return { enabled, channel, url };
}

type MemberStatus = 'creator' | 'administrator' | 'member' | 'restricted' | 'left' | 'kicked' | string;

/**
 * Foydalanuvchi kanalga obunami. O'chiq bo'lsa yoki kanal sozlanmagan bo'lsa — true.
 * Tekshirib bo'lmasa (bot kanalga admin emas, kanal topilmadi, tarmoq xatosi) — true (fail-open).
 */
export async function isSubscribed(userId: number): Promise<boolean> {
  const cfg = await getSubConfig();
  if (!cfg.enabled || !cfg.channel) return true;
  try {
    const m = (await clientApi().getChatMember(cfg.channel, userId)) as { status: MemberStatus; is_member?: boolean };
    if (m.status === 'creator' || m.status === 'administrator' || m.status === 'member') return true;
    if (m.status === 'restricted') return m.is_member === true;
    return false;
  } catch (e) {
    console.warn('[subscribe] getChatMember xatosi (fail-open):', (e as Error)?.message ?? e);
    return true;
  }
}

/** Obuna so'raladigan xabar matni (HTML) — mijozlar boti uchun. */
export function subGateHtml(): string {
  return (
    '📢 <b>Botdan foydalanish uchun kanalimizga obuna bo\u2018ling</b>\n\n' +
    'Pastdagi tugma orqali obuna bo\u2018lib, keyin «✅ Tekshirish» ni bosing.'
  );
}

/** Bitta mijoz uchun tekshiruv (keshsiz — har safar yangidan). */
export async function getSettingRaw(key: string): Promise<string | null> {
  return getSetting(key);
}

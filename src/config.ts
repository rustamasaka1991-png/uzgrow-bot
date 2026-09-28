// Barcha sozlamalar environment o'zgaruvchilaridan o'qiladi (Vercel -> Settings -> Environment Variables).

function read(name: string): string {
  return (process.env[name] ?? '').trim();
}

export const DEFAULT_TELEGRAM_API_ROOT = 'https://api.telegram.org';

function required(name: string): string {
  const v = read(name);
  if (!v) throw new Error(`Environment o'zgaruvchisi topilmadi: ${name}`);
  return v;
}

export const config = {
  get clientBotToken(): string {
    return required('CLIENT_BOT_TOKEN');
  },
  /** Operator/menejerlar boti tokeni. Bo'sh bo'lsa, xodimlarga xabar yetkazilmaydi (faqat saqlanadi). */
  get staffBotToken(): string {
    return read('STAFF_BOT_TOKEN');
  },
  get hasStaffBot(): boolean {
    return read('STAFF_BOT_TOKEN') !== '';
  },
  get databaseUrl(): string {
    return required('DATABASE_URL');
  },
  /**
   * Telegram webhook tokenlarining ildiz kaliti (hech qachon URL ga yozilmaydi — faqat Vercel env da turadi).
   * Almashtirilsa, `npm run setup` qayta ishga tushirilishi kerak (webhook secret_token lar yangilanadi).
   */
  get webhookSecret(): string {
    return required('WEBHOOK_SECRET');
  },
  /**
   * HTTP orqali sozlash (POST /api/setup, `Authorization: Bearer <SETUP_KEY>`) uchun ALOHIDA kalit.
   * Bo'sh bo'lsa — /api/setup o'chirilgan (asosiy yo'l: lokal `npm run setup`).
   */
  get setupKey(): string {
    return read('SETUP_KEY');
  },
  /**
   * Media havolalari (/api/media?t=…) imzosi uchun ixtiyoriy alohida kalit.
   * Bo'sh bo'lsa — WEBHOOK_SECRET dan hosil qilinadi (avvalgidek).
   */
  get mediaSecret(): string {
    return read('MEDIA_SECRET');
  },
  /** Admin Telegram ID lari: "123,456" */
  get adminIds(): number[] {
    return read('ADMIN_IDS')
      .split(/[\s,;]+/)
      .map((s) => Number(s))
      .filter((n) => Number.isSafeInteger(n) && n > 0);
  },
  /** Ilova manzili (https://...), oxirida "/" siz. Bo'sh bo'lishi mumkin — unda bazadagi sozlama ishlatiladi. */
  get appUrlEnv(): string {
    const v = read('APP_URL').replace(/\/+$/, '');
    if (v) return v.startsWith('http') ? v : `https://${v}`;
    const vercel = read('VERCEL_PROJECT_PRODUCTION_URL');
    return vercel ? `https://${vercel.replace(/\/+$/, '')}` : '';
  },
  /** Faqat testlar uchun: soxta Telegram API manzili. */
  get telegramApiRoot(): string {
    return read('TELEGRAM_API_ROOT').replace(/\/+$/, '') || DEFAULT_TELEGRAM_API_ROOT;
  },
  /** Haqiqiy Telegram serveri bilan ishlayaptimi (testlarda soxta server ishlatiladi). */
  get usesRealTelegram(): boolean {
    return this.telegramApiRoot === DEFAULT_TELEGRAM_API_ROOT;
  },
  timezone: 'Asia/Tashkent',
};

export function isAdmin(tgUserId: number | undefined | null): boolean {
  if (!tgUserId) return false;
  return config.adminIds.includes(tgUserId);
}

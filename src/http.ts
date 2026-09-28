// Vercel funksiyalari uchun umumiy HTTP yordamchilar: webhook qabul qilish, JSON javoblar.
import type { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import { safeEqualStr, webhookSecretFor } from './auth.js';
import { REQUEST_BUDGET_MS, runWithDeadline } from './deadline.js';
import { markUpdateProcessed, unmarkUpdate } from './repo.js';
import { ensureSchema } from './setup.js';
import type { BotKind } from './types.js';
import { describeError } from './util.js';

export { REQUEST_BUDGET_MS, callBudgetMs, remainingMs, runWithDeadline } from './deadline.js';

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

/**
 * Vercel handlerini so'rov vaqt byudjeti bilan o'rash: ichidagi Telegram chaqiruvlari (src/tg.ts) va
 * fayl yuklashlar `remainingMs()` ga qarab o'z vaqt chegarasini tanlaydi va funksiya o'ldirilishidan oldin
 * xato bilan qaytadi (foydalanuvchiga xato matni yuborishga ulguriladi).
 */
export function withRequestDeadline(
  handler: (req: Request) => Promise<Response>,
  budgetMs = REQUEST_BUDGET_MS,
): (req: Request) => Promise<Response> {
  return (req) => runWithDeadline(budgetMs, () => handler(req));
}

export interface WebhookHooks {
  /**
   * Update qayta ishlangandan keyin (xato bo'lsa ham) chaqiriladi — masalan, xodim botga qaytganda kutib turgan
   * xabarlarni yetkazish. Xatolari faqat logga yoziladi.
   */
  afterUpdate?: (update: Update) => Promise<void>;
}

/**
 * Telegram webhook handler:
 *  - maxfiy tokenni tekshiradi,
 *  - bir xil update ni ikki marta ishlamaydi (Telegram qayta yuborsa),
 *  - xatolar Telegramga 200 qaytaradi (cheksiz qayta yuborishlarning oldini olish uchun),
 *  - butun ishlov so'rov vaqt byudjeti ichida bajariladi (src/deadline.ts).
 */
export function createWebhookHandler(kind: BotKind, getBot: () => Promise<Bot>, hooks: WebhookHooks = {}) {
  return withRequestDeadline(async function handle(req: Request): Promise<Response> {
    if (req.method === 'GET') return json({ ok: true, bot: kind });
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, POST' } });

    const secret = req.headers.get('x-telegram-bot-api-secret-token') ?? '';
    if (!safeEqualStr(secret, webhookSecretFor(kind))) {
      return new Response('Unauthorized', { status: 401 });
    }

    let update: Update;
    try {
      update = (await req.json()) as Update;
    } catch {
      return new Response('ok');
    }
    if (!update || typeof update.update_id !== 'number') return new Response('ok');

    try {
      // Deploy migratsiyadan oldin chiqib qolgan bo'lsa — sxema shu yerda yangilanadi (instansiyada bir marta)
      await ensureSchema();
      const fresh = await markUpdateProcessed(kind, update.update_id);
      if (!fresh) return new Response('ok');
    } catch (e) {
      // Baza ishlamayapti — Telegram keyinroq qayta yuborsin
      console.error(`[${kind}] baza xatosi (sxema / processed_updates):`, describeError(e));
      return new Response('Service Unavailable', { status: 503 });
    }

    let bot: Bot;
    try {
      bot = await getBot();
    } catch (e) {
      // Bot ishga tushmadi (masalan, getMe tarmoq xatosi yoki vaqt tugadi) — update yo'qolmasin: belgini olib
      // tashlaymiz, Telegram uni keyinroq qayta yuboradi.
      console.error(`[${kind}] botni ishga tushirib bo'lmadi:`, describeError(e));
      await unmarkUpdate(kind, update.update_id).catch(() => {});
      return new Response('Service Unavailable', { status: 503 });
    }

    try {
      await bot.handleUpdate(update);
    } catch (e) {
      // BotError ichida ctx (butun update — mijoz matni) va Telegram payload i bor — faqat xavfsiz tavsif yoziladi
      console.error(`[${kind}] update #${update.update_id} ni qayta ishlashda xato:`, describeError(e));
    }
    if (hooks.afterUpdate) {
      try {
        await hooks.afterUpdate(update);
      } catch (e) {
        console.error(`[${kind}] update #${update.update_id} dan keyingi ishlov xatosi:`, describeError(e));
      }
    }
    return new Response('ok');
  });
}

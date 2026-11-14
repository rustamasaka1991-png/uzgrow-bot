// Operator/menejerlar boti webhook: https://<domen>/api/staff-bot
// Har bir update dan keyin: xodim botni to'xtatgan/qaytganini kuzatish va kutib turgan xabarlarni yetkazish.
// Bitta bot rejimida eski xodimlar boti ishlamaydi — unga yozgan xodimga yangi botga o'tish aytiladi
// (javob webhook javobining o'zida qaytadi, ya'ni eski bot nomidan yuboriladi: xodim uni allaqachon ishga tushirgan).
import type { Update } from 'grammy/types';
import { safeEqualStr, webhookSecretFor } from '../src/auth.js';
import { getStaffBot } from '../src/bots/staff.js';
import { config } from '../src/config.js';
import { createWebhookHandler, json, withRequestDeadline } from '../src/http.js';
import { botUsername } from '../src/links.js';
import { onStaffBotUpdate } from '../src/presence.js';

const normal = createWebhookHandler('staff', getStaffBot, { afterUpdate: onStaffBotUpdate });

async function movedNotice(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ ok: true, bot: 'staff', moved: true });
  if (!safeEqualStr(req.headers.get('x-telegram-bot-api-secret-token') ?? '', webhookSecretFor('staff'))) {
    return new Response('Unauthorized', { status: 401 });
  }
  const u = (await req.json().catch(() => null)) as Update | null;
  const chatId = u?.message?.chat.type === 'private' ? u.message.chat.id : null;
  if (!chatId) return new Response('ok');
  const name = await botUsername('client').catch(() => 'uzgroww_bot');
  return json({
    method: 'sendMessage',
    chat_id: chatId,
    text:
      `⚠️ Bu bot endi ishlamaydi. Barcha ish yangi botda: @${name}\n\n` +
      `👉 https://t.me/${name} ni oching va «Start» ni bosing — mijozlarning xabarlari o'sha yerga keladi.`,
    link_preview_options: { is_disabled: true },
  });
}

export default {
  fetch: (req: Request) => (config.singleBot ? withRequestDeadline(movedNotice)(req) : normal(req)),
};

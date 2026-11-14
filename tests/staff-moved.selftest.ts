// Bitta bot rejimida eski xodimlar boti "yangi botga o'ting" deb javob berishini tekshirish:
// npx tsx tests/staff-moved.selftest.ts  (bazasiz, tarmoqsiz)
import assert from 'node:assert/strict';

Object.assign(process.env, { CLIENT_BOT_TOKEN: '1:same', STAFF_BOT_TOKEN: '1:same', WEBHOOK_SECRET: 's'.repeat(40) });
delete process.env.DATABASE_URL;
const { webhookSecretFor } = await import('../src/auth.js');
const hook = (await import('../api/staff-bot.js')).default;

const post = (body: unknown, secret = webhookSecretFor('staff')) =>
  hook.fetch(
    new Request('https://x/api/staff-bot', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
      body: JSON.stringify(body),
    }),
  );

assert.equal((await post({ update_id: 1 }, 'wrong')).status, 401);
const r = await post({ update_id: 2, message: { message_id: 1, date: 0, chat: { id: 42, type: 'private' }, text: '/start' } });
const j = (await r.json()) as { method: string; chat_id: number; text: string };
assert.equal(j.method, 'sendMessage');
assert.equal(j.chat_id, 42);
assert.match(j.text, /@uzgroww_bot/);
assert.equal(await (await post({ update_id: 3, callback_query: { id: 'x' } })).text(), 'ok');
console.log('staff-moved selftest: OK');
process.exit(0);

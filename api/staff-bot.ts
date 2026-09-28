// Operator/menejerlar boti webhook: https://<domen>/api/staff-bot
// Har bir update dan keyin: xodim botni to'xtatgan/qaytganini kuzatish va kutib turgan xabarlarni yetkazish.
import { getStaffBot } from '../src/bots/staff.js';
import { createWebhookHandler } from '../src/http.js';
import { onStaffBotUpdate } from '../src/presence.js';

export default { fetch: createWebhookHandler('staff', getStaffBot, { afterUpdate: onStaffBotUpdate }) };

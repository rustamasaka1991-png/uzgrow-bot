// Mijozlar boti webhook: https://<domen>/api/client-bot
// Har bir update dan keyin: mijoz tahrirlagan xabar (edited_message) xodimdagi nusxaga ham yetkaziladi.
import { getClientBot } from '../src/bots/client.js';
import { onClientBotUpdate } from '../src/edits.js';
import { createWebhookHandler } from '../src/http.js';

export default { fetch: createWebhookHandler('client', getClientBot, { afterUpdate: onClientBotUpdate }) };

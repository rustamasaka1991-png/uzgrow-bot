// Mijozlar boti webhook: https://<domen>/api/client-bot
// Har bir update dan keyin: mijoz tahrirlagan xabar (edited_message) xodimdagi nusxaga ham yetkaziladi.
// Bitta bot rejimi (STAFF_BOT_TOKEN = CLIENT_BOT_TOKEN): xodim / panel foydalanuvchisi yozsa — xodimlar boti logikasi.
import type { Update } from 'grammy/types';
import { getClientBot } from '../src/bots/client.js';
import { getStaffBot } from '../src/bots/staff.js';
import { config } from '../src/config.js';
import { onClientBotUpdate } from '../src/edits.js';
import { createWebhookHandler } from '../src/http.js';
import { onStaffBotUpdate } from '../src/presence.js';
import { getStaffByTgId } from '../src/repo.js';
import { getPanelRole } from '../src/roles.js';

async function isStaffSide(u: Update): Promise<boolean> {
  const from = u.message?.from ?? u.edited_message?.from ?? u.callback_query?.from ?? u.my_chat_member?.from;
  if (!from || from.is_bot) return false;
  if (/^\/start(@\w+)?\s+inv_/.test(u.message?.text ?? '')) return true; // xodim taklif havolasi
  return !!(await getStaffByTgId(from.id)) || !!(await getPanelRole(from.id));
}

export default {
  fetch: createWebhookHandler('client', getClientBot, {
    afterUpdate: onClientBotUpdate,
    route: async (u) =>
      config.singleBot && (await isStaffSide(u)) ? { getBot: getStaffBot, afterUpdate: onStaffBotUpdate } : null,
  }),
};

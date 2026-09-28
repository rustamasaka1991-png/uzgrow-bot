// Xodimlar botining har bir update idan keyin (api/staff-bot.ts → createWebhookHandler afterUpdate):
//  - xodim botni bloklasa/to'xtatsa (my_chat_member → kicked) — u oflayn ko'rinadi, adminlar ogohlantiriladi;
//  - botga qaytsa (member) yoki botda biror narsa yozsa/bossa — "yetib bo'lmaydi" belgisi olinadi va unga hali
//    yetkazilmagan mijoz xabarlari (tartib bilan) yetkaziladi.
// Bot handlerlaridan mustaqil ishlaydi: yetkazish kafolati bot modulidagi o'zgarishlarga bog'liq emas.
import type { Update } from 'grammy/types';
import { handleStaffReachable, handleStaffUnreachable, redeliverPendingToStaff } from './relay.js';
import { getStaffByTgId, hasPendingForStaff, isStaffAvailable } from './repo.js';
import { staffApi } from './tg.js';

export async function onStaffBotUpdate(update: Update): Promise<void> {
  if (!staffApi()) return;

  const member = update.my_chat_member;
  if (member) {
    if (member.chat.type !== 'private' || member.from.is_bot) return;
    const staff = await getStaffByTgId(member.from.id);
    if (!staff) return;
    const status = member.new_chat_member.status;
    if (status === 'kicked') await handleStaffUnreachable(staff);
    // Qaytdi: belgi olinadi (o'chirib qo'yilgan xodim uchun ham — admin kartasida eskirgan ogohlantirish qolmasin);
    // navbatni yetkazish ichida xodim mavjudligi alohida tekshiriladi.
    else if (status === 'member') await handleStaffReachable(staff);
    return;
  }

  const msg = update.message ?? update.edited_message;
  const from = msg?.from ?? update.callback_query?.from;
  const chatType = msg?.chat.type ?? update.callback_query?.message?.chat.type ?? 'private';
  if (!from || from.is_bot || chatType !== 'private') return;

  const staff = await getStaffByTgId(from.id);
  if (!staff || !isStaffAvailable(staff)) return;
  if (staff.bot_blocked) {
    // Xodim botda faol — demak botni qayta ishga tushirgan (my_chat_member yo'qolgan bo'lsa ham)
    await handleStaffReachable(staff);
    return;
  }
  // Oldingi yetkazish vaqtinchalik xato bilan to'xtagan bo'lsa — xodim hozir botda, yetkazamiz
  if (await hasPendingForStaff(staff.id)) await redeliverPendingToStaff(staff);
}

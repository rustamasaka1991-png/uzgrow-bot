// Panel huquqlarini tekshirish (har bir handler bajarilish vaqtida — tugma qachon chizilganidan qat'i nazar).
import { can, type PanelPerm } from '../../roles.js';
import { NO_ACCESS_TEXT, STALE_BUTTON_TEXT, sendHtml, type StaffContext } from '../staff/ui.js';

/** Huquq bo'lsa true; bo'lmasa «⛔ Ruxsat yo'q» (callback — alert, xabar — javob) va false. */
export async function requirePerm(ctx: StaffContext, perm: PanelPerm): Promise<boolean> {
  if (can(ctx.panelRole, perm)) return true;
  if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: NO_ACCESS_TEXT, show_alert: true });
  else await sendHtml(ctx, NO_ACCESS_TEXT);
  return false;
}

/** Eskirgan / noto'g'ri tugma. */
export async function stale(ctx: StaffContext): Promise<void> {
  await ctx.answerCallbackQuery({ text: STALE_BUTTON_TEXT });
}

// 📢 Majburiy obuna (admin, ROP, developer — barchasi): mijozlar boti ishlashi uchun
// kanalga obuna sharti. Kanal va tugma havolasi — `adm:set:subchannel` / `adm:set:suburl`
// (umumiy SettingState oqimi, ../admin.ts), yoqish/o'chirish/tozalash — shu yerda.
// Callbacklar: sub:home, sub:on, sub:off, sub:clear.
import { Composer, InlineKeyboard } from 'grammy';
import { deleteSetting, setSetting } from '../../repo.js';
import { getSubConfig } from '../../subscribe.js';
import { esc } from '../../util.js';
import { clearState } from '../../repo.js';
import { render, type StaffContext, type View } from '../staff/ui.js';
import { requirePerm, stale } from './access.js';

export async function subHomeView(notice?: string): Promise<View> {
  const cfg = await getSubConfig();
  const lines: string[] = [];
  if (notice) lines.push(notice, '');
  lines.push(
    '📢 <b>Majburiy obuna</b>',
    '',
    `Holat: ${cfg.enabled ? '✅ yoqilgan' : '❌ o\u2018chiq'}`,
    `Kanal: ${cfg.channel ? esc(cfg.channel) : '—'}`,
    `Tugma havolasi: ${cfg.url ? esc(cfg.url) : '— (kanaldan olinadi)'}`,
    '',
    "Yoqilgan bo'lsa, mijoz /start va xabar yuborishda avval kanalga obuna bo'lishi shart bo'ladi. " +
      "«✅ Tekshirish» bosgach bot ishlaydi.",
    '',
    '⚠️ Bot kanalga <b>admin</b> qilib qo\u2018shilgan bo\u2018lishi kerak (aks holda tekshirib bo\u2018lmaydi va bot hammani o\u2018tkazadi).',
  );
  const kb = new InlineKeyboard()
    .text('✏️ Kanal', 'adm:set:subchannel')
    .text('✏️ Tugma havolasi', 'adm:set:suburl')
    .row();
  if (cfg.enabled) kb.text("❌ O'chirish", 'sub:off').row();
  else kb.text('✅ Yoqish', 'sub:on').row();
  kb.text('🗑 Tozalash', 'sub:clear').row();
  kb.text('⬅️ Admin panel', 'adm:home');
  return { text: lines.join('\n'), keyboard: kb };
}

export const subscribeComposer = new Composer<StaffContext>();

subscribeComposer.callbackQuery('sub:home', async (ctx) => {
  if (!(await requirePerm(ctx, 'panel'))) return;
  await clearState('staff', ctx.from!.id);
  await ctx.answerCallbackQuery();
  await render(ctx, await subHomeView());
});

subscribeComposer.callbackQuery('sub:on', async (ctx) => {
  if (!(await requirePerm(ctx, 'panel'))) return;
  await clearState('staff', ctx.from!.id);
  const cfg = await getSubConfig();
  if (!cfg.channel) {
    await ctx.answerCallbackQuery({ text: 'Avval kanalni kiriting', show_alert: true });
    await render(ctx, await subHomeView());
    return;
  }
  await setSetting('sub_enabled', '1');
  await ctx.answerCallbackQuery({ text: '✅ Yoqildi' });
  await render(ctx, await subHomeView('✅ Majburiy obuna yoqildi.'));
});

subscribeComposer.callbackQuery('sub:off', async (ctx) => {
  if (!(await requirePerm(ctx, 'panel'))) return;
  await clearState('staff', ctx.from!.id);
  await deleteSetting('sub_enabled');
  await ctx.answerCallbackQuery({ text: "❌ O'chirildi" });
  await render(ctx, await subHomeView("❌ Majburiy obuna o'chirildi."));
});

subscribeComposer.callbackQuery('sub:clear', async (ctx) => {
  if (!(await requirePerm(ctx, 'panel'))) return;
  await clearState('staff', ctx.from!.id);
  await deleteSetting('sub_enabled');
  await deleteSetting('sub_channel');
  await deleteSetting('sub_url');
  await ctx.answerCallbackQuery({ text: '🗑 Tozalandi' });
  await render(ctx, await subHomeView('🗑 Obuna sozlamalari tozalandi.'));
});

subscribeComposer.callbackQuery(/^sub:/, async (ctx) => {
  if (!(await requirePerm(ctx, 'panel'))) return;
  await stale(ctx);
});

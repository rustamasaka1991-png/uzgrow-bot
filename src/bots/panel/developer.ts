// 🛠 Developer paneli (faqat developer — ADMIN_IDS env): admin va ROP larni Telegram ID (yoki forward qilingan
// xabar) orqali qo'shish / olib tashlash va tizim holati. Maxfiy qiymatlar (tokenlar, kalitlar) hech qachon
// ko'rsatilmaydi — faqat "berilgan / berilmagan".
// Callbacklar: dev:home, dev:users, dev:add:<admin|rop>, dev:rm:<id>, dev:rmok:<id>, dev:sys.
import { Composer, InlineKeyboard } from 'grammy';
import type { Message as TgMessage } from 'grammy/types';
import { countComplaints } from '../../complaints.js';
import { config } from '../../config.js';
import { db } from '../../db.js';
import { botUsername, getAppUrl } from '../../links.js';
import { clearState, getSetting, getStaffByTgId, getStats, setState } from '../../repo.js';
import {
  ROLE_TITLES,
  can,
  listPanelUsers,
  removePanelRole,
  setPanelRole,
  type AssignableRole,
  type PanelUser,
} from '../../roles.js';
import { SCHEMA_VERSION } from '../../schema.js';
import { setAdminCommands, webhookStatus, type WebhookStatus } from '../../setup.js';
import { esc, formatTime, oneLine, tgErrorDescription, truncate } from '../../util.js';
import {
  TEXT_LIMIT,
  afterSuccess,
  fmtNum,
  mainKeyboard,
  parseId,
  render,
  sendHtml,
  stripKeyboard,
  type StaffContext,
  type View,
} from '../staff/ui.js';
import { requirePerm, stale } from './access.js';
import { casState, dropUserState, enterState, loadStateRow, repromptState, statePerm, type DevAddState } from './state.js';

/** Qisqa rol nomi (tugmalar va matn ichida). */
function roleShort(role: AssignableRole): string {
  return role === 'rop' ? 'ROP' : 'admin';
}

function isAssignable(s: string | undefined): s is AssignableRole {
  return s === 'admin' || s === 'rop';
}

// ───────────────────────────── Ko'rinishlar ─────────────────────────────

export async function devHomeView(notice?: string): Promise<View> {
  const users = await listPanelUsers();
  const rops = users.filter((u) => u.role === 'rop').length;
  const admins = users.filter((u) => u.role === 'admin').length;
  const devs = users.filter((u) => u.role === 'developer').length;
  const lines: string[] = [];
  if (notice) lines.push(notice, '');
  lines.push(
    '🛠 <b>Developer panel</b>',
    '',
    `🛠 Developerlar: ${devs} · 👑 ROP: ${rops} · ⚙️ Adminlar: ${admins}`,
    '',
    "Admin va ROP larni Telegram ID orqali qo'shing yoki olib tashlang, tizim holatini kuzating.",
  );
  const kb = new InlineKeyboard()
    .text('👥 Adminlar va ROP', 'dev:users')
    .row()
    .text("➕ Admin qo'shish", 'dev:add:admin')
    .text("➕ ROP qo'shish", 'dev:add:rop')
    .row()
    .text('🖥 Tizim holati', 'dev:sys')
    .row()
    .text('⬅️ Admin panel', 'adm:home');
  return { text: lines.join('\n'), keyboard: kb };
}

function userLine(u: PanelUser): string {
  const name = u.name ? esc(oneLine(u.name, 40)) : '—';
  return `${ROLE_TITLES[u.role]} · ${name} · ID <code>${u.tg_user_id}</code>${u.from_env ? ' 🔒' : ''}`;
}

export async function usersView(notice?: string): Promise<View> {
  const users = await listPanelUsers();
  const head: string[] = [];
  if (notice) head.push(notice, '');
  head.push(`👥 <b>Adminlar va ROP</b> (${users.length})`, '');
  const foot = ['', "🔒 — ADMIN_IDS dan (developer; botdan olib tashlab bo'lmaydi)", "🗑 — huquqni olib tashlash"];
  const lines = users.map(userLine);
  let text = [...head, ...lines, ...foot].join('\n');
  // Juda ko'p bo'lsa (amalda bo'lmaydi) — oxirgilari qisqartiriladi
  while (text.length > TEXT_LIMIT - 64 && lines.length > 1) {
    lines.pop();
    text = [...head, ...lines, '…', ...foot].join('\n');
  }
  const kb = new InlineKeyboard();
  for (const u of users.filter((x) => !x.from_env).slice(0, 40)) {
    const role = u.role as AssignableRole;
    kb.text(`🗑 ${oneLine(u.name || String(u.tg_user_id), 30)} (${roleShort(role)})`, `dev:rm:${u.tg_user_id}`).row();
  }
  kb.text("➕ Admin qo'shish", 'dev:add:admin').text("➕ ROP qo'shish", 'dev:add:rop').row();
  kb.text('⬅️ Developer panel', 'dev:home');
  return { text, keyboard: kb };
}

export function devAddPromptView(role: AssignableRole, error?: string): View {
  const lines = [
    `➕ <b>${roleShort(role) === 'ROP' ? 'ROP' : 'Admin'} qo'shish</b>`,
    '',
    `Yangi ${roleShort(role)} ning Telegram ID raqamini yuboring (masalan: 123456789).`,
    "ID ni @userinfobot orqali bilish mumkin. Yoki o'sha odamning biror xabarini shu yerga forward qiling.",
  ];
  if (error) lines.push('', `⚠️ ${esc(error)}`);
  return { text: lines.join('\n'), keyboard: new InlineKeyboard().text('✖️ Bekor qilish', 'adm:cancel') };
}

function webhookLines(title: string, configured: boolean, s: WebhookStatus | undefined): string[] {
  if (!configured) return [`${title}: ⚪️ token berilmagan`];
  if (!s) return [`${title}: ⚠️ holatini olib bo'lmadi`];
  const out = [
    `${title}: ${s.url ? '✅ webhook' : "❌ webhook o'rnatilmagan"}${s.url ? ` — ${esc(s.url)}` : ''}`,
    `   📥 Navbatda: ${fmtNum(s.pending_update_count)}`,
  ];
  if (s.last_error_message) {
    const when = s.last_error_date ? ` (${esc(formatTime(s.last_error_date))})` : '';
    out.push(`   ⚠️ Oxirgi xato${when}: ${esc(truncate(s.last_error_message, 200))}`);
  }
  return out;
}

export async function sysView(): Promise<View> {
  const sql = db();
  const [appUrl, dbVersion, clientHook, staffHook, st, cNew, cAll, running, users] = await Promise.all([
    getAppUrl().catch(() => ''),
    getSetting('schema_version').catch(() => null),
    webhookStatus('client'),
    config.hasStaffBot ? webhookStatus('staff') : Promise.resolve(undefined),
    getStats(),
    countComplaints('new'),
    countComplaints('all'),
    sql<{ n: number }[]>`select count(*)::int as n from broadcasts where status in ('pending', 'running')`,
    listPanelUsers(),
  ]);
  const yes = (b: boolean) => (b ? '✅' : '❌');
  const versionOk = dbVersion === SCHEMA_VERSION;
  const lines = [
    '🖥 <b>Tizim holati</b>',
    '',
    `🌐 Ilova: ${appUrl ? esc(appUrl) : '—'}`,
    `🗄 Sxema versiyasi: <code>${esc(dbVersion ?? '—')}</code>${versionOk ? ' ✅' : ` ⚠️ (kod: <code>${esc(SCHEMA_VERSION)}</code>)`}`,
    '',
    ...webhookLines('🤖 Mijozlar boti', true, clientHook),
    ...webhookLines('🧑‍💼 Xodimlar boti', config.hasStaffBot, staffHook),
    '',
    `👥 Mijozlar: ${fmtNum(st.clients)} · 💬 Suhbatlar: ${fmtNum(st.conversations)} · ✉️ Xabarlar: ${fmtNum(st.messages)}`,
    `🧑‍💼 Xodimlar: ${fmtNum(st.staff_total)} (akkaunti ulangan: ${fmtNum(st.staff_linked)})`,
    `⚠️ Shikoyatlar: ${fmtNum(cNew)} yangi / ${fmtNum(cAll)} jami`,
    `📣 Faol ommaviy xabarlar: ${fmtNum(running[0]?.n ?? 0)}`,
    `🔐 Panel foydalanuvchilari: ${fmtNum(users.length)}`,
    '',
    `🔑 STAFF_BOT_TOKEN: ${yes(config.hasStaffBot)} · SETUP_KEY: ${yes(!!config.setupKey)} · MEDIA_SECRET: ${yes(!!config.mediaSecret)}`,
    `🕐 Tekshirildi: ${esc(formatTime(new Date()))}`,
  ];
  const kb = new InlineKeyboard().text('🔄 Yangilash', 'dev:sys').text('⬅️ Developer panel', 'dev:home');
  return { text: lines.join('\n'), keyboard: kb };
}

// ───────────────────────────── Qo'shish ─────────────────────────────

async function startDevAdd(ctx: StaffContext, role: string | undefined): Promise<void> {
  if (!isAssignable(role)) return stale(ctx);
  const st: DevAddState = { step: 'dev_add', role };
  await ctx.answerCallbackQuery();
  await enterState(ctx, st, devAddPromptView(role), 'edit');
}

type Target = { ok: true; id: number; name: string } | { ok: false; error: string };

/** Kiritilgan ID (faqat raqamlar) yoki forward qilingan xabar egasi. */
function targetOf(msg: TgMessage): Target {
  const origin = msg.forward_origin;
  if (origin) {
    if (origin.type === 'user') {
      const u = origin.sender_user;
      if (u.is_bot) return { ok: false, error: "Botni admin yoki ROP qilib bo'lmaydi." };
      return { ok: true, id: u.id, name: [u.first_name, u.last_name].filter(Boolean).join(' ').trim() };
    }
    if (origin.type === 'hidden_user') {
      return {
        ok: false,
        error:
          `«${oneLine(origin.sender_user_name, 40)}» forward sozlamalarida akkauntini yashirgan — ID ni aniqlab bo'lmadi. ` +
          "Uning Telegram ID raqamini yuboring (@userinfobot orqali bilish mumkin).",
      };
    }
    return { ok: false, error: "Bu xabar foydalanuvchidan emas. Foydalanuvchining xabarini forward qiling yoki ID raqamini yuboring." };
  }
  const t = (msg.text ?? '').trim();
  if (/^\d{1,15}$/.test(t)) {
    const id = Number(t);
    if (Number.isSafeInteger(id) && id > 0) return { ok: true, id, name: '' };
  }
  return { ok: false, error: "ID faqat raqamlardan iborat bo'lishi kerak (masalan: 123456789)." };
}

/** `dev_add` holatidagi xabar: ID yoki forward → rol beriladi. */
export async function handleDevAddInput(ctx: StaffContext, msg: TgMessage, st: DevAddState): Promise<void> {
  const uid = ctx.from!.id;
  const t = targetOf(msg);
  if (!t.ok) return repromptState(ctx, st, msg, devAddPromptView(st.role, t.error));

  // Holat avval olinadi — bir vaqtda kelgan ikki xabar bir amalni ikki marta bajarmaydi
  if (!(await casState(uid, st, null))) return;
  let name = t.name;
  let res: Awaited<ReturnType<typeof setPanelRole>>;
  try {
    if (!name) name = (await getStaffByTgId(t.id))?.full_name ?? '';
    res = await setPanelRole(t.id, st.role, name, uid);
  } catch (e) {
    await setState('staff', uid, st).catch(() => {});
    throw e;
  }
  if (!res.ok) {
    await setState('staff', uid, st);
    const error = res.reason === 'developer' ? 'Bu foydalanuvchi allaqachon developer.' : "ID noto'g'ri.";
    return repromptState(ctx, st, null, devAddPromptView(st.role, error));
  }

  await stripKeyboard(ctx, st.promptMsgId);
  // Rol pasaytirilgan bo'lsa (ROP → admin): endi ruxsat yo'q tugallanmagan amal (masalan, yozilayotgan ommaviy
  // xabar) darhol bekor qilinadi — dev:rmok dagidek
  if (t.id !== uid) {
    const row = await loadStateRow(t.id).catch(() => null);
    if (row && row.st.step !== 'group' && !can(st.role, statePerm(row.st))) {
      await dropUserState(ctx.api, t.id).catch(() => false);
    }
  }
  const title = ROLE_TITLES[st.role];
  const bot = await botUsername('staff').catch(() => '');
  const where = bot ? `@${esc(bot)} ga` : 'xodimlar botiga';
  const who = t.name ? ` (<b>${esc(oneLine(t.name, 40))}</b>)` : '';
  // Rol allaqachon berilgan — tasdiq eng yaxshi urinish (yangi foydalanuvchiga xabar baribir yuboriladi)
  await afterSuccess('rol berilgani haqidagi tasdiq', () =>
    sendHtml(ctx, `✅ <code>${t.id}</code>${who} endi ${title}. U ${where} /start yozsa, «⚙️ Admin panel» chiqadi.`, {
      markup: new InlineKeyboard().text('👥 Adminlar va ROP', 'dev:users').text('⬅️ Developer panel', 'dev:home'),
    }),
  );

  // Yangi panel foydalanuvchisiga: /admin buyrug'i va xabar (u botni hali ochmagan bo'lsa — xato, e'tiborsiz)
  if (t.id !== uid) {
    await setAdminCommands(ctx.api, t.id).catch(() => {});
    try {
      const staff = await getStaffByTgId(t.id);
      await ctx.api.sendMessage(t.id, `🎉 Sizga ${title} huquqi berildi. /admin — boshqaruv paneli.`, {
        reply_markup: mainKeyboard(staff, true),
      });
    } catch (e) {
      console.warn(`[staff/dev] ${t.id} ga xabar yuborilmadi:`, tgErrorDescription(e));
    }
  }
}

// ───────────────────────────── Olib tashlash ─────────────────────────────

async function findAssigned(id: number | null): Promise<PanelUser | null> {
  if (!id) return null;
  return (await listPanelUsers()).find((u) => u.tg_user_id === id && !u.from_env) ?? null;
}

async function confirmRemove(ctx: StaffContext, idStr: string | undefined): Promise<void> {
  const u = await findAssigned(parseId(idStr));
  if (!u) {
    await ctx.answerCallbackQuery({ text: 'Topilmadi (allaqachon olib tashlangan bo\'lishi mumkin)', show_alert: true });
    await render(ctx, await usersView());
    return;
  }
  await ctx.answerCallbackQuery();
  const name = u.name ? `<b>${esc(oneLine(u.name, 40))}</b> · ` : '';
  await render(ctx, {
    text:
      `🗑 ${name}ID <code>${u.tg_user_id}</code> — ${ROLE_TITLES[u.role]} huquqi olib tashlansinmi?\n\n` +
      "U boshqaruv paneliga kira olmaydi (xodim bo'lsa, xodim sifatida ishlashda davom etadi).",
    keyboard: new InlineKeyboard()
      .text('✅ Ha, olib tashlash', `dev:rmok:${u.tg_user_id}`)
      .text("❌ Yo'q", 'dev:users'),
  });
}

async function doRemove(ctx: StaffContext, idStr: string | undefined): Promise<void> {
  const u = await findAssigned(parseId(idStr));
  // Tugallanmagan panel amali (masalan, yozilayotgan ommaviy xabar) rol o'chirilishidan OLDIN bekor qilinadi: aks
  // holda rol o'chirilgan, holat esa hali turgan oraliqda kelgan xabar admin kiritmasi sifatida qabul qilinishi mumkin
  if (u) await dropUserState(ctx.api, u.tg_user_id).catch(() => false);
  const removed = u ? await removePanelRole(u.tg_user_id) : false;
  if (!u || !removed) {
    await ctx.answerCallbackQuery({ text: 'Allaqachon olib tashlangan' });
    await render(ctx, await usersView());
    return;
  }
  await ctx.answerCallbackQuery({ text: '🗑 Olib tashlandi' });
  const id = u.tg_user_id;
  // Oraliqda (holat bekor qilingandan keyin, rol o'chirilishidan oldin) panel tugmasi bilan yangi amal boshlangan
  // bo'lsa — u ham bekor qilinadi
  await dropUserState(ctx.api, id).catch(() => false);
  try {
    const staff = await getStaffByTgId(id);
    await ctx.api.sendMessage(id, `ℹ️ Sizning ${ROLE_TITLES[u.role]} huquqingiz olib tashlandi.`, {
      reply_markup: mainKeyboard(staff, false),
    });
  } catch (e) {
    console.warn(`[staff/dev] ${id} ga xabar yuborilmadi:`, tgErrorDescription(e));
  }
  await ctx.api.deleteMyCommands({ scope: { type: 'chat', chat_id: id } }).catch(() => {});
  await afterSuccess("huquq olib tashlangandan keyingi ro'yxat", async () =>
    render(ctx, await usersView(`✅ <code>${id}</code> — ${ROLE_TITLES[u.role]} huquqi olib tashlandi.`)),
  );
}

// ───────────────────────────── Handler ─────────────────────────────

export const developerComposer = new Composer<StaffContext>();

developerComposer.callbackQuery(/^dev:/, async (ctx) => {
  if (!(await requirePerm(ctx, 'developer'))) return;
  const [, action = '', a1] = (ctx.callbackQuery.data ?? '').split(':');
  // Navigatsiya kutilayotgan panel kiritmasini bekor qiladi (dev:add yangi holat bilan almashtiradi)
  if (action !== 'add') await clearState('staff', ctx.from!.id);
  switch (action) {
    case 'home':
      await ctx.answerCallbackQuery();
      await render(ctx, await devHomeView());
      return;
    case 'users':
      await ctx.answerCallbackQuery();
      await render(ctx, await usersView());
      return;
    case 'add':
      return startDevAdd(ctx, a1);
    case 'rm':
      return confirmRemove(ctx, a1);
    case 'rmok':
      return doRemove(ctx, a1);
    case 'sys':
      await ctx.answerCallbackQuery();
      await render(ctx, await sysView());
      return;
    default:
      return stale(ctx);
  }
});

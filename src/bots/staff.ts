// Operator va menejerlar boti (STAFF_BOT_TOKEN): mijozlar xabarlarini qabul qilish, javob berish,
// chatlar ro'yxati va tarixi. Boshqaruv paneli (developer / ROP / admin) — ./admin.ts va ./panel/* (shu botning ichida).
import { Bot, Composer, InlineKeyboard, type BotError, type CommandContext, type NextFunction } from 'grammy';
import type { Message as TgMessage } from 'grammy/types';
import { config } from '../config.js';
import { db } from '../db.js';
import { getWebAppUrl } from '../links.js';
import {
  handleStaffReachable,
  relayErrorText,
  relayStaffMessage,
  retryDelivery,
  type RelayResult,
} from '../relay.js';
import {
  countStaffConversations,
  getClient,
  getStaffByTgId,
  linkStaffByInvite,
  listMessages,
  listStaffConversations,
  markReadByStaff,
  setStaffActiveConversation,
  updateStaff,
  updateStaffUsername,
} from '../repo.js';
import { ROLE_TITLES, can, getPanelRole, panelRecipients, type PanelRole } from '../roles.js';
import { setAdminCommands } from '../setup.js';
import { greetingText } from '../texts.js';
import { extractContent, react, retryOnFlood } from '../tg.js';
import type { Conversation, ConversationView, Staff } from '../types.js';
import { dativeSuffix, esc, formatTime, isNotModified, oneLine, roleIcon, roleLabel, tgErrorDescription, truncate } from '../util.js';
import { adminComposer, dropAdminState } from './admin.js';
import {
  candidateOf,
  clearActiveIf,
  clientNameOf,
  newerWaitingConversations,
  ownActiveConversation,
  ownConversationView,
  recentCandidates,
  relayedStaffMessageExists,
  resolveReplyConversation,
  type RecipientCandidate,
} from './staff/conv.js';
import { onStaffEdit } from './staff/edits.js';
import { buildTranscript } from './staff/transcript.js';
import {
  BTN,
  CAPTION_LIMIT,
  CLIENT_LINK_HINT,
  ERROR_TEXT,
  INACTIVE_TEXT,
  NOT_STAFF_TEXT,
  PANEL_CALLBACK_RE as PANEL_CALLBACK_DATA_RE,
  STALE_BUTTON_TEXT,
  afterSuccess,
  callbackMessage,
  clientLinkOf,
  isCommandMessage,
  logError,
  mainKeyboard,
  parseId,
  render,
  sendHtml,
  shareUrl,
  stripKeyboard,
  type StaffContext,
  type View,
} from './staff/ui.js';

const CHATS_PAGE_SIZE = 8;
const TRANSCRIPT_SIZE = 15;

// ───────────────────────────── Bot yaratish ─────────────────────────────

let botPromise: Promise<Bot> | null = null;

/** Xodimlar boti (bir marta yaratiladi va init qilinadi; xato bo'lsa keyingi chaqiruvda qayta uriniladi). */
export async function getStaffBot(): Promise<Bot> {
  if (!botPromise) {
    const p = (async () => {
      const bot = createStaffBot();
      await bot.init();
      return bot as unknown as Bot;
    })();
    botPromise = p;
    p.catch((e) => {
      console.error('[staff] botni ishga tushirib bo\'lmadi:', tgErrorDescription(e));
      if (botPromise === p) botPromise = null;
    });
  }
  return botPromise;
}

function createStaffBot(): Bot<StaffContext> {
  if (!config.hasStaffBot) throw new Error('STAFF_BOT_TOKEN berilmagan — xodimlar boti ishlamaydi');
  const bot = new Bot<StaffContext>(config.staffBotToken, { client: { apiRoot: config.telegramApiRoot } });
  bot.api.config.use(retryOnFlood);
  bot.catch((err) => logError(`update #${err.ctx.update.update_id} (kutilmagan xato)`, err.error));

  const root = bot.errorBoundary(onError);
  root.use(privateOnly);
  root.use(ensureCallbackAnswered);
  root.use(identity);
  // Tahrirlangan xabarlar: faqat mijozga yetkazilgan nusxani yangilash. Buyruq/tugma/admin kiritmasi
  // handlerlari tahrirda qayta ishga tushmasligi uchun shu yerda to'xtatiladi (next() chaqirilmaydi).
  root.on('edited_message', onStaffEdit);
  root.command('start', onStart);
  root.use(unknownUserGuard);
  root.command('cancel', onCancel);
  root.use(adminComposer);
  root.use(staffHandlers());
  return bot;
}

// ───────────────────────────── Umumiy middleware ─────────────────────────────

async function onError(err: BotError<StaffContext>): Promise<void> {
  const ctx = err.ctx;
  // Telegram xatosining payload i (mijoz yozishmalari) logga yozilmaydi — faqat metod, kod va tavsif
  logError(`update #${ctx.update.update_id}`, err.error);
  // Callback query ga javob ensureCallbackAnswered da (xato holatida ham) beriladi.
  if (ctx.chat?.type === 'private') {
    await ctx.reply(ERROR_TEXT).catch(() => {});
  }
}

/** Faqat shaxsiy chatlar; guruh/kanallar jimgina e'tiborsiz qoldiriladi. */
async function privateOnly(ctx: StaffContext, next: NextFunction): Promise<void> {
  if (ctx.myChatMember) {
    // Xodim botni bloklashi/qaytishi (oflayn belgisi, adminlarga xabar, navbatni yetkazish) yagona joyda —
    // src/presence.ts (api/staff-bot.ts afterUpdate) da bajariladi; bu yerda takrorlanmaydi.
    const u = ctx.myChatMember;
    console.log(`[staff] my_chat_member: ${u.from.id} -> ${u.new_chat_member.status}`);
    return;
  }
  if (ctx.chat?.type !== 'private' || !ctx.from || ctx.from.is_bot) {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
    return;
  }
  await next();
}

/**
 * Har bir callback query albatta javob oladi (hatto handler javob bermasa yoki xato bo'lsa ham).
 * Javob — "best-effort" va faqat bir marta: Telegram rad etsa (masalan, qayta yuborilgan eski update da
 * "query is too old"), bu asosiy amalni (o'chirish, suhbatni ochish...) yarim yo'lda to'xtatmaydi.
 */
async function ensureCallbackAnswered(ctx: StaffContext, next: NextFunction): Promise<void> {
  if (!ctx.callbackQuery) return next();
  let answered = false;
  const original = ctx.answerCallbackQuery.bind(ctx);
  ctx.answerCallbackQuery = ((...args: Parameters<typeof original>) => {
    if (answered) return Promise.resolve(true as const); // ikkinchi javob Telegramda 400 bo'lardi
    answered = true;
    return original(...args).catch((e) => {
      console.warn('[staff] answerCallbackQuery:', tgErrorDescription(e));
      return true as const;
    });
  }) as typeof ctx.answerCallbackQuery;
  try {
    await next();
  } catch (e) {
    if (!answered) {
      answered = true;
      await original({ text: '⚠️ Xatolik yuz berdi' }).catch(() => {});
    }
    throw e;
  } finally {
    if (!answered) await original().catch(() => {});
  }
}

/** Kim yozyapti: ulangan xodim (ctx.staff) va/yoki panel roli (ctx.panelRole: developer / ROP / admin). */
async function identity(ctx: StaffContext, next: NextFunction): Promise<void> {
  const from = ctx.from!;
  let staff = await getStaffByTgId(from.id);
  const username = from.username ?? null;
  if (staff && (staff.tg_username ?? null) !== username) {
    try {
      await updateStaffUsername(staff.id, username);
      staff = { ...staff, tg_username: username };
    } catch (e) {
      logError('username yangilanmadi', e);
    }
  }
  // Botni bloklagan deb belgilangan xodim yana yozdi — demak u qaytgan: belgini olib tashlab (onlayn holati
  // tiklanadi), navbatdagi mijoz xabarlarini yetkazamiz. Keyin update odatdagidek (yangi holat bilan) qayta ishlanadi.
  if (staff?.bot_blocked) {
    try {
      await handleStaffReachable(staff);
      staff = (await getStaffByTgId(from.id)) ?? staff;
    } catch (e) {
      logError('handleStaffReachable', e);
    }
  }
  ctx.staff = staff;
  // Rol har bir update da qayta aniqlanadi (olib tashlangan huquq darhol amal qiladi). Panel tugmalari (bloklash,
  // o'chirish, shikoyatlar, ommaviy xabar, developer) va panelga kirish xabarlari (/start, /admin, /cancel,
  // «⚙️ Admin panel») — keshsiz: boshqa instansiyada olib tashlangan (yoki berilgan) rol ham darhol amal qiladi.
  // Keshda rol bo'lsa — har qanday update da (kutilayotgan panel kiritmasi ham) rol bazadan qayta tekshiriladi.
  const panelCallback = PANEL_CALLBACK_DATA_RE.test(ctx.callbackQuery?.data ?? '');
  const text = ctx.message?.text ?? '';
  const panelEntry = text === BTN.admin || /^\/(start|admin|cancel)(@\w+)?(\s|$)/i.test(text);
  ctx.panelRole = await getPanelRole(from.id, { fresh: panelCallback || panelEntry, freshIfRole: true });
  ctx.admin = !!ctx.panelRole;
  await next();
}

/** Xodim ham, admin ham bo'lmaganlarga hech narsa ochilmaydi. */
async function unknownUserGuard(ctx: StaffContext, next: NextFunction): Promise<void> {
  if (ctx.staff || ctx.admin) return next();
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({ text: 'Bu bot faqat xodimlar uchun', show_alert: true });
    return;
  }
  if (ctx.message) await sendHtml(ctx, NOT_STAFF_TEXT, { markup: { remove_keyboard: true } });
}

// ───────────────────────────── /start, /cancel ─────────────────────────────

async function onStart(ctx: CommandContext<StaffContext>): Promise<void> {
  const payload = (ctx.match ?? '').trim();
  // Tugallanmagan panel amali bekor qilinadi (so'rov xabaridagi tugmalar ham olib tashlanadi) — huquqi olib
  // tashlangan foydalanuvchida qolib ketgan holat ham
  await dropAdminState(ctx);
  if (ctx.admin) {
    // /admin buyrug'i faqat panel foydalanuvchilari menyusida ko'rinsin (setup vaqtida ularning chati hali bo'lmagan bo'lishi mumkin)
    await setAdminCommands(ctx.api, ctx.from!.id).catch((e) =>
      console.warn('[staff] admin buyruqlari o\'rnatilmadi:', tgErrorDescription(e)),
    );
  } else {
    // Panel roli yo'q: rol olib tashlanishi bilan bir vaqtda boshqa instansiyada qayta o'rnatilgan eski /admin
    // buyrug'i menyuda qolib ketmasin (xatolar e'tiborsiz)
    await ctx.api.deleteMyCommands({ scope: { type: 'chat', chat_id: ctx.from!.id } }).catch(() => {});
  }

  if (payload.startsWith('inv_')) {
    await handleInvite(ctx, payload.slice(4));
    return;
  }

  const me = ctx.staff;
  if (me) {
    await sendHtml(ctx, staffWelcomeText(me, ctx.panelRole, await clientLinkOf(me)), { markup: mainKeyboard(me, ctx.admin) });
    await sendWebAppHint(ctx);
    return;
  }
  if (ctx.panelRole) {
    await sendHtml(ctx, panelWelcomeText(ctx.panelRole), { markup: mainKeyboard(null, true) });
    return;
  }
  await sendHtml(ctx, NOT_STAFF_TEXT, { markup: { remove_keyboard: true } });
}

/** Xodim profili yo'q panel foydalanuvchisi (developer / ROP / admin) uchun /start matni. */
function panelWelcomeText(role: PanelRole): string {
  const lines = [
    `👋 Assalomu alaykum! Sizning rolingiz: <b>${ROLE_TITLES[role]}</b>.`,
    '',
    "⚙️ «Admin panel» orqali operator va menejerlarni qo'shing, ularga taklif havolasini yuboring, bloklang yoki " +
      "o'chiring, matnlarni sozlang va statistikani kuzating.",
  ];
  if (can(role, 'broadcast')) {
    lines.push('', '📣 Mijozlarga ommaviy xabar yuborish ham shu yerda.');
  }
  if (can(role, 'complaints')) {
    lines.push('', '⚠️ Xodimlar ustidan shikoyatlarni ko‘rish ham shu yerda.');
  }
  if (can(role, 'developer')) lines.push('', "🛠 Developer panel — admin va ROP larni qo'shish, tizim holati.");
  lines.push(
    '',
    "ℹ️ Mijozlar bilan o'zingiz ham yozishmoqchi bo'lsangiz — o'zingizni xodim sifatida qo'shib, taklif havolasini bosing.",
  );
  return lines.join('\n');
}

function staffWelcomeText(me: Staff, role: PanelRole | null, clientLink: string): string {
  const lines = [
    `👋 Assalomu alaykum, <b>${esc(me.full_name)}</b>!`,
    '',
    `Siz <b>${roleIcon(me.role)} ${roleLabel(me.role)}</b> sifatida ishlaysiz. Mijozlar sizga yozgan xabarlar shu yerga keladi.`,
    '',
  ];
  if (clientLink) {
    const hint = me.is_active ? CLIENT_LINK_HINT : 'Havola profilingiz blokdan chiqarilgach ishlaydi.';
    lines.push(`🔗 Mijozlar uchun havolangiz: ${esc(clientLink)}`, `<i>${esc(hint)}</i>`, '');
  }
  lines.push(
    `${me.is_online ? '🟢 Holatingiz: <b>onlayn</b>' : '⚪️ Holatingiz: <b>oflayn</b>'} (o'zgartirish — «${BTN.status}»)`,
    '✍️ Javob berish uchun mijoz xabariga <b>Reply</b> qiling yoki «↩️ Javob berish» tugmasini bosing.',
  );
  if (!me.is_active) {
    lines.push(
      '',
      "🚫 Profilingiz bloklangan — mijozlar sizni ro'yxatda ko'rmaydi va siz ham ularga xabar yubora olmaysiz.",
    );
  }
  if (role) lines.push('', `⚙️ Sizning rolingiz: <b>${ROLE_TITLES[role]}</b> — «${BTN.admin}» tugmasi orqali boshqarasiz.`);
  return lines.join('\n');
}

async function sendWebAppHint(ctx: StaffContext): Promise<void> {
  const url = await getWebAppUrl();
  if (!url) return;
  await sendHtml(ctx, '📱 Barcha chatlaringizni Telegramdagidek qulay ko\'rinishda oching:', {
    markup: new InlineKeyboard().webApp('📱 Chatlarni ochish', url),
  });
}

async function handleInvite(ctx: StaffContext, code: string): Promise<void> {
  const from = ctx.from!;
  const keyboardNow = mainKeyboard(ctx.staff, ctx.admin);
  if (!/^[A-Za-z0-9]{4,64}$/.test(code)) {
    await sendHtml(ctx, "❌ Taklif havolasi noto'g'ri yoki eskirgan. Admindan yangi havola so'rang.", { markup: keyboardNow });
    return;
  }
  const res = await linkStaffByInvite(code, from.id, from.username ?? null);
  if (!res.ok) {
    let text: string;
    if (res.reason === 'already_linked_other') {
      text = "❌ Sizning akkauntingiz boshqa xodim profiliga ulangan.";
    } else if (res.reason === 'taken') {
      text = '❌ Bu profil boshqa akkauntga ulangan.';
    } else if (ctx.staff) {
      text = `ℹ️ Siz allaqachon <b>${esc(ctx.staff.full_name)}</b> (${roleLabel(ctx.staff.role)}) profiliga ulangansiz.`;
    } else {
      text = "❌ Taklif havolasi noto'g'ri yoki eskirgan. Admindan yangi havola so'rang.";
    }
    await sendHtml(ctx, text, { markup: keyboardNow });
    return;
  }

  const s = res.staff;
  ctx.staff = s;
  const clientLink = await clientLinkOf(s);
  const lines = [
    `✅ Tabriklaymiz! Siz <b>${esc(s.full_name)}</b> (${roleLabel(s.role)}) profiliga muvaffaqiyatli ulandingiz.`,
    '',
    '📩 Endi mijozlar sizni menyuda ko\'radi va yozgan xabarlari shu yerga keladi.',
    '',
  ];
  if (clientLink) {
    lines.push(
      '🔗 <b>Mijozlar uchun havolangiz:</b>',
      esc(clientLink),
      esc(s.is_active ? CLIENT_LINK_HINT : 'Havola profilingiz blokdan chiqarilgach ishlaydi.'),
      `<i>📋 Nusxalash va ulashish — «${BTN.profile}» da.</i>`,
      '',
    );
  }
  lines.push(
    '<b>Qanday javob beriladi?</b>',
    '• Mijoz xabariga <b>Reply</b> qiling, yoki',
    '• xabar ostidagi «↩️ Javob berish» tugmasini bosing — keyingi xabarlaringiz shu mijozga boradi.',
    '',
    `💬 Barcha suhbatlar — «${BTN.chats}», holatingiz — «${BTN.status}».`,
  );
  if (!s.is_active) {
    lines.push(
      '',
      "🚫 Profilingiz hozircha bloklangan — blokdan chiqarilgach, mijozlar sizni ko'radi va siz ularga yoza olasiz.",
    );
  }
  // Akkaunt allaqachon ulangan — xush kelibsiz xabari eng yaxshi urinish (adminlarga xabar baribir yuboriladi)
  await afterSuccess('ulanish tasdig\'i', async () => {
    await sendHtml(ctx, lines.join('\n'), { markup: mainKeyboard(s, ctx.admin) });
    await sendWebAppHint(ctx);
  });

  const who = from.username ? `@${esc(from.username)}` : `ID: <code>${from.id}</code>`;
  const note = `🔗 <b>${esc(s.full_name)}</b> (${roleLabel(s.role)}) akkauntini ulab oldi (${who})`;
  const recipients = await panelRecipients('panel').catch(() => config.adminIds);
  await Promise.allSettled(
    recipients.filter((id) => id !== from.id).map((id) => ctx.api.sendMessage(id, note, { parse_mode: 'HTML' })),
  );
}

/**
 * /cancel: eng aniq kutilayotgan narsani bekor qiladi — tugallanmagan admin amali bo'lsa o'shani,
 * aks holda aktiv suhbatni yopadi (keyingi Reply'siz xabar hech kimga avtomatik ketmaydi).
 */
async function onCancel(ctx: StaffContext): Promise<void> {
  const droppedAdmin = await dropAdminState(ctx);
  const me = ctx.staff;
  let text = '✖️ Bekor qilindi';
  if (!droppedAdmin && me?.active_conversation_id) {
    const activeId = me.active_conversation_id;
    const v = await ownConversationView(me, activeId);
    if (await clearActiveIf(me.id, activeId)) {
      ctx.staff = { ...me, active_conversation_id: null };
      if (v) {
        text =
          `✖️ Bekor qilindi — <b>${esc(clientNameOf(v))}</b> bilan aktiv suhbat yopildi.\n\n` +
          '✍️ Keyingi xabaringiz uchun mijoz xabariga <b>Reply</b> qiling yoki «↩️ Javob berish» tugmasini bosing.';
      }
    }
  }
  await sendHtml(ctx, text, { markup: mainKeyboard(ctx.staff, ctx.admin) });
}

// ───────────────────────────── Xodim handlerlari ─────────────────────────────

function staffHandlers(): Composer<StaffContext> {
  const c = new Composer<StaffContext>();

  c.callbackQuery('noop', (ctx) => ctx.answerCallbackQuery());

  c.command('chats', (ctx) => showChats(ctx, 0, 'new'));
  c.hears(BTN.chats, (ctx) => showChats(ctx, 0, 'new'));
  // `chats:<p>` — ro'yxat sahifalari (joyida tahrirlanadi); `chats:<p>:n` — transkript/profil ostidan (yangi xabar,
  // o'qilayotgan tarix yoki profil kartasi o'chib ketmaydi)
  c.callbackQuery(/^chats:(\d{1,6})(:n)?$/, (ctx) => showChats(ctx, Number(ctx.match[1]), ctx.match[2] ? 'new' : 'edit'));

  c.command('status', toggleStatus);
  c.hears(BTN.status, toggleStatus);

  c.command('profile', showProfile);
  c.hears(BTN.profile, showProfile);

  c.command('help', showHelp);
  c.hears(BTN.help, showHelp);

  c.callbackQuery(/^open:(\d{1,15})$/, (ctx) => onOpen(ctx, ctx.match[1]));
  c.callbackQuery(/^shist:(\d{1,15}):(\d{1,15})$/, (ctx) => onHistory(ctx, ctx.match[1], ctx.match[2]));
  c.callbackQuery(/^cinfo:(\d{1,15})$/, (ctx) => onClientInfo(ctx, ctx.match[1]));
  c.callbackQuery(/^act:(\d{1,15})$/, (ctx) => onActivate(ctx, ctx.match[1]));
  c.callbackQuery(/^deact:(\d{1,15})(?::(\d{1,6}))?$/, (ctx) => onDeactivate(ctx, ctx.match[1], ctx.match[2]));
  c.callbackQuery(/^to:(\d{1,15})$/, (ctx) => onSendTo(ctx, ctx.match[1]));
  c.callbackQuery(/^retry:(\d{1,15})$/, (ctx) => onRetry(ctx, ctx.match[1]));

  // Noma'lum / eskirgan tugmalar
  c.on('callback_query', (ctx) => ctx.answerCallbackQuery({ text: STALE_BUTTON_TEXT }));

  c.on('message', routeStaffMessage);
  return c;
}

/** Xodim profili talab qilinadigan joylarda: yo'q bo'lsa (admin, lekin xodim emas) — tushuntirish. */
async function requireStaff(ctx: StaffContext): Promise<Staff | null> {
  if (ctx.staff) return ctx.staff;
  const text = 'ℹ️ Siz xodim profiliga ulanmagansiz — bu bo\'lim faqat operator va menejerlar uchun.';
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({ text, show_alert: true });
  } else {
    await sendHtml(ctx, `${esc(text)}\n\n⚙️ Xodimlarni boshqarish uchun «${BTN.admin}» tugmasini bosing.`, {
      markup: mainKeyboard(null, ctx.admin),
    });
  }
  return null;
}

async function denyConversation(ctx: StaffContext): Promise<void> {
  await ctx.answerCallbackQuery({ text: "⛔ Suhbat topilmadi yoki sizga tegishli emas", show_alert: true });
}

/** Aktiv suhbatni yopish tugmasi (bitta suhbatga tegishli xabarlar uchun). */
function deactButton(kb: InlineKeyboard, conversationId: number): InlineKeyboard {
  return kb.text('✖️ Aktivni yopish', `deact:${conversationId}`);
}

// ── 💬 Chatlar ──

async function showChats(ctx: StaffContext, page: number, mode: 'edit' | 'new'): Promise<void> {
  const me = await requireStaff(ctx);
  if (!me) return;
  const view = await chatsView(me, page);
  await render(ctx, view, mode);
  if (ctx.callbackQuery) await ctx.answerCallbackQuery();
}

async function chatsView(me: Staff, page: number): Promise<View> {
  const total = await countStaffConversations(me.id);
  const pages = Math.max(1, Math.ceil(total / CHATS_PAGE_SIZE));
  const p = Math.min(Math.max(0, Math.trunc(page) || 0), pages - 1);
  const [list, active, url] = await Promise.all([
    total ? listStaffConversations(me.id, { limit: CHATS_PAGE_SIZE, offset: p * CHATS_PAGE_SIZE }) : Promise.resolve([]),
    ownConversationView(me, me.active_conversation_id),
    getWebAppUrl(),
  ]);

  const lines = [`💬 <b>Chatlaringiz</b> (${total})`];
  if (active) lines.push(`✍️ Aktiv: <b>${esc(clientNameOf(active))}</b>`);
  if (!total) {
    lines.push('', "Hozircha chatlar yo'q. Mijozlar sizga yozishi bilan shu yerda paydo bo'ladi.");
  } else {
    lines.push('', 'Suhbatni ochish uchun tanlang 👇');
    if (list.some((v) => v.unread_staff > 0)) lines.push("🔴 — o'qilmagan xabarlar soni");
  }

  const kb = new InlineKeyboard();
  for (const v of list) {
    const unread = v.unread_staff > 0 ? `🔴${v.unread_staff} ` : '';
    const mark = active && v.id === active.id ? '✍️ ' : '';
    const preview = oneLine(v.last_message_preview, 28);
    const label = `${unread}${mark}${oneLine(clientNameOf(v), 24)}${preview ? ' · ' + preview : ''}`;
    kb.text(label, `open:${v.id}`).row();
  }
  if (pages > 1) {
    if (p > 0) kb.text('⬅️', `chats:${p - 1}`);
    kb.text(`${p + 1}/${pages}`, 'noop');
    if (p < pages - 1) kb.text('➡️', `chats:${p + 1}`);
    kb.row();
  }
  // Ro'yxatdagi variant sahifa raqami bilan (joyida yangilanadi); bitta suhbat "langari" hisoblanmaydi
  if (active) kb.text(`✖️ Aktivni yopish (${oneLine(clientNameOf(active), 24)})`, `deact:${active.id}:${p}`).row();
  if (url) kb.webApp('📱 Mini App da ochish', url);
  return { text: lines.join('\n'), keyboard: kb };
}

// ── Suhbatni ochish va tarix ──

function transcriptLabels(v: ConversationView) {
  return {
    client: `👤 <b>${esc(oneLine(clientNameOf(v), 40))}</b>`,
    staff: '<b>Siz</b>',
    bot: '🤖 <i>Avto-javob</i>',
  };
}

async function sendTranscript(ctx: StaffContext, v: ConversationView, beforeId: number | null): Promise<void> {
  const rows = await listMessages(v.id, {
    ...(beforeId ? { beforeId } : {}),
    limit: TRANSCRIPT_SIZE + 1,
  });
  const more = rows.length > TRANSCRIPT_SIZE;
  const msgs = more ? rows.slice(rows.length - TRANSCRIPT_SIZE) : rows;
  const name = clientNameOf(v);
  const uname = v.client_username ? ` · @${esc(v.client_username)}` : '';
  const header = beforeId
    ? `📜 <b>${esc(name)}</b>${uname} — oldingi xabarlar`
    : `💬 <b>${esc(name)}</b>${uname}`;
  const footer = beforeId ? undefined : `✍️ Endi yozgan xabarlaringiz <b>${esc(name)}</b>${dativeSuffix(name)} yuboriladi.`;
  const t = buildTranscript(msgs, transcriptLabels(v), {
    header,
    ...(footer ? { footer } : {}),
    hasMore: more,
    empty: beforeId ? "<i>Bundan oldingi xabarlar yo'q.</i>" : "<i>Hozircha xabarlar yo'q.</i>",
  });

  // `cinfo:<id>` / `shist:<id>:..` tugmalari transkriptni shu suhbatga bog'laydi: unga Reply qilinsa, xabar
  // aynan shu mijozga boradi (conv.ts → resolveReplyConversation).
  const kb = new InlineKeyboard();
  if (t.hasMore && t.oldestId) kb.text('⬆️ Oldingi', `shist:${v.id}:${t.oldestId}`).row();
  kb.text('ℹ️ Mijoz haqida', `cinfo:${v.id}`).text('💬 Chatlar', 'chats:0:n');
  await sendHtml(ctx, t.text, { markup: kb });
}

async function onOpen(ctx: StaffContext, idStr: string | undefined): Promise<void> {
  const me = await requireStaff(ctx);
  if (!me) return;
  const v = await ownConversationView(me, parseId(idStr));
  if (!v) return denyConversation(ctx);
  await setStaffActiveConversation(me.id, v.id);
  await markReadByStaff(v.id);
  ctx.staff = { ...me, active_conversation_id: v.id };
  await ctx.answerCallbackQuery({ text: `✍️ ${oneLine(clientNameOf(v), 60)}` });
  await sendTranscript(ctx, v, null);
}

async function onHistory(ctx: StaffContext, idStr: string | undefined, beforeStr: string | undefined): Promise<void> {
  const me = await requireStaff(ctx);
  if (!me) return;
  const v = await ownConversationView(me, parseId(idStr));
  if (!v) return denyConversation(ctx);
  const before = beforeStr === '0' ? null : parseId(beforeStr);
  await ctx.answerCallbackQuery();
  await sendTranscript(ctx, v, before);
}

async function onClientInfo(ctx: StaffContext, idStr: string | undefined): Promise<void> {
  const me = await requireStaff(ctx);
  if (!me) return;
  const v = await ownConversationView(me, parseId(idStr));
  if (!v) return denyConversation(ctx);
  const [client, counts] = await Promise.all([
    getClient(v.client_id),
    db()<{ total: number; from_client: number; first_at: Date | null }[]>`
      select count(*)::int as total,
             count(*) filter (where sender = 'client')::int as from_client,
             min(created_at) as first_at
      from messages where conversation_id = ${v.id}`,
  ]);
  const c = counts[0] ?? { total: 0, from_client: 0, first_at: null };
  const name = clientNameOf(v);
  const lines = [
    'ℹ️ <b>Mijoz haqida</b>',
    '',
    `👤 Ism: <b>${esc(name)}</b>`,
    `🔗 Username: ${v.client_username ? '@' + esc(v.client_username) : '—'}`,
    `🆔 Telegram ID: <code>${v.client_id}</code>`,
  ];
  if (client?.language_code) lines.push(`🌐 Til: ${esc(client.language_code)}`);
  lines.push(
    `📅 Birinchi murojaat: ${esc(formatTime(c.first_at ?? v.created_at))}`,
    `🕐 Oxirgi xabar: ${v.last_message_at ? esc(formatTime(v.last_message_at)) : '—'}`,
    `✉️ Xabarlar: <b>${c.total}</b> (mijozdan: ${c.from_client})`,
  );
  if (client?.bot_blocked) lines.push('', '⚠️ Mijoz botni bloklagan — xabarlaringiz yetkazilmaydi.');

  // `act:<id>` — bu kartani ham shu suhbatga bog'laydi (unga Reply qilinsa, xabar shu mijozga boradi)
  const kb = new InlineKeyboard()
    .text('💬 Suhbatni ochish', `open:${v.id}`)
    .text('✍️ Yozish', `act:${v.id}`)
    .row()
    .text('💬 Chatlar', 'chats:0');
  await ctx.answerCallbackQuery();
  await sendHtml(ctx, lines.join('\n'), { markup: kb });
}

async function onActivate(ctx: StaffContext, idStr: string | undefined): Promise<void> {
  const me = await requireStaff(ctx);
  if (!me) return;
  const v = await ownConversationView(me, parseId(idStr));
  if (!v) return denyConversation(ctx);
  await setStaffActiveConversation(me.id, v.id);
  await markReadByStaff(v.id);
  ctx.staff = { ...me, active_conversation_id: v.id };
  await ctx.answerCallbackQuery({ text: '✍️ Endi javobingiz shu mijozga boradi' });
  const text = me.is_active
    ? `✍️ Aktiv suhbat: <b>${esc(clientNameOf(v))}</b>\nXabaringizni yozing.`
    : `✍️ Aktiv suhbat: <b>${esc(clientNameOf(v))}</b>\n\n${esc(INACTIVE_TEXT)}`;
  await sendHtml(ctx, text, {
    replyTo: callbackMessage(ctx)?.message_id,
    markup: deactButton(new InlineKeyboard().text('ℹ️ Mijoz haqida', `cinfo:${v.id}`), v.id),
  });
}

/** `deact:<id>` (bildirishnoma ostidan) yoki `deact:<id>:<sahifa>` (chatlar ro'yxatidan): aktiv suhbatni yopish. */
async function onDeactivate(ctx: StaffContext, idStr: string | undefined, pageStr: string | undefined): Promise<void> {
  const me = await requireStaff(ctx);
  if (!me) return;
  const v = await ownConversationView(me, parseId(idStr));
  if (!v) return denyConversation(ctx);
  const closed = await clearActiveIf(me.id, v.id);
  if (closed || me.active_conversation_id === v.id) ctx.staff = { ...me, active_conversation_id: null };
  await ctx.answerCallbackQuery({
    text: closed ? '✖️ Aktiv suhbat yopildi' : 'ℹ️ Bu suhbat allaqachon aktiv emas',
  });

  if (pageStr !== undefined) {
    await render(ctx, await chatsView(ctx.staff!, Number(pageStr)), 'edit');
    return;
  }
  const msg = callbackMessage(ctx);
  if (!msg) return;
  if (!closed) {
    // Bu suhbat allaqachon aktiv emas (boshqasi tanlangan) — eskirgan tugmani olib tashlaymiz, xolos
    await stripKeyboard(ctx, msg.message_id);
    return;
  }
  const text =
    `✖️ <b>${esc(clientNameOf(v))}</b> bilan aktiv suhbat yopildi.\n` +
    'Yozish uchun mijoz xabariga <b>Reply</b> qiling yoki «↩️ Javob berish» tugmasini bosing.';
  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  } catch (e) {
    if (!isNotModified(e)) await stripKeyboard(ctx, msg.message_id);
  }
}

// ── 🔄 Holat ──

async function toggleStatus(ctx: StaffContext): Promise<void> {
  const me = await requireStaff(ctx);
  if (!me) return;
  const updated = await updateStaff(me.id, { is_online: !me.is_online });
  if (!updated) {
    await sendHtml(ctx, ERROR_TEXT);
    return;
  }
  ctx.staff = updated;
  const text = updated.is_online
    ? '🟢 Siz endi <b>onlayn</b>siz — mijozlar buni ko\'radi.'
    : '⚪️ Siz endi <b>oflayn</b>siz — avto-javobga «hozir ish joyida emas» qo\'shiladi.';
  // Holat allaqachon almashgan: «qayta urinib ko'ring» bo'yicha qayta bosish uni ortga qaytarib yuborardi
  await afterSuccess('holat tasdig\'i', () => sendHtml(ctx, text, { markup: mainKeyboard(updated, ctx.admin) }));
}

// ── 👤 Profilim ──

async function showProfile(ctx: StaffContext): Promise<void> {
  const me = await requireStaff(ctx);
  if (!me) return;
  const [counts, greeting, clientLink] = await Promise.all([
    db()<{ chats: number; unread: number }[]>`
      select count(*) filter (where last_message_at is not null)::int as chats,
             coalesce(sum(unread_staff), 0)::int as unread
      from conversations where staff_id = ${me.id}`,
    greetingText(me, { first_name: '' }),
    clientLinkOf(me),
  ]);
  const stats = counts[0] ?? { chats: 0, unread: 0 };

  const build = (descMax: number, greetMax: number): string => {
    const lines = [
      `${roleIcon(me.role)} <b>${esc(me.full_name)}</b>`,
      `${roleLabel(me.role)}${me.position ? ' · ' + esc(me.position) : ''}`,
    ];
    if (me.description) lines.push('', esc(truncate(me.description, descMax)));
    lines.push(
      '',
      me.is_online ? '🟢 Holat: <b>onlayn</b>' : '⚪️ Holat: <b>oflayn</b>',
      me.is_active
        ? '✅ Profil faol — mijozlar sizni menyuda ko\'radi'
        : "🚫 Profil bloklangan — mijozlar sizni ko'rmaydi, siz ham ularga yoza olmaysiz",
      `💬 Chatlar: <b>${stats.chats}</b>${stats.unread ? ` (o'qilmagan: ${stats.unread})` : ''}`,
    );
    if (clientLink) {
      lines.push(
        '',
        `🔗 Mijozlar uchun havolangiz: ${esc(clientLink)}`,
        me.is_active
          ? "Mijoz shu havola orqali kirsa, darhol siz bilan chat boshlanadi."
          : 'Profilingiz blokdan chiqarilgach ishlaydi.',
      );
    }
    lines.push(
      '',
      `🤖 <b>Avto-javob</b> ${me.greeting ? '(shaxsiy)' : '(standart)'}:`,
      `<blockquote>${esc(truncate(greeting, greetMax))}</blockquote>`,
      '',
      'ℹ️ Profilni admin tahrirlaydi.',
    );
    return lines.join('\n');
  };

  const kb = new InlineKeyboard();
  if (clientLink) kb.copyText('📋 Nusxalash', clientLink).url('📤 Ulashish', shareUrl(clientLink)).row();
  // `:n` — profil kartasi (rasm) chatlar ro'yxatiga almashtirilib, o'chib ketmasin
  kb.text('💬 Chatlar', 'chats:0:n');
  const fullText = build(700, 1200);
  if (me.photo_file_id) {
    let caption = build(300, 300);
    if (caption.length > CAPTION_LIMIT) caption = build(120, 120);
    if (caption.length <= CAPTION_LIMIT) {
      await render(ctx, { text: fullText, keyboard: kb, photo: { fileId: me.photo_file_id, caption } }, 'new');
      return;
    }
  }
  await sendHtml(ctx, fullText, { markup: kb });
}

// ── ℹ️ Yordam ──

async function showHelp(ctx: StaffContext): Promise<void> {
  const [url, clientLink] = await Promise.all([getWebAppUrl(), ctx.staff ? clientLinkOf(ctx.staff) : Promise.resolve('')]);
  const parts: string[] = [];
  if (ctx.staff) {
    parts.push(
      'ℹ️ <b>Bot qanday ishlaydi?</b>',
      '',
      '📩 Mijozlar sizga mijozlar boti orqali yozadi — xabarlari shu yerga keladi. Har bir xabar tepasida mijoz ismi bo\'ladi, yangi mijoz esa 🆕 bilan belgilanadi.',
      '',
      '🔗 <b>Shaxsiy havolangiz</b>' + (clientLink ? `: ${esc(clientLink)}` : ` — «${BTN.profile}» da.`),
      `Uni mijozlarga bering: havola orqali kirgan mijoz hech narsa tanlamasdan darhol siz bilan yozishadi. Nusxalash va ulashish — «${BTN.profile}».`,
      '',
      '✍️ <b>Javob berishning 3 usuli:</b>',
      '1. Mijoz xabariga <b>Reply</b> (javob) qiling — eng ishonchli usul;',
      '2. Xabar ostidagi «↩️ Javob berish» tugmasini bosing — keyingi barcha xabarlaringiz shu mijozga boradi;',
      `3. «${BTN.chats}» dan suhbatni oching — u aktiv bo'ladi.`,
      '',
      '🔒 Xabar adashib boshqa mijozga ketmasligi uchun: Reply qilingan xabar kimniki ekanini aniqlab bo\'lmasa yoki aktiv suhbatdan keyin boshqa mijoz yozgan bo\'lsa, bot «❓ Bu xabar kimga?» deb so\'raydi — mijozni tanlasangiz, xabar o\'shanga yuboriladi.',
      `✖️ Aktiv suhbatni «${BTN.chats}» dagi «✖️ Aktivni yopish» tugmasi yoki /cancel bilan yopasiz.`,
      '',
      '📎 Matn, rasm, video, fayl, ovozli xabar, stiker, joylashuv va kontakt yuborish mumkin. Yetkazilgan xabarga 👍 qo\'yiladi.',
      '✏️ Yuborilgan matn yoki izohni tahrirlasangiz, mijozdagi nusxasi ham yangilanadi (✍ belgisi qo\'yiladi). Yangilab bo\'lmasa, bot bu haqda yozadi.',
      '',
      `${BTN.status} — onlayn/oflayn. Oflayn bo'lsangiz, mijozga boradigan avto-javobga «hozir ish joyida emas» izohi qo'shiladi.`,
      '',
      url
        ? '📱 <b>Mini App</b> — pastdagi «💬 Chatlar» menyu tugmasi orqali barcha suhbatlarni Telegramdagidek qulay ko\'rinishda ochasiz.'
        : '📱 <b>Mini App</b> — menyu tugmasi orqali barcha suhbatlarni qulay ko\'rinishda ochish mumkin.',
      '',
      '🔒 Suhbatlaringizni faqat siz ko\'rasiz — boshqa xodimlar va adminlar ularni ko\'ra olmaydi. Mijoz siz ustingizdan shikoyat qilsa, rahbar (ROP) o\'sha suhbatni ko\'rib chiqishi mumkin.',
      '',
      'Buyruqlar: /chats, /status, /profile, /cancel, /help',
    );
  } else {
    const role = ctx.panelRole;
    parts.push(
      `ℹ️ <b>Qisqa yo'riqnoma</b> · ${role ? ROLE_TITLES[role] : ROLE_TITLES.admin}`,
      '',
      `1. «${BTN.admin}» → «➕ Xodim qo'shish»: rol, ism, lavozim, tavsif, avto-javob va rasmni kiriting.`,
      '2. Xodim kartasidagi taklif havolasini o\'sha xodimga yuboring — u havolani bosib, Telegram akkauntini ulaydi.',
      '3. Ulangan va faol xodimlarni mijozlar menyuda ko\'radi va ular bilan yozishadi.',
      "4. Xodim kartasida «🚫 Bloklash» — mijozlar uni ko'rmaydi va u mijozlarga yoza olmaydi; «🗑 O'chirish» — ro'yxatdan butunlay olib tashlash.",
      '',
      '🔗 Har bir xodimning <b>mijozlar uchun shaxsiy havolasi</b> bor (kartada): mijoz shu havola orqali kirsa, hech narsa tanlamasdan darhol o\'sha xodim bilan chat boshlanadi. Nomini «✏️ Havola nomi» tugmasi bilan o\'zgartirasiz.',
    );
    if (can(role, 'broadcast')) {
      parts.push(
        '',
        "📣 «Mijozlarga xabar» — barcha mijozlarga bot orqali xabar (matn, rasm, video, fayl...). Yuborishdan oldin ko'rinishi ko'rsatiladi.",
      );
    }
    if (can(role, 'complaints')) {
      parts.push(
        '',
        "⚠️ «Shikoyatlar» — mijozlarning xodimlar ustidan shikoyatlari: shikoyat qilingan suhbatni o'qish va «hal qilindi» deb belgilash.",
      );
    }
    if (can(role, 'developer')) {
      parts.push('', "🛠 «Developer panel» — admin va ROP larni Telegram ID orqali qo'shish/olib tashlash, tizim holati.");
    }
    parts.push(
      '',
      can(role, 'complaints')
        ? "🔒 Mijoz va xodim o'rtasidagi yozishmalar maxfiy — ularni faqat o'sha xodim ko'radi (ROP — faqat shikoyat qilingan suhbatni)."
        : "🔒 Mijoz va xodim o'rtasidagi yozishmalar maxfiy — ularni faqat o'sha xodim ko'radi.",
      '',
      'Buyruqlar: /admin, /cancel, /help',
    );
  }
  if (ctx.staff && ctx.panelRole) {
    const extras: string[] = [];
    if (can(ctx.panelRole, 'broadcast')) extras.push('mijozlarga xabar');
    if (can(ctx.panelRole, 'complaints')) extras.push('shikoyatlar');
    const extra = extras.length ? `, ${extras.join(' va ')}` : '';
    parts.push(
      '',
      `⚙️ <b>${ROLE_TITLES[ctx.panelRole]}</b>: «${BTN.admin}» — xodimlarni qo'shish/tahrirlash/bloklash, taklif va mijoz havolalari, matnlar, statistika${extra}.`,
    );
  }
  await sendHtml(ctx, parts.join('\n'), { markup: mainKeyboard(ctx.staff, ctx.admin) });
}

// ───────────────────────────── Xodim xabarlarini mijozga yo'naltirish ─────────────────────────────

/** Foydalanuvchi yuboradigan, lekin qo'llab-quvvatlanmaydigan xabar turlari (xizmat xabarlari emas). */
const UNSUPPORTED_USER_KINDS = ['poll', 'dice', 'game', 'story', 'invoice', 'paid_media', 'giveaway', 'checklist'];

/**
 * Xodim xabarini mijozga yo'naltirish. Maxfiylik qoidasi: xabar faqat aniq ma'lum mijozga ketadi.
 *  - Reply: xabar qaysi suhbatga tegishli ekani aniqlansa — o'sha suhbat; aniqlanmasa — HECH QACHON aktiv
 *    suhbatga taxminan yuborilmaydi, «Bu xabar kimga?» so'raladi.
 *  - Reply'siz: aktiv suhbat, lekin undan keyin boshqa mijoz yozgan bo'lsa — yana so'raladi.
 */
async function routeStaffMessage(ctx: StaffContext): Promise<void> {
  const msg = ctx.message as TgMessage;
  const chatId = ctx.chat!.id;

  if (isCommandMessage(msg)) {
    await sendHtml(ctx, "❓ Noma'lum buyruq. Yordam uchun /help ni bosing.", { replyTo: msg.message_id });
    return;
  }

  const content = extractContent(msg);
  if (!content) {
    const userKind = UNSUPPORTED_USER_KINDS.some((k) => k in msg);
    if (userKind) await sendHtml(ctx, "⚠️ Bu turdagi xabarni yuborib bo'lmaydi", { replyTo: msg.message_id });
    // Xizmat xabarlari (masalan, pin) — jimgina e'tiborsiz
    return;
  }

  const me = ctx.staff;
  if (!me) {
    await sendHtml(
      ctx,
      "ℹ️ Siz xodim profiliga ulanmagansiz, shuning uchun xabarlaringiz mijozlarga yuborilmaydi.\n\n" +
        `⚙️ Xodimlarni boshqarish uchun «${BTN.admin}» tugmasini bosing.`,
      { markup: mainKeyboard(null, ctx.admin) },
    );
    return;
  }
  // O'chirib qo'yilgan xodim mijozlarga yoza olmaydi (mijozlar ham unga yoza olmaydi — ikki tomon bir xil)
  if (!me.is_active) {
    await sendHtml(ctx, esc(INACTIVE_TEXT), { replyTo: msg.message_id });
    return;
  }

  let conversation: Conversation;
  let previousActive: number | null = null;
  const replyTo = msg.reply_to_message;
  if (replyTo) {
    const found = await resolveReplyConversation(me, chatId, ctx.me.id, replyTo);
    if (!found) {
      await askRecipient(ctx, me, msg, 'unknown_reply', await ownActiveConversation(me));
      return;
    }
    conversation = found;
    if (me.active_conversation_id !== found.id) {
      previousActive = me.active_conversation_id;
      await setStaffActiveConversation(me.id, found.id);
      ctx.staff = { ...me, active_conversation_id: found.id };
    }
  } else {
    const active = await ownActiveConversation(me);
    if (!active) {
      await askRecipient(ctx, me, msg, 'none', null);
      return;
    }
    const waiting = await newerWaitingConversations(me, active.id);
    if (waiting.length) {
      await askRecipient(ctx, me, msg, 'ambiguous', active, waiting);
      return;
    }
    conversation = active;
  }

  const res = await relayStaffMessage({
    staff: me,
    conversation,
    content,
    staffChatId: chatId,
    staffMsgId: msg.message_id,
    via: 'bot',
    // Mijozda ham javob sifatida (iqtibos bilan) ko'rinsin — Telegramdagidek
    ...(replyTo ? { replyToStaffMsgId: replyTo.message_id } : {}),
  });
  // react() o'zi eng yaxshi urinish (xatolarni yutadi)
  if (res.ok) await react('staff', chatId, msg.message_id, '👍');
  else await sendHtml(ctx, esc(relayFailureText(res)), { replyTo: msg.message_id, markup: retryMarkup(res) });

  // Reply aktiv suhbatni boshqa mijozga almashtirdi — xodim buni aniq ko'rsin. Eng yaxshi urinish: xabar mijozga
  // allaqachon yetkazilgan bo'lishi mumkin — bu izoh yuborilmasa (429/5xx/timeout), xodimga «⚠️ Xatolik… qayta
  // urinib ko'ring» ko'rsatilmaydi (aks holda u javobni qayta yuboradi va mijoz uni ikki marta oladi).
  if (previousActive != null) {
    await afterSuccess("«🔁 Endi Reply'siz…» izohi", async () => {
      const v = await ownConversationView(me, conversation.id);
      if (!v) return;
      await sendHtml(ctx, `🔁 Endi Reply'siz xabarlaringiz <b>${esc(clientNameOf(v))}</b>${dativeSuffix(clientNameOf(v))} yuboriladi.`, {
        markup: deactButton(new InlineKeyboard(), v.id),
      });
    });
  }
}

type AskReason = 'none' | 'unknown_reply' | 'ambiguous';

/**
 * «Bu xabar kimga?» — xabar hech kimga yuborilmaydi; xodim tanlagan mijozga `to:<id>` tugmasi orqali ketadi.
 * So'rov xodim xabariga Reply sifatida yuboriladi — tugma bosilganda asl xabar `reply_to_message` dan olinadi
 * (hech narsa saqlanmaydi).
 */
async function askRecipient(
  ctx: StaffContext,
  me: Staff,
  msg: TgMessage,
  reason: AskReason,
  active: ConversationView | null,
  waiting: RecipientCandidate[] = [],
): Promise<void> {
  let candidates: RecipientCandidate[];
  if (reason === 'ambiguous' && active) {
    candidates = [candidateOf(active), ...waiting];
  } else {
    const recent = await recentCandidates(me, 5);
    candidates = active && !recent.some((r) => r.id === active.id) ? [candidateOf(active), ...recent.slice(0, 4)] : recent;
  }

  const waitingIds = new Set(waiting.map((w) => w.id));
  const kb = new InlineKeyboard();
  for (const c of candidates) {
    const mark = active && c.id === active.id ? '✍️ ' : waitingIds.has(c.id) ? '🆕 ' : c.unread > 0 ? '🔴 ' : '👤 ';
    const preview = oneLine(c.preview, 22);
    kb.text(`${mark}${oneLine(c.name, 24)}${preview ? ' · ' + preview : ''}`, `to:${c.id}`).row();
  }
  kb.text('💬 Chatlar', 'chats:0:n');

  let text: string;
  if (reason === 'ambiguous' && active) {
    const others = waiting.map((w) => `<b>${esc(oneLine(w.name, 40))}</b>`).join(', ');
    text =
      '❓ <b>Bu xabar kimga?</b>\n\n' +
      `Aktiv suhbat — <b>${esc(oneLine(clientNameOf(active), 40))}</b>, lekin undan keyin ${others} ham yozdi. ` +
      'Xabar adashib ketmasligi uchun u hali hech kimga yuborilmadi.\n\n' +
      'Qabul qiluvchini tanlang 👇\n' +
      '<i>💡 Aniq mijozga yozish uchun uning xabariga Reply qiling.</i>';
  } else if (reason === 'unknown_reply') {
    text =
      '❓ <b>Bu xabar kimga?</b>\n\n' +
      "Siz javob bergan xabar qaysi mijozga tegishli ekanini aniqlab bo'lmadi, shuning uchun xabar hech kimga yuborilmadi.\n\n" +
      (candidates.length ? 'Qabul qiluvchini tanlang 👇 yoki ' : '') +
      'mijozning «↩️ Javob berish» tugmali xabariga Reply qiling.';
  } else {
    text =
      '❓ Kimga javob berayotganingizni tanlang: mijoz xabariga <b>Reply</b> qiling yoki «↩️ Javob berish» tugmasini bosing.' +
      (candidates.length ? '\n\nYoki shu xabar kimga yuborilishini tanlang 👇' : '');
  }
  await sendHtml(ctx, text, { replyTo: msg.message_id, markup: kb });
}

/** «Bu xabar kimga?» so'rovidagi (yoki admin ogohlantirishidagi) tanlov: asl xabarni shu mijozga yuborish. */
async function onSendTo(ctx: StaffContext, idStr: string | undefined): Promise<void> {
  const me = await requireStaff(ctx);
  if (!me) return;
  const v = await ownConversationView(me, parseId(idStr));
  if (!v) return denyConversation(ctx);
  if (!me.is_active) {
    await ctx.answerCallbackQuery({ text: INACTIVE_TEXT, show_alert: true });
    return;
  }
  const prompt = callbackMessage(ctx);
  const orig = prompt?.reply_to_message as TgMessage | undefined;
  const chatId = ctx.chat!.id;
  if (!prompt || !orig || orig.from?.id !== ctx.from!.id) {
    await ctx.answerCallbackQuery({
      text: "⚠️ Asl xabar topilmadi (o'chirilgan bo'lishi mumkin). Xabarni qayta yuboring.",
      show_alert: true,
    });
    if (prompt) await stripKeyboard(ctx, prompt.message_id);
    return;
  }
  const rawName = oneLine(clientNameOf(v), 64);
  const name = esc(rawName);
  if (await relayedStaffMessageExists(me.id, chatId, orig.message_id)) {
    await ctx.answerCallbackQuery({ text: 'ℹ️ Bu xabar allaqachon yuborilgan' });
    await stripKeyboard(ctx, prompt.message_id);
    return;
  }
  const content = extractContent(orig);
  if (!content) {
    await ctx.answerCallbackQuery({ text: "⚠️ Bu turdagi xabarni yuborib bo'lmaydi", show_alert: true });
    await stripKeyboard(ctx, prompt.message_id);
    return;
  }

  // Da'vo: ikki marta bosilganda xabar ikki marta ketmasin — so'rovni birinchi tahrirlagan yutadi,
  // ikkinchisi Telegramdan "message is not modified" oladi.
  try {
    await ctx.editMessageText('⏳ Yuborilmoqda…');
  } catch (e) {
    if (isNotModified(e)) {
      await ctx.answerCallbackQuery({ text: '⏳ Yuborilmoqda…' });
      return;
    }
  }

  let res: Awaited<ReturnType<typeof relayStaffMessage>>;
  try {
    if (me.active_conversation_id !== v.id) {
      await setStaffActiveConversation(me.id, v.id);
      ctx.staff = { ...me, active_conversation_id: v.id };
    }
    res = await relayStaffMessage({
      staff: me,
      conversation: v,
      content,
      staffChatId: chatId,
      staffMsgId: orig.message_id,
      via: 'bot',
    });
  } catch (e) {
    logError('to: yuborish xatosi', e);
    // So'rovni tugmalari bilan qaytaramiz — xodim qayta tanlay oladi
    await ctx.api
      .editMessageText(chatId, prompt.message_id, prompt.text ?? '❓ Bu xabar kimga?', {
        ...(prompt.entities ? { entities: prompt.entities } : {}),
        ...(prompt.reply_markup ? { reply_markup: prompt.reply_markup } : {}),
      })
      .catch(() => {});
    await ctx.answerCallbackQuery({ text: ERROR_TEXT, show_alert: true });
    return;
  }

  if (res.ok) {
    await react('staff', chatId, orig.message_id, '👍');
    await ctx.answerCallbackQuery({ text: '✅ Yuborildi' });
    // Tugma tasdiqni shu suhbatga bog'laydi: unga Reply qilinsa ham xabar aynan shu mijozga boradi
    await editPrompt(
      ctx,
      `✅ <b>${name}</b>${dativeSuffix(rawName)} yuborildi — endi aktiv suhbat shu mijoz bilan.`,
      orig.message_id,
      deactButton(new InlineKeyboard(), v.id),
    );
    return;
  }
  const errText = relayFailureText(res);
  await ctx.answerCallbackQuery({ text: truncate(errText, 190), show_alert: true });
  await editPrompt(ctx, esc(errText), orig.message_id, retryMarkup(res));
}

type RelayFailure = Extract<RelayResult, { ok: false }>;

function relayFailureText(res: RelayFailure): string {
  return relayErrorText(res.error, { saved: !!res.message });
}

/** Xabar saqlangan, lekin yetkazilmagan bo'lsa — «🔁 Qayta yuborish» tugmasi (yangi yozuv yaratmaydi). */
function retryMarkup(res: RelayFailure): InlineKeyboard | undefined {
  if (!res.message || (res.error !== 'send_failed' && res.error !== 'client_blocked')) return undefined;
  return new InlineKeyboard().text('🔁 Qayta yuborish', `retry:${res.message.id}`);
}

/** `retry:<messageId>` — saqlangan, lekin yetkazilmagan o'z xabarini mijozga qayta yuborish. */
async function onRetry(ctx: StaffContext, idStr: string | undefined): Promise<void> {
  const me = await requireStaff(ctx);
  if (!me) return;
  if (!me.is_active) {
    await ctx.answerCallbackQuery({ text: INACTIVE_TEXT, show_alert: true });
    return;
  }
  const id = parseId(idStr);
  // retryDelivery egalikni tekshiradi: faqat shu xodimning suhbatidagi o'z xabari
  const res = id ? await retryDelivery({ role: 'staff', staff: me }, id) : null;
  if (!res || (!res.ok && res.error === 'forbidden')) {
    await ctx.answerCallbackQuery({ text: "⛔ Xabar topilmadi yoki sizga tegishli emas", show_alert: true });
    return;
  }
  if (!res.ok || !res.delivered) {
    const text = res.ok ? relayErrorText('send_failed', { saved: true }) : relayFailureText(res);
    await ctx.answerCallbackQuery({ text: truncate(text, 190), show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery({ text: '✅ Yetkazildi' });
  const m = res.message;
  if (m.staff_chat_msg_id && m.staff_chat_id === ctx.chat!.id) await react('staff', ctx.chat!.id, m.staff_chat_msg_id, '👍');
  try {
    await ctx.editMessageText('✅ Xabar mijozga yetkazildi.');
  } catch (e) {
    if (!isNotModified(e)) {
      const cm = callbackMessage(ctx);
      if (cm) await stripKeyboard(ctx, cm.message_id);
    }
  }
}

/**
 * So'rov xabarini yakuniy natija bilan almashtirish; tahrirlab bo'lmasa — yangi xabar. Eng yaxshi urinish: natija
 * (✅ yuborildi / xato matni) callback javobida allaqachon ko'rsatilgan, xabar esa mijozga yetkazilgan bo'lishi
 * mumkin — bu yerdagi xato «⚠️ Xatolik… qayta urinib ko'ring» ga aylanmasligi kerak.
 */
async function editPrompt(ctx: StaffContext, html: string, replyTo: number, markup?: InlineKeyboard): Promise<void> {
  try {
    await ctx.editMessageText(html, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...(markup ? { reply_markup: markup } : {}),
    });
  } catch (e) {
    if (isNotModified(e)) return;
    console.warn('[staff] so\'rovni tahrirlab bo\'lmadi:', tgErrorDescription(e));
    await afterSuccess("«Bu xabar kimga?» natijasi", () => sendHtml(ctx, html, { replyTo, ...(markup ? { markup } : {}) }));
  }
}

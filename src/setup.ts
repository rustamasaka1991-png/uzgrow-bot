// Bir martalik sozlash: bazani yaratish, webhooklarni o'rnatish, buyruqlar va Mini App menyu tugmalari.
import { webhookSecretFor } from './auth.js';
import { config } from './config.js';
import { db } from './db.js';
import { setSetting } from './repo.js';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';
import { SETTING_KEYS } from './texts.js';
import type { Api } from 'grammy';
import { apiFor } from './tg.js';
import type { BotKind } from './types.js';
import { tgErrorDescription } from './util.js';

/** Parallel migratsiyalar (bir nechta Vercel instansiyasi) bir-birini kutishi uchun advisory lock kaliti. */
const MIGRATION_LOCK_KEY = 7_311_902_451;
const SCHEMA_VERSION_KEY = 'schema_version';

/** Idempotent migratsiya (bir vaqtda faqat bittasi) + sxema versiyasini yozish. */
export async function migrate(): Promise<void> {
  const sql = db();
  await sql.begin(async (tx) => {
    const t = tx as unknown as typeof sql;
    await t`select pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`;
    await t.unsafe(SCHEMA_SQL);
    await t`
      insert into settings (key, value, updated_at) values (${SCHEMA_VERSION_KEY}, ${SCHEMA_VERSION}, now())
      on conflict (key) do update set value = excluded.value, updated_at = now()`;
  });
}

let schemaReady: Promise<void> | null = null;

/**
 * Baza sxemasi joriy kod versiyasiga mos ekanini kafolatlash (har bir instansiyada bir marta, arzon tekshiruv).
 * Yangi kod migratsiyadan oldin deploy qilinib qolsa, yangi ustunlar/jadvallar yo'qligi sababli xabarlar
 * yo'qolmasligi uchun migratsiya shu yerda avtomatik bajariladi. Xato bo'lsa keyingi chaqiruvda qayta uriniladi.
 */
export function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    const p = (async () => {
      const sql = db();
      const rows = await sql<{ current: boolean }[]>`
        select exists (
          select 1 from settings where key = ${SCHEMA_VERSION_KEY} and value = ${SCHEMA_VERSION}
        ) as current`;
      if (rows[0]?.current) return;
      console.warn(`[schema] baza sxemasi eski — migratsiya bajarilmoqda (${SCHEMA_VERSION})`);
      await migrate();
    })();
    schemaReady = p;
    p.catch(() => {
      if (schemaReady === p) schemaReady = null;
    });
  }
  return schemaReady;
}

/**
 * Telegram yuboradigan update turlari. `edited_message` — mijoz/xodim xabarini tahrirlasa, ikkinchi tomondagi
 * nusxa ham yangilanadi. Ro'yxat Telegram tomonida setWebhook bilan saqlanadi — o'zgarsa setup qayta ishga
 * tushirilishi kerak.
 */
export const ALLOWED_UPDATES = ['message', 'edited_message', 'callback_query', 'my_chat_member'] as const;

const CLIENT_COMMANDS = [
  { command: 'start', description: 'Botni ishga tushirish' },
  { command: 'menu', description: 'Asosiy menyu' },
  { command: 'operators', description: '👨‍💻 Operatorlar' },
  { command: 'managers', description: '👔 Menejerlar' },
  { command: 'chats', description: '💬 Suhbatlarim' },
  { command: 'help', description: 'ℹ️ Yordam' },
];

/** Xodimlar botining umumiy buyruqlari (hamma uchun). */
export const STAFF_COMMANDS = [
  { command: 'start', description: 'Botni ishga tushirish' },
  { command: 'chats', description: '💬 Chatlar' },
  { command: 'status', description: '🟢 Onlayn / oflayn' },
  { command: 'profile', description: '👤 Profilim' },
  { command: 'cancel', description: '✖️ Bekor qilish' },
  { command: 'help', description: 'ℹ️ Yordam' },
];

/** Adminlar uchun (faqat ularning chatida ko'rinadi): umumiy buyruqlar + /admin. */
export const STAFF_ADMIN_COMMANDS = [
  STAFF_COMMANDS[0]!,
  { command: 'admin', description: '⚙️ Admin panel' },
  ...STAFF_COMMANDS.slice(1),
];

/** Admin chatiga /admin buyrug'i bilan menyu o'rnatish (admin botni hali boshlamagan bo'lsa xato beradi). */
export async function setAdminCommands(api: Api, adminId: number): Promise<void> {
  await api.setMyCommands(STAFF_ADMIN_COMMANDS, { scope: { type: 'chat', chat_id: adminId } });
}

/** Telegram tomonidagi webhook holati (xatolarni darhol ko'rish uchun). */
export interface WebhookStatus {
  url: string;
  pending_update_count: number;
  last_error_message?: string;
  /** ISO vaqt */
  last_error_date?: string;
  allowed_updates?: string[];
}

export interface BotSetupResult {
  username?: string;
  webhook?: string;
  ok: boolean;
  error?: string;
  /** setWebhook dan keyingi getWebhookInfo (yoki ?info=1 rejimida joriy holat). */
  info?: WebhookStatus;
}

export interface SetupReport {
  appUrl: string;
  migrated: boolean;
  bots: Partial<Record<BotKind, BotSetupResult>>;
  /** Xato emas, lekin e'tibor talab qiladigan holatlar (masalan, production bo'lmagan domen). */
  warnings?: string[];
}

export interface SetupOptions {
  /**
   * O'rnatishdan oldin `${appUrl}/api/<bot>` ga GET so'rov yuborib, u haqiqatan shu ilova ekanini va ochiq
   * (Vercel Deployment Protection / 401 / redirect yo'q) ekanini tekshirish. Standart: haqiqiy Telegram bilan
   * ishlaganda yoqilgan (testlarda soxta server — o'chirilgan).
   */
  probe?: boolean;
  warnings?: string[];
}

const BOT_PATH: Record<BotKind, string> = { client: 'client-bot', staff: 'staff-bot' };

/**
 * Webhook manzili haqiqatan shu ilovaga olib boradimi: GET → 200 {ok:true, bot:<kind>}.
 * Vercel himoyasi (401/403), yo'naltirish (3xx) yoki boshqa sayt — xato matni qaytadi.
 */
export async function probeWebhookUrl(appUrl: string, kind: BotKind): Promise<string | null> {
  const url = `${appUrl}/api/${BOT_PATH[kind]}`;
  let res: Response;
  try {
    res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } });
  } catch (e) {
    return `${url} ga ulanib bo'lmadi (${e instanceof Error ? e.message : String(e)})`;
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* JSON emas */
  }
  const b = body as { ok?: unknown; bot?: unknown } | null;
  if (res.status === 200 && b?.ok === true && b.bot === kind) return null;
  if (res.status === 401 || res.status === 403) {
    return `${url} himoyalangan (HTTP ${res.status}) — Vercel Deployment Protection yoqilgan bo'lishi mumkin. Production domenini ishlating.`;
  }
  if (res.status >= 300 && res.status < 400) {
    return `${url} boshqa manzilga yo'naltiradi (HTTP ${res.status}) — Telegram yo'naltirishga ergashmaydi. To'g'ridan-to'g'ri domenni ko'rsating.`;
  }
  return `${url} bu ilovaga o'xshamaydi (HTTP ${res.status}) — manzil noto'g'ri.`;
}

export async function webhookStatus(kind: BotKind): Promise<WebhookStatus | undefined> {
  const api = apiFor(kind);
  if (!api) return undefined;
  try {
    const info = await api.getWebhookInfo();
    return {
      url: info.url ?? '',
      pending_update_count: info.pending_update_count,
      ...(info.last_error_message ? { last_error_message: info.last_error_message } : {}),
      ...(info.last_error_date ? { last_error_date: new Date(info.last_error_date * 1000).toISOString() } : {}),
      ...(info.allowed_updates ? { allowed_updates: info.allowed_updates } : {}),
    };
  } catch (e) {
    console.warn(`[setup] ${kind} getWebhookInfo:`, tgErrorDescription(e));
    return undefined;
  }
}

async function setupBot(kind: BotKind, appUrl: string): Promise<BotSetupResult> {
  const api = apiFor(kind);
  if (!api) return { ok: false, error: 'Token berilmagan (STAFF_BOT_TOKEN)' };
  try {
    const me = await api.getMe();
    await setSetting(kind === 'client' ? 'client_bot_username' : 'staff_bot_username', me.username ?? '');
    const webhook = `${appUrl}/api/${BOT_PATH[kind]}`;
    await api.setWebhook(webhook, {
      secret_token: webhookSecretFor(kind),
      allowed_updates: [...ALLOWED_UPDATES],
      max_connections: 40,
    });
    await api.setMyCommands(kind === 'client' ? CLIENT_COMMANDS : STAFF_COMMANDS);
    if (kind === 'staff') {
      // Admin botni hali ochmagan bo'lsa ("chat not found") — /start bosganda o'rnatiladi
      for (const id of config.adminIds) await setAdminCommands(api, id).catch(() => {});
    }
    await api.setChatMenuButton({
      menu_button: {
        type: 'web_app',
        text: kind === 'client' ? '📱 Menyu' : '💬 Chatlar',
        web_app: { url: `${appUrl}/app/` },
      },
    });
    if (kind === 'client') {
      await api
        .setMyDescription(
          '👋 Assalomu alaykum!\n\nBu bot orqali operator va menejerlarimiz bilan to\'g\'ridan-to\'g\'ri yozishishingiz mumkin.\n\nBoshlash uchun «Start» tugmasini bosing.',
        )
        .catch(() => {});
      await api.setMyShortDescription('Operator va menejerlar bilan tezkor aloqa').catch(() => {});
    } else {
      await api
        .setMyDescription('Xodimlar uchun ish boti: mijozlar bilan barcha yozishmalar shu yerda.\n\nAdmin bergan taklif havolasi orqali kiring.')
        .catch(() => {});
      await api.setMyShortDescription('Operator va menejerlar uchun ish boti').catch(() => {});
    }
    const info = await webhookStatus(kind);
    return { ok: true, username: me.username, webhook, ...(info ? { info } : {}) };
  } catch (e) {
    return { ok: false, error: tgErrorDescription(e) };
  }
}

export async function runSetup(appUrl: string, opts: SetupOptions = {}): Promise<SetupReport> {
  const url = appUrl.replace(/\/+$/, '');
  if (!/^https:\/\//.test(url)) throw new Error(`APP_URL https:// bilan boshlanishi kerak: "${url}"`);
  const warnings = [...(opts.warnings ?? [])];
  const probe = opts.probe ?? config.usesRealTelegram;

  // Noto'g'ri/himoyalangan manzil hech qachon saqlanmasin va webhook ga yozilmasin
  if (probe) {
    const problems = (
      await Promise.all((['client', ...(config.hasStaffBot ? (['staff'] as const) : [])] as BotKind[]).map((k) => probeWebhookUrl(url, k)))
    ).filter((p): p is string => !!p);
    if (problems.length) {
      return {
        appUrl: url,
        migrated: false,
        bots: {
          client: { ok: false, error: problems.join(' ') },
          ...(config.hasStaffBot ? { staff: { ok: false, error: problems.join(' ') } } : {}),
        },
        warnings,
      };
    }
  }

  await migrate();
  await setSetting(SETTING_KEYS.appUrl, url);
  const report: SetupReport = { appUrl: url, migrated: true, bots: {} };
  report.bots.client = await setupBot('client', url);
  report.bots.staff = config.hasStaffBot ? await setupBot('staff', url) : { ok: false, error: 'STAFF_BOT_TOKEN berilmagan' };
  for (const kind of ['client', 'staff'] as const) {
    const info = report.bots[kind]?.info;
    // Faqat yaqindagi (so'nggi 1 soat) xatolar — eskisi allaqachon hal bo'lgan bo'lishi mumkin
    const recent = info?.last_error_date && Date.now() - Date.parse(info.last_error_date) < 60 * 60 * 1000;
    if (info?.last_error_message && recent) {
      warnings.push(
        `${kind === 'client' ? 'Mijozlar' : 'Xodimlar'} boti webhook oxirgi xatosi (${info.last_error_date}): ${info.last_error_message}`,
      );
    }
  }
  if (warnings.length) report.warnings = warnings;
  return report;
}

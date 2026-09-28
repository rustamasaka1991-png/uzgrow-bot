// Bir martalik sozlash (lokal kompyuterdan, .env bilan):
//   npm run setup -- https://your-app.vercel.app   → baza jadvallari + ikkala bot webhooki, buyruqlar, Mini App menyu tugmasi
//   npm run setup                                  → manzil .env dagi APP_URL dan olinadi
//   npm run setup -- --info                        → hech narsani o'zgartirmasdan botlar va webhook holatini ko'rsatish
// Muqobil (Vercel da SETUP_KEY sozlangan bo'lsa; kalit faqat sarlavhada — hech qachon URL/brauzer manzilida emas):
//   curl -X POST -H "Authorization: Bearer $SETUP_KEY" https://<domen>/api/setup
import { config } from '../src/config.js';
import { closeDb } from '../src/db.js';
import { runSetup, type SetupReport } from '../src/setup.js';
import { apiFor } from '../src/tg.js';
import type { BotKind } from '../src/types.js';
import { tgErrorDescription } from '../src/util.js';

const BOT_LABELS: Record<BotKind, string> = {
  client: '🤖 Mijozlar boti',
  staff: '👥 Xodimlar boti',
};

function usage(): void {
  console.log(`Foydalanish:
  npm run setup -- https://your-app.vercel.app   Bazani tayyorlash va botlarni ulash
  npm run setup                                  Manzil .env dagi APP_URL dan olinadi
  npm run setup -- --info                        Faqat holatni ko'rsatish (hech narsa o'zgarmaydi)`);
}

/** "my-app.vercel.app" → "https://my-app.vercel.app"; http:// va yo'l/parametrli manzillar rad etiladi. */
function normalizeAppUrl(raw: string): string {
  let s = raw.trim();
  if (!s) throw new Error('Manzil bo\'sh');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`Noto'g'ri manzil: "${raw}"`);
  }
  if (u.protocol !== 'https:') {
    throw new Error(`Manzil https:// bilan boshlanishi kerak (Telegram faqat HTTPS webhookni qabul qiladi): "${raw}"`);
  }
  if (u.search || u.hash) throw new Error(`Manzilda ?parametr yoki #qism bo'lmasligi kerak: "${raw}"`);
  if (u.username || u.password) throw new Error(`Manzilda login/parol bo'lmasligi kerak: "${raw}"`);
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.origin}${path}`;
}

function missingEnv(names: string[]): string[] {
  return names.filter((n) => !(process.env[n] ?? '').trim());
}

function printReport(report: SetupReport): void {
  console.log('');
  if (report.migrated) {
    console.log(`✅ Baza jadvallari tayyor (migratsiya bajarildi)`);
  } else {
    // runSetup manzilni tekshirib (probe) rad etgan — hech narsa o'zgartirilmagan
    console.log(`⛔ Sozlash to'xtatildi — manzil tekshiruvdan o'tmadi, baza va webhooklar o'zgartirilmadi.`);
  }
  console.log(`🌐 Ilova manzili: ${report.appUrl}`);
  console.log(`📱 Mini App:      ${report.appUrl}/app/`);
  console.log('');
  for (const kind of ['client', 'staff'] as const) {
    const r = report.bots[kind];
    if (!r) continue;
    if (r.ok) {
      console.log(`${BOT_LABELS[kind]}: ✅ @${r.username ?? '?'}`);
      console.log(`   Webhook: ${r.webhook}`);
      if (r.info) {
        const parts = [`kutilayotgan yangilanishlar: ${r.info.pending_update_count}`];
        if (r.info.allowed_updates?.length) parts.push(`turlar: ${r.info.allowed_updates.join(', ')}`);
        console.log(`   Holat: ${parts.join('; ')}`);
        if (r.info.last_error_message) {
          console.log(`   Oxirgi xato: "${r.info.last_error_message}"${r.info.last_error_date ? ` (${r.info.last_error_date})` : ''}`);
        }
      }
    } else {
      console.log(`${BOT_LABELS[kind]}: ❌ ${r.error ?? 'noma\'lum xato'}`);
    }
  }
  if (report.warnings?.length) {
    console.log('');
    for (const w of report.warnings) console.log(`⚠️  ${w}`);
  }
}

async function printWebhookStatus(kinds: BotKind[]): Promise<void> {
  for (const kind of kinds) {
    const api = apiFor(kind);
    if (!api) continue;
    try {
      const info = await api.getWebhookInfo();
      const parts = [`kutilayotgan yangilanishlar: ${info.pending_update_count}`];
      if (info.last_error_message) {
        const when = info.last_error_date ? new Date(info.last_error_date * 1000).toLocaleString('uz-UZ', { timeZone: config.timezone }) : '';
        parts.push(`oxirgi xato: "${info.last_error_message}"${when ? ` (${when})` : ''}`);
      }
      console.log(`   ${BOT_LABELS[kind]} webhook holati — ${parts.join('; ')}`);
    } catch (e) {
      console.log(`   ${BOT_LABELS[kind]} webhook holatini olib bo'lmadi: ${tgErrorDescription(e)}`);
    }
  }
}

async function showInfo(): Promise<number> {
  const missing = missingEnv(['CLIENT_BOT_TOKEN']);
  if (missing.length) {
    console.error(`❌ .env da yo'q: ${missing.join(', ')}`);
    return 1;
  }
  let ok = true;
  for (const kind of ['client', 'staff'] as const) {
    const api = apiFor(kind);
    if (!api) {
      console.log(`${BOT_LABELS[kind]}: ⚠️  token berilmagan (STAFF_BOT_TOKEN)`);
      continue;
    }
    try {
      const me = await api.getMe();
      const info = await api.getWebhookInfo();
      console.log(`${BOT_LABELS[kind]}: @${me.username}`);
      console.log(`   Webhook: ${info.url || '— (o\'rnatilmagan)'}`);
      console.log(`   Kutilayotgan yangilanishlar: ${info.pending_update_count}`);
      if (info.last_error_message) console.log(`   Oxirgi xato: ${info.last_error_message}`);
      if (!info.url) ok = false;
    } catch (e) {
      ok = false;
      console.log(`${BOT_LABELS[kind]}: ❌ ${tgErrorDescription(e)}`);
    }
  }
  const admins = config.adminIds;
  console.log(admins.length ? `👑 Adminlar: ${admins.join(', ')}` : '⚠️  ADMIN_IDS bo\'sh — admin panelga hech kim kira olmaydi.');
  return ok ? 0 : 1;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  if (args.includes('-h') || args.includes('--help')) {
    usage();
    return 0;
  }
  const unknown = args.filter((a) => a.startsWith('-') && a !== '--info');
  if (unknown.length) {
    console.error(`❌ Noma'lum parametr: ${unknown.join(' ')}\n`);
    usage();
    return 1;
  }
  if (args.includes('--info')) return showInfo();

  const positional = args.filter((a) => !a.startsWith('-'));
  if (positional.length > 1) {
    console.error('❌ Faqat bitta manzil bering.\n');
    usage();
    return 1;
  }
  const raw = positional[0] ?? config.appUrlEnv;
  if (!raw) {
    console.error('❌ Ilova manzili berilmagan va .env da APP_URL yo\'q.\n');
    usage();
    return 1;
  }
  let appUrl: string;
  try {
    appUrl = normalizeAppUrl(raw);
  } catch (e) {
    console.error(`❌ ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  const missing = missingEnv(['CLIENT_BOT_TOKEN', 'DATABASE_URL', 'WEBHOOK_SECRET']);
  if (missing.length) {
    console.error(`❌ .env da quyidagilar to'ldirilmagan: ${missing.join(', ')}`);
    return 1;
  }
  if (!config.hasStaffBot) console.warn('⚠️  STAFF_BOT_TOKEN berilmagan — xodimlar boti sozlanmaydi.');

  console.log(`⏳ Sozlanmoqda: ${appUrl} ...`);
  const report = await runSetup(appUrl);
  printReport(report);

  // runSetup hisobotida webhook holati bo'lmasa (getWebhookInfo xato bergan) — alohida so'raymiz
  const okKinds = (['client', 'staff'] as const).filter((k) => report.bots[k]?.ok && !report.bots[k]?.info);
  if (okKinds.length) await printWebhookStatus(okKinds);

  console.log('');
  const admins = config.adminIds;
  if (admins.length) console.log(`👑 Adminlar (ADMIN_IDS): ${admins.join(', ')}`);
  else console.log('⚠️  ADMIN_IDS bo\'sh — admin panelga hech kim kira olmaydi. .env / Vercel da ADMIN_IDS ni to\'ldiring.');

  const clientOk = report.bots.client?.ok === true;
  const staffOk = report.bots.staff?.ok === true;
  if (clientOk && staffOk) {
    console.log('\n🎉 Hammasi tayyor! Keyingi qadamlar:');
    console.log(`   1) Xodimlar botiga /start yozing (admin sifatida) → «⚙️ Admin panel» → «➕ Xodim qo'shish».`);
    console.log('   2) Har bir xodimga uning taklif havolasini yuboring — u o\'z Telegram akkauntini ulaydi.');
    console.log(`   3) Mijozlar botiga /start yozib, operator/menejerni tanlab sinab ko'ring.`);
  } else if (clientOk) {
    console.log('\n⚠️  Mijozlar boti tayyor, lekin xodimlar boti sozlanmadi — mijoz xabarlari xodimlarga yetkazilmaydi.');
  } else {
    console.log('\n❌ Mijozlar botini sozlab bo\'lmadi. Tokenni (CLIENT_BOT_TOKEN) va internet ulanishini tekshiring.');
  }
  return clientOk ? 0 : 1;
}

let code = 1;
try {
  code = await main();
} catch (e) {
  console.error(`❌ Xato: ${e instanceof Error ? e.message : String(e)}`);
  code = 1;
} finally {
  await closeDb().catch(() => {});
}
process.exitCode = code;
// grammY keep-alive ulanishlari jarayonni ushlab turmasligi uchun
setTimeout(() => process.exit(code), 1500).unref();

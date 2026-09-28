// HTTP orqali sozlash (ixtiyoriy). Asosiy va tavsiya etilgan yo'l — lokal kompyuterdan: `npm run setup -- https://<domen>`.
//
// Faqat POST, kalit faqat sarlavhada (hech qachon URL/brauzer manzilida emas — u loglarda, tarixda va havola
// ko'rinishini oluvchi botlarda qolib ketadi):
//   curl -X POST -H "Authorization: Bearer $SETUP_KEY" https://<domen>/api/setup
//   curl -X POST -H "Authorization: Bearer $SETUP_KEY" "https://<domen>/api/setup?info=1"   → faqat holat (hech narsa o'zgarmaydi)
//
// SETUP_KEY — Vercel env dagi ALOHIDA kalit (kamida 16 belgi, WEBHOOK_SECRET dan farqli). Bo'sh bo'lsa endpoint
// o'chirilgan (404). Agar setup manzili qachondir ?key=<WEBHOOK_SECRET> ko'rinishida ochilgan/ulashilgan bo'lsa —
// Vercel da WEBHOOK_SECRET ni almashtiring va setup ni qayta ishga tushiring (webhook tokenlari yangilanadi).
import { safeEqualStr } from '../src/auth.js';
import { config } from '../src/config.js';
import { json, withRequestDeadline } from '../src/http.js';
import { getAppUrl } from '../src/links.js';
import { runSetup, webhookStatus } from '../src/setup.js';
import { describeError } from '../src/util.js';

const MIN_KEY_LENGTH = 16;

function fail(status: number, error: string, message: string, headers: Record<string, string> = {}): Response {
  return json({ ok: false, error, message }, status, headers);
}

/**
 * Kalit FAQAT `Authorization: Bearer <SETUP_KEY>` sarlavhasidan olinadi. So'rov parametrlari (?key=…) umuman
 * o'qilmaydi — ularga zaxira yo'l ham yo'q.
 */
function presentedKey(req: Request): string {
  const m = /^Bearer\s+(.+)$/i.exec((req.headers.get('authorization') ?? '').trim());
  return m ? m[1]!.trim() : '';
}

function hostOf(v: string | null | undefined): string {
  return (v ?? '')
    .split(',')[0]!
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
}

/**
 * Webhook va Mini App manzili:
 *  1) APP_URL (aniq ko'rsatilgan) →
 *  2) so'rov kelgan domen, agar u Vercel yaratgan vaqtinchalik (deployment/branch) manzil bo'lmasa (production
 *     yoki egasi ochgan custom domen) →
 *  3) VERCEL_PROJECT_PRODUCTION_URL. Vaqtinchalik manzillar himoyalangan va o'zgarmas — webhook ularga bog'lanmasligi kerak.
 */
function resolveAppUrl(req: Request): { appUrl: string; warnings: string[] } {
  const warnings: string[] = [];
  const reqHost = hostOf(req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? new URL(req.url).host);
  const generated = new Set(
    [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL, req.headers.get('x-vercel-deployment-url')].map(hostOf).filter(Boolean),
  );
  const prodHost = hostOf(process.env.VERCEL_PROJECT_PRODUCTION_URL);

  let appUrl: string;
  if ((process.env.APP_URL ?? '').trim()) {
    appUrl = config.appUrlEnv;
  } else if (reqHost && !generated.has(reqHost)) {
    appUrl = `https://${reqHost}`;
    if (prodHost && reqHost !== prodHost) {
      warnings.push(`Manzil production domenidan farq qiladi: ${reqHost} (production: ${prodHost}). Bu sizning domeningiz bo'lsa — hammasi joyida.`);
    }
  } else {
    appUrl = config.appUrlEnv || (reqHost ? `https://${reqHost}` : '');
    if (reqHost && generated.has(reqHost)) {
      warnings.push(`So'rov vaqtinchalik deployment manzilidan keldi (${reqHost}) — production domeni ishlatildi: ${appUrl}`);
    }
  }
  return { appUrl, warnings };
}

async function handle(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return fail(405, 'method_not_allowed', "Faqat POST. Kalitni `Authorization: Bearer <SETUP_KEY>` sarlavhasida yuboring.", {
      allow: 'POST',
    });
  }

  const expected = config.setupKey;
  if (!expected) {
    return fail(404, 'setup_disabled', "HTTP orqali sozlash o'chirilgan. `npm run setup` dan foydalaning yoki Vercel da SETUP_KEY ni sozlang.");
  }
  let webhookSecret = '';
  try {
    webhookSecret = config.webhookSecret;
  } catch {
    return fail(500, 'misconfigured', 'WEBHOOK_SECRET sozlanmagan.');
  }
  if (expected.length < MIN_KEY_LENGTH || safeEqualStr(expected, webhookSecret)) {
    return fail(
      500,
      'misconfigured',
      `SETUP_KEY kamida ${MIN_KEY_LENGTH} belgidan iborat va WEBHOOK_SECRET dan farqli bo'lishi kerak.`,
    );
  }
  const given = presentedKey(req);
  if (!given || !safeEqualStr(given, expected)) {
    return fail(401, 'unauthorized', "Noto'g'ri yoki berilmagan kalit (Authorization: Bearer <SETUP_KEY>).", {
      'www-authenticate': 'Bearer',
    });
  }

  // Vaqtinchalik (preview) deployment o'z env/bazasi bilan production botlarini qayta sozlab yubormasin
  if ((process.env.VERCEL_ENV ?? '').trim() === 'preview') {
    return fail(409, 'preview_deployment', "Sozlash faqat production deploymentida bajariladi. Production domenidan chaqiring.");
  }

  // Faqat holat: hech narsa o'zgarmaydi
  if (new URL(req.url).searchParams.get('info') === '1') {
    const [client, staff, appUrl] = await Promise.all([
      webhookStatus('client'),
      config.hasStaffBot ? webhookStatus('staff') : Promise.resolve(undefined),
      getAppUrl().catch(() => ''),
    ]);
    return json({ ok: true, appUrl, bots: { client: { info: client }, ...(config.hasStaffBot ? { staff: { info: staff } } : {}) } });
  }

  const { appUrl, warnings } = resolveAppUrl(req);
  if (!appUrl) return fail(500, 'no_app_url', "Ilova manzilini aniqlab bo'lmadi. APP_URL ni sozlang.");
  try {
    const report = await runSetup(appUrl, { warnings });
    const ok = report.bots.client?.ok === true;
    return json({ ok, ...report }, ok ? 200 : 500);
  } catch (e) {
    console.error('setup xatosi:', describeError(e));
    return fail(500, 'setup_failed', e instanceof Error ? e.message : String(e));
  }
}

export default { fetch: withRequestDeadline(handle, 55_000) };

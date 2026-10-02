// Kutib turgan mijoz xabarlarini fonda yetkazish (ichki): POST /api/redeliver {staffId, notBefore, hop},
// sarlavha x-redeliver-key. Faqat ilovaning o'zi chaqiradi (src/redeliver.ts → requestRedelivery).
// notBefore gacha kutadi (≤ 30 s shu chaqiruvda; uzoqroq bo'lsa — uxlab, o'zini qayta chaqiradi), keyin xodimning
// navbatini tartib bilan yetkazadi (src/relay.ts → runScheduledRedelivery). Band qilish tufayli parallel chaqiruvlar
// bitta xabarni ikki marta yubormaydi.
import { safeEqualStr } from '../src/auth.js';
import { json, withRequestDeadline } from '../src/http.js';
import {
  REDELIVER_HOP_SLEEP_MS,
  REDELIVER_MAX_HOPS,
  REDELIVER_MAX_INLINE_WAIT_MS,
  parseRedeliverRequest,
  redeliverKey,
  requestRedelivery,
  vercelWaitUntil,
  type RedeliverRequest,
} from '../src/redeliver.js';
import { runScheduledRedelivery } from '../src/relay.js';
import { releaseRedeliveryMark } from '../src/repo.js';
import { ensureSchema } from '../src/setup.js';
import { describeError, sleep } from '../src/util.js';

async function processRequest(r: RedeliverRequest): Promise<void> {
  const wait = r.notBefore - Date.now();
  if (wait > REDELIVER_MAX_INLINE_WAIT_MS) {
    // Uzoq kutish: bir qismini shu yerda uxlaymiz va zanjirni davom ettiramiz (belgi o'zgarmaydi — force)
    if (r.hop >= REDELIVER_MAX_HOPS) {
      // Zanjir shu yerda to'xtaydi: uning belgisi (redeliver_at = notBefore) 90 s gacha yangi so'rovlarni rad etib
      // turmasin — keyingi hodisa yangi zanjir boshlay olsin
      console.warn(`[redeliver] xodim #${r.staffId}: fon zanjiri cheklovi (${REDELIVER_MAX_HOPS}) — belgi bo'shatildi, keyingi hodisa kutiladi`);
      await ensureSchema();
      await releaseRedeliveryMark(r.staffId, new Date(r.notBefore));
      return;
    }
    await sleep(Math.min(wait - REDELIVER_MAX_INLINE_WAIT_MS / 2, REDELIVER_HOP_SLEEP_MS));
    await requestRedelivery(r.staffId, r.notBefore, { hop: r.hop + 1, force: true });
    return;
  }
  if (wait > 0) await sleep(wait);
  await ensureSchema();
  await runScheduledRedelivery(r.staffId, r.hop);
}

async function handle(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, { allow: 'POST' });
  const key = req.headers.get('x-redeliver-key') ?? '';
  if (!key || !safeEqualStr(key, redeliverKey())) return json({ ok: false, error: 'unauthorized' }, 401);
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    /* bo'sh */
  }
  const r = parseRedeliverRequest(body);
  if (!r) return json({ ok: false, error: 'bad_request' }, 400);

  const work = processRequest(r).catch((e) => {
    console.error(`[redeliver] xodim #${r.staffId} navbatini fonda yetkazishda xato:`, describeError(e));
  });
  // Vercel: javob darhol qaytadi (chaqiruvchi kutmaydi), ish waitUntil ichida davom etadi; aks holda — so'rov ichida
  const waitUntil = vercelWaitUntil();
  if (waitUntil) {
    waitUntil(work);
    return json({ ok: true, accepted: true }, 202);
  }
  await work;
  return json({ ok: true });
}

export default { fetch: withRequestDeadline(handle, 55_000) };

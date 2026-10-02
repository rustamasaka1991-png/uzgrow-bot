// Ommaviy xabarni davom ettirish (ichki): POST /api/broadcast  {id, notBefore?, hop?, stalled?}, sarlavha x-broadcast-key.
// Faqat ilovaning o'zi chaqiradi (src/broadcast.ts → continueBroadcastInBackground).
// notBefore (Telegram 429 retry_after) gacha boshlanmaydi: uzoq kutish bo'laklab (≤ 40 s uxlab, o'zini qayta
// chaqirib) o'tkaziladi — flood paytida har soniyada chaqiruvlar zanjiri bo'lmasin. Kursor ketma-ket bir necha bo'lakda
// siljimasa — zanjir to'xtaydi (ROP «▶️ Davom ettirish» bilan davom ettiradi).
import { safeEqualStr } from '../src/auth.js';
import { broadcastKey, continueBroadcastInBackground, runBroadcast } from '../src/broadcast.js';
import { json, withRequestDeadline } from '../src/http.js';
import { describeError, sleep } from '../src/util.js';

/** Bitta chaqiruvdagi yuborish byudjeti (55 s so'rov byudjeti ichida). */
const BUDGET_MS = 45_000;
/** notBefore gacha shundan ko'p qolgan bo'lsa — shu chaqiruvda yubormaymiz: uxlab, o'zini qayta chaqiradi. */
const INLINE_WAIT_MAX_MS = 15_000;
/** O'zini qayta chaqirishdan oldin bitta chaqiruvda uxlash chegarasi. */
const HOP_SLEEP_MS = 40_000;
/** Zanjirdagi chaqiruvlar soni cheklovi (har bo'lak va har kutish bo'g'ini — bitta). */
const MAX_HOPS = 1_000;
/** Kursor shuncha ketma-ket bo'lakda siljimasa — zanjir to'xtaydi. */
const MAX_STALLED = 3;
/** notBefore bundan uzoq kelajakda bo'lsa — noto'g'ri so'rov. */
const MAX_AHEAD_MS = 2 * 3600_000;

function intOr(v: unknown, dflt: number): number {
  if (v == null) return dflt;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : NaN;
}

async function handle(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, { allow: 'POST' });
  const key = req.headers.get('x-broadcast-key') ?? '';
  if (!key || !safeEqualStr(key, broadcastKey())) return json({ ok: false, error: 'unauthorized' }, 401);
  let body: { id?: unknown; notBefore?: unknown; hop?: unknown; stalled?: unknown } = {};
  try {
    body = ((await req.json()) ?? {}) as typeof body;
  } catch {
    /* bo'sh */
  }
  const id = Number(body?.id);
  const hop = intOr(body?.hop, 0);
  const stalled = intOr(body?.stalled, 0);
  const notBefore = body?.notBefore == null ? 0 : Number(body.notBefore);
  if (!Number.isSafeInteger(id) || id <= 0) return json({ ok: false, error: 'bad_request' }, 400);
  if (!(hop >= 0) || !(stalled >= 0) || !Number.isFinite(notBefore) || notBefore - Date.now() > MAX_AHEAD_MS) {
    return json({ ok: false, error: 'bad_request' }, 400);
  }
  if (hop > MAX_HOPS) {
    console.warn(`[broadcast] #${id}: zanjir cheklovi (${MAX_HOPS}) — to'xtadi («▶️ Davom ettirish» bilan davom etadi)`);
    return json({ ok: true, finished: false, claimed: false, stopped: 'hops' });
  }
  try {
    const wait = notBefore - Date.now();
    if (wait > INLINE_WAIT_MAX_MS) {
      // Telegram flood kutishi: bir qismini shu yerda uxlaymiz va zanjirni davom ettiramiz (yubormasdan)
      await sleep(Math.min(wait, HOP_SLEEP_MS));
      await continueBroadcastInBackground(id, { notBefore, hop: hop + 1, stalled });
      return json({ ok: true, finished: false, claimed: false, waiting: true });
    }
    if (wait > 0) await sleep(wait);
    const r = await runBroadcast(id, { budgetMs: BUDGET_MS - Math.max(0, wait) });
    if (r.claimed && !r.finished) {
      const nextStalled = r.progressed ? 0 : stalled + 1;
      if (nextStalled >= MAX_STALLED) {
        console.warn(
          `[broadcast] #${id}: ${nextStalled} ta bo'lakda kursor siljimadi — zanjir to'xtadi («▶️ Davom ettirish» bilan davom etadi)`,
        );
      } else {
        await continueBroadcastInBackground(id, { notBefore: r.retryAt, hop: hop + 1, stalled: nextStalled });
      }
    }
    return json({ ok: true, finished: r.finished, claimed: r.claimed });
  } catch (e) {
    console.error(`[broadcast] #${id} xatosi:`, describeError(e));
    return json({ ok: false, error: 'internal' }, 500);
  }
}

export default { fetch: withRequestDeadline(handle, 55_000) };

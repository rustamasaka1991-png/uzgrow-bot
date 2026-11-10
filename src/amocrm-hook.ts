// amoCRM dan kelgan hook (operator amoCRM chatida mijozga javob yozdi) -> mijozga Telegram orqali yetkaziladi,
// xodimning Telegram chatiga ham nusxa boradi (ikkala tomonda tarix bir xil ko'rinsin).
import { amo, parseAmoConversationId, verifyHookSignature } from './amocrm.js';
import { json } from './http.js';
import { relayErrorText, relayStaffMessage } from './relay.js';
import { getConversation, getStaff } from './repo.js';
import { ensureSchema } from './setup.js';
import { staffApi } from './tg.js';
import type { Content } from './types.js';
import { describeError, esc, truncate } from './util.js';

const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

interface AmoHook {
  message?: {
    conversation?: { client_id?: string };
    message?: { type?: string; text?: string; media?: string; file_name?: string };
  };
}

async function contentFromAmo(m: NonNullable<NonNullable<AmoHook['message']>['message']>): Promise<Content | null> {
  const text = (m.text ?? '').trim();
  if (!m.media || m.type === 'text') return text ? { kind: 'text', text } : null;
  const res = await fetch(m.media, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`amoCRM faylini yuklab bo'lmadi: HTTP ${res.status}`);
  const data = new Uint8Array(await res.arrayBuffer());
  if (data.byteLength > MAX_MEDIA_BYTES) throw new Error('amoCRM fayli juda katta');
  const mimeType = (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim();
  const fileName = m.file_name || (m.type === 'picture' ? 'image.jpg' : 'file');
  return {
    kind: m.type === 'picture' && mimeType.startsWith('image/') ? 'photo' : 'document',
    ...(text ? { text } : {}),
    upload: { data, fileName, mimeType },
  };
}

async function deliver(hook: AmoHook): Promise<void> {
  const convId = parseAmoConversationId(hook.message?.conversation?.client_id);
  const msg = hook.message?.message;
  if (!convId || !msg) return; // bizning chat emas (yoki boshqa turdagi hook)
  const conversation = await getConversation(convId);
  const staff = conversation ? await getStaff(conversation.staff_id) : null;
  if (!conversation || !staff) return console.warn(`[amocrm] suhbat #${convId} topilmadi`);

  const content = await contentFromAmo(msg);
  if (!content) return;
  const r = await relayStaffMessage({ staff, conversation, content, via: 'bot', fromAmo: true });

  // Xodimning Telegram chatiga nusxa (u ham ko'rib tursin)
  const api = staffApi();
  if (api && staff.tg_user_id && !staff.bot_blocked) {
    const status = r.ok ? '' : `\n⚠️ ${relayErrorText(r.error)}`;
    const body = content.kind === 'text' ? esc(content.text) : `📎 ${esc(content.upload?.fileName)}${content.text ? `\n${esc(content.text)}` : ''}`;
    await api
      .sendMessage(staff.tg_user_id, truncate(`🟦 <b>amoCRM dan javob</b> (suhbat #${convId}):\n${body}${status}`, 4000), {
        parse_mode: 'HTML',
      })
      .catch((e) => console.error('[amocrm] xodimga nusxa yuborilmadi:', describeError(e)));
  }
  if (!r.ok) console.error(`[amocrm] suhbat #${convId}: mijozga yetkazilmadi — ${r.error}`);
}

/** POST /api/amocrm/<scope_id> */
export async function handleAmoHook(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ ok: false }, 405);
  if (!amo.enabled) return json({ ok: false }, 404);
  const body = (await req.text()).trim();
  if (!verifyHookSignature(body, req.headers.get('x-signature'), amo.secret)) return json({ ok: false }, 401);
  let hook: AmoHook;
  try {
    hook = JSON.parse(body) as AmoHook;
  } catch {
    return json({ ok: false }, 400);
  }
  // amoCRM hookni qayta yubormaydi — shu so'rov ichida yetkazamiz, xato faqat logga
  try {
    await ensureSchema();
    await deliver(hook);
  } catch (e) {
    console.error('[amocrm] hookni qayta ishlashda xato:', describeError(e));
  }
  return json({ ok: true });
}

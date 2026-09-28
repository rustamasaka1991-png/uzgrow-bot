// Mijoz o'z xabarini tahrirlasa (edited_message) — xodimdagi nusxa ham yangilanadi va tarix to'g'rilanadi.
// Xodim tomoni (xodim o'z javobini tahrirlashi) — src/bots/staff/edits.ts.
import type { MessageEntity, Update } from 'grammy/types';
import { clientHeaderForStaff, handleStaffUnreachable, staffMessageKeyboard } from './relay.js';
import {
  addMessageLinks,
  applyMessageEdit,
  findClientMessageForEdit,
  getClient,
  getStaff,
  isFirstMessageOfConversation,
  updateMessageDelivery,
} from './repo.js';
import {
  MAX_DOWNLOAD_BYTES,
  NotEditableError,
  editRelayed,
  extractContent,
  fitsSingleMessage,
  sendContent,
  staffApi,
} from './tg.js';
import type { Client, Content, Message, MsgKind } from './types.js';
import { describeError, tgErrorCode, tgErrorDescription } from './util.js';

/**
 * Tahrir sifatida qabul qilinmaydigan turlar: jonli joylashuv yangilanishlari ham edited_message bo'lib keladi
 * (8 soatgacha oqim), kontakt/stiker/video-xabarni esa Telegramda tahrirlab bo'lmaydi.
 */
const IGNORED_EDIT_KINDS: readonly MsgKind[] = ['location', 'contact', 'sticker', 'video_note'];

/** Izoh olib tashlanganda xodimga ko'rsatiladigan matn. */
const CAPTION_REMOVED = '(izoh olib tashlandi)';

export type EditRelayResult =
  /**
   * edited — xodimdagi nusxa joyida tahrirlandi; notice — joyida tahrirlab bo'lmadi, xodimga asl xabarga reply
   * qilingan "✏️ … tahrirlandi" xabari yuborildi; unchanged — mazmun o'zgarmagan; saved — faqat tarix yangilandi
   * (xabar hali xodimga yetkazilmagan — navbatdan yangilangan holda boradi — yoki xodim botiga yetib bo'lmadi).
   */
  | { ok: true; outcome: 'edited' | 'notice' | 'unchanged' | 'saved'; message: Message }
  /** not_found — bu xabar relay qilinmagan (buyruq, tugma va h.k.); ignored — tahrir sifatida qaralmaydi. */
  | { ok: false; reason: 'not_found' | 'ignored' };

/** Kalitlar tartibiga bog'liq bo'lmagan JSON (jsonb kalitlarni qayta tartiblaydi). */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

function sameEntities(a: MessageEntity[] | null | undefined, b: MessageEntity[] | null | undefined): boolean {
  return stableJson(a && a.length ? a : null) === stableJson(b && b.length ? b : null);
}

/**
 * Mijoz botida `edited_message` kelganda chaqiriladi. Ikkinchi avto-javob yuborilmaydi, o'qilmaganlar soni
 * oshmaydi. Xodimdagi nusxa xuddi o'sha sarlavha va «↩️ Javob berish» tugmasi bilan joyida tahrirlanadi;
 * iloji bo'lmasa (asl xabar bo'laklab yuborilgan, juda eski, media almashtirilgan) — asl xabarga reply qilingan
 * "✏️ … — tahrirlandi" xabari yuboriladi. Telegram xatolari tashlanmaydi (faqat logga yoziladi).
 */
export async function relayClientEdit(params: {
  client: Client;
  /** Tahrirlangan xabarning mijoz chatidagi id si. */
  clientMsgId: number;
  /** extractContent(ctx.editedMessage) natijasi. */
  content: Content | null;
}): Promise<EditRelayResult> {
  const { client, clientMsgId, content } = params;
  if (!content || IGNORED_EDIT_KINDS.includes(content.kind)) return { ok: false, reason: 'ignored' };

  const row = await findClientMessageForEdit(client.tg_user_id, clientMsgId);
  if (!row) return { ok: false, reason: 'not_found' };

  const mediaReplaced =
    content.kind !== row.kind ||
    (!!content.fileUniqueId && !!row.file_unique_id && content.fileUniqueId !== row.file_unique_id);
  const text = content.text ?? null;
  const entities = content.entities && content.entities.length ? content.entities : null;
  if (!mediaReplaced && (row.text ?? '') === (text ?? '') && sameEntities(row.entities, entities)) {
    return { ok: true, outcome: 'unchanged', message: row };
  }
  if (mediaReplaced && content.fileSize && content.fileSize > MAX_DOWNLOAD_BYTES) {
    return { ok: false, reason: 'ignored' };
  }

  const updated =
    (await applyMessageEdit(row.id, {
      text,
      entities,
      ...(mediaReplaced
        ? {
            media: {
              kind: content.kind,
              file_id_client: content.fileId ?? null,
              file_id_staff: null,
              file_unique_id: content.fileUniqueId ?? null,
              file_name: content.fileName ?? null,
              mime_type: content.mimeType ?? null,
              file_size: content.fileSize ?? null,
              meta: content.meta ?? null,
            },
          }
        : {}),
    })) ?? row;

  // Xodimga hali yetkazilmagan bo'lsa — navbatdagi (yangilangan) yozuv o'zi boradi
  const staff = await getStaff(row.conversation_staff_id);
  const chatId = row.staff_chat_id;
  const targetId = row.staff_chat_msg_id;
  if (!staffApi() || !staff?.tg_user_id || chatId == null || targetId == null || chatId !== staff.tg_user_id) {
    return { ok: true, outcome: 'saved', message: updated };
  }

  const base = clientHeaderForStaff(client);
  if (await isFirstMessageOfConversation(row)) base.header = `🆕 ${base.header}`;
  const keyboard = staffMessageKeyboard(row.conversation_id);

  // 1) Joyida tahrirlash — faqat asl xabar bitta xabarga sig'gan bo'lsa (aks holda u bo'laklab yuborilgan)
  if (!mediaReplaced && fitsSingleMessage(row.kind, row.text, row.entities, base.header, base.headerSuffix)) {
    try {
      const outcome = await editRelayed('staff', chatId, targetId, content, { ...base, replyMarkup: keyboard });
      return { ok: true, outcome, message: updated };
    } catch (e) {
      if (tgErrorCode(e) === 403) {
        await handleStaffUnreachable(staff);
        return { ok: true, outcome: 'saved', message: updated };
      }
      if (!(e instanceof NotEditableError)) {
        console.warn(`[edits] xodimdagi nusxani tahrirlab bo'lmadi (xabar #${row.id}):`, tgErrorDescription(e));
      }
    }
  }

  // 2) Tahrir haqida yangi xabar (asl nusxaga reply)
  const notice: Content = mediaReplaced
    ? { ...content }
    : text
      ? { kind: 'text', text, entities: entities ?? undefined }
      : { kind: 'text', text: CAPTION_REMOVED };
  try {
    const res = await sendContent('staff', chatId, notice, 'client', {
      header: `✏️ ${base.header}`,
      headerSuffix: `${base.headerSuffix ?? ''} — xabar tahrirlandi`,
      replyMarkup: keyboard,
      replyParameters: { message_id: targetId },
    });
    await addMessageLinks(row.id, 'staff', chatId, res.messageIds).catch((e) =>
      console.error(`[edits] message_links (#${row.id}) saqlanmadi:`, describeError(e)),
    );
    if (mediaReplaced && res.fileId) await updateMessageDelivery(row.id, { file_id_staff: res.fileId });
    return { ok: true, outcome: 'notice', message: { ...updated, file_id_staff: mediaReplaced ? (res.fileId ?? null) : updated.file_id_staff } };
  } catch (e) {
    console.error(`[edits] tahrirni xodimga yetkazib bo'lmadi (xabar #${row.id}):`, tgErrorDescription(e));
    if (tgErrorCode(e) === 403) await handleStaffUnreachable(staff);
    return { ok: true, outcome: 'saved', message: updated };
  }
}

/**
 * Mijozlar botining har bir update idan keyin (api/client-bot.ts → createWebhookHandler afterUpdate):
 * `edited_message` bo'lsa — tahrir xodimga yetkaziladi. Bot moduli ham relayClientEdit ni chaqirsa, ikkinchi
 * chaqiruv bazadagi yangilangan matnni ko'rib 'unchanged' qaytaradi (takroriy xabar yuborilmaydi).
 */
export async function onClientBotUpdate(update: Update): Promise<void> {
  const msg = update.edited_message;
  if (!msg || msg.chat.type !== 'private' || !msg.from || msg.from.is_bot) return;
  const client = await getClient(msg.from.id);
  if (!client) return;
  const res = await relayClientEdit({ client, clientMsgId: msg.message_id, content: extractContent(msg) });
  if (res.ok && res.outcome !== 'unchanged') {
    console.log(`[edits] mijoz ${client.tg_user_id} xabari #${res.message.id} tahrirlandi (${res.outcome})`);
  }
}

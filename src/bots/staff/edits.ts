// Xodim mijozga yuborilgan xabarini Telegramda tahrirlasa — mijozdagi nusxasi va saqlangan tarix ham yangilanadi
// (matn, izoh, almashtirilgan media). Yangilab bo'lmaydigan holatlarda xodimga aniq sababi aytiladi —
// tahrir jimgina "yo'qolib" qolmaydi.
import { InputFile, InputMediaBuilder } from 'grammy';
import type { InputMedia, Message as TgMessage, MessageEntity } from 'grammy/types';
import { clientMessageKeyboard, staffHeaderForClient } from '../../relay.js';
import { applyMessageEdit, findStaffMessageForEdit, getConversation, setClientBlocked } from '../../repo.js';
import { FileTooBigError, clientApi, downloadFile, extractContent, react, safeFileName } from '../../tg.js';
import type { Content, MsgKind } from '../../types.js';
import { esc, isNotModified, tgErrorCode } from '../../util.js';
import {
  CAPTION_LIMIT,
  INACTIVE_TEXT,
  TEXT_LIMIT,
  isCommandMessage,
  isMainButton,
  logError,
  sendHtml,
  type StaffContext,
} from './ui.js';

/** Izohi (caption) tahrirlanadigan media turlari. */
const CAPTION_KINDS: readonly MsgKind[] = ['photo', 'video', 'animation', 'document', 'audio', 'voice'];
/** editMessageMedia bilan almashtirsa bo'ladigan turlar (ovozli xabar, stiker, video-xabar — yo'q). */
const REPLACEABLE_KINDS: readonly MsgKind[] = ['photo', 'video', 'animation', 'document', 'audio'];

const NOTE = {
  notSent: "✏️ Tahrir hech kimga yetkazilmadi — bu xabar mijozga yuborilmagan edi.",
  undelivered:
    "✏️ Tahrir yetkazilmadi — asl xabar ham mijozga yetkazilmagan edi (masalan, mijoz botni bloklagan). Xabarni qayta yuboring.",
  replaced:
    "✏️ Xabar turi o'zgargani uchun mijozdagi nusxani yangilab bo'lmaydi. Yangisini alohida xabar qilib yuboring.",
  splitText:
    "✏️ Tahrir yetkazilmadi: asl xabar juda uzun bo'lgani uchun mijozga bir necha qism bo'lib borgan. To'g'rilangan matnni yangi xabar qilib yuboring.",
  longText:
    "✏️ Tahrir yetkazilmadi: matn juda uzun (sarlavha bilan 4096 belgidan oshdi). To'g'rilangan matnni yangi xabar qilib yuboring.",
  splitCaption:
    "✏️ Tahrir yetkazilmadi: asl izoh uzun bo'lgani uchun mijozga alohida matn bo'lib borgan. To'g'rilangan xabarni yangi xabar qilib yuboring.",
  longCaption:
    "✏️ Tahrir yetkazilmadi: izoh juda uzun (sarlavha bilan 1024 belgidan oshdi). To'g'rilangan xabarni yangi xabar qilib yuboring.",
  tooBig: "✏️ Almashtirilgan fayl juda katta (20 MB dan oshmasin) — tahrir yetkazilmadi.",
  blocked: '✏️ Tahrir yetkazilmadi — mijoz botni bloklagan.',
  failed: "✏️ Tahrirni mijozga yetkazib bo'lmadi. To'g'rilangan xabarni yangi xabar qilib yuboring.",
} as const;

/** Sarlavha (bold) + matn — mijozga yuborilgan ko'rinish bilan bir xil (tg.ts sendContent dagidek). */
function withHeader(header: string, body: string, entities?: MessageEntity[] | null): { text: string; entities: MessageEntity[] } {
  const prefix = body ? `${header}\n` : header;
  const out: MessageEntity[] = [{ type: 'bold', offset: 0, length: header.length }];
  for (const e of entities ?? []) out.push({ ...e, offset: e.offset + prefix.length });
  return { text: prefix + body, entities: out };
}

const DEFAULT_EXT: Partial<Record<MsgKind, string>> = { photo: 'jpg', video: 'mp4', animation: 'mp4', audio: 'mp3', document: 'bin' };

function mediaFor(content: Content, file: InputFile, caption: { text: string; entities: MessageEntity[] }): InputMedia | null {
  const opts = { caption: caption.text, caption_entities: caption.entities };
  switch (content.kind) {
    case 'photo':
      return InputMediaBuilder.photo(file, opts);
    case 'video':
      return InputMediaBuilder.video(file, { ...opts, supports_streaming: true });
    case 'animation':
      return InputMediaBuilder.animation(file, opts);
    case 'audio':
      return InputMediaBuilder.audio(file, opts);
    case 'document':
      return InputMediaBuilder.document(file, opts);
    default:
      return null;
  }
}

function clientFileIdOf(kind: MsgKind, m: TgMessage): string | undefined {
  switch (kind) {
    case 'photo':
      return m.photo?.[m.photo.length - 1]?.file_id;
    case 'video':
      return m.video?.file_id;
    case 'animation':
      return m.animation?.file_id ?? m.document?.file_id;
    case 'audio':
      return m.audio?.file_id;
    case 'document':
      return m.document?.file_id;
    default:
      return undefined;
  }
}

/**
 * `edited_message` handleri. next() ni chaqirmaydi: tahrirlangan buyruq, tugma yoki admin kiritmasi
 * qayta bajarilmasligi kerak.
 */
export async function onStaffEdit(ctx: StaffContext): Promise<void> {
  const edited = ctx.editedMessage as TgMessage | undefined;
  const me = ctx.staff;
  if (!edited || !me || !ctx.chat) return;
  // Jonli joylashuv yangilanishlari ham edited_message bo'lib keladi — ular tahrir emas
  if (edited.location || edited.venue) return;
  if (isCommandMessage(edited) || isMainButton(edited.text)) return;
  const chatId = ctx.chat.id;
  const note = (html: string) => sendHtml(ctx, html, { replyTo: edited.message_id });

  // Faqat shu xodimning suhbatlaridagi o'z xabari (maxfiylik)
  const row = await findStaffMessageForEdit(me.id, chatId, edited.message_id);
  if (!row) {
    await note(NOTE.notSent);
    return;
  }
  if (!me.is_active) {
    await note(`✏️ Tahrir mijozga yetkazilmadi.\n${esc(INACTIVE_TEXT)}`);
    return;
  }
  if (row.client_chat_msg_id == null) {
    await note(NOTE.undelivered);
    return;
  }
  const conv = await getConversation(row.conversation_id);
  if (!conv || conv.staff_id !== me.id) return;
  const clientId = conv.client_id;
  const clientMsgId = row.client_chat_msg_id;
  const content = extractContent(edited);
  if (!content) {
    await note(NOTE.replaced);
    return;
  }

  const header = staffHeaderForClient(me).header;
  const body = content.text ?? '';
  const api = clientApi();
  // Mijozdagi nusxaning «↩️ Javob berish» tugmasi saqlanadi (tahrirda reply_markup berilmasa, Telegram uni o'chiradi)
  const keyboard = { reply_markup: clientMessageKeyboard(conv.id) };
  let media: Parameters<typeof applyMessageEdit>[1]['media'];
  try {
    if (row.kind === 'text') {
      if (content.kind !== 'text') {
        await note(NOTE.replaced);
        return;
      }
      // Asl matn sarlavha bilan limitdan oshgan bo'lsa, u bo'laklab yuborilgan — bitta bo'lakni almashtirib bo'lmaydi
      if (withHeader(header, row.text ?? '').text.length > TEXT_LIMIT) {
        await note(NOTE.splitText);
        return;
      }
      const merged = withHeader(header, body, content.entities);
      if (merged.text.length > TEXT_LIMIT) {
        await note(NOTE.longText);
        return;
      }
      await api.editMessageText(clientId, clientMsgId, merged.text, {
        entities: merged.entities,
        link_preview_options: { is_disabled: false },
        ...keyboard,
      });
    } else if (CAPTION_KINDS.includes(row.kind)) {
      if (withHeader(header, row.text ?? '').text.length > CAPTION_LIMIT) {
        await note(NOTE.splitCaption);
        return;
      }
      const merged = withHeader(header, body, content.entities);
      if (merged.text.length > CAPTION_LIMIT) {
        await note(NOTE.longCaption);
        return;
      }
      const mediaChanged =
        content.kind !== row.kind || (!!content.fileUniqueId && content.fileUniqueId !== row.file_unique_id);
      if (!mediaChanged) {
        await api.editMessageCaption(clientId, clientMsgId, { caption: merged.text, caption_entities: merged.entities, ...keyboard });
      } else {
        // Media almashtirildi: fayl staff botdan yuklab olinib, mijoz botiga qayta yuklanadi (file_id lar botga xos)
        if (!REPLACEABLE_KINDS.includes(row.kind) || !REPLACEABLE_KINDS.includes(content.kind) || !content.fileId) {
          await note(NOTE.replaced);
          return;
        }
        const { data } = await downloadFile('staff', content.fileId);
        const name = safeFileName(content.fileName) || `${content.kind}.${DEFAULT_EXT[content.kind] ?? 'bin'}`;
        const input = mediaFor(content, new InputFile(data, name), merged);
        if (!input) {
          await note(NOTE.replaced);
          return;
        }
        const res = await api.editMessageMedia(clientId, clientMsgId, input, keyboard);
        const sent = res === true ? undefined : (res as TgMessage);
        media = {
          kind: content.kind,
          file_id_staff: content.fileId,
          file_id_client: sent ? (clientFileIdOf(content.kind, sent) ?? null) : null,
          file_unique_id: content.fileUniqueId ?? null,
          file_name: content.fileName ?? null,
          mime_type: content.mimeType ?? null,
          file_size: content.fileSize ?? null,
          meta: content.meta ?? null,
        };
      }
    } else {
      // Stiker, video-xabar, kontakt, joylashuv Telegramda tahrirlanmaydi
      return;
    }
  } catch (e) {
    if (!isNotModified(e)) {
      if (e instanceof FileTooBigError) {
        await note(NOTE.tooBig);
        return;
      }
      logError('tahrirni mijozga yetkazish', e);
      if (tgErrorCode(e) === 403) {
        await setClientBlocked(clientId, true);
        await note(NOTE.blocked);
      } else {
        await note(NOTE.failed);
      }
      return;
    }
  }

  await applyMessageEdit(row.id, {
    text: content.text ?? null,
    entities: content.entities ?? null,
    ...(media ? { media } : {}),
  });
  // ✍ — tahrir mijozga yetkazildi
  await react('staff', chatId, edited.message_id, '✍');
}

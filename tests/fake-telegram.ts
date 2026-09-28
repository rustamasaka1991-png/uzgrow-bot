/**
 * tests/fake-telegram.ts — in-process fake Telegram Bot API server for tests.
 *
 * It speaks the real Bot API wire protocol (JSON, urlencoded, query string and multipart/form-data —
 * including grammY's non-standard multipart headers), so the app's real grammY `Bot`/`Api` objects talk
 * to it unchanged: point `TELEGRAM_API_ROOT` at `fake.url` BEFORE the app creates its bots.
 *
 * ── Quick start ────────────────────────────────────────────────────────────────────────────────────────
 *   import { startFakeTelegram, fakeJpeg, findButton } from './fake-telegram.js';
 *   const tg = await startFakeTelegram({ bots: [
 *     { token: '111111:CLIENTTOKEN', username: 'uzgroww_bot' },
 *     { token: '222222:STAFFTOKEN', username: 'uzgrow_staff_bot' },
 *   ] });
 *   process.env.TELEGRAM_API_ROOT = tg.url;
 *   const upd = tg.messageUpdate(CLIENT, { id: 501, is_bot: false, first_name: 'Ali' }, { text: '/start' });
 *   await clientWebhook.fetch(new Request('https://x/api/client-bot', { method: 'POST', headers, body: JSON.stringify(upd) }));
 *   tg.lastSent(CLIENT, 501)?.text;                         // plain text (HTML already parsed away)
 *   const card = tg.sent(CLIENT, 501).find((m) => m.kind === 'photo')!;
 *   const press = tg.pressButton(CLIENT, 501, card, /Yozish/); // callback_query update for that button
 *   tg.unansweredCallbacks();                               // → [] if every callback query was answered
 *   await tg.close();
 *
 * ── Behaviour (mirrors the real Bot API; everything marked [strict] is stricter than Telegram on purpose) ──
 *  • Tokens: any well-formed `<digits>:<secret>` token works (bot id = the digits). `knownTokensOnly` → others 401.
 *    Malformed token path → 404 "Not Found" (like Telegram). Unknown method → 404 "Not Found".
 *  • Message ids are allocated PER BOT PER CHAT starting at 1 (user messages built with the helpers below share
 *    the same sequence). Ids therefore collide across chats — code must always key messages by (chat, id).
 *  • file_ids are BOT-SPECIFIC: `F_<botId>_<n>`. Using another bot's (or an unknown) file_id in sendX / getFile
 *    → 400 "Bad Request: wrong file identifier/HTTP URL specified". Using a file of the wrong kind (e.g. a
 *    photo id in sendDocument) → 400 "Bad Request: type of file mismatch".
 *  • Uploads (multipart, `attach://<name>` or the file part named like the field) are stored; getFile returns a
 *    `file_path` and `GET /file/bot<token>/<file_path>` serves the exact bytes (404 for another bot's token).
 *    Photos get 1–4 PhotoSizes (each with its own file_id); only the LARGEST (last) one carries the original
 *    bytes. [strict] Photo uploads must be real images (JPEG/PNG/GIF/WEBP/BMP magic bytes) else 400
 *    "IMAGE_PROCESS_FAILED" — use `fakeJpeg()` for test photos. getFile of a file > 20 MB → "file is too big".
 *    http(s) URLs as media are fetched (5 s timeout); failure → 400 "failed to get HTTP URL content".
 *  • parse_mode HTML is parsed like Telegram: supported tags only (b strong i em u ins s strike del span.tg-spoiler
 *    tg-spoiler a code pre blockquote tg-emoji), `&lt; &gt; &amp; &quot;` + numeric entities; an unescaped `<`,
 *    unknown tag (`<br>`), unmatched/unclosed tag → 400 "Bad Request: can't parse entities: …". Stored text is the
 *    parsed plain text and `entities` are produced (UTF-16 offsets). MarkdownV2/Markdown are NOT parsed.
 *  • Limits: text 4096 / caption 1024 (Unicode code points, after parsing) → "message is too long" /
 *    "message caption is too long"; empty text → "message text is empty"; callback_data 1–64 UTF-8 bytes →
 *    "BUTTON_DATA_INVALID"; inline button without an action → "Text buttons are unallowed in the inline
 *    keyboard"; url/web_app buttons validated (web_app must be https); > 100 inline buttons → error;
 *    answerCallbackQuery text ≤ 200. [strict] explicit `entities`/`caption_entities` must lie inside the text
 *    and must not split a UTF-16 surrogate pair (disable with `strictEntities:false`).
 *  • reply_parameters / reply_to_message_id: target must exist in the same chat (else 400 "message to be replied
 *    not found" unless allow_sending_without_reply). Result carries `reply_to_message`.
 *  • Inline keyboards are echoed in `reply_markup` of results. Reply keyboards are tracked per chat (`keyboard()`).
 *  • Edits (editMessageText/Caption/Media/ReplyMarkup): message must exist, not be deleted and be the bot's own
 *    ("message to edit not found" / "message can't be edited"); text edit of a media message → "there is no text
 *    in the message to edit"; caption edit of a text message → "there is no caption in the message to edit";
 *    identical content+markup → "message is not modified: …". Omitting reply_markup REMOVES the inline keyboard
 *    (like Telegram). editMessageMedia returns the message with the new media (new PhotoSizes/file_ids).
 *  • Blocked chats (`blockChat`) → every method targeting that chat returns 403 "Forbidden: bot was blocked by
 *    the user". Sending to a bot id → 403. `strictChats:true` → sending to a private chat that never talked to
 *    the bot → 403 "Forbidden: bot can't initiate conversation with a user".
 *  • answerCallbackQuery: answering the same query id twice → 400 "query is too old … or query ID is invalid".
 *  • setMessageReaction: target must exist; emoji must be in Telegram's standard reaction list ("REACTION_INVALID").
 *  • setWebhook requires https (empty url deletes); secret_token charset checked; getWebhookInfo reflects it.
 *  • `failNext()` injects errors (e.g. 429 with retry_after, 400 on an edit to test fallbacks).
 *
 * ── Implemented methods ──
 *   getMe logOut close getUpdates setWebhook deleteWebhook getWebhookInfo
 *   sendMessage sendPhoto sendVideo sendAnimation sendDocument sendAudio sendVoice sendVideoNote sendSticker
 *   sendLocation sendContact sendChatAction copyMessage forwardMessage
 *   editMessageText editMessageCaption editMessageMedia editMessageReplyMarkup deleteMessage deleteMessages
 *   answerCallbackQuery setMessageReaction getFile getChat
 *   setMyCommands getMyCommands deleteMyCommands setChatMenuButton getChatMenuButton
 *   setMyDescription getMyDescription setMyShortDescription getMyShortDescription setMyName getMyName
 *
 * ── Test API (returned by startFakeTelegram; all functions are plain closures — safe to destructure) ──
 *   url, port, close()                                  server address / shutdown (closes keep-alive sockets)
 *   calls, callsFor(token, method?), lastCall(token, method?), clear(), reset()
 *        every API call: { seq, token, botId, method, params, files, multipart, ok, result?, error?, uploaded[] }
 *        (`method` matching is case-insensitive; clear() empties calls/downloads, reset() wipes ALL state)
 *   downloads                                            every GET /file/... request { token, path, ok, fileId? }
 *   me(token)                                            the bot's User object
 *   nextUpdateId()                                       monotonically increasing update_id
 *   userMessage(token, from, fields?)  → Message         a user→bot message stored in the chat (id allocated);
 *        fields: any Message fields (text, photo, document, caption, …) + `replyTo` (message id in the chat),
 *        `chat` (override, e.g. a group), `message_id` (override). "/cmd" texts get a bot_command entity.
 *   messageUpdate(token, from, fields?) → Update         { update_id, message: userMessage(...) }
 *   callbackUpdate(token, from, target, data, opts?)     { update_id, callback_query } for a stored message;
 *        target = message id (in the user's private chat or opts.chatId) | ChatMessage | Message;
 *        opts: { chatId?, id?, inaccessible? }  (data is NOT validated — craft malicious data freely)
 *   pressButton(token, from, target, match, opts?)       like callbackUpdate, using the callback_data of the
 *        button whose text/callback_data equals `match` (string) or matches it (RegExp). Throws if missing.
 *   myChatMemberUpdate(token, from, 'kicked'|'member', { apply = true })  apply → block/unblock the chat
 *   editedMessageUpdate(token, from, messageId, fields?) → Update   { update_id, edited_message } for a stored USER
 *        message in the private chat with `from`: `fields` (text, caption, entities, location, …; replyTo/chat/
 *        message_id are ignored) replace the stored ones, edit_date is set, "/cmd" texts get a bot_command entity.
 *        The stored message is updated too (its ChatMessage `edits` counter grows). Throws for bot/missing messages.
 *   sent(token, chatId), lastSent(token, chatId)         bot→user messages (not deleted), current state
 *   chatMessages(token, chatId, { includeDeleted?, fromBot? })   everything in the chat, ordered by id
 *   message(token, chatId, messageId)                    one ChatMessage (incl. deleted)
 *   texts(token, chatId)                                 text/caption of every non-deleted bot message
 *   keyboard(token, chatId)                              last reply keyboard markup sent (null if removed/none)
 *   reactions(token, chatId, messageId)                  emojis set by setMessageReaction
 *   callbackAnswer(queryId), unansweredCallbacks(token?) answers given / callback ids issued but never answered
 *   expireCallback(queryId) → boolean                    forget an issued (unanswered) query, like Telegram does once
 *        it is too old — e.g. after a test made answerCallbackQuery fail on purpose
 *   blockChat(token, chatId), unblockChat(token, chatId), isBlocked(token, chatId), knowChat(token, chatId)
 *   registerFile(token, bytes?, meta?) → StoredFile      a file owned by that bot (meta.type default 'document';
 *        meta.file_size overrides the reported size, e.g. to simulate 25 MB without allocating it)
 *   makeFileId(token, type?, bytes?) → string            shortcut for registerFile(...).file_id
 *   photo(token, bytes?) → PhotoSize[]                   for crafting `message.photo` (bytes default fakeJpeg())
 *   document(token, bytes?, meta?) → Document            for crafting `message.document`
 *   media(token, type, bytes?, meta?)                    video/voice/audio/animation/video_note/sticker objects
 *   fileBytes(fileId), fileInfo(fileId), files(token?)   inspect stored files
 *   failNext(token|null, method, error?, { times?, when? })   make the next matching call(s) fail
 *   webhook(token), commands(token), menuButton(token, chatId?), botInfo(token)
 *
 * Standalone exports: startFakeTelegram, fakeJpeg, fakeWebp, bytesEqual, findButton, buttonData, parseTelegramHtml.
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Document, Message, PhotoSize, Update, User } from 'grammy/types';

// ───────────────────────────── Public types ─────────────────────────────

/** Loosely typed JSON object (Bot API params / objects). */
export type P = Record<string, any>;

export type FileType = 'photo' | 'video' | 'animation' | 'document' | 'audio' | 'voice' | 'video_note' | 'sticker';

export type MessageKind =
  | 'text'
  | 'photo'
  | 'video'
  | 'animation'
  | 'document'
  | 'audio'
  | 'voice'
  | 'video_note'
  | 'sticker'
  | 'location'
  | 'contact'
  | 'other';

export interface StoredFile {
  file_id: string;
  file_unique_id: string;
  botId: number;
  token: string;
  type: FileType;
  bytes: Uint8Array;
  /** Reported size (may be overridden to simulate big files). */
  file_size: number;
  file_path: string;
  file_name?: string;
  mime_type?: string;
  width?: number;
  height?: number;
  duration?: number;
  /** Photos: file_ids of all sizes of this photo (ascending). */
  group?: string[];
  source: 'upload' | 'registered' | 'url';
}

export interface UploadedPart {
  name: string;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface RecordedCall {
  seq: number;
  token: string;
  botId: number;
  /** Method name as it appeared in the URL. */
  method: string;
  /** Decoded parameters (JSON-ish multipart fields are parsed; `attach://x` strings kept as is). */
  params: P;
  /** File parts of a multipart request, keyed by part name. */
  files: Record<string, { filename: string; contentType: string; size: number; bytes: Uint8Array }>;
  multipart: boolean;
  ok: boolean;
  result?: unknown;
  error?: { error_code: number; description: string };
  /** file_ids created from uploads/URLs during this call (photos: the largest size). */
  uploaded: string[];
  at: number;
}

export interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
  web_app?: { url: string };
  row: number;
  col: number;
  [key: string]: unknown;
}

export interface ChatMessage {
  id: number;
  chatId: number;
  fromBot: boolean;
  deleted: boolean;
  /** Bot API method that created it ('user' for helper-created user messages). */
  method: string;
  /** Current Bot API view of the message (after edits). */
  message: Message;
  /** Plain text or caption after entity parsing ('' if none). */
  text: string;
  /** Raw text/caption as passed by the app (before parse_mode parsing). */
  source?: string;
  parseMode?: string;
  /** reply_markup as passed by the app on send / last edit (any keyboard type). */
  markup?: any;
  /** Flattened inline keyboard buttons. */
  buttons: InlineButton[];
  reactions: string[];
  /** Number of successful edits. */
  edits: number;
  kind: MessageKind;
  /** Main file_id (largest photo size for photos). */
  fileId?: string;
}

export interface FakeBotConfig {
  token: string;
  username?: string;
  first_name?: string;
}

export interface FakeTelegramOptions {
  /** Default 0 (random free port). */
  port?: number;
  /** Default 127.0.0.1 */
  host?: string;
  /** Pre-configured bots (username / first_name for getMe). Other well-formed tokens also work. */
  bots?: FakeBotConfig[];
  /** Only tokens listed in `bots` are accepted; others → 401 Unauthorized. Default false. */
  knownTokensOnly?: boolean;
  /** Sending to a private chat the user never started → 403. Default false. */
  strictChats?: boolean;
  /** Explicit entities must be in range and not split surrogate pairs. Default true. */
  strictEntities?: boolean;
  /** Photo uploads must be real images (magic bytes). Default true. */
  validateImages?: boolean;
  /** Log every call to the console. Default: env FAKE_TG_LOG=1 */
  log?: boolean;
}

export interface InjectedError {
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

export interface IncomingFields {
  /** Reply to this message id (must exist in the same chat). */
  replyTo?: number;
  /** Override the chat (default: private chat with `from`). */
  chat?: P;
  /** Override the allocated message id. */
  message_id?: number;
  text?: string;
  caption?: string;
  [key: string]: unknown;
}

export interface FakeTelegram {
  readonly url: string;
  readonly port: number;
  readonly calls: RecordedCall[];
  readonly downloads: Array<{ token: string; path: string; ok: boolean; fileId?: string }>;
  close(): Promise<void>;
  clear(): void;
  reset(): void;
  callsFor(token: string, method?: string): RecordedCall[];
  lastCall(token: string, method?: string): RecordedCall | undefined;
  me(token: string): User;
  nextUpdateId(): number;
  userMessage(token: string, from: User | number, fields?: IncomingFields): Message;
  messageUpdate(token: string, from: User | number, fields?: IncomingFields): Update;
  callbackUpdate(
    token: string,
    from: User | number,
    target: number | ChatMessage | Message,
    data: string,
    opts?: { chatId?: number; id?: string; inaccessible?: boolean },
  ): Update;
  pressButton(
    token: string,
    from: User | number,
    target: number | ChatMessage | Message,
    match: string | RegExp,
    opts?: { chatId?: number; id?: string },
  ): Update;
  myChatMemberUpdate(token: string, from: User | number, status: 'kicked' | 'member', opts?: { apply?: boolean }): Update;
  editedMessageUpdate(token: string, from: User | number, messageId: number, fields?: IncomingFields): Update;
  sent(token: string, chatId: number): ChatMessage[];
  lastSent(token: string, chatId: number): ChatMessage | undefined;
  chatMessages(token: string, chatId: number, opts?: { includeDeleted?: boolean; fromBot?: boolean }): ChatMessage[];
  message(token: string, chatId: number, messageId: number): ChatMessage | undefined;
  texts(token: string, chatId: number): string[];
  keyboard(token: string, chatId: number): any;
  reactions(token: string, chatId: number, messageId: number): string[];
  callbackAnswer(queryId: string): P | undefined;
  unansweredCallbacks(token?: string): string[];
  expireCallback(queryId: string): boolean;
  blockChat(token: string, chatId: number): void;
  unblockChat(token: string, chatId: number): void;
  isBlocked(token: string, chatId: number): boolean;
  knowChat(token: string, chatId: number): void;
  registerFile(token: string, bytes?: Uint8Array, meta?: RegisterFileMeta): StoredFile;
  makeFileId(token: string, type?: FileType, bytes?: Uint8Array): string;
  photo(token: string, bytes?: Uint8Array): PhotoSize[];
  document(token: string, bytes?: Uint8Array, meta?: { file_name?: string; mime_type?: string; file_size?: number }): Document;
  media(token: string, type: FileType, bytes?: Uint8Array, meta?: RegisterFileMeta): any;
  fileBytes(fileId: string): Uint8Array | undefined;
  fileInfo(fileId: string): StoredFile | undefined;
  files(token?: string): StoredFile[];
  failNext(
    token: string | null,
    method: string,
    error?: InjectedError,
    opts?: { times?: number; when?: (params: P) => boolean },
  ): void;
  webhook(token: string): P | null;
  commands(token: string, scope?: P, languageCode?: string): P[];
  menuButton(token: string, chatId?: number): P;
  botInfo(token: string): { description: string; short_description: string; name: string };
}

export interface RegisterFileMeta {
  type?: FileType;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
  file_unique_id?: string;
  width?: number;
  height?: number;
  duration?: number;
  emoji?: string;
}

// ───────────────────────────── Standalone helpers ─────────────────────────────

/** Deterministic-looking JPEG bytes (valid SOI/SOF0/EOI markers, so dimension sniffing works). */
export function fakeJpeg(opts: { width?: number; height?: number; size?: number; seed?: number } = {}): Uint8Array {
  const width = Math.max(1, Math.min(opts.width ?? 640, 65535));
  const height = Math.max(1, Math.min(opts.height ?? 480, 65535));
  const head = [
    0xff, 0xd8, // SOI
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, // APP0
    0xff, 0xc0, 0x00, 0x11, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, // SOF0
    0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00, // SOS
  ];
  const size = Math.max(opts.size ?? 2048, head.length + 16);
  const out = new Uint8Array(size);
  out.set(head);
  let x = (opts.seed ?? Math.floor(Math.random() * 0x7fffffff)) >>> 0 || 0x9e3779b9;
  for (let i = head.length; i < size - 2; i++) {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    out[i] = x % 255; // never 0xff → no accidental markers
  }
  out[size - 2] = 0xff;
  out[size - 1] = 0xd9; // EOI
  return out;
}

/** Minimal RIFF/WEBP container bytes (enough for magic-byte checks). */
export function fakeWebp(size = 512): Uint8Array {
  const n = Math.max(size, 32);
  const out = new Uint8Array(n);
  out.set([0x52, 0x49, 0x46, 0x46]); // RIFF
  new DataView(out.buffer).setUint32(4, n - 8, true);
  out.set([0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c], 8); // WEBPVP8L
  for (let i = 16; i < n; i++) out[i] = (i * 31 + 7) % 251;
  return out;
}

export function bytesEqual(a: Uint8Array | undefined | null, b: Uint8Array | undefined | null): boolean {
  if (!a || !b || a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

function buttonMatches(b: InlineButton, match: string | RegExp): boolean {
  if (typeof match === 'string') return b.text === match || b.callback_data === match;
  return match.test(b.text) || (b.callback_data !== undefined && match.test(b.callback_data));
}

/** Find an inline button by exact text/callback_data (string) or by RegExp over text or callback_data. */
export function findButton(msg: ChatMessage | undefined, match: string | RegExp): InlineButton | undefined {
  return msg?.buttons.find((b) => buttonMatches(b, match));
}

/** callback_data of the matching button (throws if there is none). */
export function buttonData(msg: ChatMessage | undefined, match: string | RegExp): string {
  const b = findButton(msg, match);
  if (!b || b.callback_data === undefined) {
    const list = msg ? msg.buttons.map((x) => `${x.text} → ${x.callback_data ?? x.url ?? (x.web_app ? 'web_app' : '?')}`) : [];
    throw new Error(`[fake-telegram] no callback button matching ${String(match)}. Buttons: ${JSON.stringify(list)}`);
  }
  return b.callback_data;
}

// ───────────────────────────── Internals ─────────────────────────────

class TgError extends Error {
  constructor(
    public code: number,
    public description: string,
    public parameters?: P,
  ) {
    super(description);
  }
}

const bad = (d: string): TgError => new TgError(400, `Bad Request: ${d}`);

const NOT_MODIFIED =
  'message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message';
const WRONG_FILE = 'wrong file identifier/HTTP URL specified';

const TOKEN_RE = /^(\d{1,20}):([A-Za-z0-9_-]{1,200})$/;
const MAX_BODY = 52 * 1024 * 1024;
const MAX_UPLOAD = 50 * 1024 * 1024;
const MAX_PHOTO = 10 * 1024 * 1024;
const MAX_GETFILE = 20 * 1024 * 1024;

const JSON_FIELDS = new Set([
  'reply_markup',
  'entities',
  'caption_entities',
  'reply_parameters',
  'link_preview_options',
  'media',
  'commands',
  'scope',
  'menu_button',
  'allowed_updates',
  'reaction',
  'message_ids',
  'results',
]);
const NUMBER_FIELDS = new Set([
  'chat_id',
  'from_chat_id',
  'message_id',
  'reply_to_message_id',
  'message_thread_id',
  'user_id',
  'latitude',
  'longitude',
  'horizontal_accuracy',
  'live_period',
  'heading',
  'proximity_alert_radius',
  'duration',
  'width',
  'height',
  'length',
  'cache_time',
  'offset',
  'limit',
  'timeout',
  'max_connections',
]);
const BOOL_FIELDS = new Set([
  'disable_notification',
  'protect_content',
  'show_alert',
  'supports_streaming',
  'is_big',
  'drop_pending_updates',
  'has_spoiler',
  'allow_sending_without_reply',
  'disable_web_page_preview',
  'disable_content_type_detection',
  'show_caption_above_media',
  'allow_paid_broadcast',
]);

const ENTITY_TYPES = new Set([
  'mention',
  'hashtag',
  'cashtag',
  'bot_command',
  'url',
  'email',
  'phone_number',
  'bold',
  'italic',
  'underline',
  'strikethrough',
  'spoiler',
  'blockquote',
  'expandable_blockquote',
  'code',
  'pre',
  'text_link',
  'text_mention',
  'custom_emoji',
  'date_time',
]);

const REACTIONS = new Set([
  '👍', '👎', '❤', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱', '🤬', '😢', '🎉', '🤩', '🤮', '💩', '🙏', '👌', '🕊',
  '🤡', '🥱', '🥴', '😍', '🐳', '❤‍🔥', '🌚', '🌭', '💯', '🤣', '⚡', '🍌', '🏆', '💔', '🤨', '😐', '🍓', '🍾', '💋',
  '🖕', '😈', '😴', '😭', '🤓', '👻', '👨‍💻', '👀', '🎃', '🙈', '😇', '😨', '🤝', '✍', '🤗', '🫡', '🎅', '🎄', '☃',
  '💅', '🤪', '🗿', '🆒', '💘', '🙉', '🦄', '😘', '💊', '🙊', '😎', '👾', '🤷‍♂', '🤷', '🤷‍♀', '😡',
]);

const CHAT_ACTIONS = new Set([
  'typing',
  'upload_photo',
  'record_video',
  'upload_video',
  'record_voice',
  'upload_voice',
  'upload_document',
  'choose_sticker',
  'find_location',
  'record_video_note',
  'upload_video_note',
]);

const FOLDERS: Record<FileType, string> = {
  photo: 'photos',
  video: 'videos',
  animation: 'animations',
  document: 'documents',
  audio: 'music',
  voice: 'voice',
  video_note: 'video_notes',
  sticker: 'stickers',
};

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  tgs: 'application/x-tgsticker',
};

const DEFAULT_MIME: Record<FileType, string | undefined> = {
  photo: 'image/jpeg',
  video: 'video/mp4',
  animation: 'video/mp4',
  document: undefined,
  audio: 'audio/mpeg',
  voice: 'audio/ogg',
  video_note: 'video/mp4',
  sticker: 'image/webp',
};

const DEFAULT_EXT: Record<FileType, string> = {
  photo: 'jpg',
  video: 'mp4',
  animation: 'mp4',
  document: 'bin',
  audio: 'mp3',
  voice: 'oga',
  video_note: 'mp4',
  sticker: 'webp',
};

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function clone<T>(v: T): T {
  return v === undefined ? v : structuredClone(v);
}

/** Stable JSON (sorted keys, undefined dropped) for "not modified" comparisons. */
function canon(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) => {
    if (val && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Uint8Array)) {
      const o: P = {};
      for (const k of Object.keys(val as P).sort()) if ((val as P)[k] !== undefined) o[k] = (val as P)[k];
      return o;
    }
    return val;
  });
}

function codePoints(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

function splitsSurrogate(s: string, offset: number): boolean {
  if (offset <= 0 || offset >= s.length) return false;
  const prev = s.charCodeAt(offset - 1);
  const cur = s.charCodeAt(offset);
  return prev >= 0xd800 && prev <= 0xdbff && cur >= 0xdc00 && cur <= 0xdfff;
}

function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('base64url');
}

function toU8(b: Buffer): Uint8Array {
  return new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

function extOf(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return m ? m[1]!.toLowerCase() : undefined;
}

function guessMime(filename: string | undefined, type: FileType): string | undefined {
  const ext = extOf(filename);
  if (ext && MIME_BY_EXT[ext]) return MIME_BY_EXT[ext];
  return DEFAULT_MIME[type] ?? (type === 'document' ? 'application/octet-stream' : undefined);
}

interface ImageInfo {
  kind: 'jpeg' | 'png' | 'gif' | 'webp' | 'bmp';
  width?: number;
  height?: number;
}

function sniffImage(b: Uint8Array): ImageInfo | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1]!;
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      if (marker === 0xda || marker === 0xd9) break;
      const len = (b[i + 2]! << 8) | b[i + 3]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { kind: 'jpeg', height: (b[i + 5]! << 8) | b[i + 6]!, width: (b[i + 7]! << 8) | b[i + 8]! };
      }
      i += 2 + len;
    }
    return { kind: 'jpeg' };
  }
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length >= 24 && PNG.every((v, i) => b[i] === v)) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { kind: 'png', width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    return { kind: 'gif', width: b[6]! | (b[7]! << 8), height: b[8]! | (b[9]! << 8) };
  }
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return { kind: 'webp' };
  }
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return { kind: 'bmp' };
  return null;
}

// ───────────────────────────── HTML parse_mode ─────────────────────────────

const HTML_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'span', 'tg-spoiler', 'a', 'code', 'pre', 'blockquote', 'tg-emoji',
]);

function decodeEntityAt(src: string, i: number): { text: string; len: number } | null {
  const m = /^&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,8});/.exec(src.slice(i, i + 12));
  if (!m) return null;
  const name = m[1]!;
  if (name[0] === '#') {
    const cp = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
    return { text: String.fromCodePoint(cp), len: m[0].length };
  }
  const named: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"' };
  const t = named[name.toLowerCase()];
  return t === undefined ? null : { text: t, len: m[0].length };
}

/**
 * Telegram-compatible HTML parse_mode parser. Returns plain text + entities (UTF-16 offsets) or throws a
 * TgError with Telegram's "can't parse entities" message. Exported for unit tests.
 */
export function parseTelegramHtml(src: string): { text: string; entities: P[] } {
  let out = '';
  const stack: Array<{ tag: string; start: number; attrs: Record<string, string> }> = [];
  const entities: P[] = [];
  const err = (msg: string) => bad(`can't parse entities: ${msg}`);
  const byteOff = (i: number) => utf8Bytes(src.slice(0, i));
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '&') {
      const d = decodeEntityAt(src, i);
      if (d) {
        out += d.text;
        i += d.len;
      } else {
        out += '&';
        i++;
      }
      continue;
    }
    if (ch !== '<') {
      out += ch;
      i++;
      continue;
    }
    const tagOffset = byteOff(i);
    if (src[i + 1] === '/') {
      const m = /^<\/([^>\s]*)\s*>/.exec(src.slice(i));
      if (!m) throw err(`Unclosed end tag at byte offset ${tagOffset}`);
      const name = m[1]!.toLowerCase();
      const open = stack.pop();
      if (!open) throw err(`Unexpected end tag at byte offset ${tagOffset}`);
      if (open.tag !== name) {
        throw err(`Unmatched end tag at byte offset ${tagOffset}, expected "</${open.tag}>", found "</${name}>"`);
      }
      const length = out.length - open.start;
      if (length > 0) {
        const e = entityFor(open.tag, open.attrs, open.start, length, stack);
        if (e) entities.push(e);
      }
      i += m[0].length;
      continue;
    }
    // start tag
    let j = i + 1;
    while (j < src.length && /[A-Za-z0-9-]/.test(src[j]!)) j++;
    const name = src.slice(i + 1, j).toLowerCase();
    if (!HTML_TAGS.has(name)) throw err(`Unsupported start tag "${name}" at byte offset ${tagOffset}`);
    const attrs: Record<string, string> = {};
    for (;;) {
      while (j < src.length && /\s/.test(src[j]!)) j++;
      if (j >= src.length) throw err(`Unclosed start tag at byte offset ${tagOffset}`);
      if (src[j] === '>') {
        j++;
        break;
      }
      const a0 = j;
      while (j < src.length && /[A-Za-z0-9_-]/.test(src[j]!)) j++;
      const attr = src.slice(a0, j).toLowerCase();
      if (!attr) throw err(`Empty attribute name in the tag "${name}" at byte offset ${tagOffset}`);
      while (j < src.length && /\s/.test(src[j]!)) j++;
      let value = '';
      if (src[j] === '=') {
        j++;
        while (j < src.length && /\s/.test(src[j]!)) j++;
        const q = src[j];
        if (q === '"' || q === "'") {
          const end = src.indexOf(q, j + 1);
          if (end < 0) throw err(`Unclosed start tag at byte offset ${tagOffset}`);
          value = src.slice(j + 1, end);
          j = end + 1;
        } else {
          const v0 = j;
          while (j < src.length && !/[\s>]/.test(src[j]!)) j++;
          value = src.slice(v0, j);
        }
        // decode entities inside the attribute value
        let decoded = '';
        for (let k = 0; k < value.length; ) {
          if (value[k] === '&') {
            const d = decodeEntityAt(value, k);
            if (d) {
              decoded += d.text;
              k += d.len;
              continue;
            }
          }
          decoded += value[k];
          k++;
        }
        value = decoded;
      }
      attrs[attr] = value;
    }
    if (name === 'span' && attrs.class !== 'tg-spoiler') {
      throw err(`Tag "span" must have class "tg-spoiler" at byte offset ${tagOffset}`);
    }
    if (name === 'tg-emoji' && !/^\d+$/.test(attrs['emoji-id'] ?? '')) {
      throw err(`Custom emoji entity must contain a valid custom emoji identifier at byte offset ${tagOffset}`);
    }
    stack.push({ tag: name, start: out.length, attrs });
    i = j;
  }
  if (stack.length) throw err(`Can't find end tag corresponding to start tag "${stack[stack.length - 1]!.tag}"`);
  entities.sort((a, b) => a.offset - b.offset || b.length - a.length);
  return { text: out, entities: cleanHtmlEntities(entities) };
}

function entityFor(
  tag: string,
  attrs: Record<string, string>,
  offset: number,
  length: number,
  parents: Array<{ tag: string }>,
): P | null {
  switch (tag) {
    case 'b':
    case 'strong':
      return { type: 'bold', offset, length };
    case 'i':
    case 'em':
      return { type: 'italic', offset, length };
    case 'u':
    case 'ins':
      return { type: 'underline', offset, length };
    case 's':
    case 'strike':
    case 'del':
      return { type: 'strikethrough', offset, length };
    case 'span':
    case 'tg-spoiler':
      return { type: 'spoiler', offset, length };
    case 'a': {
      const href = (attrs.href ?? '').trim();
      if (!href) return null;
      const m = /^tg:\/\/user\?id=(\d+)$/.exec(href);
      if (m) return { type: 'text_mention', offset, length, user: { id: Number(m[1]), is_bot: false, first_name: '' } };
      return { type: 'text_link', offset, length, url: href };
    }
    case 'code': {
      if (parents.length && parents[parents.length - 1]!.tag === 'pre') {
        const lang = /^language-(.+)$/.exec(attrs.class ?? '');
        return { type: 'pre', offset, length, ...(lang ? { language: lang[1] } : {}), __inPre: true };
      }
      return { type: 'code', offset, length };
    }
    case 'pre':
      return { type: 'pre', offset, length };
    case 'blockquote':
      return { type: 'expandable' in attrs ? 'expandable_blockquote' : 'blockquote', offset, length };
    case 'tg-emoji':
      return { type: 'custom_emoji', offset, length, custom_emoji_id: attrs['emoji-id'] };
    default:
      return null;
  }
}

function cleanHtmlEntities(list: P[]): P[] {
  // <pre><code class="language-x"> → a single pre entity with language
  const out: P[] = [];
  for (const e of list) {
    if (e.__inPre) {
      const pre = list.find((p) => p !== e && p.type === 'pre' && !p.__inPre && p.offset === e.offset && p.length === e.length);
      if (pre && e.language) pre.language = e.language;
      if (pre) continue;
      const { __inPre, ...rest } = e;
      void __inPre;
      out.push(rest);
      continue;
    }
    out.push(e);
  }
  return out;
}

// ───────────────────────────── Multipart ─────────────────────────────

function parseDisposition(v: string): { name?: string; filename?: string } {
  const out: { name?: string; filename?: string } = {};
  const re = /;\s*([A-Za-z0-9_*-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(v))) {
    const key = m[1]!.toLowerCase();
    let val = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : (m[3] ?? '').trim();
    if (key === 'filename*') {
      const mm = /^[^']*'[^']*'(.*)$/.exec(val);
      if (mm) {
        try {
          val = decodeURIComponent(mm[1]!);
        } catch {
          /* keep raw */
        }
      }
      out.filename = val;
    } else if (key === 'name') {
      out.name = val;
    } else if (key === 'filename' && out.filename === undefined) {
      out.filename = val;
    }
  }
  return out;
}

function parseMultipart(body: Buffer, contentType: string): { fields: Map<string, string>; parts: Map<string, UploadedPart> } {
  const bm = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  if (!bm) throw bad("can't parse multipart/form-data: boundary is not specified");
  const boundary = bm[1] ?? bm[2]!;
  const delim = Buffer.from(`--${boundary}`);
  const inner = Buffer.from(`\r\n--${boundary}`);
  const fields = new Map<string, string>();
  const parts = new Map<string, UploadedPart>();
  let pos = body.indexOf(delim);
  if (pos < 0) throw bad("can't parse multipart/form-data: boundary not found in body");
  for (;;) {
    pos += delim.length;
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break; // closing delimiter
    while (body[pos] === 0x20 || body[pos] === 0x09) pos++;
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;
    else if (body[pos] === 0x0a) pos += 1;
    const headerEnd = body.indexOf('\r\n\r\n', pos);
    if (headerEnd < 0) throw bad("can't parse multipart/form-data: part headers are not terminated");
    const headers = body.subarray(pos, headerEnd).toString('utf8');
    const contentStart = headerEnd + 4;
    const next = body.indexOf(inner, contentStart);
    if (next < 0) throw bad("can't parse multipart/form-data: closing boundary not found");
    const content = body.subarray(contentStart, next);
    let disposition = '';
    let partType = '';
    for (const line of headers.split(/\r?\n/)) {
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const k = line.slice(0, idx).trim().toLowerCase();
      const v = line.slice(idx + 1).trim();
      if (k === 'content-disposition') disposition = v;
      else if (k === 'content-type') partType = v;
    }
    const d = parseDisposition(disposition.replace(/^[^;]*/, ''));
    if (d.name !== undefined) {
      if (d.filename !== undefined) {
        parts.set(d.name, {
          name: d.name,
          filename: d.filename || d.name,
          contentType: partType || 'application/octet-stream',
          bytes: toU8(content),
        });
      } else {
        fields.set(d.name, content.toString('utf8'));
      }
    }
    pos = next + 2; // now at "--boundary"
  }
  return { fields, parts };
}

function coerceField(key: string, v: string): unknown {
  const t = v.trim();
  if (JSON_FIELDS.has(key) && (t.startsWith('{') || t.startsWith('['))) {
    try {
      return JSON.parse(t);
    } catch {
      throw bad(`can't parse ${key} JSON object`);
    }
  }
  if (NUMBER_FIELDS.has(key) && /^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (BOOL_FIELDS.has(key) && (t === 'true' || t === 'false')) return t === 'true';
  return v;
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on('data', (c: Buffer) => {
      if (failed) return;
      size += c.length;
      if (size > limit) {
        failed = true;
        reject(new TgError(413, 'Request Entity Too Large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', (e) => {
      if (!failed) reject(e);
    });
  });
}

// ───────────────────────────── State ─────────────────────────────

interface StoredMessage {
  chatId: number;
  id: number;
  fromBot: boolean;
  method: string;
  message: P;
  sourceText?: string;
  parseMode?: string;
  markup?: unknown;
  deleted: boolean;
  reactions: string[];
  edits: P[];
}

interface ChatState {
  id: number;
  nextId: number;
  messages: Map<number, StoredMessage>;
  keyboard: unknown;
  blocked: boolean;
  known: boolean;
  menuButton?: P;
}

interface BotState {
  token: string;
  id: number;
  username: string;
  firstName: string;
  chats: Map<number, ChatState>;
  webhook: P | null;
  commands: Map<string, P[]>;
  defaultMenuButton: P | null;
  description: string;
  shortDescription: string;
  name: string;
}

interface Ctx {
  bot: BotState;
  p: P;
  parts: Map<string, UploadedPart>;
  call: RecordedCall;
}

interface Formatted {
  text: string;
  entities: P[];
  source: string;
  parseMode?: string;
}

interface Injection {
  token: string | null;
  method: string;
  error: InjectedError;
  times: number;
  when?: (params: P) => boolean;
}

const MEDIA_KINDS: MessageKind[] = ['photo', 'video', 'animation', 'audio', 'document'];

function detectKind(m: P): MessageKind {
  if (typeof m.text === 'string') return 'text';
  if (m.photo) return 'photo';
  if (m.animation) return 'animation';
  if (m.video) return 'video';
  if (m.document) return 'document';
  if (m.audio) return 'audio';
  if (m.voice) return 'voice';
  if (m.video_note) return 'video_note';
  if (m.sticker) return 'sticker';
  if (m.location || m.venue) return 'location';
  if (m.contact) return 'contact';
  return 'other';
}

function mainFileId(m: P, kind: MessageKind): string | undefined {
  if (kind === 'photo') return m.photo?.[m.photo.length - 1]?.file_id;
  const obj = m[kind];
  return obj && typeof obj === 'object' && typeof obj.file_id === 'string' ? obj.file_id : undefined;
}

function flattenButtons(markup: unknown): InlineButton[] {
  const rows = (markup as P | undefined)?.inline_keyboard;
  if (!Array.isArray(rows)) return [];
  const out: InlineButton[] = [];
  rows.forEach((row: unknown, r: number) => {
    if (!Array.isArray(row)) return;
    row.forEach((b: P, c: number) => out.push({ ...clone(b), text: String(b?.text ?? ''), row: r, col: c }));
  });
  return out;
}

/** Copy of a message suitable for `reply_to_message` (no nested reply). */
function stripReply(m: P): P {
  const { reply_to_message, ...rest } = clone(m);
  void reply_to_message;
  return rest;
}

function baseOf(m: P): P {
  const out: P = { message_id: m.message_id, from: clone(m.from), chat: clone(m.chat), date: m.date };
  if (m.reply_to_message) out.reply_to_message = clone(m.reply_to_message);
  return out;
}

function withoutEditDate(m: P): P {
  const { edit_date, ...rest } = m;
  void edit_date;
  return rest;
}

// ───────────────────────────── Server ─────────────────────────────

export async function startFakeTelegram(options: FakeTelegramOptions = {}): Promise<FakeTelegram> {
  const opts = {
    host: '127.0.0.1',
    port: 0,
    knownTokensOnly: false,
    strictChats: false,
    strictEntities: true,
    validateImages: true,
    log: process.env.FAKE_TG_LOG === '1',
    ...options,
  };

  const configured = new Map<string, FakeBotConfig>();
  for (const b of opts.bots ?? []) configured.set(b.token, b);

  let bots = new Map<string, BotState>();
  let files = new Map<string, StoredFile>();
  let filePaths = new Map<string, StoredFile>();
  let users = new Map<number, P>();
  let chatInfo = new Map<number, P>();
  let issuedCallbacks = new Map<string, { token: string; data: string; chatId: number; messageId: number }>();
  let answers = new Map<string, P>();
  let injections: Injection[] = [];
  const calls: RecordedCall[] = [];
  const downloads: Array<{ token: string; path: string; ok: boolean; fileId?: string }> = [];
  let fileSeq = 0;
  let callSeq = 0;
  let cbSeq = 0;
  let updateSeq = 100000;

  // ── state helpers ──

  function botFor(token: string): BotState {
    let b = bots.get(token);
    if (!b) {
      const m = TOKEN_RE.exec(token);
      if (!m) throw new Error(`[fake-telegram] malformed bot token: ${token}`);
      const id = Number(m[1]);
      const cfg = configured.get(token);
      b = {
        token,
        id,
        username: cfg?.username ?? `bot${id}_bot`,
        firstName: cfg?.first_name ?? cfg?.username ?? `Bot ${id}`,
        chats: new Map(),
        webhook: null,
        commands: new Map(),
        defaultMenuButton: null,
        description: '',
        shortDescription: '',
        name: cfg?.first_name ?? cfg?.username ?? `Bot ${id}`,
      };
      bots.set(token, b);
    }
    return b;
  }

  function botUserShort(b: BotState): P {
    return { id: b.id, is_bot: true, first_name: b.firstName, username: b.username };
  }

  function botUserFull(b: BotState): P {
    return {
      ...botUserShort(b),
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
    };
  }

  function chatState(b: BotState, id: number): ChatState {
    let c = b.chats.get(id);
    if (!c) {
      c = { id, nextId: 1, messages: new Map(), keyboard: null, blocked: false, known: false };
      b.chats.set(id, c);
    }
    return c;
  }

  function chatObject(id: number): P {
    const custom = chatInfo.get(id);
    if (custom) return clone(custom);
    if (id < 0) return { id, type: 'supergroup', title: `Group ${id}` };
    const u = users.get(id);
    if (!u) return { id, type: 'private', first_name: `User${id}` };
    return {
      id,
      type: 'private',
      first_name: u.first_name,
      ...(u.last_name ? { last_name: u.last_name } : {}),
      ...(u.username ? { username: u.username } : {}),
    };
  }

  function resolveUser(from: User | number | P): P {
    if (typeof from === 'number') return clone(users.get(from) ?? { id: from, is_bot: false, first_name: `User${from}` });
    users.set(from.id, clone(from as P));
    return clone(from as P);
  }

  function isBotId(id: number): boolean {
    for (const b of bots.values()) if (b.id === id) return true;
    for (const t of configured.keys()) if (Number(t.split(':')[0]) === id) return true;
    return false;
  }

  function chatFor(c: Ctx, o: { key?: string; send?: boolean; allowBlocked?: boolean } = {}): ChatState {
    const key = o.key ?? 'chat_id';
    const raw = c.p[key];
    if (raw === undefined || raw === null || raw === '') throw bad(`${key} is empty`);
    let id: number;
    if (typeof raw === 'number') id = raw;
    else if (typeof raw === 'string' && /^-?\d+$/.test(raw.trim())) id = Number(raw.trim());
    else throw bad('chat not found');
    if (!Number.isSafeInteger(id) || id === 0) throw bad('chat not found');
    if (o.send && id > 0 && isBotId(id)) throw new TgError(403, "Forbidden: bot can't send messages to bots");
    const chat = chatState(c.bot, id);
    if (id < 0 && !chat.known) throw bad('chat not found');
    if (chat.blocked && !o.allowBlocked) throw new TgError(403, 'Forbidden: bot was blocked by the user');
    if (o.send && opts.strictChats && !chat.known) {
      throw new TgError(403, "Forbidden: bot can't initiate conversation with a user");
    }
    return chat;
  }

  // ── text / markup validation ──

  function checkEntities(text: string, list: unknown): P[] {
    if (!Array.isArray(list)) throw bad("can't parse entities: entities must be an Array");
    const out: P[] = [];
    for (const e of list as unknown[]) {
      if (!e || typeof e !== 'object') throw bad("can't parse MessageEntity: Object expected");
      const ent = e as P;
      if (!ENTITY_TYPES.has(ent.type)) throw bad("can't parse MessageEntity: Unsupported type specified");
      if (!Number.isInteger(ent.offset) || !Number.isInteger(ent.length) || ent.offset < 0 || ent.length <= 0) {
        throw bad("can't parse MessageEntity: Field \"offset\"/\"length\" must be a non-negative Integer");
      }
      if (ent.type === 'text_link' && typeof ent.url !== 'string') {
        throw bad("can't parse MessageEntity: Field \"url\" must be of type String");
      }
      if (opts.strictEntities) {
        if (ent.offset + ent.length > text.length) {
          throw bad(
            `can't parse entities: ${ent.type} entity (offset ${ent.offset}, length ${ent.length}) is outside of the text (UTF-16 length ${text.length}) [fake-telegram strict check]`,
          );
        }
        if (splitsSurrogate(text, ent.offset) || splitsSurrogate(text, ent.offset + ent.length)) {
          throw bad(
            `can't parse entities: ${ent.type} entity (offset ${ent.offset}, length ${ent.length}) splits a UTF-16 surrogate pair [fake-telegram strict check]`,
          );
        }
      }
      out.push(clone(ent));
    }
    return out.sort((a, b) => a.offset - b.offset);
  }

  function formatted(
    obj: P,
    textKey: string,
    entKey: string,
    parseModeRaw: unknown,
    limit: number,
    tooLong: string,
  ): Formatted | null {
    const raw = obj[textKey];
    if (raw === undefined || raw === null) return null;
    const source = typeof raw === 'string' ? raw : String(raw);
    const parseMode = typeof parseModeRaw === 'string' && parseModeRaw ? parseModeRaw : undefined;
    let text = source;
    let entities: P[] = [];
    const given = obj[entKey];
    if (given !== undefined && given !== null) {
      entities = checkEntities(text, given);
    } else if (parseMode) {
      const mode = parseMode.toLowerCase();
      if (mode === 'html') {
        const r = parseTelegramHtml(source);
        text = r.text;
        entities = r.entities;
      } else if (mode !== 'markdown' && mode !== 'markdownv2') {
        throw bad('unsupported parse_mode');
      }
    }
    if (codePoints(text) > limit) throw bad(tooLong);
    return { text, entities, source, parseMode };
  }

  function checkUrl(u: unknown, what: string, httpsOnly: boolean): void {
    if (typeof u !== 'string' || !u) throw bad(`${what} is empty`);
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      throw bad(`${what} '${u}' is invalid: Wrong HTTP URL`);
    }
    if (httpsOnly) {
      if (parsed.protocol !== 'https:') throw bad(`${what} '${u}' is invalid: Only HTTPS links are allowed`);
    } else if (!['http:', 'https:', 'tg:'].includes(parsed.protocol)) {
      throw bad(`${what} '${u}' is invalid: Wrong HTTP URL`);
    }
  }

  function checkInlineButton(b: unknown): void {
    if (!b || typeof b !== 'object') throw bad("can't parse inline keyboard button: InlineKeyboardButton must be an Object");
    const btn = b as P;
    if (typeof btn.text !== 'string') throw bad("can't parse inline keyboard button: Field \"text\" must be of type String");
    if (!btn.text.trim()) throw bad("can't parse inline keyboard button: Text is empty");
    const actions = [
      'callback_data',
      'url',
      'web_app',
      'login_url',
      'switch_inline_query',
      'switch_inline_query_current_chat',
      'switch_inline_query_chosen_chat',
      'copy_text',
      'callback_game',
      'pay',
    ].filter((k) => btn[k] !== undefined);
    if (!actions.length) throw bad("can't parse inline keyboard button: Text buttons are unallowed in the inline keyboard");
    if (btn.callback_data !== undefined) {
      if (typeof btn.callback_data !== 'string') throw bad("can't parse inline keyboard button: Field \"callback_data\" must be of type String");
      const n = utf8Bytes(btn.callback_data);
      if (n < 1 || n > 64) throw bad('BUTTON_DATA_INVALID');
    }
    if (btn.url !== undefined) checkUrl(btn.url, 'inline keyboard button URL', false);
    if (btn.web_app !== undefined) checkUrl(btn.web_app?.url, 'inline keyboard button Web App URL', true);
  }

  function checkMarkup(markup: unknown, inlineOnly: boolean): void {
    if (markup === undefined || markup === null) return;
    if (typeof markup !== 'object' || Array.isArray(markup)) throw bad("can't parse reply keyboard markup JSON object");
    const mk = markup as P;
    if (mk.inline_keyboard !== undefined) {
      if (!Array.isArray(mk.inline_keyboard)) throw bad("can't parse inline keyboard markup: Field \"inline_keyboard\" must be an Array");
      let count = 0;
      for (const row of mk.inline_keyboard) {
        if (!Array.isArray(row)) throw bad("can't parse inline keyboard markup: Field \"inline_keyboard\" must be an Array of Arrays");
        for (const b of row) {
          count++;
          checkInlineButton(b);
        }
      }
      if (count > 100) throw bad('reply markup is too long');
      return;
    }
    if (inlineOnly) throw bad('inline keyboard expected');
    if (mk.keyboard !== undefined) {
      if (!Array.isArray(mk.keyboard)) throw bad("can't parse keyboard markup: Field \"keyboard\" must be an Array");
      for (const row of mk.keyboard) {
        if (!Array.isArray(row)) throw bad("can't parse keyboard markup: Field \"keyboard\" must be an Array of Arrays");
        for (const b of row) {
          const text = typeof b === 'string' ? b : (b as P)?.text;
          if (typeof text !== 'string' || !text.trim()) throw bad("can't parse keyboard button: Text is empty");
          if (typeof b === 'object' && (b as P).web_app !== undefined) {
            checkUrl((b as P).web_app?.url, 'keyboard button Web App URL', true);
          }
        }
      }
      return;
    }
    if (mk.remove_keyboard === true || mk.force_reply === true) return;
    throw bad("can't parse reply keyboard markup JSON object");
  }

  function replyTarget(chat: ChatState, p: P): P | undefined {
    let rp = p.reply_parameters;
    if ((rp === undefined || rp === null) && p.reply_to_message_id !== undefined && p.reply_to_message_id !== null) {
      rp = { message_id: p.reply_to_message_id, allow_sending_without_reply: p.allow_sending_without_reply };
    }
    if (rp === undefined || rp === null) return undefined;
    if (typeof rp !== 'object') throw bad("can't parse reply parameters JSON object");
    const sameChat = rp.chat_id === undefined || rp.chat_id === null || Number(rp.chat_id) === chat.id;
    const target = sameChat ? chat.messages.get(Number(rp.message_id)) : undefined;
    if (!target || target.deleted) {
      if (rp.allow_sending_without_reply === true) return undefined;
      throw bad('message to be replied not found');
    }
    return stripReply(target.message);
  }

  function updateKeyboardState(chat: ChatState, markup: unknown): void {
    const mk = markup as P | undefined;
    if (!mk || typeof mk !== 'object') return;
    if (Array.isArray(mk.keyboard)) chat.keyboard = clone(mk);
    else if (mk.remove_keyboard === true) chat.keyboard = null;
  }

  function deliver(c: Ctx, chat: ChatState, replyTo: P | undefined, content: P, extra: { sourceText?: string; parseMode?: string } = {}): P {
    const markup = c.p.reply_markup;
    const id = chat.nextId++;
    const msg: P = { message_id: id, from: botUserShort(c.bot), chat: chatObject(chat.id), date: nowSec(), ...content };
    if (replyTo) msg.reply_to_message = replyTo;
    if (markup && typeof markup === 'object' && Array.isArray((markup as P).inline_keyboard)) {
      msg.reply_markup = { inline_keyboard: clone((markup as P).inline_keyboard) };
    }
    updateKeyboardState(chat, markup);
    chat.messages.set(id, {
      chatId: chat.id,
      id,
      fromBot: true,
      method: c.call.method,
      message: msg,
      sourceText: extra.sourceText,
      parseMode: extra.parseMode,
      markup: clone(markup),
      deleted: false,
      reactions: [],
      edits: [],
    });
    return clone(msg);
  }

  // ── files ──

  function newFile(
    b: BotState,
    type: FileType,
    bytes: Uint8Array,
    meta: RegisterFileMeta & { uniqueSuffix?: string },
    source: StoredFile['source'],
  ): StoredFile {
    const n = ++fileSeq;
    const file_id = `F_${b.id}_${n}`;
    const ext = extOf(meta.file_name) ?? DEFAULT_EXT[type];
    const f: StoredFile = {
      file_id,
      file_unique_id: meta.file_unique_id ?? `U${sha(bytes).slice(0, 15)}${meta.uniqueSuffix ?? ''}`,
      botId: b.id,
      token: b.token,
      type,
      bytes,
      file_size: meta.file_size ?? bytes.byteLength,
      file_path: `${FOLDERS[type]}/file_${n}.${ext}`,
      ...(meta.file_name !== undefined ? { file_name: meta.file_name } : {}),
      ...(meta.mime_type !== undefined ? { mime_type: meta.mime_type } : {}),
      ...(meta.width !== undefined ? { width: meta.width } : {}),
      ...(meta.height !== undefined ? { height: meta.height } : {}),
      ...(meta.duration !== undefined ? { duration: meta.duration } : {}),
      source,
    };
    files.set(file_id, f);
    filePaths.set(`${b.token}\n${f.file_path}`, f);
    return f;
  }

  function newPhoto(b: BotState, bytes: Uint8Array, source: StoredFile['source'], meta: RegisterFileMeta = {}): StoredFile[] {
    const info = sniffImage(bytes);
    const w0 = meta.width ?? info?.width ?? 800;
    const h0 = meta.height ?? info?.height ?? 600;
    const maxSide = Math.max(w0, h0, 1);
    const scale = maxSide > 2560 ? 2560 / maxSide : 1;
    const finalSide = maxSide * scale;
    const sizes: StoredFile[] = [];
    const base = meta.file_unique_id ?? `U${sha(bytes).slice(0, 15)}`;
    for (const t of [90, 320, 800].filter((x) => x < finalSide)) {
      const s = t / maxSide;
      const head = bytes.subarray(0, Math.min(bytes.byteLength, 16 + t));
      const thumb = new Uint8Array(head.byteLength + 4);
      thumb.set(head);
      thumb.set([0xff, 0xd9, t & 0xff, (t >> 8) & 0xff], head.byteLength);
      sizes.push(
        newFile(b, 'photo', thumb, { width: Math.max(1, Math.round(w0 * s)), height: Math.max(1, Math.round(h0 * s)), file_unique_id: `${base}_${t}` }, source),
      );
    }
    sizes.push(
      newFile(
        b,
        'photo',
        bytes,
        { width: Math.max(1, Math.round(w0 * scale)), height: Math.max(1, Math.round(h0 * scale)), file_unique_id: base, file_size: meta.file_size },
        source,
      ),
    );
    const group = sizes.map((f) => f.file_id);
    for (const f of sizes) f.group = group;
    return sizes;
  }

  function fileObject(f: StoredFile, type: FileType): any {
    const base = { file_id: f.file_id, file_unique_id: f.file_unique_id, file_size: f.file_size };
    switch (type) {
      case 'photo':
        return (f.group ?? [f.file_id]).map((id) => {
          const s = files.get(id) ?? f;
          return { file_id: s.file_id, file_unique_id: s.file_unique_id, file_size: s.file_size, width: s.width ?? 800, height: s.height ?? 600 };
        });
      case 'video':
        return {
          ...base,
          width: f.width ?? 640,
          height: f.height ?? 360,
          duration: f.duration ?? 5,
          mime_type: f.mime_type ?? 'video/mp4',
          ...(f.file_name ? { file_name: f.file_name } : {}),
        };
      case 'animation':
        return {
          ...base,
          width: f.width ?? 320,
          height: f.height ?? 240,
          duration: f.duration ?? 3,
          mime_type: f.mime_type ?? 'video/mp4',
          ...(f.file_name ? { file_name: f.file_name } : {}),
        };
      case 'document':
        return { ...base, ...(f.file_name ? { file_name: f.file_name } : {}), ...(f.mime_type ? { mime_type: f.mime_type } : {}) };
      case 'audio':
        return {
          ...base,
          duration: f.duration ?? 30,
          mime_type: f.mime_type ?? 'audio/mpeg',
          ...(f.file_name ? { file_name: f.file_name } : {}),
        };
      case 'voice':
        return { ...base, duration: f.duration ?? 3, mime_type: f.mime_type ?? 'audio/ogg' };
      case 'video_note':
        return { ...base, length: f.width ?? 240, duration: f.duration ?? 5 };
      case 'sticker':
        return {
          ...base,
          type: 'regular',
          width: f.width ?? 512,
          height: f.height ?? 512,
          is_animated: f.mime_type === 'application/x-tgsticker',
          is_video: f.mime_type === 'video/webm',
        };
    }
  }

  function compatible(stored: FileType, wanted: FileType): boolean {
    if (stored === wanted) return true;
    if (wanted === 'document') return stored === 'animation' || stored === 'video' || stored === 'audio';
    if (wanted === 'animation') return stored === 'document';
    return false;
  }

  function storeUpload(c: Ctx, type: FileType, part: UploadedPart, source: StoredFile['source'], meta: P = {}): StoredFile {
    const bytes = part.bytes;
    if (!bytes.byteLength) throw bad('file must be non-empty');
    let file: StoredFile;
    if (type === 'photo') {
      if (bytes.byteLength > MAX_PHOTO) throw bad('PHOTO_INVALID_DIMENSIONS');
      if (opts.validateImages && !sniffImage(bytes)) throw bad('IMAGE_PROCESS_FAILED');
      const sizes = newPhoto(c.bot, bytes, source);
      file = sizes[sizes.length - 1]!;
    } else {
      if (bytes.byteLength > MAX_UPLOAD) throw new TgError(413, 'Request Entity Too Large');
      const mime = part.contentType && part.contentType !== 'application/octet-stream' ? part.contentType : guessMime(part.filename, type);
      const keepName = type === 'document' || type === 'audio' || type === 'video' || type === 'animation';
      const img = type === 'sticker' || type === 'video' || type === 'animation' ? sniffImage(bytes) : null;
      file = newFile(
        c.bot,
        type,
        bytes,
        {
          ...(keepName ? { file_name: part.filename } : {}),
          ...(mime ? { mime_type: mime } : {}),
          width: typeof meta.width === 'number' ? meta.width : type === 'video_note' && typeof meta.length === 'number' ? meta.length : img?.width,
          height: typeof meta.height === 'number' ? meta.height : img?.height,
          duration: typeof meta.duration === 'number' ? meta.duration : undefined,
        },
        source,
      );
    }
    c.call.uploaded.push(file.file_id);
    return file;
  }

  async function fetchUrl(u: string): Promise<{ bytes: Uint8Array; contentType: string }> {
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? '' };
    } catch {
      throw bad('failed to get HTTP URL content');
    }
  }

  async function resolveMedia(c: Ctx, value: unknown, type: FileType, field: string, meta: P = {}): Promise<StoredFile> {
    let part: UploadedPart | undefined;
    if (value === undefined || value === null || value === '') {
      part = c.parts.get(field);
      if (!part) throw bad(`there is no ${field} in the request`);
    } else if (typeof value === 'string' && value.startsWith('attach://')) {
      part = c.parts.get(value.slice('attach://'.length));
      if (!part) throw bad(WRONG_FILE);
    } else if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
      const { bytes, contentType } = await fetchUrl(value);
      let name = field;
      try {
        name = decodeURIComponent(new URL(value).pathname.split('/').pop() || field);
      } catch {
        /* keep default name */
      }
      return storeUpload(c, type, { name: field, filename: name, contentType: contentType.split(';')[0]!.trim(), bytes }, 'url', meta);
    } else if (typeof value === 'string') {
      const f = files.get(value.trim());
      if (!f || f.botId !== c.bot.id) throw bad(WRONG_FILE);
      if (!compatible(f.type, type)) throw bad('type of file mismatch');
      return f;
    } else {
      throw bad(WRONG_FILE);
    }
    return storeUpload(c, type, part, 'upload', meta);
  }

  // ── edits ──

  function editTarget(c: Ctx): StoredMessage {
    const chat = chatFor(c);
    const id = Number(c.p.message_id);
    if (!Number.isInteger(id) || id <= 0) throw bad('message identifier is not specified');
    const m = chat.messages.get(id);
    if (!m || m.deleted) throw bad('message to edit not found');
    if (!m.fromBot) throw bad("message can't be edited");
    return m;
  }

  function applyEdit(s: StoredMessage, next: P, markup: unknown, fmt?: Formatted | null, keepSource = false): P {
    if (canon(withoutEditDate(next)) === canon(withoutEditDate(s.message))) throw bad(NOT_MODIFIED);
    next.edit_date = nowSec();
    s.edits.push(s.message);
    s.message = next;
    s.markup = clone(markup);
    if (!keepSource) {
      s.sourceText = fmt?.source;
      s.parseMode = fmt?.parseMode;
    }
    return clone(next);
  }

  function inlineMarkupOf(markup: unknown): P | undefined {
    return markup && typeof markup === 'object' && Array.isArray((markup as P).inline_keyboard)
      ? { inline_keyboard: clone((markup as P).inline_keyboard) }
      : undefined;
  }

  // ── method handlers ──

  async function sendMedia(c: Ctx, type: FileType): Promise<P> {
    const chat = chatFor(c, { send: true });
    const captionless = type === 'sticker' || type === 'video_note';
    const cap = captionless ? null : formatted(c.p, 'caption', 'caption_entities', c.p.parse_mode, 1024, 'message caption is too long');
    checkMarkup(c.p.reply_markup, false);
    const replyTo = replyTarget(chat, c.p);
    const file = await resolveMedia(c, c.p[type], type, type, c.p);
    const content: P = { [type]: fileObject(file, type) };
    if (type === 'animation') content.document = fileObject(file, 'document');
    if (type === 'sticker' && typeof c.p.emoji === 'string') content.sticker.emoji = c.p.emoji;
    if (type === 'audio') {
      if (typeof c.p.title === 'string') content.audio.title = c.p.title;
      if (typeof c.p.performer === 'string') content.audio.performer = c.p.performer;
    }
    if (cap && cap.text) {
      content.caption = cap.text;
      if (cap.entities.length) content.caption_entities = cap.entities;
    }
    if (c.p.has_spoiler === true) content.has_media_spoiler = true;
    return deliver(c, chat, replyTo, content, cap ? { sourceText: cap.source, parseMode: cap.parseMode } : {});
  }

  function sendMessage(c: Ctx): P {
    const chat = chatFor(c, { send: true });
    const f = formatted(c.p, 'text', 'entities', c.p.parse_mode, 4096, 'message is too long');
    if (!f || !f.text.trim()) throw bad('message text is empty');
    checkMarkup(c.p.reply_markup, false);
    const replyTo = replyTarget(chat, c.p);
    const content: P = { text: f.text };
    if (f.entities.length) content.entities = f.entities;
    return deliver(c, chat, replyTo, content, { sourceText: f.source, parseMode: f.parseMode });
  }

  function sendLocation(c: Ctx): P {
    const chat = chatFor(c, { send: true });
    const lat = Number(c.p.latitude);
    const lon = Number(c.p.longitude);
    if (c.p.latitude === undefined || !Number.isFinite(lat) || lat < -90 || lat > 90) throw bad('wrong latitude specified');
    if (c.p.longitude === undefined || !Number.isFinite(lon) || lon < -180 || lon > 180) throw bad('wrong longitude specified');
    checkMarkup(c.p.reply_markup, false);
    const replyTo = replyTarget(chat, c.p);
    return deliver(c, chat, replyTo, { location: { latitude: lat, longitude: lon } });
  }

  function sendContact(c: Ctx): P {
    const chat = chatFor(c, { send: true });
    const phone = typeof c.p.phone_number === 'string' ? c.p.phone_number.trim() : String(c.p.phone_number ?? '').trim();
    const first = typeof c.p.first_name === 'string' ? c.p.first_name.trim() : '';
    if (!phone) throw bad('phone number is empty');
    if (!first) throw bad('CONTACT_NAME_EMPTY');
    checkMarkup(c.p.reply_markup, false);
    const replyTo = replyTarget(chat, c.p);
    const contact: P = { phone_number: phone, first_name: first };
    if (typeof c.p.last_name === 'string' && c.p.last_name) contact.last_name = c.p.last_name;
    if (typeof c.p.vcard === 'string' && c.p.vcard) contact.vcard = c.p.vcard;
    return deliver(c, chat, replyTo, { contact });
  }

  function copyOrForward(c: Ctx, forward: boolean): P {
    const chat = chatFor(c, { send: true });
    const from = chatFor(c, { key: 'from_chat_id', allowBlocked: true });
    const src = from.messages.get(Number(c.p.message_id));
    if (!src || src.deleted) throw bad(forward ? 'message to forward not found' : 'message to copy not found');
    checkMarkup(c.p.reply_markup, false);
    const replyTo = replyTarget(chat, c.p);
    const content: P = {};
    const m = src.message;
    for (const k of ['text', 'entities', 'photo', 'video', 'animation', 'document', 'audio', 'voice', 'video_note', 'sticker', 'location', 'contact', 'caption', 'caption_entities']) {
      if (m[k] !== undefined) content[k] = clone(m[k]);
    }
    if (!forward && c.p.caption !== undefined) {
      const cap = formatted(c.p, 'caption', 'caption_entities', c.p.parse_mode, 1024, 'message caption is too long');
      delete content.caption;
      delete content.caption_entities;
      if (cap && cap.text) {
        content.caption = cap.text;
        if (cap.entities.length) content.caption_entities = cap.entities;
      }
    }
    if (forward) {
      content.forward_origin = { type: 'user', sender_user: clone(m.from), date: m.date };
      content.forward_date = m.date;
    }
    const msg = deliver(c, chat, replyTo, content);
    return forward ? msg : { message_id: msg.message_id };
  }

  async function editMessageText(c: Ctx): Promise<P | true> {
    const f = formatted(c.p, 'text', 'entities', c.p.parse_mode, 4096, 'message is too long');
    if (!f || !f.text.trim()) throw bad('message text is empty');
    checkMarkup(c.p.reply_markup, true);
    if (c.p.inline_message_id) return true;
    const s = editTarget(c);
    if (typeof s.message.text !== 'string') throw bad('there is no text in the message to edit');
    const next: P = { ...baseOf(s.message), text: f.text };
    if (f.entities.length) next.entities = f.entities;
    const mk = inlineMarkupOf(c.p.reply_markup);
    if (mk) next.reply_markup = mk;
    return applyEdit(s, next, c.p.reply_markup, f);
  }

  async function editMessageCaption(c: Ctx): Promise<P | true> {
    const cap = formatted(c.p, 'caption', 'caption_entities', c.p.parse_mode, 1024, 'message caption is too long');
    checkMarkup(c.p.reply_markup, true);
    if (c.p.inline_message_id) return true;
    const s = editTarget(c);
    if (!MEDIA_KINDS.includes(detectKind(s.message)) && detectKind(s.message) !== 'voice') {
      throw bad('there is no caption in the message to edit');
    }
    const next: P = clone(s.message);
    delete next.caption;
    delete next.caption_entities;
    delete next.reply_markup;
    delete next.edit_date;
    if (cap && cap.text) {
      next.caption = cap.text;
      if (cap.entities.length) next.caption_entities = cap.entities;
    }
    const mk = inlineMarkupOf(c.p.reply_markup);
    if (mk) next.reply_markup = mk;
    return applyEdit(s, next, c.p.reply_markup, cap);
  }

  async function editMessageMedia(c: Ctx): Promise<P | true> {
    const media = c.p.media;
    if (!media || typeof media !== 'object' || Array.isArray(media)) throw bad("can't parse InputMedia: media isn't specified");
    const type = media.type as FileType;
    if (!['photo', 'video', 'animation', 'audio', 'document'].includes(type)) throw bad("can't parse InputMedia: unsupported media type");
    const cap = formatted(media, 'caption', 'caption_entities', media.parse_mode, 1024, 'message caption is too long');
    checkMarkup(c.p.reply_markup, true);
    if (c.p.inline_message_id) {
      await resolveMedia(c, media.media, type, 'media', media);
      return true;
    }
    const s = editTarget(c);
    if (!MEDIA_KINDS.includes(detectKind(s.message))) throw bad('there is no media in the message to edit');
    const file = await resolveMedia(c, media.media, type, 'media', media);
    const next: P = { ...baseOf(s.message), [type]: fileObject(file, type) };
    if (type === 'animation') next.document = fileObject(file, 'document');
    if (cap && cap.text) {
      next.caption = cap.text;
      if (cap.entities.length) next.caption_entities = cap.entities;
    }
    if (media.has_spoiler === true) next.has_media_spoiler = true;
    const mk = inlineMarkupOf(c.p.reply_markup);
    if (mk) next.reply_markup = mk;
    return applyEdit(s, next, c.p.reply_markup, cap);
  }

  async function editMessageReplyMarkup(c: Ctx): Promise<P | true> {
    checkMarkup(c.p.reply_markup, true);
    if (c.p.inline_message_id) return true;
    const s = editTarget(c);
    const next: P = clone(s.message);
    delete next.reply_markup;
    delete next.edit_date;
    const mk = inlineMarkupOf(c.p.reply_markup);
    if (mk) next.reply_markup = mk;
    return applyEdit(s, next, c.p.reply_markup, null, true);
  }

  function deleteMessage(c: Ctx): true {
    const chat = chatFor(c);
    const s = chat.messages.get(Number(c.p.message_id));
    if (!s || s.deleted) throw bad('message to delete not found');
    s.deleted = true;
    return true;
  }

  function deleteMessages(c: Ctx): true {
    const chat = chatFor(c);
    const ids = c.p.message_ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 100) throw bad('message identifiers are not specified');
    for (const id of ids) {
      const s = chat.messages.get(Number(id));
      if (s) s.deleted = true;
    }
    return true;
  }

  function answerCallbackQuery(c: Ctx): true {
    const id = c.p.callback_query_id === undefined || c.p.callback_query_id === null ? '' : String(c.p.callback_query_id);
    if (!id || answers.has(id)) throw bad('query is too old and response timeout expired or query ID is invalid');
    if (c.p.text !== undefined && codePoints(String(c.p.text)) > 200) throw bad('MESSAGE_TOO_LONG');
    if (c.p.url !== undefined) checkUrl(c.p.url, 'callback query URL', false);
    const issued = issuedCallbacks.get(id);
    if (issued && issued.token !== c.bot.token) throw bad('query is too old and response timeout expired or query ID is invalid');
    answers.set(id, { ...clone(c.p), token: c.bot.token });
    return true;
  }

  function setMessageReaction(c: Ctx): true {
    const chat = chatFor(c);
    const s = chat.messages.get(Number(c.p.message_id));
    if (!s || s.deleted) throw bad('MESSAGE_ID_INVALID');
    const list = c.p.reaction ?? [];
    if (!Array.isArray(list)) throw bad("can't parse reaction types JSON object");
    if (list.length > 1) throw bad('REACTIONS_TOO_MANY');
    const emojis: string[] = [];
    for (const r of list) {
      if (!r || typeof r !== 'object' || r.type !== 'emoji' || !REACTIONS.has(String(r.emoji).replace(/️/g, ''))) {
        throw bad('REACTION_INVALID');
      }
      emojis.push(r.emoji);
    }
    s.reactions = emojis;
    return true;
  }

  function sendChatAction(c: Ctx): true {
    chatFor(c, { send: true });
    if (!CHAT_ACTIONS.has(String(c.p.action))) throw bad('wrong parameter action in request');
    return true;
  }

  function getFile(c: Ctx): P {
    const id = typeof c.p.file_id === 'string' ? c.p.file_id.trim() : '';
    if (!id) throw bad('invalid file_id');
    const f = files.get(id);
    if (!f || f.botId !== c.bot.id) throw bad(WRONG_FILE);
    if (f.file_size > MAX_GETFILE) throw bad('file is too big');
    return { file_id: f.file_id, file_unique_id: f.file_unique_id, file_size: f.file_size, file_path: f.file_path };
  }

  function setWebhook(c: Ctx): true {
    const url = typeof c.p.url === 'string' ? c.p.url.trim() : '';
    if (!url) {
      c.bot.webhook = null;
      return true;
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw bad('bad webhook: Failed to resolve host: Name or service not known');
    }
    if (parsed.protocol !== 'https:') throw bad('bad webhook: An HTTPS URL must be provided for webhook');
    if (c.p.secret_token !== undefined && !/^[A-Za-z0-9_-]{1,256}$/.test(String(c.p.secret_token))) {
      throw bad('secret token contains unallowed characters');
    }
    if (c.p.max_connections !== undefined) {
      const n = Number(c.p.max_connections);
      if (!Number.isInteger(n) || n < 1 || n > 100) throw bad('bad webhook: max_connections must be between 1 and 100');
    }
    if (c.p.allowed_updates !== undefined && !Array.isArray(c.p.allowed_updates)) throw bad("can't parse allowed_updates");
    c.bot.webhook = {
      url,
      ...(c.p.secret_token !== undefined ? { secret_token: String(c.p.secret_token) } : {}),
      ...(c.p.max_connections !== undefined ? { max_connections: Number(c.p.max_connections) } : {}),
      ...(c.p.allowed_updates !== undefined ? { allowed_updates: clone(c.p.allowed_updates) } : {}),
      set_at: nowSec(),
    };
    return true;
  }

  function getWebhookInfo(c: Ctx): P {
    const w = c.bot.webhook;
    return {
      url: w?.url ?? '',
      has_custom_certificate: false,
      pending_update_count: 0,
      ...(w?.max_connections !== undefined ? { max_connections: w.max_connections } : w ? { max_connections: 40 } : {}),
      ...(w?.allowed_updates ? { allowed_updates: clone(w.allowed_updates) } : {}),
      ...(w ? { ip_address: '127.0.0.1' } : {}),
    };
  }

  function commandsKey(scope: unknown, lang: unknown): string {
    return `${canon(scope ?? { type: 'default' })}|${typeof lang === 'string' ? lang : ''}`;
  }

  function setMyCommands(c: Ctx): true {
    const list = c.p.commands;
    if (!Array.isArray(list)) throw bad("can't parse commands JSON object");
    if (list.length > 100) throw bad('too many commands');
    for (const cmd of list) {
      if (!cmd || typeof cmd !== 'object' || typeof cmd.command !== 'string' || !/^[a-z0-9_]{1,32}$/.test(cmd.command)) {
        throw bad('BOT_COMMAND_INVALID');
      }
      const d = typeof cmd.description === 'string' ? cmd.description : '';
      if (!d.trim() || codePoints(d) > 256) throw bad('BOT_COMMAND_DESCRIPTION_INVALID');
    }
    const scope = c.p.scope as P | undefined;
    if (scope && typeof scope === 'object' && (scope.type === 'chat' || scope.type === 'chat_member')) {
      // Like Telegram: a chat scope for a user who never opened the bot → "chat not found" (strictChats only)
      const id = Number(scope.chat_id);
      if (!Number.isSafeInteger(id) || id === 0) throw bad('chat not found');
      if (opts.strictChats && !chatState(c.bot, id).known) throw bad('chat not found');
    }
    c.bot.commands.set(commandsKey(c.p.scope, c.p.language_code), clone(list));
    return true;
  }

  function setChatMenuButton(c: Ctx): true {
    const mb = c.p.menu_button ?? { type: 'default' };
    if (!mb || typeof mb !== 'object') throw bad("can't parse menu button JSON object");
    if (!['commands', 'default', 'web_app'].includes(mb.type)) throw bad('unsupported menu button type');
    if (mb.type === 'web_app') {
      if (typeof mb.text !== 'string' || !mb.text.trim()) throw bad('menu button text is empty');
      checkUrl(mb.web_app?.url, 'menu button Web App URL', true);
    }
    if (c.p.chat_id !== undefined && c.p.chat_id !== null && c.p.chat_id !== '') {
      const chat = chatFor(c, { allowBlocked: true });
      chat.menuButton = clone(mb);
    } else {
      c.bot.defaultMenuButton = clone(mb);
    }
    return true;
  }

  function getChatMenuButton(c: Ctx): P {
    if (c.p.chat_id !== undefined && c.p.chat_id !== null && c.p.chat_id !== '') {
      const chat = chatFor(c, { allowBlocked: true });
      if (chat.menuButton) return clone(chat.menuButton);
    }
    return clone(c.bot.defaultMenuButton ?? { type: 'commands' });
  }

  function setText(c: Ctx, key: string, limit: number, set: (v: string) => void): true {
    const v = c.p[key] === undefined || c.p[key] === null ? '' : String(c.p[key]);
    if (codePoints(v) > limit) throw bad(`${key.replace('_', ' ')} is too long`);
    set(v);
    return true;
  }

  const HANDLERS: Record<string, (c: Ctx) => unknown> = {
    getme: (c) => botUserFull(c.bot),
    logout: () => true,
    close: () => true,
    getupdates: (c) => {
      if (c.bot.webhook) {
        throw new TgError(409, "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first");
      }
      return [];
    },
    setwebhook: setWebhook,
    deletewebhook: (c) => {
      c.bot.webhook = null;
      return true;
    },
    getwebhookinfo: getWebhookInfo,
    sendmessage: sendMessage,
    sendphoto: (c) => sendMedia(c, 'photo'),
    sendvideo: (c) => sendMedia(c, 'video'),
    sendanimation: (c) => sendMedia(c, 'animation'),
    senddocument: (c) => sendMedia(c, 'document'),
    sendaudio: (c) => sendMedia(c, 'audio'),
    sendvoice: (c) => sendMedia(c, 'voice'),
    sendvideonote: (c) => sendMedia(c, 'video_note'),
    sendsticker: (c) => sendMedia(c, 'sticker'),
    sendlocation: sendLocation,
    sendcontact: sendContact,
    sendchataction: sendChatAction,
    copymessage: (c) => copyOrForward(c, false),
    forwardmessage: (c) => copyOrForward(c, true),
    editmessagetext: editMessageText,
    editmessagecaption: editMessageCaption,
    editmessagemedia: editMessageMedia,
    editmessagereplymarkup: editMessageReplyMarkup,
    deletemessage: deleteMessage,
    deletemessages: deleteMessages,
    answercallbackquery: answerCallbackQuery,
    setmessagereaction: setMessageReaction,
    getfile: getFile,
    getchat: (c) => {
      const chat = chatFor(c, { allowBlocked: true });
      if (!chat.known && !users.has(chat.id) && !chatInfo.has(chat.id)) throw bad('chat not found');
      return chatObject(chat.id);
    },
    setmycommands: setMyCommands,
    getmycommands: (c) => clone(c.bot.commands.get(commandsKey(c.p.scope, c.p.language_code)) ?? []),
    deletemycommands: (c) => {
      c.bot.commands.delete(commandsKey(c.p.scope, c.p.language_code));
      return true;
    },
    setchatmenubutton: setChatMenuButton,
    getchatmenubutton: getChatMenuButton,
    setmydescription: (c) => setText(c, 'description', 512, (v) => (c.bot.description = v)),
    getmydescription: (c) => ({ description: c.bot.description }),
    setmyshortdescription: (c) => setText(c, 'short_description', 120, (v) => (c.bot.shortDescription = v)),
    getmyshortdescription: (c) => ({ short_description: c.bot.shortDescription }),
    setmyname: (c) => setText(c, 'name', 64, (v) => (c.bot.name = v || c.bot.firstName)),
    getmyname: (c) => ({ name: c.bot.name }),
  };

  // ── HTTP ──

  function sendJson(res: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }

  function takeInjection(token: string, method: string, params: P): TgError | null {
    const idx = injections.findIndex(
      (inj) => (inj.token === null || inj.token === token) && inj.method === method.toLowerCase() && (!inj.when || inj.when(params)),
    );
    if (idx < 0) return null;
    const inj = injections[idx]!;
    inj.times -= 1;
    if (inj.times <= 0) injections.splice(idx, 1);
    const code = inj.error.error_code ?? 400;
    return new TgError(code, inj.error.description ?? `Bad Request: injected failure (${method})`, inj.error.parameters);
  }

  function parseParams(req: IncomingMessage, url: URL, body: Buffer): { params: P; parts: Map<string, UploadedPart>; multipart: boolean } {
    const params: P = {};
    for (const [k, v] of url.searchParams) params[k] = coerceField(k, v);
    const ct = String(req.headers['content-type'] ?? '').toLowerCase();
    let parts = new Map<string, UploadedPart>();
    let multipart = false;
    if (!body.length) return { params, parts, multipart };
    if (ct.startsWith('application/json')) {
      let data: unknown;
      try {
        data = JSON.parse(body.toString('utf8'));
      } catch {
        throw bad("can't parse JSON object");
      }
      if (data && typeof data === 'object' && !Array.isArray(data)) Object.assign(params, data);
    } else if (ct.startsWith('multipart/form-data')) {
      multipart = true;
      const r = parseMultipart(body, String(req.headers['content-type']));
      for (const [k, v] of r.fields) params[k] = coerceField(k, v);
      parts = r.parts;
    } else if (ct.startsWith('application/x-www-form-urlencoded') || !ct) {
      for (const [k, v] of new URLSearchParams(body.toString('utf8'))) params[k] = coerceField(k, v);
    }
    return { params, parts, multipart };
  }

  function serveFile(res: ServerResponse, token: string, path: string): void {
    const f = filePaths.get(`${token}\n${path}`);
    downloads.push({ token, path, ok: !!f, ...(f ? { fileId: f.file_id } : {}) });
    if (!f) return sendJson(res, 404, { ok: false, error_code: 404, description: 'Not Found' });
    const buf = Buffer.from(f.bytes.buffer, f.bytes.byteOffset, f.bytes.byteLength);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': buf.byteLength });
    res.end(buf);
  }

  async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let path = url.pathname;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      /* keep raw */
    }
    const fm = /^\/file\/bot([^/]+)\/(.+)$/.exec(path);
    if (fm) {
      req.resume();
      return serveFile(res, fm[1]!, fm[2]!);
    }
    const m = /^\/bot([^/]+)\/(?:test\/)?([A-Za-z0-9_]+)\/?$/.exec(path);
    if (!m || !TOKEN_RE.test(m[1]!)) {
      req.resume();
      return sendJson(res, 404, { ok: false, error_code: 404, description: 'Not Found' });
    }
    const token = m[1]!;
    const method = m[2]!;
    if (opts.knownTokensOnly && !configured.has(token)) {
      req.resume();
      return sendJson(res, 401, { ok: false, error_code: 401, description: 'Unauthorized' });
    }
    const bot = botFor(token);
    const call: RecordedCall = {
      seq: ++callSeq,
      token,
      botId: bot.id,
      method,
      params: {},
      files: {},
      multipart: false,
      ok: false,
      uploaded: [],
      at: started,
    };
    let status = 200;
    let payload: P;
    try {
      const body = await readBody(req, MAX_BODY);
      const parsed = parseParams(req, url, body);
      call.params = parsed.params;
      call.multipart = parsed.multipart;
      for (const [k, part] of parsed.parts) {
        call.files[k] = { filename: part.filename, contentType: part.contentType, size: part.bytes.byteLength, bytes: part.bytes };
      }
      calls.push(call);
      const injected = takeInjection(token, method, parsed.params);
      if (injected) throw injected;
      const handler = HANDLERS[method.toLowerCase()];
      if (!handler) throw new TgError(404, 'Not Found');
      const result = await handler({ bot, p: parsed.params, parts: parsed.parts, call });
      call.ok = true;
      call.result = clone(result);
      payload = { ok: true, result };
    } catch (e) {
      if (!calls.includes(call)) calls.push(call);
      let err: TgError;
      if (e instanceof TgError) err = e;
      else {
        console.error('[fake-telegram] internal error in', method, e);
        err = new TgError(500, `Internal Server Error: ${e instanceof Error ? e.message : String(e)}`);
      }
      call.error = { error_code: err.code, description: err.description };
      status = err.code;
      payload = { ok: false, error_code: err.code, description: err.description, ...(err.parameters ? { parameters: err.parameters } : {}) };
    }
    if (opts.log) {
      const brief = call.ok ? 'ok' : `${call.error?.error_code} ${call.error?.description}`;
      console.log(`[fake-telegram] bot${bot.id} ${method} ${JSON.stringify(call.params).slice(0, 200)} → ${brief}`);
    }
    sendJson(res, status, payload);
  }

  const server = createServer((req, res) => {
    onRequest(req, res).catch((e) => {
      console.error('[fake-telegram] request failed:', e);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error_code: 500, description: 'Internal Server Error' });
      else res.destroy();
    });
  });
  server.keepAliveTimeout = 1000;

  await new Promise<void>((resolve, reject) => {
    const onError = (e: Error) => reject(e);
    server.once('error', onError);
    server.listen(opts.port, opts.host, () => {
      server.off('error', onError);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const url = `http://${opts.host}:${port}`;

  // ── test API ──

  function view(s: StoredMessage): ChatMessage {
    const m = clone(s.message);
    const kind = detectKind(m);
    const fileId = mainFileId(m, kind);
    return {
      id: s.id,
      chatId: s.chatId,
      fromBot: s.fromBot,
      deleted: s.deleted,
      method: s.method,
      message: m as Message,
      text: typeof m.text === 'string' ? m.text : typeof m.caption === 'string' ? m.caption : '',
      ...(s.sourceText !== undefined ? { source: s.sourceText } : {}),
      ...(s.parseMode !== undefined ? { parseMode: s.parseMode } : {}),
      markup: clone(s.markup),
      buttons: flattenButtons(m.reply_markup),
      reactions: [...s.reactions],
      edits: s.edits.length,
      kind,
      ...(fileId ? { fileId } : {}),
    };
  }

  function listMessages(token: string, chatId: number, o: { includeDeleted?: boolean; fromBot?: boolean } = {}): ChatMessage[] {
    const chat = botFor(token).chats.get(chatId);
    if (!chat) return [];
    return [...chat.messages.values()]
      .filter((s) => (o.includeDeleted || !s.deleted) && (o.fromBot === undefined || s.fromBot === o.fromBot))
      .sort((a, b) => a.id - b.id)
      .map(view);
  }

  function userMessage(token: string, from: User | number, fields: IncomingFields = {}): Message {
    const b = botFor(token);
    const user = resolveUser(from);
    const { chat: chatOverride, replyTo, message_id, ...rest } = fields;
    const chatObj: P = chatOverride
      ? clone(chatOverride)
      : {
          id: user.id,
          type: 'private',
          first_name: user.first_name,
          ...(user.last_name ? { last_name: user.last_name } : {}),
          ...(user.username ? { username: user.username } : {}),
        };
    if (chatOverride) chatInfo.set(chatObj.id, clone(chatObj));
    const chat = chatState(b, Number(chatObj.id));
    chat.known = true;
    let id: number;
    if (message_id !== undefined) {
      id = message_id;
      if (id >= chat.nextId) chat.nextId = id + 1;
    } else {
      id = chat.nextId++;
    }
    const msg: P = { message_id: id, from: user, chat: chatObj, date: nowSec(), ...clone(rest) };
    if (typeof msg.text === 'string' && msg.entities === undefined) {
      const cmd = /^\/[A-Za-z0-9_]{1,32}(@[A-Za-z0-9_]{3,64})?/.exec(msg.text);
      if (cmd) msg.entities = [{ type: 'bot_command', offset: 0, length: cmd[0].length }];
    }
    if (replyTo !== undefined) {
      const t = chat.messages.get(replyTo);
      if (!t) throw new Error(`[fake-telegram] userMessage: replyTo message ${replyTo} not found in chat ${chat.id}`);
      msg.reply_to_message = stripReply(t.message);
    }
    chat.messages.set(id, {
      chatId: chat.id,
      id,
      fromBot: false,
      method: 'user',
      message: msg,
      deleted: false,
      reactions: [],
      edits: [],
    });
    return clone(msg) as Message;
  }

  function nextUpdateId(): number {
    return ++updateSeq;
  }

  function resolveTarget(token: string, user: P, target: number | ChatMessage | Message, chatIdOpt?: number): StoredMessage {
    const b = botFor(token);
    let chatId: number;
    let msgId: number;
    if (typeof target === 'number') {
      chatId = chatIdOpt ?? user.id;
      msgId = target;
    } else if ('chatId' in target && typeof (target as ChatMessage).chatId === 'number') {
      chatId = (target as ChatMessage).chatId;
      msgId = (target as ChatMessage).id;
    } else {
      chatId = (target as P).chat?.id ?? chatIdOpt ?? user.id;
      msgId = (target as P).message_id;
    }
    const s = b.chats.get(chatId)?.messages.get(msgId);
    if (!s) throw new Error(`[fake-telegram] message ${msgId} not found in chat ${chatId} of bot ${b.id}`);
    return s;
  }

  function callbackUpdate(
    token: string,
    from: User | number,
    target: number | ChatMessage | Message,
    data: string,
    o: { chatId?: number; id?: string; inaccessible?: boolean } = {},
  ): Update {
    const user = resolveUser(from);
    const s = resolveTarget(token, user, target, o.chatId);
    const chat = chatState(botFor(token), s.chatId);
    chat.known = true;
    const id = o.id ?? `cbq${++cbSeq}`;
    issuedCallbacks.set(id, { token, data, chatId: s.chatId, messageId: s.id });
    const message = o.inaccessible ? { chat: chatObject(s.chatId), message_id: s.id, date: 0 } : clone(s.message);
    return {
      update_id: nextUpdateId(),
      callback_query: { id, from: user, chat_instance: `ci${s.chatId}`, message, data },
    } as unknown as Update;
  }

  function pressButton(
    token: string,
    from: User | number,
    target: number | ChatMessage | Message,
    match: string | RegExp,
    o: { chatId?: number; id?: string } = {},
  ): Update {
    const user = resolveUser(from);
    const s = resolveTarget(token, user, target, o.chatId);
    const data = buttonData(view(s), match);
    return callbackUpdate(token, from, s.id, data, { ...o, chatId: s.chatId });
  }

  function myChatMemberUpdate(token: string, from: User | number, status: 'kicked' | 'member', o: { apply?: boolean } = {}): Update {
    const b = botFor(token);
    const user = resolveUser(from);
    const chat = chatState(b, user.id);
    if (o.apply !== false) {
      chat.blocked = status === 'kicked';
      if (status === 'member') chat.known = true;
    }
    const me = botUserShort(b);
    const old = status === 'kicked' ? { user: me, status: 'member' } : { user: me, status: 'kicked', until_date: 0 };
    const neu = status === 'kicked' ? { user: me, status: 'kicked', until_date: 0 } : { user: me, status: 'member' };
    return {
      update_id: nextUpdateId(),
      my_chat_member: { chat: chatObject(user.id), from: user, date: nowSec(), old_chat_member: old, new_chat_member: neu },
    } as unknown as Update;
  }

  /**
   * A user edits one of their earlier messages (private chat with `from`): like Telegram, the update carries the
   * WHOLE message in its new state (unchanged fields kept) with `edit_date`. The stored message is updated too.
   */
  function editedMessageUpdate(token: string, from: User | number, messageId: number, fields: IncomingFields = {}): Update {
    const b = botFor(token);
    const user = resolveUser(from);
    const chat = chatState(b, user.id);
    const stored = chat.messages.get(messageId);
    if (!stored) throw new Error(`[fake-telegram] editedMessageUpdate: message ${messageId} not found in chat ${user.id} of bot ${b.id}`);
    if (stored.fromBot) throw new Error(`[fake-telegram] editedMessageUpdate: message ${messageId} was sent by the bot, not the user`);
    const { replyTo: _replyTo, chat: _chat, message_id: _messageId, ...rest } = fields;
    const msg: P = clone(stored.message);
    // New text/caption replaces the old one together with its formatting (unless new entities are given)
    if ('text' in rest) {
      delete msg.text;
      delete msg.entities;
    }
    if ('caption' in rest) {
      delete msg.caption;
      delete msg.caption_entities;
    }
    Object.assign(msg, clone(rest), { edit_date: nowSec() });
    if (typeof msg.text === 'string' && msg.entities === undefined) {
      const cmd = /^\/[A-Za-z0-9_]{1,32}(@[A-Za-z0-9_]{3,64})?/.exec(msg.text);
      if (cmd) msg.entities = [{ type: 'bot_command', offset: 0, length: cmd[0].length }];
    }
    stored.message = msg;
    stored.edits.push(clone(msg));
    return { update_id: nextUpdateId(), edited_message: clone(msg) } as unknown as Update;
  }

  function registerFile(token: string, bytes?: Uint8Array, meta: RegisterFileMeta = {}): StoredFile {
    const b = botFor(token);
    const type = meta.type ?? 'document';
    const data =
      bytes ??
      (type === 'photo'
        ? fakeJpeg()
        : type === 'sticker'
          ? fakeWebp()
          : new TextEncoder().encode(`fake-${type}-${fileSeq + 1}-${Math.random()}`));
    let f: StoredFile;
    if (type === 'photo') {
      const sizes = newPhoto(b, data, 'registered', meta);
      f = sizes[sizes.length - 1]!;
    } else {
      f = newFile(
        b,
        type,
        data,
        { ...meta, mime_type: meta.mime_type ?? guessMime(meta.file_name, type) },
        'registered',
      );
    }
    return { ...f };
  }

  function mediaObject(token: string, type: FileType, bytes?: Uint8Array, meta: RegisterFileMeta = {}): any {
    const f = files.get(registerFile(token, bytes, { ...meta, type }).file_id)!;
    const obj = fileObject(f, type);
    if (type === 'sticker' && meta.emoji) obj.emoji = meta.emoji;
    return obj;
  }

  function resetAll(): void {
    bots = new Map();
    files = new Map();
    filePaths = new Map();
    users = new Map();
    chatInfo = new Map();
    issuedCallbacks = new Map();
    answers = new Map();
    injections = [];
    calls.length = 0;
    downloads.length = 0;
  }

  const api: FakeTelegram = {
    url,
    port,
    calls,
    downloads,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    clear: () => {
      calls.length = 0;
      downloads.length = 0;
    },
    reset: resetAll,
    callsFor: (token, method) =>
      calls.filter((c) => c.token === token && (method === undefined || c.method.toLowerCase() === method.toLowerCase())),
    lastCall: (token, method) => {
      const list = api.callsFor(token, method);
      return list[list.length - 1];
    },
    me: (token) => botUserFull(botFor(token)) as User,
    nextUpdateId,
    userMessage,
    messageUpdate: (token, from, fields) => ({ update_id: nextUpdateId(), message: userMessage(token, from, fields) }) as unknown as Update,
    callbackUpdate,
    pressButton,
    myChatMemberUpdate,
    editedMessageUpdate,
    sent: (token, chatId) => listMessages(token, chatId, { fromBot: true }),
    lastSent: (token, chatId) => {
      const list = listMessages(token, chatId, { fromBot: true });
      return list[list.length - 1];
    },
    chatMessages: listMessages,
    message: (token, chatId, messageId) => {
      const s = botFor(token).chats.get(chatId)?.messages.get(messageId);
      return s ? view(s) : undefined;
    },
    texts: (token, chatId) => listMessages(token, chatId, { fromBot: true }).map((m) => m.text),
    keyboard: (token, chatId) => clone(botFor(token).chats.get(chatId)?.keyboard ?? null),
    reactions: (token, chatId, messageId) => [...(botFor(token).chats.get(chatId)?.messages.get(messageId)?.reactions ?? [])],
    callbackAnswer: (queryId) => clone(answers.get(queryId)),
    unansweredCallbacks: (token) =>
      [...issuedCallbacks.entries()].filter(([id, v]) => (token === undefined || v.token === token) && !answers.has(id)).map(([id]) => id),
    expireCallback: (queryId) => !answers.has(queryId) && issuedCallbacks.delete(queryId),
    blockChat: (token, chatId) => {
      chatState(botFor(token), chatId).blocked = true;
    },
    unblockChat: (token, chatId) => {
      chatState(botFor(token), chatId).blocked = false;
    },
    isBlocked: (token, chatId) => botFor(token).chats.get(chatId)?.blocked === true,
    knowChat: (token, chatId) => {
      chatState(botFor(token), chatId).known = true;
    },
    registerFile,
    makeFileId: (token, type = 'document', bytes) => registerFile(token, bytes, { type }).file_id,
    photo: (token, bytes) => mediaObject(token, 'photo', bytes) as PhotoSize[],
    document: (token, bytes, meta = {}) => mediaObject(token, 'document', bytes, meta) as Document,
    media: mediaObject,
    fileBytes: (fileId) => files.get(fileId)?.bytes,
    fileInfo: (fileId) => {
      const f = files.get(fileId);
      return f ? { ...f } : undefined;
    },
    files: (token) => [...files.values()].filter((f) => token === undefined || f.token === token).map((f) => ({ ...f })),
    failNext: (token, method, error = {}, o = {}) => {
      injections.push({ token, method: method.toLowerCase(), error, times: o.times ?? 1, when: o.when });
    },
    webhook: (token) => clone(botFor(token).webhook),
    commands: (token, scope, languageCode) => clone(botFor(token).commands.get(commandsKey(scope, languageCode)) ?? []),
    menuButton: (token, chatId) => {
      const b = botFor(token);
      if (chatId !== undefined) {
        const mb = b.chats.get(chatId)?.menuButton;
        if (mb) return clone(mb);
      }
      return clone(b.defaultMenuButton ?? { type: 'commands' });
    },
    botInfo: (token) => {
      const b = botFor(token);
      return { description: b.description, short_description: b.shortDescription, name: b.name };
    },
  };
  return api;
}

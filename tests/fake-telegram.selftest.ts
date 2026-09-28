// Soxta Telegram serverining o'z-o'zini tekshirishi (.env kerak emas):
//   npx tsx tests/fake-telegram.selftest.ts
import { Api, Bot, GrammyError, InlineKeyboard, InputFile } from 'grammy';
import {
  buttonData,
  bytesEqual,
  fakeJpeg,
  findButton,
  parseTelegramHtml,
  startFakeTelegram,
  type FakeTelegram,
} from './fake-telegram.js';

const CLIENT = '111111:CLIENTTOKEN';
const STAFF = '222222:STAFFTOKEN';
const USER = { id: 501, is_bot: false as const, first_name: 'Ali', username: 'ali_u' };
const USER2 = { id: 502, is_bot: false as const, first_name: 'Vali' };

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (e) {
    failed++;
    console.log(`❌ ${name}\n   ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function eq(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg}: expected ${b}, got ${a}`);
}

async function rejects(p: Promise<unknown>, re: RegExp, msg: string): Promise<GrammyError> {
  try {
    await p;
  } catch (e) {
    const d = e instanceof GrammyError ? `${e.error_code} ${e.description}` : String(e);
    if (!re.test(d)) throw new Error(`${msg}: unexpected error "${d}"`);
    if (!(e instanceof GrammyError)) throw new Error(`${msg}: expected GrammyError, got ${String(e)}`);
    return e;
  }
  throw new Error(`${msg}: expected an error`);
}

const tg: FakeTelegram = await startFakeTelegram({
  bots: [
    { token: CLIENT, username: 'uzgroww_bot', first_name: 'Uzgrow' },
    { token: STAFF, username: 'uzgrow_staff_bot', first_name: 'Uzgrow Staff' },
  ],
});
const client = new Api(CLIENT, { apiRoot: tg.url });
const staff = new Api(STAFF, { apiRoot: tg.url });

try {
  await test('getMe: sozlangan username', async () => {
    const me = await client.getMe();
    eq([me.id, me.username, me.is_bot], [111111, 'uzgroww_bot', true], 'client getMe');
    const me2 = await staff.getMe();
    eq(me2.username, 'uzgrow_staff_bot', 'staff getMe');
  });

  await test('sendMessage HTML: matn va entity lar, chat bo\'yicha alohida message_id', async () => {
    const m1 = await client.sendMessage(USER.id, '👋 <b>Ali &amp; Vali</b> &lt;3 — <i>salom</i>', { parse_mode: 'HTML' });
    eq(m1.text, '👋 Ali & Vali <3 — salom', 'parsed text');
    eq(m1.entities, [
      { type: 'bold', offset: 3, length: 10 },
      { type: 'italic', offset: 19, length: 5 },
    ], 'entities (UTF-16)');
    const m2 = await client.sendMessage(USER.id, 'ikkinchi');
    const other = await client.sendMessage(USER2.id, 'boshqa chat');
    eq([m1.message_id, m2.message_id, other.message_id], [1, 2, 1], 'per-chat ids');
    const staffMsg = await staff.sendMessage(USER.id, 'staff bot');
    eq(staffMsg.message_id, 1, 'per-bot ids');
    eq(tg.lastSent(CLIENT, USER.id)?.text, 'ikkinchi', 'lastSent');
    eq(tg.texts(CLIENT, USER.id), ['👋 Ali & Vali <3 — salom', 'ikkinchi'], 'texts');
    eq(tg.sent(CLIENT, USER.id)[0]?.source, '👋 <b>Ali &amp; Vali</b> &lt;3 — <i>salom</i>', 'source kept');
  });

  await test('HTML xatolari: escape qilinmagan <, noma\'lum teg, yopilmagan teg', async () => {
    await rejects(client.sendMessage(USER.id, 'a < b', { parse_mode: 'HTML' }), /can't parse entities: Unsupported start tag "" at byte offset 2/, 'bare <');
    await rejects(client.sendMessage(USER.id, 'x<br>y', { parse_mode: 'HTML' }), /Unsupported start tag "br"/, '<br>');
    await rejects(client.sendMessage(USER.id, '<b>x', { parse_mode: 'HTML' }), /Can't find end tag corresponding to start tag "b"/, 'unclosed');
    await rejects(client.sendMessage(USER.id, '<b>x</i>', { parse_mode: 'HTML' }), /Unmatched end tag/, 'unmatched');
    await rejects(client.sendMessage(USER.id, '<span>x</span>', { parse_mode: 'HTML' }), /tg-spoiler/, 'span');
    const ok = await client.sendMessage(USER.id, 'Tom & Jerry > all <a href="https://t.me/x?a=1&amp;b=2">link</a>', { parse_mode: 'HTML' });
    eq(ok.text, 'Tom & Jerry > all link', 'bare & and > are fine');
    eq(ok.entities?.[0], { type: 'text_link', offset: 18, length: 4, url: 'https://t.me/x?a=1&b=2' }, 'link entity');
    const pre = parseTelegramHtml('<pre><code class="language-ts">let x</code></pre>');
    eq(pre.entities, [{ type: 'pre', offset: 0, length: 5, language: 'ts' }], 'pre+code');
  });

  await test('Limitlar: 4096 belgi, bo\'sh matn, caption 1024', async () => {
    await client.sendMessage(USER.id, '😀'.repeat(4096)); // 4096 code points = 8192 UTF-16 units → Telegram accepts
    await rejects(client.sendMessage(USER.id, 'x'.repeat(4097)), /message is too long/, '4097');
    await rejects(client.sendMessage(USER.id, '   '), /message text is empty/, 'blank');
    await rejects(client.sendMessage(USER.id, '<b></b>', { parse_mode: 'HTML' }), /message text is empty/, 'empty after parse');
    await rejects(
      client.sendPhoto(USER.id, new InputFile(fakeJpeg(), 'a.jpg'), { caption: 'c'.repeat(1025) }),
      /message caption is too long/,
      'caption',
    );
  });

  await test('Entity strict tekshiruvi: diapazondan tashqari / surrogate juftni bo\'lish', async () => {
    await rejects(client.sendMessage(USER.id, 'abc', { entities: [{ type: 'bold', offset: 1, length: 5 }] }), /outside of the text/, 'range');
    await rejects(client.sendMessage(USER.id, '👤 Ali', { entities: [{ type: 'bold', offset: 0, length: 1 }] }), /surrogate/, 'surrogate');
    const m = await client.sendMessage(USER.id, '👤 Ali\nsalom', { entities: [{ type: 'bold', offset: 0, length: 6 }] });
    eq(m.entities, [{ type: 'bold', offset: 0, length: 6 }], 'valid entity kept');
  });

  await test('Klaviaturalar: callback_data ≤ 64 bayt, web_app https, reply keyboard holati', async () => {
    await rejects(
      client.sendMessage(USER.id, 'x', { reply_markup: new InlineKeyboard().text('a', 'x'.repeat(65)) }),
      /BUTTON_DATA_INVALID/,
      '65 bytes',
    );
    await rejects(
      client.sendMessage(USER.id, 'x', { reply_markup: new InlineKeyboard().text('a', 'ё'.repeat(33)) }),
      /BUTTON_DATA_INVALID/,
      '66 UTF-8 bytes',
    );
    await rejects(
      client.sendMessage(USER.id, 'x', { reply_markup: new InlineKeyboard().webApp('app', 'http://example.test/app/') }),
      /Only HTTPS links are allowed/,
      'web_app http',
    );
    await rejects(
      client.sendMessage(USER.id, 'x', { reply_markup: { inline_keyboard: [[{ text: 'only text' } as never]] } }),
      /Text buttons are unallowed/,
      'text-only button',
    );
    const m = await client.sendMessage(USER.id, 'menu', {
      reply_markup: new InlineKeyboard().text('👨‍💻 Operatorlar', 'ls:operator').row().webApp('📱 Menyu', 'https://example.test/app/'),
    });
    eq(m.reply_markup?.inline_keyboard.length, 2, 'inline markup echoed');
    const cm = tg.lastSent(CLIENT, USER.id)!;
    eq(findButton(cm, /Operator/)?.callback_data, 'ls:operator', 'findButton');
    eq(buttonData(cm, 'ls:operator'), 'ls:operator', 'buttonData');
    await client.sendMessage(USER.id, 'kb', {
      reply_markup: { keyboard: [[{ text: '👨‍💻 Operatorlar' }, { text: '👔 Menejerlar' }]], resize_keyboard: true, is_persistent: true },
    });
    eq(tg.keyboard(CLIENT, USER.id)?.keyboard?.[0]?.[1]?.text, '👔 Menejerlar', 'reply keyboard tracked');
    await client.sendMessage(USER.id, 'rm', { reply_markup: { remove_keyboard: true } });
    eq(tg.keyboard(CLIENT, USER.id), null, 'keyboard removed');
  });

  let clientPhotoId = '';
  const jpeg = fakeJpeg({ width: 1024, height: 768, size: 4096, seed: 7 });

  await test('sendPhoto yuklash → getFile → /file/ yuklab olish (baytlar bir xil)', async () => {
    const m = await client.sendPhoto(USER.id, new InputFile(jpeg, 'photo.jpg'), { caption: '<b>Rasm</b>', parse_mode: 'HTML' });
    assert(m.photo && m.photo.length === 4, `4 sizes expected, got ${m.photo?.length}`);
    const largest = m.photo[m.photo.length - 1]!;
    eq([largest.width, largest.height], [1024, 768], 'dims sniffed from JPEG');
    assert(/^F_111111_\d+$/.test(largest.file_id), `bot-specific file id: ${largest.file_id}`);
    eq(m.caption, 'Rasm', 'caption parsed');
    eq(m.caption_entities, [{ type: 'bold', offset: 0, length: 4 }], 'caption entities');
    clientPhotoId = largest.file_id;
    const call = tg.lastCall(CLIENT, 'sendPhoto')!;
    assert(call.multipart && call.uploaded.length === 1, 'upload recorded');
    const file = await client.getFile(largest.file_id);
    assert(file.file_path, 'file_path');
    const res = await fetch(`${tg.url}/file/bot${CLIENT}/${file.file_path}`);
    eq(res.status, 200, 'download status');
    assert(bytesEqual(new Uint8Array(await res.arrayBuffer()), jpeg), 'downloaded bytes equal');
    assert(bytesEqual(tg.fileBytes(largest.file_id), jpeg), 'fileBytes equal');
    assert(!bytesEqual(tg.fileBytes(m.photo[0]!.file_id), jpeg), 'thumbnail bytes differ from original');
    const wrong = await fetch(`${tg.url}/file/bot${STAFF}/${file.file_path}`);
    eq(wrong.status, 404, 'other bot token cannot download');
  });

  await test('Boshqa botning file_id si → 400 wrong file identifier', async () => {
    await rejects(staff.sendPhoto(USER.id, clientPhotoId), /400 Bad Request: wrong file identifier\/HTTP URL specified/, 'sendPhoto');
    await rejects(staff.getFile(clientPhotoId), /wrong file identifier/, 'getFile');
    await rejects(client.sendPhoto(USER.id, 'F_111111_999999'), /wrong file identifier/, 'unknown id');
    await rejects(client.sendDocument(USER.id, clientPhotoId), /type of file mismatch/, 'photo as document');
    const again = await client.sendPhoto(USER2.id, clientPhotoId);
    eq(again.photo?.[again.photo.length - 1]?.file_id, clientPhotoId, 'same bot reuse keeps file_id');
    eq(tg.lastCall(CLIENT, 'sendPhoto')?.multipart, false, 'reuse is JSON (no upload)');
  });

  await test('Rasm bo\'lmagan baytlar sendPhoto da → IMAGE_PROCESS_FAILED; bo\'sh fayl rad etiladi', async () => {
    await rejects(client.sendPhoto(USER.id, new InputFile(new TextEncoder().encode('not an image'), 'x.jpg')), /IMAGE_PROCESS_FAILED/, 'text bytes');
    await rejects(client.sendDocument(USER.id, new InputFile(new Uint8Array(0), 'empty.txt')), /file must be non-empty/, 'empty');
  });

  await test('Barcha media turlari (yuklash) + mime aniqlash', async () => {
    const doc = await client.sendDocument(USER.id, new InputFile(new TextEncoder().encode('%PDF-1.4 test'), "Hisobot oʻzbekcha.pdf"), {
      caption: 'hujjat',
    });
    eq([doc.document?.file_name, doc.document?.mime_type], ['Hisobot oʻzbekcha.pdf', 'application/pdf'], 'document meta (unicode name)');
    const video = await client.sendVideo(USER.id, new InputFile(new Uint8Array([1, 2, 3]), 'v.mp4'), { width: 320, height: 240, duration: 9 });
    eq([video.video?.mime_type, video.video?.width, video.video?.duration], ['video/mp4', 320, 9], 'video');
    const anim = await client.sendAnimation(USER.id, new InputFile(new Uint8Array([4, 5]), 'a.mp4'));
    assert(anim.animation && anim.document && anim.animation.file_id === anim.document.file_id, 'animation also has document');
    const audio = await client.sendAudio(USER.id, new InputFile(new Uint8Array([6]), 'song.mp3'), { title: 'T' });
    eq([audio.audio?.mime_type, audio.audio?.title], ['audio/mpeg', 'T'], 'audio');
    const voice = await client.sendVoice(USER.id, new InputFile(new Uint8Array([7]), 'voice.ogg'));
    eq(voice.voice?.mime_type, 'audio/ogg', 'voice');
    const note = await client.sendVideoNote(USER.id, new InputFile(new Uint8Array([8]), 'n.mp4'));
    assert(note.video_note?.file_id, 'video note');
    const sticker = await client.sendSticker(USER.id, new InputFile(new Uint8Array([9]), 's.webp'));
    eq([sticker.sticker?.is_animated, sticker.sticker?.type], [false, 'regular'], 'sticker');
    const loc = await client.sendLocation(USER.id, 41.31, 69.28);
    eq(loc.location, { latitude: 41.31, longitude: 69.28 }, 'location');
    const contact = await client.sendContact(USER.id, '+998901234567', 'Ali');
    eq(contact.contact?.phone_number, '+998901234567', 'contact');
    eq(await client.sendChatAction(USER.id, 'typing'), true, 'chat action');
    await rejects(client.sendChatAction(USER.id, 'dancing' as never), /wrong parameter action/, 'bad action');
  });

  await test('Standart multipart (fetch FormData, fayl maydon nomi bilan) va urlencoded/query', async () => {
    const fd = new FormData();
    fd.set('chat_id', String(USER.id));
    fd.set('caption', 'std');
    fd.set('reply_markup', JSON.stringify({ inline_keyboard: [[{ text: 'ok', callback_data: 'ok' }]] }));
    fd.set('document', new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'text/plain' }), 'notes "q".txt');
    const r = await (await fetch(`${tg.url}/bot${CLIENT}/sendDocument`, { method: 'POST', body: fd })).json();
    assert(r.ok, `std multipart failed: ${JSON.stringify(r)}`);
    eq([r.result.document.mime_type, r.result.document.file_size, r.result.reply_markup.inline_keyboard[0][0].callback_data], ['text/plain', 4, 'ok'], 'std multipart');
    const u = await (
      await fetch(`${tg.url}/bot${CLIENT}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ chat_id: String(USER.id), text: '123' }),
      })
    ).json();
    eq([u.ok, u.result.text], [true, '123'], 'urlencoded (numeric text stays string)');
    const q = await (await fetch(`${tg.url}/bot${CLIENT}/sendMessage?chat_id=${USER.id}&text=query`)).json();
    eq(q.result?.text, 'query', 'query string');
    const nf = await fetch(`${tg.url}/bot${CLIENT}/noSuchMethod`);
    eq([nf.status, (await nf.json()).description], [404, 'Not Found'], 'unknown method');
    const badTok = await fetch(`${tg.url}/botNOTATOKEN/getMe`);
    eq(badTok.status, 404, 'malformed token');
  });

  await test('editMessageMedia yangi rasm bilan xabarni qaytaradi; not modified', async () => {
    const card = await client.sendPhoto(USER.id, clientPhotoId, {
      caption: 'card 1',
      reply_markup: new InlineKeyboard().text('▶️', 'nav:1:next'),
    });
    const newJpeg = fakeJpeg({ seed: 99 });
    const edited = await client.editMessageMedia(
      USER.id,
      card.message_id,
      { type: 'photo', media: new InputFile(newJpeg, 'n.jpg'), caption: '<b>card 2</b>', parse_mode: 'HTML' },
      { reply_markup: new InlineKeyboard().text('◀️', 'nav:2:prev') },
    );
    assert(edited !== true, 'message expected');
    const newId = edited.photo?.[edited.photo.length - 1]?.file_id;
    assert(newId && newId !== clientPhotoId, 'new file id');
    assert(bytesEqual(tg.fileBytes(newId), newJpeg), 'new bytes stored');
    const firstBtn = edited.reply_markup?.inline_keyboard[0]?.[0] as { callback_data?: string } | undefined;
    eq([edited.caption, firstBtn?.callback_data], ['card 2', 'nav:2:prev'], 'caption+markup');
    assert(edited.edit_date, 'edit_date');
    const view = tg.message(CLIENT, USER.id, card.message_id)!;
    eq([view.fileId, view.edits, view.kind], [newId, 1, 'photo'], 'stored view updated');
    await rejects(
      client.editMessageMedia(USER.id, card.message_id, { type: 'photo', media: newId, caption: '<b>card 2</b>', parse_mode: 'HTML' }, {
        reply_markup: new InlineKeyboard().text('◀️', 'nav:2:prev'),
      }),
      /message is not modified/,
      'same media',
    );
    await rejects(client.editMessageMedia(USER.id, card.message_id, { type: 'photo', media: 'F_222222_1' }), /wrong file identifier/, 'cross-bot media');
    const text = await client.sendMessage(USER.id, 'text msg');
    await rejects(client.editMessageMedia(USER.id, text.message_id, { type: 'photo', media: newId }), /no media in the message/, 'text→media');
  });

  await test('editMessageText / Caption / ReplyMarkup qoidalari', async () => {
    const m = await client.sendMessage(USER.id, 'Ro\'yxat', { reply_markup: new InlineKeyboard().text('A', 'a') });
    await rejects(
      client.editMessageText(USER.id, m.message_id, 'Ro\'yxat', { reply_markup: new InlineKeyboard().text('A', 'a') }),
      /400 Bad Request: message is not modified/,
      'not modified',
    );
    const e = await client.editMessageText(USER.id, m.message_id, '<b>Yangi</b>', { parse_mode: 'HTML' });
    assert(e !== true && (e as { text?: string }).text === 'Yangi' && !e.reply_markup, 'edit without reply_markup removes keyboard');
    eq(tg.message(CLIENT, USER.id, m.message_id)?.buttons, [], 'buttons gone');
    const photo = tg.sent(CLIENT, USER.id).find((x) => x.kind === 'photo')!;
    await rejects(client.editMessageText(USER.id, photo.id, 'x'), /there is no text in the message to edit/, 'text edit of photo');
    await rejects(client.editMessageCaption(USER.id, m.message_id, { caption: 'x' }), /there is no caption/, 'caption of text');
    const c = await client.editMessageCaption(USER.id, photo.id, { caption: 'yangi izoh' });
    assert(c !== true && c.caption === 'yangi izoh', 'caption edited');
    const rm = await client.editMessageReplyMarkup(USER.id, m.message_id, { reply_markup: new InlineKeyboard().text('B', 'b') });
    assert(rm !== true && rm.reply_markup?.inline_keyboard[0]?.[0]?.text === 'B', 'markup edited');
    await rejects(client.editMessageText(USER.id, 9999, 'x'), /message to edit not found/, 'missing');
    await rejects(
      client.editMessageText(USER.id, m.message_id, 'y', { reply_markup: { keyboard: [[{ text: 'k' }]] } as never }),
      /inline keyboard expected/,
      'reply keyboard in edit',
    );
    const um = tg.userMessage(CLIENT, USER, { text: 'user text' });
    await rejects(client.editMessageText(USER.id, um.message_id, 'hack'), /message can't be edited/, 'user message');
  });

  await test('deleteMessage va reply_parameters', async () => {
    const m = await client.sendMessage(USER.id, 'o\'chiriladi');
    eq(await client.deleteMessage(USER.id, m.message_id), true, 'delete');
    await rejects(client.deleteMessage(USER.id, m.message_id), /message to delete not found/, 'twice');
    await rejects(client.sendMessage(USER.id, 'r', { reply_parameters: { message_id: m.message_id } }), /message to be replied not found/, 'reply to deleted');
    const ok = await client.sendMessage(USER.id, 'r', { reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true } });
    assert(!ok.reply_to_message, 'sent without reply');
    const um = tg.userMessage(CLIENT, USER, { text: 'savol' });
    const r = await client.sendMessage(USER.id, 'javob', { reply_parameters: { message_id: um.message_id } });
    eq(r.reply_to_message?.text, 'savol', 'reply_to_message');
    await rejects(client.sendMessage(USER2.id, 'x', { reply_parameters: { message_id: um.message_id + 1000 } }), /replied not found/, 'other chat');
  });

  await test('Bloklangan chat → 403; blokdan chiqarish', async () => {
    tg.blockChat(CLIENT, USER2.id);
    const err = await rejects(client.sendMessage(USER2.id, 'x'), /403 Forbidden: bot was blocked by the user/, 'blocked');
    eq(err.error_code, 403, 'error_code');
    await rejects(client.sendPhoto(USER2.id, clientPhotoId), /403/, 'blocked media');
    assert(tg.isBlocked(CLIENT, USER2.id), 'isBlocked');
    const ok = await staff.sendMessage(USER2.id, 'staff bot is not blocked');
    assert(ok.message_id > 0, 'block is per bot');
    tg.unblockChat(CLIENT, USER2.id);
    await client.sendMessage(USER2.id, 'ok');
    const upd = tg.myChatMemberUpdate(CLIENT, USER2, 'kicked') as { my_chat_member?: { new_chat_member: { status: string } } };
    eq(upd.my_chat_member?.new_chat_member.status, 'kicked', 'my_chat_member update');
    await rejects(client.sendMessage(USER2.id, 'x'), /blocked/, 'kicked applies block');
    tg.myChatMemberUpdate(CLIENT, USER2, 'member');
    await client.sendMessage(USER2.id, 'back');
    await rejects(client.sendMessage(STAFF.split(':')[0] as unknown as number, 'x'), /bots/, 'bot-to-bot');
  });

  await test('Reaksiyalar', async () => {
    const um = tg.userMessage(STAFF, USER, { text: 'javob' });
    eq(await staff.setMessageReaction(USER.id, um.message_id, [{ type: 'emoji', emoji: '👍' }]), true, 'react');
    eq(tg.reactions(STAFF, USER.id, um.message_id), ['👍'], 'stored');
    await rejects(staff.setMessageReaction(USER.id, um.message_id, [{ type: 'emoji', emoji: '🦖' as never }]), /REACTION_INVALID/, 'invalid');
    await rejects(staff.setMessageReaction(USER.id, 4242, [{ type: 'emoji', emoji: '👍' }]), /MESSAGE_ID_INVALID/, 'missing msg');
  });

  await test('Callback query: bir marta javob, ikkinchisi xato; unansweredCallbacks', async () => {
    const m = await client.sendMessage(USER.id, 'tanlang', { reply_markup: new InlineKeyboard().text('✍️ Yozish', 'pick:7') });
    const upd = tg.pressButton(CLIENT, USER.id, tg.message(CLIENT, USER.id, m.message_id)!, /Yozish/) as {
      callback_query?: { id: string; data?: string; message?: { message_id: number; reply_markup?: unknown } };
    };
    eq([upd.callback_query?.data, upd.callback_query?.message?.message_id], ['pick:7', m.message_id], 'pressButton');
    const id = upd.callback_query!.id;
    eq(tg.unansweredCallbacks(), [id], 'pending');
    eq(await client.answerCallbackQuery(id, { text: '✅ Tanlandi' }), true, 'answer');
    eq(tg.callbackAnswer(id)?.text, '✅ Tanlandi', 'recorded');
    await rejects(client.answerCallbackQuery(id), /query is too old/, 'double answer');
    await rejects(client.answerCallbackQuery('x', { text: 'a'.repeat(201) }), /MESSAGE_TOO_LONG/, 'long text');
    eq(tg.unansweredCallbacks(), [], 'none pending');
    assert(tg.callbackUpdate(CLIENT, USER, m.message_id, 'forged:1'), 'arbitrary data allowed');
    const forged = (tg.callbackUpdate(CLIENT, USER, m.message_id, 'forged:2') as { callback_query?: { id: string } })
      .callback_query!.id;
    const forgedFirst = tg.unansweredCallbacks().find((x) => x !== forged)!;
    eq(tg.expireCallback(forged), true, 'expire unanswered');
    eq(tg.expireCallback(forged), false, 'already expired');
    eq(tg.unansweredCallbacks(), [forgedFirst], 'expired query is no longer pending');
    eq(tg.expireCallback(forgedFirst), true, 'cleanup');
    eq(tg.expireCallback(id), false, 'answered query is not expired');
  });

  await test('editedMessageUpdate: foydalanuvchi xabarini tahrirlash (matn, izoh, buyruq entity)', async () => {
    const um = tg.userMessage(CLIENT, USER, { text: 'salom', entities: [{ type: 'bold', offset: 0, length: 5 }] });
    const upd = tg.editedMessageUpdate(CLIENT, USER, um.message_id, { text: 'xayr', replyTo: 999 }) as {
      update_id: number;
      message?: unknown;
      edited_message?: { message_id: number; text?: string; entities?: unknown; edit_date?: number; chat: { id: number } };
    };
    assert(upd.update_id > 0 && !upd.message, 'edited_message update');
    const e = upd.edited_message!;
    eq([e.message_id, e.text, e.entities, e.chat.id], [um.message_id, 'xayr', undefined, USER.id], 'new state, old entities dropped');
    assert(typeof e.edit_date === 'number' && e.edit_date > 0, 'edit_date');
    const stored = tg.message(CLIENT, USER.id, um.message_id)!;
    eq([stored.text, stored.edits, stored.fromBot], ['xayr', 1, false], 'stored message updated');
    const cmd = tg.editedMessageUpdate(CLIENT, USER, um.message_id, { text: '/start' }) as { edited_message?: { entities?: unknown } };
    eq(cmd.edited_message?.entities, [{ type: 'bot_command', offset: 0, length: 6 }], 'command entity');
    const pm = tg.userMessage(CLIENT, USER, { photo: tg.photo(CLIENT), caption: 'eski' });
    const cap = tg.editedMessageUpdate(CLIENT, USER, pm.message_id, { caption: 'yangi' }) as {
      edited_message?: { caption?: string; photo?: unknown[] };
    };
    eq(cap.edited_message?.caption, 'yangi', 'caption');
    assert(cap.edited_message?.photo?.length, 'photo kept');
    const botMsg = await client.sendMessage(USER.id, 'bot xabari');
    let threw = '';
    try {
      tg.editedMessageUpdate(CLIENT, USER, botMsg.message_id, { text: 'x' });
    } catch (err) {
      threw = String(err);
    }
    assert(/sent by the bot/.test(threw), `bot message: ${threw}`);
    threw = '';
    try {
      tg.editedMessageUpdate(CLIENT, USER, 987654, { text: 'x' });
    } catch (err) {
      threw = String(err);
    }
    assert(/not found/.test(threw), `missing message: ${threw}`);
  });

  await test('Webhook, buyruqlar, menyu tugmasi, tavsiflar', async () => {
    await rejects(client.setWebhook('http://example.test/api/client-bot'), /HTTPS URL must be provided/, 'http webhook');
    await rejects(client.setWebhook('https://example.test/x', { secret_token: 'bad token!' }), /unallowed characters/, 'secret');
    eq(await client.setWebhook('https://example.test/api/client-bot', { secret_token: 'abc_DEF-1', allowed_updates: ['message'] }), true, 'set');
    const info = await client.getWebhookInfo();
    eq([info.url, info.allowed_updates], ['https://example.test/api/client-bot', ['message']], 'info');
    eq(tg.webhook(CLIENT)?.secret_token, 'abc_DEF-1', 'secret stored');
    await rejects(client.setMyCommands([{ command: 'Start', description: 'x' }]), /BOT_COMMAND_INVALID/, 'uppercase command');
    await client.setMyCommands([{ command: 'start', description: 'Boshlash' }]);
    eq(tg.commands(CLIENT), [{ command: 'start', description: 'Boshlash' }], 'commands');
    await rejects(
      client.setChatMenuButton({ menu_button: { type: 'web_app', text: 'M', web_app: { url: 'http://x.test' } } }),
      /Only HTTPS/,
      'menu http',
    );
    await client.setChatMenuButton({ menu_button: { type: 'web_app', text: '📱 Menyu', web_app: { url: 'https://example.test/app/' } } });
    eq(tg.menuButton(CLIENT).type, 'web_app', 'menu stored');
    await client.setMyDescription('Tavsif');
    await client.setMyShortDescription('Qisqa');
    eq(tg.botInfo(CLIENT), { description: 'Tavsif', short_description: 'Qisqa', name: 'Uzgrow' }, 'descriptions');
    await rejects(client.setMyShortDescription('x'.repeat(121)), /too long/, 'short desc limit');
  });

  await test('failNext: xatoni soxtalashtirish (429 retry_after)', async () => {
    tg.failNext(CLIENT, 'sendMessage', { error_code: 429, description: 'Too Many Requests: retry after 3', parameters: { retry_after: 3 } });
    const e = await rejects(client.sendMessage(USER.id, 'x'), /429/, 'injected');
    eq(e.parameters.retry_after, 3, 'parameters');
    await client.sendMessage(USER.id, 'x'); // only once
    tg.failNext(null, 'editMessageText', {}, { when: (p) => p.text === 'boom' });
    const m = await client.sendMessage(USER.id, 'a');
    await client.editMessageText(USER.id, m.message_id, 'b');
    await rejects(client.editMessageText(USER.id, m.message_id, 'boom'), /injected failure/, 'conditional injection');
  });

  await test('Katta fayl: getFile → file is too big; userMessage bot_command entity', async () => {
    const big = tg.registerFile(CLIENT, new Uint8Array([1]), { type: 'video', file_size: 25 * 1024 * 1024 });
    await rejects(client.getFile(big.file_id), /file is too big/, 'too big');
    const um = tg.userMessage(CLIENT, USER, { text: '/start staff_12' });
    eq(um.entities, [{ type: 'bot_command', offset: 0, length: 6 }], 'command entity');
    const photo = tg.photo(CLIENT);
    const pm = tg.userMessage(CLIENT, USER, { photo, caption: 'rasm' });
    assert(pm.photo?.length && pm.photo[pm.photo.length - 1]!.file_id.startsWith('F_111111_'), 'photo helper');
    const doc = tg.document(STAFF, new TextEncoder().encode('hi'), { file_name: 'a.txt' });
    eq([doc.mime_type, doc.file_size], ['text/plain', 2], 'document helper');
    const ids = tg.chatMessages(CLIENT, USER.id, { includeDeleted: true }).map((x) => x.id);
    eq(ids, [...ids].sort((a, b) => a - b), 'ordered ids');
    eq(new Set(ids).size, ids.length, 'unique ids per chat');
  });

  await test('URL orqali media va guruh chatlari', async () => {
    const file = await client.getFile(clientPhotoId);
    const viaUrl = await client.sendPhoto(USER.id, `${tg.url}/file/bot${CLIENT}/${file.file_path}`);
    const id = viaUrl.photo?.[viaUrl.photo.length - 1]?.file_id;
    assert(id && id !== clientPhotoId && bytesEqual(tg.fileBytes(id), jpeg), 'URL fetched and stored as a new file');
    eq(tg.lastCall(CLIENT, 'sendPhoto')?.uploaded, [id], 'uploaded recorded');
    await rejects(client.sendPhoto(USER.id, 'http://127.0.0.1:1/x.jpg'), /failed to get HTTP URL content/, 'unreachable URL');
    await rejects(client.sendMessage(-100123, 'x'), /chat not found/, 'unknown group');
    const gm = tg.userMessage(CLIENT, USER, { text: 'guruhda', chat: { id: -100123, type: 'supergroup', title: 'G' } });
    eq(gm.chat.type, 'supergroup', 'group message');
    const reply = await client.sendMessage(-100123, 'ok', { reply_parameters: { message_id: gm.message_id } });
    eq([reply.chat.id, reply.chat.type], [-100123, 'supergroup'], 'group chat object');
  });

  await test('strictChats: foydalanuvchi botni boshlamagan bo\'lsa → 403', async () => {
    const strict = await startFakeTelegram({ strictChats: true });
    try {
      const api = new Api(CLIENT, { apiRoot: strict.url });
      await rejects(api.sendMessage(777, 'x'), /bot can't initiate conversation/, 'unknown chat');
      strict.userMessage(CLIENT, { id: 777, is_bot: false, first_name: 'N' }, { text: '/start' });
      await api.sendMessage(777, 'ok');
    } finally {
      await strict.close();
    }
  });

  await test('grammY Bot: /start → reply, tugma → answerCallbackQuery + editMessageText', async () => {
    const bot = new Bot(CLIENT, { client: { apiRoot: tg.url } });
    bot.command('start', (ctx) =>
      ctx.reply(`Salom, <b>${ctx.from?.first_name ?? ''}</b>!`, {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text('👨‍💻 Operatorlar', 'ls:operator'),
      }),
    );
    bot.callbackQuery(/^ls:/, async (ctx) => {
      await ctx.answerCallbackQuery();
      await ctx.editMessageText('👨‍💻 <b>Operatorlarimiz</b>', { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('🟢 Aziz', 'card:1') });
    });
    await bot.init();
    await bot.handleUpdate(tg.messageUpdate(CLIENT, USER, { text: '/start' }));
    const hello = tg.lastSent(CLIENT, USER.id)!;
    eq(hello.text, 'Salom, Ali!', 'reply');
    const press = tg.pressButton(CLIENT, USER, hello, 'ls:operator');
    await bot.handleUpdate(press);
    const after = tg.message(CLIENT, USER.id, hello.id)!;
    eq([after.text, after.buttons[0]?.callback_data, after.edits], ['Operatorlarimiz'.replace(/^/, '👨‍💻 '), 'card:1', 1], 'edited');
    assert(tg.callbackAnswer(press.callback_query!.id), 'answered');
    assert(!tg.unansweredCallbacks(CLIENT).includes(press.callback_query!.id), 'not pending');
  });

  // ── src/tg.ts bilan integratsiya (botlar orasida media ko'chirish) ──
  process.env.CLIENT_BOT_TOKEN = CLIENT;
  process.env.STAFF_BOT_TOKEN = STAFF;
  process.env.TELEGRAM_API_ROOT = tg.url;
  const tgmod = await import('../src/tg.js');

  await test('src/tg.ts sendContent: client file_id → staff botga qayta yuklanadi', async () => {
    const bytes = fakeJpeg({ seed: 1234 });
    const photo = tg.photo(CLIENT, bytes);
    const incoming = tg.userMessage(CLIENT, USER, { photo, caption: 'Mana rasm' });
    const content = tgmod.extractContent(incoming);
    assert(content && content.kind === 'photo', 'extractContent photo');
    const res = await tgmod.sendContent('staff', USER.id, content, 'client', { header: '👤 Ali', headerSuffix: ' · @ali_u' });
    assert(res.fileId && res.fileId.startsWith('F_222222_'), `staff file id: ${res.fileId}`);
    assert(bytesEqual(tg.fileBytes(res.fileId), bytes), 'same bytes after re-upload');
    const call = tg.lastCall(STAFF, 'sendPhoto')!;
    assert(call.multipart && call.uploaded.length === 1, 'was an upload, not the client file_id');
    const sent = tg.message(STAFF, USER.id, res.messageId)!;
    eq(sent.text, '👤 Ali · @ali_u\nMana rasm', 'caption with header');
    eq(sent.message.caption_entities, [{ type: 'bold', offset: 0, length: 6 }], 'header bold (UTF-16: 👤 is 2 units)');
    const same = await tgmod.sendContent('client', USER2.id, content, 'client');
    eq(same.fileId, content.fileId, 'same bot → file_id reused');
  });

  await test('src/tg.ts sendContent: matn + sarlavha entity siljishi (emoji)', async () => {
    const incoming = tg.userMessage(STAFF, USER, {
      text: '😀 salom dunyo',
      entities: [{ type: 'italic', offset: 3, length: 5 }],
    });
    const content = tgmod.extractContent(incoming)!;
    const res = await tgmod.sendContent('client', USER.id, content, 'staff', { header: '👨‍💻 Aziz' });
    const m = tg.message(CLIENT, USER.id, res.messageId)!;
    eq(m.text, '👨‍💻 Aziz\n😀 salom dunyo', 'text');
    eq(m.message.entities, [
      { type: 'bold', offset: 0, length: 10 },
      { type: 'italic', offset: 14, length: 5 },
    ], 'shifted entities');
    const { data } = await tgmod.downloadFile('staff', tg.makeFileId(STAFF, 'document', new Uint8Array([5, 6, 7])));
    eq([...data], [5, 6, 7], 'downloadFile');
  });
} finally {
  await tg.close();
}

console.log(`\n${failed ? '❌' : '✅'} ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;

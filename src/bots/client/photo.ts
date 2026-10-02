// Mijozlar botida xodim rasmini ko'rsatish: keshlangan file_id -> staff botdan qayta yuklash -> standart avatar.
// file_id lar botga xos — mijoz botida faqat mijoz boti file_id lari ishlatiladi.
import { InputFile } from 'grammy';
import type { Message as TgMessage } from 'grammy/types';
import { config } from '../../config.js';
import { placeholderJpeg } from '../../placeholder.js';
import {
  cacheClientPhoto,
  clearClientPhoto,
  deleteSetting,
  getSetting,
  getSettings,
  getStaff,
  setSetting,
} from '../../repo.js';
import { SETTING_KEYS } from '../../texts.js';
import { downloadFile } from '../../tg.js';
import type { Staff } from '../../types.js';
import { describeError, isNotModified, tgErrorCode, tgErrorDescription } from '../../util.js';

export type PhotoMedia = string | InputFile;

/** Rasmni yuborish yoki tahrirlash amali (sendPhoto / editMessageMedia). */
export type PhotoPerform = (media: PhotoMedia) => Promise<TgMessage | true>;

interface Attempt {
  name: string;
  /** null — bu variant mavjud emas, keyingisiga o'tiladi. */
  load: () => Promise<PhotoMedia | null>;
  upload: boolean;
  /**
   * Faqat yuklash (upload) variantlarida: shu instansiyadagi parallel so'rovlar bitta yuklashni kutadigan kalit
   * (xodim id + rasm unique id, yoki standart avatar). Birinchi so'rov yuklaydi, qolganlari uning file_id sini oladi.
   */
  key?: string;
  /**
   * Faqat yuklash variantlarida: yuklashdan OLDIN keshni bazadan qayta o'qish (keshsiz) — boshqa instansiya
   * shu orada yuklab, file_id ni saqlagan bo'lishi mumkin. null — keshda yo'q.
   */
  recheck?: () => Promise<string | null>;
  /** Yangi yuklangan faylning mijoz botidagi file_id sini saqlash. */
  onSuccess?: (fileId: string) => Promise<void>;
  /** file_id (keshlangan yoki qayta o'qilgan) yaroqsiz bo'lib chiqdi — keshni tozalash. */
  onFileError?: (fileId: string) => Promise<void>;
}

/**
 * Telegram faylni qabul qilmagani (noto'g'ri/eskirgan file_id, rasmni qayta ishlab bo'lmadi) haqidagi 400 xato.
 * Xabarga oid xatolar (tahrirlanadigan xabar topilmadi va h.k.) bunga kirmaydi — ular chaqiruvchiga qaytariladi.
 */
export function isFileError(e: unknown): boolean {
  if (tgErrorCode(e) !== 400) return false;
  const d = tgErrorDescription(e);
  if (/message|not modified|caption|entit|parse|button|markup|chat not found/i.test(d)) return false;
  return /file|photo|image|media|http url|web ?page|IMAGE_|PHOTO_|FILE_/i.test(d);
}

function largestPhotoId(res: TgMessage | true): string | undefined {
  if (res === true) return undefined;
  const p = res.photo;
  return p && p.length ? p[p.length - 1]!.file_id : undefined;
}

/** Standart avatar yuklashining kaliti. */
const PLACEHOLDER_KEY = 'placeholder';

/** Xodim rasmi yuklashining kaliti: xodim + aynan shu rasm (rasm almashtirilsa — yangi kalit). */
export function staffPhotoKey(staff: Pick<Staff, 'id' | 'photo_unique_id' | 'photo_file_id'>): string {
  return `staff:${staff.id}:${staff.photo_unique_id ?? staff.photo_file_id ?? ''}`;
}

function attemptsFor(staff: Staff): Attempt[] {
  const list: Attempt[] = [];
  const cached = staff.client_photo_file_id;
  if (cached) {
    list.push({
      name: 'cached',
      load: async () => cached,
      upload: false,
      onFileError: (bad) => clearClientPhoto(staff.id, bad),
    });
  }
  const staffFileId = staff.photo_file_id;
  if (staffFileId && config.hasStaffBot) {
    list.push({
      name: 'staff-reupload',
      load: async () => {
        const { data } = await downloadFile('staff', staffFileId);
        return new InputFile(data, `staff_${staff.id}.jpg`);
      },
      upload: true,
      key: staffPhotoKey(staff),
      // Xodim yozuvi so'rov boshida bir marta o'qilgan — shu orada boshqa instansiya keshlagan bo'lishi mumkin
      recheck: async () => (await getStaff(staff.id))?.client_photo_file_id ?? null,
      onSuccess: (fileId) => cacheClientPhoto(staff.id, staff.photo_unique_id, fileId),
      onFileError: (bad) => clearClientPhoto(staff.id, bad),
    });
  }
  list.push({
    name: 'placeholder-cached',
    load: () => getSetting(SETTING_KEYS.placeholderPhoto),
    upload: false,
    onFileError: () => deleteSetting(SETTING_KEYS.placeholderPhoto),
  });
  list.push({
    name: 'placeholder-upload',
    load: async () => new InputFile(placeholderJpeg(), 'avatar.jpg'),
    upload: true,
    key: PLACEHOLDER_KEY,
    // getSetting 30 soniya keshlaydi (null ham) — bu yerda keshsiz o'qiladi
    recheck: async () => (await getSettings([SETTING_KEYS.placeholderPhoto]))[SETTING_KEYS.placeholderPhoto],
    onSuccess: (fileId) => setSetting(SETTING_KEYS.placeholderPhoto, fileId),
    onFileError: () => deleteSetting(SETTING_KEYS.placeholderPhoto),
  });
  return list;
}

// ───────────────────────────── Parallel yuklashlarni birlashtirish ─────────────────────────────

/**
 * Shu instansiyada hozir davom etayotgan yuklashlar: kalit → mijoz botidagi ISHLAGAN file_id (yuklovchi so'rov
 * rasmni muvaffaqiyatli yuborgach) yoki null (yuklab/yuborib bo'lmadi). Kesh bo'sh paytda (rasm endigina
 * almashtirilgan yoki birinchi marta) bir vaqtda kelgan /start lar har biri qayta yuklamasligi uchun.
 */
const inflightUploads = new Map<string, Promise<string | null>>();

/** Testlar uchun: hozir davom etayotgan yuklashlar soni. */
export function inflightPhotoUploads(): number {
  return inflightUploads.size;
}

/** Bitta so'rovda kutiladigan boshqa yuklovchilar soni (yuklovchi xatoga uchrasa — navbatdagisi). */
const MAX_SHARED_WAITS = 3;

type Outcome = { ok: true; res: TgMessage | true } | { ok: false; error: unknown };

/**
 * Rasm bilan amalni bir marta bajarish. Faylga oid xato (yaroqsiz file_id / rasm) — `{ ok: false }`, keyingi
 * variantga o'tiladi; boshqa xatolar (403, xabar topilmadi, 429...) chaqiruvchiga tashlanadi.
 */
async function performOnce(staff: Staff, name: string, media: PhotoMedia, perform: PhotoPerform): Promise<Outcome> {
  try {
    return { ok: true, res: await perform(media) };
  } catch (e) {
    if (isNotModified(e)) return { ok: true, res: true };
    if (!isFileError(e)) throw e;
    console.warn(`[client] xodim #${staff.id} rasmi (${name}) qabul qilinmadi:`, tgErrorDescription(e));
    return { ok: false, error: e };
  }
}

async function clearBad(attempt: Attempt, fileId: string): Promise<void> {
  if (!attempt.onFileError) return;
  await attempt.onFileError(fileId).catch((err) => console.error('[client] rasm keshini tozalash xatosi:', describeError(err)));
}

interface RunState {
  staffRow: Staff;
  perform: PhotoPerform;
  /** Shu so'rovda Telegram qabul qilmagan file_id lar (qayta urinilmaydi). */
  failed: Set<string>;
  /** «rasm yuklanmoqda…» holatini ko'rsatish (bir marta). */
  announce: () => Promise<void>;
}

/** Yuklash varianti natijasi: `res` — bajarildi; aks holda (xato bilan yoki xatosiz) keyingi variantga o'tiladi. */
type UploadOutcome = { res: TgMessage | true } | { res?: undefined; error?: unknown };

/**
 * Yuklash varianti (xodim rasmi yoki standart avatar), parallel so'rovlar birlashtirilgan holda:
 *  1) shu kalit bo'yicha yuklash davom etayotgan bo'lsa — uning natijasini (file_id) kutib, u bilan yuboriladi;
 *  2) aks holda bu so'rov yuklovchi bo'ladi: avval kesh bazadan qayta o'qiladi (boshqa instansiya yuklagan
 *     bo'lsa — yuklanmaydi), keyin fayl yuklab olinib, yuklanadi. Ishlagan file_id kutayotganlarga beriladi.
 */
async function runUpload(attempt: Attempt, s: RunState): Promise<UploadOutcome> {
  const { staffRow: staff, perform, failed } = s;
  const key = attempt.key!;
  let lastError: unknown;

  // 1) Boshqa so'rov yuklayapti — natijasini kutamiz (u muvaffaqiyatsiz bo'lsa, navbatdagi yuklovchini)
  for (let i = 0; i < MAX_SHARED_WAITS; i++) {
    const pending = inflightUploads.get(key);
    if (!pending) break;
    const shared = await pending.catch(() => null);
    if (!shared || failed.has(shared)) continue;
    const out = await performOnce(staff, `${attempt.name}:shared`, shared, perform);
    if (out.ok) return { res: out.res };
    failed.add(shared);
    lastError = out.error;
    await clearBad(attempt, shared);
  }

  // 2) Yuklovchi. Ro'yxatdan o'tish yuqoridagi tekshiruv bilan bir sinxron qadamda (oraliqda await yo'q) —
  //    bir vaqtda kelgan so'rovlardan faqat bittasi yuklaydi.
  let settle!: (fileId: string | null) => void;
  const promise = new Promise<string | null>((resolve) => (settle = resolve));
  const registered = !inflightUploads.has(key);
  if (registered) inflightUploads.set(key, promise);
  let result: string | null = null;
  try {
    // 2a) Boshqa instansiya shu orada keshlagan file_id
    let rechecked: string | null = null;
    if (attempt.recheck) {
      rechecked = await attempt.recheck().catch((e: unknown) => {
        console.warn(`[client] xodim #${staff.id} rasmi keshini qayta o'qib bo'lmadi:`, describeError(e));
        return null;
      });
    }
    if (rechecked && !failed.has(rechecked)) {
      const out = await performOnce(staff, `${attempt.name}:recheck`, rechecked, perform);
      if (out.ok) {
        result = rechecked;
        return { res: out.res };
      }
      failed.add(rechecked);
      lastError = out.error;
      await clearBad(attempt, rechecked);
    }

    // 2b) Yuklash
    await s.announce();
    let media: PhotoMedia | null;
    try {
      media = await attempt.load();
    } catch (e) {
      console.warn(`[client] xodim #${staff.id} rasmi (${attempt.name}) olinmadi:`, tgErrorDescription(e));
      return { error: e };
    }
    if (media == null || media === '') return lastError === undefined ? {} : { error: lastError };
    const out = await performOnce(staff, attempt.name, media, perform);
    if (!out.ok) return { error: out.error };
    const fileId = largestPhotoId(out.res);
    if (fileId) {
      result = fileId;
      // Kutayotganlar keshga yozilishini kutmasin
      settle(fileId);
      if (attempt.onSuccess) {
        await attempt.onSuccess(fileId).catch((err) => console.error('[client] rasm keshini saqlash xatosi:', describeError(err)));
      }
    }
    return { res: out.res };
  } finally {
    settle(result);
    if (registered && inflightUploads.get(key) === promise) inflightUploads.delete(key);
  }
}

/**
 * Xodim rasmi bilan amalni bajarish. Keshlangan file_id ishlamasa — kesh tozalanib, fayl qayta yuklanadi;
 * xodim rasmi umuman olinmasa — standart avatar ishlatiladi.
 * Faylga oid bo'lmagan xatolar (403, xabar topilmadi va h.k.) darhol chaqiruvchiga uzatiladi.
 * Bir vaqtda kelgan so'rovlar (kesh bo'sh paytda) rasmni bir marta yuklaydi (shu instansiya ichida), yuklashdan
 * oldin esa kesh bazadan qayta o'qiladi (boshqa instansiya yuklagan bo'lsa — qayta yuklanmaydi).
 */
export async function withStaffPhoto(
  staff: Staff,
  perform: PhotoPerform,
  beforeUpload?: () => Promise<void>,
): Promise<TgMessage | true> {
  let lastError: unknown = null;
  let announced = false;
  const state: RunState = {
    staffRow: staff,
    perform,
    failed: new Set<string>(),
    announce: async () => {
      if (announced || !beforeUpload) return;
      announced = true;
      await beforeUpload().catch(() => {});
    },
  };

  for (const attempt of attemptsFor(staff)) {
    if (attempt.upload && attempt.key) {
      const out = await runUpload(attempt, state);
      if (out.res !== undefined) return out.res;
      if (out.error !== undefined) lastError = out.error;
      continue;
    }

    let media: PhotoMedia | null;
    try {
      if (attempt.upload) await state.announce();
      media = await attempt.load();
    } catch (e) {
      console.warn(`[client] xodim #${staff.id} rasmi (${attempt.name}) olinmadi:`, tgErrorDescription(e));
      lastError = e;
      continue;
    }
    if (media == null || media === '') continue;
    if (typeof media === 'string' && state.failed.has(media)) continue;

    const out = await performOnce(staff, attempt.name, media, perform);
    if (!out.ok) {
      lastError = out.error;
      if (typeof media === 'string') {
        state.failed.add(media);
        await clearBad(attempt, media);
      }
      continue;
    }
    if (attempt.onSuccess) {
      const fileId = largestPhotoId(out.res);
      if (fileId) await attempt.onSuccess(fileId).catch((err) => console.error('[client] rasm keshini saqlash xatosi:', describeError(err)));
    }
    return out.res;
  }
  throw lastError ?? new Error('Xodim rasmini yuborib bo\'lmadi');
}

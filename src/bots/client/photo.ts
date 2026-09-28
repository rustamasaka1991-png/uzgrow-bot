// Mijozlar botida xodim rasmini ko'rsatish: keshlangan file_id -> staff botdan qayta yuklash -> standart avatar.
// file_id lar botga xos — mijoz botida faqat mijoz boti file_id lari ishlatiladi.
import { InputFile } from 'grammy';
import type { Message as TgMessage } from 'grammy/types';
import { config } from '../../config.js';
import { placeholderJpeg } from '../../placeholder.js';
import { cacheClientPhoto, clearClientPhoto, deleteSetting, getSetting, setSetting } from '../../repo.js';
import { SETTING_KEYS } from '../../texts.js';
import { downloadFile } from '../../tg.js';
import type { Staff } from '../../types.js';
import { isNotModified, tgErrorCode, tgErrorDescription } from '../../util.js';

export type PhotoMedia = string | InputFile;

/** Rasmni yuborish yoki tahrirlash amali (sendPhoto / editMessageMedia). */
export type PhotoPerform = (media: PhotoMedia) => Promise<TgMessage | true>;

interface Attempt {
  name: string;
  /** null — bu variant mavjud emas, keyingisiga o'tiladi. */
  load: () => Promise<PhotoMedia | null>;
  upload: boolean;
  /** Yangi yuklangan faylning mijoz botidagi file_id sini saqlash. */
  onSuccess?: (fileId: string) => Promise<void>;
  /** file_id yaroqsiz bo'lib chiqdi — keshni tozalash. */
  onFileError?: () => Promise<void>;
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

function attemptsFor(staff: Staff): Attempt[] {
  const list: Attempt[] = [];
  const cached = staff.client_photo_file_id;
  if (cached) {
    list.push({
      name: 'cached',
      load: async () => cached,
      upload: false,
      onFileError: () => clearClientPhoto(staff.id, cached),
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
      onSuccess: (fileId) => cacheClientPhoto(staff.id, staff.photo_unique_id, fileId),
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
    onSuccess: (fileId) => setSetting(SETTING_KEYS.placeholderPhoto, fileId),
  });
  return list;
}

/**
 * Xodim rasmi bilan amalni bajarish. Keshlangan file_id ishlamasa — kesh tozalanib, fayl qayta yuklanadi;
 * xodim rasmi umuman olinmasa — standart avatar ishlatiladi.
 * Faylga oid bo'lmagan xatolar (403, xabar topilmadi va h.k.) darhol chaqiruvchiga uzatiladi.
 */
export async function withStaffPhoto(
  staff: Staff,
  perform: PhotoPerform,
  beforeUpload?: () => Promise<void>,
): Promise<TgMessage | true> {
  let lastError: unknown = null;
  let announced = false;
  for (const attempt of attemptsFor(staff)) {
    let media: PhotoMedia | null;
    try {
      if (attempt.upload && beforeUpload && !announced) {
        announced = true;
        await beforeUpload().catch(() => {});
      }
      media = await attempt.load();
    } catch (e) {
      console.warn(`[client] xodim #${staff.id} rasmi (${attempt.name}) olinmadi:`, tgErrorDescription(e));
      lastError = e;
      continue;
    }
    if (media == null || media === '') continue;

    let res: TgMessage | true;
    try {
      res = await perform(media);
    } catch (e) {
      if (isNotModified(e)) return true;
      if (!isFileError(e)) throw e;
      console.warn(`[client] xodim #${staff.id} rasmi (${attempt.name}) qabul qilinmadi:`, tgErrorDescription(e));
      lastError = e;
      if (attempt.onFileError) await attempt.onFileError().catch((err) => console.error('[client] rasm keshini tozalash xatosi:', err));
      continue;
    }

    if (attempt.onSuccess) {
      const fileId = largestPhotoId(res);
      if (fileId) await attempt.onSuccess(fileId).catch((err) => console.error('[client] rasm keshini saqlash xatosi:', err));
    }
    return res;
  }
  throw lastError ?? new Error('Xodim rasmini yuborib bo\'lmadi');
}

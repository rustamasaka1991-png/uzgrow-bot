// Mini App uchun JSON (DTO) ko'rinishlari. Sanalar ISO satr sifatida qaytariladi.
import { createHash } from 'node:crypto';
import { signMediaToken } from '../auth.js';
import { botUsername, inviteLink, staffClientLink } from '../links.js';
import { isStaffAvailable } from '../repo.js';
import type {
  Conversation,
  ConversationView,
  Message,
  MessageMeta,
  MsgKind,
  Role,
  Sender,
  Staff,
  Via,
} from '../types.js';
import { clientName, roleLabel, tgErrorDescription } from '../util.js';

export type AppRole = 'client' | 'staff';

export interface StaffCardDTO {
  id: number;
  role: Role;
  role_label: string;
  full_name: string;
  position: string;
  description: string;
  is_online: boolean;
  photo_url: string | null;
  /** So'rov yuborgan mijozga nisbatan (xodim/admin uchun null) */
  conversation_id: number | null;
  unread: number;
}

export interface PeerDTO {
  name: string;
  subtitle: string;
  photo_url: string | null;
  is_online: boolean | null;
  initials: string;
}

export interface ConvSummaryDTO {
  id: number;
  staff_id: number;
  client_id: number;
  peer: PeerDTO;
  last_message_at: string | null;
  last_message_preview: string | null;
  last_sender: Sender | null;
  unread: number;
  is_active: boolean;
  /** Qo'shimcha: mijoz tomoni uchun — xodim hozir xabar qabul qila oladimi (xodim tomonida doim true) */
  available: boolean;
}

export interface MediaDTO {
  url: string | null;
  file_name: string | null;
  mime_type: string | null;
  file_size: number | null;
  inline: boolean;
  /** `url` dagi imzolangan tokenning amal qilish muddati (ISO). URL bo'lmasa null. */
  expires_at: string | null;
}

export interface MessageDTO {
  id: number;
  conversation_id: number;
  sender: Sender;
  outgoing: boolean;
  kind: MsgKind;
  text: string | null;
  created_at: string;
  via: Via;
  meta: MessageMeta | null;
  media: MediaDTO | null;
  /**
   * Suhbatdoshga yetkazilganmi: mijoz xabari — xodimlar botiga, xodim xabari — mijozga. Avto-javob — doim true.
   * false bo'lsa Mini App ❗ belgisini va «qayta yuborish» imkonini ko'rsatadi.
   */
  delivered: boolean;
  /** Yuboruvchi xabarni tahrirlaganmi. */
  edited: boolean;
  /** Oxirgi tahrir vaqti (ISO) yoki null. */
  edited_at: string | null;
}

export interface AdminStaffDTO extends StaffCardDTO {
  /** Xodim xodimlar botini to'xtatgan/bloklagan — mijoz xabarlari unga yetib bormayapti (navbatda). */
  bot_blocked: boolean;
  tg_user_id: number | null;
  tg_username: string | null;
  is_active: boolean;
  linked: boolean;
  invite_link: string | null;
  greeting: string | null;
  sort_order: number;
  created_at: string | null;
  /** Mijozlar uchun qisqa havola nomi (t.me/<mijoz_boti>?start=<link_code>) */
  link_code: string | null;
  /** Mijozlar uchun to'liq shaxsiy havola ('' — mijozlar boti username i aniqlanmagan) */
  client_link: string;
}

export interface StaffProfileDTO extends StaffCardDTO {
  tg_username: string | null;
  is_active: boolean;
  linked: boolean;
  greeting: string | null;
  /** Mijozlar uchun qisqa havola nomi */
  link_code: string | null;
  /** Mijozlar uchun to'liq shaxsiy havola ('' — aniqlanmagan) */
  client_link: string;
}

/** Mijoz tomonidagi suhbat qatori (xodim ma'lumotlari bilan). */
export interface ClientConvRow extends Conversation {
  staff_full_name: string;
  staff_role: Role;
  staff_position: string;
  staff_is_online: boolean;
  staff_photo_file_id: string | null;
  staff_photo_unique_id: string | null;
  staff_client_photo_file_id: string | null;
  staff_deleted: boolean;
  staff_available: boolean;
}

// ───────────────────────────── Media qoidalari ─────────────────────────────

/** Fayl biriktiriladigan xabar turlari. */
export const MEDIA_KINDS: ReadonlySet<MsgKind> = new Set<MsgKind>([
  'photo',
  'video',
  'animation',
  'document',
  'audio',
  'voice',
  'video_note',
  'sticker',
]);

/**
 * Brauzerda xavfsiz ko'rsatiladigan rasm turlari (SVG ataylab kiritilmagan).
 * GIF kiritilmagan: Telegram GIF fayllarni (hujjat sifatida yuborilganda ham) MPEG-4 animatsiyaga aylantiradi,
 * shuning uchun "image/gif" deb saqlangan hujjatning file_id si ko'pincha MP4 baytlarni qaytaradi.
 */
export const INLINE_IMAGE_MIMES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Mini App ichida ko'rsatiladigan hujjat-rasmning maksimal hajmi. */
export const MAX_INLINE_DOCUMENT_BYTES = 4 * 1024 * 1024;

/** Media proksi orqali beriladigan faylning maksimal hajmi (Vercel javob limiti 4.5 MB). */
export const MEDIA_PROXY_MAX_BYTES = Math.floor(4.4 * 1024 * 1024);

/** MIME turini normallashtirish (image/jpg -> image/jpeg). Noto'g'ri bo'lsa ''. */
export function normalizeMime(mime: string | null | undefined): string {
  const m = (mime ?? '').split(';')[0]!.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(m) || m.length > 100) return '';
  if (m === 'image/jpg' || m === 'image/pjpeg') return 'image/jpeg';
  return m;
}

/** Xabar faylini Mini App ichida rasm sifatida ko'rsatish mumkinmi. */
export function isInlineMedia(m: Pick<Message, 'kind' | 'mime_type' | 'file_size' | 'meta'>): boolean {
  if (m.file_size != null && m.file_size > MEDIA_PROXY_MAX_BYTES) return false;
  switch (m.kind) {
    case 'photo':
      return true;
    case 'sticker':
      return !m.meta?.sticker_animated && (normalizeMime(m.mime_type) || 'image/webp') === 'image/webp';
    case 'document':
      return (
        INLINE_IMAGE_MIMES.has(normalizeMime(m.mime_type)) &&
        (m.file_size == null || m.file_size <= MAX_INLINE_DOCUMENT_BYTES)
      );
    default:
      return false;
  }
}

// ───────────────────────────── Media tokenlari ─────────────────────────────

/** Media token kamida shuncha vaqt amal qiladi (soniya). */
export const MEDIA_TOKEN_MIN_TTL = 6 * 60 * 60;
/**
 * Token muddati shu qadamga yaxlitlanadi: bir oyna ichida bir xil xabar uchun URL o'zgarmaydi,
 * shuning uchun brauzer keshi qayta ochilganda ham ishlaydi. Natijada token 6–12 soat amal qiladi.
 */
export const MEDIA_TOKEN_BUCKET = 6 * 60 * 60;

/** Hozirgi vaqt uchun media tokenining (barqaror) tugash vaqti, epoch soniyalarda. */
export function mediaTokenExpiry(nowSec = Math.floor(Date.now() / 1000)): number {
  return Math.ceil((nowSec + MEDIA_TOKEN_MIN_TTL) / MEDIA_TOKEN_BUCKET) * MEDIA_TOKEN_BUCKET;
}

/** Xabar fayli uchun proksi URL (imzolangan, muddatli) va uning tugash vaqti. */
export function messageMediaUrl(messageId: number, nowSec = Math.floor(Date.now() / 1000)): { url: string; exp: number } {
  const exp = mediaTokenExpiry(nowSec);
  return { url: `/api/media?t=${encodeURIComponent(signMediaToken(messageId, exp - nowSec, nowSec))}`, exp };
}

// ───────────────────────────── Yordamchilar ─────────────────────────────

export function iso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const x = d instanceof Date ? d : new Date(d);
  return Number.isNaN(x.getTime()) ? null : x.toISOString();
}

/** Ismdan avatar uchun bosh harflar ("Ali Valiyev" -> "AV"). */
export function initials(name: string): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  let out = '';
  for (const w of words) {
    const ch = Array.from(w).find((c) => /[\p{L}\p{N}]/u.test(c));
    if (ch) out += ch;
    if (Array.from(out).length >= 2) break;
  }
  return out ? out.toLocaleUpperCase('uz') : '?';
}

type StaffPhotoFields = Pick<Staff, 'photo_file_id' | 'photo_unique_id' | 'client_photo_file_id'>;

/** Rasm versiyasi (URL keshini yangilash uchun). Rasm bo'lmasa null. */
export function staffPhotoVersion(s: StaffPhotoFields): string | null {
  const file = s.photo_file_id || s.client_photo_file_id;
  if (!file) return null;
  return s.photo_unique_id || createHash('sha256').update(file).digest('base64url').slice(0, 16);
}

export function staffPhotoUrl(staffId: number, s: StaffPhotoFields): string | null {
  const v = staffPhotoVersion(s);
  return v ? `/api/media?staff=${staffId}&v=${encodeURIComponent(v)}` : null;
}

function staffSubtitle(role: Role, position: string | null | undefined): string {
  const pos = (position ?? '').trim();
  return pos ? `${roleLabel(role)} · ${pos}` : roleLabel(role);
}

// ───────────────────────────── Xodim kartalari ─────────────────────────────

export function staffCardDTO(s: Staff, conv?: { id: number; unread: number } | null): StaffCardDTO {
  return {
    id: s.id,
    role: s.role,
    role_label: roleLabel(s.role),
    full_name: s.full_name,
    position: s.position ?? '',
    description: s.description ?? '',
    is_online: !!s.is_online,
    photo_url: s.deleted_at ? null : staffPhotoUrl(s.id, s),
    conversation_id: conv?.id ?? null,
    unread: conv?.unread ?? 0,
  };
}

/**
 * Xodimning mijozlar uchun shaxsiy havolasi (https://t.me/<mijoz_boti>?start=<link_code>). Bot username i
 * aniqlanmasa yoki Telegram/baza xatosi bo'lsa — '' (profil/ro'yxat baribir qaytadi).
 */
export async function safeClientLink(s: Pick<Staff, 'id' | 'link_code'>): Promise<string> {
  try {
    return await staffClientLink({ id: s.id, link_code: s.link_code ?? null });
  } catch (e) {
    console.error('staffClientLink xatosi:', tgErrorDescription(e));
    return '';
  }
}

/** Mijozlar boti username i (Mini App dagi havola prefiksi uchun). Aniqlanmasa — ''. */
export async function safeClientBotUsername(): Promise<string> {
  try {
    return await botUsername('client');
  } catch (e) {
    console.error('botUsername(client) xatosi:', tgErrorDescription(e));
    return '';
  }
}

/** Xodimning o'z profili (Mini App "Profil" bo'limi). unread — barcha chatlardagi o'qilmaganlar. */
export async function staffProfileDTO(s: Staff, totalUnread: number): Promise<StaffProfileDTO> {
  return {
    ...staffCardDTO(s, null),
    unread: totalUnread,
    tg_username: s.tg_username,
    is_active: s.is_active,
    linked: s.tg_user_id != null,
    greeting: s.greeting,
    link_code: s.link_code ?? null,
    client_link: await safeClientLink(s),
  };
}

export async function adminStaffDTO(s: Staff): Promise<AdminStaffDTO> {
  const linked = s.tg_user_id != null;
  let link: string | null = null;
  const clientLink = safeClientLink(s);
  if (!linked && s.invite_code) {
    try {
      link = await inviteLink(s.invite_code);
    } catch (e) {
      console.error('inviteLink xatosi:', tgErrorDescription(e));
      link = null;
    }
  }
  return {
    ...staffCardDTO(s, null),
    bot_blocked: linked && !!s.bot_blocked,
    tg_user_id: s.tg_user_id,
    tg_username: s.tg_username,
    is_active: s.is_active,
    linked,
    invite_link: link,
    greeting: s.greeting,
    sort_order: s.sort_order,
    created_at: iso(s.created_at),
    link_code: s.link_code ?? null,
    client_link: await clientLink,
  };
}

// ───────────────────────────── Suhbatlar ─────────────────────────────

/** Suhbat + xodim obyektidan mijoz qatorini yasash (qo'shimcha so'rovsiz). */
export function clientRowFrom(conv: Conversation, s: Staff): ClientConvRow {
  return {
    ...conv,
    staff_full_name: s.full_name,
    staff_role: s.role,
    staff_position: s.position,
    staff_is_online: s.is_online,
    staff_photo_file_id: s.photo_file_id,
    staff_photo_unique_id: s.photo_unique_id,
    staff_client_photo_file_id: s.client_photo_file_id,
    staff_deleted: !!s.deleted_at,
    staff_available: isStaffAvailable(s),
  };
}

/** Mijoz uchun: suhbatdosh — xodim. */
export function clientConvSummary(row: ClientConvRow, activeId: number | null): ConvSummaryDTO {
  const name = row.staff_full_name;
  return {
    id: row.id,
    staff_id: row.staff_id,
    client_id: row.client_id,
    peer: {
      name,
      subtitle: staffSubtitle(row.staff_role, row.staff_position),
      photo_url: row.staff_deleted
        ? null
        : staffPhotoUrl(row.staff_id, {
            photo_file_id: row.staff_photo_file_id,
            photo_unique_id: row.staff_photo_unique_id,
            client_photo_file_id: row.staff_client_photo_file_id,
          }),
      is_online: row.staff_available ? !!row.staff_is_online : false,
      initials: initials(name),
    },
    last_message_at: iso(row.last_message_at),
    last_message_preview: row.last_message_preview,
    last_sender: row.last_sender,
    unread: row.unread_client ?? 0,
    is_active: activeId != null && row.id === activeId,
    available: !!row.staff_available,
  };
}

/**
 * staffConvSummary o'qiydigan ustunlar. DIQQAT: Mini App ro'yxat imzosi (list_sig) bazada aynan shu ustunlardan
 * hisoblanadi (queries.ts: staffListSigExpr). Bu funksiya yangi ustunga bog'liq bo'lib qolsa yoki natija boshqacha
 * hisoblansa — imzoga ham qo'shing va STAFF_LIST_SIG_VERSION ni oshiring.
 */
export type StaffConvSummarySource = Pick<
  ConversationView,
  | 'id'
  | 'staff_id'
  | 'client_id'
  | 'last_message_at'
  | 'last_message_preview'
  | 'last_sender'
  | 'unread_staff'
  | 'client_first_name'
  | 'client_last_name'
  | 'client_username'
>;

/** Xodim uchun: suhbatdosh — mijoz. */
export function staffConvSummary(row: StaffConvSummarySource, activeId: number | null): ConvSummaryDTO {
  const name = clientName({ first_name: row.client_first_name, last_name: row.client_last_name });
  return {
    id: row.id,
    staff_id: row.staff_id,
    client_id: row.client_id,
    peer: {
      name,
      subtitle: row.client_username ? `@${row.client_username}` : '',
      photo_url: null,
      is_online: null,
      initials: initials(name),
    },
    last_message_at: iso(row.last_message_at),
    last_message_preview: row.last_message_preview,
    last_sender: row.last_sender,
    unread: row.unread_staff ?? 0,
    is_active: activeId != null && row.id === activeId,
    available: true,
  };
}

// ───────────────────────────── Xabarlar ─────────────────────────────

/** messageDTO o'qiydigan ustunlar (sync ularni ixcham so'rov bilan oladi — queries.ts: syncMessages). */
export type MessageDTOSource = Pick<
  Message,
  | 'id'
  | 'conversation_id'
  | 'sender'
  | 'kind'
  | 'text'
  | 'meta'
  | 'file_id_client'
  | 'file_id_staff'
  | 'file_name'
  | 'mime_type'
  | 'file_size'
  | 'client_chat_msg_id'
  | 'staff_chat_msg_id'
  | 'via'
  | 'created_at'
  | 'edited_at'
>;

export function messageDTO(m: MessageDTOSource, role: AppRole): MessageDTO {
  let media: MediaDTO | null = null;
  if (MEDIA_KINDS.has(m.kind)) {
    const hasFile = !!(m.file_id_client || m.file_id_staff);
    const inline = hasFile && isInlineMedia(m);
    const signed = inline ? messageMediaUrl(m.id) : null;
    media = {
      url: signed ? signed.url : null,
      file_name: m.file_name ?? null,
      mime_type: m.kind === 'photo' ? 'image/jpeg' : m.mime_type ?? null,
      file_size: m.file_size ?? null,
      inline,
      expires_at: signed ? new Date(signed.exp * 1000).toISOString() : null,
    };
  }
  return {
    id: m.id,
    conversation_id: m.conversation_id,
    sender: m.sender,
    outgoing: (role === 'client' && m.sender === 'client') || (role === 'staff' && m.sender === 'staff'),
    kind: m.kind,
    text: m.text ?? null,
    created_at: iso(m.created_at) ?? new Date(0).toISOString(),
    via: m.via,
    meta: m.meta ?? null,
    media,
    delivered: isDelivered(m),
    edited: m.edited_at != null,
    edited_at: iso(m.edited_at),
  };
}

/** Xabar suhbatdoshga yetkazilganmi (saqlangan yozuv bo'yicha). */
export function isDelivered(m: Pick<Message, 'sender' | 'client_chat_msg_id' | 'staff_chat_msg_id'>): boolean {
  if (m.sender === 'client') return m.staff_chat_msg_id != null;
  if (m.sender === 'staff') return m.client_chat_msg_id != null;
  return true;
}

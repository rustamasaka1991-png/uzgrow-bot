import type { MessageEntity } from 'grammy/types';

export type Role = 'operator' | 'manager';
export type Sender = 'client' | 'staff' | 'bot';
export type Via = 'bot' | 'webapp';
export type BotKind = 'client' | 'staff';

export type MsgKind =
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
  | 'contact';

export interface Staff {
  id: number;
  role: Role;
  full_name: string;
  position: string;
  description: string;
  greeting: string | null;
  photo_file_id: string | null;
  photo_unique_id: string | null;
  client_photo_file_id: string | null;
  tg_user_id: number | null;
  tg_username: string | null;
  invite_code: string | null;
  is_active: boolean;
  is_online: boolean;
  sort_order: number;
  active_conversation_id: number | null;
  /** Aktiv suhbat oxirgi marta aniq tanlangan vaqt (setStaffActiveConversation). */
  active_set_at: Date | null;
  /** Xodim xodimlar botini bloklagan/to'xtatgan — xabarlar yetkazilmaydi (u qaytganda yetkaziladi). */
  bot_blocked: boolean;
  /** Bloklashdan oldingi onlayn holati (qaytganda tiklanadi). */
  online_before_block: boolean | null;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface Client {
  tg_user_id: number;
  first_name: string;
  last_name: string | null;
  username: string | null;
  language_code: string | null;
  active_conversation_id: number | null;
  bot_blocked: boolean;
  created_at: Date;
  last_seen_at: Date;
}

export interface Conversation {
  id: number;
  client_id: number;
  staff_id: number;
  auto_replied: boolean;
  unread_staff: number;
  unread_client: number;
  last_message_at: Date | null;
  last_message_preview: string | null;
  last_sender: Sender | null;
  created_at: Date;
}

export interface MessageMeta {
  latitude?: number;
  longitude?: number;
  phone_number?: string;
  contact_name?: string;
  emoji?: string;
  duration?: number;
  width?: number;
  height?: number;
  /** Stiker animatsiyali/video bo'lsa true */
  sticker_animated?: boolean;
}

export interface Message {
  id: number;
  conversation_id: number;
  sender: Sender;
  kind: MsgKind;
  text: string | null;
  entities: MessageEntity[] | null;
  file_id_client: string | null;
  file_id_staff: string | null;
  file_unique_id: string | null;
  file_name: string | null;
  mime_type: string | null;
  file_size: number | null;
  meta: MessageMeta | null;
  client_chat_msg_id: number | null;
  staff_chat_id: number | null;
  staff_chat_msg_id: number | null;
  via: Via;
  created_at: Date;
  /** Yuboruvchi xabarni tahrirlagan vaqt (bo'lmasa null). */
  edited_at: Date | null;
  /** Yetkazish da'vo qilingan vaqt (parallel qayta yetkazishlarda takrorlanmaslik uchun). */
  delivery_claimed_at: Date | null;
  /** Qayta urinib bo'lmaydigan yetkazish xatosi (masalan, 'file_too_big'). */
  delivery_error: string | null;
}

/** Bir tomondan kelgan xabar mazmuni (bot yoki Mini App orqali). */
export interface Content {
  kind: MsgKind;
  /** Matn yoki izoh (caption) */
  text?: string;
  entities?: MessageEntity[];
  /** Manba botdagi file_id (bot orqali kelganda) */
  fileId?: string;
  fileUniqueId?: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  meta?: MessageMeta;
  /** Mini App orqali yuklangan fayl (fileId o'rniga) */
  upload?: { data: Uint8Array; fileName: string; mimeType: string };
}

/** Konversatsiya + ikki tomon haqida ma'lumot (ro'yxatlar uchun). */
export interface ConversationView extends Conversation {
  staff_full_name: string;
  staff_role: Role;
  staff_position: string;
  staff_photo_unique_id: string | null;
  staff_is_online: boolean;
  client_first_name: string;
  client_last_name: string | null;
  client_username: string | null;
}

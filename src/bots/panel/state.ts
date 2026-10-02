// Boshqaruv paneli (admin / ROP / developer) holat mashinasi: user_state (bot = 'staff') jadvalida saqlanadi.
// Kutilayotgan panel holati xodim xabarlarini mijozga yo'naltirishdan USTUN turadi (panelga kiritilgan matn hech
// qachon mijozga ketib qolmaydi). Bu yerda — holat turlari, ularni tekshirish va atomik (compare-and-swap) saqlash;
// holatlarni qayta ishlash — ../admin.ts (xodim, matnlar), ./broadcast.ts (ommaviy xabar), ./developer.ts (rollar).
import type { Message as TgMessage } from 'grammy/types';
import { BROADCAST_KINDS, type BroadcastContent } from '../../broadcast.js';
import { db } from '../../db.js';
import { clearState, setState } from '../../repo.js';
import type { AssignableRole, PanelPerm } from '../../roles.js';
import type { Role } from '../../types.js';
import { render, stripKeyboard, type StaffContext, type View } from '../staff/ui.js';

// ───────────────────────────── Turlar ─────────────────────────────

export type AddStage = 'role' | 'name' | 'position' | 'description' | 'greeting' | 'photo';
export const ADD_STAGES: readonly AddStage[] = ['role', 'name', 'position', 'description', 'greeting', 'photo'];

export type TextField = 'full_name' | 'position' | 'description' | 'greeting';
/** `link_code` — mijozlar uchun shaxsiy havola nomi (t.me/<mijoz_boti>?start=<nom>). */
export type EditField = TextField | 'photo' | 'link_code';
// Tartib muhim: stateTag() indeksni ishlatadi — yangi maydonlar faqat oxiriga qo'shiladi
export const EDIT_FIELDS: readonly EditField[] = ['full_name', 'position', 'description', 'greeting', 'photo', 'link_code'];

export type SettingName = 'welcome' | 'greeting' | 'offline';

export function isSettingName(s: string | undefined): s is SettingName {
  return s === 'welcome' || s === 'greeting' || s === 'offline';
}

export interface Draft {
  role?: Role;
  full_name?: string;
  position?: string;
  description?: string;
  /** null — standart avto-javob */
  greeting?: string | null;
}

export interface InputStateBase {
  /** Oxirgi so'rov xabari (keyingi qadamda uning tugmalari olib tashlanadi) */
  promptMsgId?: number;
  /**
   * Noto'g'ri turdagi albom (media group) kelganda so'rov faqat BIR marta qayta ko'rsatiladi: albomning qolgan
   * elementlari shu belgi orqali jimgina e'tiborsiz qoldiriladi. Keyingi albom bo'lmagan xabar uni o'chiradi.
   */
  ignoreGroup?: string;
}
export interface AddState extends InputStateBase {
  step: 'add';
  stage: AddStage;
  draft: Draft;
}
export interface EditState extends InputStateBase {
  step: 'edit';
  staffId: number;
  field: EditField;
}
export interface SettingState extends InputStateBase {
  step: 'setting';
  key: SettingName;
}
/** 📣 Mijozlarga xabar: admin/ROP/developer yuboriladigan xabarni kutyapmiz. */
export interface BroadcastState extends InputStateBase {
  step: 'broadcast';
}
/** 📣 Xabar qabul qilindi, oldindan ko'rinishi ko'rsatildi — «✅ Yuborish» (bc:send) kutilmoqda. */
export interface BroadcastConfirmState extends InputStateBase {
  step: 'broadcast_confirm';
  content: BroadcastContent;
  /** ROP yuborgan asl xabar (xodimlar botidagi chatda) */
  srcMsgId: number;
}
/** 🛠 Developer: yangi admin/ROP ning Telegram ID si (yoki forward qilingan xabari) kutilmoqda. */
export interface DevAddState extends InputStateBase {
  step: 'dev_add';
  role: AssignableRole;
}
/**
 * Rasm albom (media group) bo'lib kelganda: birinchi rasm qabul qilingach, albomning qolgan rasmlari
 * ketma-ket kelsa ham mijozga yo'naltirilib ketmasligi uchun qisqa "iz". Boshqa har qanday xabar uni o'chiradi.
 */
export interface GroupState {
  step: 'group';
  mediaGroupId: string;
  promptMsgId?: number;
}
export type InputState = AddState | EditState | SettingState | BroadcastState | BroadcastConfirmState | DevAddState;
export type AdminState = InputState | GroupState;

/**
 * Panel kiritmasini kutish muddati (har bir qadam uni yangilaydi). Undan keyin yozilgan matn hech qachon
 * xodim ma'lumoti, umumiy matn yoki ommaviy xabar sifatida qabul qilinmaydi.
 */
export const INPUT_TTL_SEC = 15 * 60;

/** Holat qaysi huquqni talab qiladi (rol o'zgarsa — holat bekor qilinadi). */
export function statePerm(st: AdminState): PanelPerm {
  switch (st.step) {
    case 'broadcast':
    case 'broadcast_confirm':
      return 'broadcast';
    case 'dev_add':
      return 'developer';
    default:
      return 'panel';
  }
}

// ───────────────────────────── Tekshirish ─────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isBroadcastContent(v: unknown): v is BroadcastContent {
  if (!isPlainObject(v)) return false;
  if (!BROADCAST_KINDS.includes(v.kind as BroadcastContent['kind'])) return false;
  if (v.text !== undefined && typeof v.text !== 'string') return false;
  if (v.entities !== undefined && !Array.isArray(v.entities)) return false;
  if (v.kind === 'text') return typeof v.text === 'string' && v.text.trim() !== '';
  return typeof v.fileId === 'string' && v.fileId !== '';
}

export function parseState(raw: unknown): AdminState | null {
  if (!isPlainObject(raw)) return null;
  const r = raw;
  if (r.promptMsgId !== undefined && !Number.isSafeInteger(r.promptMsgId)) return null;
  if (r.ignoreGroup !== undefined && (typeof r.ignoreGroup !== 'string' || !r.ignoreGroup)) return null;
  switch (r.step) {
    case 'add': {
      if (!ADD_STAGES.includes(r.stage as AddStage)) return null;
      if (!isPlainObject(r.draft)) return null;
      const d = r.draft;
      if (d.role !== undefined && d.role !== 'operator' && d.role !== 'manager') return null;
      for (const k of ['full_name', 'position', 'description']) {
        if (d[k] !== undefined && typeof d[k] !== 'string') return null;
      }
      if (d.greeting !== undefined && d.greeting !== null && typeof d.greeting !== 'string') return null;
      return raw as unknown as AddState;
    }
    case 'edit':
      if (!Number.isSafeInteger(r.staffId) || !EDIT_FIELDS.includes(r.field as EditField)) return null;
      return raw as unknown as EditState;
    case 'setting':
      return isSettingName(r.key as string) ? (raw as unknown as SettingState) : null;
    case 'broadcast':
      return raw as unknown as BroadcastState;
    case 'broadcast_confirm':
      if (!Number.isSafeInteger(r.srcMsgId) || !isBroadcastContent(r.content)) return null;
      return raw as unknown as BroadcastConfirmState;
    case 'dev_add':
      return r.role === 'admin' || r.role === 'rop' ? (raw as unknown as DevAddState) : null;
    case 'group':
      return typeof r.mediaGroupId === 'string' && r.mediaGroupId ? (raw as unknown as GroupState) : null;
    default:
      return null;
  }
}

// ───────────────────────────── Saqlash (atomik) ─────────────────────────────

export interface StateRow {
  st: AdminState;
  /** Oxirgi yangilanishdan beri o'tgan vaqt (soniya) */
  ageSec: number;
  /** INPUT_TTL_SEC dan yangi */
  fresh: boolean;
}

/** Holat + uning yoshi (muddati o'tgan holat ham qaytadi — chaqiruvchi uni bekor qiladi). */
export async function loadStateRow(userId: number): Promise<StateRow | null> {
  const rows = await db()<{ state: unknown; age: number }[]>`
    select state, extract(epoch from (now() - updated_at))::float8 as age
    from user_state where bot = 'staff' and tg_user_id = ${userId}`;
  const r = rows[0];
  if (!r) return null;
  const st = parseState(r.state);
  if (!st) {
    await clearState('staff', userId);
    return null;
  }
  const ageSec = Number(r.age) || 0;
  return { st, ageSec, fresh: ageSec < INPUT_TTL_SEC };
}

/** Amaldagi (muddati o'tmagan) holat. */
export async function loadState(userId: number): Promise<AdminState | null> {
  const row = await loadStateRow(userId);
  return row?.fresh ? row.st : null;
}

/**
 * Compare-and-swap: holat hali ham `expected` bo'lsa, uni `next` ga almashtiradi (null — o'chiradi).
 * Bir vaqtda kelgan ikki xabar (masalan, albomdagi 2 ta rasm) yoki tugmani ikki marta bosish bir amalni
 * ikki marta bajarmasligi uchun.
 */
export async function casState(userId: number, expected: AdminState, next: AdminState | null): Promise<boolean> {
  const sql = db();
  const rows = next
    ? await sql`
        update user_state set state = ${sql.json(next as never)}, updated_at = now()
        where bot = 'staff' and tg_user_id = ${userId} and state = ${sql.json(expected as never)}
        returning 1 as ok`
    : await sql`
        delete from user_state
        where bot = 'staff' and tg_user_id = ${userId} and state = ${sql.json(expected as never)}
        returning 1 as ok`;
  return rows.length > 0;
}

/** Amalni yakunlash: holat o'chiriladi (albom bo'lsa — uning qolgan qismi uchun iz qoldiriladi). */
export async function finishState(userId: number, st: InputState, msg: TgMessage | null): Promise<boolean> {
  const next: GroupState | null = msg?.media_group_id ? { step: 'group', mediaGroupId: msg.media_group_id } : null;
  return casState(userId, st, next);
}

/** Holatni o'chirib, o'chirilgan holatni (muddati o'tgan bo'lsa ham) va uning yangiligini qaytaradi. */
export async function takeStateRow(userId: number): Promise<{ st: AdminState; fresh: boolean } | null> {
  const rows = await db()<{ state: unknown; fresh: boolean }[]>`
    delete from user_state where bot = 'staff' and tg_user_id = ${userId}
    returning state, (extract(epoch from (now() - updated_at)) < ${INPUT_TTL_SEC}) as fresh`;
  const r = rows[0];
  const st = r ? parseState(r.state) : null;
  return st ? { st, fresh: !!r!.fresh } : null;
}

/** Holatni o'chirib, o'chirilgan (va hali eskirmagan) holatni qaytaradi. */
export async function takeState(userId: number): Promise<AdminState | null> {
  const r = await takeStateRow(userId);
  return r?.fresh ? r.st : null;
}

/** Yangi holatni saqlab, so'rov xabarini ko'rsatadi va uning id sini holatga yozadi. */
export async function enterState(ctx: StaffContext, st: AdminState, view: View, mode: 'edit' | 'new'): Promise<void> {
  const uid = ctx.from!.id;
  await setState('staff', uid, st);
  const msgId = await render(ctx, view, mode);
  await casState(uid, st, { ...st, promptMsgId: msgId });
}

/** Albom belgisi olib tashlangan holat. */
export function withoutGroup<T extends InputState>(st: T): T {
  if (st.ignoreGroup === undefined) return st;
  const copy = { ...st };
  delete copy.ignoreGroup;
  return copy;
}

/**
 * Noto'g'ri kiritishda so'rovni qayta ko'rsatish (./broadcast.ts, ./developer.ts uchun umumiy).
 * Albom (media group) bo'lsa — so'rov faqat bir marta: xabar yuborishdan OLDIN albom CAS bilan "egallanadi",
 * shuning uchun bir vaqtda kelgan elementlardan faqat bittasi so'rov yuboradi, qolganlari jimgina tugaydi.
 * `nextOf` — so'rovdan keyingi holat (standart: o'sha holat).
 */
export async function repromptState<T extends InputState>(
  ctx: StaffContext,
  st: T,
  msg: TgMessage | null,
  view: View,
  nextOf: (cur: T) => InputState = (cur) => cur,
): Promise<void> {
  const uid = ctx.from!.id;
  let cur: T = st;
  const mgid = msg?.media_group_id;
  if (mgid && cur.ignoreGroup !== mgid) {
    const claimed: T = { ...cur, ignoreGroup: mgid };
    if (!(await casState(uid, cur, claimed))) return;
    cur = claimed;
  }
  await stripKeyboard(ctx, cur.promptMsgId);
  const msgId = await render(ctx, view, 'new');
  const base = nextOf(cur);
  // Albom bo'lmagan xabar — eski albom belgisi kerak emas
  const next = mgid ? { ...base, ignoreGroup: mgid, promptMsgId: msgId } : { ...withoutGroup(base), promptMsgId: msgId };
  await casState(uid, cur, next);
}

/**
 * Boshqa foydalanuvchining (masalan, huquqi olib tashlangan admin/ROP) tugallanmagan panel holatini o'chirish va
 * so'rov xabaridagi tugmalarni olib tashlash (xatolar e'tiborsiz). Holat bo'lgan bo'lsa true.
 */
export async function dropUserState(
  api: StaffContext['api'],
  userId: number,
): Promise<boolean> {
  const r = await takeStateRow(userId);
  if (!r) return false;
  if (r.st.promptMsgId) {
    await api.editMessageReplyMarkup(userId, r.st.promptMsgId, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
  }
  return true;
}

// Panel rollari (xodimlar botidagi boshqaruv paneli):
//   developer — ADMIN_IDS env dagi Telegram ID lar: hamma huquqlar + developer paneli (admin/ROP qo'shish, tizim holati);
//   rop       — rahbar: to'liq admin paneli + mijozlarga ommaviy xabar + shikoyatlar (shikoyat qilingan suhbatni ko'rish);
//   admin     — to'liq admin paneli (xodim qo'shish/tahrirlash/bloklash/o'chirish, matnlar, statistika)
//               + mijozlarga ommaviy xabar (shikoyatlarsiz).
// Admin va ROP larni developer Telegram ID orqali qo'shadi (panel_roles jadvali).
import { config } from './config.js';
import { db } from './db.js';

export type PanelRole = 'developer' | 'rop' | 'admin';
export type AssignableRole = Exclude<PanelRole, 'developer'>;
export type PanelPerm = 'panel' | 'complaints' | 'broadcast' | 'developer';

export const ROLE_TITLES: Record<PanelRole, string> = {
  developer: '🛠 Developer',
  rop: '👑 ROP (rahbar)',
  admin: '⚙️ Admin',
};

/** Rolga ruxsat: panel va ommaviy xabar — hamma rollar; shikoyat — ROP va developer; developer paneli — faqat developer. */
export function can(role: PanelRole | null | undefined, perm: PanelPerm): boolean {
  if (!role) return false;
  switch (perm) {
    case 'panel':
    case 'broadcast':
      return true;
    case 'complaints':
      return role === 'rop' || role === 'developer';
    case 'developer':
      return role === 'developer';
    default:
      return false;
  }
}

export function isDeveloper(tgUserId: number | null | undefined): boolean {
  return !!tgUserId && config.adminIds.includes(tgUserId);
}

const cache = new Map<number, { role: AssignableRole | null; at: number }>();
const CACHE_TTL_MS = 10_000;

export function clearRoleCache(): void {
  cache.clear();
}

/**
 * Foydalanuvchining panel roli (yo'q bo'lsa null). Developer — env dan, qolganlari bazadan (10 s kesh).
 * `fresh` — keshsiz (boshqa serverless instansiyada olib tashlangan rol darhol kuchini yo'qotishi uchun: panel
 * tugmalari, Mini App admin amallari).
 * `freshIfRole` — keshdagi "rol yo'q" javobi ishlatiladi, keshdagi rol esa bazadan qayta tekshiriladi: panel
 * foydalanuvchilari (bir nechta kishi) uchun bitta PK so'rovi, oddiy xodimlar uchun esa kesh saqlanadi.
 */
export async function getPanelRole(
  tgUserId: number | null | undefined,
  opts: { fresh?: boolean; freshIfRole?: boolean } = {},
): Promise<PanelRole | null> {
  if (!tgUserId || !Number.isSafeInteger(tgUserId)) return null;
  if (isDeveloper(tgUserId)) return 'developer';
  const hit = opts.fresh ? undefined : cache.get(tgUserId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS && !(opts.freshIfRole && hit.role)) return hit.role;
  const rows = await db()<{ role: AssignableRole }[]>`select role from panel_roles where tg_user_id = ${tgUserId}`;
  const role = rows[0]?.role ?? null;
  cache.set(tgUserId, { role, at: Date.now() });
  return role;
}

export interface PanelUser {
  tg_user_id: number;
  role: PanelRole;
  name: string;
  added_by: number | null;
  created_at: Date | null;
  /** true — ADMIN_IDS env dan (botdan o'chirib bo'lmaydi) */
  from_env: boolean;
}

/** Barcha panel foydalanuvchilari: avval developerlar (env), keyin ROP lar, keyin adminlar. */
export async function listPanelUsers(): Promise<PanelUser[]> {
  const rows = await db()<{ tg_user_id: number; role: AssignableRole; name: string; added_by: number | null; created_at: Date }[]>`
    select tg_user_id, role, name, added_by, created_at from panel_roles
    order by case role when 'rop' then 0 else 1 end, created_at, tg_user_id`;
  const devs: PanelUser[] = config.adminIds.map((id) => ({
    tg_user_id: id,
    role: 'developer',
    name: '',
    added_by: null,
    created_at: null,
    from_env: true,
  }));
  const devSet = new Set(config.adminIds);
  return [
    ...devs,
    ...rows.filter((r) => !devSet.has(r.tg_user_id)).map((r) => ({ ...r, from_env: false })),
  ];
}

export type SetRoleResult = { ok: true; created: boolean } | { ok: false; reason: 'invalid_id' | 'developer' };

/** Admin yoki ROP tayinlash (mavjud bo'lsa rol/ism yangilanadi). */
export async function setPanelRole(
  tgUserId: number,
  role: AssignableRole,
  name: string,
  addedBy: number | null,
): Promise<SetRoleResult> {
  if (!Number.isSafeInteger(tgUserId) || tgUserId <= 0) return { ok: false, reason: 'invalid_id' };
  if (isDeveloper(tgUserId)) return { ok: false, reason: 'developer' };
  const rows = await db()<{ inserted: boolean }[]>`
    insert into panel_roles (tg_user_id, role, name, added_by)
    values (${tgUserId}, ${role}, ${name.trim().slice(0, 64)}, ${addedBy})
    on conflict (tg_user_id) do update set role = excluded.role,
      name = case when excluded.name <> '' then excluded.name else panel_roles.name end
    returning (xmax = 0) as inserted`;
  cache.delete(tgUserId);
  return { ok: true, created: rows[0]?.inserted ?? false };
}

/** Admin/ROP rolini olib tashlash. Developerni (env) olib tashlab bo'lmaydi. */
export async function removePanelRole(tgUserId: number): Promise<boolean> {
  if (isDeveloper(tgUserId)) return false;
  const rows = await db()`delete from panel_roles where tg_user_id = ${tgUserId} returning tg_user_id`;
  cache.delete(tgUserId);
  return rows.length > 0;
}

/** Berilgan huquqqa ega barcha panel foydalanuvchilarining Telegram ID lari (bildirishnomalar uchun). */
export async function panelRecipients(perm: PanelPerm = 'panel'): Promise<number[]> {
  const users = await listPanelUsers();
  const ids = users.filter((u) => can(u.role, perm)).map((u) => u.tg_user_id);
  return [...new Set(ids)];
}

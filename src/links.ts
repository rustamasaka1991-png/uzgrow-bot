// Ilova manzili va bot havolalari.
import { config } from './config.js';
import { getSetting, setSetting } from './repo.js';
import { SETTING_KEYS } from './texts.js';
import { clientApi, staffApi } from './tg.js';

function hostOf(url: string | undefined): string {
  return (url ?? '').trim().replace(/^https?:\/\//i, '').replace(/[/?#].*$/, '').toLowerCase();
}

/**
 * Saqlangan manzil Vercel yaratgan vaqtinchalik (deployment/branch) domenmi — ular himoyalangan va keyingi
 * deploylarda eskiradi, Mini App tugmalari ularga olib bormasligi kerak.
 */
function isGeneratedDeploymentHost(url: string): boolean {
  const host = hostOf(url);
  if (!host) return false;
  return [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL].some((h) => !!h && hostOf(h) === host);
}

/** Ilova manzili: APP_URL env -> bazadagi sozlama (setup vaqtida saqlanadi) -> Vercel production domen. */
export async function getAppUrl(): Promise<string> {
  const fromEnv = (process.env.APP_URL ?? '').trim();
  if (fromEnv) return config.appUrlEnv;
  const saved = (await getSetting(SETTING_KEYS.appUrl))?.replace(/\/+$/, '');
  if (saved && !(isGeneratedDeploymentHost(saved) && config.appUrlEnv)) return saved;
  return config.appUrlEnv;
}

/** Mini App manzili (bo'sh bo'lsa — Mini App tugmalari ko'rsatilmaydi). */
export async function getWebAppUrl(): Promise<string> {
  const base = await getAppUrl();
  return base.startsWith('https://') ? `${base}/app/` : '';
}

const usernameCache: Partial<Record<'client' | 'staff', string>> = {};

export async function botUsername(bot: 'client' | 'staff'): Promise<string> {
  if (usernameCache[bot]) return usernameCache[bot]!;
  const key = bot === 'client' ? 'client_bot_username' : 'staff_bot_username';
  const saved = await getSetting(key);
  if (saved) return (usernameCache[bot] = saved);
  const api = bot === 'client' ? clientApi() : staffApi();
  if (!api) return '';
  const me = await api.getMe();
  const name = me.username ?? '';
  if (name) await setSetting(key, name);
  return (usernameCache[bot] = name);
}

/** Xodim taklif havolasi: https://t.me/<staff_bot>?start=inv_<code> */
export async function inviteLink(code: string): Promise<string> {
  const name = await botUsername('staff');
  return name ? `https://t.me/${name}?start=inv_${code}` : `inv_${code}`;
}

/** Mijoz boti orqali ma'lum xodimga to'g'ridan-to'g'ri havola: https://t.me/<client_bot>?start=staff_<id> */
export async function staffDeepLink(staffId: number): Promise<string> {
  const name = await botUsername('client');
  return name ? `https://t.me/${name}?start=staff_${staffId}` : '';
}

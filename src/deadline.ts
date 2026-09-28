// So'rov (Vercel funksiyasi chaqiruvi) uchun vaqt byudjeti.
// Vercel funksiyani maxDuration (60 s) da to'xtatadi — shundan oldin Telegram chaqiruvlari tugashi (yoki xato
// bilan qaytishi) kerak, aks holda foydalanuvchiga xato haqida xabar ham yuborilmay qoladi.
// AsyncLocalStorage ishlatiladi: bitta Vercel instansiyasi bir vaqtda bir nechta so'rovga xizmat qilishi mumkin.
import { AsyncLocalStorage } from 'node:async_hooks';

/** Webhook / Mini App so'rovi uchun standart byudjet (maxDuration 60 s dan ~10 s zaxira bilan). */
export const REQUEST_BUDGET_MS = 50_000;

/** Xato javobini yuborish uchun oxirida qoldiriladigan zaxira. */
const ERROR_REPLY_RESERVE_MS = 8_000;

const store = new AsyncLocalStorage<{ deadline: number }>();

/** `fn` ni berilgan vaqt byudjeti bilan ishga tushirish (ichma-ich chaqirilsa — qisqarog'i amal qiladi). */
export function runWithDeadline<T>(budgetMs: number, fn: () => Promise<T>): Promise<T> {
  const outer = store.getStore()?.deadline ?? Number.POSITIVE_INFINITY;
  const deadline = Math.min(outer, Date.now() + Math.max(0, budgetMs));
  return store.run({ deadline }, fn);
}

/** Joriy so'rov tugashigacha qolgan vaqt (ms). So'rov konteksti bo'lmasa (CLI, testlar) — Infinity. */
export function remainingMs(): number {
  const d = store.getStore()?.deadline;
  return d === undefined ? Number.POSITIVE_INFINITY : d - Date.now();
}

/**
 * Bitta tarmoq chaqiruvi uchun vaqt: `capMs` dan oshmaydi va so'rov oxirida xato javobi uchun zaxira qoldiradi.
 * Zaxira ichida (masalan, xato xabarini yuborishda) ham qisqa (≤ 4 s) imkoniyat beriladi.
 */
export function callBudgetMs(capMs: number): number {
  const left = remainingMs();
  if (!Number.isFinite(left)) return capMs;
  const budget = Math.max(left - ERROR_REPLY_RESERVE_MS, Math.min(left - 1_000, 4_000));
  return Math.max(1_000, Math.min(capMs, budget));
}

/**
 * `delayMs` kutib, yana bir tarmoq chaqiruvini qilishga vaqt yetadimi: kutishdan keyin ham xato javobi zaxirasidan
 * tashqari kamida `minCallMs` qolishi kerak. So'rov konteksti bo'lmasa (CLI, testlar) — doim true.
 */
export function canRetryAfter(delayMs: number, minCallMs = 5_000): boolean {
  return remainingMs() - delayMs - ERROR_REPLY_RESERVE_MS >= minCallMs;
}

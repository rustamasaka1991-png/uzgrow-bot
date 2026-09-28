// Suhbat tarixini (transcript) xodimlar botida HTML matn ko'rinishida chiqarish.
import type { Message } from '../../types.js';
import { KIND_LABELS, esc, formatTime, truncate } from '../../util.js';
import { TEXT_LIMIT } from './ui.js';

/** Bitta xabar matnining maksimal uzunligi (uzun xabarlar tarixni to'ldirib yubormasligi uchun). */
const BODY_MAX = 1200;
/** Telegram limitidan biroz kichik zaxira. */
const SAFE_LIMIT = TEXT_LIMIT - 96;

function mapsLink(lat: number, lon: number): string {
  return `https://maps.google.com/?q=${lat},${lon}`;
}

/** Xabar mazmuni (HTML, xavfsiz). */
export function messageBodyHtml(m: Message): string {
  const text = m.text ? esc(truncate(m.text, BODY_MAX)) : '';
  const meta = m.meta ?? {};
  switch (m.kind) {
    case 'text':
      return text || "<i>(bo'sh xabar)</i>";
    case 'location': {
      const lat = Number(meta.latitude);
      const lon = Number(meta.longitude);
      const label = Number.isFinite(lat) && Number.isFinite(lon)
        ? `<a href="${mapsLink(lat, lon)}">📍 Joylashuv</a>`
        : '📍 Joylashuv';
      return text ? `${label}\n${text}` : label;
    }
    case 'contact': {
      const parts = [meta.contact_name, meta.phone_number].filter(Boolean).map((p) => esc(String(p)));
      return `👤 <i>Kontakt</i>${parts.length ? ': ' + parts.join(', ') : ''}`;
    }
    case 'sticker':
      return `<i>${KIND_LABELS.sticker}</i>${meta.emoji ? ' ' + esc(meta.emoji) : ''}`;
    case 'document':
    case 'audio': {
      const name = m.file_name ? ': ' + esc(truncate(m.file_name, 80)) : '';
      const head = `<i>${KIND_LABELS[m.kind]}</i>${name}`;
      return text ? `${head}\n${text}` : head;
    }
    default: {
      const head = `<i>${KIND_LABELS[m.kind] || '📎 Fayl'}</i>`;
      return text ? `${head}\n${text}` : head;
    }
  }
}

export interface TranscriptLabels {
  /** Mijoz xabarlari uchun (masalan "👤 <b>Ali</b>") — HTML */
  client: string;
  /** Xodim xabarlari uchun — HTML */
  staff: string;
  /** Bot (avto-javob) xabarlari uchun — HTML */
  bot: string;
}

export interface Transcript {
  text: string;
  /** Ko'rsatilgan eng eski xabar id si (keyingi "oldingi" sahifa uchun) */
  oldestId: number | null;
  /** Bundan oldingi xabarlar bormi */
  hasMore: boolean;
}

/**
 * Xabarlar (id bo'yicha o'sish tartibida) -> bitta matn.
 * 4096 belgidan oshsa, eng eski xabarlar tushirib qoldiriladi (ular "oldingi" sahifada ko'rinadi).
 */
export function buildTranscript(
  messages: Message[],
  labels: TranscriptLabels,
  opts: { header: string; footer?: string; hasMore: boolean; empty?: string },
): Transcript {
  const entries = messages.map((m) => {
    const who = m.sender === 'client' ? labels.client : m.sender === 'staff' ? labels.staff : labels.bot;
    const via = m.via === 'webapp' ? ' · 📱' : '';
    return { id: m.id, html: `${who} · ${formatTime(m.created_at)}${via}\n${messageBodyHtml(m)}` };
  });

  const footer = opts.footer ? `\n\n${opts.footer}` : '';
  const assemble = (list: typeof entries, more: boolean): string => {
    const body = list.length ? list.map((e) => e.html).join('\n\n') : opts.empty ?? "<i>Hozircha xabarlar yo'q.</i>";
    const moreLine = more ? '<i>⋯ oldingi xabarlar «⬆️ Oldingi» tugmasida</i>\n\n' : '';
    return `${opts.header}\n\n${moreLine}${body}${footer}`;
  };

  let hasMore = opts.hasMore;
  let list = entries;
  let text = assemble(list, hasMore);
  while (text.length > SAFE_LIMIT && list.length > 1) {
    list = list.slice(1);
    hasMore = true;
    text = assemble(list, hasMore);
  }
  if (text.length > TEXT_LIMIT) {
    // Juda kam uchraydi (bitta xabar ham sig'madi) — xavfsiz qisqartirilgan ko'rinish
    text = `${opts.header}\n\n<i>Xabar juda uzun — to'liq ko'rinishi uchun Mini App ni oching.</i>${footer}`;
  }
  return { text, oldestId: list[0]?.id ?? null, hasMore };
}

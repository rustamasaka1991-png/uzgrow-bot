/* Uzgrow Mini App — xodimlar va panel rollari (developer / ROP / admin) uchun interfeys (mijozlar uchun o'chirilgan: ular bot chatida yozadi;
 * mijozlar boti orqali ochilsa server 403 client_app_disabled qaytaradi va "Chatga qaytish" ekrani ko'rsatiladi).
 * Vanilla JS, build bosqichisiz. Tashqi skript faqat: https://telegram.org/js/telegram-web-app.js
 * API shartnomasi: POST /api/app  { initData, action, ...params }  →  { ok: true, ... } | { ok: false, error, message }
 */
(function () {
  'use strict';

  // ═══════════════════════════ Muhit va konstantalar ═══════════════════════════

  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  const API_URL = '/api/app';
  const MAX_UPLOAD = 4 * 1024 * 1024;
  const TEXT_MAX = 4096;
  const CAPTION_MAX = 1024;
  const CHAT_POLL = 3000;
  const LIST_POLL = 8000;
  const MAX_BACKOFF = 60000;

  const MSG = {
    generic: "Xatolik yuz berdi. Iltimos, qayta urinib ko'ring.",
    network: "Internet aloqasi yo'q yoki server javob bermayapti.",
    timeout: "So'rov juda uzoq davom etdi. Qayta urinib ko'ring.",
    session: 'Sessiya eskirgan — Mini App ni yopib, qayta oching.',
    tooBig: "Fayl hajmi 4 MB dan oshmasligi kerak. Kattaroq fayllarni bot chatiga to'g'ridan-to'g'ri yuboring.",
    openInTelegram: 'Iltimos, ushbu sahifani Telegram bot ichidan oching.',
    staffUnavailable: "Bu xodim hozir mavjud emas. Iltimos, boshqa operator yoki menejerni tanlang.",
    notStaff: "Bu bo'lim faqat xodimlar uchun. Admin bergan taklif havolasi orqali xodimlar botiga kiring.",
    undelivered: 'Saqlandi, lekin mijozga yetkazilmadi',
    staffInactive: "Profilingiz bloklangan — mijozlarga xabar yubora olmaysiz. Admin bilan bog'laning.",
    clientAppDisabled: 'Bu ilova faqat xodimlar uchun. Iltimos, bot chatiga qayting va shu yerda yozing.',
  };

  // Panel rollari (xodimlar botidagi boshqaruv paneli; server: src/roles.ts ROLE_TITLES bilan bir xil)
  const PANEL_ROLE_TITLES = { developer: '🛠 Developer', rop: '👑 ROP (rahbar)', admin: '⚙️ Admin' };
  const PANEL_ROLE_HINTS = {
    developer: 'Barcha huquqlar',
    rop: "To'liq admin paneli, shikoyatlar va ommaviy xabar",
    admin: 'Xodimlar, bot matnlari va statistika',
  };
  const COMPLAINTS_HINT = {
    developer: 'Shikoyatlar roʻyxati, suhbatni oʻqish va «Hal qilindi» — shu ilovadagi «⚠️ Shikoyatlar» boʻlimida.',
    rop: 'Shikoyatlar roʻyxati, suhbatni oʻqish va «Hal qilindi» — shu ilovadagi «⚠️ Shikoyatlar» boʻlimida.',
  };

  /** Serverdagi panel_role -> 'developer' | 'rop' | 'admin' (is_admin bor-u rol kelmagan eski server — 'admin'). */
  function normPanelRole(v) {
    return v === 'developer' || v === 'rop' || v === 'admin' ? v : 'admin';
  }

  function panelRoleTitle(role, serverTitle) {
    if (typeof serverTitle === 'string' && serverTitle.trim() && serverTitle.length <= 64) return serverTitle.trim();
    return PANEL_ROLE_TITLES[role] || PANEL_ROLE_TITLES.admin;
  }

  function readDevInitData() {
    try {
      const hash = (window.location.hash || '').replace(/^#/, '');
      if (!hash) return '';
      return new URLSearchParams(hash).get('dev_init_data') || '';
    } catch (e) {
      return '';
    }
  }

  const inTelegram = !!(tg && tg.initData);
  const initData = (tg && tg.initData) || readDevInitData();

  const USER = (function () {
    try {
      const u = JSON.parse(new URLSearchParams(initData).get('user') || 'null');
      return u && typeof u === 'object' ? u : {};
    } catch (e) {
      return {};
    }
  })();

  const platform = tg && tg.platform ? String(tg.platform) : 'unknown';
  const DESKTOP =
    /^(tdesktop|macos|web|weba|webk|unigram)$/i.test(platform) ||
    (!/^(ios|android|android_x)$/i.test(platform) &&
      !!window.matchMedia &&
      window.matchMedia('(hover: hover) and (pointer: fine)').matches);

  // ═══════════════════════════ Telegram WebApp yordamchilari ═══════════════════════════

  function tgAtLeast(v) {
    try {
      return !!tg && typeof tg.isVersionAtLeast === 'function' && tg.isVersionAtLeast(v);
    } catch (e) {
      return false;
    }
  }

  function tgTry(fn) {
    try {
      fn();
      return true;
    } catch (e) {
      return false;
    }
  }

  const haptic = {
    impact(style) {
      if (tgAtLeast('6.1')) tgTry(() => tg.HapticFeedback.impactOccurred(style || 'light'));
    },
    notify(type) {
      if (tgAtLeast('6.1')) tgTry(() => tg.HapticFeedback.notificationOccurred(type || 'success'));
    },
    select() {
      if (tgAtLeast('6.1')) tgTry(() => tg.HapticFeedback.selectionChanged());
    },
  };

  function clip(s, n) {
    const arr = Array.from(String(s == null ? '' : s));
    return arr.length > n ? arr.slice(0, n - 1).join('') + '…' : arr.join('');
  }

  /** Tasdiqlash oynasi → Promise<boolean>. */
  function confirmDialog(message, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      if (tgAtLeast('6.2')) {
        const params = {
          message: clip(message, 256),
          buttons: [
            { id: 'ok', type: opts.destructive ? 'destructive' : 'default', text: clip(opts.ok || 'Ha', 64) },
            { id: 'cancel', type: 'cancel' },
          ],
        };
        if (opts.title) params.title = clip(opts.title, 64);
        if (tgTry(() => tg.showPopup(params, (id) => resolve(id === 'ok')))) return;
        resolve(false);
        return;
      }
      try {
        resolve(window.confirm(message));
      } catch (e) {
        resolve(false);
      }
    });
  }

  /** Bir nechta tanlovli oyna → Promise<id|null>. buttons: [{id, text, destructive}] (ko'pi bilan 2 ta + bekor qilish). */
  function choiceDialog(message, buttons, title) {
    return new Promise((resolve) => {
      if (tgAtLeast('6.2')) {
        const params = {
          message: clip(message, 256),
          buttons: buttons
            .slice(0, 2)
            .map((b) => ({ id: b.id, type: b.destructive ? 'destructive' : 'default', text: clip(b.text, 64) }))
            .concat([{ id: 'cancel', type: 'cancel' }]),
        };
        if (title) params.title = clip(title, 64);
        if (tgTry(() => tg.showPopup(params, (id) => resolve(id && id !== 'cancel' ? id : null)))) return;
        resolve(null);
        return;
      }
      try {
        resolve(window.confirm(message + '\n\n' + buttons[0].text + '?') ? buttons[0].id : null);
      } catch (e) {
        resolve(null);
      }
    });
  }

  function isSafeHttpUrl(u) {
    try {
      const x = new URL(u);
      return x.protocol === 'http:' || x.protocol === 'https:';
    } catch (e) {
      return false;
    }
  }

  function openLink(url) {
    if (!isSafeHttpUrl(url)) return;
    if (/^https:\/\/t\.me\//i.test(url) && tgAtLeast('6.1') && tgTry(() => tg.openTelegramLink(url))) return;
    if (tg && inTelegram && typeof tg.openLink === 'function' && tgTry(() => tg.openLink(url))) return;
    try {
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      /* e'tiborsiz */
    }
  }

  function setBackButton(visible) {
    if (!tgAtLeast('6.1')) return;
    tgTry(() => (visible ? tg.BackButton.show() : tg.BackButton.hide()));
  }

  function closeApp() {
    if (tg && tgTry(() => tg.close())) return;
    try {
      window.close();
    } catch (e) {
      /* e'tiborsiz */
    }
  }

  function applyTheme() {
    let scheme = 'light';
    if (inTelegram && tg.colorScheme) scheme = tg.colorScheme === 'dark' ? 'dark' : 'light';
    else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) scheme = 'dark';
    const root = document.documentElement;
    root.setAttribute('data-scheme', scheme);
    root.style.colorScheme = scheme;
    if (inTelegram && tgAtLeast('6.1')) {
      tgTry(() => tg.setHeaderColor('bg_color'));
      tgTry(() => tg.setBackgroundColor('secondary_bg_color'));
    }
    if (inTelegram && tgAtLeast('7.10')) tgTry(() => tg.setBottomBarColor('bg_color'));
  }

  // ═══════════════════════════ Kichik yordamchilar ═══════════════════════════

  function str(v) {
    return v == null ? '' : String(v);
  }

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  function arr(v) {
    return Array.isArray(v) ? v : [];
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function toDate(v) {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function hhmm(d) {
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function dayKey(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function dayDiff(d) {
    const a = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const now = new Date();
    const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((b.getTime() - a.getTime()) / 86400000);
  }

  function dayLabel(d) {
    const diff = dayDiff(d);
    if (diff === 0) return 'Bugun';
    if (diff === 1) return 'Kecha';
    return pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.' + d.getFullYear();
  }

  const WEEKDAYS = ['Yak', 'Dush', 'Sesh', 'Chor', 'Pay', 'Jum', 'Shan'];

  function listTime(v) {
    const d = toDate(v);
    if (!d) return '';
    const diff = dayDiff(d);
    if (diff <= 0) return hhmm(d);
    if (diff === 1) return 'Kecha';
    if (diff < 7) return WEEKDAYS[d.getDay()];
    return pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.' + String(d.getFullYear()).slice(-2);
  }

  function fullDate(v) {
    const d = toDate(v);
    if (!d) return '';
    return pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + hhmm(d);
  }

  function fmtSize(n) {
    n = num(n);
    if (n <= 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function fmtDuration(sec) {
    sec = Math.max(0, Math.round(num(sec)));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (m >= 60) return Math.floor(m / 60) + ':' + pad2(m % 60) + ':' + pad2(s);
    return m + ':' + pad2(s);
  }

  function fmtCount(n) {
    return n > 99 ? '99+' : String(n);
  }

  function fmtNum(n) {
    return String(Math.round(num(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }

  function roleLabel(role) {
    return role === 'manager' ? 'Menejer' : 'Operator';
  }

  function roleEmoji(role) {
    return role === 'manager' ? '👔' : '👨‍💻';
  }

  function firstWord(s) {
    return str(s).trim().split(/\s+/)[0] || '';
  }

  const NAME_LETTER_RE = /[A-Za-zÀ-ɏЀ-ӿ]/;
  const APOSTROPHES = "'ʻʼ’‘`";

  /**
   * Ismga jo'nalish kelishigi qo'shimchasi (imlo qoidalari bo'yicha): k → -ka, q → -qa, qolganlari → -ga
   * (Otabek → Otabekka, Ortiq → Ortiqqa, Malika → Malikaga, Ulug' → Ulug'ga). Kirill yozuvidagi ismlarga
   * kirillcha qo'shimcha qo'yiladi (Отабек → Отабекка). So'z harf bilan tugamasa (emoji, raqam) — ''
   * qaytaradi, chaqiruvchi qo'shimchasiz ibora ishlatadi.
   */
  function dative(word) {
    const w = str(word).trim();
    if (!w) return '';
    const upper = w === w.toUpperCase() && w !== w.toLowerCase();
    const sfx = (s) => (upper ? s.toUpperCase() : s);
    const last = w.charAt(w.length - 1);
    const prev = w.length > 1 ? w.charAt(w.length - 2) : '';
    // g' (tutuq belgisining istalgan shakli bilan) — -ga: bog'ga, Ulug'ga
    if (APOSTROPHES.indexOf(last) >= 0 && (prev === 'g' || prev === 'G')) return w + sfx('ga');
    if (!NAME_LETTER_RE.test(last)) return '';
    const lc = last.toLowerCase();
    if (/[Ѐ-ӿ]/.test(last)) {
      if (lc === 'к') return w + sfx('ка');
      if (lc === 'қ') return w + sfx('қа');
      return w + sfx('га');
    }
    if (lc === 'k') return w + sfx('ka');
    if (lc === 'q') return w + sfx('qa');
    return w + sfx('ga');
  }

  function initialsOf(name) {
    const words = str(name).trim().split(/\s+/).filter(Boolean);
    let out = '';
    for (let i = 0; i < words.length && Array.from(out).length < 2; i++) {
      const ch = Array.from(words[i])[0];
      if (ch && /[0-9A-Za-zÀ-ɏЀ-ӿ]/.test(ch)) out += ch;
    }
    if (!out) {
      const first = Array.from(str(name).trim())[0];
      out = first || '?';
    }
    return out.toUpperCase();
  }

  function seedNum(seed) {
    if (typeof seed === 'number' && Number.isFinite(seed)) return Math.abs(Math.floor(seed));
    const s = str(seed);
    let x = 7;
    for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(x);
  }

  /** Faqat o'z serverimiz, https, blob va data:image manzillari. */
  function safeSrc(u) {
    const s = str(u).trim();
    if (!s) return '';
    if (s.charAt(0) === '/' && s.charAt(1) !== '/') return s;
    if (/^https:\/\//i.test(s) || /^blob:/i.test(s) || /^data:image\//i.test(s)) return s;
    try {
      if (/^http:\/\//i.test(s) && new URL(s).origin === window.location.origin) return s;
    } catch (e) {
      /* noto'g'ri manzil */
    }
    return '';
  }

  function debounce(fn, ms) {
    let t = 0;
    const wrapped = function () {
      const args = arguments;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(null, args), ms);
    };
    wrapped.flush = function () {
      clearTimeout(t);
      fn();
    };
    wrapped.cancel = function () {
      clearTimeout(t);
    };
    return wrapped;
  }

  // Brauzer xotirasi (faqat qulayliklar uchun: tab, qoralama). Har doim try/catch.
  const storage = {
    key(k) {
      return 'uzg:' + (S.role || 'x') + ':' + (USER.id || 0) + ':' + k;
    },
    get(k, d) {
      try {
        const v = window.localStorage.getItem(this.key(k));
        return v == null ? d : JSON.parse(v);
      } catch (e) {
        return d;
      }
    },
    set(k, v) {
      try {
        window.localStorage.setItem(this.key(k), JSON.stringify(v));
      } catch (e) {
        /* e'tiborsiz */
      }
    },
    del(k) {
      try {
        window.localStorage.removeItem(this.key(k));
      } catch (e) {
        /* e'tiborsiz */
      }
    },
  };

  // ═══════════════════════════ DOM yordamchilari ═══════════════════════════

  function h(tag, props, children) {
    const el = document.createElement(tag);
    if (props) {
      const keys = Object.keys(props);
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const v = props[key];
        if (v === undefined || v === null || v === false) continue;
        if (key === 'class') el.className = v;
        else if (key === 'text') el.textContent = String(v);
        else if (key === 'html') el.innerHTML = v; // faqat ichki statik SVG satrlar uchun
        else if (key === 'style') {
          if (typeof v === 'string') el.setAttribute('style', v);
          else Object.assign(el.style, v);
        } else if (key === 'value') el.value = v;
        else if (key === 'checked') el.checked = !!v;
        else if (key === 'disabled') el.disabled = !!v;
        else if (key.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(key.slice(2).toLowerCase(), v);
        else if (key === 'dataset') Object.assign(el.dataset, v);
        else el.setAttribute(key, v === true ? '' : String(v));
      }
    }
    if (children !== undefined && children !== null) append(el, children);
    return el;
  }

  function append(parent, children) {
    const list = Array.isArray(children) ? children : [children];
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (c === undefined || c === null || c === false) continue;
      if (Array.isArray(c)) append(parent, c);
      else if (c instanceof Node) parent.appendChild(c);
      else parent.appendChild(document.createTextNode(String(c)));
    }
    return parent;
  }

  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
    return el;
  }

  /** Elementni faqat vertikal aylantirib ko'rsatish (scrollIntoView overflow:hidden ota-onalarni ham suradi). */
  function revealV(el, smooth) {
    let sc = el ? el.parentElement : null;
    while (sc && sc !== document.body) {
      const oy = getComputedStyle(sc).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && sc.scrollHeight > sc.clientHeight) break;
      sc = sc.parentElement;
    }
    if (!sc || sc === document.body) return;
    const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - sc.clientHeight / 3;
    try {
      sc.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
    } catch (e) {
      sc.scrollTop = Math.max(0, top);
    }
  }

  const ICONS = {
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
    send: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M3.4 10.5 19.9 3.3c.9-.4 1.8.5 1.4 1.4l-7.2 16.5c-.4.9-1.7.8-1.9-.1l-1.5-6.1a1 1 0 0 0-.7-.7l-6.1-1.5c-.9-.2-1-1.5-.1-1.9z"/></svg>',
    attach: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 11.3l-8.2 8.2a5.3 5.3 0 0 1-7.5-7.5l8.6-8.6a3.5 3.5 0 0 1 5 5l-8.6 8.6a1.8 1.8 0 0 1-2.5-2.5l7.9-7.9"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5l4.5 4.5L19.5 6.5"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5.5 12.5 12 19l6.5-6.5"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15"/></svg>',
    share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13v6a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-6M12 3v12M7 8l5-5 5 5"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>',
    chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>',
    camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8.5h3l2-3h6l2 3h3V19H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
  };

  function icon(name, cls) {
    const s = h('span', { class: 'ico' + (cls ? ' ' + cls : ''), 'aria-hidden': 'true' });
    s.innerHTML = ICONS[name] || '';
    return s;
  }

  function spinner(cls) {
    return h('span', { class: 'spinner' + (cls ? ' ' + cls : ''), role: 'progressbar', 'aria-label': 'Yuklanmoqda' });
  }

  function makeImg(src, opts) {
    opts = opts || {};
    const img = document.createElement('img');
    if (opts.cls) img.className = opts.cls;
    img.alt = opts.alt || '';
    img.decoding = 'async';
    img.draggable = false;
    if (opts.lazy) img.loading = 'lazy';
    img.addEventListener('load', () => {
      img.classList.add('loaded');
      if (opts.onload) opts.onload(img);
    });
    img.addEventListener('error', () => {
      if (opts.onerror) opts.onerror(img);
    });
    img.src = src;
    return img;
  }

  const AVA_GRADIENTS = [
    ['#ff885e', '#ff516a'],
    ['#ffcd6a', '#ffa85c'],
    ['#82b1ff', '#665fff'],
    ['#a0de7e', '#54cb68'],
    ['#53edd6', '#28c9b7'],
    ['#72d5fd', '#2a9ef1'],
    ['#e0a2f3', '#d669ed'],
  ];

  function avatar(o) {
    const size = o.size || 48;
    const g = AVA_GRADIENTS[seedNum(o.seed == null ? o.name : o.seed) % AVA_GRADIENTS.length];
    const el = h('div', {
      class: 'ava',
      'aria-hidden': 'true',
      style:
        'width:' + size + 'px;height:' + size + 'px;font-size:' + Math.round(size * 0.38) + 'px;' +
        'background-image:linear-gradient(160deg,' + g[0] + ',' + g[1] + ')',
    });
    el.appendChild(h('span', { class: 'ava-txt', text: o.initials || initialsOf(o.name) }));
    const src = safeSrc(o.url);
    if (src) el.appendChild(makeImg(src, { cls: 'ava-img', lazy: !!o.lazy, onerror: (img) => img.remove() }));
    if (o.online === true) el.appendChild(h('span', { class: 'ava-dot' }));
    return el;
  }

  function emptyState(emoji, title, text, actions) {
    return h('div', { class: 'empty' }, [
      h('div', { class: 'empty-emoji', 'aria-hidden': 'true', text: emoji }),
      h('p', { class: 'empty-title', text: title }),
      text ? h('p', { class: 'empty-text', text: text }) : null,
      actions && actions.length ? h('div', { class: 'empty-actions' }, actions) : null,
    ]);
  }

  // Havolalarni xavfsiz ajratish (faqat http/https), qolgan hammasi textContent.
  const URL_RE = /https?:\/\/[^\s<>"'`«»]+/gi;

  function countChar(s, ch) {
    let n = 0;
    for (let i = 0; i < s.length; i++) if (s.charAt(i) === ch) n++;
    return n;
  }

  function linkify(text) {
    const frag = document.createDocumentFragment();
    const s = str(text);
    let last = 0;
    let m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(s))) {
      let url = m[0];
      for (;;) {
        const ch = url.charAt(url.length - 1);
        if (/[.,!?:;'"]/.test(ch)) {
          url = url.slice(0, -1);
          continue;
        }
        const pairs = { ')': '(', ']': '[', '}': '{' };
        if (pairs[ch] && countChar(url, pairs[ch]) < countChar(url, ch)) {
          url = url.slice(0, -1);
          continue;
        }
        break;
      }
      const start = m.index;
      if (start > last) frag.appendChild(document.createTextNode(s.slice(last, start)));
      if (url.length > 8 && isSafeHttpUrl(url)) {
        const target = url;
        frag.appendChild(
          h('a', {
            href: target,
            target: '_blank',
            rel: 'noopener noreferrer',
            onclick: (e) => {
              e.preventDefault();
              e.stopPropagation();
              openLink(target);
            },
            text: target,
          }),
        );
      } else {
        frag.appendChild(document.createTextNode(url));
      }
      last = start + url.length;
    }
    if (last < s.length) frag.appendChild(document.createTextNode(s.slice(last)));
    return frag;
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) {
      /* zaxira usul */
    }
    try {
      const ta = h('textarea', {
        value: text,
        readonly: true,
        style: 'position:fixed;top:-1000px;left:0;opacity:0;font-size:16px',
      });
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  // ═══════════════════════════ Mijozlar uchun shaxsiy havola ═══════════════════════════
  // Har bir xodimning qisqa havolasi: https://t.me/<mijoz_boti>?start=<link_code> (masalan ...?start=aziza).
  // Mijoz shu havola orqali botga kirsa — hech narsa tanlamasdan shu xodim bilan chat boshlanadi.

  /** Server bilan bir xil qoida (src/repo.ts LINK_CODE_RE): 2–32 ta kichik lotin harfi, raqam yoki "_". */
  const LINK_CODE_RE = /^[a-z0-9_]{2,32}$/;
  const LINK_SHARE_TEXT = "Men bilan shu havola orqali bog'laning";
  const CLIENT_LINK_RE = /^https:\/\/t\.me\/([A-Za-z0-9_]{3,64})\?start=([A-Za-z0-9_]{1,64})$/;

  function normalizeLinkCode(v) {
    return str(v).trim().toLowerCase().replace(/^@/, '');
  }

  /** Havola nomidagi xato matni ('' — to'g'ri). */
  function linkCodeError(code) {
    if (!code) return 'Havola nomini kiriting.';
    if (/^staff_\d+$/.test(code)) return "Bu nom tizim uchun band — boshqa nom yozing.";
    if (!LINK_CODE_RE.test(code)) return "Havola nomi 2–32 ta lotin harfi, raqam yoki _ bo'lishi kerak (masalan: aziza).";
    return '';
  }

  const CYR_TO_LAT = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l',
    м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'x', ц: 's', ч: 'ch', ш: 'sh',
    щ: 'sh', ъ: '', ы: 'i', ь: '', э: 'e', ю: 'yu', я: 'ya', ў: 'o', қ: 'q', ғ: 'g', ҳ: 'h',
  };

  /** Ismdan taxminiy havola nomi (serverdagi avtomatik nom bilan bir xil qoida; band bo'lsa server raqam qo'shadi). */
  function linkCodeSuggestion(fullName) {
    const first = str(fullName).trim().split(/\s+/)[0] || '';
    let out = '';
    Array.from(first.toLowerCase()).forEach((ch) => {
      out += Object.prototype.hasOwnProperty.call(CYR_TO_LAT, ch) ? CYR_TO_LAT[ch] : ch;
    });
    try {
      out = out.normalize('NFKD');
    } catch (e) {
      /* eski brauzer */
    }
    out = out.replace(/[^a-z0-9]/g, '').slice(0, 24);
    return out.length >= 2 ? out : 'xodim';
  }

  /** Faqat t.me havolasi (serverdan kelgan qiymat ekranga/ulashishga shu tekshiruvdan keyin chiqadi). */
  function safeClientLink(v) {
    const link = str(v).trim();
    return CLIENT_LINK_RE.test(link) ? link : '';
  }

  /** Mijozlar boti username i: havoladan yoki bootstrap/admin ro'yxatidagi client_bot dan. */
  function clientBotName(link) {
    const m = CLIENT_LINK_RE.exec(str(link));
    if (m) return m[1];
    if (S.clientBot) return S.clientBot;
    // Zaxira: ro'yxatdagi istalgan xodim havolasidan yoki o'z profilidan
    const known = A.staff.map((x) => x.client_link).concat(S.me ? [S.me.client_link] : []);
    for (let i = 0; i < known.length; i++) {
      const k = CLIENT_LINK_RE.exec(str(known[i]));
      if (k) return k[1];
    }
    return '';
  }

  async function copyLink(link) {
    const ok = await copyText(link);
    if (ok) {
      toast('Havola nusxalandi 📋', 'success', 2000);
      haptic.notify('success');
    } else {
      toast("Nusxalab bo'lmadi — havolani bosib turib, qo'lda nusxalang.", 'error');
    }
  }

  /** Telegram "Ulashish" oynasi (t.me/share/url — Telegram ichida openTelegramLink orqali ochiladi). */
  function shareLink(link, text) {
    if (!/^https:\/\//.test(str(link))) return;
    openLink('https://t.me/share/url?url=' + encodeURIComponent(link) + '&text=' + encodeURIComponent(text || LINK_SHARE_TEXT));
  }

  /** Havola qutisi: to'liq havola (bosilsa nusxalanadi) + "📋 Nusxalash" va "📤 Ulashish" tugmalari. */
  function clientLinkBox(link, shareText) {
    return h('div', { class: 'invite-box client-link-box' }, [
      h('button', { class: 'invite-link', type: 'button', 'aria-label': 'Havolani nusxalash', onclick: () => copyLink(link), text: link }),
      h('div', { class: 'invite-actions' }, [
        h('button', { class: 'btn sm secondary', type: 'button', onclick: () => copyLink(link) }, '📋 Nusxalash'),
        h('button', { class: 'btn sm', type: 'button', onclick: () => shareLink(link, shareText) }, '📤 Ulashish'),
      ]),
    ]);
  }

  // ═══════════════════════════ Toastlar va holat oynalari ═══════════════════════════

  const toastsEl = document.getElementById('toasts');
  const toastTimers = new WeakMap();

  function dismissToast(el) {
    clearTimeout(toastTimers.get(el));
    el.classList.remove('show');
    el.classList.add('hide');
    setTimeout(() => el.remove(), 260);
  }

  function toast(message, type, ms) {
    if (!message || !toastsEl) return;
    type = type || 'info';
    const text = String(message);
    const dur = ms || (type === 'error' ? 4500 : 3000);
    const existing = Array.prototype.find.call(toastsEl.children, (t) => t.dataset.msg === text && !t.classList.contains('hide'));
    if (existing) {
      existing.classList.remove('bump');
      void existing.offsetWidth;
      existing.classList.add('bump');
      clearTimeout(toastTimers.get(existing));
      toastTimers.set(existing, setTimeout(() => dismissToast(existing), dur));
      return;
    }
    while (toastsEl.children.length >= 3) toastsEl.firstChild.remove();
    const hasEmoji = /^[←-⯿☀-➿\uD83C-\uDBFF]/.test(text);
    const emoji = type === 'error' ? '⚠️' : type === 'success' ? '✅' : type === 'warn' ? '⚠️' : 'ℹ️';
    const el = h('div', { class: 'toast ' + type, role: type === 'error' ? 'alert' : 'status' }, [
      hasEmoji ? null : h('span', { class: 'toast-ico', 'aria-hidden': 'true', text: emoji }),
      h('span', { class: 'toast-text', text: text }),
    ]);
    el.dataset.msg = text;
    el.addEventListener('click', () => dismissToast(el));
    toastsEl.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
    toastTimers.set(el, setTimeout(() => dismissToast(el), dur));
  }

  let netBannerEl = null;
  let netBannerText = null;
  /** status: 0 — tarmoq/vaqt tugadi (internet muammosi); boshqasi — server javob berdi, lekin xato bilan. */
  function netBanner(show, status) {
    const text = !status ? "Aloqa yo'q. Qayta ulanmoqda…" : 'Server vaqtincha javob bermayapti. Qayta urinilmoqda…';
    if (show && netBannerEl) {
      if (netBannerText) netBannerText.textContent = text;
    } else if (show) {
      netBannerText = h('span', { text: text });
      netBannerEl = h('div', { class: 'net-banner', role: 'status' }, [spinner('sm light'), netBannerText]);
      document.body.appendChild(netBannerEl);
      requestAnimationFrame(() => requestAnimationFrame(() => netBannerEl && netBannerEl.classList.add('show')));
    } else if (!show && netBannerEl) {
      netBannerText = null;
      const el = netBannerEl;
      netBannerEl = null;
      el.classList.remove('show');
      setTimeout(() => el.remove(), 350);
    }
  }

  function showFatal(o) {
    const old = document.querySelector('.fatal[data-js]');
    if (old) old.remove();
    const actions = (o.actions || []).map((a) =>
      h('button', { class: 'btn block' + (a.secondary ? ' secondary' : ''), type: 'button', onclick: a.fn }, a.label),
    );
    const el = h('div', { class: 'fatal', role: 'alertdialog', 'aria-modal': 'true', 'data-js': '1' }, [
      h('div', { class: 'fatal-emoji', 'aria-hidden': 'true', text: o.emoji || '😕' }),
      h('h1', { text: o.title }),
      o.text ? h('p', { text: o.text }) : null,
      actions.length ? h('div', { class: 'fatal-actions' }, actions) : null,
    ]);
    document.body.appendChild(el);
    return el;
  }

  function hideFatal() {
    const old = document.querySelector('.fatal[data-js]');
    if (old) old.remove();
  }

  // ═══════════════════════════ API ═══════════════════════════

  class ApiError extends Error {
    constructor(code, message, status, data) {
      super(message);
      this.code = code;
      this.status = status || 0;
      this.data = data || null;
    }
  }

  let sessionDead = false;
  // Xodim profili uzildi/o'chirildi (403 not_staff): barcha so'rovlar to'xtatiladi, maxfiy ma'lumotlar ekrandan olinadi
  let accessDead = false;
  // Mini App mijozlar boti orqali ochilgan (403 client_app_disabled): mijozlar uchun ilova o'chirilgan
  let clientDisabled = false;

  function sessionExpired() {
    if (sessionDead || accessDead || clientDisabled) return;
    sessionDead = true;
    poller.stop();
    netBanner(false);
    outboxFailAll();
    showFatal({
      emoji: '🔒',
      title: 'Sessiya eskirgan',
      text: MSG.session,
      actions: inTelegram ? [{ label: 'Yopish', fn: closeApp }] : [],
    });
  }

  /**
   * Kirish huquqi yo'q: xodim profili uzilgan yoki o'chirilgan (yoki umuman xodim emas).
   * So'rovlar to'xtatiladi, ochiq ekranlar yopiladi, suhbatlar va admin ma'lumotlari xotiradan tozalanadi.
   */
  function accessRevoked(text) {
    if (accessDead || sessionDead || clientDisabled) return;
    accessDead = true;
    poller.stop();
    netBanner(false);
    outboxClear();
    nav.teardown();
    S.convs = [];
    S.extraConvs.clear();
    S.listSig = null;
    S.total = 0;
    S.me = null;
    S.staff = [];
    S.isAdmin = false;
    S.panelRole = null;
    S.panelRoleTitle = '';
    A.staff = [];
    A.stats = null;
    A.loaded = false;
    mediaUrls.clear();
    showFatal({
      emoji: '⛔',
      title: 'Kirish mumkin emas',
      text: text || MSG.notStaff,
      actions: inTelegram ? [{ label: 'Yopish', fn: closeApp }] : [],
    });
  }

  /**
   * Mijozlar uchun Mini App o'chirilgan: mijoz bot chatida yozadi. Do'stona to'liq ekranli xabar va
   * "Chatga qaytish" tugmasi (Mini App ni yopadi). So'rovlar, qayta urinishlar va polling to'xtatiladi.
   */
  function clientAppDisabled(text) {
    if (clientDisabled) return;
    clientDisabled = true;
    poller.stop();
    netBanner(false);
    outboxClear();
    nav.teardown();
    S.convs = [];
    S.extraConvs.clear();
    S.listSig = null;
    S.me = null;
    S.staff = [];
    mediaUrls.clear();
    showFatal({
      emoji: '💬',
      title: 'Bot chatida yozing',
      text: text || MSG.clientAppDisabled,
      actions: [{ label: 'Chatga qaytish', fn: closeApp }],
    });
  }

  /** Sessiya tugagan yoki kirish taqiqlangan bo'lsa — darhol qaytariladigan xato. */
  function deadError() {
    if (clientDisabled) return new ApiError('client_app_disabled', MSG.clientAppDisabled, 403);
    if (sessionDead) return new ApiError('unauthorized', MSG.session, 401);
    if (accessDead) return new ApiError('not_staff', MSG.notStaff, 403);
    return null;
  }

  // Server va qurilma soatlari farqi (media tokenlari muddati server vaqti bilan yoziladi)
  let clockSkewMs = 0;

  function noteServerDate(v) {
    const t = Date.parse(str(v));
    if (Number.isFinite(t)) clockSkewMs = t - Date.now();
  }

  function serverNowSec() {
    return Math.floor((Date.now() + clockSkewMs) / 1000);
  }

  function errorFrom(status, data) {
    let code = data && typeof data.error === 'string' ? data.error : '';
    if (!code) code = status === 401 ? 'unauthorized' : status === 413 ? 'file_too_big' : status ? 'http_' + status : 'bad_response';
    let message = data && typeof data.message === 'string' && data.message.trim() ? data.message.trim() : '';
    if (!message) {
      if (status === 401) message = MSG.session;
      else if (status === 413 || code === 'file_too_big') message = MSG.tooBig;
      else if (status === 404) message = "Ma'lumot topilmadi.";
      else if (status === 403) message = "Bu amal uchun ruxsat yo'q.";
      else if (status === 429) message = "Juda ko'p so'rov. Birozdan keyin urinib ko'ring.";
      else message = MSG.generic;
    }
    return new ApiError(code, message, status, data);
  }

  function handleResponse(status, data) {
    if (status >= 200 && status < 300 && data && typeof data === 'object' && data.ok !== false) return data;
    const err = errorFrom(status, data);
    if (err.code === 'client_app_disabled') clientAppDisabled(err.message);
    else if (status === 401 || err.code === 'unauthorized') sessionExpired();
    // Faqat aniq 'not_staff' — butun sessiya uchun kirish yo'q. 'forbidden', 'staff_only', 'admin_only'
    // kabi kodlar alohida amal/suhbat uchun rad etish, ular chaqiruvchida ko'rsatiladi.
    else if (err.code === 'not_staff') accessRevoked();
    throw err;
  }

  async function api(action, params, opts) {
    opts = opts || {};
    const dead = deadError();
    if (dead) throw dead;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (ctrl) ctrl.abort();
    }, opts.timeout || 25000);
    try {
      let res;
      try {
        res = await fetch(API_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(Object.assign({}, params || {}, { initData: initData, action: action })),
          signal: ctrl ? ctrl.signal : undefined,
          cache: 'no-store',
          credentials: 'same-origin',
        });
      } catch (e) {
        throw new ApiError(timedOut ? 'timeout' : 'network', timedOut ? MSG.timeout : MSG.network, 0);
      }
      try {
        noteServerDate(res.headers.get('date'));
      } catch (e) {
        /* sarlavha yo'q */
      }
      let data = null;
      try {
        data = await res.json();
      } catch (e) {
        if (timedOut) throw new ApiError('timeout', MSG.timeout, 0);
        data = null;
      }
      return handleResponse(res.status, data);
    } finally {
      clearTimeout(timer);
    }
  }

  /** multipart/form-data yuklash (XHR — yuklash jarayonini ko'rsatish uchun). */
  function apiUpload(action, fields, blob, fileName, onProgress) {
    return new Promise((resolve, reject) => {
      const dead = deadError();
      if (dead) {
        reject(dead);
        return;
      }
      const fd = new FormData();
      fd.append('initData', initData);
      fd.append('action', action);
      Object.keys(fields || {}).forEach((k) => {
        const v = fields[k];
        if (v !== undefined && v !== null) fd.append(k, String(v));
      });
      fd.append('file', blob, fileName || 'file');
      const xhr = new XMLHttpRequest();
      xhr.open('POST', API_URL, true);
      xhr.timeout = 120000;
      if (xhr.upload && onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable && e.total > 0) onProgress(Math.min(1, e.loaded / e.total));
        };
      }
      xhr.onload = () => {
        let data = null;
        try {
          data = JSON.parse(xhr.responseText);
        } catch (e) {
          data = null;
        }
        try {
          resolve(handleResponse(xhr.status, data));
        } catch (err) {
          reject(err);
        }
      };
      xhr.onerror = () => reject(new ApiError('network', MSG.network, 0));
      xhr.ontimeout = () => reject(new ApiError('timeout', MSG.timeout, 0));
      xhr.onabort = () => reject(new ApiError('aborted', MSG.generic, 0));
      xhr.send(fd);
    });
  }

  function reportError(e) {
    if (!e || e.status === 401 || sessionDead || accessDead || clientDisabled || e.code === 'not_staff' || e.code === 'client_app_disabled') return;
    toast(e.message || MSG.generic, 'error');
    haptic.notify('error');
  }

  // ═══════════════════════════ Holat (state) va hodisalar ═══════════════════════════

  const S = {
    role: null, // 'client' | 'staff'
    me: null,
    isAdmin: false,
    // Panel roli: 'developer' | 'rop' | 'admin' | null (isAdmin — istalgan panel roli) va uning sarlavhasi
    panelRole: null,
    panelRoleTitle: '',
    clientBot: '', // mijozlar boti username i (shaxsiy havolalar prefiksi uchun)
    staff: [], // mijoz uchun: StaffCard[]
    convs: [], // ConvSummary[]
    total: 0,
    extraConvs: new Map(), // xodim: «Ko'proq yuklash» bilan olingan eski suhbatlar (id -> ConvSummary)
    // Serverdagi ro'yxat imzosi (list_sig): sync da yuboriladi — ro'yxat o'zgarmagan bo'lsa server uni qayta
    // yubormaydi. Ro'yxat mahalliy o'zgartirilsa (optimistik unread/aktivlik) — tozalanadi.
    listSig: null,
    // Xodim: «Ko'proq yuklash» sahifalash holati (serverdagi keyingi offset; hammasi yuklanganmi)
    convNextOffset: 0,
    convsExhausted: false,
  };

  const A = { staff: [], stats: null, loaded: false, dirty: true };

  const bus = (function () {
    const map = {};
    return {
      on(evt, fn) {
        (map[evt] = map[evt] || []).push(fn);
        return () => {
          map[evt] = (map[evt] || []).filter((f) => f !== fn);
        };
      },
      emit(evt, arg) {
        (map[evt] || []).slice().forEach((fn) => {
          try {
            fn(arg);
          } catch (e) {
            console.error(e);
          }
        });
      },
    };
  })();

  function normPeer(p, fallbackName) {
    p = p || {};
    return {
      name: str(p.name) || fallbackName,
      subtitle: str(p.subtitle),
      photo_url: safeSrc(p.photo_url) || null,
      is_online: typeof p.is_online === 'boolean' ? p.is_online : null,
      initials: str(p.initials),
    };
  }

  function normConv(c) {
    c = c || {};
    return {
      id: num(c.id) || null,
      staff_id: num(c.staff_id) || null,
      client_id: num(c.client_id) || null,
      peer: normPeer(c.peer, S.role === 'client' ? 'Xodim' : 'Mijoz'),
      last_message_at: c.last_message_at || null,
      last_message_preview: str(c.last_message_preview),
      last_sender: c.last_sender || null,
      unread: Math.max(0, num(c.unread)),
      is_active: !!c.is_active,
      // Mijoz uchun: xodim hali ham mavjudmi (yo'q bo'lsa — faqat tarixni o'qish)
      available: c.available !== false,
    };
  }

  function normStaffCard(s) {
    s = s || {};
    const role = s.role === 'manager' ? 'manager' : 'operator';
    return {
      id: num(s.id),
      role: role,
      role_label: str(s.role_label) || roleLabel(role),
      full_name: str(s.full_name) || 'Xodim',
      position: str(s.position),
      description: str(s.description),
      is_online: !!s.is_online,
      photo_url: safeSrc(s.photo_url) || null,
      conversation_id: num(s.conversation_id) || null,
      unread: Math.max(0, num(s.unread)),
      // undefined — maydon kelmagan; null — standart (umumiy) avto-javob
      greeting: s.greeting === undefined ? undefined : s.greeting === null ? null : str(s.greeting),
      tg_username: str(s.tg_username),
      // Xodim profili (Mini App "Profil"): o'chirib qo'yilgan xodim mijozlarga yoza olmaydi
      is_active: s.is_active !== false,
      // Mijozlar uchun shaxsiy havola (t.me/<mijoz_boti>?start=<link_code>)
      link_code: s.link_code ? str(s.link_code) : null,
      client_link: safeClientLink(s.client_link),
    };
  }

  function normAdminStaff(s) {
    const base = normStaffCard(s);
    s = s || {};
    base.tg_user_id = num(s.tg_user_id) || null;
    base.is_active = s.is_active !== false;
    base.linked = typeof s.linked === 'boolean' ? s.linked : !!base.tg_user_id;
    base.invite_link = s.invite_link ? str(s.invite_link) : null;
    base.sort_order = num(s.sort_order);
    base.bot_blocked = !!s.bot_blocked;
    return base;
  }

  function convTime(c) {
    const d = toDate(c.last_message_at);
    return d ? d.getTime() : 0;
  }

  function sortConvs(list) {
    return list.slice().sort((a, b) => convTime(b) - convTime(a) || num(b.id) - num(a.id));
  }

  function setConvs(list) {
    const fresh = arr(list).map(normConv).filter((c) => c.id);
    // Xodim: server faqat oxirgi 100 ta suhbatni qaytaradi — «Ko'proq yuklash» bilan olingan eski suhbatlar
    // ro'yxatda qoladi. Ularda yangi xabar bo'lsa, ular yuqoridagi ro'yxatga (yangi ma'lumot bilan) o'tadi.
    if (S.role === 'staff' && S.extraConvs.size) {
      const have = new Set(fresh.map((c) => c.id));
      // Sahifalash boshlangan bo'lsa, yuqoridagi 100 talikdan pastga tushib ketgan suhbat ham yo'qolmasin —
      // u endi sahifalangan (eski) suhbatlar qatorida. Xodimning suhbati boshqa xodimga o'tmaydi.
      S.convs.forEach((c) => {
        if (!have.has(c.id) && !S.extraConvs.has(c.id) && c.last_message_at) S.extraConvs.set(c.id, c);
      });
      S.extraConvs.forEach((c, id) => {
        if (have.has(id)) S.extraConvs.delete(id);
        else fresh.push(c);
      });
    }
    S.convs = sortConvs(fresh);
    bus.emit('convs');
  }

  /** Sahifalab olingan (eski) suhbatlarni ro'yxatga qo'shish. */
  function addExtraConvs(list) {
    let added = 0;
    list.forEach((c) => {
      if (!c.id || S.convs.some((x) => x.id === c.id)) return;
      S.extraConvs.set(c.id, c);
      S.convs.push(c);
      added++;
    });
    if (added) {
      S.listSig = null;
      S.convs = sortConvs(S.convs);
      bus.emit('convs');
    }
    return added;
  }

  function upsertConv(conv) {
    if (!conv || !conv.id) return;
    // Mahalliy (optimistik) o'zgarish: keyingi sync ro'yxatni to'liq qaytarsin
    S.listSig = null;
    const i = S.convs.findIndex((c) => c.id === conv.id);
    if (i >= 0) S.convs[i] = conv;
    else if (S.role === 'staff' && S.extraConvs.size) {
      S.extraConvs.set(conv.id, conv);
      S.convs.push(conv);
    } else S.convs.push(conv);
    S.convs = sortConvs(S.convs);
    bus.emit('convs');
  }

  /** Sync/bootstrap javobidagi ro'yxat imzosini eslab qolish (ro'yxat so'ralmagan bo'lsa — o'zgarmaydi). */
  function noteListSig(res) {
    if (res && typeof res.list_sig === 'string') S.listSig = res.list_sig;
  }

  /** Mijoz: serverdagi aktiv suhbat (bot chatidagi xabarlar qayerga borishi) — «faol» belgilarini moslash. */
  function applyActiveId(v) {
    if (S.role !== 'client' || v === undefined) return;
    const act = num(v) || null;
    let changed = false;
    S.convs = S.convs.map((c) => {
      const on = c.id === act;
      if (c.is_active === on) return c;
      changed = true;
      return Object.assign({}, c, { is_active: on });
    });
    if (changed) {
      S.listSig = null;
      bus.emit('convs');
    }
  }

  /**
   * sentSig — so'rovda yuborilgan ro'yxat imzosi (davriy bootstrap). Server ro'yxatni o'zgarmagan deb topsa
   * `conversations: null` va xuddi shu `list_sig` ni qaytaradi — mahalliy ro'yxat saqlanadi.
   */
  function applyBootstrap(res, isRefresh, sentSig) {
    S.role = res.role === 'staff' ? 'staff' : 'client';
    const convs = Array.isArray(res.conversations) ? res.conversations : null;
    const kept = !convs && !!sentSig && res.list_sig === sentSig;
    // Ro'yxat to'liq keldi — uning imzosi (yo'q bo'lsa null: keyingi sync to'liq ro'yxat qaytaradi).
    // O'zgarmagan (kept) — imzoga tegilmaydi (sync dagi kabi): so'rov davomida mahalliy o'zgarish uni tozalagan
    // bo'lsa, tozaligicha qoladi. Kutilmagan null — tozalanadi, keyingi sync to'liq ro'yxat oladi.
    if (convs) S.listSig = typeof res.list_sig === 'string' ? res.list_sig : null;
    else if (!kept) S.listSig = null;
    if (S.role === 'client') {
      S.me = res.me || null;
      S.staff = arr(res.staff).map(normStaffCard).filter((s) => s.id);
      bus.emit('staff');
    } else {
      if (typeof res.client_bot === 'string' && /^[A-Za-z0-9_]{3,64}$/.test(res.client_bot)) S.clientBot = res.client_bot;
      const me = res.me ? normStaffCard(res.me) : null;
      const admin = !!res.is_admin;
      const panelRole = admin ? normPanelRole(res.panel_role) : null;
      if (isRefresh && !me && !admin) {
        // Server odatda 403 not_staff qaytaradi; bu — qo'shimcha himoya
        accessRevoked();
        return;
      }
      // Profil uzildi/ulandi yoki panel roli o'zgardi — tablar tuzilmasi boshqa, asosiy ekran qayta quriladi
      const layoutChanged = !!isRefresh && (!!me !== !!S.me || admin !== S.isAdmin || panelRole !== S.panelRole);
      S.me = me;
      S.isAdmin = admin;
      S.panelRole = panelRole;
      S.panelRoleTitle = panelRole ? panelRoleTitle(panelRole, res.panel_role_title) : '';
      S.total = num(res.total);
      // Sahifalash: bootstrap oxirgi 100 tasini beradi. Foydalanuvchi allaqachon ko'proq yuklagan bo'lsa,
      // erishilgan joy saqlanadi (suhbatlar faqat yuqoriga ko'tariladi — hech biri o'tkazib yuborilmaydi).
      const bootOffset = res.next_offset !== undefined ? num(res.next_offset) : convs ? convs.length : S.convs.length;
      if (!isRefresh || !S.extraConvs.size) {
        S.convNextOffset = bootOffset;
        S.convsExhausted = res.has_more !== undefined ? !res.has_more : S.total <= bootOffset;
      } else {
        S.convNextOffset = Math.max(S.convNextOffset, bootOffset);
        // Hammasi yuklangandan keyin yangi suhbatlar faqat ro'yxat boshida paydo bo'ladi (sync ularni olib keladi)
        if (S.convsExhausted) S.convNextOffset = Math.max(S.convNextOffset, S.total);
      }
      // Ro'yxat o'zgarmagan (conversations: null) — mahalliy nusxa qoladi; jami soni yangilangan bo'lishi mumkin
      if (convs) setConvs(convs);
      else bus.emit('convs');
      if (layoutChanged && nav.stack.length) nav.replaceRoot(StaffRoot());
      else bus.emit('me');
      return;
    }
    setConvs(res.conversations);
  }

  function openChatConvId() {
    const top = nav.top();
    return top && top.type === 'chat' && top.convId ? top.convId() : null;
  }

  function unreadOf(c) {
    return c.id === openChatConvId() ? 0 : c.unread;
  }

  function totalUnread() {
    return S.convs.reduce((sum, c) => sum + unreadOf(c), 0);
  }

  // ═══════════════════════════ Navigatsiya (ekranlar steki) ═══════════════════════════

  const appEl = document.getElementById('app');

  const nav = {
    stack: [],
    overlays: [],
    lockUntil: 0,
    top() {
      return this.stack[this.stack.length - 1] || null;
    },
    setRoot(ctrl) {
      clear(appEl);
      this.stack = [ctrl];
      ctrl.el.classList.add('screen');
      appEl.appendChild(ctrl.el);
      syncBack();
      if (ctrl.onShow) ctrl.onShow();
    },
    /** Asosiy (pastki) ekranni almashtirish; ustidagi ochiq ekranlar joyida qoladi. */
    replaceRoot(ctrl) {
      const old = this.stack[0];
      if (!old) {
        this.setRoot(ctrl);
        return;
      }
      const covered = this.stack.length > 1;
      ctrl.el.classList.add('screen');
      if (covered) {
        ctrl.el.classList.add('under');
        ctrl.el.setAttribute('aria-hidden', 'true');
        ctrl.el.setAttribute('inert', '');
      }
      if (old.el.parentNode === appEl) appEl.replaceChild(ctrl.el, old.el);
      else appEl.insertBefore(ctrl.el, appEl.firstChild);
      this.stack[0] = ctrl;
      if (old.destroy) old.destroy();
      if (!covered && ctrl.onShow) ctrl.onShow();
    },
    /** Hamma ekran va oynalarni yopish (kirish huquqi yo'qolganda). Qoralamalar saqlanmaydi. */
    teardown() {
      const overlays = this.overlays.slice().reverse();
      overlays.forEach((o) => tgTry(() => o.close()));
      this.overlays = [];
      const stack = this.stack.slice().reverse();
      this.stack = [];
      stack.forEach((c) => {
        if (c.destroy) tgTry(() => c.destroy({ discard: true }));
      });
      this.lockUntil = 0;
      clear(appEl);
      syncBack();
    },
    locked() {
      return Date.now() < this.lockUntil;
    },
    push(ctrl) {
      if (!ctrl || this.locked()) return false;
      this.lockUntil = Date.now() + 360;
      const prev = this.top();
      const el = ctrl.el;
      el.classList.add('screen', 'pushed', 'enter');
      appEl.appendChild(el);
      void el.offsetWidth;
      el.classList.remove('enter');
      if (prev) {
        prev.el.classList.add('under');
        prev.el.setAttribute('aria-hidden', 'true');
        prev.el.setAttribute('inert', '');
        if (prev.onHide) prev.onHide();
      }
      this.stack.push(ctrl);
      syncBack();
      if (ctrl.onShow) ctrl.onShow();
      poller.reschedule();
      return true;
    },
    async pop(opts) {
      if (this.stack.length <= 1) return false;
      const ctrl = this.top();
      if (!(opts && opts.force)) {
        if (this.locked()) return false;
        if (ctrl.canLeave) {
          const ok = await ctrl.canLeave();
          if (!ok || this.top() !== ctrl) return false;
        }
      }
      this.lockUntil = Date.now() + 360;
      this.stack.pop();
      const prev = this.top();
      ctrl.el.classList.add('leave');
      ctrl.el.setAttribute('inert', '');
      setTimeout(() => ctrl.el.remove(), 380);
      if (ctrl.destroy) ctrl.destroy();
      if (prev) {
        prev.el.classList.remove('under');
        prev.el.removeAttribute('aria-hidden');
        prev.el.removeAttribute('inert');
        if (prev.onShow) prev.onShow();
      }
      syncBack();
      poller.kick();
      return true;
    },
    /** Joriy ekranni yangisi bilan almashtirish (orqaga qaytish avvalgi ekranga olib boradi). */
    replaceTop(ctrl) {
      if (!ctrl || this.stack.length <= 1) return this.push(ctrl);
      const old = this.stack.pop();
      this.lockUntil = 0;
      const pushed = this.push(ctrl);
      old.el.classList.add('under');
      setTimeout(() => old.el.remove(), 380);
      if (old.destroy) old.destroy();
      return pushed;
    },
    async popToRoot() {
      if (this.stack.length <= 1) return;
      // Oraliq ekranlar darhol olib tashlanadi, eng ustkisi animatsiya bilan yopiladi
      const top = this.stack.pop();
      while (this.stack.length > 1) {
        const mid = this.stack.pop();
        if (mid.destroy) mid.destroy();
        mid.el.remove();
      }
      this.stack.push(top);
      this.lockUntil = 0;
      await this.pop({ force: true });
    },
  };

  function syncBack() {
    setBackButton(nav.overlays.length > 0 || nav.stack.length > 1);
  }

  function handleBack() {
    if (nav.overlays.length) {
      nav.overlays[nav.overlays.length - 1].close();
      return;
    }
    if (nav.stack.length > 1) nav.pop();
  }

  function currentChat() {
    const top = nav.top();
    return top && top.type === 'chat' ? top : null;
  }

  function registerOverlay(close) {
    const entry = { close: close };
    nav.overlays.push(entry);
    syncBack();
    return () => {
      const i = nav.overlays.indexOf(entry);
      if (i >= 0) nav.overlays.splice(i, 1);
      syncBack();
    };
  }

  // ═══════════════════════════ Pastki oyna (sheet) va rasm ko'ruvchi ═══════════════════════════

  function openSheet(o) {
    let closed = false;
    const backdrop = h('div', { class: 'sheet-backdrop' });
    const closeBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Yopish' }, icon('close'));
    const body = h('div', { class: 'sheet-body' }, o.body);
    const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title || 'Oyna' }, [
      h('div', { class: 'sheet-grab', 'aria-hidden': 'true' }),
      h('div', { class: 'sheet-head' }, [h('h2', { class: 'sheet-title', text: o.title || '' }), closeBtn]),
      body,
    ]);
    let unregister = null;
    function close(result) {
      if (closed) return;
      closed = true;
      if (unregister) unregister();
      backdrop.classList.remove('show');
      sheet.classList.remove('show');
      setTimeout(() => {
        backdrop.remove();
        sheet.remove();
      }, 330);
      if (o.onClose) o.onClose(result);
    }
    backdrop.addEventListener('click', () => close(null));
    closeBtn.addEventListener('click', () => close(null));
    appEl.appendChild(backdrop);
    appEl.appendChild(sheet);
    unregister = registerOverlay(() => close(null));
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        backdrop.classList.add('show');
        sheet.classList.add('show');
      }),
    );
    return { close: close, body: body, el: sheet };
  }

  function openViewer(src, opts) {
    opts = opts || {};
    const url = safeSrc(src);
    if (!url) return;
    let closed = false;
    let clickTimer = 0;
    let lastClick = 0;
    const img = makeImg(url, { alt: opts.alt || 'Rasm' });
    const stage = h('div', { class: 'viewer-stage' }, img);
    const closeBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Yopish' }, icon('close'));
    const bottom = opts.onResend
      ? h('div', { class: 'viewer-bottom' }, [
          h('button', { class: 'btn sm', type: 'button', onclick: (e) => opts.onResend(e.currentTarget) }, '📥 Botda ochish'),
        ])
      : null;
    const el = h('div', { class: 'viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Rasm' }, [
      stage,
      h('div', { class: 'viewer-top' }, closeBtn),
      bottom,
    ]);
    let unregister = null;
    function close() {
      if (closed) return;
      closed = true;
      clearTimeout(clickTimer);
      if (unregister) unregister();
      el.classList.remove('show');
      setTimeout(() => el.remove(), 250);
    }
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      close();
    });
    stage.addEventListener('click', () => {
      const now = Date.now();
      if (now - lastClick < 300) {
        clearTimeout(clickTimer);
        lastClick = 0;
        el.classList.toggle('zoomed');
        return;
      }
      lastClick = now;
      clickTimer = setTimeout(() => {
        if (el.classList.contains('zoomed')) el.classList.toggle('chrome-hidden');
        else close();
      }, 300);
    });
    appEl.appendChild(el);
    unregister = registerOverlay(close);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
  }

  // ═══════════════════════════ Rasm/fayl tayyorlash ═══════════════════════════

  function loadImageFromBlob(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => resolve({ img: img, url: url });
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('decode'));
      };
      img.src = url;
    });
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve) => {
      try {
        canvas.toBlob((b) => resolve(b), type, quality);
      } catch (e) {
        resolve(null);
      }
    });
  }

  function jpegName(name) {
    const base = str(name).replace(/\.[^.\/\\]{1,6}$/, '') || 'rasm';
    return base + '.jpg';
  }

  async function reencodeJpeg(file, maxDim, quality) {
    const loaded = await loadImageFromBlob(file);
    try {
      const w = loaded.img.naturalWidth;
      const hgt = loaded.img.naturalHeight;
      if (!w || !hgt) throw new Error('decode');
      const scale = Math.min(1, maxDim / Math.max(w, hgt));
      const cw = Math.max(1, Math.round(w * scale));
      const ch = Math.max(1, Math.round(hgt * scale));
      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(loaded.img, 0, 0, cw, ch);
      const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
      if (!blob) throw new Error('encode');
      return blob;
    } finally {
      URL.revokeObjectURL(loaded.url);
    }
  }

  /** Chat uchun fayl: 4 MB dan katta rasmlar siqiladi, boshqalari tekshiriladi. → {blob, name, type, isImage} */
  async function prepareChatFile(file) {
    if (!file || !file.size) throw new Error("Fayl bo'sh yoki o'qib bo'lmadi.");
    const type = str(file.type).toLowerCase();
    const name = str(file.name) || 'fayl';
    const compressible = /^image\/(jpeg|jpg|png|webp)$/.test(type);
    const isImage = /^image\/(jpeg|jpg|png|webp|gif)$/.test(type);
    if (file.size <= MAX_UPLOAD) return { blob: file, name: name, type: type, isImage: isImage };
    if (!compressible) throw new Error(MSG.tooBig);
    const attempts = [
      [2560, 0.88],
      [1920, 0.82],
      [1600, 0.75],
    ];
    for (let i = 0; i < attempts.length; i++) {
      let blob = null;
      try {
        blob = await reencodeJpeg(file, attempts[i][0], attempts[i][1]);
      } catch (e) {
        throw new Error(MSG.tooBig);
      }
      if (blob.size <= MAX_UPLOAD) return { blob: blob, name: jpegName(name), type: 'image/jpeg', isImage: true, compressed: true };
    }
    throw new Error(MSG.tooBig);
  }

  /** Xodim rasmi: har doim JPEG, eng katta tomoni ≤ 1280 px. */
  async function prepareStaffPhoto(file) {
    if (!file || !file.size) throw new Error("Rasm bo'sh yoki o'qib bo'lmadi.");
    const type = str(file.type).toLowerCase();
    if (type && !/^image\//.test(type)) throw new Error('Iltimos, rasm faylini tanlang (JPG yoki PNG).');
    try {
      const blob = await reencodeJpeg(file, 1280, 0.9);
      return { blob: blob, name: jpegName(file.name), type: 'image/jpeg' };
    } catch (e) {
      if (/^image\/(jpeg|png|webp)$/.test(type) && file.size <= MAX_UPLOAD) return { blob: file, name: str(file.name) || 'rasm.jpg', type: type };
      throw new Error("Bu rasmni o'qib bo'lmadi. Iltimos, JPG yoki PNG formatidagi rasm tanlang.");
    }
  }

  // Bitta yashirin <input type=file> qayta ishlatiladi (bekor qilinganda DOM da keraksiz elementlar qolmasin).
  let fileInputEl = null;
  let fileResolver = null;

  function pickFile(accept) {
    return new Promise((resolve) => {
      if (fileResolver) fileResolver(null);
      if (!fileInputEl) {
        fileInputEl = h('input', {
          type: 'file',
          tabindex: '-1',
          'aria-hidden': 'true',
          style: 'position:fixed;top:-200px;left:0;width:1px;height:1px;opacity:0',
        });
        fileInputEl.addEventListener('change', () => {
          const f = fileInputEl.files && fileInputEl.files[0] ? fileInputEl.files[0] : null;
          const r = fileResolver;
          fileResolver = null;
          fileInputEl.value = '';
          if (r) r(f);
        });
        fileInputEl.addEventListener('cancel', () => {
          const r = fileResolver;
          fileResolver = null;
          if (r) r(null);
        });
        document.body.appendChild(fileInputEl);
      }
      fileInputEl.accept = accept || '';
      fileInputEl.value = '';
      fileResolver = resolve;
      fileInputEl.click();
    });
  }

  // ═══════════════════════════ So'rovlar (polling) ═══════════════════════════

  const poller = {
    timer: 0,
    inflight: false,
    again: false,
    failures: 0,
    stopped: false,
    ticks: 0,
    lastBoot: 0,
    interval() {
      return currentChat() ? CHAT_POLL : LIST_POLL;
    },
    delay() {
      if (!this.failures) return this.interval();
      return Math.min(this.interval() * Math.pow(2, this.failures), MAX_BACKOFF);
    },
    plan(ms) {
      clearTimeout(this.timer);
      if (this.stopped || !S.role || document.hidden) return;
      this.timer = setTimeout(() => this.tick(), Math.max(0, ms));
    },
    reschedule() {
      if (this.inflight) return;
      this.plan(this.delay());
    },
    kick() {
      if (this.inflight) {
        this.again = true;
        return;
      }
      this.plan(0);
    },
    stop() {
      this.stopped = true;
      clearTimeout(this.timer);
    },
    async tick() {
      if (this.stopped || this.inflight || document.hidden || !S.role) return;
      const chat = currentChat();
      let action = 'sync';
      let params = {};
      if (chat && chat.canSync()) {
        params = chat.syncParams(this.ticks);
        // Ochiq chatda ro'yxat har 3-so'rovda (~9 s) olinadi: qolganlarida bazaga ro'yxat so'rovi ham yo'q.
        // Ochiq chatning o'qilmaganlari baribir 0 ko'rsatiladi (unreadOf), badge lar biroz kechroq yangilanadi.
        if (this.ticks % 3 !== 0) params.list = false;
      } else if (!chat && this.ticks - this.lastBoot >= 6) action = 'bootstrap'; // ~48 s da bir: xodimlar holati, profil
      // Ro'yxat o'zgarmagan bo'lsa server uni qayta yubormaydi (conversations: null) — sync da ham, davriy
      // bootstrap da ham (imzo bazada hisoblanadi: o'zgarmagan ro'yxat uchun ~100 bayt)
      if ((action === 'bootstrap' || params.list !== false) && S.listSig) params.listSig = S.listSig;
      this.inflight = true;
      this.again = false;
      this.ticks++;
      try {
        const res = await api(action, params, { timeout: 15000 });
        this.failures = 0;
        netBanner(false);
        if (action === 'bootstrap') {
          this.lastBoot = this.ticks;
          if (res.role === S.role) applyBootstrap(res, true, params.listSig);
        } else {
          // Imzo ro'yxatdan OLDIN yoziladi: setConvs ichidagi mahalliy o'zgarish uni tozalasa — tozaligicha qoladi
          if (Array.isArray(res.conversations)) {
            noteListSig(res);
            setConvs(res.conversations);
          } else if (params.listSig && res.list_sig === params.listSig) {
            // Ro'yxat o'zgarmagan — mahalliy nusxa dolzarb
          } else if (params.list !== false) {
            // Kutilmagan javob (eski server): imzoni tozalaymiz, keyingi safar to'liq ro'yxat keladi
            S.listSig = null;
          }
          if (chat && params.conversationId && currentChat() === chat) chat.onSync(arr(res.messages), res);
        }
      } catch (e) {
        // Sessiya tugagan yoki xodimga kirish yopilgan — tarmoq xatosi emas (ekran allaqachon almashtirilgan)
        if (e.status === 401 || e.code === 'not_staff' || sessionDead || accessDead || clientDisabled) return;
        if (chat && params.conversationId && (e.status === 403 || e.status === 404)) chat.onAccessLost(e);
        else {
          this.failures++;
          // status 0 — internet/vaqt tugadi; 5xx va boshqalar — server vaqtincha javob bermayapti
          if (this.failures >= 2) netBanner(true, e.status);
        }
      } finally {
        this.inflight = false;
        if (!this.stopped) this.plan(this.again ? 0 : this.delay());
      }
    },
  };

  let hiddenAt = 0;
  function onVisibility() {
    if (document.hidden) {
      hiddenAt = Date.now();
      clearTimeout(poller.timer);
      const chat = currentChat();
      if (chat) chat.saveDraftNow();
    } else {
      if (hiddenAt && Date.now() - hiddenAt > 45000) poller.lastBoot = -100;
      hiddenAt = 0;
      poller.kick();
    }
  }

  // ═══════════════════════════ Tabli asosiy ekran ═══════════════════════════

  function TabbedRoot(o) {
    const tabBtns = {};
    const panels = {};
    const badges = {};
    const ids = o.tabs.map((t) => t.id);
    let current = null;

    const indicator = h('span', { class: 'tabs-ind', 'aria-hidden': 'true' });
    indicator.style.width = 'calc((100% - 6px) / ' + o.tabs.length + ')';
    const tabsEl = h('div', { class: 'tabs', role: 'tablist' }, indicator);
    const panelsEl = h('div', { class: 'panels' });

    o.tabs.forEach((t) => {
      const badge = h('span', { class: 'count', hidden: true });
      const btn = h(
        'button',
        {
          class: 'tab',
          type: 'button',
          role: 'tab',
          id: 'tab-' + t.id,
          'aria-controls': 'panel-' + t.id,
          'aria-selected': 'false',
          onclick: () => select(t.id, true),
        },
        [h('span', { class: 'tab-emoji', 'aria-hidden': 'true', text: t.emoji }), h('span', { class: 'tab-label', text: t.label }), badge],
      );
      const panel = h('section', { class: 'panel', role: 'tabpanel', id: 'panel-' + t.id, 'aria-labelledby': 'tab-' + t.id, hidden: true });
      tabBtns[t.id] = btn;
      panels[t.id] = panel;
      badges[t.id] = badge;
      tabsEl.appendChild(btn);
      panelsEl.appendChild(panel);
    });

    const header = h('header', { class: 'topbar' }, [
      h('div', { class: 'topbar-text' }, [o.titleEl, o.subtitleEl]),
      o.headerRight || null,
    ]);
    const el = h('section', { class: 'root' }, [header, o.tabs.length > 1 ? h('div', { class: 'tabs-wrap' }, tabsEl) : null, panelsEl]);

    function select(id, byUser) {
      if (ids.indexOf(id) < 0) id = ids[0];
      if (id === current) {
        // Faol tabni qayta bosish — ro'yxat boshiga qaytish
        if (byUser) {
          try {
            panels[id].scrollTo({ top: 0, behavior: 'smooth' });
          } catch (e) {
            panels[id].scrollTop = 0;
          }
        }
        return;
      }
      current = id;
      const idx = ids.indexOf(id);
      indicator.style.transform = 'translateX(' + idx * 100 + '%)';
      ids.forEach((tid) => {
        const on = tid === id;
        tabBtns[tid].classList.toggle('active', on);
        tabBtns[tid].setAttribute('aria-selected', on ? 'true' : 'false');
        tabBtns[tid].tabIndex = on ? 0 : -1;
        panels[tid].hidden = !on;
        panels[tid].classList.toggle('shown', on && !!byUser);
      });
      if (byUser) {
        haptic.select();
        storage.set('tab', id);
      }
      if (o.onTab) o.onTab(id);
    }

    function setBadge(id, n) {
      const b = badges[id];
      if (!b) return;
      const txt = n > 0 ? fmtCount(n) : '';
      if (b.textContent !== txt) {
        b.textContent = txt;
        b.hidden = !n;
        if (n) {
          b.classList.remove('pop');
          void b.offsetWidth;
          b.classList.add('pop');
        }
      }
    }

    return {
      el: el,
      panel: (id) => panels[id],
      select: select,
      setBadge: setBadge,
      current: () => current,
    };
  }

  // ═══════════════════════════ Suhbatlar ro'yxati komponenti ═══════════════════════════

  function ConvList(o) {
    // Qatorlar — haqiqiy <button> lar (role=listitem tugma semantikasini yo'qotadi)
    const el = h('div', { class: 'list' });
    const rows = new Map();

    function mainFor(c, unread) {
      const mine = S.role === 'client' ? c.last_sender === 'client' : c.last_sender === 'staff';
      let preview = c.last_message_preview;
      if (!preview) preview = c.last_message_at ? '' : "Hali xabar yo'q";
      return h('div', { class: 'row-main' }, [
        h('div', { class: 'row-top' }, [
          h('span', { class: 'row-name', text: c.peer.name }),
          c.is_active ? h('span', { class: 'pill-active', text: 'faol', title: 'Bot chatidagi xabarlaringiz shu suhbatga yuboriladi' }) : null,
          h('span', { class: 'row-time' + (unread ? ' unread' : ''), text: listTime(c.last_message_at) }),
        ]),
        h('div', { class: 'row-bottom' }, [
          h('span', { class: 'row-preview' }, [mine && c.last_message_preview ? h('span', { class: 'row-me', text: 'Siz: ' }) : null, preview]),
          unread ? h('span', { class: 'count', text: fmtCount(unread) }) : null,
        ]),
      ]);
    }

    function update(list) {
      const today = dayKey(new Date());
      // Avval eskirgan qatorlarni olib tashlaymiz — qolganlari joyida qoladi (keraksiz DOM ko'chirishlarisiz)
      const seen = new Set(list.map((c) => c.id));
      rows.forEach((r, id) => {
        if (!seen.has(id)) {
          r.el.remove();
          rows.delete(id);
        }
      });
      list.forEach((c, i) => {
        let r = rows.get(c.id);
        if (!r) {
          const btn = h('button', { class: 'row conv', type: 'button' });
          const slot = h('div', { class: 'row-ava' });
          btn.appendChild(slot);
          r = { el: btn, slot: slot, main: null, sig: '', avaSig: '', conv: c };
          btn.addEventListener('click', () => o.onOpen(r.conv));
          rows.set(c.id, r);
        }
        r.conv = c;
        const unread = unreadOf(c);
        const online = S.role === 'client' ? c.peer.is_online : null;
        const avaSig = [c.peer.photo_url, c.peer.name, c.peer.initials, online].join('|');
        if (avaSig !== r.avaSig) {
          clear(r.slot).appendChild(
            avatar({ url: c.peer.photo_url, name: c.peer.name, initials: c.peer.initials, seed: S.role === 'client' ? c.staff_id : c.client_id, size: 52, online: online, lazy: true }),
          );
          r.avaSig = avaSig;
        }
        const sig = JSON.stringify([c.peer.name, c.last_message_at, c.last_message_preview, c.last_sender, unread, c.is_active, today]);
        if (sig !== r.sig) {
          if (r.main) r.main.remove();
          r.main = mainFor(c, unread);
          r.el.appendChild(r.main);
          r.el.setAttribute('aria-label', c.peer.name + (unread ? ', ' + unread + " ta o'qilmagan xabar" : ''));
          r.sig = sig;
        }
        const at = el.children[i];
        if (at !== r.el) el.insertBefore(r.el, at || null);
      });
      el.hidden = list.length === 0;
    }

    return { el: el, update: update };
  }

  // ═══════════════════════════ Chat ekrani (mijoz va xodim uchun umumiy) ═══════════════════════════

  const KIND_INFO = {
    photo: { emoji: '📷', label: 'Rasm' },
    video: { emoji: '🎬', label: 'Video' },
    animation: { emoji: '🎞', label: 'GIF' },
    document: { emoji: '📄', label: 'Fayl' },
    audio: { emoji: '🎵', label: 'Audio' },
    voice: { emoji: '🎤', label: 'Ovozli xabar' },
    video_note: { emoji: '📹', label: 'Video xabar' },
    sticker: { emoji: '🎨', label: 'Stiker' },
    location: { emoji: '📍', label: 'Joylashuv' },
    contact: { emoji: '👤', label: 'Kontakt' },
  };

  // ── Xabar media havolalari ──
  // Server har javobda xabar rasmi uchun yangi imzoli token beradi (muddati ichida). Bir xabar uchun bitta
  // URL ni qayta ishlatamiz: brauzer keshi ishlaydi va chat qayta ochilganda rasmlar qaytadan yuklanmaydi.
  const mediaUrls = new Map(); // message id -> url
  const MEDIA_URL_REUSE_SEC = 600; // tokenning kamida 10 daqiqasi qolgan bo'lsa — eski URL ishlatiladi

  function mediaTokenExp(url) {
    const m = /[?&]t=([^&#]+)/.exec(str(url));
    if (!m) return 0;
    let t = '';
    try {
      t = decodeURIComponent(m[1]);
    } catch (e) {
      return 0;
    }
    const exp = Number(t.split('.')[1]);
    return Number.isFinite(exp) && exp > 0 ? exp : 0;
  }

  /** Token muddati `marginSec` soniya ichida tugaydimi (tokensiz havolalar uchun — yo'q). */
  function mediaUrlExpiring(url, marginSec) {
    const exp = mediaTokenExp(url);
    return !!exp && exp - serverNowSec() <= marginSec;
  }

  function stableMediaUrl(id, url) {
    if (!id || !url || !mediaTokenExp(url)) return url;
    const cached = mediaUrls.get(id);
    if (cached && (!mediaUrlExpiring(cached, MEDIA_URL_REUSE_SEC) || mediaTokenExp(cached) >= mediaTokenExp(url))) return cached;
    mediaUrls.set(id, url);
    return url;
  }

  function normMsg(m) {
    if (!m || typeof m !== 'object') return null;
    const id = num(m.id);
    if (!id) return null;
    const media = m.media && typeof m.media === 'object' ? m.media : null;
    return {
      id: id,
      conversation_id: num(m.conversation_id),
      sender: m.sender === 'staff' || m.sender === 'bot' ? m.sender : 'client',
      outgoing: m.sender !== 'bot' && !!m.outgoing,
      kind: str(m.kind) || 'text',
      text: m.text == null ? '' : str(m.text),
      created_at: m.created_at,
      via: str(m.via),
      meta: m.meta && typeof m.meta === 'object' ? m.meta : null,
      media: media
        ? {
            url: stableMediaUrl(id, safeSrc(media.url) || null),
            file_name: str(media.file_name),
            mime_type: str(media.mime_type),
            file_size: num(media.file_size),
            inline: !!media.inline,
          }
        : null,
      // Suhbatdoshga yetkazilganmi (maydon kelmasa — yetkazilgan deb hisoblanadi)
      delivered: m.sender === 'bot' || m.delivered !== false,
      edited: !!m.edited,
      edited_at: m.edited_at || null,
    };
  }

  /** Pufak ko'rinishiga ta'sir qiladigan maydonlar (joyida qayta chizish kerakmi). */
  function msgSig(m) {
    return JSON.stringify([m.kind, m.text, m.delivered, m.edited, m.media ? [m.media.url, m.media.file_name, m.media.inline] : null, m.meta]);
  }

  function msgPreview(m) {
    if (m.kind === 'text') return m.text.replace(/\s+/g, ' ').trim().slice(0, 80);
    const info = KIND_INFO[m.kind];
    return info ? info.emoji + ' ' + info.label : '📎 Fayl';
  }

  function revokeLater(url) {
    if (url) setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ═══════════════════════════ Yuborish navbati (outbox) ═══════════════════════════
  // Telegramdagidek: foydalanuvchi oldingi xabar yetib borishini kutmasdan yozaveradi. Xabarlar qat'iy
  // ketma-ket (FIFO) yuboriladi — Telegram va bazada tartib saqlanadi. Navbat chat ekranidan mustaqil:
  // chatdan chiqilsa ham yuborish davom etadi, qayta ochilganda kutilayotgan pufaklar yana ko'rinadi.
  // Yuborilmagan matnlar localStorage da saqlanadi (Mini App yopilib qolsa ham yo'qolmaydi).
  // Element holatlari: 'queued' → 'sending' → (serverga saqlandi — navbatdan chiqadi) | 'failed'.
  const outbox = { items: [], inflight: null, seq: 0, restored: false };
  const OUTBOX_KEEP_MS = 7 * 86400000;
  // Server birinchi so'rovni hali bajarayotgan bo'lsa (409 in_progress) — shuncha marta kutib, qayta so'raymiz
  const IN_PROGRESS_POLLS = 12;
  const IN_PROGRESS_WAIT_MS = 2500;

  /**
   * Har bir yuboriladigan xabar uchun bir martalik kalit (idempotentlik): javob yo'qolib, xabar qayta yuborilsa,
   * server uni ikkinchi marta yetkazmaydi — saqlangan xabarni qaytaradi.
   */
  function newNonce() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    } catch (e) {
      /* eski webview */
    }
    return (Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).slice(0, 40);
  }

  function sleepMs(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function outboxFor(convId) {
    return convId ? outbox.items.filter((p) => p.convId === convId) : [];
  }

  function outboxChat(convId) {
    const c = currentChat();
    return c && c.convId() === convId ? c : null;
  }

  function outboxNotify(p, type, extra) {
    const chat = outboxChat(p.convId);
    if (chat && chat.onOutbox) chat.onOutbox(type, p, extra);
  }

  function outboxPersist() {
    if (!S.role || accessDead) return;
    const list = outbox.items
      .filter((p) => p.kind === 'text' && (p.state === 'queued' || p.state === 'failed'))
      .slice(-50)
      .map((p) => ({ c: p.convId, t: p.text, at: p.created_at, n: p.nonce }));
    if (list.length) storage.set('outbox', list);
    else storage.del('outbox');
  }

  /** Oldingi seansdan qolgan yuborilmagan matnlar — «yuborilmadi» holatida (foydalanuvchi o'zi qayta yuboradi yoki o'chiradi). */
  function outboxRestore() {
    if (outbox.restored) return;
    outbox.restored = true;
    const list = storage.get('outbox', null);
    if (!Array.isArray(list)) return;
    const now = Date.now();
    list.forEach((x) => {
      const convId = num(x && x.c);
      const text = str(x && x.t).trim();
      const at = toDate(x && x.at);
      if (!convId || !text || (at && now - at.getTime() > OUTBOX_KEEP_MS)) return;
      const n = str(x && x.n);
      outbox.items.push({
        lid: ++outbox.seq,
        convId: convId,
        kind: 'text',
        text: text.slice(0, TEXT_MAX),
        state: 'failed',
        created_at: at ? at.toISOString() : new Date().toISOString(),
        // Oldingi seansda yuborilgan-u javobi yo'qolgan bo'lsa — xuddi shu kalit bilan takrorlanmaydi
        nonce: /^[A-Za-z0-9_-]{8,64}$/.test(n) ? n : newNonce(),
      });
    });
    outboxPersist();
  }

  function outboxPush(p) {
    // Qayta yuborishda kalit o'zgarmaydi (server birinchi urinish saqlanganini bilsa — takrorlamaydi)
    if (!p.nonce) p.nonce = newNonce();
    p.lid = ++outbox.seq;
    p.state = 'queued';
    p.progress = 0;
    outbox.items.push(p);
    outboxPersist();
    outboxPump();
    return p;
  }

  function outboxRemove(p) {
    const i = outbox.items.indexOf(p);
    if (i >= 0) outbox.items.splice(i, 1);
    outboxPersist();
  }

  /** Qayta yuborish: element navbat oxiriga o'tadi (yuborilish tartibi ko'rinish tartibiga mos bo'lsin). */
  function outboxRetry(p) {
    const i = outbox.items.indexOf(p);
    if (i >= 0) outbox.items.splice(i, 1);
    p.error = null;
    p.created_at = new Date().toISOString();
    outboxPush(p);
  }

  function outboxFailWhere(pred) {
    outbox.items.forEach((p) => {
      if (p.state === 'queued' && pred(p)) {
        p.state = 'failed';
        outboxNotify(p, 'failed', null);
      }
    });
    outboxPersist();
  }

  function outboxFailAll() {
    outboxFailWhere(() => true);
  }

  function outboxClear() {
    outbox.items.forEach((p) => revokeLater(p.previewUrl));
    outbox.items = [];
    storage.del('outbox');
  }

  function outboxPump() {
    if (outbox.inflight || sessionDead || accessDead) return;
    const next = outbox.items.find((p) => p.state === 'queued');
    if (!next) return;
    outbox.inflight = next;
    outboxSend(next)
      .catch((e) => console.error(e))
      .then(() => {
        outbox.inflight = null;
        outboxPump();
      });
  }

  async function outboxSend(p) {
    p.state = 'sending';
    p.progress = 0;
    p.error = null;
    outboxPersist();
    outboxNotify(p, 'update');
    // Fayl yuklanayotganda Mini App tasodifan yopilib qolmasin
    const guardClose = p.kind !== 'text' && tgAtLeast('6.2');
    if (guardClose) tgTry(() => tg.enableClosingConfirmation());
    try {
      const once = () =>
        p.kind === 'text'
          ? api('send', { conversationId: p.convId, text: p.text, clientNonce: p.nonce }, { timeout: 45000 })
          : apiUpload('upload', { conversationId: p.convId, caption: p.caption || '', clientNonce: p.nonce }, p.blob, p.fileName, (f) => {
              p.progress = f;
              outboxNotify(p, 'progress');
            });
      let res;
      for (let attempt = 0; ; attempt++) {
        try {
          res = await once();
          break;
        } catch (e) {
          // Oldingi (javobi yo'qolgan) so'rov serverda hali bajarilmoqda — xabar "yuborilmoqda" holatida qoladi;
          // kutib, xuddi shu kalit bilan so'raymiz (tayyor bo'lsa server saqlangan xabarni qaytaradi) yoki sync uni oladi
          if (e.code !== 'in_progress' || attempt >= IN_PROGRESS_POLLS) throw e;
          await sleepMs(IN_PROGRESS_WAIT_MS);
          if (p.adoptedId || outbox.items.indexOf(p) < 0 || sessionDead || accessDead) return;
        }
      }
      outboxRemove(p);
      p.state = 'sent';
      const chat = outboxChat(p.convId);
      if (chat && chat.onOutbox) chat.onOutbox('sent', p, res);
      else revokeLater(p.previewUrl);
      if (res.warning) toast(res.warning, 'warn', 5000);
      applyActiveId(res.active_conversation_id);
      const serverMsg = normMsg(res.message);
      const listed = serverMsg ? S.convs.find((c) => c.id === p.convId) : null;
      if (listed) {
        upsertConv(
          Object.assign({}, listed, {
            last_message_at: serverMsg.created_at,
            last_message_preview: msgPreview(serverMsg),
            last_sender: S.role,
            unread: chat ? 0 : listed.unread,
          }),
        );
      }
      poller.kick();
    } catch (e) {
      if (p.adoptedId) {
        // Sync bu xabarni serverdan allaqachon qaytargan — u saqlangan, xato ko'rsatilmaydi (yetkazilganligini
        // pufak o'zi ko'rsatadi: sync keyingi so'rovlarda holatini yangilaydi)
        const chat = outboxChat(p.convId);
        if (chat && chat.onOutbox) chat.onOutbox('settled', p, null);
        else revokeLater(p.previewUrl);
        return;
      }
      if (accessDead || outbox.items.indexOf(p) < 0) return;
      p.state = 'failed';
      p.error = e.message;
      outboxPersist();
      // Sessiya tugagan bo'lsa navbatdagilar ham yuborilmaydi; xodim mavjud bo'lmasa — shu suhbatdagilar
      if (e.status === 401 || sessionDead) outboxFailAll();
      else if (e.code === 'staff_unavailable') outboxFailWhere((x) => x.convId === p.convId);
      // Bloklangan xodim — hech bir suhbatga yoza olmaydi
      else if (e.code === 'staff_inactive') {
        outboxFailAll();
        if (S.me) {
          S.me = Object.assign({}, S.me, { is_active: false });
          bus.emit('me');
        }
      }
      outboxNotify(p, 'failed', e);
      if (outboxChat(p.convId) || e.status === 401 || sessionDead) {
        reportError(e);
      } else {
        // Chat yopilgan (fonda yuborilayotgan edi) — qaysi suhbatda ekanini aytamiz
        const listed = S.convs.find((c) => c.id === p.convId);
        const who = listed ? '«' + listed.peer.name + '» bilan suhbatni' : 'Suhbatni';
        toast('Xabar yuborilmadi. ' + who + " ochib, qayta urinib ko'ring.", 'error', 6000);
        haptic.notify('error');
      }
    } finally {
      if (guardClose) tgTry(() => tg.disableClosingConfirmation());
    }
  }

  function ChatScreen(opts) {
    let conv = opts.conv;
    const msgs = new Map();
    let ids = [];
    const nodes = new Map();
    const quiet = new Set(); // kutilayotgan pufak o'rniga chiqqan server xabarlari — kirish animatsiyasisiz
    const warned = new Set();
    const blobUrls = new Map();
    let syncAfterId = 0;
    // Server vaqti (ISO): shundan keyingi tahrirlar sync da so'raladi
    let editedSince = null;
    // Sync `send` javobidan oldin qaytargan (hali yuborilayotgan) o'z xabarlarimiz — ❗ emas, 🕒 ko'rsatiladi
    const settling = new Set();
    // Yetkazilmagan chiquvchi xabarlar pufagida hozir ko'rsatilgan holat (o'zgarsa — joyida qayta chiziladi)
    const shownDelivery = new Map();
    const retrying = new Set();
    let hasMore = false;
    let loadingOlder = false;
    let olderFailAt = 0;
    let ready = false;
    let readonly = false;
    let destroyed = false;
    let syncDisabled = false;
    let newCount = 0;
    let stick = true;
    let unreadBeforeId = null;
    let lastQueued = null;
    let avaSig = '';
    const unsubs = [];
    const pendingItems = () => outboxFor(conv.id);

    const self = { type: 'chat' };

    // ── DOM ──
    const backBtn = h('button', { class: 'icon-btn back-btn', type: 'button', 'aria-label': 'Orqaga', onclick: () => nav.pop() }, icon('back'));
    const avaSlot = h('div', { class: 'chat-ava' });
    const nameEl = h('div', { class: 'chat-name' });
    const subEl = h('div', { class: 'chat-sub' });
    const peerBtn = h('button', { class: 'chat-peer', type: 'button', 'aria-label': "Suhbatdosh haqida", onclick: showPeerInfo }, [
      avaSlot,
      h('div', { class: 'chat-titles' }, [nameEl, subEl]),
    ]);
    const header = h('header', { class: 'chat-header' }, [backBtn, peerBtn]);

    const olderEl = h('div', { class: 'older-loader', hidden: true }, spinner('sm'));
    const introEl = h('div', { class: 'chat-intro', hidden: true });
    const listEl = h('div', { class: 'msgs', role: 'log', 'aria-live': 'polite', 'aria-label': 'Xabarlar' });
    const inner = h('div', { class: 'chat-inner' }, [olderEl, h('div', { class: 'chat-grow' }), introEl, listEl]);
    const scroller = h('div', { class: 'chat-scroll' }, inner);
    const pill = h('button', { class: 'new-pill', type: 'button', hidden: true, onclick: () => scrollToBottom(true) });
    const stateEl = h('div', { class: 'chat-state' }, spinner());
    const body = h('div', { class: 'chat-body' }, [scroller, pill, stateEl]);

    const textarea = h('textarea', {
      class: 'composer-input',
      rows: '1',
      placeholder: 'Xabar yozing…',
      maxlength: String(TEXT_MAX),
      'aria-label': 'Xabar matni',
      enterkeyhint: DESKTOP ? 'send' : 'enter',
      autocomplete: 'off',
      disabled: true,
    });
    const attachBtn = h('button', { class: 'icon-btn attach', type: 'button', 'aria-label': 'Rasm yoki fayl biriktirish', disabled: true }, icon('attach'));
    const sendBtn = h('button', { class: 'send-btn', type: 'button', 'aria-label': 'Yuborish', disabled: true }, icon('send'));
    const countEl = h('div', { class: 'composer-count', hidden: true, 'aria-live': 'polite' });
    const composer = h('div', { class: 'composer' }, [attachBtn, h('div', { class: 'input-wrap' }, textarea), sendBtn, countEl]);
    const banner = h('div', { class: 'chat-banner', hidden: true });

    self.el = h('section', { class: 'chat', 'aria-label': 'Suhbat' }, [header, body, banner, composer]);

    // ── Sarlavha ──
    function renderHeader() {
      const p = conv.peer;
      nameEl.textContent = p.name;
      clear(subEl);
      if (S.role === 'client') {
        append(subEl, [
          h('span', { class: p.is_online ? 'online-text' : '', text: p.is_online ? 'onlayn' : 'oflayn' }),
          p.subtitle ? ' · ' + p.subtitle : '',
        ]);
      } else {
        subEl.textContent = p.subtitle || 'Mijoz';
      }
      const sig = [p.photo_url, p.name, p.initials, p.is_online].join('|');
      if (sig !== avaSig) {
        avaSig = sig;
        clear(avaSlot).appendChild(
          avatar({
            url: p.photo_url,
            name: p.name,
            initials: p.initials,
            seed: S.role === 'client' ? conv.staff_id : conv.client_id,
            size: 40,
            online: S.role === 'client' ? p.is_online : null,
          }),
        );
      }
    }

    function staffCardOf() {
      return S.staff.find((s) => s.id === conv.staff_id) || null;
    }

    function showPeerInfo() {
      const p = conv.peer;
      const items = [];
      if (S.role === 'client') {
        const s = staffCardOf();
        if (s && s.position) items.push(['Lavozim', s.position]);
        if (s && s.description) items.push(["Ma'lumot", s.description]);
        items.push(['Holat', p.is_online ? '🟢 Hozir onlayn' : "⚪️ Hozir oflayn — xabaringiz saqlanadi va imkon bo'lganda javob beriladi"]);
      } else {
        if (p.subtitle) items.push(['Telegram', p.subtitle]);
        if (conv.client_id) items.push(['Telegram ID', String(conv.client_id)]);
        if (conv.last_message_at) items.push(['Oxirgi xabar', fullDate(conv.last_message_at)]);
      }
      const username = S.role === 'staff' && /^@[A-Za-z0-9_]{3,}$/.test(p.subtitle) ? p.subtitle.slice(1) : '';
      const ava = avatar({ url: p.photo_url, name: p.name, initials: p.initials, seed: S.role === 'client' ? conv.staff_id : conv.client_id, size: 88 });
      const bodyEls = [
        p.photo_url
          ? h('button', { class: 'ava-btn', type: 'button', style: 'margin:0 auto', 'aria-label': 'Rasmni ochish', onclick: () => openViewer(p.photo_url, { alt: p.name }) }, ava)
          : ava,
        h('div', { class: 'profile-name', text: p.name }),
        S.role === 'client'
          ? h('div', { class: 'profile-meta' }, [h('span', { class: 'badge ' + (p.is_online ? 'on' : 'off'), text: p.is_online ? 'Onlayn' : 'Oflayn' })])
          : null,
        items.length
          ? h(
              'div',
              { class: 'info-block' },
              items.map((it) => h('div', { class: 'info-item' }, [h('div', { class: 'info-label', text: it[0] }), h('div', { class: 'info-value', text: it[1] })])),
            )
          : null,
        username
          ? h('div', { class: 'sheet-actions' }, [
              h('button', { class: 'btn secondary', type: 'button', onclick: () => openLink('https://t.me/' + username) }, 'Telegram profilini ochish'),
            ])
          : null,
      ];
      openSheet({ title: S.role === 'client' ? roleLabel(staffCardOf() ? staffCardOf().role : 'operator') : 'Mijoz', body: h('div', { class: 'peer-sheet' }, bodyEls) });
    }

    // ── Holatlar ──
    function showState(kind, e) {
      clear(stateEl);
      if (!kind) {
        stateEl.hidden = true;
        return;
      }
      stateEl.hidden = false;
      if (kind === 'loading') {
        stateEl.appendChild(spinner());
        return;
      }
      const unavailable = e && e.code === 'staff_unavailable';
      stateEl.appendChild(
        h('div', { class: 'chat-state-card' }, [
          h('div', { class: 'chat-state-emoji', 'aria-hidden': 'true', text: unavailable ? '🙁' : '😕' }),
          h('div', { text: unavailable ? MSG.staffUnavailable : (e && e.message) || MSG.generic }),
          unavailable
            ? h('button', { class: 'btn sm', type: 'button', onclick: () => nav.pop() }, '⬅️ Ro\'yxatga qaytish')
            : h('button', { class: 'btn sm', type: 'button', onclick: load }, "🔄 Qayta urinish"),
        ]),
      );
    }

    function renderIntro() {
      const show = ready && S.role === 'client' && ids.length === 0 && pendingItems().length === 0;
      introEl.hidden = !show;
      if (!show || introEl.childNodes.length) return;
      const p = conv.peer;
      const first = firstWord(p.name) || p.name;
      // Jo'nalish kelishigi: Otabek → Otabekka, Malika → Malikaga; ism harf bilan tugamasa — qo'shimchasiz ibora
      const toWhom = dative(first) || "xodimning o'ziga";
      append(introEl, [
        avatar({ url: p.photo_url, name: p.name, initials: p.initials, seed: conv.staff_id, size: 64 }),
        h('div', { class: 'chat-intro-name', text: p.name }),
        p.subtitle ? h('div', { class: 'chat-intro-sub', text: p.subtitle }) : null,
        h('div', { class: 'chat-intro-text', text: "Savolingizni yozing — xabaringiz to'g'ridan-to'g'ri " + toWhom + ' yetkaziladi.' }),
        h('ul', { class: 'chat-intro-steps' }, [
          h('li', null, [h('span', { text: '🤖' }), h('span', { text: 'Birinchi xabaringizga bot avtomatik javob beradi.' })]),
          h('li', null, [h('span', { text: '💬' }), h('span', { text: "So'ng " + first + ' sizga shaxsan javob yozadi.' })]),
          h('li', null, [h('span', { text: '📎' }), h('span', { text: 'Matn, rasm yoki fayl (4 MB gacha) yuborishingiz mumkin.' })]),
        ]),
      ]);
    }

    /** Xodimning o'z profili o'chirib qo'yilgan — mijozlarga yoza olmaydi (tarixni o'qiy oladi). */
    function staffInactive() {
      return S.role === 'staff' && !!S.me && S.me.is_active === false;
    }

    function applyReadonly() {
      composer.hidden = readonly;
      banner.hidden = !readonly;
      if (!readonly) return;
      clear(banner);
      const staffText = staffInactive() ? '⛔ ' + MSG.staffInactive : "⚠️ Bu suhbatga yozib bo'lmaydi.";
      append(banner, [
        h('div', { text: S.role === 'client' ? '⚠️ ' + MSG.staffUnavailable : staffText }),
        S.role === 'client'
          ? h('button', { class: 'btn sm secondary', type: 'button', onclick: () => nav.popToRoot() }, '👥 Boshqa xodim tanlash')
          : null,
      ]);
    }

    // ── Xabarlar ──
    function addMessages(list, fromSync) {
      let added = 0;
      let incoming = 0;
      for (let i = 0; i < list.length; i++) {
        const m = normMsg(list[i]);
        if (!m) continue;
        if (conv.id && m.conversation_id && m.conversation_id !== conv.id) continue;
        if (fromSync && m.id > syncAfterId) syncAfterId = m.id;
        if (msgs.has(m.id)) continue;
        if (m.outgoing) adoptPending(m);
        msgs.set(m.id, m);
        added++;
        if (!m.outgoing) incoming++;
      }
      if (added) ids = Array.from(msgs.keys()).sort((a, b) => a - b);
      return { added: added, incoming: incoming };
    }

    /**
     * Sync yuborilayotgan xabarni javobdan oldin qaytarsa — kutilayotgan pufakni server xabari bilan almashtiramiz.
     * Faqat hozir yuborilayotgan ('sending') element mos keladi: navbatdagi yoki yuborilmagan bir xil matnli
     * pufak (masalan, ketma-ket ikki «ok») boshqa xabarning aks-sadosi bilan almashib ketmasin.
     */
    function adoptPending(m) {
      if (m.via && m.via !== 'webapp') return;
      const list = pendingItems();
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        if (p.state !== 'sending') continue;
        const match =
          p.kind === 'text'
            ? m.kind === 'text' && m.text === p.text
            : m.kind !== 'text' && (!m.media || !m.media.file_name || m.media.file_name === p.fileName);
        if (match) {
          if (p.previewUrl) blobUrls.set(m.id, p.previewUrl);
          p.adoptedId = m.id;
          settling.add(m.id);
          quiet.add('m:' + m.id);
          outboxRemove(p);
          return;
        }
      }
    }

    function sideOf(m) {
      if (m.sender === 'bot') return 'sys';
      return m.outgoing ? 'out' : 'in';
    }

    function render(animate) {
      const items = [];
      let lastDay = '';
      const pushDay = (d) => {
        const k = dayKey(d);
        if (k !== lastDay) {
          lastDay = k;
          items.push({ key: 'd:' + k, type: 'day', label: dayLabel(d) });
        }
      };
      for (let i = 0; i < ids.length; i++) {
        const m = msgs.get(ids[i]);
        const d = toDate(m.created_at) || new Date();
        pushDay(d);
        if (unreadBeforeId === m.id) items.push({ key: 'u', type: 'unread' });
        items.push({ key: 'm:' + m.id, type: 'msg', m: m, side: sideOf(m), t: d.getTime(), day: lastDay });
      }
      const pend = pendingItems();
      for (let i = 0; i < pend.length; i++) {
        const p = pend[i];
        const d = toDate(p.created_at) || new Date();
        pushDay(d);
        items.push({ key: 'p:' + p.lid, type: 'pending', p: p, side: 'out', t: d.getTime(), day: lastDay });
      }
      // Guruhlash (ketma-ket bir tomondan kelgan xabarlar)
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.type !== 'msg' && it.type !== 'pending') continue;
        const prev = items[i - 1];
        const next = items[i + 1];
        const same = (o) => o && (o.type === 'msg' || o.type === 'pending') && o.side === it.side && o.side !== 'sys' && o.day === it.day && Math.abs(o.t - it.t) < 10 * 60000;
        it.first = !same(prev);
        it.last = !same(next);
      }
      // Avval eskirgan tugunlarni olib tashlaymiz: o'rtadan element (masalan, «Yangi xabarlar» ajratgichi)
      // yo'qolganda keyingi tugunlar joyida qoladi — qayta qo'yilmaydi va animatsiyasi takrorlanmaydi.
      const keep = new Set(items.map((it) => it.key));
      nodes.forEach((node, key) => {
        if (!keep.has(key)) {
          node.remove();
          nodes.delete(key);
        }
      });
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const bubble = it.type === 'msg' || it.type === 'pending';
        let node = nodes.get(it.key);
        if (!node) {
          node = buildItem(it);
          nodes.set(it.key, node);
          if (animate && bubble && !quiet.has(it.key)) playAppear(node);
        } else if (it.type === 'day') {
          node.textContent = it.label;
        }
        quiet.delete(it.key);
        if (bubble) {
          node.classList.toggle('first', !!it.first);
          node.classList.toggle('last', !!it.last);
        }
        const at = listEl.children[i];
        if (at !== node) listEl.insertBefore(node, at || null);
      }
      renderIntro();
    }

    /** Kirish animatsiyasi bir marta: tugagach klass olib tashlanadi (tugun ko'chirilsa ham qayta o'ynamaydi). */
    function playAppear(node) {
      node.classList.add('appear');
      const done = (e) => {
        if (e.target !== node) return; // ichki elementlar (spinner va h.k.) animatsiyalari ham ko'tariladi
        node.classList.remove('appear');
        node.removeEventListener('animationend', done);
        node.removeEventListener('animationcancel', done);
      };
      node.addEventListener('animationend', done);
      node.addEventListener('animationcancel', done);
    }

    function buildItem(it) {
      if (it.type === 'day') return h('div', { class: 'day', text: it.label });
      if (it.type === 'unread') return h('div', { class: 'unread-sep', text: 'Yangi xabarlar' });
      if (it.type === 'pending') return buildPending(it.p);
      return buildMsg(it.m);
    }

    function stampEl(date, statusIconName, extraCls, edited) {
      const d = toDate(date);
      return h('span', { class: 'stamp' + (extraCls ? ' ' + extraCls : '') }, [
        edited ? h('span', { class: 'edited', text: 'tahrirlangan' }) : null,
        h('time', { text: d ? hhmm(d) : '', datetime: d ? d.toISOString() : null }),
        statusIconName ? icon(statusIconName, statusIconName === 'alert' ? 'warn-ico' : '') : null,
      ]);
    }

    // Yangi yuborilgan xabar yetkazilishi uchun beriladigan vaqt (shu vaqtgacha 🕒, keyin ❗)
    const UNDELIVERED_GRACE_SEC = 45;

    /** Chiquvchi xabar holati: 'ok' — yetkazilgan; 'sending' — hozir/yaqinda yuborilgan; 'failed' — yetkazilmagan. */
    function deliveryState(m) {
      if (!m.outgoing || m.sender === 'bot') return 'ok';
      if (warned.has(m.id)) return 'failed';
      if (m.delivered) return 'ok';
      if (settling.has(m.id)) return 'sending';
      const d = toDate(m.created_at);
      const age = d ? serverNowSec() - Math.floor(d.getTime() / 1000) : Infinity;
      return age < UNDELIVERED_GRACE_SEC ? 'sending' : 'failed';
    }

    function undeliveredText() {
      return S.role === 'staff' ? MSG.undelivered + ' — qayta yuborish uchun bosing' : 'Xodimga hali yetkazilmadi — qayta yuborish uchun bosing';
    }

    /** Saqlangan, lekin yetkazilmagan o'z xabarini qayta yuborish (yangi yozuv yaratilmaydi). */
    function retryMsg(m) {
      if (retrying.has(m.id) || destroyed) return;
      retrying.add(m.id);
      haptic.impact('light');
      api('retry', { messageId: m.id }, { timeout: 45000 })
        .then((res) => {
          if (destroyed) return;
          if (res.delivered) warned.delete(m.id);
          if (res.message) updateMessages([res.message]);
          if (res.delivered) {
            toast('Yetkazildi', 'success', 2000);
            haptic.notify('success');
          } else {
            toast(res.warning || "Hozircha yetkazib bo'lmadi. Birozdan keyin qayta urinib ko'ring.", 'warn', 5000);
          }
        })
        .catch((e) => {
          if (!destroyed && (e.code === 'staff_unavailable' || e.code === 'staff_inactive')) {
            if (e.code === 'staff_inactive' && S.me) S.me = Object.assign({}, S.me, { is_active: false });
            readonly = true;
            applyReadonly();
            updateSendState();
          }
          reportError(e);
        })
        .then(() => retrying.delete(m.id));
    }

    /** Mavjud xabar pufagini (holati/matni o'zgargan) joyida qayta chizish. */
    function rebuildMsg(id) {
      const key = 'm:' + id;
      const m = msgs.get(id);
      const old = nodes.get(key);
      if (!m || !old) return;
      const node = buildMsg(m);
      node.classList.toggle('first', old.classList.contains('first'));
      node.classList.toggle('last', old.classList.contains('last'));
      old.replaceWith(node);
      nodes.set(key, node);
    }

    /** Serverdan kelgan yangilangan xabarlar (tahrir, yetkazildi): faqat allaqachon ko'rsatilganlari almashtiriladi. */
    function updateMessages(list) {
      for (let i = 0; i < list.length; i++) {
        const m = normMsg(list[i]);
        if (!m || !msgs.has(m.id)) continue;
        if (conv.id && m.conversation_id && m.conversation_id !== conv.id) continue;
        const old = msgs.get(m.id);
        if (m.delivered) {
          warned.delete(m.id);
          settling.delete(m.id);
        }
        msgs.set(m.id, m);
        if (msgSig(old) !== msgSig(m) || (shownDelivery.get(m.id) || 'ok') !== deliveryState(m)) rebuildMsg(m.id);
      }
    }

    /** Vaqt o'tishi bilan 🕒 → ❗ (yetkazilmagan xabar uchun berilgan vaqt tugadi). */
    function refreshDeliveryStates() {
      shownDelivery.forEach((state, id) => {
        const m = msgs.get(id);
        if (!m) {
          shownDelivery.delete(id);
          return;
        }
        if (deliveryState(m) !== state) rebuildMsg(id);
      });
    }

    function textBlock(text) {
      const el = h('div', { class: 'text' });
      el.appendChild(linkify(text));
      el.appendChild(h('span', { class: 'stamp-space', 'aria-hidden': 'true' }));
      return el;
    }

    function mediaWidth() {
      return Math.max(160, Math.min(280, Math.floor((window.innerWidth || 360) * 0.68)));
    }

    function sizeBox(box, w, hgt, maxW) {
      if (!(w > 0 && hgt > 0)) return false;
      const dw = Math.max(90, Math.min(maxW, w));
      let dh = Math.round((dw * hgt) / w);
      dh = Math.max(80, Math.min(360, dh));
      box.style.width = dw + 'px';
      box.style.height = dh + 'px';
      return true;
    }

    function onMediaLoaded(box, img, hadSize, maxW) {
      if (!hadSize) {
        const before = box.offsetHeight;
        const top = box.getBoundingClientRect().top;
        sizeBox(box, img.naturalWidth, img.naturalHeight, maxW);
        const delta = box.offsetHeight - before;
        if (delta && !stick && top < scroller.getBoundingClientRect().top) scroller.scrollTop += delta;
      }
      if (stick) scrollToBottom(false);
    }

    function resend(m, btn) {
      if (!btn || btn.disabled) return;
      btn.disabled = true;
      const old = btn.textContent;
      btn.textContent = 'Yuborilmoqda…';
      api('resend', { messageId: m.id }, { timeout: 60000 })
        .then(() => {
          toast('Fayl bot chatiga yuborildi', 'success');
          haptic.notify('success');
          btn.textContent = '✅ Yuborildi';
          setTimeout(() => {
            btn.textContent = old;
            btn.disabled = false;
          }, 4000);
        })
        .catch((e) => {
          btn.textContent = old;
          btn.disabled = false;
          reportError(e);
        });
    }

    function fileChip(kind, name, metaText) {
      const info = KIND_INFO[kind] || KIND_INFO.document;
      return h('div', { class: 'file-chip' }, [
        h('div', { class: 'file-ico', 'aria-hidden': 'true', text: info.emoji }),
        h('div', { class: 'file-info' }, [h('div', { class: 'file-name', text: name || info.label }), h('div', { class: 'file-meta', text: metaText || info.label })]),
      ]);
    }

    function buildMsg(m) {
      if (m.sender === 'bot') {
        const b = h('div', { class: 'bubble' }, [
          h('div', { class: 'sys-label', text: '🤖 Avtomatik javob' }),
          textBlock(m.text),
          stampEl(m.created_at, null),
        ]);
        return h('div', { class: 'msg sys', 'data-id': String(m.id) }, h('div', { class: 'msg-col' }, b));
      }
      const side = m.outgoing ? 'out' : 'in';
      const dstate = deliveryState(m);
      const isWarned = dstate === 'failed';
      if (dstate === 'ok') shownDelivery.delete(m.id);
      else shownDelivery.set(m.id, dstate);
      const node = h('div', { class: 'msg ' + side + (isWarned ? ' warned' : '') + (m.edited ? ' edited' : ''), 'data-id': String(m.id) });
      const col = h('div', { class: 'msg-col' });
      const bubble = h('div', { class: 'bubble' });
      const media = m.media;
      const kind = m.kind;
      const caption = m.text;
      const status = m.outgoing ? (isWarned ? 'alert' : dstate === 'sending' ? 'clock' : 'check') : null;

      if (kind === 'text' || (!media && kind !== 'location' && kind !== 'contact' && KIND_INFO[kind] == null)) {
        bubble.appendChild(textBlock(caption));
      } else if (media && media.inline && media.url) {
        const isSticker = kind === 'sticker';
        bubble.classList.add(isSticker ? 'sticker' : 'media');
        if (!caption) bubble.classList.add('no-caption');
        const maxW = isSticker ? 160 : mediaWidth();
        const box = h('button', { class: 'media-box', type: 'button', 'aria-label': isSticker ? 'Stiker' : 'Rasmni kattalashtirish' });
        let hadSize = false;
        if (isSticker) {
          box.style.width = '160px';
          box.style.height = '160px';
          hadSize = true;
        } else {
          const meta = m.meta || {};
          hadSize = sizeBox(box, num(meta.width), num(meta.height), maxW);
          if (!hadSize) {
            box.style.width = maxW + 'px';
            box.style.height = Math.round(maxW * 0.75) + 'px';
          }
        }
        const src = blobUrls.get(m.id) || media.url;
        let refreshed = false;
        const broken = () => {
          if (!box.querySelector('.media-shimmer')) box.appendChild(h('div', { class: 'media-shimmer' }, h('span', { text: '🖼' })));
        };
        const img = makeImg(src, {
          alt: isSticker ? str(m.meta && m.meta.emoji) || 'Stiker' : 'Rasm',
          lazy: true,
          onload: (im) => {
            const ph = box.querySelector('.media-shimmer');
            if (ph) ph.remove();
            onMediaLoaded(box, im, hadSize, maxW);
          },
          onerror: () => {
            const cur = img.getAttribute('src');
            if (cur !== media.url) {
              // Lokal oldindan ko'rinish (blob) ishlamadi — server nusxasiga o'tamiz
              img.src = media.url;
              return;
            }
            if (!refreshed && mediaUrlExpiring(media.url, 60)) {
              // Imzoli havola muddati o'tgan (chat uzoq ochiq qolgan) — yangi havola olib, bir marta qayta urinamiz
              refreshed = true;
              refreshMediaUrl(m).then(
                (u) => {
                  if (!img.isConnected) return;
                  if (u && u !== cur) img.src = u;
                  else broken();
                },
                broken,
              );
              return;
            }
            broken();
          },
        });
        box.appendChild(img);
        if (!isSticker) {
          box.addEventListener('click', () => {
            const shown = blobUrls.get(m.id);
            const view = (u) => openViewer(u, { onResend: (btn) => resend(m, btn) });
            if (shown && img.getAttribute('src') === shown) view(shown);
            else if (mediaUrlExpiring(media.url, 60)) refreshMediaUrl(m).then((u) => view(u || media.url), reportError);
            else view(media.url);
          });
        }
        bubble.appendChild(box);
        if (caption) bubble.appendChild(textBlock(caption));
      } else if (kind === 'location') {
        const meta = m.meta || {};
        const lat = Number(meta.latitude);
        const lon = Number(meta.longitude);
        const valid = meta.latitude != null && meta.longitude != null && Number.isFinite(lat) && Number.isFinite(lon);
        bubble.classList.add('filey');
        const card = h(
          'button',
          {
            class: 'loc-card',
            type: 'button',
            disabled: !valid,
            onclick: () => openLink('https://maps.google.com/?q=' + lat.toFixed(6) + ',' + lon.toFixed(6)),
          },
          fileChip('location', caption || 'Joylashuv', valid ? '🗺 Xaritada ochish' : "Koordinatalar yo'q"),
        );
        bubble.appendChild(card);
      } else if (kind === 'contact') {
        const meta = m.meta || {};
        const phone = str(meta.phone_number);
        bubble.classList.add('filey');
        const card = h(
          'button',
          {
            class: 'contact-card',
            type: 'button',
            onclick: () => {
              if (!phone) return;
              copyText(phone).then((ok) => toast(ok ? 'Telefon raqami nusxalandi' : phone, ok ? 'success' : 'info'));
            },
          },
          fileChip('contact', str(meta.contact_name) || 'Kontakt', phone ? phone + ' · nusxalash' : 'Kontakt'),
        );
        bubble.appendChild(card);
        if (caption) bubble.appendChild(textBlock(caption));
      } else {
        const info = KIND_INFO[kind] || KIND_INFO.document;
        const meta = m.meta || {};
        const parts = [];
        if (media && media.file_size) parts.push(fmtSize(media.file_size));
        if (meta.duration) parts.push(fmtDuration(meta.duration));
        if (!parts.length) parts.push(info.label);
        const name = (media && media.file_name) || (kind === 'sticker' && meta.emoji ? 'Stiker ' + meta.emoji : info.label);
        bubble.classList.add('filey');
        bubble.appendChild(fileChip(kind, name, parts.join(' · ')));
        const btn = h('button', { class: 'file-open', type: 'button' }, '📥 Botda ochish');
        btn.addEventListener('click', () => resend(m, btn));
        bubble.appendChild(btn);
        if (caption) bubble.appendChild(textBlock(caption));
      }
      bubble.appendChild(stampEl(m.created_at, status, null, m.edited));
      col.appendChild(bubble);
      if (isWarned) {
        col.appendChild(h('button', { class: 'warn-note', type: 'button', onclick: () => retryMsg(m) }, undeliveredText()));
      }
      node.appendChild(col);
      return node;
    }

    /**
     * Xabar saqlandi, lekin yetkazilmadi — ⚠ belgisi va izoh. Pufak allaqachon chizilgan bo'lsa
     * (sync xabarni `send` javobidan oldin qaytargan) — joyida yangilanadi.
     */
    function markWarned(id) {
      warned.add(id);
      settling.delete(id);
      const node = nodes.get('m:' + id);
      if (!node || node.classList.contains('warned')) return;
      rebuildMsg(id);
    }

    // ── Muddati o'tgan media havolalarini yangilash ──
    // So'rovlar ketma-ket: har biri shu xabar atrofidagi ~30 ta xabarni (10 tasi yangiroq) qamraydi,
    // shuning uchun qo'shni rasmlar odatda qo'shimcha so'rovsiz shu javobdan yangilanadi.
    let urlChain = Promise.resolve();

    function freshMediaUrl(id) {
      const u = mediaUrls.get(id);
      if (!u || mediaUrlExpiring(u, 60)) return null;
      const x = msgs.get(id);
      if (x && x.media) x.media.url = u;
      return u;
    }

    function refreshMediaUrl(m) {
      const run = () => {
        const have = freshMediaUrl(m.id);
        if (have || destroyed || !conv.id) return have;
        // messages: id < beforeId, eng yangilaridan `limit` tasi. Chegara — shu xabardan 10 ta keyingi yuklangan xabar.
        const idx = ids.indexOf(m.id);
        const upper = idx >= 0 ? ids[Math.min(idx + 10, ids.length - 1)] : m.id;
        return api('messages', { conversationId: conv.id, beforeId: Math.max(upper, m.id) + 1, limit: 30 }).then((res) => {
          arr(res.messages).forEach((raw) => {
            const id = num(raw && raw.id);
            const u = raw && raw.media ? safeSrc(raw.media.url) : '';
            if (id && u) stableMediaUrl(id, u);
          });
          return freshMediaUrl(m.id);
        });
      };
      const pr = urlChain.then(run, run);
      urlChain = pr.catch(() => null);
      return pr;
    }

    function buildPending(p) {
      const node = h('div', { class: 'msg out pending' });
      const col = h('div', { class: 'msg-col' });
      const bubble = h('div', { class: 'bubble' });
      p.progressText = null;
      p.progressBar = null;
      if (p.kind === 'text') {
        bubble.appendChild(textBlock(p.text));
      } else if (p.previewUrl) {
        bubble.classList.add('media');
        if (!p.caption) bubble.classList.add('no-caption');
        const maxW = mediaWidth();
        const box = h('div', { class: 'media-box' });
        const hadSize = sizeBox(box, p.w, p.h, maxW);
        if (!hadSize) {
          box.style.width = maxW + 'px';
          box.style.height = Math.round(maxW * 0.75) + 'px';
        }
        box.appendChild(makeImg(p.previewUrl, { alt: 'Rasm' }));
        const ringLen = 2 * Math.PI * 21;
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', '24');
        circle.setAttribute('cy', '24');
        circle.setAttribute('r', '21');
        circle.setAttribute('stroke-dasharray', String(ringLen));
        circle.setAttribute('stroke-dashoffset', String(ringLen));
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 48 48');
        svg.appendChild(circle);
        const pct = h('span', { text: '0%' });
        const ring = h('div', { class: 'up-ring' }, [svg, pct]);
        const overlay = h('div', { class: 'up-overlay' }, ring);
        box.appendChild(overlay);
        p.progressText = pct;
        p.progressCircle = circle;
        p.ringLen = ringLen;
        p.overlay = overlay;
        bubble.appendChild(box);
        if (p.caption) bubble.appendChild(textBlock(p.caption));
      } else {
        bubble.classList.add('filey');
        bubble.appendChild(fileChip('document', p.fileName, fmtSize(p.size)));
        const bar = h('i');
        bubble.appendChild(h('div', { class: 'upbar' }, bar));
        p.progressBar = bar;
        if (p.caption) bubble.appendChild(textBlock(p.caption));
      }
      const stamp = stampEl(p.created_at, 'clock');
      bubble.appendChild(stamp);
      col.appendChild(bubble);
      const failNote = h('div', { class: 'fail-note', hidden: true, text: 'Yuborilmadi. Qayta urinish uchun bosing.' });
      col.appendChild(failNote);
      node.appendChild(col);
      node.addEventListener('click', () => {
        if (p.state === 'failed') pendingActions(p);
      });
      p.node = node;
      p.stamp = stamp;
      p.failNote = failNote;
      paintPending(p);
      return node;
    }

    /** Navbatdan kelgan holat o'zgarishi — faqat shu chat chizgan pufak uchun. */
    function updatePending(p) {
      if (p.node && nodes.get('p:' + p.lid) === p.node) paintPending(p);
    }

    function paintPending(p) {
      const failed = p.state === 'failed';
      p.node.classList.toggle('failed', failed);
      p.failNote.hidden = !failed;
      const oldIco = p.stamp.querySelector('.ico');
      const newIco = icon(failed ? 'alert' : 'clock', failed ? 'warn-ico' : '');
      if (oldIco) oldIco.replaceWith(newIco);
      else p.stamp.appendChild(newIco);
      const f = Math.max(0, Math.min(1, p.progress || 0));
      if (p.progressText) {
        p.progressText.textContent = failed ? '!' : Math.round(f * 100) + '%';
        p.progressCircle.setAttribute('stroke-dashoffset', String(p.ringLen * (1 - f)));
      }
      if (p.progressBar) p.progressBar.style.width = Math.round(f * 100) + '%';
    }

    async function pendingActions(p) {
      let choice = null;
      if (readonly) {
        const ok = await confirmDialog("Xabar yuborilmadi va bu suhbatga endi yozib bo'lmaydi. Xabar o'chirilsinmi?", {
          ok: "O'chirish",
          destructive: true,
        });
        choice = ok ? 'delete' : null;
      } else {
        choice = await choiceDialog('Xabar yuborilmadi. Nima qilamiz?', [
          { id: 'retry', text: '🔄 Qayta yuborish' },
          { id: 'delete', text: "O'chirish", destructive: true },
        ]);
      }
      if (destroyed || p.state !== 'failed' || outbox.items.indexOf(p) < 0) return;
      if (choice === 'retry') {
        // Pufak yangi vaqt bilan navbat oxiriga o'tadi — qayta quramiz
        dropNode('p:' + p.lid);
        unreadBeforeId = null;
        outboxRetry(p);
        render(false);
        scrollToBottom(true);
        haptic.impact('light');
      } else if (choice === 'delete') {
        deletePending(p);
        render(false);
      }
    }

    function dropNode(key) {
      const n = nodes.get(key);
      if (n) {
        n.remove();
        nodes.delete(key);
      }
    }

    function deletePending(p) {
      outboxRemove(p);
      if (!p.previewUrl) return;
      // Server xabari hali shu lokal rasmni ko'rsatayotgan bo'lsa — bo'shatmaymiz (chat yopilganda bo'shatiladi)
      let used = false;
      blobUrls.forEach((u) => {
        if (u === p.previewUrl) used = true;
      });
      if (!used) revokeLater(p.previewUrl);
    }

    // ── Aylantirish (scroll) ──
    function distFromBottom() {
      return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    }

    function scrollToBottom(smooth) {
      newCount = 0;
      stick = true;
      const top = scroller.scrollHeight;
      if (smooth && typeof scroller.scrollTo === 'function') {
        try {
          scroller.scrollTo({ top: top, behavior: 'smooth' });
        } catch (e) {
          scroller.scrollTop = top;
        }
      } else {
        scroller.scrollTop = top;
      }
      updatePill();
    }

    function updatePill() {
      const dist = distFromBottom();
      if (newCount > 0 && dist > 80) {
        pill.hidden = false;
        pill.classList.remove('round');
        clear(pill);
        append(pill, [icon('down'), newCount + ' ta yangi xabar']);
        pill.setAttribute('aria-label', newCount + ' ta yangi xabar');
      } else if (dist > 700) {
        pill.hidden = false;
        pill.classList.add('round');
        clear(pill).appendChild(icon('down'));
        pill.setAttribute('aria-label', 'Pastga');
      } else {
        pill.hidden = true;
        if (dist <= 80) newCount = 0;
      }
    }

    scroller.addEventListener(
      'scroll',
      () => {
        const dist = distFromBottom();
        stick = dist < 80;
        if (stick) newCount = 0;
        updatePill();
        if (scroller.scrollTop < 400 && hasMore && ready) loadOlder();
      },
      { passive: true },
    );

    async function loadOlder() {
      if (loadingOlder || !hasMore || !ready || !ids.length || destroyed || Date.now() - olderFailAt < 5000) return;
      loadingOlder = true;
      olderEl.hidden = false;
      try {
        const res = opts.loadPage
          ? await opts.loadPage(ids[0], 50)
          : await api('messages', { conversationId: conv.id, beforeId: ids[0], limit: 50 });
        if (destroyed) return;
        const prevH = scroller.scrollHeight;
        const prevTop = scroller.scrollTop;
        hasMore = !!res.has_more;
        const r = addMessages(arr(res.messages), false);
        if (!r.added) hasMore = false;
        olderEl.hidden = true;
        render(false);
        scroller.scrollTop = scroller.scrollHeight - prevH + prevTop;
      } catch (e) {
        olderFailAt = Date.now();
        reportError(e);
      } finally {
        loadingOlder = false;
        olderEl.hidden = true;
      }
      if (!destroyed) fillIfShort();
    }

    /** Xabarlar ekranni to'ldirmasa (aylantirish imkoni bo'lmasa) — eski xabarlarni avtomatik yuklash. */
    function fillIfShort() {
      if (hasMore && !loadingOlder && ready && scroller.scrollHeight <= scroller.clientHeight + 40) {
        setTimeout(loadOlder, 0);
      }
    }

    // ── Yuklash ──
    async function load() {
      ready = false;
      showState('loading');
      setComposerEnabled(false);
      try {
        const res = await opts.load();
        if (destroyed) return;
        if (res.conversation) {
          const c = normConv(res.conversation);
          if (c.id) conv = c;
        }
        readonly = !!res.readonly || staffInactive();
        hasMore = !!res.has_more;
        if (res.server_time) editedSince = str(res.server_time);
        addMessages(arr(res.messages), true);
        computeUnreadDivider(opts.unread || 0);
        ready = true;
        showState(null);
        renderHeader();
        render(false);
        applyReadonly();
        restoreDraft();
        setComposerEnabled(!readonly);
        if (conv.id) {
          const listed = S.convs.find((c) => c.id === conv.id);
          // Aktiv suhbatni server aytadi: kartadagi «✍️ Yozish» uni almashtiradi, eski suhbatni ko'rish — yo'q
          let activeNow = listed ? listed.is_active : !!conv.is_active;
          if (S.role === 'client' && res.active_conversation_id !== undefined) {
            activeNow = (num(res.active_conversation_id) || null) === conv.id;
            applyActiveId(res.active_conversation_id);
          }
          upsertConv(Object.assign({}, listed || conv, { unread: 0, peer: conv.peer, is_active: activeNow }));
        }
        // Boshlang'ich aylantirish: yangi xabarlar ajratgichiga yoki eng pastga
        requestAnimationFrame(() => {
          const sep = nodes.get('u');
          if (sep && sep.parentNode) {
            scroller.scrollTop += sep.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 8;
            stick = distFromBottom() < 80;
          } else {
            scrollToBottom(false);
          }
          updatePill();
          fillIfShort();
        });
        if (DESKTOP && !readonly) textarea.focus();
        poller.reschedule();
      } catch (e) {
        if (destroyed || e.status === 401) return;
        showState('error', e);
      }
    }

    function computeUnreadDivider(unread) {
      unreadBeforeId = null;
      if (!unread) return;
      const incoming = ids.filter((id) => {
        const m = msgs.get(id);
        return !m.outgoing && m.sender !== 'bot';
      });
      if (!incoming.length) return;
      const idx = Math.max(0, incoming.length - unread);
      unreadBeforeId = incoming[idx];
    }

    // ── Sync (poller chaqiradi) ──
    self.convId = () => conv.id;
    self.canSync = () => !opts.noSync && ready && !destroyed && !syncDisabled && !!conv.id;
    self.syncParams = (tick) => {
      let after = syncAfterId;
      // Har 5-so'rovda oxirgi bir nechta xabarni qayta so'raymiz: bir vaqtda yozilgan xabarlardan kichik id lisi
      // kechroq saqlansa, syncAfterId undan o'tib ketgan bo'ladi. Kichik suhbatlarda (≤ 6 xabar) — butun suhbat
      // (afterId=0; server 100 tagacha qaytaradi, mavjudlari o'tkazib yuboriladi). Aynan yangi suhbatda mijozning
      // birinchi xabari, avto-javob va xodimning tezkor javobi deyarli bir vaqtda yoziladi.
      if (tick % 5 === 4 && ids.length) after = Math.min(after, ids.length > 6 ? ids[ids.length - 7] : 0);
      const params = { conversationId: conv.id, afterId: after };
      // Ochiq chatdagi tahrirlar va hali yetkazilmagan o'z xabarlarimizning holati
      if (editedSince) params.editedSince = editedSince;
      const undelivered = [];
      for (let i = ids.length - 1; i >= 0 && undelivered.length < 50; i--) {
        const m = msgs.get(ids[i]);
        if (m && m.outgoing && !m.delivered) undelivered.push(m.id);
      }
      if (undelivered.length) params.undelivered = undelivered;
      return params;
    };
    self.onSync = (list, res) => {
      if (!ready || destroyed) return;
      if (res && res.server_time) editedSince = str(res.server_time);
      if (res && Array.isArray(res.updated) && res.updated.length) updateMessages(res.updated);
      refreshDeliveryStates();
      const wasNear = distFromBottom() < 120;
      const r = addMessages(list, true);
      if (!r.added) return;
      render(true);
      if (wasNear) {
        scrollToBottom(true);
      } else if (r.incoming) {
        newCount += r.incoming;
        updatePill();
      }
      if (r.incoming) haptic.impact('soft');
    };
    self.onAccessLost = (e) => {
      if (syncDisabled) return;
      syncDisabled = true;
      readonly = true;
      applyReadonly();
      reportError(e);
    };

    function onConvs() {
      if (!conv.id) return;
      const c = S.convs.find((x) => x.id === conv.id);
      if (!c) return;
      const changed = c.peer.is_online !== conv.peer.is_online || c.peer.name !== conv.peer.name || c.peer.photo_url !== conv.peer.photo_url || c.peer.subtitle !== conv.peer.subtitle;
      conv = Object.assign({}, conv, { peer: c.peer, last_message_at: c.last_message_at, is_active: c.is_active, available: c.available });
      if (changed) renderHeader();
      if (S.role === 'client' && ready && !readonly && c.available === false) {
        readonly = true;
        applyReadonly();
      }
    }
    unsubs.push(bus.on('convs', onConvs));

    // ── Yuborish ──
    function setComposerEnabled(on) {
      textarea.disabled = !on;
      updateSendState();
    }

    function updateSendState() {
      const val = textarea.value;
      const has = val.trim().length > 0;
      // Yuborish tugmasi oldingi xabar yetib borishini kutmaydi — xabarlar navbat bilan ketma-ket yuboriladi
      sendBtn.disabled = !ready || readonly || !has || val.length > TEXT_MAX;
      attachBtn.disabled = !ready || readonly;
      const len = val.length;
      if (len > TEXT_MAX - 600) {
        countEl.hidden = false;
        countEl.textContent = len + ' / ' + TEXT_MAX;
        countEl.classList.toggle('over', len > TEXT_MAX);
      } else {
        countEl.hidden = true;
      }
    }

    function autoGrow() {
      textarea.style.height = '40px';
      const hgt = Math.min(150, Math.max(40, textarea.scrollHeight));
      textarea.style.height = hgt + 'px';
      textarea.style.overflowY = textarea.scrollHeight > 150 ? 'auto' : 'hidden';
    }

    const draftKey = () => 'draft:' + (conv.id || 's' + conv.staff_id);
    const saveDraft = debounce(() => {
      if (!conv.id && !conv.staff_id) return;
      const v = textarea.value;
      if (v.trim()) storage.set(draftKey(), v.slice(0, TEXT_MAX));
      else storage.del(draftKey());
    }, 400);
    self.saveDraftNow = () => saveDraft.flush();

    function restoreDraft() {
      const d = storage.get(draftKey(), '');
      if (d && !textarea.value) {
        textarea.value = String(d).slice(0, TEXT_MAX);
        autoGrow();
      }
      updateSendState();
    }

    textarea.addEventListener('input', () => {
      autoGrow();
      updateSendState();
      saveDraft();
    });
    textarea.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
      if ((e.ctrlKey || e.metaKey) || (DESKTOP && !e.shiftKey && !e.altKey)) {
        e.preventDefault();
        sendText();
      }
    });
    textarea.addEventListener('focus', () => {
      if (!DESKTOP) composer.classList.add('kb');
      if (stick) setTimeout(() => scrollToBottom(false), 250);
    });
    textarea.addEventListener('blur', () => composer.classList.remove('kb'));
    sendBtn.addEventListener('mousedown', (e) => e.preventDefault());
    sendBtn.addEventListener('click', () => sendText());
    attachBtn.addEventListener('click', onAttach);

    /** Yangi xabarni navbatga qo'yish: pufak darhol ko'rinadi (🕒), yuborish navbat bo'yicha. */
    function enqueue(item) {
      item.convId = conv.id;
      item.created_at = new Date().toISOString();
      unreadBeforeId = null;
      outboxPush(item);
      render(true);
      scrollToBottom(false);
      haptic.impact('light');
    }

    function sendText() {
      if (!ready || readonly || destroyed || !conv.id) return;
      const text = textarea.value.trim();
      if (!text) return;
      if (text.length > TEXT_MAX) {
        toast('Xabar juda uzun: ' + TEXT_MAX + ' belgigacha yozing.', 'error');
        return;
      }
      // Tasodifiy ikki marta bosish (yoki Enter takrori) bir xil xabarni ikki marta yubormasin
      const now = Date.now();
      if (lastQueued && lastQueued.text === text && now - lastQueued.t < 300) return;
      lastQueued = { text: text, t: now };
      textarea.value = '';
      autoGrow();
      saveDraft.cancel();
      storage.del(draftKey());
      updateSendState();
      enqueue({ kind: 'text', text: text });
    }

    /** Navbatdagi xabar natijasi (outboxSend chaqiradi). */
    self.onOutbox = (type, p, extra) => {
      if (destroyed) return;
      if (type === 'sent') {
        onSent(p, extra);
      } else if (type === 'settled') {
        // Sync olgan xabarning yuborish so'rovi javobsiz tugadi — endi holatini sync ko'rsatadi (🕒 → ✓ yoki ❗)
        if (p.adoptedId && settling.delete(p.adoptedId)) rebuildMsg(p.adoptedId);
      } else if (type === 'failed') {
        if (extra && (extra.code === 'staff_unavailable' || extra.code === 'staff_inactive') && !readonly) {
          readonly = true;
          applyReadonly();
          updateSendState();
        }
        updatePending(p);
        render(false);
      } else {
        updatePending(p);
      }
    };

    function onSent(p, res) {
      const serverMsg = normMsg(res.message);
      // Sync bu xabarni javobdan oldin qaytargan bo'lishi mumkin — unda pufak joyida yangilanadi
      const existed = !!serverMsg && msgs.has(serverMsg.id);
      if (serverMsg) {
        settling.delete(serverMsg.id);
        if (p.previewUrl && !blobUrls.has(serverMsg.id)) blobUrls.set(serverMsg.id, p.previewUrl);
        // Kutilayotgan pufak o'rniga — animatsiyasiz (🕒 → ✓)
        quiet.add('m:' + serverMsg.id);
        // Xodim xabari saqlandi, lekin mijozga yetmadi (masalan, mijoz botni bloklagan) — darhol ❗
        if (S.role === 'staff' && res.delivered === false) warned.add(serverMsg.id);
      }
      const wasNear = distFromBottom() < 160;
      addMessages([res.message, res.auto_reply].filter(Boolean), false);
      if (existed) updateMessages([res.message]);
      render(true);
      if (wasNear) scrollToBottom(true);
    }

    async function onAttach() {
      if (!ready || readonly || destroyed) return;
      const file = await pickFile('');
      if (!file || destroyed || readonly) return;
      let prepared;
      try {
        prepared = await prepareChatFile(file);
      } catch (e) {
        toast(e.message || MSG.tooBig, 'error');
        haptic.notify('error');
        return;
      }
      if (destroyed) return;
      openAttachSheet(prepared);
    }

    function openAttachSheet(prepared) {
      let previewUrl = null;
      let w = 0;
      let hgt = 0;
      const previewBox = h('div');
      if (prepared.isImage) {
        previewUrl = URL.createObjectURL(prepared.blob);
        previewBox.className = 'attach-preview';
        previewBox.appendChild(
          makeImg(previewUrl, {
            alt: 'Tanlangan rasm',
            onload: (img) => {
              w = img.naturalWidth;
              hgt = img.naturalHeight;
            },
          }),
        );
      } else {
        previewBox.className = 'attach-file';
        previewBox.appendChild(fileChip('document', prepared.name, fmtSize(prepared.blob.size)));
      }
      const capField = makeField({ label: 'Izoh (ixtiyoriy)', max: CAPTION_MAX, multiline: true, rows: 2, placeholder: 'Rasm yoki faylga izoh…' });
      const initialCaption = textarea.value.trim();
      if (initialCaption && initialCaption.length <= CAPTION_MAX) capField.set(initialCaption);
      let sent = false;
      const sendB = h('button', { class: 'btn', type: 'button' }, [icon('send'), 'Yuborish']);
      const cancelB = h('button', { class: 'btn plain', type: 'button' }, 'Bekor qilish');
      const sheet = openSheet({
        title: prepared.isImage ? '🖼 Rasm yuborish' : '📎 Fayl yuborish',
        body: [
          previewBox,
          prepared.compressed
            ? h('div', { class: 'attach-note', text: "ℹ️ Rasm 4 MB dan katta edi — sifatini saqlagan holda siqildi (" + fmtSize(prepared.blob.size) + ')' })
            : null,
          capField.el,
          h('div', { class: 'sheet-actions' }, [cancelB, sendB]),
        ],
        onClose: () => {
          if (!sent && previewUrl) URL.revokeObjectURL(previewUrl);
        },
      });
      cancelB.addEventListener('click', () => sheet.close());
      sendB.addEventListener('click', () => {
        const caption = capField.get().trim();
        if (caption.length > CAPTION_MAX) {
          capField.setError('Izoh ' + CAPTION_MAX + ' belgidan oshmasligi kerak.');
          return;
        }
        if (destroyed || readonly || !conv.id) {
          sheet.close(null);
          return;
        }
        sent = true;
        if (caption && caption === initialCaption) {
          textarea.value = '';
          autoGrow();
          saveDraft.cancel();
          storage.del(draftKey());
          updateSendState();
        }
        sheet.close(true);
        enqueue({
          kind: 'file',
          blob: prepared.blob,
          fileName: prepared.name,
          size: prepared.blob.size,
          caption: caption,
          previewUrl: previewUrl,
          w: w,
          h: hgt,
        });
      });
    }

    self.onViewport = () => {
      if (stick) scrollToBottom(false);
    };

    self.onShow = () => {
      renderHeader();
    };

    /**
     * Chatdan chiqish. Navbatdagi xabarlar fonda yuborilishda davom etadi (chat qayta ochilsa pufaklari yana
     * ko'rinadi); ularning rasm oldindan ko'rinishlari navbatga tegishli, shuning uchun bo'shatilmaydi.
     * opts.discard — kirish huquqi yo'qolganda: qoralama saqlanmaydi, ro'yxat yangilanmaydi.
     */
    self.destroy = (opts) => {
      const discard = !!(opts && opts.discard);
      destroyed = true;
      if (discard) saveDraft.cancel();
      else saveDraft.flush();
      unsubs.forEach((u) => u());
      const owned = new Set();
      outbox.items.forEach((p) => {
        if (p.previewUrl) owned.add(p.previewUrl);
      });
      const urls = [];
      blobUrls.forEach((u) => {
        if (!owned.has(u)) urls.push(u);
      });
      urls.forEach(revokeLater);
      if (!discard && conv.id) {
        const listed = S.convs.find((c) => c.id === conv.id);
        if (listed && listed.unread) upsertConv(Object.assign({}, listed, { unread: 0 }));
      }
    };

    renderHeader();
    load();
    return self;
  }

  // ═══════════════════════════ Forma elementlari ═══════════════════════════

  function makeField(o) {
    const id = 'f' + Math.random().toString(36).slice(2, 9);
    const input = o.multiline
      ? h('textarea', { class: 'input', id: id, rows: String(o.rows || 3), placeholder: o.placeholder || '', autocomplete: 'off' })
      : h('input', {
          class: 'input',
          id: id,
          type: o.type || 'text',
          placeholder: o.placeholder || '',
          inputmode: o.inputmode || null,
          autocomplete: 'off',
          enterkeyhint: 'next',
        });
    const counter = o.max ? h('span', { class: 'counter', 'aria-hidden': 'true' }) : null;
    const errEl = h('div', { class: 'field-error', hidden: true, role: 'alert' });
    const el = h('div', { class: 'field' }, [
      h('label', { class: 'field-label', for: id }, [h('span', null, [o.label, o.required ? h('span', { class: 'req', text: ' *' }) : null]), counter]),
      input,
      o.hint ? h('div', { class: 'field-hint' }, o.hint) : null,
      errEl,
    ]);
    function updateCounter() {
      if (!counter) return;
      const len = input.value.length;
      counter.textContent = len + '/' + o.max;
      counter.classList.toggle('over', len > o.max);
    }
    input.addEventListener('input', () => {
      updateCounter();
      if (!errEl.hidden) setError('');
      if (o.onInput) o.onInput();
    });
    function setError(msg) {
      errEl.textContent = msg || '';
      errEl.hidden = !msg;
      input.classList.toggle('invalid', !!msg);
      if (msg) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }
    function set(v) {
      input.value = v == null ? '' : String(v);
      updateCounter();
    }
    updateCounter();
    return {
      el: el,
      input: input,
      get: () => input.value,
      set: set,
      setError: setError,
      focus: () => {
        try {
          input.focus({ preventScroll: true });
        } catch (e) {
          /* e'tiborsiz */
        }
        revealV(el, true);
      },
    };
  }

  /**
   * "Mijoz havolasi" maydoni: o'zgarmas prefiks (t.me/<mijoz_boti>?start=) + havola nomi. Kiritilgan matn
   * darhol kichik harfga o'giriladi; tekshiruv server bilan bir xil (LINK_CODE_RE).
   */
  function linkCodeField(o) {
    const id = 'f' + Math.random().toString(36).slice(2, 9);
    const input = h('input', {
      class: 'input',
      id: id,
      type: 'text',
      placeholder: o.placeholder || '',
      autocomplete: 'off',
      autocapitalize: 'none',
      autocorrect: 'off',
      spellcheck: 'false',
      enterkeyhint: 'done',
      'aria-describedby': id + '-hint',
    });
    const prefixText = h('span', { dir: 'ltr' });
    const prefixEl = h('span', { class: 'link-prefix', 'aria-hidden': 'true' }, prefixText);
    const box = h('div', { class: 'link-input' }, [prefixEl, input]);
    const hintEl = h('div', { class: 'field-hint', id: id + '-hint' });
    const errEl = h('div', { class: 'field-error', hidden: true, role: 'alert' });
    const el = h('div', { class: 'field' }, [
      h('label', { class: 'field-label', for: id }, h('span', null, o.label)),
      box,
      hintEl,
      errEl,
    ]);
    function setPrefix(bot) {
      prefixText.textContent = (bot ? 't.me/' + bot : '') + '?start=';
    }
    function setError(msg) {
      errEl.textContent = msg || '';
      errEl.hidden = !msg;
      box.classList.toggle('invalid', !!msg);
      if (msg) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }
    input.addEventListener('input', () => {
      // Katta harflar darhol kichikka (uzunlik o'zgarmaydi — kursor joyida qoladi)
      const v = input.value;
      const lower = v.toLowerCase();
      if (lower !== v && lower.length === v.length) {
        const a = input.selectionStart;
        const b = input.selectionEnd;
        input.value = lower;
        try {
          input.setSelectionRange(a, b);
        } catch (e) {
          /* e'tiborsiz */
        }
      }
      if (!errEl.hidden) setError('');
      if (o.onInput) o.onInput();
    });
    setPrefix(o.bot);
    return {
      el: el,
      input: input,
      get: () => normalizeLinkCode(input.value),
      set: (v) => {
        input.value = v == null ? '' : String(v);
      },
      setPrefix: setPrefix,
      setHint: (children) => {
        clear(hintEl);
        append(hintEl, children);
        hintEl.hidden = !hintEl.firstChild;
      },
      setPlaceholder: (v) => {
        input.placeholder = v || '';
      },
      setError: setError,
      focus: () => {
        try {
          input.focus({ preventScroll: true });
        } catch (e) {
          /* e'tiborsiz */
        }
        revealV(el, true);
      },
    };
  }

  function segmented(options, value, onChange) {
    let current = value;
    const btns = options.map((opt) =>
      h('button', { type: 'button', 'aria-pressed': opt.id === value ? 'true' : 'false', onclick: () => select(opt.id, true) }, opt.label),
    );
    const el = h('div', { class: 'seg', role: 'group' }, btns);
    function select(id, byUser) {
      if (id === current && byUser) return;
      current = id;
      options.forEach((opt, i) => btns[i].setAttribute('aria-pressed', opt.id === id ? 'true' : 'false'));
      if (byUser) {
        haptic.select();
        if (onChange) onChange(id);
      }
    }
    return { el: el, get: () => current, set: (id) => select(id, false) };
  }

  function switchRow(title, sub, checked, onChange) {
    const input = h('input', { type: 'checkbox', role: 'switch', checked: !!checked, 'aria-label': title });
    const el = h('label', { class: 'switch-row' }, [
      h('div', { class: 'switch-row-text' }, [h('div', { class: 'switch-row-title', text: title }), sub ? h('div', { class: 'switch-row-sub', text: sub }) : null]),
      h('span', { class: 'switch' }, [input, h('span', { class: 'track', 'aria-hidden': 'true' })]),
    ]);
    input.addEventListener('change', () => {
      haptic.select();
      if (onChange) onChange(input.checked);
    });
    return { el: el, input: input, get: () => input.checked, set: (v) => (input.checked = !!v) };
  }

  function placeholderHint(prefix, names) {
    const parts = [prefix + ' '];
    names.forEach((n, i) => {
      if (i) parts.push(', ');
      parts.push(h('code', { text: n[0] }));
      parts.push(' — ' + n[1]);
    });
    parts.push('.');
    return parts;
  }

  function screenBar(title, onBack) {
    return h('header', { class: 'bar' }, [
      h('button', { class: 'icon-btn back-btn', type: 'button', 'aria-label': 'Orqaga', onclick: onBack || (() => nav.pop()) }, icon('back')),
      h('h1', { class: 'bar-title', text: title }),
    ]);
  }

  // ═══════════════════════════ Xodim: asosiy ekran ═══════════════════════════

  function StaffRoot() {
    const me = S.me;
    const tabs = [];
    const canComplaints = S.panelRole === 'rop' || S.panelRole === 'developer';
    if (me) {
      tabs.push({ id: 'chats', emoji: '💬', label: 'Chatlar' });
      tabs.push({ id: 'profile', emoji: '👤', label: 'Profil' });
    }
    if (canComplaints) tabs.push({ id: 'complaints', emoji: '⚠️', label: 'Shikoyatlar' });
    if (S.isAdmin) tabs.push({ id: 'watch', emoji: '👁', label: 'Kuzatuv' });
    if (S.isAdmin) tabs.push({ id: 'admin', emoji: '⚙️', label: 'Admin' });

    const titleEl = h('h1', { class: 'topbar-title' });
    const subtitleEl = h('div', { class: 'topbar-sub' });
    const chip = me ? h('button', { class: 'status-chip', type: 'button', onclick: () => toggleOnline() }) : null;
    let adminPanel = null;
    let complaintsPanel = null;
    let watchPanel = null;
    const unsubs = [];

    const root = TabbedRoot({
      titleEl: titleEl,
      subtitleEl: subtitleEl,
      headerRight: chip,
      tabs: tabs,
      onTab: (id) => {
        if (id === 'admin' && adminPanel) adminPanel.ensureLoaded();
        if (id === 'complaints' && complaintsPanel) complaintsPanel.ensureLoaded();
        if (id === 'watch' && watchPanel) watchPanel.ensureLoaded();
      },
    });

    function renderHead() {
      if (S.me) {
        const n = firstWord(S.me.full_name);
        titleEl.textContent = n ? 'Salom, ' + n + ' 👋' : 'Salom 👋';
        subtitleEl.textContent = S.me.role_label + (S.me.position ? ' · ' + S.me.position : '');
        if (chip) {
          chip.classList.toggle('on', S.me.is_online);
          chip.textContent = S.me.is_online ? 'Onlayn' : 'Oflayn';
          chip.setAttribute('aria-pressed', S.me.is_online ? 'true' : 'false');
          chip.setAttribute('aria-label', 'Holat: ' + (S.me.is_online ? 'onlayn' : 'oflayn') + '. O\'zgartirish uchun bosing');
        }
      } else {
        titleEl.textContent = '⚙️ Admin panel';
        subtitleEl.textContent = 'Xodimlar va bot sozlamalari';
      }
    }

    // ── Chatlar ──
    if (me) {
      const panel = root.panel('chats');
      const searchInput = h('input', {
        type: 'search',
        placeholder: 'Ism, @username yoki xabar…',
        'aria-label': "Chatlarni mijoz ismi, @username yoki xabar bo'yicha qidirish",
        enterkeyhint: 'search',
        autocomplete: 'off',
      });
      const clearBtn = h('button', { class: 'icon-btn clear-btn', type: 'button', 'aria-label': 'Tozalash', hidden: true }, icon('close'));
      const search = h('label', { class: 'search' }, [icon('search'), searchInput, clearBtn]);
      // Qidiruv natijasidagi (ro'yxatda hali yo'q) eski suhbat ochilsa — u ro'yxatga ham qo'shiladi
      const openFromList = (c) => {
        if (!S.convs.some((x) => x.id === c.id)) addExtraConvs([c]);
        openStaffChat(c);
      };
      const list = ConvList({ onOpen: openFromList });
      const empty = emptyState('📭', "Hozircha chatlar yo'q", "Mijozlar sizga yozishi bilan shu yerda paydo bo'ladi. Bot chatida ham xabarlar keladi.");
      const noResults = emptyState('🔍', 'Hech narsa topilmadi', "Boshqa so'z bilan qidirib ko'ring.");
      const note = h('div', { class: 'list-note', hidden: true, 'aria-live': 'polite' });
      const moreBtn = h('button', { class: 'btn sm secondary', type: 'button' }, "⬇️ Ko'proq yuklash");
      const moreWrap = h('div', { class: 'list-more', hidden: true }, moreBtn);
      append(panel, [search, list.el, empty, noResults, note, moreWrap]);

      // Server qidiruvi: barcha suhbatlar bo'yicha (faqat yuklangan 100 tasi emas). Har bir so'rovga tartib
      // raqami beriladi — eskirgan javob (foydalanuvchi matnni o'zgartirib ulgurgan) e'tiborsiz qoldiriladi.
      let searchSeq = 0;
      let found = null; // { q, items, hasMore, nextOffset, done, failed }
      let loadingMore = false;

      const localMatch = (q) => (c) => (c.peer.name + ' ' + c.peer.subtitle + ' ' + c.last_message_preview).toLowerCase().indexOf(q) >= 0;

      const renderChats = () => {
        const raw = searchInput.value.trim();
        const q = raw.toLowerCase();
        const all = S.convs.filter((c) => c.last_message_at);
        let shown = all;
        let serverDone = false;
        if (q) {
          if (found && found.q === raw && found.done && !found.failed) {
            // Server natijalari; ro'yxatda bor suhbatlar uchun — yangiroq mahalliy ma'lumot (o'qilmaganlar, ko'rinish)
            const byId = new Map(S.convs.map((c) => [c.id, c]));
            shown = found.items.map((c) => byId.get(c.id) || c);
            serverDone = true;
          } else {
            // Server javobigacha — yuklangan suhbatlar ichidan darhol
            shown = all.filter(localMatch(q));
            serverDone = !!(found && found.q === raw && found.failed);
          }
        }
        list.update(shown);
        empty.hidden = all.length > 0 || S.total > 0;
        search.hidden = all.length === 0 && S.total === 0 && !q;
        // «Topilmadi» faqat server javob bergandan keyin (yuklanmagan eski suhbatlarda bo'lishi mumkin)
        noResults.hidden = !(q && serverDone && shown.length === 0);
        clearBtn.hidden = !q;
        let canMore;
        if (q) {
          canMore = serverDone && !!found && !found.failed && found.hasMore;
          const pending = !!found && found.q === raw && !found.done;
          note.hidden = !(pending || (serverDone && shown.length > 0));
          note.textContent = pending ? 'Barcha chatlar bo\'yicha qidirilmoqda…' : 'Topildi: ' + shown.length + (canMore ? '+' : '') + ' ta chat';
        } else {
          const total = Math.max(S.total, all.length);
          canMore = !S.convsExhausted && total > all.length;
          note.hidden = !(total > all.length);
          note.textContent = all.length + ' / ' + total + ' ta chat ko\'rsatilmoqda. Eski chatlarni yuklang yoki qidiring.';
        }
        moreWrap.hidden = !canMore;
        moreBtn.disabled = loadingMore;
        moreBtn.classList.toggle('loading', loadingMore);
        root.setBadge('chats', totalUnread());
      };

      const runSearch = async (more) => {
        const raw = searchInput.value.trim();
        if (!raw) {
          searchSeq++;
          found = null;
          renderChats();
          return;
        }
        const seq = ++searchSeq;
        const cont = !!more && !!found && found.q === raw && found.done && !found.failed;
        const offset = cont ? found.nextOffset : 0;
        if (!cont) found = { q: raw, items: [], hasMore: false, nextOffset: 0, done: false, failed: false };
        renderChats();
        try {
          const res = await api('conversations', { search: raw, offset: offset }, { timeout: 15000 });
          if (seq !== searchSeq) return;
          const items = arr(res.conversations).map(normConv).filter((c) => c.id);
          const prev = cont ? found.items : [];
          const seen = new Set(prev.map((c) => c.id));
          found = {
            q: raw,
            items: prev.concat(items.filter((c) => !seen.has(c.id))),
            hasMore: !!res.has_more,
            nextOffset: num(res.next_offset) || offset + items.length,
            done: true,
            failed: false,
          };
        } catch (e) {
          if (seq !== searchSeq) return;
          // Tarmoq/limit xatosi: yuklangan chatlar ichidagi natijalar qoladi
          if (cont) found.done = true;
          else found = { q: raw, items: [], hasMore: false, nextOffset: 0, done: true, failed: true };
          reportError(e);
        }
        renderChats();
      };
      const searchLater = debounce(() => runSearch(false), 300);

      const loadMore = async () => {
        if (loadingMore) return;
        loadingMore = true;
        renderChats();
        try {
          if (searchInput.value.trim()) {
            await runSearch(true);
          } else {
            const res = await api('conversations', { offset: S.convNextOffset }, { timeout: 15000 });
            const items = arr(res.conversations).map(normConv).filter((c) => c.id);
            S.convNextOffset = Math.max(S.convNextOffset, num(res.next_offset));
            if (!res.has_more) {
              S.convsExhausted = true;
              S.convNextOffset = Math.max(S.convNextOffset, S.total);
            }
            addExtraConvs(items);
          }
        } catch (e) {
          reportError(e);
        } finally {
          loadingMore = false;
          renderChats();
        }
      };

      searchInput.addEventListener('input', () => {
        renderChats();
        searchLater();
      });
      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          searchLater.flush();
        }
      });
      clearBtn.addEventListener('click', (e) => {
        e.preventDefault();
        searchInput.value = '';
        searchLater.cancel();
        searchSeq++;
        found = null;
        renderChats();
        searchInput.focus();
      });
      moreBtn.addEventListener('click', loadMore);
      unsubs.push(bus.on('convs', renderChats));
      unsubs.push(() => {
        searchLater.cancel();
        searchSeq++;
      });
      renderChats();

      // ── Profil ──
      const profilePanel = root.panel('profile');
      let profileSig = '';
      const renderProfile = () => {
        const m = S.me;
        if (!m) return;
        const chatCount = Math.max(S.total, S.convs.filter((c) => c.last_message_at).length);
        const sig = JSON.stringify([m, chatCount, S.isAdmin]);
        if (sig === profileSig) return;
        profileSig = sig;
        clear(profilePanel);
        const ava = avatar({ url: m.photo_url, name: m.full_name, seed: m.id, size: 96 });
        const sw = switchRow(m.is_online ? '🟢 Onlayn' : '⚪️ Oflayn', null, m.is_online, (v) => toggleOnline(v, sw));
        append(profilePanel, [
          h('div', { class: 'profile-card' }, [
            m.photo_url ? h('button', { class: 'ava-btn', type: 'button', style: 'margin:0 auto', 'aria-label': 'Rasmni ochish', onclick: () => openViewer(m.photo_url, { alt: m.full_name }) }, ava) : ava,
            h('h2', { class: 'profile-name', text: m.full_name }),
            h('div', { class: 'profile-meta' }, [
              h('span', { class: 'badge role-' + m.role, text: roleEmoji(m.role) + ' ' + m.role_label }),
              h('span', { class: 'badge ' + (m.is_online ? 'on' : 'off'), text: m.is_online ? 'Onlayn' : 'Oflayn' }),
            ]),
            m.position ? h('div', { class: 'profile-pos', text: m.position }) : null,
          ]),
          m.is_active === false ? h('div', { class: 'note-warn', role: 'status', text: '🚫 ' + MSG.staffInactive }) : null,
          h('div', { class: 'status-card' + (m.is_online ? ' on' : '') }, [
            h('div', { class: 'status-card-emoji', 'aria-hidden': 'true', text: m.is_online ? '🟢' : '🌙' }),
            h('div', { class: 'status-card-text' }, [
              h('div', { class: 'status-card-title', text: m.is_online ? 'Siz onlaynsiz' : 'Siz oflaynsiz' }),
              h('div', {
                class: 'status-card-sub',
                text: m.is_online ? 'Mijozlar sizni «Onlayn» deb ko\'radi.' : "Avto-javobga «hozir ish joyida emas» izohi qo'shiladi.",
              }),
            ]),
            h('span', { class: 'switch' }, [sw.input, h('span', { class: 'track', 'aria-hidden': 'true' })]),
          ]),
          h('div', { class: 'link-card' }, [
            h('div', { class: 'link-card-title', text: '🔗 Mijozlar uchun havolangiz' }),
            h('div', {
              class: 'link-card-sub',
              text: m.is_active
                ? 'Shu havolani mijozlaringizga bering — ular kirishi bilan siz bilan chat boshlanadi.'
                : '🚫 Profilingiz bloklangan — havola blokdan chiqarilgach ishlaydi.',
            }),
            m.client_link
              ? clientLinkBox(m.client_link, LINK_SHARE_TEXT)
              : h('div', { class: 'link-card-empty', text: "Havola hozircha tayyor emas. Admin bilan bog'laning." }),
          ]),
          h('div', { class: 'info-block' }, [
            h('div', { class: 'info-item' }, [h('div', { class: 'info-label', text: 'Tavsif' }), h('div', { class: 'info-value' + (m.description ? '' : ' muted'), text: m.description || "Kiritilmagan" })]),
            m.greeting !== undefined
              ? h('div', { class: 'info-item' }, [
                  h('div', { class: 'info-label', text: 'Avto-javob matni' }),
                  h('div', { class: 'info-value' + (m.greeting ? '' : ' muted'), text: m.greeting || 'Standart (umumiy) matn ishlatiladi' }),
                ])
              : null,
            h('div', { class: 'info-item' }, [h('div', { class: 'info-label', text: 'Chatlar soni' }), h('div', { class: 'info-value', text: fmtNum(chatCount) })]),
          ]),
          S.isAdmin
            ? h('div', { style: 'margin-top:12px' }, h('button', { class: 'btn block secondary', type: 'button', onclick: () => openStaffForm(m.id) }, '✏️ Profilni tahrirlash'))
            : null,
          h('p', { class: 'note', text: S.isAdmin ? 'ℹ️ Profil ma\'lumotlarini «Admin» bo\'limida ham tahrirlashingiz mumkin.' : "ℹ️ Ism, lavozim, tavsif va rasmni admin tahrirlaydi." }),
        ]);
      };
      unsubs.push(
        bus.on('me', () => {
          renderHead();
          renderProfile();
        }),
      );
      renderProfile();
    }

    // ── Shikoyatlar (ROP / developer) ──
    if (canComplaints) {
      complaintsPanel = ComplaintsPanel(root.panel('complaints'), root);
    }

    // ── Kuzatuv (admin / ROP / developer, faqat o'qish) ──
    if (S.isAdmin) {
      watchPanel = WatchPanel(root.panel('watch'));
    }

    // ── Admin ──
    if (S.isAdmin) {
      adminPanel = AdminPanel(root.panel('admin'));
    }

    let statusBusy = false;
    async function toggleOnline(value, sw) {
      if (!S.me || statusBusy) {
        if (sw) sw.set(S.me && S.me.is_online);
        return;
      }
      const next = typeof value === 'boolean' ? value : !S.me.is_online;
      statusBusy = true;
      const prev = S.me.is_online;
      S.me = Object.assign({}, S.me, { is_online: next });
      renderHead();
      haptic.impact('medium');
      try {
        const res = await api('status.set', { online: next });
        if (res.me) S.me = normStaffCard(Object.assign({}, S.me, res.me));
        toast(next ? '🟢 Siz endi onlaynsiz — mijozlar buni ko\'radi.' : '⚪️ Siz endi oflaynsiz.', 'success');
      } catch (e) {
        S.me = Object.assign({}, S.me, { is_online: prev });
        reportError(e);
      } finally {
        statusBusy = false;
        if (sw) sw.set(S.me.is_online);
        renderHead();
        bus.emit('me');
      }
    }

    renderHead();
    const saved = storage.get('tab', null);
    const ids = tabs.map((t) => t.id);
    let initial = saved && ids.indexOf(saved) >= 0 ? saved : ids[0];
    if (me && totalUnread() > 0) initial = 'chats';
    root.select(initial, false);

    return {
      type: 'root',
      el: root.el,
      onShow() {
        if (root.current() === 'admin' && adminPanel && A.dirty) adminPanel.refresh();
        if (root.current() === 'complaints' && complaintsPanel) complaintsPanel.ensureLoaded();
        if (root.current() === 'watch' && watchPanel) watchPanel.ensureLoaded();
        bus.emit('convs');
      },
      destroy() {
        unsubs.forEach((u) => u());
        if (adminPanel) adminPanel.destroy();
      },
    };
  }

  // ═══════════════════════════ Shikoyatlar (Mini App: ROP / developer) ═══════════════════════════

  function normComplaint(c) {
    c = c || {};
    return {
      id: num(c.id) || null,
      client_id: num(c.client_id) || null,
      staff_id: num(c.staff_id) || null,
      conversation_id: num(c.conversation_id) || null,
      text: str(c.text),
      status: c.status === 'resolved' ? 'resolved' : 'new',
      created_at: c.created_at || null,
      submitted_at: c.submitted_at || c.created_at || null,
      client_name: str(c.client_name) || 'Mijoz',
      client_username: str(c.client_username),
      staff_name: str(c.staff_name) || 'Xodim',
      staff_role: c.staff_role === 'manager' ? 'manager' : 'operator',
    };
  }

  function openReadonlyChat(conv, load, loadPage) {
    if (nav.locked()) return;
    nav.push(ChatScreen({ conv: conv, unread: 0, noSync: true, load: load, loadPage: loadPage }));
  }

  function ComplaintsPanel(container, root) {
    let filter = 'new';
    let items = [];
    let hasMore = false;
    let nextOffset = 0;
    let loading = false;
    let loaded = false;
    let loadError = null;

    const filterEl = h('div', { class: 'seg' }, [
      h('button', { type: 'button', 'data-f': 'new', 'aria-pressed': 'true' }, '🆕 Yangilar'),
      h('button', { type: 'button', 'data-f': 'all', 'aria-pressed': 'false' }, '📋 Hammasi'),
    ]);
    const listEl = h('div', { class: 'list' });
    const stateEl = h('div', { class: 'center-state', hidden: true });
    const moreWrap = h('div', { class: 'list-more', hidden: true }, h('button', { class: 'btn sm secondary', type: 'button', onclick: () => load(false) }, "⬇️ Ko'proq yuklash"));
    const refreshBtn = h('button', { class: 'icon-btn accent', type: 'button', 'aria-label': 'Yangilash', onclick: () => load(true) }, icon('refresh'));
    append(container, [
      h('div', { class: 'sec-title' }, [h('span', { text: '⚠️ Shikoyatlar — faqat oʻqish va hal qilish' }), refreshBtn]),
      filterEl,
      listEl,
      stateEl,
      moreWrap,
      h('p', { class: 'legend', text: '🔒 Oʻz ustingizdagi shikoyatlar roʻyxatda koʻrinmaydi — ularni rahbariyatning boshqa aʼzosi koʻrib chiqadi.' }),
    ]);

    filterEl.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => {
        if (filter !== b.dataset.f) {
          filter = b.dataset.f;
          haptic.select();
          load(true);
        }
      });
    });

    function render() {
      filterEl.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.f === filter ? 'true' : 'false'));
      clear(listEl);
      if (!items.length && loaded && !loading) {
        listEl.appendChild(h('div', { class: 'center-state', style: 'padding:22px 16px' }, [h('span', { text: filter === 'new' ? "Yangi shikoyatlar yo'q 🎉" : "Hozircha shikoyatlar yo'q 🎉" })]));
      }
      items.forEach((c) => {
        const icon = c.status === 'new' ? '🆕' : '✅';
        listEl.appendChild(
          h('button', { class: 'row', type: 'button', onclick: () => nav.push(ComplaintScreen(c.id)) }, [
            h('div', { class: 'row-main' }, [
              h('div', { class: 'row-top' }, [
                h('span', { class: 'row-name', text: '#' + c.id + ' ' + icon + ' ' + c.staff_name }),
                h('span', { class: 'row-time', text: listTime(c.submitted_at) }),
              ]),
              h('div', { class: 'row-sub', text: c.client_name + (c.client_username ? ' ( @' + c.client_username + ' )' : '') + ' · ' + clip(c.text, 80) }),
            ]),
            icon('chev', 'chev'),
          ]),
        );
      });
      moreWrap.hidden = !hasMore;
      clear(stateEl);
      if (loading && !items.length) {
        stateEl.hidden = false;
        stateEl.appendChild(spinner());
      } else if (loadError && !items.length) {
        stateEl.hidden = false;
        append(stateEl, [
          h('div', { text: loadError }),
          h('button', { class: 'btn sm secondary', type: 'button', onclick: () => load(true) }, '🔄 Qayta urinish'),
        ]);
      } else {
        stateEl.hidden = true;
      }
    }

    function applyListRes(res, reset) {
      const got = arr(res.complaints).map(normComplaint).filter((c) => c.id);
      items = reset ? got : items.concat(got.filter((c) => !items.some((x) => x.id === c.id)));
      hasMore = !!res.has_more;
      nextOffset = num(res.next_offset) || items.length;
      loaded = true;
      if (root && res.total_new !== undefined) root.setBadge('complaints', num(res.total_new));
    }

    async function load(reset) {
      if (loading) return;
      // Fondagi kesh (ilovа ochilganda isitilgan) — darhol chiziladi, kutish yo'q
      if (reset && filter === 'new') {
        const pre = takePrefetch('complaints');
        if (pre) {
          try {
            applyListRes(pre, true);
          } catch (e) {
            /* kesh yaroqsiz — serverdan yuklaymiz */
          }
          if (items.length) {
            render();
            return;
          }
        }
      }
      loading = true;
      loadError = null;
      refreshBtn.disabled = true;
      if (reset) {
        items = [];
        nextOffset = 0;
        hasMore = false;
      }
      render();
      try {
        const res = await api('complaints.list', { filter: filter, offset: reset ? 0 : nextOffset }, { timeout: 20000 });
        applyListRes(res, reset);
      } catch (e) {
        loadError = e.message || MSG.generic;
        if (items.length) reportError(e);
      } finally {
        loading = false;
        refreshBtn.disabled = false;
        render();
      }
    }

    return { ensureLoaded() { if (!loaded && !loading) load(true); }, refresh: () => load(true) };
  }

  function ComplaintScreen(id) {
    const self = { type: 'complaint' };
    const bodyEl = h('div', { class: 'screen-body' }, h('div', { class: 'center-state' }, spinner()));
    self.el = h('section', { class: 'form-screen' }, [screenBar('⚠️ Shikoyat #' + id), bodyEl]);
    let destroyed = false;

    async function load() {
      try {
        const res = await api('complaints.get', { id: id });
        if (destroyed) return;
        render(normComplaint(res.complaint));
      } catch (e) {
        if (destroyed) return;
        clear(bodyEl).appendChild(
          h('div', { class: 'center-state' }, [h('div', { text: e.message || MSG.generic }), h('button', { class: 'btn sm secondary', type: 'button', onclick: load }, '🔄 Qayta urinish')]),
        );
      }
    }

    function render(c) {
      clear(bodyEl);
      const statusBadge = h('span', { class: 'badge ' + (c.status === 'new' ? 'on' : 'off'), text: c.status === 'new' ? '🆕 Yangi' : '✅ Hal qilingan' });
      append(bodyEl, [
        h('div', { class: 'info-block' }, [
          h('div', { class: 'info-item' }, [h('div', { class: 'info-label', text: 'Holat' }), statusBadge]),
          h('div', { class: 'info-item' }, [h('div', { class: 'info-label', text: 'Xodim' }), h('div', { class: 'info-value', text: c.staff_name })]),
          h('div', { class: 'info-item' }, [h('div', { class: 'info-label', text: 'Mijoz' }), h('div', { class: 'info-value', text: c.client_name + (c.client_username ? ' (@' + c.client_username + ')' : '') })]),
          h('div', { class: 'info-item' }, [h('div', { class: 'info-label', text: 'Vaqti' }), h('div', { class: 'info-value', text: fullDate(c.submitted_at) })]),
          h('div', { class: 'info-item' }, [h('div', { class: 'info-label', text: 'Matn' }), h('div', { class: 'info-value', text: c.text || '—' })]),
        ]),
        h('div', { class: 'sheet-actions' }, [
          c.conversation_id ? h('button', { class: 'btn secondary', type: 'button', onclick: openTranscript }, "💬 Suhbatni ko'rish") : null,
          c.status === 'new' ? h('button', { class: 'btn', type: 'button', onclick: resolve }, '✅ Hal qilindi') : null,
        ]),
        h('p', { class: 'note', text: "🔒 Suhbat faqat oʻqish uchun ochiladi — yozib boʻlmaydi, oʻqilgan belgilari oʻzgarmaydi." }),
      ]);
    }

    async function openTranscript() {
      try {
        const first = await api('complaints.messages', { id: id, limit: 50 });
        if (destroyed) return;
        const conv = normConv(first.conversation);
        openReadonlyChat(
          conv,
          async () => ({ conversation: null, messages: first.messages, has_more: first.has_more, readonly: true, server_time: first.server_time }),
          async (beforeId, limit) => api('complaints.messages', { id: id, beforeId: beforeId, limit: limit || 50 }),
        );
      } catch (e) {
        reportError(e);
      }
    }

    async function resolve() {
      if (!(await confirmDialog('Shikoyat #' + id + ' hal qilindi deb belgilansinmi? Mijozga xabar boradi.'))) return;
      try {
        await api('complaints.resolve', { id: id });
        toast('✅ Hal qilindi', 'success');
        nav.pop();
      } catch (e) {
        reportError(e);
      }
    }

    load();
    self.destroy = () => { destroyed = true; };
    return self;
  }

  // ═══════════════════════════ Kuzatuv (Mini App: admin / ROP / developer) ═══════════════════════════

  function WatchPanel(container) {
    let staff = [];
    let loading = false;
    let loaded = false;
    let loadError = null;
    const listEl = h('div', { class: 'list' });
    const stateEl = h('div', { class: 'center-state', hidden: true });
    append(container, [
      h('div', { class: 'sec-title' }, h('span', { text: '👁 Chatlar kuzatuvi — faqat oʻqish' })),
      listEl,
      stateEl,
      h('p', { class: 'legend', text: "🔒 Sizga xabarlar kelmaydi — faqat kirib oʻqiysiz. Yozib boʻlmaydi." }),
    ]);

    function render() {
      clear(listEl);
      staff.forEach((s) => {
        const sub = (s.linked ? (s.is_active ? '🟢 Faol' : '🚫 Bloklangan') : '⏳ Ulanmagan');
        listEl.appendChild(
          h('button', { class: 'row', type: 'button', onclick: () => nav.push(WatchConvsScreen(s)) }, [
            h('div', { class: 'row-main' }, [
              h('div', { class: 'row-top' }, [h('span', { class: 'row-name', text: s.full_name })]),
              h('div', { class: 'row-sub', text: sub }),
            ]),
            icon('chev', 'chev'),
          ]),
        );
      });
      clear(stateEl);
      if (loading && !loaded) {
        stateEl.hidden = false;
        stateEl.appendChild(spinner());
      } else if (loadError && !loaded) {
        stateEl.hidden = false;
        append(stateEl, [
          h('div', { text: loadError }),
          h('button', { class: 'btn sm secondary', type: 'button', onclick: () => load() }, '🔄 Qayta urinish'),
        ]);
      } else {
        stateEl.hidden = true;
      }
      if (loaded && !staff.length && !loading) {
        listEl.appendChild(h('div', { class: 'center-state', style: 'padding:22px 16px' }, [h('span', { text: "Hozircha xodimlar yo'q" })]));
      }
    }

    function applyWatchStaff(res) {
      staff = arr(res.staff).map((s) => ({ id: num(s.id), full_name: str(s.full_name) || 'Xodim', role: s.role, is_active: s.is_active !== false, linked: !!s.linked })).filter((s) => s.id);
      loaded = true;
    }

    async function load() {
      if (loading) return;
      const pre = takePrefetch('watchStaff');
      if (pre) {
        try {
          applyWatchStaff(pre);
        } catch (e) {
          /* kesh yaroqsiz — serverdan yuklaymiz */
        }
        if (staff.length) {
          render();
          return;
        }
      }
      loading = true;
      loadError = null;
      render();
      try {
        const res = await api('watch.staff', {}, { timeout: 20000 });
        applyWatchStaff(res);
      } catch (e) {
        loadError = e.message || MSG.generic;
        if (loaded) reportError(e);
      } finally {
        loading = false;
        render();
      }
    }

    return { ensureLoaded() { if (!loaded && !loading) load(); }, refresh: () => load() };
  }

  function WatchConvsScreen(st) {
    const self = { type: 'watch-convs' };
    let items = [];
    let hasMore = false;
    let nextOffset = 0;
    let loading = false;
    let destroyed = false;
    const listEl = h('div', { class: 'list' });
    const stateEl = h('div', { class: 'center-state' }, spinner());
    const moreWrap = h('div', { class: 'list-more', hidden: true }, h('button', { class: 'btn sm secondary', type: 'button', onclick: () => load(false) }, "⬇️ Ko'proq yuklash"));
    const bodyEl = h('div', { class: 'screen-body' }, [listEl, stateEl, moreWrap]);
    self.el = h('section', { class: 'form-screen' }, [screenBar('👁 ' + st.full_name), bodyEl]);

    function render() {
      clear(listEl);
      items.forEach((c) => {
        const unread = c.unread > 0 ? '🔴' + c.unread + ' ' : '';
        listEl.appendChild(
          h('button', { class: 'row', type: 'button', onclick: () => openWatchChat(c) }, [
            h('div', { class: 'row-main' }, [
              h('div', { class: 'row-top' }, [
                h('span', { class: 'row-name', text: unread + c.peer.name }),
                h('span', { class: 'row-time', text: listTime(c.last_message_at) }),
              ]),
              h('div', { class: 'row-sub', text: c.last_message_preview || "Hali xabar yo'q" }),
            ]),
            icon('chev', 'chev'),
          ]),
        );
      });
      moreWrap.hidden = !hasMore;
      clear(stateEl);
      if (loading && !items.length) stateEl.appendChild(spinner());
      else if (!loading && !items.length) stateEl.appendChild(h('div', { text: "Bu xodimda hali suhbatlar yo'q" }));
      else stateEl.hidden = true;
    }

    async function load(reset) {
      if (loading || destroyed) return;
      loading = true;
      if (reset) {
        items = [];
        nextOffset = 0;
        hasMore = false;
      }
      render();
      try {
        const res = await api('watch.conversations', { staffId: st.id, offset: reset ? 0 : nextOffset });
        const got = arr(res.conversations).map(normConv).filter((c) => c.id);
        items = reset ? got : items.concat(got.filter((c) => !items.some((x) => x.id === c.id)));
        hasMore = !!res.has_more;
        nextOffset = num(res.next_offset) || items.length;
      } catch (e) {
        if (!items.length) {
          clear(stateEl).appendChild(h('div', { text: e.message || MSG.generic }));
        } else reportError(e);
      } finally {
        loading = false;
        if (!destroyed) render();
      }
    }

    async function openWatchChat(c) {
      try {
        const first = await api('watch.messages', { conversationId: c.id, limit: 50 });
        if (destroyed) return;
        const conv = normConv(first.conversation);
        openReadonlyChat(
          conv,
          async () => ({ conversation: null, messages: first.messages, has_more: first.has_more, readonly: true, server_time: first.server_time }),
          async (beforeId, limit) => api('watch.messages', { conversationId: c.id, beforeId: beforeId, limit: limit || 50 }),
        );
      } catch (e) {
        reportError(e);
      }
    }

    load(true);
    self.destroy = () => { destroyed = true; };
    return self;
  }

  function openStaffChat(conv) {
    if (nav.locked()) return;
    nav.push(
      ChatScreen({
        conv: conv,
        unread: conv.unread,
        load: async () => {
          const r = await api('messages', { conversationId: conv.id });
          return { conversation: null, messages: r.messages, has_more: r.has_more, server_time: r.server_time };
        },
      }),
    );
  }

  // ═══════════════════════════ Admin panel ═══════════════════════════

  function adminStaffFrom(res) {
    if (!res) return null;
    const s = res.staff && !Array.isArray(res.staff) ? res.staff : res.item || null;
    return s ? normAdminStaff(s) : null;
  }

  function upsertAdminStaff(s) {
    const i = A.staff.findIndex((x) => x.id === s.id);
    if (i >= 0) A.staff[i] = s;
    else A.staff.push(s);
    bus.emit('admin');
  }

  async function loadAdminStaff() {
    const res = await api('admin.staff.list');
    const list = Array.isArray(res.staff) ? res.staff : Array.isArray(res.items) ? res.items : Array.isArray(res.list) ? res.list : [];
    A.staff = list.map(normAdminStaff).filter((s) => s.id);
    if (typeof res.client_bot === 'string' && /^[A-Za-z0-9_]{3,64}$/.test(res.client_bot)) S.clientBot = res.client_bot;
    A.loaded = true;
    bus.emit('admin');
    return A.staff;
  }

  async function loadAdminStats() {
    const res = await api('admin.stats');
    A.stats = res.stats && typeof res.stats === 'object' ? res.stats : res;
    bus.emit('admin');
  }

  function AdminPanel(container) {
    let loading = false;
    let loadError = null;
    const statsEl = h('div', { class: 'stats' });
    // Rol sarlavhasi (🛠 Developer / 👑 ROP (rahbar) / ⚙️ Admin) va ROP/developer uchun shikoyatlar kartasi
    const roleEl = h('div', { class: 'role-line', role: 'note' });
    const complaintsEl = h('div', { class: 'complaints-wrap', hidden: true });
    const listWrap = h('div');
    const stateEl = h('div', { class: 'center-state', hidden: true });
    const refreshBtn = h('button', { class: 'icon-btn accent', type: 'button', 'aria-label': 'Yangilash', onclick: () => refresh(true) }, icon('refresh'));

    append(container, [
      roleEl,
      h('div', { class: 'sec-title' }, [h('span', { text: '📊 Statistika' }), refreshBtn]),
      statsEl,
      complaintsEl,
      h('div', { class: 'admin-actions' }, [
        h('button', { class: 'btn', type: 'button', onclick: () => openStaffForm(null) }, [icon('plus'), 'Yangi xodim']),
        h('button', { class: 'btn secondary', type: 'button', onclick: () => nav.push(SettingsScreen()) }, '📝 Bot matnlari'),
      ]),
      stateEl,
      listWrap,
    ]);

    function statCard(emoji, label, value, sub, subMuted) {
      return h('div', { class: 'stat' }, [
        h('div', { class: 'stat-top' }, [h('span', { 'aria-hidden': 'true', text: emoji }), h('span', { text: label })]),
        h('div', { class: 'stat-num', text: value }),
        sub ? h('div', { class: 'stat-sub' + (subMuted ? ' muted' : ''), text: sub }) : null,
      ]);
    }

    let statsSig = null;
    let listSig = null;

    function renderRole() {
      clear(roleEl);
      const role = S.panelRole;
      roleEl.hidden = !role;
      if (!role) return;
      append(roleEl, [
        h('span', { class: 'role-chip role-' + role, text: S.panelRoleTitle || PANEL_ROLE_TITLES[role] }),
        h('span', { class: 'role-line-sub', text: PANEL_ROLE_HINTS[role] || '' }),
      ]);
    }

    /** ROP va developer: yangi shikoyatlar soni (server can(role, 'complaints') bo'lsa complaints_new qaytaradi). */
    function renderComplaints(s) {
      clear(complaintsEl);
      const role = S.panelRole;
      const show = (role === 'rop' || role === 'developer') && !!s && s.complaints_new !== undefined && s.complaints_new !== null;
      complaintsEl.hidden = !show;
      if (!show) return;
      const n = num(s.complaints_new);
      append(complaintsEl, [
        h('div', { class: 'stat stat-wide' + (n > 0 ? ' warn' : '') }, [
          h('div', { class: 'stat-wide-main' }, [
            h('span', { class: 'stat-wide-label', text: '⚠️ Yangi shikoyatlar: ' }),
            h('span', { class: 'stat-wide-num', text: fmtNum(n) }),
          ]),
          s.complaints_total !== undefined && s.complaints_total !== null
            ? h('div', { class: 'stat-sub muted', text: 'Jami: ' + fmtNum(s.complaints_total) })
            : null,
        ]),
        h('p', { class: 'note complaints-hint', text: COMPLAINTS_HINT[role] || COMPLAINTS_HINT.rop }),
        inTelegram
          ? h('div', { class: 'complaints-actions' }, h('button', { class: 'btn sm secondary', type: 'button', onclick: closeApp }, '↩️ Botga qaytish'))
          : null,
      ]);
    }

    function renderStats() {
      const sig = JSON.stringify([A.stats || null, S.panelRole]);
      if (sig === statsSig) return;
      statsSig = sig;
      clear(statsEl);
      const s = A.stats;
      renderComplaints(s);
      if (!s) {
        for (let i = 0; i < 4; i++) statsEl.appendChild(statCard('·', '…', '—'));
        return;
      }
      append(statsEl, [
        statCard('👥', 'Mijozlar', fmtNum(s.clients), '+' + fmtNum(s.clients_today) + ' bugun', !num(s.clients_today)),
        statCard('💬', 'Suhbatlar', fmtNum(s.conversations), null),
        statCard('✉️', 'Xabarlar', fmtNum(s.messages), '+' + fmtNum(s.messages_today) + ' bugun', !num(s.messages_today)),
        statCard('🧑‍💼', 'Xodimlar', fmtNum(s.staff_total), fmtNum(s.staff_linked) + ' tasi ulangan', true),
      ]);
    }

    function staffRow(s) {
      const status = s.linked ? (s.is_active ? '🟢 Faol' : '🚫 Bloklangan') : '⏳ Ulanmagan' + (s.is_active ? '' : ' · bloklangan');
      const blocked = s.linked && s.bot_blocked ? " · ⚠️ botni to'xtatgan" : '';
      const sub = status + blocked + (s.position ? ' · ' + s.position : '') + (s.link_code ? ' · 🔗 ' + s.link_code : '');
      return h('button', { class: 'row', type: 'button', onclick: () => openStaffForm(s.id) }, [
        avatar({ url: s.photo_url, name: s.full_name, seed: s.id, size: 48, online: s.linked && s.is_active ? s.is_online : null, lazy: true }),
        h('div', { class: 'row-main' }, [
          h('div', { class: 'row-top' }, [h('span', { class: 'row-name', text: s.full_name })]),
          h('div', { class: 'row-sub', text: sub }),
        ]),
        icon('chev', 'chev'),
      ]);
    }

    function renderList() {
      const sig = A.loaded ? JSON.stringify(A.staff) : '';
      if (sig === listSig) return;
      listSig = sig;
      clear(listWrap);
      if (!A.loaded) return;
      const groups = [
        { role: 'operator', title: '👨‍💻 Operatorlar' },
        { role: 'manager', title: '👔 Menejerlar' },
      ];
      groups.forEach((g) => {
        const items = A.staff.filter((s) => s.role === g.role);
        listWrap.appendChild(h('div', { class: 'sec-title' }, h('span', { text: g.title + ' · ' + items.length })));
        if (!items.length) {
          listWrap.appendChild(
            h('div', { class: 'list' }, h('div', { class: 'center-state', style: 'padding:22px 16px' }, [h('span', { text: "Hali hech kim qo'shilmagan" })])),
          );
          return;
        }
        listWrap.appendChild(h('div', { class: 'list' }, items.map(staffRow)));
      });
      listWrap.appendChild(h('p', { class: 'legend', text: '🟢 faol · 🚫 bloklangan · ⏳ akkaunt ulanmagan (taklif havolasini yuboring)' }));
      if (A.staff.some((s) => s.linked && s.bot_blocked)) {
        listWrap.appendChild(
          h('p', { class: 'legend', text: "⚠️ botni to'xtatgan — xodim xodimlar botini bloklagan: mijozlar xabarlari unga yetib bormayapti (u /start bosishi bilan yetkaziladi)." }),
        );
      }
    }

    function renderState() {
      clear(stateEl);
      if (loading && !A.loaded) {
        stateEl.hidden = false;
        stateEl.appendChild(spinner());
      } else if (loadError && !A.loaded) {
        stateEl.hidden = false;
        append(stateEl, [
          h('div', { text: loadError }),
          h('button', { class: 'btn sm secondary', type: 'button', onclick: () => refresh(true) }, "🔄 Qayta urinish"),
        ]);
      } else {
        stateEl.hidden = true;
      }
    }

    async function refresh(manual) {
      if (loading) return;
      loading = true;
      loadError = null;
      refreshBtn.disabled = true;
      renderState();
      let failed = null;
      await Promise.all([loadAdminStats().catch((e) => (failed = failed || e)), loadAdminStaff().catch((e) => (failed = failed || e))]);
      loading = false;
      refreshBtn.disabled = false;
      if (failed) {
        loadError = failed.message || MSG.generic;
        if (manual || A.loaded) reportError(failed);
      } else {
        A.dirty = false;
        if (manual) toast('Yangilandi', 'success', 1500);
      }
      renderState();
      renderStats();
      renderList();
    }

    const unsub = bus.on('admin', () => {
      renderStats();
      renderList();
    });
    renderRole();
    renderStats();

    return {
      ensureLoaded() {
        if ((!A.loaded || A.dirty) && !loading) refresh(false);
      },
      refresh: () => refresh(false),
      destroy: unsub,
    };
  }

  function openStaffForm(id) {
    if (nav.locked()) return;
    if (id != null && !A.staff.find((s) => s.id === id)) {
      loadAdminStaff()
        .then(() => {
          if (A.staff.find((s) => s.id === id)) nav.push(StaffFormScreen(id));
          else toast('Xodim topilmadi', 'error');
        })
        .catch(reportError);
      return;
    }
    nav.push(StaffFormScreen(id));
  }

  const LIMITS = { full_name: [2, 64], position: [0, 100], description: [0, 700], greeting: [0, 1000] };

  function StaffFormScreen(staffId, flags) {
    flags = flags || {};
    const isNew = staffId == null;
    let cur = isNew ? null : A.staff.find((s) => s.id === staffId) || null;
    const self = { type: 'form' };
    let saving = false;
    let photoBusy = false;
    let newPhoto = null; // yangi xodim uchun: {blob, name, url}
    let destroyed = false;

    const saveBtn = h('button', { class: 'btn', type: 'button' }, isNew ? "➕ Xodimni qo'shish" : '💾 Saqlash');
    const bodyEl = h('div', { class: 'screen-body with-actions' });
    self.el = h('section', { class: 'form-screen' }, [
      screenBar(isNew ? 'Yangi xodim' : 'Xodimni tahrirlash'),
      bodyEl,
      h('div', { class: 'form-actions' }, saveBtn),
    ]);

    const roleSeg = segmented(
      [
        { id: 'operator', label: '👨‍💻 Operator' },
        { id: 'manager', label: '👔 Menejer' },
      ],
      cur ? cur.role : 'operator',
      () => updateDirty(),
    );
    const fName = makeField({ label: 'Ism familiya', required: true, max: 64, placeholder: 'Masalan: Aziz Karimov', onInput: () => updateDirty() });
    const fPos = makeField({ label: 'Lavozim', max: 100, placeholder: 'Masalan: Katta operator', onInput: () => updateDirty() });
    const fDesc = makeField({
      label: 'Tavsif',
      max: 700,
      multiline: true,
      rows: 4,
      placeholder: "Mijozlar ko'radigan qisqa ma'lumot: qaysi masalalarda yordam beradi, ish vaqti va h.k.",
      onInput: () => updateDirty(),
    });
    const fGreet = makeField({
      label: 'Avto-javob matni',
      max: 1000,
      multiline: true,
      rows: 4,
      placeholder: "Bo'sh qoldirilsa — umumiy standart matn ishlatiladi",
      hint: placeholderHint('Mijoz shu xodimga birinchi marta yozganda yuboriladi.', [
        ['{name}', 'mijoz ismi'],
        ['{staff}', 'xodim ismi'],
      ]),
      onInput: () => updateDirty(),
    });
    const fSort = makeField({ label: 'Tartib raqami', type: 'number', inputmode: 'numeric', placeholder: '0', hint: "Kichik raqamli xodim ro'yxatda yuqoriroq turadi.", onInput: () => updateDirty() });
    // Bloklash / blokdan chiqarish (is_active) — tasdiqdan keyin darhol saqlanadi, formadagi boshqa o'zgarishlarga tegmaydi
    const blockWrap = h('div', { class: 'switch-row block-row' });
    let blockBusy = false;
    const fLink = linkCodeField({
      label: 'Havola nomi',
      bot: clientBotName(cur && cur.client_link),
      onInput: () => {
        updateDirty();
        renderClientLink();
      },
    });

    if (cur) {
      fName.set(cur.full_name);
      fPos.set(cur.position);
      fDesc.set(cur.description);
      fGreet.set(cur.greeting || '');
      fSort.set(String(cur.sort_order));
      fLink.set(cur.link_code || '');
    }

    function snapshot() {
      return JSON.stringify([
        roleSeg.get(),
        fName.get().trim(),
        fPos.get().trim(),
        fDesc.get().trim(),
        fGreet.get().trim(),
        isNew ? '' : fSort.get().trim(),
        fLink.get(),
      ]);
    }
    let baseline = snapshot();
    function isDirty() {
      return snapshot() !== baseline || (isNew && !!newPhoto);
    }
    function updateDirty() {
      if (!isNew) saveBtn.disabled = saving || !isDirty();
    }

    // ── Rasm bo'limi ──
    const photoWrap = h('div', { class: 'photo-wrap' });
    const photoActions = h('div', { class: 'photo-actions' });
    const photoSec = h('div', { class: 'form-sec' }, h('div', { class: 'photo-edit' }, [photoWrap, photoActions]));

    function renderPhoto(progress) {
      clear(photoWrap);
      const url = isNew ? (newPhoto ? newPhoto.url : null) : cur.photo_url;
      const name = fName.get().trim() || (cur ? cur.full_name : '') || '?';
      photoWrap.appendChild(avatar({ url: url, name: name, seed: cur ? cur.id : name, size: 104 }));
      if (photoBusy) {
        photoWrap.appendChild(h('div', { class: 'photo-busy' }, progress != null && progress < 1 ? Math.round(progress * 100) + '%' : spinner('light')));
      }
      clear(photoActions);
      const hasPhoto = !!url;
      photoActions.appendChild(
        h('button', { class: 'btn sm secondary', type: 'button', disabled: photoBusy, onclick: onPickPhoto }, [icon('camera'), hasPhoto ? 'Rasmni almashtirish' : 'Rasm yuklash']),
      );
      if (hasPhoto) {
        photoActions.appendChild(h('button', { class: 'btn sm danger', type: 'button', disabled: photoBusy, onclick: onRemovePhoto }, "O'chirish"));
      }
    }

    async function onPickPhoto() {
      if (photoBusy) return;
      const file = await pickFile('image/*');
      if (!file || destroyed) return;
      let prepared;
      try {
        prepared = await prepareStaffPhoto(file);
      } catch (e) {
        toast(e.message, 'error');
        return;
      }
      if (prepared.blob.size > MAX_UPLOAD) {
        toast(MSG.tooBig, 'error');
        return;
      }
      if (isNew) {
        if (newPhoto && newPhoto.url) URL.revokeObjectURL(newPhoto.url);
        newPhoto = { blob: prepared.blob, name: prepared.name, url: URL.createObjectURL(prepared.blob) };
        renderPhoto();
        return;
      }
      photoBusy = true;
      renderPhoto(0);
      try {
        const res = await apiUpload('admin.staff.photo', { id: cur.id }, prepared.blob, prepared.name, (f) => {
          if (!destroyed) renderPhoto(f);
        });
        await applyStaffResult(res);
        toast('🖼 Rasm yangilandi', 'success');
        haptic.notify('success');
      } catch (e) {
        reportError(e);
      } finally {
        photoBusy = false;
        if (!destroyed) renderPhoto();
      }
    }

    async function onRemovePhoto() {
      if (isNew) {
        if (newPhoto && newPhoto.url) URL.revokeObjectURL(newPhoto.url);
        newPhoto = null;
        renderPhoto();
        return;
      }
      const ok = await confirmDialog("Xodim rasmi o'chirilsinmi?", { ok: "O'chirish", destructive: true });
      if (!ok || destroyed) return;
      photoBusy = true;
      renderPhoto();
      try {
        const res = await api('admin.staff.photo.remove', { id: cur.id });
        await applyStaffResult(res);
        toast("Rasm o'chirildi", 'success');
      } catch (e) {
        reportError(e);
      } finally {
        photoBusy = false;
        if (!destroyed) renderPhoto();
      }
    }

    /** Admin amali javobidan xodimni yangilash (javobda bo'lmasa — ro'yxatni qayta yuklash). */
    async function applyStaffResult(res) {
      let s = adminStaffFrom(res);
      if (!s) {
        await loadAdminStaff();
        s = A.staff.find((x) => x.id === cur.id) || null;
      } else {
        upsertAdminStaff(s);
      }
      A.dirty = true;
      if (s && !destroyed) {
        cur = s;
        renderAccount();
        renderClientLink();
        renderBlock();
      }
      if (S.me && cur && S.me.id === cur.id) refreshMe();
      return s;
    }

    // ── Mijoz havolasi (xodimning shaxsiy qisqa havolasi) ──
    const clientLinkWrap = h('div');
    const clientLinkSec = h('div', { class: 'form-sec' }, [fLink.el, clientLinkWrap]);

    function renderClientLink() {
      if (destroyed) return;
      const saved = cur ? cur.link_code || '' : '';
      const code = fLink.get();
      const bot = clientBotName(cur && cur.client_link);
      fLink.setPrefix(bot);
      const hint = [];
      if (isNew) {
        const suggestion = linkCodeSuggestion(fName.get());
        fLink.setPlaceholder(suggestion);
        hint.push("Bo'sh qoldirilsa — ismdan avtomatik yaratiladi (masalan: ");
        hint.push(h('code', { text: suggestion }));
        hint.push('). ');
      } else {
        fLink.setPlaceholder(saved || 'aziza');
      }
      hint.push("2–32 ta lotin harfi, raqam yoki _. Mijoz shu havola orqali botga kirsa, hech narsa tanlamasdan shu xodim bilan chat boshlanadi.");
      if (!isNew && code && code !== saved && !linkCodeError(code) && bot) {
        hint.push(' Saqlangandan keyin: ');
        hint.push(h('code', { text: 't.me/' + bot + '?start=' + code }));
      }
      fLink.setHint(hint);

      clear(clientLinkWrap);
      if (isNew || !cur) return;
      const link = safeClientLink(cur.client_link);
      const notes = [];
      if (!cur.linked) notes.push('⏳ Havola xodim akkaunti ulangandan keyin ishlaydi.');
      else if (!cur.is_active) notes.push('🚫 Xodim bloklangan — havola hozir ishlamaydi.');
      append(clientLinkWrap, [
        link
          ? clientLinkBox(link, LINK_SHARE_TEXT)
          : h('div', { class: 'field-hint', style: 'padding-bottom:14px', text: "Bot username aniqlanmadi — «npm run setup» ni qayta ishga tushiring." }),
        notes.length ? h('div', { class: 'field-hint client-link-note', text: notes.join(' ') }) : null,
      ]);
    }

    // ── Akkaunt (taklif havolasi) bo'limi ──
    const accountSec = h('div', { class: 'form-sec' });

    function renderAccount() {
      clear(accountSec);
      if (isNew || !cur) return;
      if (cur.linked) {
        const who = cur.tg_username ? '@' + cur.tg_username : 'ID ' + (cur.tg_user_id || '—');
        append(accountSec, [
          h('div', { class: 'linked-info' }, [
            h('div', { class: 'status-card-emoji', 'aria-hidden': 'true', text: '✅' }),
            h('div', { class: 'linked-info-text' }, [
              h('div', { class: 'linked-title', text: 'Ulangan: ' + who }),
              h('div', {
                class: 'linked-sub',
                text: (cur.tg_username && cur.tg_user_id ? 'ID ' + cur.tg_user_id + ' · ' : '') + (cur.is_online ? '🟢 onlayn' : '⚪️ oflayn'),
              }),
            ]),
          ]),
          h('div', { style: 'padding-bottom:14px' }, h('button', { class: 'btn block danger sm', type: 'button', onclick: onUnlink }, '🔌 Akkauntni uzish')),
        ]);
        return;
      }
      const link = cur.invite_link || '';
      const httpsLink = /^https:\/\//.test(link);
      append(accountSec, [
        h('div', { class: 'linked-info' }, [
          h('div', { class: 'status-card-emoji', 'aria-hidden': 'true', text: '⏳' }),
          h('div', { class: 'linked-info-text' }, [
            h('div', { class: 'linked-title', text: 'Akkaunt hali ulanmagan' }),
            h('div', { class: 'linked-sub', text: 'Havolani xodimga yuboring — u xodimlar botiga kirib, profilga ulanadi.' }),
          ]),
        ]),
        link
          ? h('div', { class: 'invite-box' }, [
              h('button', { class: 'invite-link', type: 'button', 'aria-label': 'Taklif havolasini nusxalash', onclick: () => doCopy(link), text: link }),
              h('div', { class: 'invite-actions' }, [
                h('button', { class: 'btn sm secondary', type: 'button', onclick: () => doCopy(link) }, [icon('copy'), 'Nusxalash']),
                h('button', { class: 'btn sm', type: 'button', disabled: !httpsLink, onclick: () => shareInvite(link) }, [icon('share'), 'Ulashish']),
                h('button', { class: 'btn sm plain wide', type: 'button', onclick: onRegenerate }, [icon('refresh'), 'Yangi havola yaratish']),
              ]),
              httpsLink ? null : h('div', { class: 'field-hint', text: "Bot username aniqlanmadi — «npm run setup» ni qayta ishga tushiring." }),
            ])
          : h('div', { style: 'padding-bottom:14px' }, h('button', { class: 'btn block secondary sm', type: 'button', onclick: onRegenerate }, [icon('refresh'), 'Taklif havolasini yaratish'])),
      ]);
    }

    async function doCopy(link) {
      const ok = await copyText(link);
      if (ok) {
        toast('Havola nusxalandi 📋', 'success', 2000);
        haptic.notify('success');
      } else {
        toast("Nusxalab bo'lmadi — havolani bosib turib, qo'lda nusxalang.", 'error');
      }
    }

    function shareInvite(link) {
      const name = cur ? cur.full_name : '';
      const text = 'Assalomu alaykum! Siz uchun «' + name + '» xodim profili tayyorlandi. Quyidagi havola orqali xodimlar botiga kiring 👇';
      const url = 'https://t.me/share/url?url=' + encodeURIComponent(link) + '&text=' + encodeURIComponent(text);
      openLink(url);
    }

    async function onRegenerate() {
      if (cur.invite_link) {
        const ok = await confirmDialog('Eski havola ishlamay qoladi. Yangi taklif havolasi yaratilsinmi?', { ok: 'Yaratish' });
        if (!ok || destroyed) return;
      }
      try {
        const res = await api('admin.staff.invite', { id: cur.id });
        if (res && typeof res.invite_link === 'string' && !adminStaffFrom(res)) {
          cur = Object.assign({}, cur, { invite_link: res.invite_link });
          upsertAdminStaff(cur);
          renderAccount();
        } else {
          await applyStaffResult(res);
        }
        toast('🔗 Yangi havola yaratildi', 'success');
      } catch (e) {
        reportError(e);
      }
    }

    async function onUnlink() {
      const ok = await confirmDialog(
        'Telegram akkaunt profildan uziladi va yangi taklif havolasi yaratiladi. Xodim boshqa mijoz xabarlarini olmaydi. Davom etasizmi?',
        { ok: 'Uzish', destructive: true },
      );
      if (!ok || destroyed) return;
      try {
        const res = await api('admin.staff.unlink', { id: cur.id });
        await applyStaffResult(res);
        toast('🔌 Akkaunt uzildi', 'success');
      } catch (e) {
        reportError(e);
      }
    }

    function renderBlock() {
      if (destroyed) return;
      clear(blockWrap);
      if (isNew || !cur) return;
      const blocked = !cur.is_active;
      const btn = h(
        'button',
        { class: 'btn sm ' + (blocked ? 'secondary' : 'danger') + (blockBusy ? ' loading' : ''), type: 'button', disabled: blockBusy, onclick: onToggleBlock },
        blocked ? '✅ Blokdan chiqarish' : '🚫 Bloklash',
      );
      append(blockWrap, [
        h('div', { class: 'switch-row-text' }, [
          h('div', { class: 'switch-row-title', text: blocked ? '🚫 Bloklangan' : '🟢 Faol' }),
          h('div', {
            class: 'switch-row-sub',
            text: blocked
              ? "Mijozlar xodimni menyuda ko'rmaydi va unga yoza olmaydi, u ham mijozlarga yoza olmaydi."
              : "Bloklangan xodim mijozlarga ko'rinmaydi va unga yozib bo'lmaydi.",
          }),
        ]),
        btn,
      ]);
    }

    async function onToggleBlock() {
      if (blockBusy || destroyed || !cur) return;
      const block = !!cur.is_active;
      const ok = await confirmDialog(
        block
          ? '«' + cur.full_name + "» bloklansinmi? Mijozlar uni ko'rmaydi va unga yoza olmaydi, u ham mijozlarga yoza olmaydi. Suhbatlar tarixi saqlanadi."
          : '«' + cur.full_name + "» blokdan chiqarilsinmi? Mijozlar uni yana menyuda ko'radi.",
        block ? { ok: 'Bloklash', destructive: true, title: 'Xodimni bloklash' } : { ok: 'Blokdan chiqarish', title: 'Blokdan chiqarish' },
      );
      if (!ok || destroyed || !cur || blockBusy) return;
      blockBusy = true;
      renderBlock();
      try {
        const res = await api('admin.staff.update', { id: cur.id, patch: { is_active: !block } });
        await applyStaffResult(res);
        toast(block ? '🚫 Xodim bloklandi' : '✅ Xodim blokdan chiqarildi', 'success');
        haptic.notify('success');
      } catch (e) {
        reportError(e);
      } finally {
        blockBusy = false;
        renderBlock();
      }
    }

    async function onDelete() {
      const ok = await confirmDialog('«' + cur.full_name + "» o'chirilsinmi? Suhbatlar tarixi saqlanadi, lekin xodim mijozlarga ko'rinmaydi.", {
        ok: "O'chirish",
        destructive: true,
        title: "Xodimni o'chirish",
      });
      if (!ok || destroyed) return;
      try {
        await api('admin.staff.delete', { id: cur.id });
        A.staff = A.staff.filter((s) => s.id !== cur.id);
        A.dirty = true;
        bus.emit('admin');
        toast("🗑 Xodim o'chirildi", 'success');
        haptic.notify('success');
        if (S.me && S.me.id === cur.id) refreshMe();
        baseline = snapshot();
        nav.pop({ force: true });
      } catch (e) {
        reportError(e);
      }
    }

    // ── Saqlash ──
    function validate() {
      let firstBad = null;
      const checks = [
        [fName, 'full_name', 'Ism'],
        [fPos, 'position', 'Lavozim'],
        [fDesc, 'description', 'Tavsif'],
        [fGreet, 'greeting', 'Avto-javob'],
      ];
      checks.forEach((c) => {
        const v = c[0].get().trim();
        const lim = LIMITS[c[1]];
        let err = '';
        if (c[1] === 'full_name' && v.length < lim[0]) err = 'Ism kamida ' + lim[0] + ' ta belgidan iborat bo\'lsin.';
        else if (v.length > lim[1]) err = c[2] + ' ' + lim[1] + ' belgidan oshmasligi kerak.';
        c[0].setError(err);
        if (err && !firstBad) firstBad = c[0];
      });
      if (!isNew) {
        const sv = fSort.get().trim();
        if (sv && !/^-?\d{1,6}$/.test(sv)) {
          fSort.setError('Butun son kiriting.');
          if (!firstBad) firstBad = fSort;
        } else fSort.setError('');
      }
      // Havola nomi: yangi xodimda ixtiyoriy; mavjud xodimda faqat o'zgartirilgan bo'lsa tekshiriladi
      const code = fLink.get();
      const linkChanged = isNew ? !!code : code !== ((cur && cur.link_code) || '');
      const linkErr = linkChanged ? linkCodeError(code) : '';
      fLink.setError(linkErr);
      if (linkErr && !firstBad) firstBad = fLink;
      if (firstBad) {
        firstBad.focus();
        haptic.notify('error');
        return false;
      }
      return true;
    }

    async function save() {
      if (saving || photoBusy) return;
      if (!validate()) return;
      const values = {
        role: roleSeg.get(),
        full_name: fName.get().trim(),
        position: fPos.get().trim(),
        description: fDesc.get().trim(),
        greeting: fGreet.get().trim() || null,
      };
      const linkCode = fLink.get();
      saving = true;
      saveBtn.classList.add('loading');
      saveBtn.disabled = true;
      try {
        if (isNew) {
          const res = await api('admin.staff.create', linkCode ? Object.assign({ link_code: linkCode }, values) : values);
          // Havola nomi band/noto'g'ri bo'lsa ham xodim yaratiladi — avtomatik nom qoladi, server ogohlantiradi
          if (res && typeof res.warning === 'string' && res.warning) toast(res.warning, 'warn', 7000);
          let created = adminStaffFrom(res);
          if (!created) {
            await loadAdminStaff();
            created = A.staff.filter((s) => s.full_name === values.full_name).sort((a, b) => b.id - a.id)[0] || null;
          } else {
            upsertAdminStaff(created);
          }
          A.dirty = true;
          if (!created) {
            toast("✅ Xodim qo'shildi", 'success');
            baseline = snapshot();
            newPhoto = null;
            nav.pop({ force: true });
            return;
          }
          if (newPhoto) {
            try {
              const pres = await apiUpload('admin.staff.photo', { id: created.id }, newPhoto.blob, newPhoto.name, null);
              const withPhoto = adminStaffFrom(pres);
              if (withPhoto) upsertAdminStaff(withPhoto);
              else await loadAdminStaff();
            } catch (e) {
              if (e.status !== 401) toast("Xodim qo'shildi, lekin rasm yuklanmadi: " + e.message, 'error', 6000);
            }
            URL.revokeObjectURL(newPhoto.url);
            newPhoto = null;
          }
          haptic.notify('success');
          toast("✅ Xodim qo'shildi. Endi taklif havolasini unga yuboring.", 'success', 4000);
          baseline = snapshot();
          nav.replaceTop(StaffFormScreen(created.id, { justCreated: true }));
          return;
        }
        const patch = {};
        if (values.role !== cur.role) patch.role = values.role;
        if (values.full_name !== cur.full_name) patch.full_name = values.full_name;
        if (values.position !== cur.position) patch.position = values.position;
        if (values.description !== cur.description) patch.description = values.description;
        if (values.greeting !== (cur.greeting ? cur.greeting.trim() : null)) patch.greeting = values.greeting;
        const sv = fSort.get().trim();
        const sortVal = sv === '' ? 0 : parseInt(sv, 10);
        if (sortVal !== cur.sort_order) patch.sort_order = sortVal;
        if (linkCode !== (cur.link_code || '')) patch.link_code = linkCode;
        if (!Object.keys(patch).length) {
          baseline = snapshot();
          updateDirty();
          return;
        }
        const res = await api('admin.staff.update', { id: cur.id, patch: patch });
        await applyStaffResult(res);
        if (!destroyed && cur && cur.link_code) fLink.set(cur.link_code);
        baseline = snapshot();
        renderClientLink();
        toast('✅ Saqlandi', 'success');
        haptic.notify('success');
      } catch (e) {
        if (!destroyed && (e.code === 'link_invalid' || e.code === 'link_taken')) {
          // Havola nomi xatosi — maydon ostida (boshqa maydonlar ham saqlanmagan, forma qayta yuboriladi)
          fLink.setError(e.message || linkCodeError(linkCode));
          fLink.focus();
          haptic.notify('error');
        } else reportError(e);
      } finally {
        saving = false;
        saveBtn.classList.remove('loading');
        if (!destroyed) {
          saveBtn.disabled = false;
          updateDirty();
        }
      }
    }
    saveBtn.addEventListener('click', save);

    // ── Tuzilish ──
    const parts = [];
    if (flags.justCreated && cur && !cur.linked) {
      parts.push(
        h('div', { class: 'callout success' }, [
          h('span', { class: 'callout-emoji', 'aria-hidden': 'true', text: '🎉' }),
          h('span', { text: "Xodim qo'shildi! Pastdagi taklif havolasini unga yuboring — u botga kirishi bilan mijozlar uni ko'radi." }),
        ]),
      );
    }
    parts.push(photoSec);
    parts.push(h('div', { class: 'form-sec-title', text: "Asosiy ma'lumotlar" }));
    parts.push(
      h('div', { class: 'form-sec' }, [
        h('div', { class: 'field' }, [h('div', { class: 'field-label' }, h('span', { text: 'Rol' })), roleSeg.el]),
        fName.el,
        fPos.el,
        fDesc.el,
      ]),
    );
    parts.push(h('div', { class: 'form-sec-title', text: 'Mijoz havolasi' }));
    parts.push(clientLinkSec);
    parts.push(h('div', { class: 'form-sec-title', text: 'Avto-javob' }));
    parts.push(h('div', { class: 'form-sec' }, fGreet.el));
    if (!isNew) {
      parts.push(h('div', { class: 'form-sec-title', text: 'Holat va tartib' }));
      parts.push(h('div', { class: 'form-sec' }, [blockWrap, fSort.el]));
      parts.push(h('div', { class: 'form-sec-title', text: 'Telegram akkaunt' }));
      parts.push(accountSec);
      parts.push(
        h('div', { class: 'danger-zone' }, h('button', { class: 'btn block ghost-danger', type: 'button', onclick: onDelete }, [icon('trash'), "Xodimni o'chirish"])),
      );
    } else {
      parts.push(
        h('p', { class: 'note', text: "Saqlangandan so'ng taklif havolasi yaratiladi — uni xodimga yuborasiz va u o'z Telegram akkauntini ulaydi." }),
      );
    }
    append(bodyEl, parts);

    if (!isNew && !cur) {
      clear(bodyEl).appendChild(emptyState('🤷', 'Xodim topilmadi', "U o'chirilgan bo'lishi mumkin."));
      saveBtn.disabled = true;
    } else {
      renderPhoto();
      renderAccount();
      renderClientLink();
      renderBlock();
      updateDirty();
      if (flags.justCreated) {
        setTimeout(() => {
          if (!destroyed) revealV(accountSec, true);
        }, 450);
      }
    }
    fName.input.addEventListener('input', () => {
      if (isNew && !newPhoto) renderPhoto();
      if (isNew) renderClientLink();
    });

    self.canLeave = async () => {
      if (saving) return false;
      if (!isDirty()) return true;
      return confirmDialog("Saqlanmagan o'zgarishlar bor. Chiqib ketasizmi?", { ok: 'Chiqish', destructive: true });
    };
    self.destroy = () => {
      destroyed = true;
      if (newPhoto && newPhoto.url) URL.revokeObjectURL(newPhoto.url);
    };
    return self;
  }

  function refreshMe() {
    api('bootstrap')
      .then((res) => {
        if (res.role === 'staff') applyBootstrap(res, true);
      })
      .catch(() => {
        /* keyingi safar yangilanadi */
      });
  }

  // ═══════════════════════════ Admin: bot matnlari ═══════════════════════════

  const SETTING_DEFS = [
    {
      key: 'welcome',
      title: '👋 Salomlashuv matni',
      hint: placeholderHint('Mijoz /start bosganda yuboriladi.', [['{name}', 'mijoz ismi']]),
    },
    {
      key: 'greeting',
      title: '🤖 Avto-javob matni',
      hint: placeholderHint("Mijoz xodimga birinchi marta yozganda yuboriladi (xodimning shaxsiy avto-javobi bo'lmasa).", [
        ['{name}', 'mijoz ismi'],
        ['{staff}', 'xodim ismi'],
      ]),
    },
    {
      key: 'offline_note',
      title: '🕐 Oflayn izohi',
      hint: placeholderHint("Xodim oflayn bo'lsa avto-javob oxiriga qo'shiladi.", [
        ['{staff}', 'xodim ismi'],
        ['{name}', 'mijoz ismi'],
      ]),
    },
  ];

  function SettingsScreen() {
    const self = { type: 'settings' };
    let data = null;
    let saving = false;
    let destroyed = false;
    const fields = {};
    const saveBtn = h('button', { class: 'btn', type: 'button', disabled: true }, '💾 Saqlash');
    const bodyEl = h('div', { class: 'screen-body with-actions' }, h('div', { class: 'center-state' }, spinner()));
    self.el = h('section', { class: 'form-screen' }, [screenBar('Bot matnlari'), bodyEl, h('div', { class: 'form-actions' }, saveBtn)]);

    function defaultsOf() {
      return (data && data.defaults) || {};
    }

    function currentOf(key) {
      return data && data[key] != null && data[key] !== '' ? String(data[key]) : null;
    }

    function effectiveOf(key) {
      const c = currentOf(key);
      return c != null ? c : str(defaultsOf()[key]);
    }

    function isDirty() {
      if (!data) return false;
      return SETTING_DEFS.some((d) => fields[d.key] && fields[d.key].field.get() !== effectiveOf(d.key));
    }

    function updateState() {
      saveBtn.disabled = saving || !isDirty();
      SETTING_DEFS.forEach((d) => {
        const f = fields[d.key];
        if (!f) return;
        const val = f.field.get();
        const def = str(defaultsOf()[d.key]);
        const isDefault = val.trim() === '' || val === def;
        clear(f.status).appendChild(h('span', { class: 'badge ' + (isDefault ? 'off' : 'on'), text: isDefault ? 'Standart matn' : "O'zgartirilgan" }));
        f.reset.disabled = isDefault;
      });
    }

    function render() {
      clear(bodyEl);
      SETTING_DEFS.forEach((d, i) => {
        const field = makeField({ label: 'Matn', max: 2000, multiline: true, rows: 6, hint: d.hint, onInput: updateState });
        field.set(effectiveOf(d.key));
        const status = h('div');
        const reset = h('button', { class: 'btn sm plain', type: 'button' }, '♻️ Standartga qaytarish');
        reset.addEventListener('click', () => {
          field.set(str(defaultsOf()[d.key]));
          field.setError('');
          updateState();
          haptic.select();
        });
        fields[d.key] = { field: field, status: status, reset: reset };
        append(bodyEl, [
          h('div', { class: 'form-sec-title', text: d.title, style: i === 0 ? 'margin-top:2px' : null }),
          h('div', { class: 'form-sec' }, [field.el, h('div', { class: 'settings-status', style: 'padding-bottom:12px' }, [status, reset])]),
        ]);
      });
      updateState();
    }

    async function load() {
      clear(bodyEl).appendChild(h('div', { class: 'center-state' }, spinner()));
      try {
        const res = await api('admin.settings.get');
        if (destroyed) return;
        data = res.settings && typeof res.settings === 'object' ? res.settings : res;
        if (!data.defaults && res.defaults) data.defaults = res.defaults;
        render();
      } catch (e) {
        if (destroyed) return;
        clear(bodyEl).appendChild(
          h('div', { class: 'center-state' }, [
            h('div', { text: e.message || MSG.generic }),
            h('button', { class: 'btn sm secondary', type: 'button', onclick: load }, "🔄 Qayta urinish"),
          ]),
        );
      }
    }

    async function save() {
      if (saving || !data) return;
      const patch = {};
      let bad = null;
      SETTING_DEFS.forEach((d) => {
        const val = fields[d.key].field.get();
        const trimmed = val.trim();
        if (trimmed.length > 2000) {
          fields[d.key].field.setError('Matn 2000 belgidan oshmasligi kerak.');
          bad = bad || fields[d.key].field;
          return;
        }
        if (val === effectiveOf(d.key)) return;
        const def = str(defaultsOf()[d.key]);
        patch[d.key] = trimmed === '' || trimmed === def.trim() ? '' : trimmed;
      });
      if (bad) {
        bad.focus();
        return;
      }
      if (!Object.keys(patch).length) return;
      saving = true;
      saveBtn.classList.add('loading');
      saveBtn.disabled = true;
      try {
        const res = await api('admin.settings.set', patch);
        const next = res && res.settings && typeof res.settings === 'object' ? res.settings : res;
        if (next && next.defaults) {
          data = next;
        } else {
          Object.keys(patch).forEach((k) => {
            data[k] = patch[k] === '' ? null : patch[k];
          });
        }
        if (!destroyed) render();
        toast('✅ Matnlar saqlandi', 'success');
        haptic.notify('success');
      } catch (e) {
        reportError(e);
      } finally {
        saving = false;
        saveBtn.classList.remove('loading');
        if (!destroyed) updateState();
      }
    }
    saveBtn.addEventListener('click', save);

    self.canLeave = async () => {
      if (saving) return false;
      if (!isDirty()) return true;
      return confirmDialog("Saqlanmagan o'zgarishlar bor. Chiqib ketasizmi?", { ok: 'Chiqish', destructive: true });
    };
    self.destroy = () => {
      destroyed = true;
    };
    load();
    return self;
  }

  // ═══════════════════════════ Ishga tushirish ═══════════════════════════

  // ROP/developer/admin uchun og'ir ro'yxatlarni ilova ochilishi bilan fonda oldindan yuklash:
  // foydalanuvchi tabni ochganda sovuq start (~5-10 s) kutilmaydi — kesh darhol chiziladi.
  const PREFETCH_TTL = 120000;
  const PC = { complaints: null, watchStaff: null };

  function prefetchPrivileged() {
    try {
      if (S.panelRole === 'rop' || S.panelRole === 'developer') {
        api('complaints.list', { filter: 'new', offset: 0 }, { timeout: 20000 })
          .then((res) => {
            PC.complaints = { at: Date.now(), res: res };
          })
          .catch(() => {});
      }
      if (S.isAdmin) {
        api('watch.staff', {}, { timeout: 20000 })
          .then((res) => {
            PC.watchStaff = { at: Date.now(), res: res };
          })
          .catch(() => {});
      }
    } catch (e) {
      /* jim — panellar ochilganda o'zi yuklaydi */
    }
  }

  function takePrefetch(kind) {
    const c = PC[kind];
    if (!c || Date.now() - c.at > PREFETCH_TTL) {
      PC[kind] = null;
      return null;
    }
    PC[kind] = null;
    return c.res;
  }

  function showBootLoader() {
    clear(appEl).appendChild(
      h('div', { class: 'boot', role: 'status' }, [h('div', { class: 'boot-logo', 'aria-hidden': 'true', text: '💬' }), h('div', { text: 'Yuklanmoqda…' })]),
    );
  }

  async function boot() {
    if (!initData) {
      clear(appEl);
      showFatal({ emoji: '📱', title: 'Telegram orqali oching', text: MSG.openInTelegram });
      return;
    }
    try {
      const res = await api('bootstrap', {}, { timeout: 25000 });
      if (res.role !== 'staff') {
        // Mijozlar uchun Mini App yo'q (server odatda 403 client_app_disabled qaytaradi; bu — qo'shimcha himoya)
        clear(appEl);
        clientAppDisabled();
        return;
      }
      applyBootstrap(res);
      if (!S.me && !S.isAdmin) {
        accessRevoked();
        return;
      }
      outboxRestore();
      nav.setRoot(StaffRoot());
      poller.lastBoot = 0;
      poller.plan(LIST_POLL);
      // Og'ir panellarni fonda isitish (serverless + baza sovuq starti foydalanuvchiga sezilmasin)
      setTimeout(prefetchPrivileged, 0);
    } catch (e) {
      clear(appEl);
      if (e.status === 401 || sessionDead || accessDead || clientDisabled) return;
      if (e.code === 'client_app_disabled') {
        clientAppDisabled(e.message);
        return;
      }
      if (e.code === 'not_staff' || e.status === 403) {
        // handleResponse 'not_staff' da allaqachon chaqiradi; boshqa 403 lar uchun — xabar matni bilan
        accessRevoked(e.code === 'not_staff' ? MSG.notStaff : e.message);
        return;
      }
      showFatal({
        emoji: '😕',
        title: "Yuklab bo'lmadi",
        text: e.message || MSG.generic,
        actions: [
          {
            label: '🔄 Qayta urinish',
            fn: () => {
              hideFatal();
              showBootLoader();
              boot();
            },
          },
        ],
      });
    }
  }

  function init() {
    applyTheme();
    if (tg) {
      tgTry(() => tg.ready());
      tgTry(() => tg.expand());
      if (tgAtLeast('7.7')) tgTry(() => tg.disableVerticalSwipes());
      tgTry(() => tg.onEvent('themeChanged', applyTheme));
      if (tgAtLeast('6.1')) tgTry(() => tg.BackButton.onClick(handleBack));
      tgTry(() =>
        tg.onEvent('viewportChanged', () => {
          const chat = currentChat();
          if (chat && chat.onViewport) chat.onViewport();
        }),
      );
      tgTry(() => tg.onEvent('activated', () => poller.kick()));
    }
    if (!inTelegram && window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) mq.addEventListener('change', applyTheme);
      else if (mq.addListener) mq.addListener(applyTheme);
    }
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', () => poller.kick());
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented) handleBack();
    });
    window.addEventListener('resize', () => {
      const chat = currentChat();
      if (chat && chat.onViewport) chat.onViewport();
    });
    window.addEventListener('unhandledrejection', (e) => {
      console.error('Unhandled:', e.reason);
    });
    window.addEventListener('pagehide', () => {
      const chat = currentChat();
      if (chat) chat.saveDraftNow();
    });
    boot();
  }

  init();
})();

// Lokal ishlab chiqish serveri — Vercel'ni taqlid qiladi:
//   npm run dev                      → http://127.0.0.1:3000
//   npm run dev -- --port 8080       → boshqa port (yoki PORT=8080)
//   npm run dev -- --host 0.0.0.0    → lokal tarmoqdan (telefon) ochish uchun
//   npm run dev -- --links           → Mini App ni brauzerda sinash uchun dev havolalar (#dev_init_data=...)
//   npm run dev -- --user 12345      → --links uchun mijoz Telegram ID si (standart: birinchi admin)
//
// • public/ statik fayllar: "/" → public/index.html, "/app/" → public/app/index.html (katalog → index.html,
//   "/app" → "/app/" ga yo'naltiriladi), to'g'ri Content-Type, ETag/304, path traversal himoyasi.
// • /api/<nom> → api/<nom>.ts ning `export default { fetch }` (yoki default funksiya / GET, POST... eksportlari).
//   Node req/res ⇄ Web Request/Response: sarlavhalar saqlanadi, body oqim (stream) sifatida uzatiladi (binary xavfsiz).
//   Vercel kabi: so'rov tanasi > 4.5 MB → 413 FUNCTION_PAYLOAD_TOO_LARGE; x-forwarded-* sarlavhalari qo'shiladi.
// • Modullar birinchi so'rovda yuklanadi va keshlanadi. Kod o'zgarsa serverni qayta ishga tushiring
//   (yoki: npx tsx watch --env-file=.env scripts/dev-server.ts).
// • Telegram webhook lari lokal serverga kelmaydi (https kerak). Botlarni lokal sinash uchun tunnel ishlating
//   (masalan: cloudflared tunnel --url http://127.0.0.1:3000) va `npm run setup -- https://<tunnel-domen>`.
//   Diqqat: bu production botlarning webhookini tunnelga o'tkazadi — ishingiz tugagach setup ni Vercel domeni bilan qayta bajaring.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PUBLIC_DIR = join(ROOT, 'public');
const API_DIR = join(ROOT, 'api');
/** Vercel funksiyasi so'rov tanasi limiti (4.5 MB). */
const BODY_LIMIT = Math.floor(4.5 * 1024 * 1024);

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
};

/** Node → Web Request ga o'tkazilmaydigan hop-by-hop sarlavhalar. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'http2-settings',
]);

// ───────────────────────────── CLI ─────────────────────────────

interface Cli {
  port: number;
  host: string;
  links: boolean;
  user?: number;
  help: boolean;
}

function parseArgs(argv: string[]): Cli {
  const cli: Cli = { port: Number(process.env.PORT) || 3000, host: '127.0.0.1', links: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const [flag, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    const value = (): string => {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new Error(`${flag} uchun qiymat berilmagan`);
      return v;
    };
    switch (flag) {
      case '--port':
      case '-p': {
        const v = value();
        const n = Number(v);
        if (!/^\d+$/.test(v) || n > 65535) throw new Error(`Noto'g'ri port: "${v}"`);
        cli.port = n;
        break;
      }
      case '--host':
      case '-H':
        cli.host = value();
        break;
      case '--links':
        cli.links = true;
        break;
      case '--user': {
        const v = value();
        const n = Number(v);
        if (!/^\d+$/.test(v) || !Number.isSafeInteger(n) || n <= 0) throw new Error(`Noto'g'ri Telegram ID: "${v}"`);
        cli.user = n;
        break;
      }
      case '--help':
      case '-h':
        cli.help = true;
        break;
      case '--':
        break;
      default:
        throw new Error(`Noma'lum parametr: ${a}`);
    }
  }
  return cli;
}

// ───────────────────────────── Static files ─────────────────────────────

function sendText(res: ServerResponse, status: number, text: string, headers: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(text);
}

async function notFound(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const custom = join(PUBLIC_DIR, '404.html');
  const st = await stat(custom).catch(() => null);
  if (st?.isFile()) {
    res.writeHead(404, { 'content-type': CONTENT_TYPES['.html']!, 'content-length': st.size, 'cache-control': 'no-store' });
    if (req.method === 'HEAD') return void res.end();
    await pipeline(createReadStream(custom), res);
    return;
  }
  sendText(res, 404, '404 — Topilmadi (Not Found)');
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendText(res, 405, 'Method Not Allowed', { allow: 'GET, HEAD' });
  }
  let rel: string;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    return sendText(res, 400, 'Bad Request');
  }
  if (rel.includes('\0') || rel.includes('\\')) return sendText(res, 400, 'Bad Request');

  let filePath = resolve(PUBLIC_DIR, `.${rel}`);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + sep)) return notFound(req, res);
  // Yashirin fayllar (.env va h.k.) hech qachon berilmaydi
  if (filePath.slice(PUBLIC_DIR.length).split(sep).some((seg) => seg.startsWith('.'))) return notFound(req, res);

  let st = await stat(filePath).catch(() => null);
  if (st?.isDirectory()) {
    if (!url.pathname.endsWith('/')) {
      res.writeHead(308, { location: `${url.pathname}/${url.search}`, 'cache-control': 'no-store' });
      return void res.end();
    }
    filePath = join(filePath, 'index.html');
    st = await stat(filePath).catch(() => null);
  }
  if (!st || !st.isFile()) return notFound(req, res);

  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers: Record<string, string | number> = {
    'content-type': CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
    etag,
    'last-modified': st.mtime.toUTCString(),
    'x-content-type-options': 'nosniff',
  };
  const inm = req.headers['if-none-match'];
  if (inm && inm.split(',').map((s) => s.trim()).includes(etag)) {
    res.writeHead(304, headers);
    return void res.end();
  }
  headers['content-length'] = st.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return void res.end();
  await pipeline(createReadStream(filePath), res);
}

// ───────────────────────────── API functions ─────────────────────────────

type FetchHandler = (req: Request) => Response | Promise<Response>;

function resolveHandler(mod: Record<string, unknown>, method: string): FetchHandler | null {
  const def = mod.default as unknown;
  if (def && typeof def === 'object' && typeof (def as { fetch?: unknown }).fetch === 'function') {
    const obj = def as { fetch: FetchHandler };
    return (r) => obj.fetch(r);
  }
  if (typeof def === 'function') return def as FetchHandler;
  const named = mod[method] ?? (method === 'HEAD' ? mod.GET : undefined);
  return typeof named === 'function' ? (named as FetchHandler) : null;
}

class PayloadTooLarge extends Error {}

/** Node so'rov tanasi → Web ReadableStream (backpressure bilan; limitdan oshsa xato; o'qilmagan qism tashlab yuboriladi). */
interface BodyAdapter {
  stream: ReadableStream<Uint8Array>;
  /** Tana 4.5 MB limitdan oshdimi */
  readonly tooLarge: boolean;
  /** Handler o'qimagan qolgan tanani o'qib tashlash (keep-alive ulanish osilib qolmasligi uchun). */
  drain(): void;
}

function nodeBody(req: IncomingMessage, limit: number): BodyAdapter {
  let total = 0;
  let finished = false;
  let tooLarge = false;
  const drain = () => {
    finished = true;
    req.resume();
  };
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      req.on('data', (chunk: Buffer) => {
        if (finished) return;
        total += chunk.byteLength;
        if (total > limit) {
          tooLarge = true;
          ctrl.error(new PayloadTooLarge('FUNCTION_PAYLOAD_TOO_LARGE'));
          drain();
          return;
        }
        ctrl.enqueue(new Uint8Array(chunk));
        if ((ctrl.desiredSize ?? 1) <= 0) req.pause();
      });
      req.once('end', () => {
        if (finished) return;
        finished = true;
        ctrl.close();
      });
      req.once('error', (e) => {
        if (finished) return;
        finished = true;
        ctrl.error(e);
      });
      req.once('close', () => {
        if (finished) return;
        finished = true;
        ctrl.error(new Error('Mijoz ulanishni uzdi'));
      });
    },
    pull() {
      if (!finished) req.resume();
    },
    cancel() {
      drain();
    },
  });
  return {
    stream,
    get tooLarge() {
      return tooLarge;
    },
    drain,
  };
}

function toWebRequest(req: IncomingMessage, url: URL, signal: AbortSignal): { request: Request; body: BodyAdapter | null } {
  const headers = new Headers();
  const raw = req.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const k = raw[i]!;
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    try {
      headers.append(k, raw[i + 1]!);
    } catch {
      /* noto'g'ri sarlavha — tashlab yuboriladi */
    }
  }
  if (!headers.has('x-forwarded-proto')) headers.set('x-forwarded-proto', 'http');
  if (!headers.has('x-forwarded-host') && req.headers.host) headers.set('x-forwarded-host', req.headers.host);
  if (!headers.has('x-forwarded-for')) headers.set('x-forwarded-for', req.socket.remoteAddress ?? '127.0.0.1');
  if (!headers.has('x-real-ip')) headers.set('x-real-ip', req.socket.remoteAddress ?? '127.0.0.1');

  const init: RequestInit & { duplex?: 'half' } = { method: req.method, headers, signal };
  let body: BodyAdapter | null = null;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    body = nodeBody(req, BODY_LIMIT);
    init.body = body.stream;
    init.duplex = 'half';
  }
  return { request: new Request(url, init), body };
}

async function writeWebResponse(req: IncomingMessage, res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    if (key === 'set-cookie' || HOP_BY_HOP.has(key)) return;
    headers[key] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(response.status, response.statusText || undefined, headers);
  const noBody = req.method === 'HEAD' || response.status === 204 || response.status === 304 || !response.body;
  if (noBody) {
    res.end();
    await response.body?.cancel().catch(() => {});
    return;
  }
  await pipeline(Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>), res);
}

async function serveApi(req: IncomingMessage, res: ServerResponse, url: URL, name: string): Promise<void> {
  const file = join(API_DIR, `${name}.ts`);
  const st = await stat(file).catch(() => null);
  if (!st?.isFile()) {
    req.resume();
    return sendText(res, 404, `404 — /api/${name} funksiyasi topilmadi`);
  }

  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > BODY_LIMIT) {
    req.resume();
    return sendText(res, 413, 'FUNCTION_PAYLOAD_TOO_LARGE: Request Entity Too Large');
  }

  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  } catch (e) {
    console.error(`❌ api/${name}.ts ni yuklab bo'lmadi:`, e);
    req.resume();
    return sendText(res, 500, `500 — api/${name}.ts ni yuklab bo'lmadi (konsolni ko'ring)`);
  }
  const handler = resolveHandler(mod, req.method ?? 'GET');
  if (!handler) {
    req.resume();
    return sendText(res, 405, 'Method Not Allowed');
  }

  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableFinished) controller.abort();
  };
  res.once('close', onClose);
  const { request, body } = toWebRequest(req, url, controller.signal);
  try {
    let response: Response;
    try {
      response = await handler(request);
    } catch (e) {
      if (body?.tooLarge) return sendText(res, 413, 'FUNCTION_PAYLOAD_TOO_LARGE: Request Entity Too Large');
      console.error(`❌ /api/${name} xatosi:`, e);
      return sendText(res, 500, '500 — FUNCTION_INVOCATION_FAILED (konsolni ko\'ring)');
    }
    // Vercel limitdan oshgan so'rovni funksiyaga umuman yetkazmaydi — shunga o'xshab 413 qaytaramiz
    if (body?.tooLarge) {
      if (response instanceof Response) await response.body?.cancel().catch(() => {});
      return sendText(res, 413, 'FUNCTION_PAYLOAD_TOO_LARGE: Request Entity Too Large');
    }
    if (!(response instanceof Response)) {
      console.error(`❌ /api/${name} Response qaytarmadi:`, response);
      return sendText(res, 500, '500 — handler Response qaytarmadi');
    }
    await writeWebResponse(req, res, response);
  } finally {
    res.off('close', onClose);
    body?.drain();
  }
}

// ───────────────────────────── Server ─────────────────────────────

async function handle(req: IncomingMessage, res: ServerResponse, port: number): Promise<void> {
  const started = Date.now();
  res.once('finish', () => {
    const ms = Date.now() - started;
    const mark = res.statusCode >= 500 ? '❌' : res.statusCode >= 400 ? '⚠️ ' : '  ';
    console.log(`${mark} ${req.method} ${req.url} → ${res.statusCode} (${ms} ms)`);
  });

  let url: URL;
  try {
    url = new URL(req.url ?? '/', `http://${req.headers.host ?? `127.0.0.1:${port}`}`);
  } catch {
    return sendText(res, 400, 'Bad Request');
  }

  const api = /^\/api\/([A-Za-z0-9][A-Za-z0-9_-]*)\/?$/.exec(url.pathname);
  if (api) return serveApi(req, res, url, api[1]!);
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    req.resume();
    return sendText(res, 404, '404 — Topilmadi (Not Found)');
  }
  return serveStatic(req, res, url);
}

async function printDevLinks(cli: Cli, base: string): Promise<void> {
  try {
    const { buildInitData } = await import('../src/auth.js');
    const { config } = await import('../src/config.js');
    const admins = config.adminIds;
    const clientUser = cli.user ?? admins[0];
    if (!clientUser) {
      console.log('ℹ️  --links: Telegram ID topilmadi. --user <ID> bering yoki .env da ADMIN_IDS ni to\'ldiring.');
      return;
    }
    const make = (token: string, id: number) =>
      `${base}/app/#dev_init_data=${encodeURIComponent(buildInitData(token, { id, first_name: 'Dev', username: 'dev_user' }))}`;
    console.log('\n🔗 Mini App dev havolalari (24 soat amal qiladi, faqat shu kompyuterda ishlating — hech kimga bermang):');
    // Mijozlar uchun Mini App o'chirilgan: bu havola faqat «Bot chatida yozing» ekranini tekshirish uchun
    console.log(`   👤 Mijoz (ID ${clientUser}) — «Bot chatida yozing» ekrani:\n   ${make(config.clientBotToken, clientUser)}`);
    if (config.hasStaffBot) {
      const staffUser = cli.user ?? admins[0]!;
      console.log(`   🧑‍💼 Xodim/admin (ID ${staffUser}):\n   ${make(config.staffBotToken, staffUser)}`);
    }
  } catch (e) {
    console.log(`ℹ️  --links: havolalarni yaratib bo'lmadi: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function usage(): void {
  console.log(`Foydalanish: npm run dev -- [--port 3000] [--host 127.0.0.1] [--links] [--user <telegram_id>]

  --port, -p   Port (standart: PORT env yoki 3000)
  --host, -H   Tinglanadigan manzil (standart: 127.0.0.1; lokal tarmoq uchun 0.0.0.0)
  --links      Mini App ni brauzerda sinash uchun imzolangan dev havolalarni chiqarish
  --user       --links uchun Telegram ID (standart: ADMIN_IDS dagi birinchi ID)`);
}

async function main(): Promise<void> {
  let cli: Cli;
  try {
    cli = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`❌ ${e instanceof Error ? e.message : String(e)}\n`);
    usage();
    process.exit(1);
  }
  if (cli.help) {
    usage();
    return;
  }

  const missing = ['CLIENT_BOT_TOKEN', 'DATABASE_URL', 'WEBHOOK_SECRET'].filter((k) => !(process.env[k] ?? '').trim());
  if (missing.length) {
    console.warn(`⚠️  .env da yo'q: ${missing.join(', ')} — /api/* so'rovlari xato qaytarishi mumkin (statik fayllar ishlaydi).`);
  }

  const server = createServer((req, res) => {
    handle(req, res, cli.port).catch((e) => {
      console.error('❌ So\'rovni qayta ishlashda xato:', e);
      if (!res.headersSent) sendText(res, 500, '500 — Internal Server Error');
      else res.destroy();
    });
  });
  server.requestTimeout = 120_000;

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(cli.port, cli.host, () => {
      server.off('error', reject);
      resolvePromise();
    });
  }).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') console.error(`❌ ${cli.port}-port band. Boshqa port: npm run dev -- --port ${cli.port + 1}`);
    else console.error('❌ Serverni ishga tushirib bo\'lmadi:', e);
    process.exit(1);
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : cli.port;
  const shownHost = cli.host === '0.0.0.0' || cli.host === '::' ? 'localhost' : cli.host;
  const base = `http://${shownHost}:${port}`;
  console.log(`🚀 Dev server ishga tushdi: ${base}`);
  console.log(`   📄 Bosh sahifa:  ${base}/`);
  console.log(`   📱 Mini App:     ${base}/app/`);
  console.log(`   🔌 API:          ${base}/api/<nom>  (api/<nom>.ts)`);
  if (cli.links) await printDevLinks(cli, base);
  console.log('\nTo\'xtatish: Ctrl+C');

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`\n⏹  ${signal} — to'xtatilmoqda...`);
    const force = setTimeout(() => process.exit(0), 3000);
    force.unref();
    server.close();
    server.closeAllConnections();
    try {
      const { closeDb } = await import('../src/db.js');
      await closeDb();
    } catch {
      /* baza ulanmagan bo'lishi mumkin */
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

await main();

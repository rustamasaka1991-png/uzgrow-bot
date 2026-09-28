import postgres from 'postgres';
import { config } from './config.js';

export type Sql = postgres.Sql<{ bigint: number }>;

let instance: Sql | null = null;

/**
 * Supabase Postgres ulanishi (Supavisor transaction pooler, port 6543).
 * Serverless muhit uchun: prepare=false, kichik pool, int8 -> number.
 */
export function db(): Sql {
  if (instance) return instance;
  const url = config.databaseUrl;
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  // Faqat testlar uchun: alohida sxema (production ma'lumotlariga tegmaslik uchun)
  const searchPath = (process.env.DATABASE_SEARCH_PATH ?? '').trim();
  instance = postgres(url, {
    ...(searchPath ? { connection: { search_path: searchPath } } : {}),
    prepare: false,
    max: 5,
    idle_timeout: 20,
    connect_timeout: 15,
    max_lifetime: 60 * 10,
    ssl: isLocal ? false : 'require',
    onnotice: () => {},
    types: {
      bigint: {
        to: 20,
        from: [20],
        serialize: (x: number) => String(x),
        parse: (x: string) => Number(x),
      },
    },
  }) as unknown as Sql;
  return instance;
}

export async function closeDb(): Promise<void> {
  if (instance) {
    const s = instance;
    instance = null;
    await s.end({ timeout: 5 });
  }
}

import postgres from 'postgres';
import { config } from './config.js';

export type Sql = postgres.Sql<{ bigint: number }>;

let instance: Sql | null = null;

/** JS massivini Postgres massiv literaliga aylantirish: [1, 'a"b', null] → {"1","a\"b",NULL}. */
function pgArrayLiteral(xs: readonly unknown[]): string {
  return (
    '{' +
    xs
      .map((x) => {
        if (x === null) return 'NULL';
        if (x === undefined) throw new Error("sql.array: undefined qiymat (null ishlating)");
        if (Array.isArray(x)) return pgArrayLiteral(x);
        const s = x instanceof Date ? x.toISOString() : String(x);
        return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
      })
      .join(',') +
    '}'
  );
}

/**
 * Supabase Postgres ulanishi (Supavisor transaction pooler, port 6543).
 * Serverless muhit uchun: prepare=false, kichik pool, int8 -> number.
 *
 * fetch_types: false — har bir yangi ulanishda pg_type dan massiv turlarini so'rash (~10 KB, +2 RTT) o'chirilgan.
 * Shunda postgres.js massiv turlarini bilmaydi va `sql.array(xs)` parametri `text` (OID 25) sifatida yuboriladi;
 * standart serializer uni "1,2,3" qilib yuborardi (noto'g'ri literal). Quyidagi `text` serializeri massivni
 * Postgres literaliga ('{"1","2","3"}') aylantiradi, server esa uni aniq cast bo'yicha o'giradi. SHART: har bir
 * sql.array aniq cast bilan yoziladi — `any(${sql.array(ids)}::bigint[])`, `::text[]` (castsiz `any($1)` text
 * ustida xato beradi). Natijadagi massiv ustunlari (array_agg va h.k.) satr bo'lib qaytadi — ishlatilmaydi.
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
    fetch_types: false,
    max: 5,
    // Fluid compute: instansiya so'rovlar orasida tirik — ulanishni tez-tez qayta ochmaslik (TLS + SCRAM)
    idle_timeout: 60,
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
      // sql.array(...) → text parametri massiv literali bilan (yuqoridagi izohga qarang); oddiy satrlar o'zgarmaydi
      text: {
        to: 25,
        from: [] as number[],
        serialize: (x: unknown) => (Array.isArray(x) ? pgArrayLiteral(x) : String(x)),
        parse: (x: string) => x,
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

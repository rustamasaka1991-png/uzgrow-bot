// Lokal: `npm run migrate` — bazada jadvallarni yaratadi (idempotent).
import { closeDb } from '../src/db.js';
import { migrate } from '../src/setup.js';

await migrate();
console.log('✅ Migratsiya bajarildi');
await closeDb();

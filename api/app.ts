// Mini App backend: POST https://<domen>/api/app
// So'rov vaqt byudjeti ichida bajariladi (src/deadline.ts): Telegram chaqiruvlari Vercel funksiyani o'ldirishidan
// oldin xato bilan qaytadi va foydalanuvchi aniq xato matnini oladi.
import { withRequestDeadline } from '../src/http.js';
import { handleAppRequest } from '../src/webapp/api.js';

export default { fetch: withRequestDeadline((req) => handleAppRequest(req)) };

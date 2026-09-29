// Mini App backend: POST https://<domen>/api/app
// Faqat xodimlar va admin uchun: mijozlar boti orqali ochilgan Mini App har qanday amalda 403 client_app_disabled
// oladi (mijozlar bot chatida yozadi; mijozlar botida Mini App tugmasi yo'q).
// So'rov vaqt byudjeti ichida bajariladi (src/deadline.ts): Telegram chaqiruvlari Vercel funksiyani o'ldirishidan
// oldin xato bilan qaytadi va foydalanuvchi aniq xato matnini oladi.
import { withRequestDeadline } from '../src/http.js';
import { handleAppRequest } from '../src/webapp/api.js';

export default { fetch: withRequestDeadline((req) => handleAppRequest(req)) };

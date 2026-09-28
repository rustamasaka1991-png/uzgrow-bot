// Media proksi: GET https://<domen>/api/media?t=<token> yoki ?staff=<id>&v=<versiya>
// So'rov vaqt byudjeti ichida bajariladi (src/deadline.ts) — Telegramdan fayl yuklash cheksiz osilib qolmaydi.
import { withRequestDeadline } from '../src/http.js';
import { handleMediaRequest } from '../src/webapp/media.js';

export default { fetch: withRequestDeadline((req) => handleMediaRequest(req)) };

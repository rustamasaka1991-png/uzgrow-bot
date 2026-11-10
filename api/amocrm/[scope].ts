// amoCRM Chats API hook: https://<domen>/api/amocrm/<scope_id> (operator amoCRM dan mijozga yozganda)
import { handleAmoHook } from '../../src/amocrm-hook.js';
import { withRequestDeadline } from '../../src/http.js';

export default { fetch: withRequestDeadline((req) => handleAmoHook(req)) };

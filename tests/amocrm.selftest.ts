// amoCRM imzolari va suhbat ID formati uchun kichik tekshiruv: npx tsx tests/amocrm.selftest.ts
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { amoConversationId, parseAmoConversationId, signRequest, verifyHookSignature } from '../src/amocrm.js';

const secret = '5a44c5dff55f3c15a4cce8d7c4cc27e207c7e189';
const body = '{"a":1}';

// Hook imzosi: to'g'ri / noto'g'ri / yo'q
const good = createHmac('sha1', secret).update(body).digest('hex');
assert.equal(verifyHookSignature(body, good, secret), true);
assert.equal(verifyHookSignature(body, good.toUpperCase(), secret), true);
assert.equal(verifyHookSignature(body + ' ', good, secret), false);
assert.equal(verifyHookSignature(body, null, secret), false);
assert.equal(verifyHookSignature(body, good, ''), false);

// So'rov imzosi: hujjatdagi tartib (METHOD, md5, content-type, date, path)
const date = new Date(Date.UTC(2020, 9, 3, 15, 11, 21));
const h = signRequest('post', '/v2/origin/custom/x/connect', body, secret, date);
assert.equal(h.Date, 'Sat, 03 Oct 2020 15:11:21 +0000');
assert.equal(h['Content-MD5'], createHash('md5').update(body).digest('hex'));
const expected = createHmac('sha1', secret)
  .update(['POST', h['Content-MD5'], 'application/json', h.Date, '/v2/origin/custom/x/connect'].join('\n'))
  .digest('hex');
assert.equal(h['X-Signature'], expected);

// Suhbat ID
assert.equal(parseAmoConversationId(amoConversationId(42)), 42);
assert.equal(parseAmoConversationId('boshqa-42'), null);
assert.equal(parseAmoConversationId(undefined), null);

console.log('amocrm selftest: OK');

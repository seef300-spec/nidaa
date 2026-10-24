import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import http2 from 'node:http2';
import crypto from 'node:crypto';
import fs from 'node:fs';
import ece from 'http_ece';
import { startApp, setupShop, Client, tokenOf, until } from './helpers.js';

const tls = { key: fs.readFileSync('test/fixtures/localhost.key'), cert: fs.readFileSync('test/fixtures/localhost.crt') };

// خدمة إشعارات وهمية (بديل FCM/Apple) تفك التشفير للتحقق من المحتوى
const pushLog = [];
const pushPlan = {}; // path -> [status, ...]
const pushSrv = https.createServer(tls, (req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    pushLog.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    const plan = pushPlan[req.url];
    const status = plan?.length ? plan.shift() : 201;
    res.writeHead(status); res.end();
  });
});

// APNs وهمي بـ HTTP/2
const apnsLog = [];
const apnsKeys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const apnsSrv = http2.createSecureServer(tls);
apnsSrv.on('stream', (stream, headers) => {
  let body = '';
  stream.on('data', (d) => { body += d; });
  stream.on('end', () => {
    const [h, c, s] = String(headers.authorization || '').replace('bearer ', '').split('.');
    const valid = crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: apnsKeys.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s || '', 'base64url'));
    apnsLog.push({ headers, body: JSON.parse(body), jwtValid: valid, claims: JSON.parse(Buffer.from(c, 'base64url')) });
    const unregistered = headers[':path'].endsWith('dead0000dead0000dead0000dead0000');
    stream.respond({ ':status': !valid ? 403 : unregistered ? 410 : 200 });
    stream.end(unregistered ? JSON.stringify({ reason: 'Unregistered' }) : '');
  });
});

let app, base, owner, pushBase;
function newSubscription(path) {
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const auth = crypto.randomBytes(16).toString('base64url');
  return { ecdh, auth, json: { endpoint: `${pushBase}${path}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth } } };
}
function decrypt(entry, sub) {
  return JSON.parse(ece.decrypt(entry.body, { version: 'aes128gcm', privateKey: sub.ecdh, authSecret: sub.auth }).toString());
}
const create = async () => (await owner.post('/api/staff/orders', {})).data.order;
const get = async (o) => (await owner.get(`/api/staff/orders/${o.id}`)).data.order;
const act = async (o, a) => { const cur = await get(o); return owner.post(`/api/staff/orders/${o.id}/${a}`, { expectedVersion: cur.version }); };

before(async () => {
  await new Promise((r) => pushSrv.listen(0, '127.0.0.1', r));
  await new Promise((r) => apnsSrv.listen(0, '127.0.0.1', r));
  pushBase = `https://localhost:${pushSrv.address().port}`;
  process.env.PUSH_ENDPOINT_ALLOW = `${pushBase}/`;
  ({ app, base } = await startApp({
    apns: {
      keyId: 'KEY1234567', teamId: 'TEAM123456', bundleId: 'com.example.nidaa.Clip',
      privateKey: apnsKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }), appId: 'TEAM123456.com.example.nidaa.Clip',
      host: `https://localhost:${apnsSrv.address().port}`,
    },
  }));
  owner = await setupShop(base);
});
after(async () => { await app.close(); pushSrv.close(); apnsSrv.close(); });

test('Web Push: اشتراك ← نداء ← قبول خدمة الإشعارات ← تأكيد الجهاز', async () => {
  const o = await create();
  const t = tokenOf(o);
  const cust = new Client(base);
  await cust.post(`/api/public/o/${t}/hello`, { clientId: 'device-android-1', platform: 'android', capability: 'push', permission: 'default' });
  let s = await get(o);
  assert.equal(s.customer.opened, true);
  assert.equal(s.notify.state, 'not_enabled', 'فتح الرابط لا يعني تفعيل التنبيه');
  const sub = newSubscription('/sub-a');
  assert.equal((await cust.post(`/api/public/o/${t}/push`, { clientId: 'device-android-1', platform: 'android', capability: 'push', subscription: sub.json })).status, 200);
  s = await get(o);
  assert.equal(s.notify.state, 'subscribed');
  assert.equal(s.lastCall, null);

  pushLog.length = 0;
  assert.equal((await act(o, 'call')).status, 200);
  await until(async () => (await get(o)).lastCall?.pushAccepted === 1);
  s = await get(o);
  assert.equal(s.lastCall.pushTotal, 1);
  assert.equal(s.lastCall.deviceReceipts, 0, 'لا نعرض «وصل» قبل تأكيد الجهاز');
  const entry = pushLog.find((e) => e.path === '/sub-a');
  assert.ok(entry, 'وصل الطلب لخدمة الإشعارات');
  assert.equal(entry.headers.urgency, 'high');
  assert.ok(Number(entry.headers.ttl) > 0);
  assert.match(entry.headers.authorization, /^vapid t=.+, k=.+/);
  const payload = decrypt(entry, sub);
  assert.match(payload.title, new RegExp(`${o.number}`));
  assert.equal(payload.url, o.url);
  assert.ok(payload.deliveryId);
  // عامل الخدمة يؤكد الاستلام
  assert.equal((await cust.post(`/api/public/o/${t}/receipt`, { channel: 'push', deliveryId: payload.deliveryId })).status, 200);
  s = await get(o);
  assert.equal(s.lastCall.deviceReceipts, 1);
  // لا يمكن تأكيد استلام لطلب آخر برمز هذا الطلب
  const o2 = await create();
  assert.equal((await new Client(base).post(`/api/public/o/${tokenOf(o2)}/receipt`, { channel: 'push', deliveryId: payload.deliveryId })).status, 404);
});

test('جهازان لنفس الطلب: كلاهما يُسجَّل ويستلم دون إلغاء أحدهما', async () => {
  const o = await create();
  const t = tokenOf(o);
  const a = new Client(base); const b = new Client(base);
  const sa = newSubscription('/dev-1'); const sb = newSubscription('/dev-2');
  await a.post(`/api/public/o/${t}/hello`, { clientId: 'device-one-0001', platform: 'android' });
  await b.post(`/api/public/o/${t}/hello`, { clientId: 'device-two-0002', platform: 'ios' });
  // فتح الرابط مرة أخرى من نفس الجهاز لا ينشئ شيئًا جديدًا
  await a.post(`/api/public/o/${t}/hello`, { clientId: 'device-one-0001', platform: 'android' });
  await a.post(`/api/public/o/${t}/push`, { clientId: 'device-one-0001', subscription: sa.json });
  await b.post(`/api/public/o/${t}/push`, { clientId: 'device-two-0002', subscription: sb.json });
  let s = await get(o);
  assert.equal(s.customer.devices, 2);
  assert.equal(s.notify.activeSubscriptions, 2);
  const all = (await owner.get('/api/staff/orders?filter=all&limit=200')).data.orders;
  assert.equal(all.filter((x) => x.id === o.id).length, 1, 'لا طلب جديد');
  pushLog.length = 0;
  await act(o, 'call');
  await until(() => pushLog.some((e) => e.path === '/dev-1') && pushLog.some((e) => e.path === '/dev-2'));
  assert.equal(decrypt(pushLog.find((e) => e.path === '/dev-2'), sb).url, o.url);
});

test('اشتراك منتهٍ (410) يُعلَّم منتهيًا، وخطأ مؤقت (500) يُعاد إرساله', async () => {
  const o = await create();
  const t = tokenOf(o);
  const c = new Client(base);
  await c.post(`/api/public/o/${t}/hello`, { clientId: 'device-gone-001' });
  await c.post(`/api/public/o/${t}/push`, { clientId: 'device-gone-001', subscription: newSubscription('/gone').json });
  const c2 = new Client(base);
  await c2.post(`/api/public/o/${t}/hello`, { clientId: 'device-flaky-01' });
  await c2.post(`/api/public/o/${t}/push`, { clientId: 'device-flaky-01', subscription: newSubscription('/flaky').json });
  pushPlan['/gone'] = [410];
  pushPlan['/flaky'] = [500];
  await act(o, 'call');
  await until(async () => { const s = await get(o); return s.lastCall.pushAccepted === 1 && s.lastCall.pushFailed === 1; }, { timeout: 8000 });
  const s = await get(o);
  assert.equal(s.notify.expiredSubscriptions, 1);
  assert.equal(s.notify.activeSubscriptions, 1);
  const attempts = await app.pool.query(`SELECT d.attempts, s.endpoint FROM deliveries d JOIN push_subscriptions s ON s.id=d.subscription_id WHERE d.order_id=$1`, [o.id]);
  assert.equal(attempts.rows.find((r) => r.endpoint.endsWith('/flaky')).attempts, 2);
  assert.equal(attempts.rows.find((r) => r.endpoint.endsWith('/gone')).attempts, 1);
  const status = await owner.get('/api/owner/status');
  assert.ok(status.data.recentErrors.length >= 1);
});

test('العميل رفض الإذن: الحالة «رفض» ولا يُدّعى وصول؛ الصفحة المفتوحة تثبت الظهور', async () => {
  const o = await create();
  const t = tokenOf(o);
  const c = new Client(base);
  await c.post(`/api/public/o/${t}/hello`, { clientId: 'device-deny-001', platform: 'android', capability: 'push', permission: 'default' });
  await c.post(`/api/public/o/${t}/viewer`, { clientId: 'device-deny-001', platform: 'android', capability: 'push', permission: 'denied' });
  let s = await get(o);
  assert.equal(s.notify.state, 'denied');
  await act(o, 'call');
  s = await get(o);
  assert.equal(s.lastCall.pushTotal, 0);
  assert.equal(s.lastCall.deviceReceipts, 0);
  assert.equal(s.lastCall.pageSeen, 0);
  const pub = (await c.get(`/api/public/o/${t}`)).data;
  assert.equal(pub.order.status, 'ready');
  await c.post(`/api/public/o/${t}/receipt`, { channel: 'page', callId: pub.order.lastCall.id, clientId: 'device-deny-001' });
  await c.post(`/api/public/o/${t}/receipt`, { channel: 'page', callId: pub.order.lastCall.id, clientId: 'device-deny-001' });
  s = await get(o);
  assert.equal(s.lastCall.pageSeen, 1);
  // العميل يؤكد قدومه
  const ack = await c.post(`/api/public/o/${t}/ack`, {});
  assert.equal(ack.status, 200);
  assert.ok((await get(o)).customer.ackAt);
});

test('آيفون بدون إضافة للشاشة الرئيسية: الحالة «غير مدعوم» بوضوح', async () => {
  const o = await create();
  const c = new Client(base);
  await c.post(`/api/public/o/${tokenOf(o)}/hello`, { clientId: 'device-iphone-1', platform: 'ios', capability: 'ios-needs-homescreen', permission: 'unknown' });
  const s = await get(o);
  assert.equal(s.notify.state, 'unsupported');
  assert.equal(s.customer.viewers[0].capability, 'ios-needs-homescreen');
});

test('تفعيل التنبيه بعد النداء يرسل النداء الحالي فورًا لهذا الجهاز', async () => {
  const o = await create();
  await act(o, 'call');
  const t = tokenOf(o);
  const c = new Client(base);
  const sub = newSubscription('/late');
  pushLog.length = 0;
  await c.post(`/api/public/o/${t}/push`, { clientId: 'device-late-001', subscription: sub.json });
  await until(() => pushLog.some((e) => e.path === '/late'));
  assert.match(decrypt(pushLog.find((e) => e.path === '/late'), sub).title, /جاهز/);
});

test('بعد التسليم أو الإلغاء يُغلق ربط التنبيه ولا يمكن الاشتراك', async () => {
  const o = await create();
  const t = tokenOf(o);
  const c = new Client(base);
  await c.post(`/api/public/o/${t}/push`, { clientId: 'device-close-01', subscription: newSubscription('/close').json });
  await act(o, 'deliver');
  const subs = await app.pool.query(`SELECT status, closed_reason FROM push_subscriptions WHERE order_id=$1`, [o.id]);
  assert.ok(subs.rows.every((r) => r.status === 'closed' && r.closed_reason === 'delivered'));
  assert.equal((await c.post(`/api/public/o/${t}/push`, { clientId: 'device-close-01', subscription: newSubscription('/close2').json })).status, 409);
});

test('تنبيه تجريبي من صفحة العميل يمر بالمسار الحقيقي ومحدود المعدل', async () => {
  const o = await create();
  const t = tokenOf(o);
  const c = new Client(base);
  const sub = newSubscription('/test-me');
  await c.post(`/api/public/o/${t}/push`, { clientId: 'device-test-001', subscription: sub.json });
  pushLog.length = 0;
  assert.equal((await c.post(`/api/public/o/${t}/push/test`, { clientId: 'device-test-001' })).status, 200);
  assert.equal(decrypt(pushLog.find((e) => e.path === '/test-me'), sub).t, 'test');
  assert.equal((await c.post(`/api/public/o/${t}/push/test`, { clientId: 'other-device-01' })).status, 409);
  await c.post(`/api/public/o/${t}/push/test`, { clientId: 'device-test-001' });
  await c.post(`/api/public/o/${t}/push/test`, { clientId: 'device-test-001' });
  assert.equal((await c.post(`/api/public/o/${t}/push/test`, { clientId: 'device-test-001' })).status, 429);
  // التنبيه التجريبي لا يُحسب نداءً
  assert.equal((await get(o)).callCount, 0);
});

test('APNs (App Clip): تنبيه + Live Activity بترويسات صحيحة وJWT موقّع، وإنهاء عند التسليم', async () => {
  const o = await create();
  const t = tokenOf(o);
  const c = new Client(base);
  const alertTok = 'ab'.repeat(32); const laTok = 'cd'.repeat(40);
  assert.equal((await c.post(`/api/public/o/${t}/apns`, { clientId: 'iphone-clip-01', platform: 'ios', type: 'alert', deviceToken: alertTok, environment: 'sandbox' })).status, 200);
  assert.equal((await c.post(`/api/public/o/${t}/apns`, { clientId: 'iphone-clip-01', platform: 'ios', type: 'liveactivity', deviceToken: laTok, environment: 'sandbox' })).status, 200);
  assert.equal((await c.post(`/api/public/o/${t}/apns`, { clientId: 'iphone-clip-01', type: 'alert', deviceToken: 'not-hex' })).status, 400);
  apnsLog.length = 0;
  await act(o, 'call');
  await until(() => apnsLog.length >= 2);
  const alert = apnsLog.find((e) => e.headers['apns-push-type'] === 'alert');
  const la = apnsLog.find((e) => e.headers['apns-push-type'] === 'liveactivity');
  assert.ok(alert.jwtValid && la.jwtValid);
  assert.equal(alert.claims.iss, 'TEAM123456');
  assert.equal(alert.headers['apns-topic'], 'com.example.nidaa.Clip');
  assert.equal(la.headers['apns-topic'], 'com.example.nidaa.Clip.push-type.liveactivity');
  assert.equal(alert.headers[':path'], `/3/device/${alertTok}`);
  assert.equal(alert.body.aps['target-content-id'], o.url);
  assert.equal(la.body.aps.event, 'update');
  assert.equal(la.body.aps['content-state'].status, 'ready');
  assert.equal(la.body.aps['content-state'].number, o.number);
  await until(async () => (await get(o)).lastCall.pushAccepted === 2);
  apnsLog.length = 0;
  await act(o, 'deliver');
  await until(() => apnsLog.length >= 1);
  assert.equal(apnsLog[0].body.aps.event, 'end');
  assert.equal(apnsLog[0].body.aps['content-state'].status, 'delivered');
});

test('APNs: رمز جهاز غير مسجل (410) يُعلَّم منتهيًا', async () => {
  const o = await create();
  const c = new Client(base);
  await c.post(`/api/public/o/${tokenOf(o)}/apns`, { clientId: 'iphone-dead-01', type: 'alert', deviceToken: 'dead0000dead0000dead0000dead0000' });
  await act(o, 'call');
  await until(async () => (await get(o)).notify.expiredSubscriptions === 1);
});

test('ملف ربط App Clip بالنطاق (AASA)', async () => {
  const r = await new Client(base).get('/.well-known/apple-app-site-association');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { appclips: { apps: ['TEAM123456.com.example.nidaa.Clip'] } });
});

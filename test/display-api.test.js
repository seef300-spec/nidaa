import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, setupShop, Client, tokenOf, createTenant } from './helpers.js';
import { runMaintenance } from '../src/services/maintenance.js';
import { businessDate } from '../src/lib/time.js';

let app, base, owner, tablet;
before(async () => {
  ({ app, base } = await startApp());
  owner = await setupShop(base);
});
after(() => app.close());

async function pairTablet(ownerClient) {
  const t = new Client(base);
  assert.equal((await t.get('/api/display/state')).status, 401);
  const start = await t.post('/api/display/pair/start', {});
  assert.equal(start.status, 200);
  assert.match(start.data.code, /^[A-Z2-9]{6}$/);
  assert.equal((await t.get('/api/display/pair/status')).data.state, 'waiting');
  const claim = await ownerClient.post('/api/owner/displays/claim', { code: start.data.code.toLowerCase(), name: 'تابلت' });
  assert.equal(claim.status, 200);
  assert.equal((await t.get('/api/display/pair/status')).data.state, 'paired');
  // الرمز يُسلَّم مرة واحدة فقط
  const replay = new Client(base); replay.cookies.set('nd_p', t.cookies.get('nd_p') || 'x');
  assert.notEqual((await replay.get('/api/display/pair/status')).data.state, 'paired');
  return { t, displayId: claim.data.display.id, code: start.data.code };
}

test('اقتران الشاشة: رمز يُدخله المالك، والرمز لا يُعاد استخدامه', async () => {
  const p = await pairTablet(owner);
  tablet = p.t;
  assert.equal((await tablet.get('/api/display/session')).data.paired, true);
  assert.equal((await owner.post('/api/owner/displays/claim', { code: p.code })).status, 404);
  assert.equal((await owner.post('/api/owner/displays/claim', { code: 'ZZZZZZ' })).status, 404);
});

test('الشاشة تعرض الطلب المختار بالتسلسل، دون بيانات داخلية، وتنتقل بعد المسح', async () => {
  assert.equal((await tablet.get('/api/display/state')).data.current, null);
  const a = (await owner.post('/api/staff/orders', { note: 'سري جدًا', externalRef: 'INV-77' })).data.order;
  const b = (await owner.post('/api/staff/orders', {})).data.order;
  let s = (await tablet.get('/api/display/state')).data;
  assert.equal(s.current.number, a.number, 'الأقدم أولًا — لا يتبدل الرمز بطلب أحدث');
  assert.equal(s.waiting, 1);
  assert.match(s.current.qrSvg, /^<svg/);
  const json = JSON.stringify(s);
  for (const secret of ['سري جدًا', 'INV-77', a.id, b.id, tokenOf(b)]) assert.ok(!json.includes(secret), secret);
  assert.equal(s.current.url, a.url);
  // الموظف يختار طلبًا صراحةً
  await owner.post(`/api/staff/orders/${b.id}/display`, { mode: 'show' });
  assert.equal((await tablet.get('/api/display/state')).data.current.number, b.number);
  // العميل يمسح ← نجاح ثم التالي
  await new Client(base).post(`/api/public/o/${tokenOf(b)}/hello`, { clientId: 'scan-device-01' });
  s = (await tablet.get('/api/display/state')).data;
  assert.equal(s.lastSuccess.number, b.number);
  assert.equal(s.current.number, a.number);
  // إخفاء
  await owner.post(`/api/staff/orders/${a.id}/display`, { mode: 'hide' });
  assert.equal((await tablet.get('/api/display/state')).data.current, null);
  // الشاشة لا تستطيع تنفيذ أي عملية موظف
  for (const p of ['/api/staff/orders', '/api/me', '/api/owner/shop']) assert.equal((await tablet.get(p)).status, 401, p);
  assert.equal((await tablet.post(`/api/staff/orders/${a.id}/call`, {})).status, 401);
});

test('التخطي التلقائي فقط عند وجود طلبات تنتظر', async () => {
  const x = (await owner.post('/api/staff/orders', {})).data.order;
  await tablet.get('/api/display/state');
  await app.pool.query(`UPDATE orders SET display_shown_at = now() - interval '1 hour' WHERE id=$1`, [x.id]);
  await runMaintenance(app, { purge: false });
  assert.equal((await tablet.get('/api/display/state')).data.current.number, x.number, 'لا تخطٍّ والطلب وحيد');
  const y = (await owner.post('/api/staff/orders', {})).data.order;
  await runMaintenance(app, { purge: false });
  assert.equal((await tablet.get('/api/display/state')).data.current.number, y.number);
});

test('إلغاء اقتران الشاشة يقطع وصولها فورًا', async () => {
  const p = await pairTablet(owner);
  assert.equal((await p.t.get('/api/display/state')).status, 200);
  assert.equal((await owner.del(`/api/owner/displays/${p.displayId}`)).status, 200);
  assert.equal((await p.t.get('/api/display/state')).status, 401);
});

test('شاشة محل آخر لا ترى طلبات هذا المحل', async () => {
  const other = await createTenant(app, base, { shop: 'آخر', username: 'other2', password: 'other-pass-2' });
  const p = await pairTablet(other.client);
  const s = (await p.t.get('/api/display/state')).data;
  assert.equal(s.current, null);
  assert.equal(s.shop.name, 'آخر');
  assert.equal((await other.client.del(`/api/owner/displays/${(await owner.get('/api/owner/displays')).data.displays[0].id}`)).status, 404);
});

test('واجهة API للكاشير: مفاتيح بصلاحيات، منع تكرار بمعرف خارجي، وإلغاء المفتاح', async () => {
  const k = await owner.post('/api/owner/api-keys', { name: 'الكاشير' });
  assert.equal(k.status, 200);
  const key = k.data.key.key;
  const pos = new Client(base, { csrf: false });
  const auth = { authorization: `Bearer ${key}` };
  const c1 = await pos.post('/api/v1/orders', { externalId: 'POS-1001', externalRef: '1001' }, auth);
  assert.equal(c1.status, 201);
  const c2 = await pos.post('/api/v1/orders', { externalId: 'POS-1001', externalRef: '1001' }, auth);
  assert.equal(c2.status, 200);
  assert.equal(c2.data.duplicate, true);
  assert.equal(c2.data.order.id, c1.data.order.id);
  const look = await pos.get('/api/v1/orders?externalId=POS-1001', auth);
  assert.equal(look.data.order.id, c1.data.order.id);
  assert.equal(look.data.order.createdVia, 'api');
  const ready = await pos.post(`/api/v1/orders/${c1.data.order.id}/ready`, {}, { ...auth, 'idempotency-key': 'pos-ready-1001' });
  assert.equal(ready.status, 200);
  assert.equal(ready.data.order.status, 'ready');
  const again = await pos.post(`/api/v1/orders/${c1.data.order.id}/ready`, {}, { ...auth, 'idempotency-key': 'pos-ready-1001' });
  assert.equal(again.status, 200);
  assert.equal(again.headers.get('idempotent-replayed'), 'true');
  assert.equal((await pos.post(`/api/v1/orders/${c1.data.order.id}/bogus`, {}, auth)).status, 400);
  // مفتاح خاطئ
  assert.equal((await pos.get('/api/v1/orders?externalId=POS-1001', { authorization: `Bearer ${key.slice(0, -2)}xx` })).status, 401);
  // يظهر في سجل الإجراءات باسم المفتاح
  const ev = (await owner.get(`/api/staff/orders/${c1.data.order.id}/events`)).data.events;
  assert.ok(ev.every((e) => e.actor_label === 'API: الكاشير'));
  // مفتاح بصلاحية قراءة فقط
  const ro = (await owner.post('/api/owner/api-keys', { name: 'قراءة', scopes: ['orders:read'] })).data.key.key;
  assert.equal((await pos.post('/api/v1/orders', {}, { authorization: `Bearer ${ro}` })).status, 403);
  // إلغاء
  await owner.del(`/api/owner/api-keys/${k.data.key.id}`);
  assert.equal((await pos.get('/api/v1/orders?externalId=POS-1001', auth)).status, 401);
  // توثيق OpenAPI متاح
  const spec = await pos.get('/api/v1/openapi.json');
  assert.equal(spec.data.openapi, '3.0.3');
});

test('حساب اليوم التشغيلي حسب توقيت الفرع وساعة البداية', () => {
  // 2026-10-24 00:30 بتوقيت الرياض = 2026-10-23 21:30 UTC
  const t = new Date('2026-10-23T21:30:00Z');
  assert.equal(businessDate(t, 'Asia/Riyadh', 4), '2026-10-23', 'بعد منتصف الليل وقبل 4 فجرًا يتبع اليوم السابق');
  assert.equal(businessDate(t, 'Asia/Riyadh', 0), '2026-10-24');
  assert.equal(businessDate(new Date('2026-10-24T01:30:00Z'), 'Asia/Riyadh', 4), '2026-10-24');
  assert.equal(businessDate(t, 'UTC', 0), '2026-10-23');
});

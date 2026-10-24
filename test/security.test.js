import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, setupShop, Client, tokenOf, login, createTenant } from './helpers.js';

let app, base, owner, staff, other;
before(async () => {
  ({ app, base } = await startApp());
  owner = await setupShop(base);
  await owner.post('/api/owner/users', { name: 'موظف', username: 'staff1', password: 'staff-pass-1' });
  staff = await login(base, 'staff1', 'staff-pass-1');
  other = await createTenant(app, base, { shop: 'محل آخر', username: 'other', password: 'other-pass-1' });
});
after(() => app.close());

const STAFF_GETS = ['/api/me', '/api/staff/orders', '/api/staff/display', '/api/owner/shop', '/api/owner/users', '/api/owner/displays', '/api/owner/status', '/api/owner/api-keys', '/api/owner/onboarding'];

test('زائر غير مسجل لا يصل لأي واجهة إدارية', async () => {
  const anon = new Client(base);
  for (const p of STAFF_GETS) assert.equal((await anon.get(p)).status, 401, p);
  const o = (await owner.post('/api/staff/orders', {})).data.order;
  for (const a of ['call', 'recall', 'deliver', 'cancel', 'undo_deliver', 'display']) {
    assert.equal((await anon.post(`/api/staff/orders/${o.id}/${a}`, { mode: 'show' })).status, 401, a);
  }
  assert.equal((await anon.post('/api/staff/orders', {})).status, 401);
  assert.equal((await anon.get(`/api/staff/orders/${o.id}/qr.svg`)).status, 401);
  assert.equal((await anon.put('/api/owner/shop', { name: 'x' })).status, 401);
  assert.equal((await anon.post('/api/owner/users', { name: 'x', username: 'hacker', password: '12345678' })).status, 401);
  assert.equal((await anon.post('/api/owner/displays/claim', { code: 'ABCDEF' })).status, 401);
  // صفحات الواجهة المحمية تحوّل لتسجيل الدخول
  for (const p of ['/staff', '/staff/settings', `/staff/print/${o.id}`]) {
    const r = await anon.get(p);
    assert.equal(r.status, 302, p);
    assert.equal(r.headers.get('location'), '/login');
  }
  // كوكي مزور
  const forged = new Client(base); forged.cookies.set('nd_s', 'A'.repeat(43));
  assert.equal((await forged.get('/api/me')).status, 401);
});

test('العميل برابطه لا يرى طلبًا آخر ولا ينفذ عمليات إدارية', async () => {
  const a = (await owner.post('/api/staff/orders', { note: 'سري', externalRef: 'INV-9' })).data.order;
  const b = (await owner.post('/api/staff/orders', {})).data.order;
  const cust = new Client(base);
  const v = await cust.get(`/api/public/o/${tokenOf(a)}`);
  assert.equal(v.status, 200);
  const json = JSON.stringify(v.data);
  assert.ok(!json.includes('سري'), 'لا تظهر الملاحظة الداخلية');
  assert.ok(!json.includes('INV-9'), 'لا يظهر رقم الفاتورة');
  assert.ok(!json.includes(a.id), 'لا يظهر المعرّف الداخلي');
  assert.ok(!json.includes(tokenOf(b)), 'لا يظهر رمز طلب آخر');
  assert.equal(v.data.order.number, a.number);
  // رمز العميل لا يفتح أي واجهة موظف
  for (const p of STAFF_GETS) assert.equal((await cust.get(p, { authorization: `Bearer ${tokenOf(a)}` })).status, 401, p);
  assert.equal((await cust.post(`/api/staff/orders/${a.id}/call`, {})).status, 401);
  assert.equal((await cust.post(`/api/v1/orders/${a.id}/ready`, {}, { authorization: `Bearer ${tokenOf(a)}` })).status, 401);
  // العميل لا يستطيع تغيير الحالة من الواجهة العامة
  assert.equal((await cust.post(`/api/public/o/${tokenOf(a)}/ack`, {})).status, 409);
  // رموز غير صالحة أو مخمّنة
  assert.equal((await cust.get('/api/public/o/AAAAAAAAAAAAAAAAAAAAAAAA')).status, 404);
  assert.equal((await cust.get(`/api/public/o/${tokenOf(a).slice(0, 23)}x`)).status, 404);
  assert.equal((await cust.get("/api/public/o/' OR 1=1 --")).status, 404);
});

test('عزل المحلات والفروع: لا قراءة ولا تعديل عبر المستأجرين', async () => {
  const mine = (await owner.post('/api/staff/orders', {})).data.order;
  const theirs = (await other.client.post('/api/staff/orders', {})).data.order;
  const oc = other.client;
  assert.equal((await oc.get(`/api/staff/orders/${mine.id}`)).status, 404);
  assert.equal((await oc.get(`/api/staff/orders/${mine.id}/events`)).status, 404);
  assert.equal((await oc.get(`/api/staff/orders/${mine.id}/qr.svg`)).status, 404);
  for (const a of ['call', 'deliver', 'cancel']) assert.equal((await oc.post(`/api/staff/orders/${mine.id}/${a}`, {})).status, 404, a);
  assert.equal((await oc.post(`/api/staff/orders/${mine.id}/display`, { mode: 'show' })).status, 404);
  const list = await oc.get('/api/staff/orders?filter=all&limit=200');
  assert.ok(list.data.orders.every((o) => o.id !== mine.id));
  assert.ok(list.data.orders.some((o) => o.id === theirs.id));
  const myList = await owner.get('/api/staff/orders?filter=all&limit=200');
  assert.ok(myList.data.orders.every((o) => o.id !== theirs.id));
  // الطلب لم يتغير
  assert.equal((await owner.get(`/api/staff/orders/${mine.id}`)).data.order.status, 'preparing');
  // المستخدمون والإعدادات
  const users = await oc.get('/api/owner/users');
  assert.ok(users.data.users.every((u) => u.username !== 'owner' && u.username !== 'staff1'));
  const ownerUsers = (await owner.get('/api/owner/users')).data.users;
  const staffId = ownerUsers.find((u) => u.username === 'staff1').id;
  assert.equal((await oc.put(`/api/owner/users/${staffId}`, { active: false })).status, 404);
  // تبديل فرع لا يملكه
  assert.equal((await oc.post('/api/me/branch', { branchId: (await owner.get('/api/me')).data.branch.id })).status, 403);
});

test('صلاحيات الموظف مقابل المالك', async () => {
  for (const p of ['/api/owner/shop', '/api/owner/users', '/api/owner/displays', '/api/owner/status', '/api/owner/api-keys']) {
    assert.equal((await staff.get(p)).status, 403, p);
  }
  assert.equal((await staff.post('/api/owner/users', { name: 'x', username: 'evil', password: '12345678', role: 'owner' })).status, 403);
  assert.equal((await staff.put('/api/owner/branch', { name: 'x' })).status, 403);
  assert.equal((await staff.post('/api/owner/displays/claim', { code: 'ABCDEF' })).status, 403);
  // الموظف يدير الطلبات
  const o = (await staff.post('/api/staff/orders', {})).data.order;
  assert.equal((await staff.post(`/api/staff/orders/${o.id}/call`, { expectedVersion: o.version })).status, 200);
});

test('إيقاف حساب الموظف يُنهي جلساته فورًا', async () => {
  await owner.post('/api/owner/users', { name: 'مؤقت', username: 'temp1', password: 'temp-pass-1' });
  const t = await login(base, 'temp1', 'temp-pass-1');
  assert.equal((await t.get('/api/me')).status, 200);
  const id = (await owner.get('/api/owner/users')).data.users.find((u) => u.username === 'temp1').id;
  await owner.put(`/api/owner/users/${id}`, { active: false });
  assert.equal((await t.get('/api/me')).status, 401);
  assert.equal((await new Client(base).post('/api/auth/login', { username: 'temp1', password: 'temp-pass-1' })).status, 401);
});

test('حماية الطلبات المزورة (CSRF): بلا ترويسة أو من أصل آخر', async () => {
  const noHeader = new Client(base, { csrf: false });
  noHeader.cookies = owner.cookies;
  assert.equal((await noHeader.post('/api/staff/orders', {})).status, 403);
  assert.equal((await owner.post('/api/staff/orders', {}, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await owner.post('/api/staff/orders', {}, { origin: base })).status, 201);
  // الكوكيز HttpOnly و SameSite=Strict
  const r = await new Client(base).post('/api/auth/login', { username: 'owner', password: 'owner-pass-1' });
  const sc = r.headers.getSetCookie().join(';');
  assert.match(sc, /HttpOnly/i);
  assert.match(sc, /SameSite=Strict/i);
});

test('تسجيل الدخول: رسالة موحدة، وقفل بعد محاولات خاطئة، وتحديد معدل', async () => {
  const c = new Client(base);
  const a = await c.post('/api/auth/login', { username: 'nouser', password: 'x' });
  const b = await c.post('/api/auth/login', { username: 'staff1', password: 'wrong' });
  assert.equal(a.status, 401); assert.equal(b.status, 401);
  assert.equal(a.data.error.message, b.data.error.message);
  for (let i = 0; i < 8; i++) await c.post('/api/auth/login', { username: 'staff1', password: 'wrong' });
  const locked = await c.post('/api/auth/login', { username: 'staff1', password: 'staff-pass-1' });
  assert.ok([423, 429].includes(locked.status), String(locked.status));
  await app.pool.query(`UPDATE users SET locked_until=NULL, failed_logins=0 WHERE username='staff1'`);
});

test('الإعداد الأول لا يتكرر، ويتطلب رمزًا عند النشر العام', async () => {
  const r = await new Client(base).post('/api/setup', { shopName: 'x', username: 'zz1', password: '12345678', setupToken: '' });
  assert.equal(r.status, 409);
  // نسخة HTTPS بدون رمز إعداد
  const { startApp: s2, TEST_DB2 } = await import('./helpers.js');
  const { app: app2, base: base2 } = await s2({ publicUrl: 'https://nidaa.example', setupToken: 'secret-setup-token' }, { db: TEST_DB2 });
  try {
    const c = new Client(base2);
    assert.equal((await c.get('/api/setup/status')).data.tokenRequired, true);
    assert.equal((await c.post('/api/setup', { shopName: 'x', username: 'own', password: '12345678', setupToken: 'wrong' })).status, 403);
    assert.equal((await c.post('/api/setup', { shopName: 'x', username: 'own', password: '12345678', setupToken: 'secret-setup-token' })).status, 200);
  } finally { await app2.close(); }
});

test('اشتراك التنبيه لا يقبل عناوين داخلية (منع SSRF)', async () => {
  const o = (await owner.post('/api/staff/orders', {})).data.order;
  const c = new Client(base);
  const t = tokenOf(o);
  await c.post(`/api/public/o/${t}/hello`, { clientId: 'client-ssrf-1', platform: 'android' });
  for (const endpoint of ['http://169.254.169.254/latest', 'https://localhost:5432/x', 'https://evil.example/push', 'file:///etc/passwd']) {
    const r = await c.post(`/api/public/o/${t}/push`, { clientId: 'client-ssrf-1', subscription: { endpoint, keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } } });
    assert.equal(r.status, 400, endpoint);
  }
  const ok = await c.post(`/api/public/o/${t}/push`, { clientId: 'client-ssrf-1', subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } } });
  assert.equal(ok.status, 200);
});

test('ترويسات الأمان وعدم تسريب الرمز في السجلات', async () => {
  const r = await new Client(base).get('/login');
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  const { redactUrl } = await import('../src/app.js');
  assert.equal(redactUrl('/api/public/o/AbCdEfGhIjKlMnOpQrStUvWx/hello'), '/api/public/o/AbCd…/hello');
  assert.equal(redactUrl('/o/AbCdEfGhIjKlMnOpQrStUvWx'), '/o/AbCd…');
});

test('الشعار: يُقبل PNG ويُرفض SVG أو المحتوى المزيف', async () => {
  const png1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  assert.equal((await owner.put('/api/owner/shop/logo', { dataUrl: `data:image/png;base64,${png1x1}` })).status, 200);
  assert.equal((await owner.put('/api/owner/shop/logo', { dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' })).status, 400);
  assert.equal((await owner.put('/api/owner/shop/logo', { dataUrl: `data:image/png;base64,${Buffer.from('<script>alert(1)</script>').toString('base64')}` })).status, 400);
  const shop = (await owner.get('/api/owner/shop')).data.shop;
  const img = await fetch(base + shop.logoUrl);
  assert.equal(img.headers.get('content-type'), 'image/png');
});

test('عزل الفروع داخل المحل نفسه: موظف فرع لا يرى فرعًا آخر', async () => {
  const nb = await owner.post('/api/owner/branches', { name: 'فرع 2' });
  assert.equal(nb.status, 200);
  const b2 = nb.data.branch.id;
  assert.equal((await staff.post('/api/me/branch', { branchId: b2 })).status, 403);
  const b1 = (await owner.get('/api/me')).data.branch.id;
  assert.equal((await owner.post('/api/me/branch', { branchId: b2 })).status, 200);
  const o = (await owner.post('/api/staff/orders', {})).data.order;
  assert.equal(o.number, 1, 'ترقيم مستقل لكل فرع');
  assert.equal((await staff.get(`/api/staff/orders/${o.id}`)).status, 404);
  assert.equal((await staff.post(`/api/staff/orders/${o.id}/call`, {})).status, 404);
  assert.ok((await staff.get('/api/staff/orders?filter=all&limit=200')).data.orders.every((x) => x.id !== o.id));
  await owner.post('/api/me/branch', { branchId: b1 });
});

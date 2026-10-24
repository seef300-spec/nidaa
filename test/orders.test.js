import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, setupShop, Client, tokenOf, login } from './helpers.js';
import { runMaintenance } from '../src/services/maintenance.js';

let app, base, owner, staff2;
const create = (c, body = {}, key) => c.post('/api/staff/orders', body, key ? { 'idempotency-key': key } : {});
const act = (c, o, action, extra = {}, key) => c.post(`/api/staff/orders/${o.id}/${action}`, { expectedVersion: o.version, ...extra }, key ? { 'idempotency-key': key } : {});

before(async () => {
  ({ app, base } = await startApp());
  owner = await setupShop(base);
  const r = await owner.post('/api/owner/users', { name: 'سارة', username: 'sara', password: 'sara-pass-1' });
  assert.equal(r.status, 200);
  staff2 = await login(base, 'sara', 'sara-pass-1');
});
after(() => app.close());

test('إنشاء طلب: رقم تلقائي متسلسل ورابط عشوائي ورقم مرجعي وملاحظة', async () => {
  const a = await create(owner, { externalRef: 'INV-1', note: 'بدون سكر' });
  const b = await create(owner);
  assert.equal(a.status, 201);
  assert.equal(a.data.order.status, 'preparing');
  assert.equal(b.data.order.number, a.data.order.number + 1);
  assert.equal(a.data.order.externalRef, 'INV-1');
  assert.equal(a.data.order.note, 'بدون سكر');
  assert.match(tokenOf(a.data.order), /^[A-Za-z0-9_-]{24}$/);
  assert.notEqual(tokenOf(a.data.order), tokenOf(b.data.order));
  assert.notEqual(a.data.order.id, String(a.data.order.number));
});

test('منع التكرار: إعادة إرسال نفس الطلب الشبكي لا تنشئ طلبًا ثانيًا', async () => {
  const key = 'create-key-0001';
  const before = (await owner.get('/api/staff/orders?filter=all&limit=200')).data.orders.length;
  const [r1, r2, r3] = await Promise.all([create(owner, { note: 'x' }, key), create(owner, { note: 'x' }, key), create(owner, { note: 'x' }, key)]);
  assert.deepEqual([r1.status, r2.status, r3.status].sort(), [201, 201, 201]);
  assert.equal(r1.data.order.id, r2.data.order.id);
  assert.equal(r2.data.order.id, r3.data.order.id);
  const after = (await owner.get('/api/staff/orders?filter=all&limit=200')).data.orders.length;
  assert.equal(after, before + 1);
  // نفس المفتاح لمحتوى مختلف مرفوض
  const bad = await create(owner, { note: 'مختلف' }, key);
  assert.equal(bad.status, 422);
});

test('تزامن: إنشاء 25 طلبًا في نفس اللحظة من موظفين يعطي أرقامًا فريدة متتالية', async () => {
  const rs = await Promise.all(Array.from({ length: 25 }, (_, i) => create(i % 2 ? owner : staff2)));
  assert.ok(rs.every((r) => r.status === 201));
  const nums = rs.map((r) => r.data.order.number).sort((x, y) => x - y);
  assert.equal(new Set(nums).size, 25);
  assert.equal(nums[24] - nums[0], 24);
});

test('دورة الحياة: نداء ← إعادة نداء بفاصل ← تسليم، مع السجل والأوقات', async () => {
  let o = (await create(owner)).data.order;
  const call = await act(owner, o, 'call');
  assert.equal(call.status, 200);
  o = call.data.order;
  assert.equal(o.status, 'ready');
  assert.equal(o.callCount, 1);
  assert.ok(o.readyAt && o.lastCalledAt);
  // إعادة النداء مباشرة ممنوعة بفاصل
  const early = await act(owner, o, 'recall');
  assert.equal(early.status, 429);
  assert.ok(early.headers.get('retry-after'));
  // نتجاوز الفاصل
  await app.pool.query(`UPDATE orders SET last_called_at = now() - interval '5 minutes' WHERE id=$1`, [o.id]);
  const rc = await act(owner, o, 'recall');
  assert.equal(rc.status, 200);
  assert.equal(rc.data.order.callCount, 2);
  assert.equal(rc.data.order.status, 'ready');
  o = rc.data.order;
  const del = await act(owner, o, 'deliver');
  assert.equal(del.status, 200);
  assert.equal(del.data.order.status, 'delivered');
  assert.ok(del.data.order.deliveredAt);
  const ev = (await owner.get(`/api/staff/orders/${o.id}/events`)).data.events.map((e) => e.action);
  assert.deepEqual(ev, ['create', 'call', 'recall', 'deliver']);
  const actors = (await owner.get(`/api/staff/orders/${o.id}/events`)).data.events.map((e) => e.actor_label);
  assert.ok(actors.every((a) => a === 'المالك'));
});

test('انتقالات غير مسموحة تُرفض في الخادم', async () => {
  let o = (await create(owner)).data.order;
  assert.equal((await act(owner, o, 'recall')).status, 409); // لا إعادة نداء قبل النداء
  o = (await act(owner, o, 'cancel')).data.order;
  assert.equal(o.status, 'cancelled');
  for (const a of ['call', 'recall', 'deliver', 'cancel']) assert.equal((await act(owner, o, a)).status, 409, a);
  assert.equal((await owner.post(`/api/staff/orders/${o.id}/hack`, {})).status, 400);
  let d = (await create(owner)).data.order;
  d = (await act(owner, d, 'call')).data.order;
  d = (await act(owner, d, 'deliver')).data.order;
  for (const a of ['call', 'recall', 'cancel', 'deliver']) assert.equal((await act(owner, d, a)).status, 409, a);
});

test('تسليم مباشر بدون جوال: قيد التجهيز ← مسلّم', async () => {
  const o = (await create(owner)).data.order;
  const r = await act(owner, o, 'deliver');
  assert.equal(r.status, 200);
  assert.equal(r.data.order.status, 'delivered');
  assert.equal(r.data.order.callCount, 0);
});

test('التراجع عن التسليم خلال المهلة فقط', async () => {
  let o = (await create(owner)).data.order;
  o = (await act(owner, o, 'call')).data.order;
  o = (await act(owner, o, 'deliver')).data.order;
  const u = await act(owner, o, 'undo_deliver');
  assert.equal(u.status, 200);
  assert.equal(u.data.order.status, 'ready');
  o = (await act(owner, u.data.order, 'deliver')).data.order;
  await app.pool.query(`UPDATE orders SET delivered_at = now() - interval '10 minutes' WHERE id=$1`, [o.id]);
  assert.equal((await act(owner, o, 'undo_deliver')).status, 409);
});

test('تزامن موظفين: نداء متزامن لنفس الطلب ينجح مرة واحدة فقط', async () => {
  const o = (await create(owner)).data.order;
  const rs = await Promise.all([act(owner, o, 'call'), act(staff2, o, 'call'), act(owner, o, 'call', {}, 'k-call-a-1'), act(staff2, o, 'call', {}, 'k-call-b-1')]);
  const ok = rs.filter((r) => r.status === 200);
  assert.equal(ok.length, 1, JSON.stringify(rs.map((r) => r.status)));
  assert.ok(rs.filter((r) => r.status !== 200).every((r) => r.status === 409));
  const calls = await app.pool.query('SELECT count(*)::int n FROM calls WHERE order_id=$1', [o.id]);
  assert.equal(calls.rows[0].n, 1);
  // الطرف الخاسر يحصل على الحالة الحالية لتحديث شاشته
  assert.ok(rs.find((r) => r.status === 409).data.error.order);
});

test('تعارض النسخة: موظف يلغي بينما الآخر سلّم', async () => {
  const o = (await create(owner)).data.order;
  const d = await act(owner, o, 'deliver');
  assert.equal(d.status, 200);
  const c = await act(staff2, o, 'cancel');
  assert.equal(c.status, 409);
  assert.equal(c.data.error.code, 'version_conflict');
});

test('النقر المتكرر بنفس المفتاح على «نداء» لا ينشئ نداءين', async () => {
  const o = (await create(owner)).data.order;
  const key = 'dbl-click-call-1';
  const [a, b] = await Promise.all([act(owner, o, 'call', {}, key), act(owner, o, 'call', {}, key)]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(a.data.order.callCount, 1); assert.equal(b.data.order.callCount, 1);
  const calls = await app.pool.query('SELECT count(*)::int n FROM calls WHERE order_id=$1', [o.id]);
  assert.equal(calls.rows[0].n, 1);
});

test('اليوم التشغيلي: الترقيم يبدأ من 1 يوميًا دون خلط مع طلب سابق بنفس الرقم', async () => {
  const branch = (await owner.get('/api/me')).data.branch.id;
  // نحوّل كل الطلبات الحالية لأمس
  await app.pool.query(`UPDATE orders SET business_date = business_date - 1 WHERE branch_id=$1`, [branch]);
  await app.pool.query(`UPDATE order_counters SET business_date = business_date - 1 WHERE branch_id=$1`, [branch]);
  const n1 = (await create(owner)).data.order;
  assert.equal(n1.number, 1);
  const list = await owner.get('/api/staff/orders?filter=all&q=1&limit=50');
  const ones = list.data.orders.filter((o) => o.number === 1);
  assert.ok(ones.length >= 2, 'يجب أن يوجد طلبان برقم 1 في يومين مختلفين');
  assert.equal(new Set(ones.map((o) => o.businessDate)).size, ones.length);
  assert.notEqual(ones[0].id, ones[1].id);
  // البحث مقيد بتاريخ
  const today = list.data.today;
  const onlyToday = await owner.get(`/api/staff/orders?filter=all&q=1&date=${today}`);
  assert.ok(onlyToday.data.orders.every((o) => o.businessDate === today));
  // الطلبات النشطة من الأمس تظهر في قائمة النشطة (لا تُخفى)
  const active = await owner.get('/api/staff/orders?filter=active&limit=200');
  assert.ok(active.data.orders.some((o) => o.businessDate !== today));
});

test('الطلبات المهجورة تنتهي تلقائيًا وتُغلق الروابط بعد المهلة', async () => {
  const o = (await create(owner)).data.order;
  await app.pool.query(`UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id=$1`, [o.id]);
  const r = await runMaintenance(app);
  assert.ok(r.expired >= 1);
  const got = (await owner.get(`/api/staff/orders/${o.id}`)).data.order;
  assert.equal(got.status, 'cancelled');
  assert.equal(got.cancelReason, 'expired');
  const pub = new Client(base, { csrf: false });
  const v = await pub.get(`/api/public/o/${tokenOf(o)}`);
  assert.equal(v.data.order.status, 'cancelled');
  assert.equal(v.data.order.cancelReason, 'expired');
  await app.pool.query(`UPDATE orders SET link_expires_at = now() - interval '1 minute' WHERE id=$1`, [o.id]);
  assert.equal((await pub.get(`/api/public/o/${tokenOf(o)}`)).status, 410);
});

test('سياسة الاحتفاظ: حذف الطلبات الأقدم من المدة', async () => {
  const o = (await create(owner)).data.order;
  await app.pool.query(`UPDATE orders SET created_at = now() - interval '200 days' WHERE id=$1`, [o.id]);
  const r = await runMaintenance(app);
  assert.ok(r.purged >= 1);
  assert.equal((await owner.get(`/api/staff/orders/${o.id}`)).status, 404);
});

test('ترقيم الصفحات والبحث مع كثرة الطلبات: لا حد صامت ولا تكرار', async () => {
  const branch = (await owner.get('/api/me')).data.branch.id;
  await app.pool.query(
    `INSERT INTO orders(tenant_id, branch_id, business_date, number, public_token, status, expires_at, link_expires_at, external_ref, created_at)
     SELECT b.tenant_id, b.id, DATE '2025-01-01', g, md5(random()::text || g)::text, 'delivered', now(), now(), 'R' || g, now() - make_interval(secs => g)
       FROM branches b, generate_series(1, 1500) g WHERE b.id=$1`, [branch]);
  await app.pool.query(`UPDATE orders SET public_token = substr(replace(public_token, '-', ''), 1, 24) WHERE business_date = DATE '2025-01-01'`);
  const seen = new Set(); let cursor = null; let pages = 0;
  do {
    const r = await owner.get(`/api/staff/orders?filter=all&date=2025-01-01&limit=200${cursor ? `&cursor=${cursor}` : ''}`);
    assert.equal(r.status, 200);
    for (const o of r.data.orders) { assert.ok(!seen.has(o.id)); seen.add(o.id); }
    cursor = r.data.nextCursor; pages++;
  } while (cursor);
  assert.equal(seen.size, 1500);
  assert.equal(pages, 8);
  const s = await owner.get('/api/staff/orders?filter=all&q=R1499');
  assert.equal(s.data.orders.length, 1);
  assert.equal(s.data.orders[0].externalRef, 'R1499');
  const n = await owner.get('/api/staff/orders?filter=all&q=777&date=2025-01-01');
  assert.equal(n.data.orders.length, 1);
  assert.equal(n.data.orders[0].number, 777);
  assert.equal((await owner.get('/api/staff/orders?cursor=garbage')).status, 400);
  assert.equal((await owner.get('/api/staff/orders?filter=bogus')).status, 400);
});

test('التحقق من المدخلات', async () => {
  assert.equal((await create(owner, { externalRef: 'x'.repeat(41) })).status, 400);
  assert.equal((await create(owner, { note: 'x'.repeat(301) })).status, 400);
  assert.equal((await create(owner, { note: { $ne: 1 } })).status, 400);
  assert.equal((await create(owner, {}, 'short')).status, 400);
  assert.equal((await owner.get('/api/staff/orders/not-a-uuid')).status, 404);
});

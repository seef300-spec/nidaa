// حالات استثنائية بمتصفح حقيقي: انقطاع الشبكة، النقر المتكرر، تعارض موظفين، إعادة التحميل، الشاشات الصغيرة
const { chromium, devices } = require('playwright');
const assert = require('assert/strict');
const BASE = process.env.BASE || 'http://localhost:3100';
const OUT = process.env.OUT || '/tmp/shots';
const results = [];
const errors = [];
function watch(page, name) {
  page.on('pageerror', (e) => errors.push(`[${name}] ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 500) errors.push(`[${name}] HTTP ${r.status()} ${r.url()}`); });
}
async function step(name, fn) {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message.split('\n')[0]]); }
}
const countOrders = (page) => page.evaluate(async () => (await (await fetch('/api/staff/orders?filter=all&limit=200')).json()).orders.length);

(async () => {
  const browser = await chromium.launch();
  const ctxA = await browser.newContext({ viewport: { width: 1366, height: 768 }, locale: 'ar' });
  const A = await ctxA.newPage(); watch(A, 'staffA');
  // إعداد عبر الواجهة البرمجية
  const s = await ctxA.request.post(`${BASE}/api/setup`, { headers: { 'x-nidaa': '1' }, data: { shopName: 'مقهى الحافة', username: 'owner', password: 'owner-pass-1', ownerName: 'م', pickupInstructions: 'النافذة' } });
  assert.equal(s.status(), 200);
  await ctxA.request.post(`${BASE}/api/owner/users`, { headers: { 'x-nidaa': '1' }, data: { name: 'ب', username: 'staffb', password: 'staffb-pass1' } });
  await A.goto(`${BASE}/staff`);
  await A.waitForSelector('.board.cols');

  await step('النقر المتكرر السريع على «طلب جديد» ينشئ طلبًا واحدًا لكل ضغطة مقبولة', async () => {
    const before = await countOrders(A);
    await A.click('#createBtn', { clickCount: 1 });
    await A.click('#createBtn', { force: true }).catch(() => {});
    await A.click('#createBtn', { force: true }).catch(() => {});
    await A.waitForTimeout(1200);
    const after = await countOrders(A);
    assert.ok(after - before <= 3 && after - before >= 1);
    // لا تكرار أثناء انشغال الزر: ضغطات خلال الطلب نفسه تُتجاهل
    await A.evaluate(() => { const b = document.querySelector('#createBtn'); b.click(); b.click(); b.click(); });
    await A.waitForTimeout(1200);
    assert.equal(await countOrders(A), after + 1);
  });

  await step('انقطاع الإنترنت أثناء الإنشاء: لا نجاح كاذب، ثم إنشاء طلب واحد عند العودة', async () => {
    const before = await countOrders(A);
    await ctxA.setOffline(true);
    await A.click('#createBtn');
    await A.waitForSelector('.toast.error', { timeout: 15000 });
    await A.screenshot({ path: `${OUT}/e1-offline-create.png` });
    await ctxA.setOffline(false);
    await A.waitForTimeout(1500);
    assert.equal(await countOrders(A), before, 'لم يُنشأ شيء أثناء الانقطاع');
    await A.click('#createBtn');
    await A.waitForTimeout(1200);
    assert.equal(await countOrders(A), before + 1);
  });

  await step('مؤشر الاتصال يتحول عند الانقطاع ويعود تلقائيًا', async () => {
    await ctxA.setOffline(true);
    await A.waitForSelector('#conn[data-state=offline], #conn[data-state=connecting]', { timeout: 10000 });
    await A.waitForSelector('#offlineBanner:not([hidden])', { timeout: 10000 }).catch(() => {});
    await A.screenshot({ path: `${OUT}/e2-offline-indicator.png` });
    await ctxA.setOffline(false);
    await A.waitForSelector('#conn[data-state=live]', { timeout: 20000 });
  });

  // موظف ثانٍ
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ar' });
  const B = await ctxB.newPage(); watch(B, 'staffB');
  await B.goto(`${BASE}/login`);
  await B.fill('#username', 'staffb'); await B.fill('#password', 'staffb-pass1');
  await B.click('#submit');
  await B.waitForSelector('.board.cols');

  await step('تزامن موظفين: الطلب الذي ينشئه أحدهما يظهر عند الآخر لحظيًا', async () => {
    const n = await B.locator('.order').count();
    await A.click('#createBtn');
    await B.waitForFunction((n0) => document.querySelectorAll('.order').length > n0, n, { timeout: 5000 });
  });

  await step('تعارض: موظف يضغط «تسليم» على نسخة قديمة بعد أن نادى الآخر — رفض واضح دون حالة متضاربة', async () => {
    const id = await A.evaluate(async () => (await (await fetch('/api/staff/orders?filter=preparing')).json()).orders[0].id);
    // A يفتح تأكيد «تسليم مباشر» (نسخته الحالية 1)
    await A.locator(`.order[data-id="${id}"] [aria-haspopup=menu]`).click();
    await A.locator(`.order[data-id="${id}"] .menu-pop button`, { hasText: 'تسليم مباشر' }).click();
    // في هذه الأثناء B ينادي الطلب
    const st = await B.evaluate(async (oid) => (await fetch(`/api/staff/orders/${oid}/call`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nidaa': '1' }, body: JSON.stringify({ expectedVersion: 1 }) })).status, id);
    assert.equal(st, 200);
    await A.click('dialog.modal [data-ok]');
    const t = A.locator('.toast.error', { hasText: /تغيّر|جهاز آخر|نداء/ });
    await t.first().waitFor({ timeout: 5000 }).catch(async () => { throw new Error('toasts: ' + (await A.locator('.toast').allTextContents()).join(' | ')); });
    await A.screenshot({ path: `${OUT}/e0-conflict.png` });
    const o = await A.evaluate(async (oid) => (await (await fetch(`/api/staff/orders/${oid}`)).json()).order, id);
    assert.equal(o.status, 'ready');
    assert.equal(o.callCount, 1);
    await A.waitForSelector(`.order[data-id="${id}"].s-ready`, { timeout: 5000 });
  });

  await step('إعادة تحميل لوحة الموظف تحافظ على البيانات من الخادم', async () => {
    const n = await A.locator('.order').count();
    await A.reload();
    await A.waitForSelector('.board.cols');
    await A.waitForTimeout(300);
    assert.equal(await A.locator('.order').count(), n);
  });

  // العميل
  const phoneCtx = await browser.newContext({ ...devices['iPhone SE'], locale: 'ar' });
  const P = await phoneCtx.newPage(); watch(P, 'customer');
  const order = await A.evaluate(async () => (await (await fetch('/api/staff/orders?filter=preparing')).json()).orders[0]);

  await step('العميل: فتح الرابط مرتين وإعادة التحميل يعرض الحالة الحالية دون طلب جديد', async () => {
    const before = await countOrders(A);
    await P.goto(order.url); await P.waitForSelector('.c-hero');
    await P.reload(); await P.waitForSelector('.c-hero');
    const P2 = await phoneCtx.newPage(); await P2.goto(order.url); await P2.waitForSelector('.c-hero'); await P2.close();
    assert.equal(await countOrders(A), before);
    assert.equal((await P.textContent('.num-big')).trim(), String(order.number));
    const devs = await A.evaluate(async (id) => (await (await fetch(`/api/staff/orders/${id}`)).json()).order.customer.devices, order.id);
    assert.equal(devs, 1, 'نفس الجهاز يُحسب مرة واحدة');
  });

  await step('العميل من جهاز آخر يتابع نفس الطلب ويستلم النداء', async () => {
    const other = await browser.newContext({ ...devices['Pixel 5'], locale: 'ar' });
    const Q = await other.newPage(); watch(Q, 'customer2');
    await Q.goto(order.url); await Q.waitForSelector('.c-hero');
    await A.locator(`.order[data-id="${order.id}"] .btn-call`).click();
    await Q.waitForSelector('.c-hero.ready', { timeout: 5000 });
    await P.waitForSelector('.c-hero.ready', { timeout: 5000 });
    const o = await A.evaluate(async (id) => (await (await fetch(`/api/staff/orders/${id}`)).json()).order, order.id);
    assert.equal(o.customer.devices, 2);
    assert.ok(o.lastCall.pageSeen >= 1, 'الصفحة المفتوحة أثبتت ظهور النداء');
    await P.screenshot({ path: `${OUT}/e3-customer-ready-small.png`, fullPage: true });
    await other.close();
  });

  await step('العميل يفقد الاتصال ثم يعود: تظهر رسالة ثم تُحدّث الحالة', async () => {
    await phoneCtx.setOffline(true);
    await P.evaluate(() => window.dispatchEvent(new Event('offline')));
    await P.waitForSelector('#conn:not([hidden])', { timeout: 10000 });
    await P.screenshot({ path: `${OUT}/e4-customer-offline.png` });
    // الموظف يسلّم أثناء انقطاع العميل
    await A.locator(`.order[data-id="${order.id}"] .btn-primary.main`).click();
    await phoneCtx.setOffline(false);
    await P.evaluate(() => window.dispatchEvent(new Event('online')));
    await P.waitForSelector('.c-hero.done', { timeout: 20000 });
    await P.waitForSelector('#conn', { state: 'hidden', timeout: 10000 });
  });

  await step('إعادة النداء: الزر معطل أثناء الفاصل ويعرض العد التنازلي', async () => {
    await A.click('#createBtn'); await A.waitForTimeout(800);
    const id = await A.evaluate(async () => { const os = (await (await fetch('/api/staff/orders?filter=preparing')).json()).orders; return os[os.length - 1].id; });
    await A.locator(`.order[data-id="${id}"] .btn-call`).click();
    await A.waitForSelector(`.order[data-id="${id}"].s-ready`);
    const recall = A.locator(`.order[data-id="${id}"] button`, { hasText: 'إعادة النداء' });
    assert.equal(await recall.isDisabled(), true);
    assert.match(await recall.textContent(), /\d+ث/);
  });

  await step('رابط منتهي وطلب ملغي يظهران برسالة مفهومة للعميل', async () => {
    await A.click('#createBtn'); await A.waitForTimeout(800);
    const o = await A.evaluate(async () => { const os = (await (await fetch('/api/staff/orders?filter=preparing')).json()).orders; return os[os.length - 1]; });
    await P.goto(o.url); await P.waitForSelector('.c-hero');
    await A.evaluate(async (x) => fetch(`/api/staff/orders/${x.id}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nidaa': '1' }, body: JSON.stringify({ expectedVersion: x.version }) }), o);
    await P.waitForSelector('.c-hero.cancelled', { timeout: 5000 });
    await P.screenshot({ path: `${OUT}/e5-customer-cancelled.png` });
  });

  await step('أحجام الشاشات: لا تمرير أفقي في لوحة الموظف وصفحة العميل والشاشة', async () => {
    for (const [w, hgt, path] of [[360, 640, order.url], [768, 1024, `${BASE}/staff`], [1024, 600, `${BASE}/staff`], [390, 844, `${BASE}/staff`]]) {
      const c = await browser.newContext({ viewport: { width: w, height: hgt }, locale: 'ar', storageState: await ctxA.storageState() });
      const pg = await c.newPage();
      await pg.goto(path); await pg.waitForTimeout(800);
      const overflow = await pg.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 1, `${w}x${hgt} ${path}: horizontal overflow ${overflow}`);
      // أهداف اللمس الرئيسية ≥ 44px
      const small = await pg.evaluate(() => [...document.querySelectorAll('.btn:not(.btn-sm), .tabs button')].filter((b) => b.offsetParent && b.getBoundingClientRect().height < 44).length);
      assert.equal(small, 0, `${w}x${hgt}: أزرار أصغر من 44px`);
      await c.close();
    }
  });

  await step('شاشة العرض بالوضع العمودي (تابلت) تعرض الرمز كاملًا', async () => {
    const t = await browser.newContext({ viewport: { width: 820, height: 1180 }, locale: 'ar' });
    const T = await t.newPage();
    await T.goto(`${BASE}/display`);
    await T.waitForFunction(() => /^[A-Z0-9]{6}$/.test(document.querySelector('#pairCode')?.textContent || ''));
    const code = await T.textContent('#pairCode');
    await ctxA.request.post(`${BASE}/api/owner/displays/claim`, { headers: { 'x-nidaa': '1' }, data: { code, name: 'عمودي' } });
    await A.click('#createBtn');
    await T.waitForSelector('#dOrder:not([hidden])', { timeout: 10000 });
    const box = await T.locator('#dQr').boundingBox();
    assert.ok(box.y + box.height <= 1180 && box.width >= 300, JSON.stringify(box));
    await T.screenshot({ path: `${OUT}/e6-display-portrait.png` });
    // إلغاء الاقتران يعيد الشاشة لصفحة الاقتران فورًا
    const list = await ctxA.request.get(`${BASE}/api/owner/displays`);
    const id = (await list.json()).displays.find((d) => d.name === 'عمودي').id;
    await ctxA.request.delete(`${BASE}/api/owner/displays/${id}`, { headers: { 'x-nidaa': '1' } });
    await T.waitForSelector('#pairView:not([hidden])', { timeout: 10000 });
    await t.close();
  });

  await step('تسجيل الخروج يمنع الوصول للوحة', async () => {
    await B.click('#logout');
    await B.waitForURL('**/login');
    await B.goto(`${BASE}/staff`);
    await B.waitForURL('**/login');
  });

  await browser.close();
  for (const r of results) console.log(r.join(' | '));
  if (errors.length) console.log('PAGE ERRORS:\n' + errors.join('\n'));
  process.exit(results.some((r) => r[0] === 'FAIL') || errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

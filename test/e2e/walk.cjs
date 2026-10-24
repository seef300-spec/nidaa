// جولة واجهات كاملة بمتصفح حقيقي مع لقطات شاشة
const { chromium, devices } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:3100';
const OUT = process.env.OUT || '/tmp/shots';
require('fs').mkdirSync(OUT, { recursive: true });
const errors = [];
const path = require('path');
const jsQR = require(path.join(__dirname, '../../node_modules/jsqr'));
const { PNG } = require(path.join(__dirname, '../../node_modules/pngjs'));
// يفك رمز QR من لقطة شاشة فعلية (كما تفعل كاميرا الجوال)
function decodeQR(buf) {
  const png = PNG.sync.read(buf);
  const r = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  return r && r.data;
}
const checks = [];
function watch(page, name) {
  page.on('console', (m) => { if (m.type() === 'error' && !(name === 'invalid' && /404/.test(m.text()))) errors.push(`[${name}] console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${name}] pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 500) errors.push(`[${name}] HTTP ${r.status()} ${r.url()}`); });
}
(async () => {
  const browser = await chromium.launch();
  const staffCtx = await browser.newContext({ viewport: { width: 1366, height: 768 }, locale: 'ar' });
  const staff = await staffCtx.newPage(); watch(staff, 'staff');
  await staff.goto(`${BASE}/setup`);
  await staff.waitForSelector('#form:not([hidden])');
  await staff.screenshot({ path: `${OUT}/01-setup.png`, fullPage: true });
  await staff.fill('#shopName', 'مقهى الصباح');
  await staff.fill('#pickup', 'من نافذة الاستلام يسار الكاشير');
  await staff.fill('#ownerName', 'سيف');
  await staff.fill('#username', 'owner');
  await staff.fill('#password', 'owner-pass-123');
  await staff.click('#submit');
  await staff.waitForURL('**/staff/settings#start');
  await staff.waitForSelector('.steps');
  await staff.screenshot({ path: `${OUT}/02-settings-start.png`, fullPage: true });

  // شاشة العرض
  const tabCtx = await browser.newContext({ viewport: { width: 1180, height: 820 }, locale: 'ar', hasTouch: true });
  const tab = await tabCtx.newPage(); watch(tab, 'display');
  await tab.goto(`${BASE}/display`);
  await tab.waitForFunction(() => /^[A-Z0-9]{6}$/.test(document.querySelector('#pairCode')?.textContent || ''));
  const code = await tab.textContent('#pairCode');
  await tab.screenshot({ path: `${OUT}/03-display-pair.png` });
  await staff.goto(`${BASE}/staff/settings#displays`);
  await staff.waitForSelector('form.section input');
  await staff.fill('form.section input.num', code);
  await staff.click('form.section button[type=submit]');
  await tab.waitForSelector('#mainView:not([hidden])', { timeout: 10000 });
  await tab.waitForSelector('#dIdle:not([hidden])');
  await tab.screenshot({ path: `${OUT}/04-display-idle.png` });

  // لوحة الطلبات
  await staff.goto(`${BASE}/staff`);
  await staff.waitForSelector('.board.cols');
  await staff.screenshot({ path: `${OUT}/05-staff-empty.png` });
  await staff.fill('#refInput', '1045');
  await staff.fill('#noteInput', 'بدون سكر');
  await staff.click('#createBtn');
  await staff.waitForSelector('.order.s-preparing');
  await staff.click('#createBtn');
  await staff.waitForFunction(() => document.querySelectorAll('.order.s-preparing').length === 2);
  await tab.waitForSelector('#dOrder:not([hidden])');
  await tab.waitForTimeout(400);
  await tab.screenshot({ path: `${OUT}/06-display-order.png` });
  await staff.waitForTimeout(500);
  await staff.screenshot({ path: `${OUT}/07-staff-two.png` });

  // العميل: آيفون
  const url = await staff.evaluate(async () => (await (await fetch('/api/staff/orders?filter=active')).json()).orders[0].url);
  const scanned = decodeQR(await tab.locator('#dQr').screenshot());
  if (scanned !== url) errors.push(`QR on display decodes to ${scanned}, expected ${url}`); else checks.push('رمز الشاشة يُقرأ ويطابق رابط الطلب الصحيح');
  const phoneCtx = await browser.newContext({ ...devices['iPhone 13'], locale: 'ar' });
  const phone = await phoneCtx.newPage(); watch(phone, 'customer');
  await phone.goto(url);
  await phone.waitForSelector('.c-hero');
  await phone.screenshot({ path: `${OUT}/08-customer-preparing.png`, fullPage: true });
  await tab.waitForSelector('#dSuccess:not([hidden])', { timeout: 5000 });
  await tab.screenshot({ path: `${OUT}/09-display-success.png` });
  await tab.waitForSelector('#dSuccess', { state: 'hidden', timeout: 6000 });
  await tab.screenshot({ path: `${OUT}/10-display-next.png` });

  await staff.waitForTimeout(600);
  await staff.screenshot({ path: `${OUT}/11-staff-opened.png` });
  // نداء
  await staff.click('.order.s-preparing .btn-call');
  await phone.waitForSelector('.c-hero.ready', { timeout: 5000 });
  await phone.screenshot({ path: `${OUT}/12-customer-ready.png`, fullPage: true });
  await phone.click('.c-ack');
  await phone.waitForSelector('.c-ready-ack');
  await staff.waitForTimeout(800);
  await staff.screenshot({ path: `${OUT}/13-staff-ready.png` });
  // تفاصيل
  await staff.click('.order.s-ready .order-num');
  await staff.waitForSelector('dialog.modal .timeline li');
  await staff.waitForTimeout(300);
  await staff.screenshot({ path: `${OUT}/14-staff-detail.png` });
  await staff.keyboard.press('Escape');
  // تسليم
  await staff.click('.order.s-ready .btn-primary.main');
  await phone.waitForSelector('.c-hero.done', { timeout: 5000 });
  await phone.screenshot({ path: `${OUT}/15-customer-done.png`, fullPage: true });
  // إلغاء الطلب الثاني
  await staff.click('.order.s-preparing [aria-haspopup=menu]');
  await staff.click('.menu-pop .danger');
  await staff.waitForSelector('dialog.modal [data-ok]');
  await staff.screenshot({ path: `${OUT}/16-staff-cancel-confirm.png` });
  await staff.click('dialog.modal [data-ok]');
  await staff.waitForSelector('.order', { state: 'detached' });
  await staff.click('[data-filter=all]');
  await staff.waitForSelector('.list .order');
  await staff.screenshot({ path: `${OUT}/17-staff-history.png` });
  // الأجهزة الصغيرة
  const andCtx = await browser.newContext({ ...devices['Pixel 7'], locale: 'ar' });
  const and = await andCtx.newPage(); watch(and, 'staff-mobile');
  await andCtx.addCookies(await staffCtx.cookies());
  await and.goto(`${BASE}/staff`);
  await and.waitForSelector('.board');
  await and.screenshot({ path: `${OUT}/18-staff-phone.png`, fullPage: true });
  await and.goto(`${BASE}/staff/settings#notify`);
  await and.waitForSelector('.section');
  await and.screenshot({ path: `${OUT}/19-settings-notify-phone.png`, fullPage: true });
  const bad = await browser.newPage(); watch(bad, 'invalid');
  await bad.goto(`${BASE}/o/AAAAAAAAAAAAAAAAAAAAAAAA`);
  await bad.waitForSelector('.c-msg');
  await bad.screenshot({ path: `${OUT}/20-customer-invalid.png` });
  // الطباعة
  const pr = await staffCtx.newPage(); watch(pr, 'print');
  const id = await staff.evaluate(async () => (await (await fetch('/api/staff/orders?filter=all')).json()).orders[0].id);
  await pr.goto(`${BASE}/staff/print/${id}`);
  await pr.waitForSelector('.ticket .qr svg');
  await pr.screenshot({ path: `${OUT}/21-print.png`, fullPage: true });
  const printedUrl = await staff.evaluate(async (oid) => (await (await fetch(`/api/staff/orders/${oid}`)).json()).order.url, id);
  await pr.emulateMedia({ media: 'print' });
  const printed = decodeQR(await pr.locator('.ticket').screenshot());
  if (printed !== printedUrl) errors.push(`printed QR decodes to ${printed}`); else checks.push('الرمز في صفحة الطباعة (وضع الطباعة) يُقرأ ويطابق الرابط');
  // ورقة 58 مم (الأصغر)
  await pr.selectOption('#size', '58').catch(() => {});
  await pr.emulateMedia({ media: 'screen' });
  await pr.selectOption('#size', '58');
  const small = decodeQR(await pr.locator('.ticket').screenshot());
  if (small !== printedUrl) errors.push(`58mm QR decodes to ${small}`); else checks.push('الرمز على إيصال 58 مم يُقرأ');
  await browser.close();
  for (const c of checks) console.log('PASS | ' + c);
  console.log(errors.length ? 'FAIL | walk errors:\n' + errors.join('\n') : 'PASS | جولة الواجهات الكاملة (إعداد ← اقتران ← طلب ← مسح ← نداء ← تسليم ← إلغاء ← سجل ← طباعة) بلا أخطاء');
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error('FAIL', e.message); console.log(errors.join('\n')); process.exit(1); });

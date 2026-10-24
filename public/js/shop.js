import { api, h, $, ICONS } from './common.js';

const slug = location.pathname.split('/')[2] || '';
api('GET', `/api/public/s/${encodeURIComponent(slug)}`).then(({ shop }) => {
  document.title = shop.name;
  const mark = shop.logoUrl ? h('img', { src: shop.logoUrl, alt: '' }) : (() => { const s = h('span', { class: 'mark' }); s.innerHTML = ICONS.logo; return s; })();
  $('#app').replaceChildren(
    h('div', { class: 'c-shop' }, mark, h('span', null, h('span', { class: 'name' }, shop.name), h('span', { class: 'branch' }, shop.branchName))),
    h('section', { class: 'c-card' }, h('h2', null, 'متابعة الطلبات'), h('p', null, 'امسح رمز QR الظاهر على الشاشة أو على إيصالك لمتابعة طلبك. لا تحتاج لتطبيق أو تسجيل.'),
      shop.pickup ? h('p', null, '📍 مكان الاستلام: ', shop.pickup) : null),
    h('p', { class: 'c-foot' }, 'إن أغلقت صفحة طلبك، امسح الرمز مرة أخرى لتعود إليه.'));
}).catch(() => {
  $('#app').replaceChildren(h('div', { class: 'c-msg' }, h('h1', null, 'الصفحة غير موجودة')));
});

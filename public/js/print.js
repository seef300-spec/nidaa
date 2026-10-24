import { api, $, h, clock, dateLabel } from './common.js';

const id = location.pathname.split('/').pop();
const t = $('#ticket');
let size = '80';
try { size = localStorage.getItem('nidaa.printSize') || '80'; } catch { /* */ }
$('#size').value = size; t.dataset.size = size;
$('#size').addEventListener('change', (e) => { t.dataset.size = e.target.value; try { localStorage.setItem('nidaa.printSize', e.target.value); } catch { /* */ } });
$('#printBtn').addEventListener('click', () => window.print());
$('#closeBtn').addEventListener('click', () => window.close());

async function main() {
  try {
    const [{ order: o }, me, svgRes] = await Promise.all([
      api('GET', `/api/staff/orders/${id}`), api('GET', '/api/me'), fetch(`/api/staff/orders/${id}/qr.svg`, { credentials: 'same-origin' }),
    ]);
    if (!svgRes.ok) throw new Error('تعذر تحميل الرمز');
    const svg = await svgRes.text();
    t.replaceChildren(...[
      me.shop.logoUrl ? h('img', { class: 'logo', src: me.shop.logoUrl, alt: '' }) : null,
      h('div', { class: 'shop' }, me.shop.name),
      h('div', { class: 'lbl' }, 'رقم طلبك'),
      h('div', { class: 'number' }, String(o.number)),
      h('div', { class: 'qr', html: svg }),
      h('div', { class: 'hint' }, 'امسح الرمز وتابع طلبك'),
      h('div', { class: 'pickup' }, 'سيصلك تنبيه عند جاهزية طلبك'),
      h('div', { class: 'meta' }, `${dateLabel(o.businessDate)} · ${clock(o.createdAt, me.branch.timezone)}`),
    ].filter(Boolean));
    document.title = `طلب ${o.number}`;
    if (['preparing', 'ready'].includes(o.status)) setTimeout(() => window.print(), 300);
    else t.prepend(h('div', { class: 'alert alert-warn no-print' }, 'هذا الطلب منتهٍ.'));
  } catch (e) {
    t.replaceChildren(h('div', { class: 'alert alert-error' }, e.message || 'تعذر التحميل'));
  }
}
main();

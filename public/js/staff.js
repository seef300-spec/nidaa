import {
  api, apiRetry, h, $, $$, ago, elapsed, clock, dateLabel, toast, toastError, confirmDialog, liveStream, coalesce,
  uuid, icon, STATUS, statusBadge, copyText, ICONS,
} from './common.js';

const S = {
  me: null, filter: 'active', q: '', date: '', orders: [], nextCursor: null, counts: {}, today: null,
  display: null, busy: new Set(), live: 'connecting', lastSync: 0, detailId: null, creating: false,
};

// ===== التهيئة =====
async function init() {
  try { S.me = await api('GET', '/api/me'); } catch (e) {
    if (e.status === 401) { location.href = '/login'; return; }
    $('#board').replaceChildren(h('div', { class: 'alert alert-error' }, e.message, ' ', h('button', { class: 'btn btn-sm', onclick: () => location.reload() }, 'إعادة المحاولة')));
    return;
  }
  const { shop, branch, user } = S.me;
  $('#shopName').textContent = shop.name;
  $('#branchName').textContent = branch.name;
  // تبديل الفرع (يظهر فقط عند وجود أكثر من فرع)
  if (S.me.branches.length > 1) {
    const sel = $('#branchSelect');
    sel.replaceChildren(...S.me.branches.map((b) => h('option', { value: b.id, selected: b.id === branch.id }, b.name)));
    sel.hidden = false; $('#branchName').hidden = true;
    sel.addEventListener('change', async () => {
      try { await api('POST', '/api/me/branch', { branchId: sel.value }); location.reload(); } catch (e) { toastError(e); sel.value = branch.id; }
    });
  }
  $('#userName').textContent = user.name;
  const mark = $('#brandMark');
  if (shop.logoUrl) mark.replaceWith(h('img', { class: 'brand-logo', src: shop.logoUrl, alt: '' }));
  else mark.innerHTML = ICONS.logo;
  $('#showOnDisplay').checked = branch.displayAutoshow;
  document.title = `لوحة الطلبات — ${shop.name}`;
  if (user.role === 'owner') {
    $('#settingsLink').hidden = false;
    api('GET', '/api/owner/onboarding').then((o) => {
      const left = o.steps.filter((s) => !s.done && !s.optional);
      if (left.length) {
        const b = $('#setupBanner');
        b.hidden = false;
        b.replaceChildren(`أكمل الإعداد الأول: ${left.map((s) => s.label).join('، ')} — `, h('a', { href: '/staff/settings#start' }, 'افتح قائمة الإعداد'));
      }
    }).catch(() => {});
  }
  bind();
  await Promise.all([load(true), loadDisplay()]);
  startStream();
  setInterval(tick, 1000);
  setInterval(() => { renderBoard(); renderDisplay(); }, 30000);
  // تحديث احتياطي خفيف كل 4 دقائق (يبقي الخادم مستيقظًا في الخطط المجانية أثناء فتح اللوحة)
  setInterval(refreshDisplay, 240000);
}

function bind() {
  $('#createBtn').addEventListener('click', createOrder);
  $('#logout').addEventListener('click', async () => {
    try { await api('POST', '/api/auth/logout'); } catch { /* ignore */ }
    location.href = '/login';
  });
  $$('#tabs [role=tab]').forEach((b) => b.addEventListener('click', () => setFilter(b.dataset.filter)));
  $('#searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    S.q = $('#searchInput').value.trim();
    S.date = $('#dateInput').value;
    if ((S.q || S.date) && S.filter === 'active') setFilter('all', false);
    $('#clearSearch').hidden = !(S.q || S.date);
    load(true);
  });
  $('#clearSearch').addEventListener('click', () => {
    $('#searchInput').value = ''; $('#dateInput').value = ''; S.q = ''; S.date = '';
    $('#clearSearch').hidden = true; load(true);
  });
  $('#moreBtn').addEventListener('click', () => load(false));
  for (const id of ['#refInput', '#noteInput']) {
    $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); createOrder(); } });
  }
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select, dialog')) return;
    if (e.key === 'n' || e.key === 'N' || e.key === '+' || e.key === 'ى') { e.preventDefault(); createOrder(); }
    if (e.key === '/') { e.preventDefault(); $('#searchInput').focus(); }
  });
  window.addEventListener('offline', () => setLive('offline'));
  window.addEventListener('online', () => { $('#offlineBanner').hidden = true; });
}

function setFilter(f, reload = true) {
  S.filter = f;
  $$('#tabs [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.filter === f)));
  if (reload) load(true);
}

// ===== الجلب =====
async function load(reset) {
  const params = new URLSearchParams({ filter: S.filter, limit: S.filter === 'active' ? '200' : '50' });
  if (S.q) params.set('q', S.q);
  if (S.date) params.set('date', S.date);
  // في القوائم التاريخية بلا تاريخ محدد نعرض اليوم الحالي للتبويبات (مسلّمة/ملغاة)
  if (!S.date && !S.q && (S.filter === 'delivered' || S.filter === 'cancelled') && S.today) params.set('date', S.today);
  if (!reset && S.nextCursor) params.set('cursor', S.nextCursor);
  try {
    const r = await api('GET', `/api/staff/orders?${params}`);
    S.orders = reset ? r.orders : [...S.orders, ...r.orders];
    S.nextCursor = r.nextCursor;
    S.counts = r.counts;
    if (!S.today) $('#dateInput').max = r.today;
    S.today = r.today;
    S.lastSync = Date.now();
    renderBoard();
    if (S.detailId) refreshDetail();
  } catch (e) {
    if (e.status === 401) { location.href = '/login'; return; }
    if (!S.orders.length) $('#board').replaceChildren(h('div', { class: 'alert alert-error' }, e.message));
    else toastError(e);
  }
}
// إعادة جلب كل الطلبات المعروضة (للتحديثات اللحظية) دون فقد الصفحات المحمّلة
const refresh = coalesce(async () => {
  if (S.filter === 'active' || !S.nextCursor) return load(true);
  // عند وجود صفحات إضافية نحدّث العناصر الظاهرة فقط
  const ids = S.orders.map((o) => o.id);
  const updated = await Promise.all(ids.slice(0, 100).map((id) => api('GET', `/api/staff/orders/${id}`).then((r) => r.order).catch(() => null)));
  S.orders = S.orders.map((o, i) => updated[i] || o);
  S.lastSync = Date.now();
  renderBoard();
  if (S.detailId) refreshDetail();
}, 200);

async function loadDisplay() {
  try { S.display = await api('GET', '/api/staff/display'); renderDisplay(); } catch { /* يظهر عند الاتصال التالي */ }
}
const refreshDisplay = coalesce(loadDisplay, 200);

function startStream() {
  liveStream('/api/staff/stream', {
    events: ['orders', 'display', 'devices'],
    onEvent: (ev) => { if (ev === 'orders') refresh(); else refreshDisplay(); },
    onState: setLive,
    onReconnect: () => { refresh(); refreshDisplay(); },
  });
}

function setLive(state) {
  S.live = state;
  const c = $('#conn');
  c.dataset.state = state;
  $('#connText').textContent = state === 'live' ? 'متصل' : state === 'offline' ? 'غير متصل' : 'جارٍ الاتصال…';
  $('#offlineBanner').hidden = state !== 'offline';
  if (state === 'live') S.lastSync = Date.now();
}

function tick() {
  const now = Date.now();
  for (const el of $$('[data-el]')) el.textContent = elapsed(el.dataset.el, now);
  for (const btn of $$('[data-cool]')) {
    const left = Math.ceil((Number(btn.dataset.cool) - now) / 1000);
    if (left > 0) { btn.disabled = true; btn.querySelector('.cd').textContent = ` (${left}ث)`; } else if (btn.disabled && !S.busy.has(btn.dataset.id)) {
      btn.disabled = false; btn.querySelector('.cd').textContent = ''; delete btn.dataset.cool;
    }
  }
  // مؤشر قدم البيانات عند انقطاع البث
  const stale = $('#staleBanner');
  if (S.live !== 'live' && S.lastSync && now - S.lastSync > 8000) {
    stale.hidden = false;
    stale.textContent = `البيانات المعروضة قد تكون قديمة — آخر تحديث ${ago(new Date(S.lastSync).toISOString())}. جارٍ إعادة الاتصال…`;
  } else stale.hidden = true;
}

// ===== شاشة العرض =====
function renderDisplay() {
  const box = $('#nowShowing');
  const d = S.display;
  if (!d) { box.replaceChildren(); return; }
  const online = d.devices.filter((x) => x.last_seen_at && Date.now() - new Date(x.last_seen_at).getTime() < 3 * 60 * 1000);
  const devLine = !d.devices.length
    ? h('span', { class: 'chip chip-warn' }, 'لا توجد شاشة مقترنة')
    : online.length ? h('span', { class: 'chip chip-ok' }, `الشاشة متصلة`) : h('span', { class: 'chip chip-warn' }, 'الشاشة غير متصلة');
  const val = d.current
    ? h('div', { class: 'val' }, h('span', { class: 'big num' }, `#${d.current.number}`), d.waiting ? h('span', { class: 'chip' }, `بالانتظار ${d.waiting}`) : null,
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => hideFromDisplay(d.current.orderId) }, 'إخفاء'))
    : h('div', { class: 'val muted' }, 'لا يوجد طلب معروض');
  box.replaceChildren(h('div', { class: 'label' }, icon('screen'), 'على الشاشة الآن', devLine), val);
}

async function hideFromDisplay(id) {
  try { await api('POST', `/api/staff/orders/${id}/display`, { mode: 'hide' }); refreshDisplay(); } catch (e) { toastError(e); }
}
async function showOnDisplay(o) {
  try {
    await api('POST', `/api/staff/orders/${o.id}/display`, { mode: 'show' });
    toast(`يظهر الآن طلب ${o.number} على الشاشة`, { type: 'ok' });
    refreshDisplay();
  } catch (e) { toastError(e); }
}

// ===== إنشاء طلب =====
async function createOrder() {
  if (S.creating) return; // منع النقر المزدوج
  S.creating = true;
  const btn = $('#createBtn');
  btn.setAttribute('aria-busy', 'true');
  const idem = uuid();
  const body = { externalRef: $('#refInput').value, note: $('#noteInput').value, showOnDisplay: $('#showOnDisplay').checked };
  try {
    const r = await apiRetry('POST', '/api/staff/orders', body, { idem, tries: 4, onRetry: () => toast('انقطع الاتصال، نعيد المحاولة بأمان دون تكرار الطلب…') });
    $('#refInput').value = ''; $('#noteInput').value = '';
    const o = r.order;
    if (!S.orders.some((x) => x.id === o.id) && S.filter === 'active') S.orders.push(o);
    renderBoard(o.id);
    if (o.display.state === 'queued') toast(`أُنشئ الطلب ${o.number} — رمزه على شاشة العرض`, { type: 'ok', action: { label: 'عرض الرمز', fn: () => openDetail(o.id) } });
    else { toast(`أُنشئ الطلب ${o.number}`, { type: 'ok' }); openDetail(o.id); }
    refreshDisplay();
  } catch (e) { toastError(e); } finally {
    S.creating = false; btn.removeAttribute('aria-busy');
  }
}

// ===== الإجراءات =====
const ACTION_TEXT = { call: 'نادِ العميل', recall: 'إعادة النداء', deliver: 'تم التسليم', cancel: 'إلغاء الطلب', undo_deliver: 'تراجع عن التسليم' };

async function doAction(o, action) {
  if (S.busy.has(o.id)) return;
  if (action === 'cancel') {
    const ok = await confirmDialog({ title: `إلغاء الطلب ${o.number}؟`, body: 'سيظهر للعميل أن الطلب ملغي، ولن يمكن ندائه بعد ذلك.', confirm: 'نعم، ألغِ الطلب', cancel: 'لا، تراجع', danger: true });
    if (!ok) return;
  }
  if (action === 'deliver' && o.status === 'preparing') {
    const ok = await confirmDialog({ title: `تسليم الطلب ${o.number} مباشرة؟`, body: 'الطلب لم يُنادَ بعد. استخدم هذا عند تسليمه للعميل يدويًا.', confirm: 'نعم، تم التسليم' });
    if (!ok) return;
  }
  S.busy.add(o.id);
  renderBoard();
  if (S.detailId === o.id) refreshDetail();
  try {
    const r = await apiRetry('POST', `/api/staff/orders/${o.id}/${action}`, { expectedVersion: o.version }, { idem: uuid(), tries: 3 });
    replaceOrder(r.order);
    if (action === 'call') toast(`تم نداء الطلب ${o.number}`, { type: 'ok' });
    else if (action === 'recall') toast(`أُعيد نداء الطلب ${o.number}`, { type: 'ok' });
    else if (action === 'deliver') toast(`سُلّم الطلب ${o.number}`, { type: 'ok', action: { label: 'تراجع', fn: () => doAction(r.order, 'undo_deliver') } });
    else if (action === 'cancel') toast(`أُلغي الطلب ${o.number}`);
    else if (action === 'undo_deliver') toast(`أُعيد الطلب ${o.number}`, { type: 'ok' });
  } catch (e) {
    if (e.extra?.order) replaceOrder(e.extra.order);
    toastError(e);
    if (e.status === 409) refresh();
  } finally {
    S.busy.delete(o.id);
    renderBoard();
    if (S.detailId === o.id) refreshDetail();
  }
}

function replaceOrder(o) {
  const i = S.orders.findIndex((x) => x.id === o.id);
  if (i >= 0) S.orders[i] = o;
  if (S.filter === 'active' && !['preparing', 'ready'].includes(o.status)) S.orders = S.orders.filter((x) => x.id !== o.id);
  else if (S.filter === 'active' && i < 0) S.orders.push(o);
}

// ===== العرض =====
function renderBoard(flashId) {
  const board = $('#board');
  const c = S.counts;
  const set = (k, v) => { const el = $(`[data-c=${k}]`); if (el) el.textContent = v ? v : ''; };
  set('active', (c.preparing || 0) + (c.ready || 0)); set('preparing', c.preparing); set('ready', c.ready);
  set('delivered', c.delivered); set('cancelled', c.cancelled);
  let list = S.orders;
  if (S.filter === 'active' && !S.q && !S.date) {
    const prep = list.filter((o) => o.status === 'preparing');
    const ready = list.filter((o) => o.status === 'ready').sort((a, b) => new Date(a.lastCalledAt) - new Date(b.lastCalledAt));
    board.className = 'board cols';
    board.replaceChildren(
      column('قيد التجهيز', 'preparing', prep, 'لا توجد طلبات قيد التجهيز. اضغط «طلب جديد» لإنشاء طلب.'),
      column('جاهزة للاستلام', 'ready', ready, 'لا توجد طلبات بانتظار الاستلام.'));
  } else {
    board.className = 'board';
    const filterName = { active: 'نشطة', preparing: 'قيد التجهيز', ready: 'جاهزة', delivered: 'مسلّمة', cancelled: 'ملغاة', all: '' }[S.filter];
    const scope = S.q ? `نتائج البحث عن «${S.q}»` : S.date ? `يوم ${dateLabel(S.date)}` : (S.filter === 'delivered' || S.filter === 'cancelled') ? 'اليوم' : '';
    board.replaceChildren(
      h('div', { class: 'row muted small' }, [filterName, scope].filter(Boolean).join(' — '), h('span', { class: 'spacer' }), `${list.length}${S.nextCursor ? '+' : ''} طلب`),
      list.length ? h('div', { class: 'list' }, list.map(card)) : h('div', { class: 'empty' }, S.q ? 'لا توجد نتائج مطابقة. جرّب رقمًا آخر أو امسح البحث.' : 'لا توجد طلبات هنا.'));
  }
  $('#moreBtn').hidden = !S.nextCursor;
  if (flashId) { const el = board.querySelector(`[data-id="${flashId}"]`); el?.classList.add('flash'); el?.scrollIntoView({ block: 'nearest' }); }
  tick();
}

function column(title, status, items, emptyText) {
  return h('section', { class: 'col', 'aria-label': title },
    h('div', { class: 'col-head' }, statusBadge(status, title), h('span', { class: 'muted num' }, String(items.length))),
    h('div', { class: 'col-list' }, items.length ? items.map(card) : h('div', { class: 'empty small' }, emptyText)));
}

function customerChips(o) {
  const chips = [];
  const c = o.customer;
  const active = ['preparing', 'ready'].includes(o.status);
  if (!c.opened) {
    if (active) chips.push(h('span', { class: 'chip chip-warn', title: 'لم يُفتح رابط الطلب من أي جهاز حتى الآن' }, '⚠ لم يمسح الرمز'));
  } else {
    chips.push(h('span', { class: 'chip', title: `أول فتح ${clock(c.firstOpenedAt)}` }, icon('phone'), `فتح الطلب · آخر ظهور ${ago(c.lastSeenAt)}`));
    if (c.devices > 1) chips.push(h('span', { class: 'chip chip-info' }, `على ${c.devices} أجهزة`));
  }
  if (active || o.status === 'ready') {
    const st = o.notify.state;
    const ios = c.viewers.some((v) => v.capability === 'ios-needs-homescreen');
    if (st === 'subscribed') chips.push(h('span', { class: 'chip chip-ok' }, icon('bell'), o.notify.activeSubscriptions > 1 ? `التنبيه مفعّل (${o.notify.activeSubscriptions})` : 'التنبيه مفعّل'));
    else if (st === 'denied') chips.push(h('span', { class: 'chip chip-bad' }, 'رفض التنبيهات — الصفحة فقط'));
    else if (st === 'expired') chips.push(h('span', { class: 'chip chip-bad' }, 'انتهى اشتراك التنبيه'));
    else if (st === 'unsupported') chips.push(h('span', { class: 'chip chip-info' }, ios ? 'آيفون: بلا تنبيه — الصفحة فقط' : 'جهازه لا يدعم التنبيه — الصفحة فقط'));
    else if (st === 'not_enabled') chips.push(h('span', { class: 'chip' }, 'لم يفعّل التنبيه'));
  }
  return chips;
}

function callChips(o) {
  const lc = o.lastCall;
  if (!lc || o.status !== 'ready') return [];
  const chips = [h('span', { class: 'chip' }, `${lc.seq > 1 ? `النداء ${lc.seq}` : 'نُودي'} · ${ago(lc.at)}`)];
  if (lc.pushTotal) {
    if (lc.pushAccepted) chips.push(h('span', { class: 'chip chip-ok', title: 'خدمة الإشعارات (آبل/جوجل) قبلت التنبيه. هذا لا يعني بالضرورة أنه ظهر على الجهاز.' }, 'قبلته خدمة الإشعارات'));
    else if (lc.pushFailed === lc.pushTotal) chips.push(h('span', { class: 'chip chip-bad' }, 'تعذّر إرسال التنبيه'));
    else chips.push(h('span', { class: 'chip' }, 'جارٍ إرسال التنبيه…'));
  }
  if (lc.deviceReceipts) chips.push(h('span', { class: 'chip chip-ok', title: 'جهاز العميل أكد استلام التنبيه' }, '✓ وصل لجهازه'));
  if (lc.pageSeen) chips.push(h('span', { class: 'chip chip-ok', title: 'صفحة الطلب المفتوحة عرضت النداء' }, '✓ ظهر في صفحته'));
  const acked = o.customer.ackAt && new Date(o.customer.ackAt) >= new Date(lc.at);
  if (acked) chips.push(h('span', { class: 'chip chip-ok' }, '✓ العميل: في الطريق'));
  const noEvidence = !lc.deviceReceipts && !lc.pageSeen && !acked;
  if (noEvidence && Date.now() - new Date(lc.at).getTime() > 45000) {
    chips.push(h('span', { class: 'chip chip-warn' }, 'لا دليل على وصول النداء — نادِ بالاسم/الرقم أو أعد النداء'));
  }
  return chips;
}

function card(o) {
  const busy = S.busy.has(o.id);
  const old = S.today && o.businessDate !== S.today;
  const t = o.status === 'ready' ? o.readyAt : o.createdAt;
  const actions = [];
  const btn = (action, cls, text, extra = {}) => h('button', { class: `btn ${cls}`, type: 'button', disabled: busy, 'aria-busy': busy ? 'true' : null, 'data-id': o.id, onclick: () => doAction(o, action), ...extra }, text, h('span', { class: 'cd' }));
  if (o.status === 'preparing') {
    actions.push(btn('call', 'btn-call main', [icon('bell'), ACTION_TEXT.call]));
  } else if (o.status === 'ready') {
    actions.push(btn('deliver', 'btn-primary main', [icon('check'), ACTION_TEXT.deliver]));
    const coolUntil = o.lastCalledAt ? new Date(o.lastCalledAt).getTime() + S.me.branch.recallCooldownSec * 1000 : 0;
    actions.push(btn('recall', '', [icon('bell'), ACTION_TEXT.recall], coolUntil > Date.now() ? { 'data-cool': String(coolUntil) } : {}));
  } else if (o.status === 'delivered' && o.undoUntil && new Date(o.undoUntil) > new Date()) {
    actions.push(btn('undo_deliver', 'btn-sm', [icon('undo'), ACTION_TEXT.undo_deliver]));
  }
  actions.push(moreMenu(o));
  const statusLine = o.status === 'cancelled' && o.cancelReason === 'expired' ? 'انتهى تلقائيًا' : null;
  return h('article', { class: `order s-${o.status}`, 'data-id': o.id, 'aria-label': `طلب ${o.number}` },
    h('div', { class: 'order-top' },
      h('button', { class: 'order-num num', type: 'button', title: 'التفاصيل والرمز', onclick: () => openDetail(o.id) }, String(o.number)),
      h('div', { class: 'order-meta' },
        h('div', { class: 'line' }, statusBadge(o.status, statusLine), o.externalRef ? h('span', null, 'فاتورة ', h('b', { class: 'num' }, o.externalRef)) : null,
          old ? h('span', { class: 'order-old' }, `من ${dateLabel(o.businessDate)}`) : null,
          o.display.state === 'queued' ? h('span', { class: 'chip chip-info' }, icon('screen'), 'على الشاشة') : null),
        h('div', { class: 'line muted' }, `أُنشئ ${clock(o.createdAt, S.me.branch.timezone)}`, o.createdVia === 'api' ? ' · من الكاشير' : '')),
      ['preparing', 'ready'].includes(o.status)
        ? h('div', { class: 'order-time' }, o.status === 'ready' ? 'جاهز منذ' : 'منذ', h('span', { class: 'el num', 'data-el': t }, elapsed(t)))
        : h('div', { class: 'order-time' }, clock(o.deliveredAt || o.cancelledAt, S.me.branch.timezone))),
    o.note ? h('div', { class: 'order-note' }, '📝 ', o.note) : null,
    h('div', { class: 'chips' }, customerChips(o), callChips(o)),
    h('div', { class: 'order-actions' }, actions));
}

function moreMenu(o) {
  const wrap = h('div', { class: 'menu' });
  const pop = h('div', { class: 'menu-pop', role: 'menu', hidden: true });
  const close = () => { pop.hidden = true; document.removeEventListener('click', outside, true); };
  const outside = (e) => { if (!wrap.contains(e.target)) close(); };
  const item = (label, fn, cls = '') => h('button', { type: 'button', role: 'menuitem', class: cls, onclick: () => { close(); fn(); } }, label);
  const active = ['preparing', 'ready'].includes(o.status);
  pop.append(
    item([icon('qr'), 'الرمز والتفاصيل'], () => openDetail(o.id)),
    active ? (o.display.state === 'queued'
      ? item([icon('screen'), 'إخفاء من الشاشة'], () => hideFromDisplay(o.id))
      : item([icon('screen'), 'اعرض على الشاشة الآن'], () => showOnDisplay(o))) : null,
    item([icon('print'), 'طباعة الرمز'], () => printOrder(o)),
    item([icon('copy'), 'نسخ رابط العميل'], async () => toast((await copyText(o.url)) ? 'نُسخ الرابط' : 'تعذر النسخ')),
    o.status === 'preparing' ? item([icon('check'), 'تسليم مباشر بدون نداء'], () => doAction(o, 'deliver')) : null,
    active ? item([icon('x'), 'إلغاء الطلب'], () => doAction(o, 'cancel'), 'danger') : null,
  );
  const trigger = h('button', { class: 'btn', type: 'button', 'aria-haspopup': 'menu', 'aria-label': 'خيارات أخرى', onclick: (e) => {
    e.stopPropagation();
    if (pop.hidden) { pop.hidden = false; document.addEventListener('click', outside, true); pop.querySelector('button')?.focus(); } else close();
  } }, '⋯');
  pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { close(); trigger.focus(); } });
  wrap.append(trigger, pop);
  return wrap;
}

function printOrder(o) {
  const w = window.open(`/staff/print/${o.id}`, '_blank', 'noopener,width=420,height=640');
  if (!w) toast('اسمح بالنوافذ المنبثقة للطباعة، أو افتح «الرمز والتفاصيل» واستخدم زر الطباعة', { type: 'error' });
}

// ===== نافذة التفاصيل =====
let dlg;
async function openDetail(id) {
  S.detailId = id;
  if (!dlg) {
    dlg = h('dialog', { class: 'modal wide', 'aria-label': 'تفاصيل الطلب' });
    dlg.addEventListener('close', () => { S.detailId = null; });
    document.body.append(dlg);
  }
  dlg.replaceChildren(h('div', { class: 'modal-body center-pad' }, h('div', { class: 'spinner' })));
  if (!dlg.open) dlg.showModal();
  await refreshDetail();
}

async function refreshDetail() {
  const id = S.detailId;
  if (!id || !dlg?.open) return;
  let o = S.orders.find((x) => x.id === id);
  let events = [];
  try {
    const [r, ev] = await Promise.all([api('GET', `/api/staff/orders/${id}`), api('GET', `/api/staff/orders/${id}/events`)]);
    o = r.order; events = ev.events;
  } catch (e) { if (!o) { dlg.replaceChildren(h('div', { class: 'modal-body' }, h('div', { class: 'alert alert-error' }, e.message))); return; } }
  if (S.detailId !== id) return;
  const tz = S.me.branch.timezone;
  const busy = S.busy.has(o.id);
  const active = ['preparing', 'ready'].includes(o.status);
  const linkInput = h('input', { class: 'input', readonly: true, value: o.url, 'aria-label': 'رابط العميل', onfocus: (e) => e.target.select() });
  const act = (action, cls, label) => h('button', { class: `btn ${cls}`, type: 'button', disabled: busy, onclick: () => doAction(o, action) }, label);
  const actions = [];
  if (o.status === 'preparing') actions.push(act('call', 'btn-call btn-lg', [icon('bell'), 'نادِ العميل']));
  if (o.status === 'ready') actions.push(act('deliver', 'btn-primary btn-lg', [icon('check'), 'تم التسليم']), act('recall', 'btn-lg', 'إعادة النداء'));
  if (o.status === 'delivered' && o.undoUntil && new Date(o.undoUntil) > new Date()) actions.push(act('undo_deliver', '', [icon('undo'), 'تراجع عن التسليم']));
  if (active) actions.push(act('cancel', 'btn-danger', 'إلغاء الطلب'));
  const times = [
    ['أُنشئ', o.createdAt], ['فتح العميل الرابط', o.customer.firstOpenedAt], ['جاهز', o.readyAt], ['آخر نداء', o.lastCalledAt],
    ['العميل أكد قدومه', o.customer.ackAt], ['التسليم', o.deliveredAt], ['الإلغاء', o.cancelledAt],
  ].filter(([, v]) => v);
  dlg.replaceChildren(
    h('div', { class: 'modal-body' },
      h('div', { class: 'row' }, h('h2', null, 'طلب ', h('span', { class: 'num' }, String(o.number))), statusBadge(o.status), h('span', { class: 'spacer' }),
        h('button', { class: 'btn btn-ghost', type: 'button', 'aria-label': 'إغلاق', onclick: () => dlg.close() }, icon('x'))),
      h('div', { class: 'detail', style: null },
        h('div', { class: 'stack' },
          active ? h('img', { class: 'qr', src: `/api/staff/orders/${o.id}/qr.svg`, alt: `رمز QR للطلب ${o.number}`, width: 260, height: 260 })
            : h('div', { class: 'alert alert-info' }, 'الطلب منتهٍ — لا حاجة لعرض الرمز.'),
          active ? h('div', { class: 'row' },
            o.display.state === 'queued'
              ? h('button', { class: 'btn btn-block', type: 'button', onclick: () => hideFromDisplay(o.id) }, icon('screen'), 'إخفاء من الشاشة')
              : h('button', { class: 'btn btn-block', type: 'button', onclick: () => showOnDisplay(o) }, icon('screen'), 'اعرض على الشاشة الآن')) : null,
          h('button', { class: 'btn btn-block', type: 'button', onclick: () => printOrder(o) }, icon('print'), 'طباعة'),
          h('div', { class: 'link-box' }, linkInput, h('button', { class: 'btn', type: 'button', title: 'نسخ', onclick: async () => toast((await copyText(o.url)) ? 'نُسخ الرابط' : 'تعذر النسخ') }, icon('copy')))),
        h('div', { class: 'stack' },
          h('dl', { class: 'kv' },
            h('dt', null, 'اليوم'), h('dd', null, dateLabel(o.businessDate)),
            o.externalRef ? [h('dt', null, 'رقم الفاتورة'), h('dd', { class: 'num' }, o.externalRef)] : null,
            o.note ? [h('dt', null, 'ملاحظة داخلية'), h('dd', null, o.note)] : null,
            ...times.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, `${clock(v, tz)} · ${ago(v)}`)])),
          h('div', { class: 'chips' }, customerChips(o), callChips(o)),
          o.customer.viewers.length ? h('div', { class: 'small muted' }, 'أجهزة العميل: ', o.customer.viewers.map((v) => `${platformName(v.platform)}${v.standalone ? ' (من الشاشة الرئيسية)' : ''} — ${permName(v)}`).join(' · ')) : null,
          h('div', { class: 'row' }, actions),
          h('ol', { class: 'timeline', 'aria-label': 'سجل الإجراءات' }, events.map((e) => h('li', null, h('time', null, clock(e.at, tz)), h('span', null, e.actionLabel, e.actor_label ? h('span', { class: 'muted' }, ` — ${e.actor_label}`) : ''))))))));
}

const platformName = (p) => ({ ios: 'آيفون', android: 'أندرويد', desktop: 'كمبيوتر', other: 'جهاز آخر' }[p] || 'جهاز');
function permName(v) {
  if (v.capability === 'ios-needs-homescreen') return 'التنبيه يتطلب الإضافة للشاشة الرئيسية';
  if (v.capability === 'unsupported') return 'لا يدعم التنبيه';
  return { granted: 'سمح بالتنبيه', denied: 'رفض التنبيه', default: 'لم يقرر بعد', ephemeral: 'تنبيه مؤقت' }[v.permission] || 'غير معروف';
}

init();

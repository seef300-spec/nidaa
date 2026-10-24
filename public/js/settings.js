import { api, h, $, $$, toast, toastError, confirmDialog, ago, copyText } from './common.js';

const S = { me: null, shop: null };
const TIMEZONES = ['Asia/Riyadh', 'Asia/Dubai', 'Asia/Kuwait', 'Asia/Qatar', 'Asia/Bahrain', 'Asia/Muscat', 'Asia/Amman', 'Asia/Baghdad', 'Africa/Cairo', 'Asia/Beirut', 'Africa/Casablanca', 'Africa/Algiers', 'Africa/Tunis', 'Europe/Istanbul', 'Europe/London', 'UTC'];

async function init() {
  try { S.me = await api('GET', '/api/me'); } catch (e) { if (e.status === 401) location.href = '/login'; return; }
  $('#shopName').textContent = `${S.me.shop.name} · ${S.me.branch.name}`;
  if (S.me.user.role !== 'owner') {
    $$('.side a').forEach((a) => { if (a.getAttribute('href') !== '#account') a.hidden = true; });
    if (location.hash !== '#account') location.hash = '#account';
  }
  window.addEventListener('hashchange', route);
  route();
}

const SECTIONS = { start, shop, staff, displays, notify, apiKeys, account };
const HASH = { '#start': 'start', '#shop': 'shop', '#staff': 'staff', '#displays': 'displays', '#notify': 'notify', '#api': 'apiKeys', '#account': 'account' };

async function route() {
  const key = HASH[location.hash] || (S.me.user.role === 'owner' ? 'start' : 'account');
  $$('.side a').forEach((a) => { if (HASH[a.getAttribute('href')] === key) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  const main = $('#content');
  main.replaceChildren(h('div', { class: 'center-pad' }, h('div', { class: 'spinner' })));
  try { main.replaceChildren(...[].concat(await SECTIONS[key]())); } catch (e) {
    main.replaceChildren(h('div', { class: 'alert alert-error' }, e.message));
  }
}

const field = (label, input, hint) => h('label', { class: 'field' }, h('span', null, label), input, hint ? h('small', null, hint) : null);
const busyBtn = async (btn, fn) => {
  if (btn.getAttribute('aria-busy')) return;
  btn.setAttribute('aria-busy', 'true'); btn.disabled = true;
  try { await fn(); } catch (e) { toastError(e); } finally { btn.removeAttribute('aria-busy'); btn.disabled = false; }
};

// ===== الإعداد الأول =====
async function start() {
  const [ob, st] = await Promise.all([api('GET', '/api/owner/onboarding'), api('GET', '/api/owner/status')]);
  const links = { shop: '#shop', logo: '#shop', pickup: '#shop', staff: '#staff', display: '#displays', order: '/staff', opened: '/staff', subscribed: '/staff', called: '/staff', delivered: '/staff' };
  const done = ob.steps.filter((s) => s.done).length;
  return [
    h('section', { class: 'section' },
      h('h2', null, 'الإعداد الأول'),
      h('p', { class: 'muted' }, `أنجزت ${done} من ${ob.steps.length} خطوات. الخطوات الاختيارية يمكن تركها.`),
      !st.https ? h('div', { class: 'alert alert-warn' }, 'النظام يعمل على رابط غير آمن (HTTP). التنبيهات على الجوال تتطلب HTTPS — انشر النظام على رابط HTTPS قبل التجربة الفعلية.') : null,
      h('ol', { class: 'steps' }, ob.steps.map((s, i) => h('li', { class: s.done ? 'done' : '' },
        h('span', { class: 'tick', 'aria-hidden': 'true' }, s.done ? '✓' : String(i + 1)),
        h('span', { class: 't' }, s.label, s.optional ? h('span', { class: 'muted small' }, ' (اختياري)') : null, h('span', { class: 'sr-only' }, s.done ? ' — تم' : ' — لم يتم')),
        !s.done ? h('a', { class: 'btn btn-sm', href: links[s.key] }, 'انتقل') : null)))),
    h('section', { class: 'section' },
      h('h2', null, 'تجربة الدورة كاملة (5 دقائق)'),
      h('ol', { class: 'test-steps' },
        h('li', null, 'على التابلت افتح: ', h('b', { class: 'code' }, `${st.publicUrl}/display`), ' ثم اقترنها من قسم «شاشات العرض».'),
        h('li', null, 'من «لوحة الطلبات» اضغط «طلب جديد» — سيظهر الرمز على التابلت.'),
        h('li', null, 'امسح الرمز بكاميرا الآيفون. يجب أن تظهر علامة ✓ على التابلت ويظهر في اللوحة «فتح الطلب».'),
        h('li', null, 'في الجوال اضغط «تجربة الصوت». على أندرويد اضغط «فعّل التنبيه». على آيفون اتبع خطوة «إضافة إلى الشاشة الرئيسية» إن أردت التنبيه والجوال مقفل.'),
        h('li', null, 'اقفل شاشة الجوال، ثم اضغط «نادِ العميل» في اللوحة، ولاحظ: هل وصل الإشعار؟ وهل ظهر في اللوحة «✓ وصل لجهازه»؟'),
        h('li', null, 'اضغط «أنا في الطريق» في الجوال، ثم «تم التسليم» في اللوحة.')),
      h('a', { class: 'btn btn-primary btn-lg', href: '/staff' }, 'افتح لوحة الطلبات')),
  ];
}

// ===== المحل والفرع =====
async function shop() {
  const d = await api('GET', '/api/owner/shop');
  const b = d.branch;
  const name = h('input', { class: 'input', value: d.shop.name, maxlength: 60, required: true });
  const logoImg = d.shop.logoUrl ? h('img', { class: 'logo-prev', src: d.shop.logoUrl, alt: 'الشعار الحالي' }) : h('div', { class: 'logo-prev center-pad muted small' }, 'بلا شعار');
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', class: 'input' });
  const shopForm = h('form', { class: 'section', onsubmit: (e) => { e.preventDefault(); busyBtn(e.submitter, async () => { await api('PUT', '/api/owner/shop', { name: name.value }); toast('حُفظ اسم المحل', { type: 'ok' }); }); } },
    h('h2', null, 'المحل'),
    field('اسم المحل (يظهر للعميل وعلى الشاشة)', name),
    h('button', { class: 'btn btn-primary', type: 'submit' }, 'حفظ الاسم'),
    h('h3', null, 'الشعار'),
    h('div', { class: 'row' }, logoImg, h('div', { class: 'stack' }, file, h('small', { class: 'muted' }, 'PNG أو JPG أو WebP. يُصغَّر تلقائيًا.'),
      d.shop.logoUrl ? h('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: async (e) => busyBtn(e.currentTarget, async () => { await api('DELETE', '/api/owner/shop/logo'); toast('حُذف الشعار'); route(); }) }, 'حذف الشعار') : null)));
  file.addEventListener('change', async () => {
    const f = file.files[0];
    if (!f) return;
    try {
      const dataUrl = await resizeImage(f, 512);
      await api('PUT', '/api/owner/shop/logo', { dataUrl });
      toast('حُفظ الشعار', { type: 'ok' }); route();
    } catch (e) { toastError(e); }
  });

  const tz = h('select', { class: 'input' }, (TIMEZONES.includes(b.timezone) ? TIMEZONES : [b.timezone, ...TIMEZONES]).map((z) => h('option', { value: z, selected: z === b.timezone }, z)));
  const inp = (v, attrs = {}) => h('input', { class: 'input', value: v, ...attrs });
  const f = {
    name: inp(b.name, { maxlength: 60, required: true }),
    pickup: inp(b.pickupInstructions, { maxlength: 140, placeholder: 'مثال: من نافذة الاستلام يسار الكاشير' }),
    dayStart: inp(b.dayStartHour, { type: 'number', min: 0, max: 23 }),
    cooldown: inp(b.recallCooldownSec, { type: 'number', min: 10, max: 600 }),
    ttl: inp(b.orderTtlHours, { type: 'number', min: 1, max: 72 }),
    grace: inp(b.linkGraceHours, { type: 'number', min: 1, max: 72 }),
    skip: inp(b.displaySkipSec, { type: 'number', min: 0, max: 3600 }),
    autoshow: h('input', { type: 'checkbox', checked: b.displayAutoshow }),
  };
  const branchForm = h('form', { class: 'section', onsubmit: (e) => {
    e.preventDefault();
    busyBtn(e.submitter, async () => {
      await api('PUT', '/api/owner/branch', {
        name: f.name.value, timezone: tz.value, pickupInstructions: f.pickup.value, dayStartHour: Number(f.dayStart.value),
        recallCooldownSec: Number(f.cooldown.value), orderTtlHours: Number(f.ttl.value), linkGraceHours: Number(f.grace.value),
        displaySkipSec: Number(f.skip.value), displayAutoshow: f.autoshow.checked,
      });
      toast('حُفظت إعدادات الفرع', { type: 'ok' });
    });
  } },
    h('h2', null, 'الفرع'),
    h('div', { class: 'grid2' },
      field('اسم الفرع', f.name),
      field('المنطقة الزمنية', tz),
      field('مكان الاستلام (يظهر للعميل عند الجاهزية)', f.pickup),
      field('بداية اليوم التشغيلي (ساعة 0–23)', f.dayStart, 'يُعاد ترقيم الطلبات من 1 عند هذه الساعة. مثال: 4 = الطلبات بعد منتصف الليل تُحسب لليوم السابق.'),
      field('الفاصل الأدنى بين النداءات (ثانية)', f.cooldown, 'يمنع إزعاج العميل بنداءات متتالية.'),
      field('إلغاء الطلب المهجور بعد (ساعة)', f.ttl, 'الطلب غير المسلّم يُغلق تلقائيًا بعد هذه المدة.'),
      field('بقاء رابط العميل بعد الانتهاء (ساعة)', f.grace),
      field('تخطي الرمز على الشاشة بعد (ثانية)', f.skip, 'فقط إذا كان هناك طلب آخر ينتظر. 0 = لا تخطٍّ.')),
    h('label', { class: 'check' }, f.autoshow, 'اعرض كل طلب جديد على شاشة العرض تلقائيًا'),
    h('button', { class: 'btn btn-primary', type: 'submit' }, 'حفظ إعدادات الفرع'));
  const nb = h('input', { class: 'input', maxlength: 60, placeholder: 'مثال: فرع العليا', required: true });
  const addBranch = h('form', { class: 'section', onsubmit: (e) => {
    e.preventDefault();
    busyBtn(e.submitter, async () => {
      await api('POST', '/api/owner/branches', { name: nb.value, timezone: tz.value });
      toast('أُضيف الفرع. اختره من أعلى لوحة الطلبات وأقرن له شاشة.', { type: 'ok', timeout: 8000 });
      nb.value = '';
    });
  } },
    h('h2', null, 'فرع إضافي'),
    h('p', { class: 'muted small' }, 'لكل فرع ترقيمه وشاشاته وطلباته المستقلة. الموظف الجديد يُربط بالفرع الحالي.'),
    field('اسم الفرع الجديد', nb), h('button', { class: 'btn', type: 'submit' }, 'إضافة فرع'));
  return [shopForm, branchForm, addBranch];
}

function resizeImage(file, max) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('تعذر قراءة الصورة'));
    img.src = URL.createObjectURL(file);
  });
}

// ===== الموظفون =====
async function staff() {
  const { users } = await api('GET', '/api/owner/users');
  const n = h('input', { class: 'input', maxlength: 40, required: true, placeholder: 'مثال: سارة' });
  const u = h('input', { class: 'input input-ltr', maxlength: 32, required: true, placeholder: 'sara', autocapitalize: 'none', spellcheck: 'false' });
  const p = h('input', { class: 'input input-ltr', type: 'text', minlength: 8, required: true, autocomplete: 'new-password', value: suggestPassword() });
  const role = h('select', { class: 'input' }, h('option', { value: 'staff' }, 'موظف'), h('option', { value: 'owner' }, 'مالك (كل الصلاحيات)'));
  const add = h('form', { class: 'section', onsubmit: (e) => {
    e.preventDefault();
    busyBtn(e.submitter, async () => {
      await api('POST', '/api/owner/users', { name: n.value, username: u.value, password: p.value, role: role.value });
      toast(`أُضيف الحساب. اسم الدخول: ${u.value.toLowerCase()}`, { type: 'ok', timeout: 8000 });
      route();
    });
  } },
    h('h2', null, 'إضافة حساب'),
    h('div', { class: 'grid2' }, field('الاسم الظاهر', n), field('اسم الدخول (لاتيني)', u), field('كلمة المرور', p, 'انسخها وأعطها للموظف. يمكنه تغييرها من «حسابي».'), field('الصلاحية', role)),
    h('button', { class: 'btn btn-primary', type: 'submit' }, 'إضافة'));
  const list = h('section', { class: 'section' }, h('h2', null, 'الحسابات'),
    h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, h('th', null, 'الاسم'), h('th', null, 'الدخول'), h('th', null, 'الصلاحية'), h('th', null, 'آخر دخول'), h('th', null, ''))),
      h('tbody', null, users.map((x) => h('tr', null,
        h('td', null, x.display_name, !x.active ? h('span', { class: 'chip chip-bad' }, ' موقوف') : null),
        h('td', { class: 'num' }, x.username),
        h('td', null, x.role === 'owner' ? 'مالك' : 'موظف'),
        h('td', { class: 'small muted' }, x.last_login_at ? ago(x.last_login_at) : '—'),
        h('td', null, x.id === S.me.user.id ? h('span', { class: 'muted small' }, 'أنت') : h('div', { class: 'row' },
          h('button', { class: 'btn btn-sm', type: 'button', onclick: async (e) => {
            const pw = suggestPassword();
            const ok = await confirmDialog({ title: `إعادة تعيين كلمة مرور ${x.display_name}؟`, body: `كلمة المرور الجديدة: ${pw} — ستُسجّل خروج كل أجهزته.`, confirm: 'تعيين' });
            if (ok) busyBtn(e.target, async () => { await api('PUT', `/api/owner/users/${x.id}`, { password: pw }); await copyText(pw); toast(`كلمة المرور الجديدة: ${pw} (نُسخت)`, { type: 'ok', timeout: 12000 }); });
          } }, 'كلمة مرور جديدة'),
          h('button', { class: `btn btn-sm ${x.active ? 'btn-danger' : ''}`, type: 'button', onclick: async (e) => {
            if (x.active && !(await confirmDialog({ title: `إيقاف حساب ${x.display_name}؟`, body: 'سيُسجَّل خروجه فورًا ولن يستطيع الدخول.', confirm: 'إيقاف', danger: true }))) return;
            busyBtn(e.target, async () => { await api('PUT', `/api/owner/users/${x.id}`, { active: !x.active }); route(); });
          } }, x.active ? 'إيقاف' : 'تفعيل')))))))));
  return [list, add];
}
function suggestPassword() {
  const a = 'abcdefghjkmnpqrstuvwxyz23456789';
  return [...crypto.getRandomValues(new Uint8Array(10))].map((b) => a[b % a.length]).join('');
}

// ===== شاشات العرض =====
async function displays() {
  const [{ displays: list }, st] = await Promise.all([api('GET', '/api/owner/displays'), api('GET', '/api/owner/status')]);
  const code = h('input', { class: 'input input-ltr num', maxlength: 7, required: true, placeholder: 'ABC234', autocapitalize: 'characters', autocomplete: 'off' });
  const name = h('input', { class: 'input', maxlength: 40, value: 'تابلت الكاشير' });
  const pair = h('form', { class: 'section', onsubmit: (e) => {
    e.preventDefault();
    busyBtn(e.submitter, async () => { await api('POST', '/api/owner/displays/claim', { code: code.value, name: name.value }); toast('تم الاقتران. يجب أن تتحول شاشة التابلت خلال ثوانٍ.', { type: 'ok', timeout: 7000 }); route(); });
  } },
    h('h2', null, 'اقتران شاشة'),
    h('ol', { class: 'test-steps' },
      h('li', null, 'على التابلت افتح المتصفح على: ', h('span', { class: 'code' }, `${st.publicUrl}/display`)),
      h('li', null, 'سيظهر رمز من 6 خانات. اكتبه هنا:')),
    h('div', { class: 'grid2' }, field('رمز الاقتران', code), field('اسم الشاشة', name)),
    h('button', { class: 'btn btn-primary', type: 'submit' }, 'اقتران'),
    h('p', { class: 'small muted' }, 'تبقى الشاشة مقترنة دون إعادة تسجيل دخول. لا ترى الشاشة إلا الطلب المعروض عليها. لملء الشاشة على آيباد: شارك ← «إضافة إلى الشاشة الرئيسية» ثم افتحها من الأيقونة.'));
  const active = list.filter((d) => !d.revoked_at);
  const tbl = h('section', { class: 'section' }, h('h2', null, 'الشاشات المقترنة'),
    active.length ? h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, h('th', null, 'الاسم'), h('th', null, 'آخر اتصال'), h('th', null, ''))),
      h('tbody', null, active.map((d) => h('tr', null, h('td', null, d.name), h('td', { class: 'small' }, d.last_seen_at ? ago(d.last_seen_at) : 'لم تتصل بعد'),
        h('td', null, h('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: async (e) => {
          if (!(await confirmDialog({ title: `إلغاء اقتران «${d.name}»؟`, body: 'ستعود الشاشة لصفحة الاقتران فورًا.', confirm: 'إلغاء الاقتران', danger: true }))) return;
          busyBtn(e.target, async () => { await api('DELETE', `/api/owner/displays/${d.id}`); toast('أُلغي الاقتران'); route(); });
        } }, 'إلغاء الاقتران')))))) : h('p', { class: 'muted' }, 'لا توجد شاشة مقترنة بعد.'));
  return [pair, tbl];
}

// ===== التنبيهات وحالة النظام =====
async function notify() {
  const st = await api('GET', '/api/owner/status');
  const d = st.deliveries7d;
  return [
    h('section', { class: 'section' },
      h('h2', null, 'وسائل التنبيه'),
      h('dl', { class: 'kv2' },
        h('dt', null, 'الرابط العام'), h('dd', { class: 'num' }, st.publicUrl, ' ', st.https ? h('span', { class: 'chip chip-ok' }, 'HTTPS') : h('span', { class: 'chip chip-bad' }, 'ليس HTTPS — التنبيهات لن تعمل')),
        h('dt', null, 'إشعارات الويب'), h('dd', null, st.webPush ? h('span', { class: 'chip chip-ok' }, 'مفعّلة (مفاتيح VAPID مُولّدة تلقائيًا)') : h('span', { class: 'chip chip-bad' }, 'غير مفعّلة')),
        h('dt', null, 'تطبيق آبل المصغّر (App Clip)'), h('dd', null, st.apns ? h('span', { class: 'chip chip-ok' }, 'APNs مُعد') : h('span', { class: 'chip' }, 'غير مُعد — يتطلب حساب مطوّر آبل (انظر دليل النشر)'))),
      h('div', { class: 'alert alert-info' }, h('div', null,
        h('b', null, 'ما الذي يعمل اليوم؟ '),
        'أندرويد (كروم/سامسونج/فايرفوكس): إشعار حتى والجوال مقفل بعد ضغط العميل «فعّل التنبيه». ',
        'آيفون: الصفحة المفتوحة تتحدث وتُصدر صوتًا؛ والإشعار والجوال مقفل يتطلب أن يضيف العميل الصفحة للشاشة الرئيسية (iOS 16.4+) أو تفعيل App Clip. ',
        'الوضع الصامت و«التركيز/عدم الإزعاج» وإعدادات الجهاز قد تمنع الصوت أو الإشعار — لا يمكن تجاوزها.'))),
    h('section', { class: 'section' },
      h('h2', null, 'إحصاءات آخر 7 أيام'),
      h('dl', { class: 'kv2' },
        h('dt', null, 'إشعارات أُرسلت'), h('dd', { class: 'num' }, String(d.total)),
        h('dt', null, 'قبلتها خدمة الإشعارات'), h('dd', { class: 'num' }, String(d.accepted)),
        h('dt', null, 'فشلت'), h('dd', { class: 'num' }, String(d.failed)),
        h('dt', null, 'أكّد الجهاز استلامها'), h('dd', { class: 'num' }, String(d.receipts)),
        h('dt', null, 'ظهرت في صفحة مفتوحة'), h('dd', { class: 'num' }, String(d.page)),
        h('dt', null, 'اشتراكات فعّالة الآن'), h('dd', { class: 'num' }, String(st.activeSubscriptions)),
        h('dt', null, 'مدة الاحتفاظ بالطلبات'), h('dd', null, `${st.retentionDays} يومًا ثم تُحذف تلقائيًا`))),
    h('section', { class: 'section' },
      h('h2', null, 'آخر الأخطاء'),
      st.recentErrors.length ? h('table', { class: 'tbl' }, h('tbody', null, st.recentErrors.map((e) => h('tr', null, h('td', { class: 'small' }, ago(e.at)), h('td', { class: 'small' }, e.message), h('td', { class: 'small num' }, [e.status, e.detail].filter(Boolean).join(' · '))))))
        : h('p', { class: 'muted' }, 'لا توجد أخطاء مسجلة.')),
  ];
}

// ===== مفاتيح API =====
async function apiKeys() {
  const { keys } = await api('GET', '/api/owner/api-keys');
  const name = h('input', { class: 'input', maxlength: 60, placeholder: 'مثال: نظام الكاشير', required: true });
  const out = h('div');
  const form = h('form', { class: 'section', onsubmit: (e) => {
    e.preventDefault();
    busyBtn(e.submitter, async () => {
      const r = await api('POST', '/api/owner/api-keys', { name: name.value });
      out.replaceChildren(h('div', { class: 'alert alert-warn stack' }, h('b', null, 'انسخ المفتاح الآن — لن يظهر مرة أخرى:'), h('div', { class: 'code' }, r.key),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: async () => toast((await copyText(r.key)) ? 'نُسخ' : 'تعذر النسخ') }, 'نسخ')));
      name.value = '';
      const list = await apiKeys();
      $('#content').replaceChildren(...list);
      $('#content').children[0].append(out);
    });
  } },
    h('h2', null, 'ربط الكاشير (لاحقًا)'),
    h('p', { class: 'muted' }, 'يسمح للكاشير بإنشاء الطلب ونداء العميل تلقائيًا. التوثيق: ', h('a', { href: '/api/v1/openapi.json', target: '_blank', rel: 'noopener' }, 'OpenAPI'), '. كل مفتاح مقيد بهذا الفرع فقط.'),
    field('اسم المفتاح', name), h('button', { class: 'btn btn-primary', type: 'submit' }, 'إنشاء مفتاح'), out);
  const list = h('section', { class: 'section' }, h('h2', null, 'المفاتيح'),
    keys.length ? h('table', { class: 'tbl' }, h('tbody', null, keys.map((k) => h('tr', null,
      h('td', null, k.name), h('td', { class: 'num small' }, `${k.prefix}_…`), h('td', { class: 'small' }, k.revoked_at ? 'ملغى' : k.last_used_at ? `آخر استخدام ${ago(k.last_used_at)}` : 'لم يُستخدم'),
      h('td', null, !k.revoked_at ? h('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: async (e) => {
        if (!(await confirmDialog({ title: 'إلغاء المفتاح؟', body: 'سيتوقف أي نظام يستخدمه فورًا.', confirm: 'إلغاء المفتاح', danger: true }))) return;
        busyBtn(e.target, async () => { await api('DELETE', `/api/owner/api-keys/${k.id}`); route(); });
      } }, 'إلغاء') : null))))) : h('p', { class: 'muted' }, 'لا توجد مفاتيح.'));
  return [form, list];
}

// ===== حسابي =====
async function account() {
  const cur = h('input', { class: 'input input-ltr', type: 'password', autocomplete: 'current-password', required: true });
  const nxt = h('input', { class: 'input input-ltr', type: 'password', autocomplete: 'new-password', minlength: 8, required: true });
  return h('form', { class: 'section', onsubmit: (e) => {
    e.preventDefault();
    busyBtn(e.submitter, async () => { await api('POST', '/api/me/password', { current: cur.value, next: nxt.value }); toast('تم تغيير كلمة المرور. سُجّل خروج أجهزتك الأخرى.', { type: 'ok' }); cur.value = ''; nxt.value = ''; });
  } },
    h('h2', null, 'حسابي'),
    h('p', null, `${S.me.user.name} — `, h('span', { class: 'num' }, S.me.user.username)),
    h('div', { class: 'grid2' }, field('كلمة المرور الحالية', cur), field('كلمة المرور الجديدة', nxt, '8 أحرف على الأقل')),
    h('button', { class: 'btn btn-primary', type: 'submit' }, 'تغيير كلمة المرور'));
}

init();

import { api, h, $, liveStream, coalesce, dateLabel, ago, ICONS } from './common.js';

const token = location.pathname.split('/')[2] || '';
const S = { data: null, error: null, live: 'connecting', lastSync: 0, sub: 'unknown', subError: null, wake: null, audioOn: false, ackBusy: false };

// ===== معلومات الجهاز (بلا بيانات شخصية) =====
function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return null; } return v; }
let clientId = store('nidaa.cid');
if (!clientId || !/^[A-Za-z0-9_-]{8,64}$/.test(clientId)) {
  clientId = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  store('nidaa.cid', clientId);
}
const ua = navigator.userAgent;
const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = /Android/.test(ua);
const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const iosVer = (() => { const m = /OS (\d+)_(\d+)/.exec(ua); return m ? Number(m[1]) + Number(m[2]) / 100 : 0; })();
const pushCapable = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext;
const capability = pushCapable ? 'push' : (isIOS && (iosVer === 0 || iosVer >= 16.04) && !standalone ? 'ios-needs-homescreen' : 'unsupported');
const platform = isIOS ? 'ios' : isAndroid ? 'android' : /Windows|Macintosh|Linux|CrOS/.test(ua) ? 'desktop' : 'other';
const permission = () => ('Notification' in window ? Notification.permission : 'unknown');
const viewer = () => ({ clientId, platform, standalone, capability, permission: permission() });

// ===== الصوت والاهتزاز =====
let actx;
function unlockAudio() {
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    S.audioOn = true;
  } catch { /* */ }
}
function chime(times = 3) {
  if (!actx) return;
  const notes = [880, 1175, 1568];
  for (let r = 0; r < times; r++) {
    notes.forEach((f, i) => {
      const t = actx.currentTime + r * 1.1 + i * 0.18;
      const o = actx.createOscillator(); const g = actx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.5, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      o.connect(g).connect(actx.destination); o.start(t); o.stop(t + 0.55);
    });
  }
}
function buzz() { try { navigator.vibrate?.([400, 150, 400, 150, 800]); } catch { /* */ } }
let titleTimer;
function flashTitle(on) {
  clearInterval(titleTimer);
  const base = S.data ? `طلب ${S.data.order.number} — ${S.data.shop.name}` : 'طلبك';
  if (!on) { document.title = base; return; }
  let x = false;
  titleTimer = setInterval(() => { x = !x; document.title = x ? '🔔 طلبك جاهز!' : base; }, 1000);
}
document.addEventListener('pointerdown', unlockAudio, { once: true });

// ===== الجلب والتحديث =====
async function hello() {
  try {
    S.data = await api('POST', `/api/public/o/${token}/hello`, viewer());
    S.error = null; S.lastSync = Date.now();
    afterData(true);
  } catch (e) { onError(e); }
}
const refresh = coalesce(async () => {
  try {
    S.data = await api('GET', `/api/public/o/${token}`);
    S.error = null; S.lastSync = Date.now();
    afterData(false);
  } catch (e) { onError(e); }
}, 150);

function onError(e) {
  if (e.status === 404 || e.status === 410) { S.error = e; S.data = null; render(); stream?.close(); return; }
  if (!S.data) { S.error = e; render(); setTimeout(hello, 4000); }
  setConn(navigator.onLine ? 'connecting' : 'offline');
}

let seenCall = store(`nidaa.call.${token}`);
let firstData = true;
function afterData(isHello) {
  const o = S.data.order;
  // نداء جديد: صوت واهتزاز وإثبات الظهور للموظف (فقط إن كانت الصفحة ظاهرة فعلًا)
  if (o.status === 'ready' && o.lastCall && o.lastCall.id !== seenCall) {
    if (!firstData || isHello) { chime(3); buzz(); }
    flashTitle(true);
    if (document.visibilityState === 'visible') markSeen(o.lastCall.id);
  }
  if (o.status !== 'ready') flashTitle(false);
  if (['delivered', 'cancelled'].includes(o.status)) releaseWake();
  firstData = false;
  render();
}
function markSeen(callId) {
  seenCall = callId; store(`nidaa.call.${token}`, callId);
  api('POST', `/api/public/o/${token}/receipt`, { channel: 'page', callId, clientId }).catch(() => {});
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  refresh();
  const o = S.data?.order;
  if (o?.status === 'ready' && o.lastCall && o.lastCall.id !== seenCall) markSeen(o.lastCall.id);
  if (S.wakeWanted) requestWake();
});

let stream;
function startStream() {
  stream = liveStream(`/api/public/o/${token}/stream?c=${clientId}`, {
    events: ['status'],
    onEvent: () => refresh(),
    onState: setConn,
    onReconnect: () => refresh(),
  });
  // احتياط: تحديث دوري خفيف إن تعطل البث في بعض الشبكات
  setInterval(() => { if (document.visibilityState === 'visible' && (S.live !== 'live' || Date.now() - S.lastSync > 60000)) refresh(); }, 15000);
}
function setConn(st) {
  S.live = st;
  if (st === 'live') S.lastSync = Date.now();
  const el = $('#conn');
  if (st === 'live' || !S.data) { el.hidden = true; return; }
  el.hidden = false;
  el.className = `c-conn ${st}`;
  el.textContent = st === 'offline' ? 'لا يوجد اتصال بالإنترنت — ستتحدث الحالة عند عودته' : `جارٍ إعادة الاتصال… آخر تحديث ${ago(new Date(S.lastSync).toISOString())}`;
}

// ===== التنبيهات =====
let swReg = null;
async function registerSW() {
  if (!pushCapable) return null;
  try { swReg = await navigator.serviceWorker.register('/sw.js', { scope: '/' }); return swReg; } catch { return null; }
}
function b64ToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
async function sendSubscription(sub) {
  await api('POST', `/api/public/o/${token}/push`, { ...viewer(), subscription: sub.toJSON() });
}
// إن كان الإذن ممنوحًا من قبل (عميل عائد) نربط الطلب تلقائيًا دون سؤال جديد
async function autoSubscribe() {
  if (!pushCapable || permission() !== 'granted' || !S.data?.push.vapidPublicKey) return;
  if (!['preparing', 'ready'].includes(S.data.order.status)) return;
  try {
    const reg = swReg || await registerSW();
    await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(S.data.push.vapidPublicKey) });
    await sendSubscription(sub);
    S.sub = 'on';
  } catch { S.sub = 'error'; }
  render();
}

async function enablePush(btn) {
  unlockAudio();
  // طلب الإذن مباشرة داخل لمسة المستخدم (شرط سفاري)
  const permP = Notification.requestPermission();
  btn.setAttribute('aria-busy', 'true'); btn.disabled = true;
  S.subError = null;
  try {
    const perm = await permP;
    api('POST', `/api/public/o/${token}/viewer`, viewer()).catch(() => {});
    if (perm !== 'granted') { S.sub = perm === 'denied' ? 'denied' : 'unknown'; render(); return; }
    const reg = swReg || await registerSW();
    if (!reg) throw new Error('sw');
    await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    const key = b64ToBytes(S.data.push.vapidPublicKey);
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    try { await sendSubscription(sub); } catch (e) {
      // اشتراك قديم بمفتاح مختلف: نجدده مرة واحدة
      if (e.status === 400) { await sub.unsubscribe(); sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }); await sendSubscription(sub); } else throw e;
    }
    S.sub = 'on';
  } catch (e) {
    S.sub = 'error';
    S.subError = e?.status === 409 ? 'انتهى هذا الطلب.' : e?.network ? 'تعذر الاتصال. تحقق من الإنترنت وحاول مجددًا.' : 'تعذّر تفعيل التنبيه على هذا المتصفح. أبقِ الصفحة مفتوحة وسنُصدر صوتًا عند الجاهزية.';
  } finally { btn.removeAttribute('aria-busy'); btn.disabled = false; render(); }
}

async function testPush(btn) {
  btn.disabled = true; btn.setAttribute('aria-busy', 'true');
  try {
    await api('POST', `/api/public/o/${token}/push/test`, { clientId });
    btn.textContent = 'أُرسل تنبيه تجريبي — يجب أن يظهر خلال ثوانٍ';
  } catch (e) { btn.textContent = e.message; } finally { btn.removeAttribute('aria-busy'); setTimeout(() => { btn.disabled = false; btn.textContent = 'تجربة التنبيه'; }, 8000); }
}

// ===== إبقاء الشاشة مضاءة =====
async function requestWake() {
  S.wakeWanted = true;
  try { S.wake = await navigator.wakeLock.request('screen'); S.wake.addEventListener('release', () => { S.wake = null; render(); }); } catch { S.wake = null; }
  render();
}
function releaseWake() { S.wakeWanted = false; S.wake?.release().catch(() => {}); S.wake = null; }

async function ack(btn) {
  if (S.ackBusy) return;
  S.ackBusy = true; btn.disabled = true; btn.setAttribute('aria-busy', 'true');
  try { S.data = await api('POST', `/api/public/o/${token}/ack`); flashTitle(false); render(); } catch (e) { btn.textContent = e.message; } finally { S.ackBusy = false; }
}

// ===== الرسم =====
const shareIcon = '<svg class="share-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>';
const raw = (html) => { const s = h('span'); s.innerHTML = html; return s; };

function render() {
  const app = $('#app');
  if (S.error && !S.data) {
    const expired = S.error.status === 410;
    const invalid = S.error.status === 404;
    document.title = expired ? 'انتهت صلاحية الرابط — نداء' : 'نداء';
    app.replaceChildren(h('div', { class: 'c-msg' },
      h('div', { class: 'ico', 'aria-hidden': 'true' }, expired ? '⌛' : invalid ? '🔍' : '⚠️'),
      h('h1', null, expired ? 'انتهت صلاحية هذا الرابط' : invalid ? 'الرابط غير صالح' : 'تعذّر تحميل طلبك'),
      h('p', { class: 'muted' }, expired ? 'هذا الطلب انتهى منذ مدة. إن كان لديك طلب جديد فامسح رمزه.' : invalid ? 'تأكد من مسح الرمز الصحيح، أو اسأل الموظف عن طلبك.' : 'تحقق من اتصالك بالإنترنت. سنعيد المحاولة تلقائيًا.'),
      !expired && !invalid ? h('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: () => location.reload() }, 'إعادة المحاولة') : null));
    return;
  }
  const { shop, order: o } = S.data;
  if (!titleTimer) document.title = `طلب ${o.number} — ${shop.name}`;
  const mark = shop.logoUrl ? h('img', { src: shop.logoUrl, alt: '' }) : h('span', { class: 'mark' }, raw(ICONS.logo));
  const header = h('a', { class: 'c-shop', href: `/s/${shop.slug}` }, mark, h('span', null, h('span', { class: 'name' }, shop.name), h('span', { class: 'branch' }, shop.branchName)));

  const heroCls = { ready: 'ready', delivered: 'done', cancelled: 'cancelled' }[o.status] || '';
  const stateLine = {
    preparing: [h('span', { class: 'prep-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), 'قيد التجهيز'],
    ready: ['🔔 طلبك جاهز!'],
    delivered: ['✓ تم الاستلام'],
    cancelled: [o.cancelReason === 'expired' ? 'انتهت مدة الطلب' : 'أُلغي الطلب'],
  }[o.status];
  const sub = {
    preparing: 'سننبهك فور جاهزيته',
    ready: shop.pickup ? `تفضل بالاستلام — ${shop.pickup}` : 'تفضل بالاستلام',
    delivered: 'بالعافية! شكرًا لزيارتك',
    cancelled: 'إن كان هذا خطأ، راجع الموظف',
  }[o.status];
  const hero = h('section', { class: `c-hero ${heroCls}`, 'aria-label': 'حالة الطلب' },
    h('div', { class: 'lbl' }, 'رقم طلبك'),
    h('div', { class: 'num-big num' }, String(o.number)),
    !o.isToday ? h('div', { class: 'date' }, `طلب يوم ${dateLabel(o.businessDate)}`) : null,
    h('div', { class: 'state', role: 'status' }, stateLine),
    h('div', { class: 'state-sub' }, sub),
    o.status === 'ready' ? ackBlock(o) : null);

  const parts = [header, hero];
  if (o.status === 'preparing' || o.status === 'ready') {
    if (shop.pickup && o.status === 'preparing') parts.push(h('div', { class: 'c-pickup' }, '📍', h('span', null, h('b', null, 'مكان الاستلام'), shop.pickup)));
    if (o.status === 'preparing') parts.push(notifyBlock());
  }
  parts.push(h('footer', { class: 'c-foot' },
    S.live === 'live' ? h('span', null, '● تتحدث الحالة تلقائيًا') : null,
    h('span', null, 'لا نطلب اسمك أو رقم جوالك. يعمل هذا الرابط لطلبك فقط.'),
    h('span', null, 'نداء')));
  app.replaceChildren(...parts);
}

function ackBlock(o) {
  const acked = o.customerAckAt && o.lastCall && new Date(o.customerAckAt) >= new Date(o.lastCall.at);
  if (acked) return h('div', { class: 'c-ready-ack', role: 'status' }, '✓ أبلغنا الموظف أنك في الطريق');
  return h('button', { class: 'btn btn-lg btn-block c-ack', type: 'button', onclick: (e) => ack(e.currentTarget) }, 'أنا في الطريق');
}

function notifyBlock() {
  const perm = permission();
  const testSound = h('button', { class: 'btn', type: 'button', onclick: () => { unlockAudio(); chime(1); buzz(); } }, '🔊 تجربة الصوت');
  const wakeBtn = 'wakeLock' in navigator
    ? (S.wake ? h('span', { class: 'chip chip-ok' }, 'الشاشة ستبقى مضاءة') : h('button', { class: 'btn', type: 'button', onclick: () => { unlockAudio(); requestWake(); } }, '☀️ أبقِ الشاشة مضاءة'))
    : null;

  if (!S.data.push.webPush) {
    return h('section', { class: 'c-card warn' }, h('h2', null, 'أبقِ هذه الصفحة مفتوحة'), h('p', null, 'سنُصدر صوتًا وتتغير الصفحة عند جاهزية طلبك.'), h('div', { class: 'c-row' }, testSound, wakeBtn));
  }
  if (capability === 'push') {
    if (S.sub === 'on' && perm === 'granted') {
      return h('section', { class: 'c-card ok' },
        h('h2', null, raw(ICONS.bell), 'التنبيه مفعّل على هذا الجهاز'),
        h('p', null, 'سيصلك إشعار عند جاهزية طلبك حتى لو أغلقت الصفحة. تأكد أن وضع «عدم الإزعاج» غير مفعّل.'),
        h('div', { class: 'c-row' }, h('button', { class: 'btn', type: 'button', onclick: (e) => testPush(e.currentTarget) }, 'تجربة التنبيه'), testSound));
    }
    if (perm === 'denied' || S.sub === 'denied') {
      return h('section', { class: 'c-card bad' },
        h('h2', null, 'التنبيهات محظورة لهذا الموقع'),
        h('p', null, 'أبقِ الصفحة مفتوحة وسنُصدر صوتًا عند الجاهزية. للتفعيل لاحقًا: من إعدادات المتصفح ← الأذونات ← الإشعارات لهذا الموقع.'),
        h('div', { class: 'c-row' }, testSound, wakeBtn));
    }
    return h('section', { class: 'c-card' },
      h('h2', null, raw(ICONS.bell), 'فعّل التنبيه'),
      h('p', null, 'ليصلك نداء عند جاهزية طلبك حتى لو أغلقت الصفحة أو قفلت الجوال.'),
      S.subError ? h('div', { class: 'alert alert-error', role: 'alert' }, S.subError) : null,
      h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', onclick: (e) => enablePush(e.currentTarget) }, 'فعّل التنبيه'),
      h('div', { class: 'c-row' }, testSound, wakeBtn));
  }
  if (capability === 'ios-needs-homescreen') {
    return h('section', { class: 'c-card warn' },
      h('h2', null, 'على آيفون: أبقِ هذه الصفحة مفتوحة'),
      h('p', null, 'ستتغير الصفحة وتُصدر صوتًا عند جاهزية طلبك (قد يكتم الوضع الصامت الصوت). اضغط «تجربة الصوت» الآن.'),
      h('div', { class: 'c-row' }, testSound, wakeBtn),
      h('details', null,
        h('summary', null, 'تريد تنبيهًا والجوال مقفل؟'),
        h('ol', { class: 'c-steps' },
          h('li', null, 'اضغط زر المشاركة ', raw(shareIcon), ' في سفاري'),
          h('li', null, 'اختر «إضافة إلى الشاشة الرئيسية»'),
          h('li', null, 'افتح «طلب ', String(S.data.order.number), '» من الشاشة الرئيسية واضغط «فعّل التنبيه»'))));
  }
  return h('section', { class: 'c-card warn' },
    h('h2', null, 'أبقِ هذه الصفحة مفتوحة'),
    h('p', null, 'متصفحك لا يدعم التنبيهات. ستتغير الصفحة وتُصدر صوتًا عند جاهزية طلبك.'),
    h('div', { class: 'c-row' }, testSound, wakeBtn));
}

// ===== البدء =====
if (!/^[A-Za-z0-9_-]{24}$/.test(token)) {
  S.error = { status: 404 }; render();
} else {
  registerSW();
  hello().then(() => { if (S.data) { startStream(); autoSubscribe(); } });
  navigator.serviceWorker?.addEventListener('message', (e) => { if (e.data?.t === 'call') refresh(); });
}

import { api, h, $, liveStream, coalesce, ICONS } from './common.js';

let stream = null; let pairTimer = null; let lastSuccessShown = null; let successTimer = null; let state = null; let wake = null;

async function boot() {
  try {
    const s = await api('GET', '/api/display/session');
    if (s.paired) startMain(); else startPairing();
  } catch {
    setStatus('offline', 'تعذر الاتصال بالخادم — إعادة المحاولة…');
    setTimeout(boot, 4000);
  }
}

// ===== الاقتران =====
async function startPairing() {
  stream?.close(); stream = null;
  $('#mainView').hidden = true; $('#pairView').hidden = false;
  clearInterval(pairTimer);
  try {
    const p = await api('POST', '/api/display/pair/start');
    $('#pairCode').textContent = p.code;
    $('#pairExpiry').textContent = 'الرمز صالح لمدة 15 دقيقة.';
    setStatus(null);
  } catch (e) {
    $('#pairCode').textContent = '······';
    $('#pairExpiry').textContent = e.message;
  }
  pairTimer = setInterval(async () => {
    try {
      const s = await api('GET', '/api/display/pair/status');
      if (s.state === 'paired') { clearInterval(pairTimer); startMain(); }
      else if (s.state === 'expired' || s.state === 'none') { clearInterval(pairTimer); $('#pairExpiry').textContent = 'انتهت صلاحية الرمز.'; $('#pairCode').textContent = '······'; }
      setStatus(null);
    } catch { setStatus('offline', 'انقطع الاتصال'); }
  }, 2500);
}
$('#newCode').addEventListener('click', startPairing);

// ===== العرض =====
function startMain() {
  $('#pairView').hidden = true; $('#mainView').hidden = false;
  keepAwake();
  const refetch = coalesce(load, 100);
  load();
  stream = liveStream('/api/display/stream', {
    events: ['display', 'revoked'],
    onEvent: (ev) => { if (ev === 'revoked') startPairing(); else refetch(); },
    onState: (st) => setStatus(st === 'live' ? null : st, st === 'offline' ? 'انقطع الإنترنت — الرمز المعروض ما زال صالحًا' : 'جارٍ إعادة الاتصال…'),
    onReconnect: refetch,
  });
  // احتياط إن توقف البث بصمت
  setInterval(() => { if (document.visibilityState === 'visible') refetch(); }, 60000);
}

async function load() {
  try {
    state = await api('GET', '/api/display/state');
    render();
  } catch (e) {
    if (e.status === 401) startPairing();
  }
}

function render() {
  const s = state;
  const logo = s.shop.logoUrl ? h('img', { src: s.shop.logoUrl, alt: '' }) : (() => { const x = h('span'); x.innerHTML = ICONS.logo; return x; })();
  $('#dLogo').replaceChildren(logo);
  $('#dShop').textContent = s.shop.name;
  document.title = `${s.shop.name} — شاشة الطلبات`;
  // نجاح الربط: يظهر مرة لكل طلب ثم يعود للطلب التالي أو الاستعداد
  const ls = s.lastSuccess;
  if (ls && ls.at !== lastSuccessShown?.at) {
    const age = new Date(s.serverTime) - new Date(ls.at);
    if (age < 6000) { lastSuccessShown = ls; showSuccess(ls.number); }
  }
  if (s.current) {
    $('#dOrder').hidden = false; $('#dIdle').hidden = true;
    $('#dNumber').textContent = s.current.number;
    $('#dQr').innerHTML = s.current.qrSvg; // SVG مولّد من الخادم
    const w = $('#dWait');
    w.hidden = !s.waiting;
    w.textContent = s.waiting ? `${s.waiting === 1 ? 'طلب واحد' : `${s.waiting} طلبات`} بعده — امسح ثم يظهر التالي` : '';
  } else {
    $('#dOrder').hidden = true; $('#dIdle').hidden = false;
    $('#dQr').replaceChildren();
    const l2 = logo.cloneNode(true);
    $('#dIdleLogo').replaceChildren(l2);
    $('#dIdleShop').textContent = `أهلًا بك في ${s.shop.name}`;
  }
}

function showSuccess(n) {
  $('#dSuccessNum').textContent = n;
  $('#dSuccess').hidden = false;
  clearTimeout(successTimer);
  successTimer = setTimeout(() => { $('#dSuccess').hidden = true; }, 2600);
}

function setStatus(kind, text) {
  const el = $('#dStatus');
  if (!kind) { el.hidden = true; return; }
  el.hidden = false; el.className = `d-status ${kind}`; el.textContent = text;
}

// ===== ملء الشاشة وإبقاء الشاشة مضاءة =====
const fsBtn = $('#fsBtn');
const standalone = matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches || navigator.standalone;
const canFs = document.fullscreenEnabled || document.webkitFullscreenEnabled;
function updateFs() {
  const inFs = document.fullscreenElement || document.webkitFullscreenElement;
  fsBtn.hidden = standalone || inFs;
  fsBtn.textContent = canFs ? 'ملء الشاشة' : 'لملء الشاشة: شارك ← إضافة إلى الشاشة الرئيسية';
}
fsBtn.addEventListener('click', async () => {
  const el = document.documentElement;
  try {
    if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  } catch { /* بعض الأجهزة لا تسمح */ }
  updateFs();
  keepAwake();
});
document.addEventListener('fullscreenchange', updateFs);
document.addEventListener('webkitfullscreenchange', updateFs);
updateFs();

async function keepAwake() {
  try { if ('wakeLock' in navigator && !wake) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } } catch { /* غير مدعوم */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });

boot();

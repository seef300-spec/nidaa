// أدوات مشتركة بين واجهات نداء
export class ApiError extends Error {
  constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra || {}; }
  get network() { return this.status === 0; }
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// كل الطلبات تمر من هنا. لا نعرض نجاحًا إلا إذا قبله الخادم.
export async function api(method, url, body, { idem, timeout = 15000, keepalive } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  const headers = { Accept: 'application/json' };
  if (method !== 'GET') headers['X-Nidaa'] = '1';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idem) headers['Idempotency-Key'] = idem;
  let res;
  try {
    res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: ctl.signal, credentials: 'same-origin', keepalive, cache: 'no-store' });
  } catch (e) {
    throw new ApiError(0, 'network', 'تعذر الاتصال بالخادم. تحقق من الإنترنت.');
  } finally { clearTimeout(t); }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const err = data?.error || {};
    throw new ApiError(res.status, err.code || 'error', err.message || `خطأ (${res.status})`, err);
  }
  return data;
}

// إعادة المحاولة بنفس مفتاح عدم التكرار عند انقطاع الشبكة فقط
export async function apiRetry(method, url, body, { idem, tries = 3, onRetry } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await api(method, url, body, { idem }); } catch (e) {
      last = e;
      if (!e.network) throw e;
      onRetry?.(i + 1);
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw last;
}

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v; // يُستخدم فقط مع محتوى من الخادم مضمون (SVG للـ QR)
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ===== الوقت =====
const nf = new Intl.NumberFormat('en-US');
export function ago(iso, now = Date.now()) {
  if (!iso) return '';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 45) return 'الآن';
  const m = Math.round(s / 60);
  if (m < 60) return m === 1 ? 'قبل دقيقة' : m === 2 ? 'قبل دقيقتين' : `قبل ${nf.format(m)} د`;
  const hr = Math.floor(m / 60);
  if (hr < 24) return hr === 1 ? 'قبل ساعة' : `قبل ${nf.format(hr)} س`;
  const d = Math.floor(hr / 24);
  return d === 1 ? 'أمس' : `قبل ${nf.format(d)} يوم`;
}
export function elapsed(iso, now = Date.now()) {
  if (!iso) return '';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}:${String(s % 60).padStart(2, '0')}`;
  return `${Math.floor(m / 60)}س ${m % 60}د`;
}
export function clock(iso, tz) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('ar-SA-u-nu-latn', { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(new Date(iso));
}
export function dateLabel(ymd) {
  if (!ymd) return '';
  const [y, m, d] = ymd.split('-').map(Number);
  return new Intl.DateTimeFormat('ar-SA-u-nu-latn-ca-gregory', { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}

// ===== التنبيهات المنبثقة =====
let toastBox;
export function toast(msg, { type = '', action, timeout = 4000 } = {}) {
  if (!toastBox) { toastBox = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(toastBox); }
  while (toastBox.children.length >= 3) toastBox.firstElementChild.remove();
  const el = h('div', { class: `toast ${type}` }, h('span', null, msg));
  if (action) el.append(h('button', { type: 'button', onclick: () => { action.fn(); el.remove(); } }, action.label));
  toastBox.append(el);
  setTimeout(() => el.remove(), action ? Math.max(timeout, 8000) : timeout);
  return el;
}
export const toastError = (e) => toast(e?.message || 'حدث خطأ', { type: 'error', timeout: 6000 });

// ===== نافذة التأكيد =====
export function confirmDialog({ title, body, confirm = 'تأكيد', cancel = 'تراجع', danger = false }) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'modal', 'aria-labelledby': 'cdlg-t' },
      h('div', { class: 'modal-body stack' }, h('h2', { id: 'cdlg-t' }, title), body ? h('p', { class: 'muted' }, body) : null),
      h('div', { class: 'modal-actions' },
        h('button', { class: `btn btn-lg ${danger ? 'btn-danger-solid' : 'btn-primary'}`, type: 'button', 'data-ok': '' }, confirm),
        h('button', { class: 'btn btn-lg', type: 'button', 'data-cancel': '' }, cancel)));
    document.body.append(dlg);
    const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.querySelector('[data-ok]').addEventListener('click', () => done(true));
    dlg.querySelector('[data-cancel]').addEventListener('click', () => done(false));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(false); });
    dlg.showModal();
    dlg.querySelector('[data-cancel]').focus();
  });
}

// ===== بث لحظي مع إعادة اتصال ومؤشر حالة =====
// onState('live'|'connecting'|'offline'), onEvent(name, data), onReconnect() لإعادة الجلب بعد الانقطاع
export function liveStream(url, { events = [], onEvent, onState, onReconnect }) {
  let es; let closed = false; let retry = 1000; let wasLive = false; let timer; let lastBeat = Date.now();
  const open = () => {
    if (closed) return;
    onState?.('connecting');
    es = new EventSource(url);
    lastBeat = Date.now();
    es.addEventListener('ping', () => { lastBeat = Date.now(); });
    es.addEventListener('hello', () => {
      lastBeat = Date.now();
      retry = 1000;
      onState?.('live');
      if (wasLive) onReconnect?.();
      wasLive = true;
    });
    for (const ev of events) es.addEventListener(ev, (m) => { lastBeat = Date.now(); let d = {}; try { d = JSON.parse(m.data); } catch { /* */ } onEvent?.(ev, d); });
    es.onerror = () => {
      es.close();
      onState?.(navigator.onLine ? 'connecting' : 'offline');
      clearTimeout(timer);
      timer = setTimeout(open, retry);
      retry = Math.min(retry * 2, 15000);
    };
  };
  const kick = () => { if (!closed) { clearTimeout(timer); es?.close(); retry = 1000; open(); } };
  window.addEventListener('online', kick);
  window.addEventListener('offline', () => { if (!closed) onState?.('offline'); });
  // اتصال ميت بصمت (شبكات الجوال): الخادم يرسل نبضة كل 20 ثانية، وغيابها 50 ثانية يعني إعادة الاتصال
  setInterval(() => { if (!closed && es?.readyState === 1 && Date.now() - lastBeat > 50000) { onState?.('connecting'); kick(); } }, 10000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && es?.readyState !== 1) kick(); });
  open();
  return { close: () => { closed = true; es?.close(); clearTimeout(timer); }, reconnect: kick };
}

// يدمج طلبات إعادة الجلب المتتالية في طلب واحد
export function coalesce(fn, wait = 250) {
  let t; let running = false; let again = false;
  const run = async () => {
    if (running) { again = true; return; }
    running = true;
    try { await fn(); } finally {
      running = false;
      if (again) { again = false; setTimeout(run, wait); }
    }
  };
  return () => { clearTimeout(t); t = setTimeout(run, wait); };
}

export const ICONS = {
  bell: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
  check: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
  plus: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  qr: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/></svg>',
  print: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>',
  copy: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  screen: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
  x: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  search: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
  phone: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/></svg>',
  undo: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg>',
  gear: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  logo: '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#17603f" d="M24 6c-8 0-13 6-13 13v8l-4 6h34l-4-6v-8c0-7-5-13-13-13z"/><path fill="#17603f" d="M19 37a5 5 0 0 0 10 0z"/><path d="M33 9c3 2 5 5 6 9M15 9c-3 2-5 5-6 9" stroke="#e0b44a" stroke-width="3" stroke-linecap="round" fill="none"/></svg>',
};
export const icon = (name) => { const s = document.createElement('span'); s.innerHTML = ICONS[name]; s.style.display = 'contents'; return s; };

export const STATUS = {
  preparing: { label: 'قيد التجهيز', cls: 'st-preparing' },
  ready: { label: 'جاهز للاستلام', cls: 'st-ready' },
  delivered: { label: 'تم التسليم', cls: 'st-delivered' },
  cancelled: { label: 'ملغي', cls: 'st-cancelled' },
};
export const statusBadge = (s, extra) => h('span', { class: `badge ${STATUS[s].cls}` }, h('span', { class: 'dot' }), extra || STATUS[s].label);

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const ta = h('textarea'); ta.style.position = 'fixed'; ta.style.opacity = '0'; ta.value = text; document.body.append(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  }
}

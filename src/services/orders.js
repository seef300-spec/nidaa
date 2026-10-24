// منطق الطلبات: الانتقالات، منع التكرار، التزامن، الاستعلامات.
// لا يعرف شيئًا عن واجهات العرض أو مزود الإشعارات.
import crypto from 'node:crypto';
import { tx } from '../db.js';
import { customerToken } from '../lib/crypto.js';
import { badRequest, conflict, notFound, gone, tooMany, AppError } from '../lib/errors.js';
import { businessDate } from '../lib/time.js';

export const STATUSES = ['preparing', 'ready', 'delivered', 'cancelled'];
export const ACTIVE = ['preparing', 'ready'];
const UNDO_WINDOW_SEC = 300;

// جدول الانتقالات المسموح بها — يُتحقق منه في الخادم فقط.
export const TRANSITIONS = {
  call:    { from: ['preparing'], to: 'ready' },
  recall:  { from: ['ready'], to: 'ready' },
  deliver: { from: ['preparing', 'ready'], to: 'delivered' },
  cancel:  { from: ['preparing', 'ready'], to: 'cancelled' },
  undo_deliver: { from: ['delivered'], to: null },
};

const ACTION_LABELS = {
  create: 'إنشاء', call: 'نداء', recall: 'إعادة نداء', deliver: 'تسليم', cancel: 'إلغاء',
  undo_deliver: 'تراجع عن التسليم', expire: 'انتهاء تلقائي', open: 'فتح العميل الرابط',
  ack: 'العميل أكد أنه قادم', display_show: 'عرض على الشاشة', display_hide: 'إخفاء من الشاشة',
  display_scanned: 'مُسح من الشاشة', display_skipped: 'تخطي العرض تلقائيًا', subscribe: 'تفعيل التنبيه',
};
export const actionLabel = (a) => ACTION_LABELS[a] || a;

function clean(s, max) {
  if (s === undefined || s === null) return null;
  if (typeof s !== 'string') throw badRequest('invalid_input', 'قيمة غير صالحة');
  const v = s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!v) return null;
  if (v.length > max) throw badRequest('too_long', `النص أطول من ${max} حرفًا`);
  return v;
}

export function requestHash(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj ?? {})).digest('hex');
}

// يحمي العملية من التكرار عند إعادة الإرسال الشبكي أو النقر المتكرر.
// المفتاح يُحفظ في نفس المعاملة مع النتيجة، فإما أن تُحفظ العملية والمفتاح معًا أو لا شيء.
export async function withIdempotency(pool, scope, key, reqHash, fn) {
  if (!key) {
    const out = await tx(pool, (c) => fn(c));
    return { ...out, replayed: false };
  }
  if (!/^[A-Za-z0-9_\-:.]{8,100}$/.test(key)) throw badRequest('invalid_idempotency_key', 'مفتاح عدم التكرار غير صالح');
  return tx(pool, async (c) => {
    const ins = await c.query(
      `INSERT INTO idempotency_keys(scope, key, request_hash) VALUES ($1,$2,$3)
       ON CONFLICT DO NOTHING RETURNING key`, [scope, key, reqHash]);
    if (ins.rowCount === 0) {
      const { rows } = await c.query('SELECT request_hash, status_code, response FROM idempotency_keys WHERE scope=$1 AND key=$2', [scope, key]);
      const r = rows[0];
      if (r.request_hash !== reqHash) throw new AppError(422, 'idempotency_mismatch', 'استُخدم مفتاح عدم التكرار لطلب مختلف');
      return { status: r.status_code, body: r.response, replayed: true, after: [] };
    }
    const out = await fn(c);
    await c.query('UPDATE idempotency_keys SET status_code=$3, response=$4 WHERE scope=$1 AND key=$2',
      [scope, key, out.status, JSON.stringify(out.body)]);
    return { ...out, replayed: false };
  });
}

async function logEvent(c, order, actor, action, fromStatus, toStatus, data) {
  await c.query(
    `INSERT INTO order_events(order_id, branch_id, actor_type, actor_id, actor_label, action, from_status, to_status, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [order.id, order.branch_id, actor.type, actor.id || null, actor.label || null, action, fromStatus, toStatus, data ? JSON.stringify(data) : null]);
}
export { logEvent };

export async function loadBranch(c, branchId) {
  const { rows } = await c.query(
    `SELECT b.*, t.name AS tenant_name, t.slug AS tenant_slug, t.logo_version, (t.logo IS NOT NULL) AS has_logo
       FROM branches b JOIN tenants t ON t.id=b.tenant_id WHERE b.id=$1`, [branchId]);
  if (!rows[0]) throw notFound('الفرع غير موجود');
  return rows[0];
}

// ===== إنشاء طلب =====
export async function createOrder(app, actor, input, idemKey) {
  const externalRef = clean(input.externalRef, 40);
  const note = clean(input.note, 300);
  const externalSource = clean(input.externalSource, 40);
  const externalId = clean(input.externalId, 100);
  if (externalId && !externalSource) throw badRequest('invalid_input', 'externalSource مطلوب مع externalId');
  const showOnDisplay = input.showOnDisplay;
  const scope = `${actor.type}:${actor.id}:create`;
  const hash = requestHash({ externalRef, note, externalSource, externalId, showOnDisplay });

  const out = await withIdempotency(app.pool, scope, idemKey, hash, async (c) => {
    const branch = await loadBranch(c, actor.branchId);
    // ربط خارجي: نفس معرف الكاشير لا ينشئ طلبًا ثانيًا
    if (externalId) {
      const ex = await c.query('SELECT id FROM orders WHERE branch_id=$1 AND external_source=$2 AND external_id=$3', [branch.id, externalSource, externalId]);
      if (ex.rows[0]) {
        const order = await getOrderForBranch(c, branch.id, ex.rows[0].id);
        return { status: 200, body: { order: await serializeStaffOne(c, app, order), duplicate: true }, after: [] };
      }
    }
    const now = new Date();
    const bdate = businessDate(now, branch.timezone, branch.day_start_hour);
    const ctr = await c.query(
      `INSERT INTO order_counters(branch_id, business_date, last_number) VALUES ($1,$2,1)
       ON CONFLICT (branch_id, business_date) DO UPDATE SET last_number = order_counters.last_number + 1
       RETURNING last_number`, [branch.id, bdate]);
    const number = ctr.rows[0].last_number;
    const autoshow = showOnDisplay === undefined ? branch.display_autoshow : !!showOnDisplay;
    const { rows } = await c.query(
      `INSERT INTO orders(tenant_id, branch_id, business_date, number, public_token, external_ref, external_source, external_id, note,
                          status, created_via, created_by, expires_at, link_expires_at, display_state, display_rank)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'preparing',$10,$11, now() + make_interval(hours => $12), now() + make_interval(hours => $12),
               $13, CASE WHEN $13::text IS NULL THEN NULL ELSE clock_timestamp() END)
       RETURNING *`,
      [branch.tenant_id, branch.id, bdate, number, customerToken(), externalRef, externalSource, externalId, note,
        actor.type === 'api' ? 'api' : 'staff', actor.type === 'user' ? actor.id : null, branch.order_ttl_hours,
        autoshow ? 'queued' : null]);
    const order = rows[0];
    await logEvent(c, order, actor, 'create', null, 'preparing', { number, externalRef: externalRef || undefined, autoshow });
    return { status: 201, body: { order: await serializeStaffOne(c, app, order) }, after: [['branch', order.branch_id], ['display', order.branch_id]] };
  });
  runAfter(app, out);
  return out;
}

function runAfter(app, out) {
  if (out.replayed) return;
  for (const [kind, id, extra] of out.after || []) {
    if (kind === 'branch') app.bus.branch(id, { type: 'orders' });
    else if (kind === 'display') app.bus.branch(id, { type: 'display' });
    else if (kind === 'order') app.bus.order(id, { type: 'status' });
    else if (kind === 'dispatch') app.notifier.dispatchCall(id).catch((e) => app.log.error({ err: e }, 'dispatch failed'));
    else if (kind === 'ended') app.notifier.orderEnded(id, extra).catch((e) => app.log.error({ err: e }, 'end notify failed'));
  }
}
export { runAfter };

export async function getOrderForBranch(c, branchId, orderId, lock = false) {
  if (!/^[0-9a-f-]{36}$/i.test(String(orderId))) throw notFound('الطلب غير موجود');
  const { rows } = await c.query(`SELECT * FROM orders WHERE id=$1 AND branch_id=$2 ${lock ? 'FOR UPDATE' : ''}`, [orderId, branchId]);
  if (!rows[0]) throw notFound('الطلب غير موجود');
  return rows[0];
}

// ===== الانتقالات =====
export async function transition(app, actor, orderId, action, { expectedVersion, idemKey } = {}) {
  const rule = TRANSITIONS[action];
  if (!rule) throw badRequest('invalid_action', 'إجراء غير معروف');
  if (expectedVersion !== undefined && expectedVersion !== null && !Number.isInteger(expectedVersion)) throw badRequest('invalid_version', 'رقم النسخة غير صالح');
  const scope = `${actor.type}:${actor.id}:${action}:${orderId}`;
  const out = await withIdempotency(app.pool, scope, idemKey, requestHash({ action, expectedVersion }), async (c) => {
    const order = await getOrderForBranch(c, actor.branchId, orderId, true);
    const branch = await loadBranch(c, order.branch_id);
    if (expectedVersion !== undefined && expectedVersion !== null && order.version !== expectedVersion) {
      throw conflict('version_conflict', 'تغيّر هذا الطلب من جهاز آخر. تم تحديث العرض.', { order: await serializeStaffOne(c, app, order) });
    }
    if (!rule.from.includes(order.status)) {
      throw conflict('invalid_transition', transitionError(action, order.status), { order: await serializeStaffOne(c, app, order) });
    }
    const after = [['branch', order.branch_id], ['order', order.id]];
    let updated;
    if (action === 'call' || action === 'recall') {
      if (action === 'recall' && order.last_called_at) {
        const elapsed = (Date.now() - new Date(order.last_called_at).getTime()) / 1000;
        if (elapsed < branch.recall_cooldown_sec) {
          const retryAfter = Math.ceil(branch.recall_cooldown_sec - elapsed);
          throw tooMany(`انتظر ${retryAfter} ثانية قبل إعادة النداء`, retryAfter);
        }
      }
      const r = await c.query(
        `UPDATE orders SET status='ready', ready_at=COALESCE(ready_at, now()), first_called_at=COALESCE(first_called_at, now()),
                last_called_at=now(), call_count=call_count+1, version=version+1,
                display_state = CASE WHEN display_state='queued' THEN 'done' ELSE display_state END,
                display_done_reason = CASE WHEN display_state='queued' THEN 'called' ELSE display_done_reason END
          WHERE id=$1 RETURNING *`, [order.id]);
      updated = r.rows[0];
      const call = await c.query(
        `INSERT INTO calls(order_id, seq, actor_type, actor_id) VALUES ($1,$2,$3,$4) RETURNING id`,
        [order.id, updated.call_count, actor.type, actor.type === 'user' ? actor.id : null]);
      const callId = call.rows[0].id;
      await c.query(
        `INSERT INTO deliveries(call_id, order_id, subscription_id, viewer_id, channel)
         SELECT $1, order_id, id, viewer_id, kind FROM push_subscriptions WHERE order_id=$2 AND status='active'`, [callId, order.id]);
      after.push(['dispatch', callId]);
      if (order.display_state === 'queued') after.push(['display', order.branch_id]);
      await logEvent(c, order, actor, action, order.status, 'ready', { seq: updated.call_count });
    } else if (action === 'deliver' || action === 'cancel') {
      const to = rule.to;
      const r = await c.query(
        `UPDATE orders SET status=$2, version=version+1,
                delivered_at = CASE WHEN $2='delivered' THEN now() ELSE delivered_at END,
                cancelled_at = CASE WHEN $2='cancelled' THEN now() ELSE cancelled_at END,
                cancel_reason = CASE WHEN $2='cancelled' THEN $3 ELSE cancel_reason END,
                link_expires_at = now() + make_interval(hours => $4),
                display_state = CASE WHEN display_state='queued' THEN 'done' ELSE display_state END,
                display_done_reason = CASE WHEN display_state='queued' THEN $2 ELSE display_done_reason END
          WHERE id=$1 RETURNING *`, [order.id, to, actor.type === 'api' ? 'api' : 'staff', branch.link_grace_hours]);
      updated = r.rows[0];
      // إغلاق ربط التنبيه بعد انتهاء الطلب
      await c.query(`UPDATE push_subscriptions SET status='closed', closed_reason=$2, updated_at=now() WHERE order_id=$1 AND status='active'`, [order.id, to]);
      if (order.display_state === 'queued') after.push(['display', order.branch_id]);
      after.push(['ended', order.id, to]);
      await logEvent(c, order, actor, action, order.status, to, null);
    } else if (action === 'undo_deliver') {
      const elapsed = (Date.now() - new Date(order.delivered_at).getTime()) / 1000;
      if (elapsed > UNDO_WINDOW_SEC) throw conflict('undo_expired', 'انتهت مهلة التراجع عن التسليم (5 دقائق)');
      const back = order.ready_at ? 'ready' : 'preparing';
      const r = await c.query(
        `UPDATE orders SET status=$2, delivered_at=NULL, version=version+1, link_expires_at=GREATEST(expires_at, now() + interval '1 hour')
          WHERE id=$1 RETURNING *`, [order.id, back]);
      updated = r.rows[0];
      await c.query(`UPDATE push_subscriptions SET status='active', closed_reason=NULL, updated_at=now() WHERE order_id=$1 AND status='closed' AND closed_reason='delivered'`, [order.id]);
      await logEvent(c, order, actor, action, 'delivered', back, null);
    }
    return { status: 200, body: { order: await serializeStaffOne(c, app, updated) }, after };
  });
  runAfter(app, out);
  return out;
}

function transitionError(action, status) {
  const st = { preparing: 'قيد التجهيز', ready: 'جاهز', delivered: 'مُسلَّم', cancelled: 'ملغي' }[status];
  if (action === 'call') return status === 'ready' ? 'تم نداء هذا الطلب بالفعل. استخدم «إعادة النداء».' : `لا يمكن نداء طلب ${st}`;
  if (action === 'recall') return `لا يمكن إعادة النداء لطلب ${st}`;
  if (action === 'undo_deliver') return 'الطلب ليس في حالة «مُسلَّم»';
  return `لا يمكن تنفيذ «${actionLabel(action)}» على طلب ${st}`;
}

// ===== شاشة العرض =====
export async function displayShow(app, actor, orderId) {
  const out = await tx(app.pool, async (c) => {
    const order = await getOrderForBranch(c, actor.branchId, orderId, true);
    if (!ACTIVE.includes(order.status)) throw conflict('invalid_transition', 'لا يمكن عرض طلب منتهٍ على الشاشة');
    // وضعه في المقدمة صراحةً بطلب الموظف
    await c.query(
      `UPDATE orders SET display_state='queued', display_done_reason=NULL, display_shown_at=NULL,
              display_rank = (SELECT COALESCE(MIN(display_rank), clock_timestamp()) - interval '1 second' FROM orders WHERE branch_id=$2 AND display_state='queued')
        WHERE id=$1`, [order.id, order.branch_id]);
    await logEvent(c, order, actor, 'display_show', null, null, null);
    return { after: [['display', order.branch_id], ['branch', order.branch_id]] };
  });
  runAfter(app, out);
}
export async function displayHide(app, actor, orderId) {
  const out = await tx(app.pool, async (c) => {
    const order = await getOrderForBranch(c, actor.branchId, orderId, true);
    if (order.display_state !== 'queued') return { after: [] };
    await c.query(`UPDATE orders SET display_state='done', display_done_reason='hidden' WHERE id=$1`, [order.id]);
    await logEvent(c, order, actor, 'display_hide', null, null, null);
    return { after: [['display', order.branch_id], ['branch', order.branch_id]] };
  });
  runAfter(app, out);
}

export async function displayState(app, branchId) {
  const c = app.pool;
  const branch = await loadBranch(c, branchId);
  // يحدد بداية العرض للطلب الحالي (يبدأ عدّاد التخطي من لحظة الظهور فعلًا)
  const cur = await c.query(
    `UPDATE orders SET display_shown_at = COALESCE(display_shown_at, now())
      WHERE id = (SELECT id FROM orders WHERE branch_id=$1 AND display_state='queued' ORDER BY display_rank, created_at LIMIT 1)
      RETURNING id, number, public_token, business_date, display_shown_at`, [branchId]);
  const waiting = await c.query(`SELECT count(*)::int AS n FROM orders WHERE branch_id=$1 AND display_state='queued'`, [branchId]);
  const last = await c.query(
    `SELECT number, first_opened_at FROM orders WHERE branch_id=$1 AND display_done_reason='scanned' AND first_opened_at > now() - interval '10 seconds'
      ORDER BY first_opened_at DESC LIMIT 1`, [branchId]);
  const current = cur.rows[0];
  return {
    serverTime: new Date().toISOString(),
    shop: shopPublic(branch),
    current: current ? { orderId: current.id, number: current.number, url: orderUrl(app, current.public_token), shownSince: current.display_shown_at } : null,
    waiting: Math.max(0, waiting.rows[0].n - (current ? 1 : 0)),
    lastSuccess: last.rows[0] ? { number: last.rows[0].number, at: last.rows[0].first_opened_at } : null,
  };
}

export function shopPublic(branch) {
  return {
    name: branch.tenant_name,
    slug: branch.tenant_slug,
    branchName: branch.name,
    logoUrl: branch.has_logo ? `/media/logo/${branch.tenant_slug}?v=${branch.logo_version}` : null,
    pickup: branch.pickup_instructions || '',
  };
}

export const orderUrl = (app, token) => `${app.config.publicUrl}/o/${token}`;

// ===== التسلسل للعرض =====
export async function serializeStaffOne(c, app, order) {
  const [s] = await serializeStaff(c, app, [order]);
  return s;
}

export async function serializeStaff(c, app, orders) {
  if (!orders.length) return [];
  const ids = orders.map((o) => o.id);
  // استعلامات متتالية: قد يكون c اتصالًا واحدًا داخل معاملة
  const viewers = await c.query(`SELECT order_id, platform, standalone, capability, permission, first_seen_at, last_seen_at FROM order_viewers WHERE order_id = ANY($1) ORDER BY first_seen_at`, [ids]);
  const subs = await c.query(`SELECT order_id, kind, status, closed_reason, count(*)::int AS n FROM push_subscriptions WHERE order_id = ANY($1) GROUP BY 1,2,3,4`, [ids]);
  const lastCalls = await c.query(
      `SELECT DISTINCT ON (cl.order_id) cl.order_id, cl.id, cl.seq, cl.created_at,
              (SELECT json_agg(json_build_object('channel', d.channel, 'sent', d.sent_at IS NOT NULL, 'accepted', d.accepted_at IS NOT NULL,
                                                 'failed', d.failed_at IS NOT NULL, 'receipt', d.receipt_at IS NOT NULL, 'error', d.error))
                 FROM deliveries d WHERE d.call_id = cl.id) AS deliveries
         FROM calls cl WHERE cl.order_id = ANY($1) ORDER BY cl.order_id, cl.seq DESC`, [ids]);
  const by = (rows) => rows.reduce((m, r) => ((m[r.order_id] ||= []).push(r), m), {});
  const V = by(viewers.rows), S = by(subs.rows), L = Object.fromEntries(lastCalls.rows.map((r) => [r.order_id, r]));
  return orders.map((o) => {
    const vs = V[o.id] || [];
    const ss = S[o.id] || [];
    const activeSubs = ss.filter((s) => s.status === 'active').reduce((n, s) => n + s.n, 0);
    const expiredSubs = ss.filter((s) => s.status === 'expired').reduce((n, s) => n + s.n, 0);
    const lc = L[o.id];
    const ds = lc?.deliveries || [];
    const push = ds.filter((d) => d.channel !== 'page');
    return {
      id: o.id,
      number: o.number,
      businessDate: o.business_date,
      status: o.status,
      cancelReason: o.cancel_reason,
      version: o.version,
      externalRef: o.external_ref,
      externalSource: o.external_source,
      externalId: o.external_id,
      note: o.note,
      createdVia: o.created_via,
      createdAt: o.created_at,
      readyAt: o.ready_at,
      firstCalledAt: o.first_called_at,
      lastCalledAt: o.last_called_at,
      callCount: o.call_count,
      deliveredAt: o.delivered_at,
      cancelledAt: o.cancelled_at,
      expiresAt: o.expires_at,
      url: orderUrl(app, o.public_token),
      display: { state: o.display_state, reason: o.display_done_reason },
      customer: {
        opened: !!o.first_opened_at,
        firstOpenedAt: o.first_opened_at,
        lastSeenAt: o.last_seen_at,
        ackAt: o.customer_ack_at,
        devices: vs.length,
        viewers: vs.map((v) => ({ platform: v.platform, standalone: v.standalone, capability: v.capability, permission: v.permission, lastSeenAt: v.last_seen_at })),
      },
      notify: {
        activeSubscriptions: activeSubs,
        expiredSubscriptions: expiredSubs,
        // أفضل حالة تنبيه معروفة — من بيانات تحقق فعلية فقط
        state: activeSubs > 0 ? 'subscribed'
          : vs.some((v) => v.permission === 'denied') ? 'denied'
          : expiredSubs > 0 ? 'expired'
          : vs.length && vs.every((v) => v.capability === 'unsupported' || v.capability === 'ios-needs-homescreen') ? 'unsupported'
          : vs.length ? 'not_enabled' : 'unknown',
      },
      lastCall: lc ? {
        seq: lc.seq,
        at: lc.created_at,
        pushTotal: push.length,
        pushSent: push.filter((d) => d.sent).length,
        pushAccepted: push.filter((d) => d.accepted).length,
        pushFailed: push.filter((d) => d.failed).length,
        deviceReceipts: push.filter((d) => d.receipt).length,
        pageSeen: ds.filter((d) => d.channel === 'page' && d.receipt).length,
      } : null,
      undoUntil: o.status === 'delivered' && o.delivered_at ? new Date(new Date(o.delivered_at).getTime() + UNDO_WINDOW_SEC * 1000) : null,
    };
  });
}

// ===== قائمة/بحث مع ترقيم صفحات =====
export async function listOrders(app, branchId, { filter = 'active', q, date, cursor, limit = 50 }) {
  limit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const where = ['branch_id = $1'];
  const args = [branchId];
  const add = (sql, v) => { args.push(v); where.push(sql.replace('?', `$${args.length}`)); };
  if (filter === 'active') where.push(`status IN ('preparing','ready')`);
  else if (STATUSES.includes(filter)) add('status = ?', filter);
  else if (filter !== 'all') throw badRequest('invalid_filter', 'تصفية غير معروفة');
  if (date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest('invalid_date', 'تاريخ غير صالح');
    add('business_date = ?', date);
  }
  if (q) {
    const s = String(q).trim().slice(0, 40);
    if (/^\d{1,6}$/.test(s)) {
      args.push(Number(s)); const n = args.length;
      args.push(s.toLowerCase() + '%');
      where.push(`(number = $${n} OR lower(external_ref) LIKE $${args.length})`);
    } else if (s) {
      add(`lower(external_ref) LIKE ?`, s.toLowerCase().replace(/[%_\\]/g, (m) => '\\' + m) + '%');
    }
  }
  const asc = filter === 'active';
  if (cursor) {
    let cur;
    try { cur = JSON.parse(Buffer.from(String(cursor), 'base64url').toString()); } catch { throw badRequest('invalid_cursor', 'مؤشر صفحة غير صالح'); }
    args.push(cur.t, cur.id);
    where.push(asc ? `(created_at, id) > ($${args.length - 1}::timestamptz, $${args.length}::uuid)` : `(created_at, id) < ($${args.length - 1}::timestamptz, $${args.length}::uuid)`);
  }
  args.push(limit + 1);
  const { rows } = await app.pool.query(
    `SELECT * FROM orders WHERE ${where.join(' AND ')} ORDER BY created_at ${asc ? 'ASC' : 'DESC'}, id ${asc ? 'ASC' : 'DESC'} LIMIT $${args.length}`, args);
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const counts = await app.pool.query(
    `SELECT status, count(*)::int AS n FROM orders WHERE branch_id=$1 AND (status IN ('preparing','ready') OR business_date = $2) GROUP BY status`,
    [branchId, await todayFor(app, branchId)]);
  return {
    orders: await serializeStaff(app.pool, app, page),
    nextCursor: more ? Buffer.from(JSON.stringify({ t: last.created_at, id: last.id })).toString('base64url') : null,
    counts: Object.fromEntries(counts.rows.map((r) => [r.status, r.n])),
    today: await todayFor(app, branchId),
  };
}

export async function todayFor(app, branchId) {
  const b = await loadBranch(app.pool, branchId);
  return businessDate(new Date(), b.timezone, b.day_start_hour);
}

export async function orderEvents(app, branchId, orderId) {
  await getOrderForBranch(app.pool, branchId, orderId);
  const { rows } = await app.pool.query(
    `SELECT at, actor_type, actor_label, action, from_status, to_status, data FROM order_events WHERE order_id=$1 ORDER BY at, id`, [orderId]);
  return rows.map((r) => ({ ...r, actionLabel: actionLabel(r.action) }));
}

// ===== صيانة دورية =====
export async function expireAbandoned(app) {
  const { rows } = await app.pool.query(
    `UPDATE orders SET status='cancelled', cancel_reason='expired', cancelled_at=now(), version=version+1,
            link_expires_at = now() + interval '1 hour',
            display_state = CASE WHEN display_state='queued' THEN 'done' ELSE display_state END,
            display_done_reason = CASE WHEN display_state='queued' THEN 'expired' ELSE display_done_reason END
      WHERE status IN ('preparing','ready') AND expires_at < now()
      RETURNING id, branch_id, status`);
  for (const o of rows) {
    await app.pool.query(`UPDATE push_subscriptions SET status='closed', closed_reason='expired', updated_at=now() WHERE order_id=$1 AND status='active'`, [o.id]);
    await logEvent(app.pool, o, { type: 'system', label: 'النظام' }, 'expire', null, 'cancelled', null);
    app.bus.branch(o.branch_id, { type: 'orders' });
    app.bus.branch(o.branch_id, { type: 'display' });
    app.bus.order(o.id, { type: 'status' });
    app.notifier.orderEnded(o.id, 'cancelled').catch(() => {});
  }
  return rows.length;
}

export async function autoSkipDisplay(app) {
  // يتخطى الطلب المعروض فقط إذا طال عرضه وهناك طلبات أخرى تنتظر — لا يبدّل الرمز أثناء المسح المعتاد
  const { rows } = await app.pool.query(
    `WITH cur AS (
       SELECT DISTINCT ON (o.branch_id) o.id, o.branch_id, o.display_shown_at, b.display_skip_sec
         FROM orders o JOIN branches b ON b.id=o.branch_id
        WHERE o.display_state='queued' ORDER BY o.branch_id, o.display_rank, o.created_at)
     UPDATE orders o SET display_state='done', display_done_reason='skipped'
       FROM cur
      WHERE o.id = cur.id AND cur.display_skip_sec > 0 AND cur.display_shown_at < now() - make_interval(secs => cur.display_skip_sec)
        AND (SELECT count(*) FROM orders x WHERE x.branch_id = cur.branch_id AND x.display_state='queued') > 1
      RETURNING o.id, o.branch_id`);
  for (const o of rows) {
    await logEvent(app.pool, o, { type: 'system', label: 'النظام' }, 'display_skipped', null, null, null);
    app.bus.branch(o.branch_id, { type: 'display' });
    app.bus.branch(o.branch_id, { type: 'orders' });
  }
  return rows.length;
}

export { gone };

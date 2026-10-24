// منطق صفحة العميل: صلاحية الرابط تمنح متابعة طلب واحد فقط.
import { tx } from '../db.js';
import { badRequest, notFound, gone, conflict } from '../lib/errors.js';
import { loadBranch, shopPublic, logEvent } from './orders.js';
import { businessDate } from '../lib/time.js';

const TOKEN_RE = /^[A-Za-z0-9_-]{24}$/;
const CLIENT_RE = /^[A-Za-z0-9_-]{8,64}$/;
const PLATFORMS = ['ios', 'android', 'desktop', 'other', 'unknown'];
const CAPS = ['push', 'ios-needs-homescreen', 'unsupported', 'apns', 'unknown'];
const PERMS = ['default', 'granted', 'denied', 'unknown', 'ephemeral'];

export async function loadByToken(c, token, { allowExpired = false } = {}) {
  if (!TOKEN_RE.test(String(token))) throw notFound('الرابط غير صالح');
  const { rows } = await c.query('SELECT * FROM orders WHERE public_token=$1', [token]);
  const o = rows[0];
  if (!o) throw notFound('الرابط غير صالح');
  if (!allowExpired && new Date(o.link_expires_at) < new Date()) throw gone('link_expired', 'انتهت صلاحية هذا الرابط');
  return o;
}

export async function publicView(app, order) {
  const branch = await loadBranch(app.pool, order.branch_id);
  const today = businessDate(new Date(), branch.timezone, branch.day_start_hour);
  const lastCall = order.call_count
    ? (await app.pool.query('SELECT id, seq, created_at FROM calls WHERE order_id=$1 ORDER BY seq DESC LIMIT 1', [order.id])).rows[0]
    : null;
  return {
    shop: shopPublic(branch),
    order: {
      number: order.number,
      status: order.status,
      // الإلغاء التلقائي يظهر للعميل كإلغاء مع سبب مفهوم
      cancelReason: order.cancel_reason === 'expired' ? 'expired' : order.cancel_reason ? 'cancelled' : null,
      businessDate: order.business_date,
      isToday: order.business_date === today,
      createdAt: order.created_at,
      readyAt: order.ready_at,
      deliveredAt: order.delivered_at,
      cancelledAt: order.cancelled_at,
      customerAckAt: order.customer_ack_at,
      lastCall: lastCall ? { id: lastCall.id, seq: lastCall.seq, at: lastCall.created_at } : null,
    },
    push: { vapidPublicKey: app.notifier.vapidPublicKey(), webPush: app.notifier.webPushEnabled() },
    linkExpiresAt: order.link_expires_at,
    serverTime: new Date().toISOString(),
  };
}

function viewerInput(body) {
  const clientId = String(body?.clientId || '');
  if (!CLIENT_RE.test(clientId)) throw badRequest('invalid_client', 'معرّف جهاز غير صالح');
  const pick = (v, list) => (list.includes(v) ? v : 'unknown');
  return {
    clientId,
    platform: pick(body.platform, PLATFORMS),
    standalone: body.standalone === true,
    capability: pick(body.capability, CAPS),
    permission: pick(body.permission, PERMS),
  };
}

// يسجّل فتح الرابط من جهاز. فتحه من أكثر من جهاز مسموح وكل جهاز يُسجَّل منفصلًا.
export async function hello(app, token, body) {
  const v = viewerInput(body);
  const res = await tx(app.pool, async (c) => {
    const order = await loadByToken(c, token);
    const { rows } = await c.query(
      `INSERT INTO order_viewers(order_id, client_id, platform, standalone, capability, permission)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (order_id, client_id) DO UPDATE SET platform=EXCLUDED.platform, standalone=EXCLUDED.standalone,
              capability=EXCLUDED.capability, permission=EXCLUDED.permission, last_seen_at=now()
       RETURNING id, (xmax = 0) AS inserted`,
      [order.id, v.clientId, v.platform, v.standalone, v.capability, v.permission]);
    const firstOpen = !order.first_opened_at;
    const upd = await c.query(
      `UPDATE orders SET first_opened_at = COALESCE(first_opened_at, now()), last_seen_at = now(),
              display_state = CASE WHEN display_state='queued' AND $2 THEN 'done' ELSE display_state END,
              display_done_reason = CASE WHEN display_state='queued' AND $2 THEN 'scanned' ELSE display_done_reason END
        WHERE id=$1 RETURNING *`, [order.id, ['preparing', 'ready'].includes(order.status)]);
    if (firstOpen) await logEvent(c, order, { type: 'customer', label: 'العميل' }, 'open', null, null, { platform: v.platform });
    else if (rows[0].inserted) await logEvent(c, order, { type: 'customer', label: 'العميل' }, 'open', null, null, { platform: v.platform, extraDevice: true });
    return { order: upd.rows[0], viewerId: rows[0].id, displayChanged: order.display_state === 'queued' };
  });
  app.bus.branch(res.order.branch_id, { type: 'orders' });
  if (res.displayChanged) app.bus.branch(res.order.branch_id, { type: 'display' });
  return publicView(app, res.order);
}

export async function updateViewer(app, token, body) {
  const v = viewerInput(body);
  const order = await loadByToken(app.pool, token);
  const r = await app.pool.query(
    `UPDATE order_viewers SET platform=$3, standalone=$4, capability=$5, permission=$6, last_seen_at=now()
      WHERE order_id=$1 AND client_id=$2 RETURNING id`, [order.id, v.clientId, v.platform, v.standalone, v.capability, v.permission]);
  if (!r.rowCount) throw notFound('افتح الطلب أولًا');
  app.bus.branch(order.branch_id, { type: 'orders' });
  return { ok: true };
}

// آخر ظهور: نحدّثه بحد أقصى مرة كل 30 ثانية لتقليل الكتابة
export async function touch(app, orderId, clientId) {
  await app.pool.query(`UPDATE orders SET last_seen_at=now() WHERE id=$1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval '30 seconds')`, [orderId]);
  if (clientId && CLIENT_RE.test(clientId)) {
    await app.pool.query(`UPDATE order_viewers SET last_seen_at=now() WHERE order_id=$1 AND client_id=$2 AND last_seen_at < now() - interval '30 seconds'`, [orderId, clientId]);
  }
}

// السماح فقط بخدمات الإشعارات المعروفة — يمنع استغلال الخادم لإرسال طلبات لعناوين داخلية
const PUSH_HOSTS = [/(^|\.)push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/, /^web\.push\.apple\.com$/];
export function allowedEndpoint(app, endpoint) {
  let u;
  try { u = new URL(endpoint); } catch { return false; }
  const extra = (process.env.PUSH_ENDPOINT_ALLOW || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (extra.some((p) => endpoint.startsWith(p))) return true;
  return u.protocol === 'https:' && PUSH_HOSTS.some((re) => re.test(u.hostname));
}

export async function subscribeWebPush(app, token, body) {
  const v = viewerInput(body);
  const sub = body?.subscription;
  const endpoint = String(sub?.endpoint || '');
  const p256dh = String(sub?.keys?.p256dh || '');
  const auth = String(sub?.keys?.auth || '');
  if (!endpoint || endpoint.length > 1000 || !allowedEndpoint(app, endpoint)) throw badRequest('invalid_subscription', 'اشتراك تنبيه غير صالح');
  if (!/^[A-Za-z0-9_-]{40,200}$/.test(p256dh) || !/^[A-Za-z0-9_-]{8,64}$/.test(auth)) throw badRequest('invalid_subscription', 'اشتراك تنبيه غير صالح');
  return saveSubscription(app, token, v, 'webpush', { endpoint, p256dh, auth });
}

export async function subscribeApns(app, token, body) {
  const v = viewerInput({ ...body, capability: 'apns' });
  const kind = body?.type === 'liveactivity' ? 'apns_liveactivity' : 'apns_alert';
  const deviceToken = String(body?.deviceToken || '');
  const env = body?.environment === 'sandbox' ? 'sandbox' : 'production';
  if (!/^[0-9a-fA-F]{32,200}$/.test(deviceToken)) throw badRequest('invalid_subscription', 'رمز جهاز غير صالح');
  return saveSubscription(app, token, v, kind, { endpoint: deviceToken.toLowerCase(), apnsEnv: env });
}

async function saveSubscription(app, token, v, kind, s) {
  const res = await tx(app.pool, async (c) => {
    const order = await loadByToken(c, token);
    if (!['preparing', 'ready'].includes(order.status)) throw conflict('order_closed', 'انتهى هذا الطلب ولم يعد التنبيه متاحًا');
    const viewer = await c.query(
      `INSERT INTO order_viewers(order_id, client_id, platform, standalone, capability, permission)
       VALUES ($1,$2,$3,$4,$5,'granted')
       ON CONFLICT (order_id, client_id) DO UPDATE SET capability=EXCLUDED.capability, permission='granted', last_seen_at=now()
       RETURNING id`, [order.id, v.clientId, v.platform, v.standalone, v.capability]);
    const viewerId = viewer.rows[0].id;
    const ins = await c.query(
      `INSERT INTO push_subscriptions(order_id, viewer_id, kind, endpoint, p256dh, auth, apns_env)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (order_id, kind, endpoint) DO UPDATE SET status='active', closed_reason=NULL, last_error=NULL,
              p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth, viewer_id=EXCLUDED.viewer_id, updated_at=now()
       RETURNING id`, [order.id, viewerId, kind, s.endpoint, s.p256dh || null, s.auth || null, s.apnsEnv || null]);
    // جهاز واحد = اشتراك ويب واحد فعّال لكل طلب (استبدال الاشتراك القديم عند تجديده)
    if (kind === 'webpush') {
      await c.query(`UPDATE push_subscriptions SET status='closed', closed_reason='replaced', updated_at=now()
                      WHERE order_id=$1 AND viewer_id=$2 AND kind='webpush' AND id<>$3 AND status='active'`, [order.id, viewerId, ins.rows[0].id]);
    }
    await logEvent(c, order, { type: 'customer', label: 'العميل' }, 'subscribe', null, null, { kind });
    return { order, subscriptionId: ins.rows[0].id };
  });
  app.bus.branch(res.order.branch_id, { type: 'orders' });
  // إن كان الطلب جاهزًا بالفعل ولم يرَ العميل النداء، نرسل له النداء الحالي على هذا الاشتراك
  if (res.order.status === 'ready') app.notifier.sendLatestCallTo(res.order.id, res.subscriptionId).catch(() => {});
  return { ok: true, subscriptionId: res.subscriptionId };
}

export async function unsubscribe(app, token, body) {
  const order = await loadByToken(app.pool, token, { allowExpired: true });
  const endpoint = String(body?.endpoint || '');
  await app.pool.query(`UPDATE push_subscriptions SET status='closed', closed_reason='customer', updated_at=now() WHERE order_id=$1 AND endpoint=$2 AND status='active'`, [order.id, endpoint]);
  app.bus.branch(order.branch_id, { type: 'orders' });
  return { ok: true };
}

// دليل الاستلام: من عامل الخدمة (إشعار) أو من الصفحة المفتوحة.
export async function receipt(app, token, body) {
  const order = await loadByToken(app.pool, token, { allowExpired: true });
  const channel = body?.channel;
  if (channel === 'push') {
    const id = String(body?.deliveryId || '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw badRequest('invalid_delivery', 'غير صالح');
    const r = await app.pool.query(`UPDATE deliveries SET receipt_at=COALESCE(receipt_at, now()) WHERE id=$1 AND order_id=$2 RETURNING id`, [id, order.id]);
    if (!r.rowCount) throw notFound();
  } else if (channel === 'page') {
    const callId = String(body?.callId || '');
    const clientId = String(body?.clientId || '');
    if (!/^[0-9a-f-]{36}$/i.test(callId) || !CLIENT_RE.test(clientId)) throw badRequest('invalid_receipt', 'غير صالح');
    const call = await app.pool.query('SELECT id FROM calls WHERE id=$1 AND order_id=$2', [callId, order.id]);
    if (!call.rowCount) throw notFound();
    const viewer = await app.pool.query('SELECT id FROM order_viewers WHERE order_id=$1 AND client_id=$2', [order.id, clientId]);
    if (!viewer.rowCount) throw notFound();
    await app.pool.query(
      `INSERT INTO deliveries(call_id, order_id, viewer_id, channel, sent_at, accepted_at, receipt_at)
       VALUES ($1,$2,$3,'page',now(),now(),now()) ON CONFLICT DO NOTHING`, [callId, order.id, viewer.rows[0].id]);
  } else throw badRequest('invalid_receipt', 'غير صالح');
  app.bus.branch(order.branch_id, { type: 'orders' });
  return { ok: true };
}

export async function customerAck(app, token) {
  const res = await tx(app.pool, async (c) => {
    const order = await loadByToken(c, token);
    if (order.status !== 'ready') throw conflict('not_ready', 'الطلب ليس جاهزًا بعد');
    if (order.customer_ack_at && new Date(order.customer_ack_at) > new Date(order.last_called_at)) return order;
    const { rows } = await c.query('UPDATE orders SET customer_ack_at=now() WHERE id=$1 RETURNING *', [order.id]);
    await logEvent(c, order, { type: 'customer', label: 'العميل' }, 'ack', null, null, null);
    return rows[0];
  });
  app.bus.branch(res.branch_id, { type: 'orders' });
  app.bus.order(res.id, { type: 'status' });
  return publicView(app, res);
}

// تنبيه تجريبي يمر بالمسار الحقيقي كاملًا (الخادم ← خدمة الإشعارات ← الجهاز)
export async function testPush(app, token, body) {
  const clientId = String(body?.clientId || '');
  if (!CLIENT_RE.test(clientId)) throw badRequest('invalid_client', 'معرّف جهاز غير صالح');
  const order = await loadByToken(app.pool, token);
  const { rows } = await app.pool.query(
    `SELECT s.* FROM push_subscriptions s JOIN order_viewers v ON v.id=s.viewer_id
      WHERE s.order_id=$1 AND v.client_id=$2 AND s.status='active' AND s.kind='webpush' ORDER BY s.updated_at DESC LIMIT 1`, [order.id, clientId]);
  if (!rows[0]) throw conflict('no_subscription', 'التنبيه غير مفعّل على هذا الجهاز');
  const res = await app.notifier.sendTest(order, rows[0]);
  if (!res.accepted) throw conflict('push_failed', 'لم تقبل خدمة الإشعارات التنبيه. أعد تفعيل التنبيه.');
  return { ok: true };
}

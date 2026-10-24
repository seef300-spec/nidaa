// منسّق التنبيهات: يقرر ماذا يُرسل لكل اشتراك ويسجل الأدلة (أُرسل/قُبل/فشل/استُلم).
import webpush from 'web-push';
import { WebPushProvider } from './webpush.js';
import { ApnsProvider } from './apns.js';
import { loadBranch } from '../orders.js';

const RETRY_DELAYS = [2000, 6000];

export class Notifier {
  constructor(app) {
    this.app = app;
    this.web = null;
    this.apns = new ApnsProvider(app.config.apns);
  }

  async init() {
    const cfg = this.app.config.vapid;
    let keys = cfg.publicKey && cfg.privateKey ? { publicKey: cfg.publicKey, privateKey: cfg.privateKey } : null;
    if (!keys) {
      // توليد مفاتيح VAPID تلقائيًا مرة واحدة وحفظها في قاعدة البيانات (لا خطوات يدوية)
      const { rows } = await this.app.pool.query(`SELECT value FROM app_settings WHERE key='vapid'`);
      if (rows[0]) keys = rows[0].value;
      else {
        const gen = webpush.generateVAPIDKeys();
        await this.app.pool.query(`INSERT INTO app_settings(key, value) VALUES ('vapid', $1) ON CONFLICT (key) DO NOTHING`, [JSON.stringify(gen)]);
        keys = (await this.app.pool.query(`SELECT value FROM app_settings WHERE key='vapid'`)).rows[0].value;
      }
    }
    const pub = this.app.config.publicUrl;
    const subject = cfg.subject || (pub.startsWith('https://') ? pub : 'mailto:admin@nidaa.invalid');
    this.web = new WebPushProvider({ ...keys, subject });
  }

  vapidPublicKey() { return this.web?.publicKey || null; }
  webPushEnabled() { return !!this.web; }
  apnsEnabled() { return this.apns.configured; }

  async context(orderId) {
    const { rows } = await this.app.pool.query('SELECT * FROM orders WHERE id=$1', [orderId]);
    const order = rows[0];
    if (!order) return null;
    const branch = await loadBranch(this.app.pool, order.branch_id);
    return { order, branch, url: `${this.app.config.publicUrl}/o/${order.public_token}` };
  }

  messageFor(ctx, seq) {
    const title = seq > 1 ? `تذكير: طلبك رقم ${ctx.order.number} جاهز` : `طلبك رقم ${ctx.order.number} جاهز`;
    const body = ctx.branch.pickup_instructions ? `تفضل بالاستلام — ${ctx.branch.pickup_instructions}` : `تفضل بالاستلام من ${ctx.branch.tenant_name}`;
    return { title, body };
  }

  payloadFor(sub, ctx, call, deliveryId) {
    const { title, body } = this.messageFor(ctx, call.seq);
    if (sub.kind === 'webpush') {
      return { t: 'call', title, body, url: ctx.url, number: ctx.order.number, callId: call.id, deliveryId, tag: `nidaa-${ctx.order.id}`, shop: ctx.branch.tenant_name };
    }
    if (sub.kind === 'apns_alert') {
      return {
        aps: { alert: { title, subtitle: ctx.branch.tenant_name, body }, sound: 'default', 'interruption-level': 'time-sensitive', 'target-content-id': ctx.url, 'thread-id': ctx.order.id },
        deliveryId, url: ctx.url,
      };
    }
    return {
      aps: {
        timestamp: Math.floor(Date.now() / 1000), event: 'update', 'relevance-score': 100,
        'content-state': { status: 'ready', number: ctx.order.number, message: body, calledAt: Math.floor(new Date(call.created_at).getTime() / 1000) },
        alert: { title, body, sound: 'default' },
      },
      deliveryId,
    };
  }

  async sendOne(d, sub, ctx, call) {
    const payload = this.payloadFor(sub, ctx, call, d.id);
    let res;
    for (let attempt = 0; ; attempt++) {
      await this.app.pool.query('UPDATE deliveries SET sent_at=COALESCE(sent_at, now()), attempts=attempts+1 WHERE id=$1', [d.id]);
      if (sub.kind === 'webpush') {
        res = this.web ? await this.web.send(sub, payload, { topic: `o${ctx.order.id.replace(/-/g, '').slice(0, 24)}` }) : { accepted: false, error: 'web push disabled' };
      } else {
        res = this.apns.configured
          ? await this.apns.send(sub, payload, { kind: sub.kind === 'apns_liveactivity' ? 'liveactivity' : 'alert', collapseId: ctx.order.id })
          : { accepted: false, error: 'APNs غير مُعد' };
      }
      if (res.accepted || !res.retryable || attempt >= RETRY_DELAYS.length) break;
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
    }
    if (res.accepted) {
      await this.app.pool.query('UPDATE deliveries SET accepted_at=now(), provider_status=$2, error=NULL, failed_at=NULL WHERE id=$1', [d.id, res.status]);
    } else {
      await this.app.pool.query('UPDATE deliveries SET failed_at=now(), provider_status=$2, error=$3 WHERE id=$1', [d.id, res.status || null, res.error || 'error']);
      if (res.expired) {
        await this.app.pool.query(`UPDATE push_subscriptions SET status='expired', last_error=$2, updated_at=now() WHERE id=$1`, [sub.id, res.error || 'expired']);
      } else {
        await this.app.pool.query(`UPDATE push_subscriptions SET last_error=$2, updated_at=now() WHERE id=$1`, [sub.id, res.error || 'error']);
      }
      await this.app.logError('push', `delivery failed (${sub.kind})`, { status: res.status, error: res.error, orderId: ctx.order.id, branchId: ctx.order.branch_id });
    }
    return res;
  }

  // يرسل نداءً لكل الاشتراكات المسجلة وقت النداء
  async dispatchCall(callId) {
    const { rows: calls } = await this.app.pool.query('SELECT * FROM calls WHERE id=$1', [callId]);
    const call = calls[0];
    if (!call) return;
    const ctx = await this.context(call.order_id);
    const { rows } = await this.app.pool.query(
      `SELECT d.id, s.id AS sub_id, s.kind, s.endpoint, s.p256dh, s.auth, s.apns_env
         FROM deliveries d JOIN push_subscriptions s ON s.id=d.subscription_id
        WHERE d.call_id=$1 AND d.sent_at IS NULL AND s.status='active'`, [callId]);
    // إشعار اللوحة فورًا بأن الإرسال بدأ
    this.app.bus.branch(ctx.order.branch_id, { type: 'orders' });
    await Promise.all(rows.map((r) => this.sendOne({ id: r.id }, { id: r.sub_id, kind: r.kind, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth, apns_env: r.apns_env }, ctx, call)));
    this.app.bus.branch(ctx.order.branch_id, { type: 'orders' });
  }

  // عند تفعيل التنبيه بعد النداء: نرسل آخر نداء لهذا الاشتراك فقط
  async sendLatestCallTo(orderId, subscriptionId) {
    const { rows } = await this.app.pool.query(
      `SELECT c.* FROM calls c WHERE c.order_id=$1 ORDER BY seq DESC LIMIT 1`, [orderId]);
    const call = rows[0];
    if (!call) return;
    const { rows: subs } = await this.app.pool.query(`SELECT * FROM push_subscriptions WHERE id=$1 AND status='active'`, [subscriptionId]);
    const sub = subs[0];
    if (!sub) return;
    const exists = await this.app.pool.query('SELECT 1 FROM deliveries WHERE call_id=$1 AND subscription_id=$2', [call.id, sub.id]);
    if (exists.rowCount) return;
    const d = await this.app.pool.query(
      `INSERT INTO deliveries(call_id, order_id, subscription_id, viewer_id, channel) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [call.id, orderId, sub.id, sub.viewer_id, sub.kind]);
    const ctx = await this.context(orderId);
    await this.sendOne({ id: d.rows[0].id }, sub, ctx, call);
    this.app.bus.branch(ctx.order.branch_id, { type: 'orders' });
  }

  // إنهاء الـ Live Activity عند التسليم أو الإلغاء
  async orderEnded(orderId, status) {
    if (!this.apns.configured) return;
    const { rows } = await this.app.pool.query(
      `SELECT * FROM push_subscriptions WHERE order_id=$1 AND kind='apns_liveactivity' AND closed_reason IN ('delivered','cancelled','expired')`, [orderId]);
    if (!rows.length) return;
    const ctx = await this.context(orderId);
    const message = status === 'delivered' ? 'تم استلام الطلب. شكرًا لك' : 'أُلغي الطلب';
    for (const sub of rows) {
      await this.apns.send(sub, {
        aps: {
          timestamp: Math.floor(Date.now() / 1000), event: 'end',
          'content-state': { status, number: ctx.order.number, message, calledAt: 0 },
          'dismissal-date': Math.floor(Date.now() / 1000) + 120,
        },
      }, { kind: 'liveactivity' });
    }
  }

  async sendTest(order, sub) {
    if (!this.web) return { accepted: false };
    const ctx = await this.context(order.id);
    const res = await this.web.send(sub, { t: 'test', title: 'تجربة: هكذا سيصلك النداء', body: `${ctx.branch.tenant_name} — طلب ${order.number}`, url: ctx.url, tag: `nidaa-test-${order.id}` }, { ttl: 120 });
    if (res.expired) await this.app.pool.query(`UPDATE push_subscriptions SET status='expired', last_error=$2, updated_at=now() WHERE id=$1`, [sub.id, res.error || 'expired']);
    return res;
  }

  close() { this.apns.close(); }
}

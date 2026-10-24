import {
  loadByToken, publicView, hello, updateViewer, subscribeWebPush, subscribeApns, unsubscribe, receipt, customerAck, touch, testPush,
} from '../services/customer.js';
import { AppError } from '../lib/errors.js';
import { shopPublic } from '../services/orders.js';

// واجهة العميل العامة: كل مسار مقيد برمز طلب واحد.
export default async function (app) {
  // تتبع محاولات الرموز الخاطئة لكل عنوان لمنع التخمين
  const guard = async (req, fn) => {
    app.limiter.hit(`pub:${req.ip}`, 900, 60_000);
    try { return await fn(); } catch (e) {
      if (e instanceof AppError && e.status === 404) app.limiter.hit(`badtok:${req.ip}`, 30, 10 * 60_000);
      throw e;
    }
  };

  app.get('/api/public/o/:token', (req) => guard(req, async () => {
    const o = await loadByToken(app.pool, req.params.token);
    return publicView(app, o);
  }));
  app.post('/api/public/o/:token/hello', (req) => guard(req, () => hello(app, req.params.token, req.body)));
  app.post('/api/public/o/:token/viewer', (req) => guard(req, () => updateViewer(app, req.params.token, req.body)));
  app.post('/api/public/o/:token/push', (req) => guard(req, () => subscribeWebPush(app, req.params.token, req.body)));
  app.post('/api/public/o/:token/push/unsubscribe', (req) => guard(req, () => unsubscribe(app, req.params.token, req.body)));
  app.post('/api/public/o/:token/apns', (req) => guard(req, () => subscribeApns(app, req.params.token, req.body)));
  app.post('/api/public/o/:token/push/test', (req) => guard(req, () => {
    app.limiter.hit(`pushtest:${req.params.token}`, 3, 10 * 60_000);
    return testPush(app, req.params.token, req.body);
  }));
  app.post('/api/public/o/:token/receipt', (req) => guard(req, () => receipt(app, req.params.token, req.body)));
  app.post('/api/public/o/:token/ack', (req) => guard(req, () => customerAck(app, req.params.token)));

  app.get('/api/public/o/:token/stream', (req, reply) => guard(req, async () => {
    const o = await loadByToken(app.pool, req.params.token);
    const clientId = String(req.query?.c || '');
    let n = 0;
    app.sse(req, reply, [[`order:${o.id}`, () => 'status']], {
      onOpen: () => touch(app, o.id, clientId).catch(() => {}),
      // آخر ظهور: كل 60 ثانية أثناء بقاء الصفحة متصلة
      onPing: () => { if (++n % 3 === 0) touch(app, o.id, clientId).catch(() => {}); },
    });
  }));

  app.get('/api/public/s/:slug', (req) => guard(req, async () => {
    const { rows } = await app.pool.query(
      `SELECT b.*, t.name AS tenant_name, t.slug AS tenant_slug, t.logo_version, (t.logo IS NOT NULL) AS has_logo
         FROM tenants t JOIN branches b ON b.tenant_id=t.id WHERE t.slug=$1 AND b.active ORDER BY b.created_at LIMIT 1`, [String(req.params.slug).slice(0, 40)]);
    if (!rows[0]) throw new AppError(404, 'not_found', 'غير موجود');
    return { shop: shopPublic(rows[0]) };
  }));
}

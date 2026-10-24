import { expireAbandoned, autoSkipDisplay } from './orders.js';

// مهام دورية: انتهاء الطلبات المهجورة، تخطي الشاشة، وتطبيق سياسة الاحتفاظ والحذف.
// قفل استشاري يضمن تنفيذها من نسخة واحدة فقط حتى لو شُغّل أكثر من خادم.
export async function runMaintenance(app, { purge = true } = {}) {
  const c = await app.pool.connect();
  try {
    const { rows } = await c.query('SELECT pg_try_advisory_lock(727002) AS ok');
    if (!rows[0].ok) return null;
    try {
      const expired = await expireAbandoned(app);
      const skipped = await autoSkipDisplay(app);
      let purged = 0;
      if (purge) {
        const r = await c.query(`DELETE FROM orders WHERE created_at < now() - make_interval(days => $1)`, [app.config.retentionDays]);
        purged = r.rowCount;
        await c.query(`DELETE FROM sessions WHERE expires_at < now()`);
        await c.query(`DELETE FROM pairing_requests WHERE expires_at < now() - interval '1 hour'`);
        await c.query(`DELETE FROM idempotency_keys WHERE created_at < now() - interval '48 hours'`);
        await c.query(`DELETE FROM error_log WHERE at < now() - interval '30 days'`);
        // بيانات الاشتراك لا تلزم بعد انتهاء الطلب ومهلة الرابط
        await c.query(`DELETE FROM push_subscriptions s USING orders o WHERE o.id=s.order_id AND o.link_expires_at < now() - interval '1 day'`);
      }
      return { expired, skipped, purged };
    } finally {
      await c.query('SELECT pg_advisory_unlock(727002)');
    }
  } finally {
    c.release();
  }
}

export function startMaintenance(app) {
  let running = false;
  let ticks = 0;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      // الحذف الثقيل كل ~10 دقائق، والباقي كل دورة
      await runMaintenance(app, { purge: ticks++ % 40 === 0 });
    } catch (e) {
      app.logError('maintenance', e.message);
    } finally { running = false; }
  }, app.config.maintenanceIntervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

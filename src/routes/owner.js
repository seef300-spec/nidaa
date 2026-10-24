import { requireUser } from './_auth.js';
import { badRequest, notFound, conflict } from '../lib/errors.js';
import { hashPassword } from '../lib/crypto.js';
import { normUsername, validatePassword, claimPairing, createApiKey, API_SCOPES } from '../services/auth.js';
import { isValidTimezone } from '../lib/time.js';
import { loadBranch, shopPublic } from '../services/orders.js';
import { tx } from '../db.js';

const str = (v, max, { required = false, label = 'الحقل' } = {}) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) throw badRequest('required', `${label} مطلوب`);
  if (s.length > max) throw badRequest('too_long', `${label} أطول من ${max} حرفًا`);
  return s;
};
const intIn = (v, min, max, label) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest('out_of_range', `${label}: قيمة بين ${min} و ${max}`);
  return n;
};

// يتحقق من نوع الصورة من محتواها (لا نقبل SVG لمنع حقن السكربت)
export function parseLogo(dataUrl) {
  const m = /^data:(image\/(png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw badRequest('invalid_logo', 'الشعار يجب أن يكون PNG أو JPG أو WebP');
  const buf = Buffer.from(m[3], 'base64');
  if (buf.length > 400 * 1024) throw badRequest('logo_too_large', 'حجم الشعار يجب ألا يتجاوز 400 كيلوبايت');
  const png = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpg = buf[0] === 0xff && buf[1] === 0xd8;
  const webp = buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP';
  const mime = png ? 'image/png' : jpg ? 'image/jpeg' : webp ? 'image/webp' : null;
  if (!mime) throw badRequest('invalid_logo', 'ملف الصورة غير صالح');
  return { buf, mime };
}

export function branchInput(b) {
  const out = {};
  if (b.name !== undefined) out.name = str(b.name, 60, { required: true, label: 'اسم الفرع' });
  if (b.timezone !== undefined) {
    if (!isValidTimezone(b.timezone)) throw badRequest('invalid_timezone', 'المنطقة الزمنية غير صحيحة');
    out.timezone = b.timezone;
  }
  if (b.dayStartHour !== undefined) out.day_start_hour = intIn(b.dayStartHour, 0, 23, 'بداية اليوم');
  if (b.pickupInstructions !== undefined) out.pickup_instructions = str(b.pickupInstructions, 140, { label: 'تعليمات الاستلام' });
  if (b.orderTtlHours !== undefined) out.order_ttl_hours = intIn(b.orderTtlHours, 1, 72, 'مدة صلاحية الطلب');
  if (b.linkGraceHours !== undefined) out.link_grace_hours = intIn(b.linkGraceHours, 1, 72, 'بقاء الرابط بعد الانتهاء');
  if (b.recallCooldownSec !== undefined) out.recall_cooldown_sec = intIn(b.recallCooldownSec, 10, 600, 'الفاصل بين النداءات');
  if (b.displayAutoshow !== undefined) out.display_autoshow = !!b.displayAutoshow;
  if (b.displaySkipSec !== undefined) out.display_skip_sec = intIn(b.displaySkipSec, 0, 3600, 'مدة العرض قبل التخطي');
  return out;
}

const branchOut = (b) => ({
  id: b.id, name: b.name, timezone: b.timezone, dayStartHour: b.day_start_hour, pickupInstructions: b.pickup_instructions,
  orderTtlHours: b.order_ttl_hours, linkGraceHours: b.link_grace_hours, recallCooldownSec: b.recall_cooldown_sec,
  displayAutoshow: b.display_autoshow, displaySkipSec: b.display_skip_sec,
});

export default async function (app) {
  const owner = (req) => requireUser(app, req, { owner: true });

  // ===== المحل =====
  app.get('/api/owner/shop', async (req) => {
    const u = await owner(req);
    const b = await loadBranch(app.pool, u.branchId);
    return { shop: shopPublic(b), branch: branchOut(b), publicUrl: app.config.publicUrl };
  });

  app.put('/api/owner/shop', async (req) => {
    const u = await owner(req);
    const name = str(req.body?.name, 60, { required: true, label: 'اسم المحل' });
    await app.pool.query('UPDATE tenants SET name=$2 WHERE id=$1', [u.tenantId, name]);
    app.bus.branch(u.branchId, { type: 'display' });
    return { ok: true };
  });

  app.put('/api/owner/shop/logo', { bodyLimit: 600 * 1024 }, async (req) => {
    const u = await owner(req);
    const { buf, mime } = parseLogo(req.body?.dataUrl);
    await app.pool.query('UPDATE tenants SET logo=$2, logo_mime=$3, logo_version=logo_version+1 WHERE id=$1', [u.tenantId, buf, mime]);
    app.bus.branch(u.branchId, { type: 'display' });
    return { ok: true };
  });

  app.delete('/api/owner/shop/logo', async (req) => {
    const u = await owner(req);
    await app.pool.query('UPDATE tenants SET logo=NULL, logo_mime=NULL, logo_version=logo_version+1 WHERE id=$1', [u.tenantId]);
    app.bus.branch(u.branchId, { type: 'display' });
    return { ok: true };
  });

  // ===== الفرع =====
  app.put('/api/owner/branch', async (req) => {
    const u = await owner(req);
    const fields = branchInput(req.body || {});
    const keys = Object.keys(fields);
    if (!keys.length) return { ok: true };
    await app.pool.query(
      `UPDATE branches SET ${keys.map((k, i) => `${k}=$${i + 3}`).join(', ')} WHERE id=$1 AND tenant_id=$2`,
      [u.branchId, u.tenantId, ...keys.map((k) => fields[k])]);
    app.bus.branch(u.branchId, { type: 'display' });
    app.bus.branch(u.branchId, { type: 'orders' });
    return { branch: branchOut(await loadBranch(app.pool, u.branchId)) };
  });

  app.post('/api/owner/branches', async (req) => {
    const u = await owner(req);
    const f = branchInput({ timezone: 'Asia/Riyadh', ...(req.body || {}) });
    if (!f.name) throw badRequest('required', 'اسم الفرع مطلوب');
    const { rows } = await app.pool.query(
      `INSERT INTO branches(tenant_id, name, timezone, pickup_instructions) VALUES ($1,$2,$3,$4) RETURNING id, name`,
      [u.tenantId, f.name, f.timezone, f.pickup_instructions || '']);
    return { branch: rows[0] };
  });

  // ===== الموظفون =====
  app.get('/api/owner/users', async (req) => {
    const u = await owner(req);
    const { rows } = await app.pool.query(
      `SELECT u.id, u.username, u.display_name, u.role, u.active, u.last_login_at, u.created_at,
              COALESCE(array_agg(ub.branch_id) FILTER (WHERE ub.branch_id IS NOT NULL), '{}') AS branches
         FROM users u LEFT JOIN user_branches ub ON ub.user_id=u.id
        WHERE u.tenant_id=$1 GROUP BY u.id ORDER BY u.role DESC, u.created_at`, [u.tenantId]);
    return { users: rows };
  });

  app.post('/api/owner/users', async (req) => {
    const u = await owner(req);
    const username = normUsername(req.body?.username);
    const name = str(req.body?.name, 40, { required: true, label: 'الاسم' });
    validatePassword(req.body?.password);
    const role = req.body?.role === 'owner' ? 'owner' : 'staff';
    const hash = await hashPassword(req.body.password);
    try {
      const created = await tx(app.pool, async (c) => {
        const { rows } = await c.query(
          `INSERT INTO users(tenant_id, username, display_name, password_hash, role) VALUES ($1,$2,$3,$4,$5) RETURNING id, username, display_name, role`,
          [u.tenantId, username, name, hash, role]);
        await c.query('INSERT INTO user_branches(user_id, branch_id) VALUES ($1,$2)', [rows[0].id, u.branchId]);
        return rows[0];
      });
      return { user: created };
    } catch (e) {
      if (e.code === '23505') throw conflict('username_taken', 'اسم المستخدم مستخدم من قبل');
      throw e;
    }
  });

  app.put('/api/owner/users/:id', async (req) => {
    const u = await owner(req);
    const { rows } = await app.pool.query('SELECT * FROM users WHERE id=$1 AND tenant_id=$2', [req.params.id, u.tenantId]);
    const target = rows[0];
    if (!target) throw notFound('المستخدم غير موجود');
    const b = req.body || {};
    if (target.id === u.id && (b.active === false || b.role === 'staff')) throw badRequest('self', 'لا يمكنك إيقاف حسابك أو خفض صلاحيتك بنفسك');
    if (b.name !== undefined) await app.pool.query('UPDATE users SET display_name=$2 WHERE id=$1', [target.id, str(b.name, 40, { required: true, label: 'الاسم' })]);
    if (b.active !== undefined) {
      await app.pool.query('UPDATE users SET active=$2 WHERE id=$1', [target.id, !!b.active]);
      if (!b.active) await app.pool.query('DELETE FROM sessions WHERE user_id=$1', [target.id]);
    }
    if (b.password !== undefined) {
      validatePassword(b.password);
      await app.pool.query('UPDATE users SET password_hash=$2, failed_logins=0, locked_until=NULL WHERE id=$1', [target.id, await hashPassword(b.password)]);
      await app.pool.query('DELETE FROM sessions WHERE user_id=$1', [target.id]);
    }
    return { ok: true };
  });

  // ===== شاشات العرض =====
  app.get('/api/owner/displays', async (req) => {
    const u = await owner(req);
    const { rows } = await app.pool.query(
      `SELECT id, name, created_at, last_seen_at, revoked_at FROM display_devices WHERE branch_id=$1 ORDER BY revoked_at NULLS FIRST, created_at DESC LIMIT 50`, [u.branchId]);
    return { displays: rows };
  });

  app.post('/api/owner/displays/claim', async (req) => {
    const u = await owner(req);
    app.limiter.hit(`claim:${u.id}`, 10, 10 * 60_000);
    const d = await claimPairing(app, u, req.body?.code, req.body?.name);
    return { display: d };
  });

  app.delete('/api/owner/displays/:id', async (req) => {
    const u = await owner(req);
    const r = await app.pool.query(`UPDATE display_devices SET revoked_at=now() WHERE id=$1 AND branch_id=$2 AND revoked_at IS NULL RETURNING id`, [req.params.id, u.branchId]);
    if (!r.rowCount) throw notFound('الشاشة غير موجودة');
    app.bus.emit(`display:${req.params.id}`, { type: 'revoked' });
    return { ok: true };
  });

  // ===== مفاتيح API =====
  app.get('/api/owner/api-keys', async (req) => {
    const u = await owner(req);
    const { rows } = await app.pool.query(
      `SELECT id, name, prefix, scopes, created_at, last_used_at, revoked_at FROM api_keys WHERE branch_id=$1 ORDER BY created_at DESC`, [u.branchId]);
    return { keys: rows, scopes: API_SCOPES };
  });
  app.post('/api/owner/api-keys', async (req) => {
    const u = await owner(req);
    return { key: await createApiKey(app, u, req.body?.name, req.body?.scopes) };
  });
  app.delete('/api/owner/api-keys/:id', async (req) => {
    const u = await owner(req);
    const r = await app.pool.query('UPDATE api_keys SET revoked_at=now() WHERE id=$1 AND branch_id=$2 AND revoked_at IS NULL RETURNING id', [req.params.id, u.branchId]);
    if (!r.rowCount) throw notFound('المفتاح غير موجود');
    return { ok: true };
  });

  // ===== حالة التشغيل والإعداد الأول =====
  app.get('/api/owner/status', async (req) => {
    const u = await owner(req);
    const q = (sql, args = [u.branchId]) => app.pool.query(sql, args).then((r) => r.rows[0]);
    const [del, errors, subs] = await Promise.all([
      q(`SELECT count(*) FILTER (WHERE d.channel<>'page')::int AS total,
                count(*) FILTER (WHERE d.accepted_at IS NOT NULL AND d.channel<>'page')::int AS accepted,
                count(*) FILTER (WHERE d.failed_at IS NOT NULL AND d.accepted_at IS NULL)::int AS failed,
                count(*) FILTER (WHERE d.receipt_at IS NOT NULL AND d.channel<>'page')::int AS receipts,
                count(*) FILTER (WHERE d.channel='page')::int AS page
           FROM deliveries d JOIN orders o ON o.id=d.order_id WHERE o.branch_id=$1 AND d.created_at > now() - interval '7 days'`),
      app.pool.query(`SELECT at, source, message, context->>'status' AS status, context->>'error' AS detail FROM error_log WHERE context->>'branchId' = $1::text ORDER BY at DESC LIMIT 20`, [u.branchId]).then((r) => r.rows),
      q(`SELECT count(*)::int AS n FROM push_subscriptions s JOIN orders o ON o.id=s.order_id WHERE o.branch_id=$1 AND s.status='active'`),
    ]);
    return {
      publicUrl: app.config.publicUrl,
      https: app.config.publicUrl.startsWith('https://'),
      webPush: app.notifier.webPushEnabled(),
      apns: app.notifier.apnsEnabled(),
      deliveries7d: del,
      activeSubscriptions: subs.n,
      recentErrors: errors,
      retentionDays: app.config.retentionDays,
    };
  });

  app.get('/api/owner/onboarding', async (req) => {
    const u = await owner(req);
    const b = await loadBranch(app.pool, u.branchId);
    const one = (sql) => app.pool.query(sql, [u.branchId]).then((r) => r.rows[0]?.n > 0);
    const [display, ordered, opened, subscribed, called, delivered, staff] = await Promise.all([
      one(`SELECT count(*)::int n FROM display_devices WHERE branch_id=$1 AND revoked_at IS NULL`),
      one(`SELECT count(*)::int n FROM orders WHERE branch_id=$1`),
      one(`SELECT count(*)::int n FROM orders WHERE branch_id=$1 AND first_opened_at IS NOT NULL`),
      one(`SELECT count(*)::int n FROM push_subscriptions s JOIN orders o ON o.id=s.order_id WHERE o.branch_id=$1`),
      one(`SELECT count(*)::int n FROM orders WHERE branch_id=$1 AND call_count > 0`),
      one(`SELECT count(*)::int n FROM orders WHERE branch_id=$1 AND status='delivered'`),
      app.pool.query(`SELECT count(*)::int n FROM users WHERE tenant_id=$1 AND role='staff'`, [u.tenantId]).then((r) => r.rows[0].n > 0),
    ]);
    return {
      steps: [
        { key: 'shop', done: !!b.tenant_name, label: 'اسم المحل والفرع' },
        { key: 'logo', done: b.has_logo, label: 'شعار المحل', optional: true },
        { key: 'pickup', done: !!b.pickup_instructions, label: 'مكان الاستلام' },
        { key: 'staff', done: staff, label: 'حسابات الموظفين', optional: true },
        { key: 'display', done: display, label: 'اقتران شاشة التابلت' },
        { key: 'order', done: ordered, label: 'إنشاء طلب تجريبي' },
        { key: 'opened', done: opened, label: 'مسح الرمز بالجوال' },
        { key: 'subscribed', done: subscribed, label: 'تفعيل التنبيه من الجوال' },
        { key: 'called', done: called, label: 'نداء العميل' },
        { key: 'delivered', done: delivered, label: 'تأكيد التسليم' },
      ],
    };
  });
}

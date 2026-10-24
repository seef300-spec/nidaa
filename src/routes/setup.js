import crypto from 'node:crypto';
import { tx } from '../db.js';
import { badRequest, forbidden, conflict, AppError } from '../lib/errors.js';
import { hashPassword, randomToken, sha256 } from '../lib/crypto.js';
import { normUsername, validatePassword, SESSION_COOKIE } from '../services/auth.js';
import { branchInput, parseLogo } from './owner.js';
import { cookieOpts } from './_auth.js';

// الإعداد الأول: متاح فقط قبل إنشاء أي محل، ويتطلب رمز الإعداد (SETUP_TOKEN) في النشر العام.
export default async function (app) {
  const needsToken = () => app.config.publicUrl.startsWith('https://') || !!app.config.setupToken;

  app.get('/api/setup/status', async () => {
    const { rows } = await app.pool.query('SELECT count(*)::int AS n FROM tenants');
    return { needed: rows[0].n === 0, tokenRequired: needsToken(), tokenConfigured: !!app.config.setupToken };
  });

  app.post('/api/setup', { bodyLimit: 700 * 1024 }, async (req, reply) => {
    app.limiter.hit(`setup:${req.ip}`, 10, 10 * 60_000);
    const b = req.body || {};
    if (needsToken()) {
      if (!app.config.setupToken) throw new AppError(503, 'setup_token_missing', 'اضبط متغير SETUP_TOKEN في إعدادات الاستضافة أولًا');
      const given = sha256(String(b.setupToken || '')), want = sha256(app.config.setupToken);
      if (!crypto.timingSafeEqual(given, want)) throw forbidden('رمز الإعداد غير صحيح');
    }
    const shopName = String(b.shopName || '').trim();
    if (!shopName || shopName.length > 60) throw badRequest('required', 'اسم المحل مطلوب (حتى 60 حرفًا)');
    const branch = branchInput({ name: b.branchName || 'الفرع الرئيسي', timezone: b.timezone || 'Asia/Riyadh', pickupInstructions: b.pickupInstructions || '' });
    const username = normUsername(b.username);
    const ownerName = String(b.ownerName || '').trim().slice(0, 40) || 'المالك';
    validatePassword(b.password);
    const logo = b.logo ? parseLogo(b.logo) : null;
    const hash = await hashPassword(b.password);
    const token = randomToken(32);
    await tx(app.pool, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(727003)');
      const { rows } = await c.query('SELECT count(*)::int AS n FROM tenants');
      if (rows[0].n > 0) throw conflict('already_setup', 'تم الإعداد مسبقًا. سجّل الدخول.');
      const slug = 'shop-' + randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, 'x').slice(0, 6);
      const t = await c.query(`INSERT INTO tenants(name, slug, logo, logo_mime, logo_version) VALUES ($1,$2,$3,$4,1) RETURNING id`,
        [shopName, slug, logo?.buf || null, logo?.mime || null]);
      const br = await c.query(`INSERT INTO branches(tenant_id, name, timezone, pickup_instructions) VALUES ($1,$2,$3,$4) RETURNING id`,
        [t.rows[0].id, branch.name, branch.timezone, branch.pickup_instructions]);
      const u = await c.query(`INSERT INTO users(tenant_id, username, display_name, password_hash, role) VALUES ($1,$2,$3,$4,'owner') RETURNING id`,
        [t.rows[0].id, username, ownerName, hash]);
      await c.query('INSERT INTO user_branches(user_id, branch_id) VALUES ($1,$2)', [u.rows[0].id, br.rows[0].id]);
      await c.query(`INSERT INTO sessions(token_hash, user_id, branch_id, expires_at) VALUES ($1,$2,$3, now() + interval '14 days')`,
        [sha256(token), u.rows[0].id, br.rows[0].id]);
    });
    reply.setCookie(SESSION_COOKIE, token, cookieOpts(app, 14 * 86400));
    return { ok: true };
  });
}

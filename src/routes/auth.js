import { login, logout, switchBranch, changeOwnPassword, userBranches, SESSION_COOKIE } from '../services/auth.js';
import { requireUser, cookieOpts } from './_auth.js';
import { shopPublic, loadBranch } from '../services/orders.js';

export default async function (app) {
  app.post('/api/auth/login', async (req, reply) => {
    const { username, password } = req.body || {};
    app.limiter.hit(`login-ip:${req.ip}`, 30, 5 * 60_000);
    app.limiter.hit(`login-u:${String(username).toLowerCase()}:${req.ip}`, 10, 5 * 60_000);
    const s = await login(app, username, password);
    reply.setCookie(SESSION_COOKIE, s.token, cookieOpts(app, s.maxAge));
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await logout(app, req.cookies?.[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req) => {
    const u = await requireUser(app, req);
    const { rows } = await app.pool.query('SELECT * FROM users WHERE id=$1', [u.id]);
    const branch = await loadBranch(app.pool, u.branchId);
    return {
      user: { id: u.id, name: u.label, username: u.username, role: u.role },
      branch: { id: branch.id, name: branch.name, timezone: branch.timezone, recallCooldownSec: branch.recall_cooldown_sec, displayAutoshow: branch.display_autoshow },
      shop: shopPublic(branch),
      branches: await userBranches(app.pool, rows[0]),
      notifications: { webPush: app.notifier.webPushEnabled(), apns: app.notifier.apnsEnabled(), httpsOk: app.config.publicUrl.startsWith('https://') },
    };
  });

  app.post('/api/me/branch', async (req) => {
    const u = await requireUser(app, req);
    await switchBranch(app, u, String(req.body?.branchId || ''));
    return { ok: true };
  });

  app.post('/api/me/password', async (req) => {
    const u = await requireUser(app, req);
    app.limiter.hit(`pw:${u.id}`, 10, 10 * 60_000);
    await changeOwnPassword(app, u, req.body?.current, req.body?.next);
    return { ok: true };
  });
}

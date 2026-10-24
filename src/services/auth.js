// المصادقة والصلاحيات: موظف/مالك (جلسة)، شاشة عرض (جهاز مقترن)، تكامل (مفتاح API).
import { randomToken, sha256, hashPassword, verifyPassword, DUMMY_HASH, pairingCode } from '../lib/crypto.js';
import { badRequest, unauthorized, forbidden, notFound, AppError } from '../lib/errors.js';
import { tx } from '../db.js';

export const SESSION_COOKIE = 'nd_s';
export const DISPLAY_COOKIE = 'nd_d';
export const PAIR_COOKIE = 'nd_p';
const SESSION_DAYS = 14;
const MAX_FAILED = 8;
const LOCK_MIN = 15;

export const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
export function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8 || pw.length > 128) throw badRequest('weak_password', 'كلمة المرور يجب أن تكون 8 أحرف على الأقل');
}
export function normUsername(u) {
  const v = String(u || '').trim().toLowerCase();
  if (!USERNAME_RE.test(v)) throw badRequest('invalid_username', 'اسم المستخدم: 3–32 حرفًا لاتينيًا أو أرقامًا أو . _ -');
  return v;
}

export async function userBranches(c, user) {
  if (user.role === 'owner') {
    return (await c.query('SELECT id, name FROM branches WHERE tenant_id=$1 AND active ORDER BY created_at', [user.tenant_id])).rows;
  }
  return (await c.query(
    `SELECT b.id, b.name FROM branches b JOIN user_branches ub ON ub.branch_id=b.id
      WHERE ub.user_id=$1 AND b.active AND b.tenant_id=$2 ORDER BY b.created_at`, [user.id, user.tenant_id])).rows;
}

export async function login(app, username, password) {
  const uname = String(username || '').trim().toLowerCase();
  const { rows } = await app.pool.query('SELECT * FROM users WHERE username=$1', [uname]);
  const user = rows[0];
  if (!user) { await verifyPassword(String(password || ''), DUMMY_HASH).catch(() => {}); throw unauthorized('اسم المستخدم أو كلمة المرور غير صحيحة'); }
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    throw new AppError(423, 'locked', 'تم إيقاف الدخول مؤقتًا بعد محاولات خاطئة متكررة. حاول بعد 15 دقيقة.');
  }
  const ok = await verifyPassword(String(password || ''), user.password_hash).catch(() => false);
  if (!ok || !user.active) {
    if (!ok) {
      await app.pool.query(
        `UPDATE users SET failed_logins = failed_logins + 1,
                locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
          WHERE id=$1`, [user.id, MAX_FAILED, LOCK_MIN]);
    }
    throw unauthorized(user.active ? 'اسم المستخدم أو كلمة المرور غير صحيحة' : 'هذا الحساب موقوف');
  }
  const branches = await userBranches(app.pool, user);
  if (!branches.length) throw forbidden('لا يوجد فرع مرتبط بحسابك');
  const token = randomToken(32);
  await app.pool.query(
    `INSERT INTO sessions(token_hash, user_id, branch_id, expires_at) VALUES ($1,$2,$3, now() + make_interval(days => $4))`,
    [sha256(token), user.id, branches[0].id, SESSION_DAYS]);
  await app.pool.query('UPDATE users SET failed_logins=0, locked_until=NULL, last_login_at=now() WHERE id=$1', [user.id]);
  return { token, maxAge: SESSION_DAYS * 86400 };
}

export async function logout(app, token) {
  if (token) await app.pool.query('DELETE FROM sessions WHERE token_hash=$1', [sha256(token)]);
}

// يعيد سياق الموظف أو null. التحقق في كل طلب: الجلسة، نشاط المستخدم، انتماء الفرع.
export async function sessionContext(app, token) {
  if (!token || token.length > 100) return null;
  const { rows } = await app.pool.query(
    `SELECT s.token_hash, s.branch_id, s.last_seen_at, u.id, u.tenant_id, u.username, u.display_name, u.role, u.active,
            b.tenant_id AS b_tenant, b.active AS b_active, b.name AS branch_name, t.name AS tenant_name
       FROM sessions s JOIN users u ON u.id=s.user_id JOIN branches b ON b.id=s.branch_id JOIN tenants t ON t.id=u.tenant_id
      WHERE s.token_hash=$1 AND s.expires_at > now()`, [sha256(token)]);
  const r = rows[0];
  if (!r || !r.active || !r.b_active || r.b_tenant !== r.tenant_id) return null;
  if (r.role !== 'owner') {
    const m = await app.pool.query('SELECT 1 FROM user_branches WHERE user_id=$1 AND branch_id=$2', [r.id, r.branch_id]);
    if (!m.rowCount) return null;
  }
  if (Date.now() - new Date(r.last_seen_at).getTime() > 5 * 60 * 1000) {
    await app.pool.query(`UPDATE sessions SET last_seen_at=now(), expires_at=now() + make_interval(days => $2) WHERE token_hash=$1`, [r.token_hash, SESSION_DAYS]);
  }
  return {
    type: 'user', id: r.id, label: r.display_name, username: r.username, role: r.role,
    tenantId: r.tenant_id, tenantName: r.tenant_name, branchId: r.branch_id, branchName: r.branch_name, tokenHash: r.token_hash,
  };
}

export async function switchBranch(app, actor, branchId) {
  const { rows } = await app.pool.query('SELECT * FROM users WHERE id=$1', [actor.id]);
  const branches = await userBranches(app.pool, rows[0]);
  if (!branches.some((b) => b.id === branchId)) throw forbidden('لا تملك صلاحية لهذا الفرع');
  await app.pool.query('UPDATE sessions SET branch_id=$2 WHERE token_hash=$1', [actor.tokenHash, branchId]);
}

export async function changeOwnPassword(app, actor, current, next) {
  validatePassword(next);
  const { rows } = await app.pool.query('SELECT password_hash FROM users WHERE id=$1', [actor.id]);
  if (!(await verifyPassword(String(current || ''), rows[0].password_hash))) throw badRequest('wrong_password', 'كلمة المرور الحالية غير صحيحة');
  await app.pool.query('UPDATE users SET password_hash=$2 WHERE id=$1', [actor.id, await hashPassword(next)]);
  // إنهاء الجلسات الأخرى
  await app.pool.query('DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2', [actor.id, actor.tokenHash]);
}

// ===== شاشة العرض =====
export async function displayContext(app, token) {
  if (!token || token.length > 100) return null;
  const { rows } = await app.pool.query(
    `SELECT d.id, d.branch_id, d.tenant_id, d.name, d.last_seen_at FROM display_devices d JOIN branches b ON b.id=d.branch_id
      WHERE d.token_hash=$1 AND d.revoked_at IS NULL AND b.active`, [sha256(token)]);
  const d = rows[0];
  if (!d) return null;
  if (!d.last_seen_at || Date.now() - new Date(d.last_seen_at).getTime() > 60 * 1000) {
    await app.pool.query('UPDATE display_devices SET last_seen_at=now() WHERE id=$1', [d.id]);
  }
  return { type: 'display', id: d.id, label: d.name, branchId: d.branch_id, tenantId: d.tenant_id };
}

export async function startPairing(app) {
  const secret = randomToken(32);
  for (let i = 0; i < 5; i++) {
    const code = pairingCode();
    try {
      const { rows } = await app.pool.query(
        `INSERT INTO pairing_requests(secret_hash, code, expires_at) VALUES ($1,$2, now() + interval '15 minutes') RETURNING code, expires_at`,
        [sha256(secret), code]);
      return { secret, code: rows[0].code, expiresAt: rows[0].expires_at };
    } catch (e) {
      if (e.code !== '23505') throw e;
    }
  }
  throw new Error('could not allocate pairing code');
}

export async function pairingStatus(app, secret) {
  if (!secret) return { state: 'none' };
  const { rows } = await app.pool.query('SELECT * FROM pairing_requests WHERE secret_hash=$1', [sha256(secret)]);
  const p = rows[0];
  if (!p) return { state: 'none' };
  if (p.claimed_at && p.device_token) {
    // يُسلَّم رمز الجهاز مرة واحدة ثم يُمسح من قاعدة البيانات
    const r = await app.pool.query(`UPDATE pairing_requests SET device_token=NULL WHERE id=$1 AND device_token IS NOT NULL RETURNING $2::text AS t`, [p.id, p.device_token]);
    if (r.rowCount) return { state: 'paired', deviceToken: p.device_token };
  }
  if (p.claimed_at) return { state: 'none' };
  if (new Date(p.expires_at) < new Date()) return { state: 'expired' };
  return { state: 'waiting', code: p.code, expiresAt: p.expires_at };
}

export async function claimPairing(app, actor, code, name) {
  const c0 = String(code || '').trim().toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-Z0-9]{6}$/.test(c0)) throw badRequest('invalid_code', 'رمز الاقتران مكوّن من 6 أحرف وأرقام');
  const dname = String(name || '').trim().slice(0, 40) || 'شاشة العرض';
  return tx(app.pool, async (c) => {
    const { rows } = await c.query(
      `SELECT * FROM pairing_requests WHERE code=$1 AND claimed_at IS NULL AND expires_at > now() FOR UPDATE`, [c0]);
    const p = rows[0];
    if (!p) throw notFound('رمز الاقتران غير صحيح أو انتهت صلاحيته. أعد فتح صفحة الشاشة على التابلت.');
    const token = randomToken(32);
    const d = await c.query(
      `INSERT INTO display_devices(tenant_id, branch_id, name, token_hash, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, created_at`,
      [actor.tenantId, actor.branchId, dname, sha256(token), actor.id]);
    await c.query('UPDATE pairing_requests SET claimed_at=now(), device_id=$2, device_token=$3 WHERE id=$1', [p.id, d.rows[0].id, token]);
    return d.rows[0];
  });
}

// ===== مفاتيح API للتكامل (الكاشير لاحقًا) =====
export const API_SCOPES = ['orders:read', 'orders:write'];
export async function apiKeyContext(app, header) {
  const m = /^Bearer\s+(nd_[a-z0-9]{8})_([A-Za-z0-9_-]{30,60})$/.exec(String(header || ''));
  if (!m) return null;
  const { rows } = await app.pool.query(
    `SELECT k.*, b.active AS b_active FROM api_keys k JOIN branches b ON b.id=k.branch_id WHERE k.prefix=$1 AND k.revoked_at IS NULL`, [m[1]]);
  const k = rows[0];
  if (!k || !k.b_active) return null;
  const crypto = await import('node:crypto');
  if (!crypto.timingSafeEqual(sha256(m[2]), k.key_hash)) return null;
  if (!k.last_used_at || Date.now() - new Date(k.last_used_at).getTime() > 60000) {
    await app.pool.query('UPDATE api_keys SET last_used_at=now() WHERE id=$1', [k.id]);
  }
  return { type: 'api', id: k.id, label: `API: ${k.name}`, tenantId: k.tenant_id, branchId: k.branch_id, scopes: k.scopes };
}

export async function createApiKey(app, actor, name, scopes) {
  const n = String(name || '').trim().slice(0, 60);
  if (!n) throw badRequest('invalid_name', 'اكتب اسمًا للمفتاح');
  const sc = Array.isArray(scopes) && scopes.length ? scopes : API_SCOPES;
  if (!sc.every((s) => API_SCOPES.includes(s))) throw badRequest('invalid_scopes', 'صلاحيات غير معروفة');
  const prefix = 'nd_' + randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, '').padEnd(8, '0').slice(0, 8);
  const secret = randomToken(32);
  const { rows } = await app.pool.query(
    `INSERT INTO api_keys(tenant_id, branch_id, name, prefix, key_hash, scopes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, name, prefix, scopes, created_at`,
    [actor.tenantId, actor.branchId, n, prefix, sha256(secret), sc, actor.id]);
  return { ...rows[0], key: `${prefix}_${secret}` };
}

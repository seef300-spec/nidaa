// أدوات الاختبار: قاعدة بيانات اختبار نظيفة، خادم حقيقي على منفذ عشوائي، وعميل HTTP بكوكيز.
import pg from 'pg';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';

export const TEST_DB = process.env.TEST_DATABASE_URL || 'postgres://nidaa:nidaa@localhost/nidaa_test';

export const TEST_DB2 = process.env.TEST_DATABASE_URL2 || 'postgres://nidaa:nidaa@localhost/nidaa_test2';

export async function resetDb(db = TEST_DB) {
  const c = new pg.Client({ connectionString: db });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
}

export async function startApp(overrides = {}, { db = TEST_DB } = {}) {
  await resetDb(db);
  const config = loadConfig({
    databaseUrl: db, port: 0, publicUrl: 'http://localhost', setupToken: '', disableMaintenance: true, logLevel: 'silent', ...overrides,
  });
  const app = await buildApp(config, { logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, base };
}

export class Client {
  constructor(base, { csrf = true } = {}) { this.base = base; this.cookies = new Map(); this.csrf = csrf; }
  async req(method, path, body, headers = {}) {
    const h = { ...headers };
    if (body !== undefined) h['content-type'] = 'application/json';
    if (this.csrf && method !== 'GET') h['x-nidaa'] = '1';
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(this.base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
    for (const sc of res.headers.getSetCookie?.() || []) {
      const [kv, ...attrs] = sc.split(';');
      const i = kv.indexOf('=');
      const k = kv.slice(0, i).trim(); const v = kv.slice(i + 1).trim();
      const expired = attrs.some((a) => /max-age=0|expires=thu, 01 jan 1970/i.test(a.trim()));
      if (!v || expired) this.cookies.delete(k); else this.cookies.set(k, v);
    }
    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('json')) data = await res.json(); else data = await res.text();
    return { status: res.status, data, headers: res.headers };
  }
  get(p, h) { return this.req('GET', p, undefined, h); }
  post(p, b = {}, h) { return this.req('POST', p, b, h); }
  put(p, b = {}, h) { return this.req('PUT', p, b, h); }
  del(p, h) { return this.req('DELETE', p, undefined, h); }
}

// إعداد محل كامل مع مالك مسجّل الدخول
export async function setupShop(base, { shop = 'مقهى الاختبار', username = 'owner', password = 'owner-pass-1' } = {}) {
  const owner = new Client(base);
  const r = await owner.post('/api/setup', { shopName: shop, branchName: 'الرئيسي', timezone: 'Asia/Riyadh', pickupInstructions: 'من النافذة', ownerName: 'المالك', username, password });
  if (r.status !== 200) throw new Error(`setup failed ${r.status} ${JSON.stringify(r.data)}`);
  return owner;
}

// محل إضافي (مستأجر آخر) يُنشأ مباشرة في قاعدة البيانات لاختبار العزل
export async function createTenant(app, base, { shop, username, password }) {
  const { hashPassword } = await import('../src/lib/crypto.js');
  const t = await app.pool.query(`INSERT INTO tenants(name, slug) VALUES ($1, $2) RETURNING id`, [shop, `t-${username}`]);
  const b = await app.pool.query(`INSERT INTO branches(tenant_id, name) VALUES ($1,'فرع') RETURNING id`, [t.rows[0].id]);
  const u = await app.pool.query(`INSERT INTO users(tenant_id, username, display_name, password_hash, role) VALUES ($1,$2,'م',$3,'owner') RETURNING id`, [t.rows[0].id, username, await hashPassword(password)]);
  await app.pool.query('INSERT INTO user_branches VALUES ($1,$2)', [u.rows[0].id, b.rows[0].id]);
  const c = new Client(base);
  const r = await c.post('/api/auth/login', { username, password });
  if (r.status !== 200) throw new Error('login failed');
  return { client: c, tenantId: t.rows[0].id, branchId: b.rows[0].id };
}

export async function login(base, username, password) {
  const c = new Client(base);
  const r = await c.post('/api/auth/login', { username, password });
  if (r.status !== 200) throw new Error(`login failed ${r.status}`);
  return c;
}

export const tokenOf = (order) => order.url.split('/o/')[1];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(fn, { timeout = 5000, every = 50 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('until: timeout');
    await sleep(every);
  }
}

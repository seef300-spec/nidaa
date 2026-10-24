// إضافة محل جديد (مستأجر) بمالكه — للتوسع لاحقًا لعدة محلات.
// الاستخدام: DATABASE_URL=... node scripts/create-tenant.js "اسم المحل" "اسم الفرع" username password
import { loadConfig } from '../src/config.js';
import { createPool, migrate, tx } from '../src/db.js';
import { hashPassword, randomToken } from '../src/lib/crypto.js';
import { normUsername, validatePassword } from '../src/services/auth.js';

const [shop, branch, username, password] = process.argv.slice(2);
if (!shop || !branch || !username || !password) { console.error('usage: create-tenant.js <shop> <branch> <username> <password>'); process.exit(1); }
const pool = createPool(loadConfig());
await migrate(pool, console);
validatePassword(password);
const u = normUsername(username);
await tx(pool, async (c) => {
  const t = await c.query(`INSERT INTO tenants(name, slug) VALUES ($1,$2) RETURNING id`, [shop, 'shop-' + randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, 'x').slice(0, 6)]);
  const b = await c.query(`INSERT INTO branches(tenant_id, name) VALUES ($1,$2) RETURNING id`, [t.rows[0].id, branch]);
  const usr = await c.query(`INSERT INTO users(tenant_id, username, display_name, password_hash, role) VALUES ($1,$2,$3,$4,'owner') RETURNING id`, [t.rows[0].id, u, u, await hashPassword(password)]);
  await c.query('INSERT INTO user_branches VALUES ($1,$2)', [usr.rows[0].id, b.rows[0].id]);
});
console.log('created');
await pool.end();

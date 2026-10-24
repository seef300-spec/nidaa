// يشغّل خادمًا على قاعدة اختبار نظيفة ثم ينفّذ جولات المتصفح (walk + edge)
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const pg = require(path.join(__dirname, '../../node_modules/pg'));
const DB = process.env.TEST_DATABASE_URL || 'postgres://nidaa:nidaa@localhost/nidaa_test';
const PORT = process.env.E2E_PORT || '3199';
const OUT = process.env.OUT || path.join(__dirname, '../../test-results/screens');

(async () => {
  const c = new pg.Client({ connectionString: DB }); await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await c.end();
  const srv = spawn(process.execPath, ['src/server.js'], { cwd: path.join(__dirname, '../..'), env: { ...process.env, DATABASE_URL: DB, PORT, LOG_LEVEL: 'warn', PUBLIC_URL: `http://localhost:${PORT}` }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://localhost:${PORT}/healthz`)).ok) break; } catch { /* */ } await new Promise((r) => setTimeout(r, 200)); }
  let code = 0;
  for (const f of ['walk.cjs', 'edge.cjs']) {
    if (f === 'edge.cjs') {
      const c2 = new pg.Client({ connectionString: DB }); await c2.connect();
      await c2.query('TRUNCATE tenants CASCADE'); await c2.end();
    }
    try { execFileSync(process.execPath, [path.join(__dirname, f)], { env: { ...process.env, BASE: `http://localhost:${PORT}`, OUT }, stdio: 'inherit' }); } catch { code = 1; }
  }
  srv.kill();
  process.exit(code);
})();

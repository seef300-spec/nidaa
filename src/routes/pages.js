import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionContext, SESSION_COOKIE } from '../services/auth.js';
import { loadByToken } from '../services/customer.js';
import { AppError } from '../lib/errors.js';

const PUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const cache = new Map();
function page(name) {
  if (process.env.NODE_ENV === 'production' && cache.has(name)) return cache.get(name);
  const html = fs.readFileSync(path.join(PUB, name), 'utf8');
  cache.set(name, html);
  return html;
}
const TOKEN_RE = /^[A-Za-z0-9_-]{24}$/;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export default async function (app) {
  const html = (reply, name, transform) => {
    let h = page(name);
    if (transform) h = transform(h);
    return reply.header('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(h);
  };
  const loggedIn = (req) => sessionContext(app, req.cookies?.[SESSION_COOKIE]);

  app.get('/', (req, reply) => html(reply, 'index.html'));
  app.get('/login', async (req, reply) => ((await loggedIn(req)) ? reply.redirect('/staff') : html(reply, 'login.html')));
  app.get('/staff', async (req, reply) => ((await loggedIn(req)) ? html(reply, 'staff.html') : reply.redirect('/login')));
  app.get('/staff/settings', async (req, reply) => ((await loggedIn(req)) ? html(reply, 'settings.html') : reply.redirect('/login')));
  app.get('/staff/print/:id', async (req, reply) => ((await loggedIn(req)) ? html(reply, 'print.html') : reply.redirect('/login')));
  app.get('/display', (req, reply) => html(reply, 'display.html'));
  app.get('/setup', (req, reply) => html(reply, 'setup.html'));
  app.get('/s/:slug', (req, reply) => html(reply, 'shop.html'));

  app.get('/o/:token', (req, reply) => {
    const t = TOKEN_RE.test(req.params.token) ? req.params.token : '';
    const a = app.config.apns;
    const banner = a.bundleId && process.env.APPLE_STORE_APP_ID
      ? `<meta name="apple-itunes-app" content="app-id=${esc(process.env.APPLE_STORE_APP_ID)}, app-clip-bundle-id=${esc(a.bundleId)}, app-clip-display=card">` : '';
    return html(reply, 'order.html', (h) => h
      .replace('<!--MANIFEST-->', t ? `<link rel="manifest" href="/o/${t}/manifest.webmanifest">` : '')
      .replace('<!--APPCLIP-->', banner));
  });

  // بيان تطبيق خاص بكل طلب: إذا أضافه العميل للشاشة الرئيسية (آيفون) يفتح طلبه نفسه ويستقبل الإشعارات
  app.get('/o/:token/manifest.webmanifest', async (req, reply) => {
    let name = 'نداء — طلبي';
    try {
      const o = await loadByToken(app.pool, req.params.token);
      const t = await app.pool.query('SELECT name FROM tenants WHERE id=$1', [o.tenant_id]);
      name = `طلب ${o.number} — ${t.rows[0].name}`;
    } catch (e) { if (!(e instanceof AppError)) throw e; }
    const start = `/o/${TOKEN_RE.test(req.params.token) ? req.params.token : ''}`;
    return reply.type('application/manifest+json').header('Cache-Control', 'no-store').send({
      name, short_name: name.slice(0, 24), lang: 'ar', dir: 'rtl', start_url: start, scope: start, id: start,
      display: 'standalone', background_color: '#f6f4ee', theme_color: '#14532d',
      icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
  });

  app.get('/media/logo/:slug', async (req, reply) => {
    const { rows } = await app.pool.query('SELECT logo, logo_mime FROM tenants WHERE slug=$1', [String(req.params.slug).slice(0, 40)]);
    if (!rows[0]?.logo) return reply.code(404).send();
    return reply.type(rows[0].logo_mime).header('Cache-Control', 'public, max-age=86400').header('Content-Security-Policy', "default-src 'none'").send(rows[0].logo);
  });

  // ربط App Clip بالنطاق (يعمل فقط بعد ضبط APPLE_APP_ID)
  app.get('/.well-known/apple-app-site-association', async (req, reply) => {
    const id = app.config.apns.appId;
    if (!id) return reply.code(404).send();
    return reply.type('application/json').send({ appclips: { apps: [id] } });
  });
}

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, migrate } from './db.js';
import { AppError } from './lib/errors.js';
import { RateLimiter } from './lib/ratelimit.js';
import { Bus } from './lib/bus.js';
import { Notifier } from './services/notify/index.js';
import { startMaintenance } from './services/maintenance.js';
import pagesRoutes from './routes/pages.js';
import authRoutes from './routes/auth.js';
import staffRoutes from './routes/staff.js';
import ownerRoutes from './routes/owner.js';
import displayRoutes from './routes/display.js';
import publicRoutes from './routes/public.js';
import setupRoutes from './routes/setup.js';
import apiV1Routes from './routes/apiv1.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// لا نسجل رموز العملاء أو الأسرار كاملة
export function redactUrl(url) {
  return String(url)
    .replace(/(\/o\/)([A-Za-z0-9_-]{4})[A-Za-z0-9_-]+/g, '$1$2…')
    .replace(/(token=)[^&]+/g, '$1…');
}

export async function buildApp(config, { logger } = {}) {
  const app = Fastify({
    trustProxy: config.trustProxy,
    forceCloseConnections: true,
    bodyLimit: 64 * 1024,
    logger: logger ?? {
      level: config.logLevel,
      redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      serializers: {
        req: (req) => ({ method: req.method, url: redactUrl(req.url), ip: req.ip }),
      },
    },
  });

  app.decorate('config', config);
  app.decorate('pool', createPool(config));
  app.decorate('bus', new Bus());
  app.decorate('limiter', new RateLimiter());
  app.decorate('logError', async (source, message, context) => {
    app.log.warn({ source, context }, message);
    try { await app.pool.query('INSERT INTO error_log(source, message, context) VALUES ($1,$2,$3)', [source, String(message).slice(0, 500), context ? JSON.stringify(context) : null]); } catch { /* ignore */ }
  });

  await migrate(app.pool, app.log);
  const notifier = new Notifier(app);
  await notifier.init();
  app.decorate('notifier', notifier);

  await app.register(fastifyCookie);

  // ترويسات الأمان
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
    if (config.secureCookies) reply.header('Strict-Transport-Security', 'max-age=31536000');
    if (req.url.startsWith('/api/') && !reply.getHeader('cache-control')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  // حماية من الطلبات المزورة: كل تعديل عبر الكوكيز يتطلب ترويسة مخصصة (لا يمكن إرسالها من موقع آخر بلا CORS)
  app.addHook('onRequest', async (req) => {
    const m = req.method;
    if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return;
    if (!req.url.startsWith('/api/') || req.url.startsWith('/api/v1/')) return;
    if (req.headers['x-nidaa'] !== '1') throw new AppError(403, 'csrf', 'طلب مرفوض');
    const origin = req.headers.origin;
    if (origin) {
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      let ok = false;
      try { ok = new URL(origin).host === host || origin === new URL(config.publicUrl).origin; } catch { ok = false; }
      if (!ok) throw new AppError(403, 'csrf', 'طلب مرفوض');
    }
  });

  // حد عام للطلبات لكل عنوان — سخي لأن عملاء كثيرين قد يتشاركون عنوان واي فاي المقهى
  app.addHook('onRequest', async (req) => {
    if (req.url.startsWith('/api/')) app.limiter.hit(`ip:${req.ip}`, 3000, 60_000);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      if (err.extra?.retryAfter) reply.header('Retry-After', String(err.extra.retryAfter));
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, ...(err.extra || {}) } });
    }
    if (err.validation || err.statusCode === 400 || err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || err.statusCode === 415) {
      return reply.code(400).send({ error: { code: 'bad_request', message: 'طلب غير صالح' } });
    }
    if (err.statusCode === 413) return reply.code(413).send({ error: { code: 'too_large', message: 'الحجم أكبر من المسموح' } });
    req.log.error({ err }, 'unhandled error');
    app.logError('server', err.message, { url: redactUrl(req.url) });
    return reply.code(500).send({ error: { code: 'server_error', message: 'حدث خطأ في الخادم. حاول مرة أخرى.' } });
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: { code: 'not_found', message: 'غير موجود' } });
    return reply.code(404).type('text/html; charset=utf-8').sendFile('404.html');
  });

  await app.register(fastifyStatic, {
    root: path.join(ROOT, 'public'),
    prefix: '/',
    index: false,
    wildcard: true,
    setHeaders: (res, p) => {
      if (p.endsWith('.html')) res.header('Cache-Control', 'no-store');
      else if (p.endsWith('sw.js')) { res.header('Cache-Control', 'no-cache'); res.header('Service-Worker-Allowed', '/'); }
      else res.header('Cache-Control', 'public, max-age=300');
    },
  });
  await app.register(fastifyStatic, {
    root: path.join(ROOT, 'node_modules/@fontsource/ibm-plex-sans-arabic/files'),
    prefix: '/fonts/',
    decorateReply: false,
    setHeaders: (res) => res.header('Cache-Control', 'public, max-age=31536000, immutable'),
  });

  // مساعد البث اللحظي (SSE)
  app.decorate('sse', (req, reply, channels, { onOpen, onPing, initial } = {}) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    res.write(`retry: 3000\n\n`);
    const send = (event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`); } catch { /* closed */ } };
    const handlers = channels.map(([ch, map]) => {
      const h = (data) => { const ev = map ? map(data) : data.type || 'message'; if (ev) send(ev, data); };
      app.bus.on(ch, h);
      return [ch, h];
    });
    send('hello', initial || { serverTime: new Date().toISOString() });
    onOpen?.();
    const ping = setInterval(() => { res.write(`event: ping\ndata: {}\n\n`); onPing?.(); }, 20000);
    const close = () => { clearInterval(ping); for (const [ch, h] of handlers) app.bus.off(ch, h); };
    req.raw.on('close', close);
    res.on('error', close);
    return send;
  });

  await app.register(pagesRoutes);
  await app.register(setupRoutes);
  await app.register(authRoutes);
  await app.register(staffRoutes);
  await app.register(ownerRoutes);
  await app.register(displayRoutes);
  await app.register(publicRoutes);
  await app.register(apiV1Routes);

  app.get('/healthz', async () => {
    await app.pool.query('SELECT 1');
    return { ok: true, time: new Date().toISOString() };
  });

  let stopMaint = () => {};
  if (!config.disableMaintenance) stopMaint = startMaintenance(app);
  app.addHook('onClose', async () => { stopMaint(); app.notifier.close(); await app.pool.end(); });
  return app;
}

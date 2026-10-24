import { requireDisplay, cookieOpts } from './_auth.js';
import { startPairing, pairingStatus, DISPLAY_COOKIE, PAIR_COOKIE, displayContext } from '../services/auth.js';
import { displayState } from '../services/orders.js';
import { qrSvg } from './staff.js';

// شاشة العرض: صلاحية قراءة الطلب المعروض فقط لفرعها، بلا أي بيانات أخرى.
export default async function (app) {
  app.get('/api/display/session', async (req) => {
    const d = await displayContext(app, req.cookies?.[DISPLAY_COOKIE]);
    return { paired: !!d, name: d?.label || null };
  });

  app.post('/api/display/pair/start', async (req, reply) => {
    app.limiter.hit(`pair:${req.ip}`, 20, 10 * 60_000);
    const p = await startPairing(app);
    reply.setCookie(PAIR_COOKIE, p.secret, cookieOpts(app, 15 * 60));
    return { code: p.code, expiresAt: p.expiresAt };
  });

  app.get('/api/display/pair/status', async (req, reply) => {
    const s = await pairingStatus(app, req.cookies?.[PAIR_COOKIE]);
    if (s.state === 'paired') {
      reply.setCookie(DISPLAY_COOKIE, s.deviceToken, cookieOpts(app, 400 * 86400));
      reply.clearCookie(PAIR_COOKIE, { path: '/' });
      return { state: 'paired' };
    }
    return s;
  });

  app.post('/api/display/unpair', async (req, reply) => {
    const d = await displayContext(app, req.cookies?.[DISPLAY_COOKIE]);
    if (d) await app.pool.query('UPDATE display_devices SET revoked_at=now() WHERE id=$1', [d.id]);
    reply.clearCookie(DISPLAY_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/display/state', async (req) => {
    const d = await requireDisplay(app, req);
    const s = await displayState(app, d.branchId);
    if (s.current) s.current.qrSvg = await qrSvg(s.current.url);
    // لا نرسل معرّف الطلب الداخلي للشاشة
    if (s.current) delete s.current.orderId;
    return { ...s, deviceName: d.label };
  });

  app.get('/api/display/stream', async (req, reply) => {
    const d = await requireDisplay(app, req);
    let n = 0;
    app.sse(req, reply, [[`branch:${d.branchId}`, (m) => (m.type === 'display' ? 'display' : null)], [`display:${d.id}`, () => 'revoked']], {
      onOpen: () => app.bus.branch(d.branchId, { type: 'devices' }),
      // آخر اتصال للشاشة: كل دقيقة أثناء بقائها متصلة
      onPing: () => { if (++n % 3 === 0) app.pool.query('UPDATE display_devices SET last_seen_at=now() WHERE id=$1', [d.id]).catch(() => {}); },
    });
  });
}

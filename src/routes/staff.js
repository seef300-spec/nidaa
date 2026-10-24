import QRCode from 'qrcode';
import { requireUser, idemKey, intOrUndef } from './_auth.js';
import {
  createOrder, transition, listOrders, getOrderForBranch, serializeStaffOne, orderEvents,
  displayShow, displayHide, displayState,
} from '../services/orders.js';
import { badRequest } from '../lib/errors.js';

const ACTIONS = new Set(['call', 'recall', 'deliver', 'cancel', 'undo_deliver']);

export async function qrSvg(text) {
  // تباين عالٍ وهامش آمن (4 وحدات) وتصحيح أخطاء متوسط يناسب الطباعة والشاشات
  return QRCode.toString(text, { type: 'svg', errorCorrectionLevel: 'M', margin: 4, color: { dark: '#000000', light: '#ffffff' } });
}

export default async function (app) {
  app.get('/api/staff/orders', async (req) => {
    const u = await requireUser(app, req);
    const { filter, q, date, cursor, limit } = req.query || {};
    return listOrders(app, u.branchId, { filter, q, date, cursor, limit });
  });

  app.post('/api/staff/orders', async (req, reply) => {
    const u = await requireUser(app, req);
    app.limiter.hit(`create:${u.id}`, 120, 60_000);
    const b = req.body || {};
    const out = await createOrder(app, u, { externalRef: b.externalRef, note: b.note, showOnDisplay: b.showOnDisplay }, idemKey(req));
    if (out.replayed) reply.header('Idempotent-Replayed', 'true');
    return reply.code(out.status).send(out.body);
  });

  app.get('/api/staff/orders/:id', async (req) => {
    const u = await requireUser(app, req);
    const o = await getOrderForBranch(app.pool, u.branchId, req.params.id);
    return { order: await serializeStaffOne(app.pool, app, o) };
  });

  app.get('/api/staff/orders/:id/events', async (req) => {
    const u = await requireUser(app, req);
    return { events: await orderEvents(app, u.branchId, req.params.id) };
  });

  app.get('/api/staff/orders/:id/qr.svg', async (req, reply) => {
    const u = await requireUser(app, req);
    const o = await getOrderForBranch(app.pool, u.branchId, req.params.id);
    reply.header('Cache-Control', 'private, max-age=3600');
    return reply.type('image/svg+xml').send(await qrSvg(`${app.config.publicUrl}/o/${o.public_token}`));
  });

  app.post('/api/staff/orders/:id/:action', async (req, reply) => {
    const u = await requireUser(app, req);
    const { id, action } = req.params;
    if (action === 'display') {
      const mode = req.body?.mode;
      if (mode === 'show') await displayShow(app, u, id);
      else if (mode === 'hide') await displayHide(app, u, id);
      else throw badRequest('invalid_mode', 'غير صالح');
      const o = await getOrderForBranch(app.pool, u.branchId, id);
      return { order: await serializeStaffOne(app.pool, app, o) };
    }
    if (!ACTIONS.has(action)) throw badRequest('invalid_action', 'إجراء غير معروف');
    app.limiter.hit(`act:${u.id}`, 240, 60_000);
    const out = await transition(app, u, id, action, { expectedVersion: intOrUndef(req.body?.expectedVersion), idemKey: idemKey(req) });
    if (out.replayed) reply.header('Idempotent-Replayed', 'true');
    return reply.code(out.status).send(out.body);
  });

  // ما يظهر الآن على شاشة العرض (للموظف)
  app.get('/api/staff/display', async (req) => {
    const u = await requireUser(app, req);
    const s = await displayState(app, u.branchId);
    const devices = await app.pool.query(
      `SELECT id, name, last_seen_at FROM display_devices WHERE branch_id=$1 AND revoked_at IS NULL ORDER BY created_at`, [u.branchId]);
    return { ...s, devices: devices.rows };
  });

  app.get('/api/staff/stream', async (req, reply) => {
    const u = await requireUser(app, req);
    app.sse(req, reply, [[`branch:${u.branchId}`]]);
  });
}

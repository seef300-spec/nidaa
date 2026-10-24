import { requireApi, idemKey, intOrUndef } from './_auth.js';
import { createOrder, transition, getOrderForBranch, serializeStaffOne } from '../services/orders.js';
import { badRequest, notFound } from '../lib/errors.js';

// واجهة التكامل (الكاشير مستقبلًا). موثقة في docs/API.md و /api/v1/openapi.json
const MAP = { ready: 'call', recall: 'recall', deliver: 'deliver', cancel: 'cancel' };

function apiOrder(o) {
  // لا نرسل الحقول الداخلية الخاصة بالواجهة
  const { undoUntil, display, ...rest } = o;
  return rest;
}

export default async function (app) {
  app.post('/api/v1/orders', async (req, reply) => {
    const k = await requireApi(app, req, 'orders:write');
    app.limiter.hit(`api:${k.id}`, 300, 60_000);
    const b = req.body || {};
    const out = await createOrder(app, k, {
      externalRef: b.externalRef, note: b.note, externalSource: b.externalId ? (b.externalSource || 'pos') : undefined,
      externalId: b.externalId, showOnDisplay: b.showOnDisplay,
    }, idemKey(req));
    if (out.replayed) reply.header('Idempotent-Replayed', 'true');
    return reply.code(out.status).send({ order: apiOrder(out.body.order), duplicate: !!out.body.duplicate });
  });

  app.get('/api/v1/orders', async (req) => {
    const k = await requireApi(app, req, 'orders:read');
    const ext = String(req.query?.externalId || '');
    if (!ext) throw badRequest('required', 'externalId مطلوب');
    const { rows } = await app.pool.query(
      'SELECT * FROM orders WHERE branch_id=$1 AND external_source=$2 AND external_id=$3',
      [k.branchId, String(req.query?.externalSource || 'pos'), ext]);
    if (!rows[0]) throw notFound('الطلب غير موجود');
    return { order: apiOrder(await serializeStaffOne(app.pool, app, rows[0])) };
  });

  app.get('/api/v1/orders/:id', async (req) => {
    const k = await requireApi(app, req, 'orders:read');
    const o = await getOrderForBranch(app.pool, k.branchId, req.params.id);
    return { order: apiOrder(await serializeStaffOne(app.pool, app, o)) };
  });

  app.post('/api/v1/orders/:id/:action', async (req, reply) => {
    const k = await requireApi(app, req, 'orders:write');
    const action = MAP[req.params.action];
    if (!action) throw badRequest('invalid_action', 'الإجراءات: ready, recall, deliver, cancel');
    app.limiter.hit(`api:${k.id}`, 300, 60_000);
    const out = await transition(app, k, req.params.id, action, { expectedVersion: intOrUndef(req.body?.expectedVersion), idemKey: idemKey(req) });
    if (out.replayed) reply.header('Idempotent-Replayed', 'true');
    return reply.code(out.status).send({ order: apiOrder(out.body.order) });
  });

  app.get('/api/v1/openapi.json', async () => openapi(app.config.publicUrl));
}

function openapi(server) {
  const order = { $ref: '#/components/schemas/Order' };
  const ok = { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { order } } } } };
  const err = { description: 'خطأ', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
  const idem = { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', minLength: 8, maxLength: 100 }, description: 'يمنع تكرار العملية عند إعادة الإرسال' };
  const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
  const act = (summary) => ({
    summary, parameters: [idParam, idem],
    requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { expectedVersion: { type: 'integer' } } } } } },
    responses: { 200: ok, 404: err, 409: err, 429: err },
  });
  return {
    openapi: '3.0.3',
    info: { title: 'Nidaa API', version: '1.0.0', description: 'واجهة تكامل نداء (الكاشير). المصادقة: Authorization: Bearer <API key>' },
    servers: [{ url: server }],
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      schemas: {
        Error: { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } } } },
        Order: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' }, number: { type: 'integer' }, businessDate: { type: 'string', format: 'date' },
            status: { type: 'string', enum: ['preparing', 'ready', 'delivered', 'cancelled'] }, version: { type: 'integer' },
            externalRef: { type: 'string', nullable: true }, externalSource: { type: 'string', nullable: true }, externalId: { type: 'string', nullable: true },
            url: { type: 'string', description: 'رابط العميل (يُحوَّل إلى QR)' },
            createdAt: { type: 'string', format: 'date-time' }, readyAt: { type: 'string', nullable: true }, deliveredAt: { type: 'string', nullable: true }, cancelledAt: { type: 'string', nullable: true },
            customer: { type: 'object' }, notify: { type: 'object' }, lastCall: { type: 'object', nullable: true },
          },
        },
      },
    },
    security: [{ bearer: [] }],
    paths: {
      '/api/v1/orders': {
        post: {
          summary: 'إنشاء طلب', parameters: [idem],
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: {
            externalId: { type: 'string', description: 'معرّف الطلب في الكاشير — يمنع التكرار' }, externalSource: { type: 'string', default: 'pos' },
            externalRef: { type: 'string', description: 'رقم الفاتورة الظاهر للموظف' }, note: { type: 'string' }, showOnDisplay: { type: 'boolean' } } } } } },
          responses: { 201: ok, 200: { description: 'موجود مسبقًا بنفس externalId' }, 401: err, 422: err },
        },
        get: { summary: 'البحث بمعرّف الكاشير', parameters: [{ name: 'externalId', in: 'query', required: true, schema: { type: 'string' } }, { name: 'externalSource', in: 'query', schema: { type: 'string', default: 'pos' } }], responses: { 200: ok, 404: err } },
      },
      '/api/v1/orders/{id}': { get: { summary: 'قراءة طلب', parameters: [idParam], responses: { 200: ok, 404: err } } },
      '/api/v1/orders/{id}/ready': { post: act('جاهز + نداء العميل') },
      '/api/v1/orders/{id}/recall': { post: act('إعادة النداء') },
      '/api/v1/orders/{id}/deliver': { post: act('تأكيد التسليم') },
      '/api/v1/orders/{id}/cancel': { post: act('إلغاء') },
    },
  };
}

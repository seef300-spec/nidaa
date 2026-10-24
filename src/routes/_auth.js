import { sessionContext, displayContext, apiKeyContext, SESSION_COOKIE, DISPLAY_COOKIE } from '../services/auth.js';
import { unauthorized, forbidden, badRequest } from '../lib/errors.js';

export function cookieOpts(app, maxAge) {
  return { path: '/', httpOnly: true, secure: app.config.secureCookies, sameSite: 'strict', maxAge };
}

export async function requireUser(app, req, { owner = false } = {}) {
  const ctx = await sessionContext(app, req.cookies?.[SESSION_COOKIE]);
  if (!ctx) throw unauthorized();
  if (owner && ctx.role !== 'owner') throw forbidden('هذا الإجراء للمالك فقط');
  return ctx;
}

export async function requireDisplay(app, req) {
  const ctx = await displayContext(app, req.cookies?.[DISPLAY_COOKIE]);
  if (!ctx) throw unauthorized('الشاشة غير مقترنة');
  return ctx;
}

export async function requireApi(app, req, scope) {
  const ctx = await apiKeyContext(app, req.headers.authorization);
  if (!ctx) throw unauthorized('مفتاح API غير صالح');
  if (!ctx.scopes.includes(scope)) throw forbidden('المفتاح لا يملك هذه الصلاحية');
  return ctx;
}

export function idemKey(req) {
  const k = req.headers['idempotency-key'];
  return k ? String(k) : undefined;
}

export function intOrUndef(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw badRequest('invalid_version', 'قيمة غير صالحة');
  return n;
}

export class AppError extends Error {
  constructor(status, code, message, extra) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
export const badRequest = (code, msg, extra) => new AppError(400, code, msg, extra);
export const unauthorized = (msg = 'يلزم تسجيل الدخول') => new AppError(401, 'unauthorized', msg);
export const forbidden = (msg = 'لا تملك صلاحية لهذا الإجراء') => new AppError(403, 'forbidden', msg);
export const notFound = (msg = 'غير موجود') => new AppError(404, 'not_found', msg);
export const conflict = (code, msg, extra) => new AppError(409, code, msg, extra);
export const gone = (code, msg) => new AppError(410, code, msg);
export const tooMany = (msg, retryAfter) => new AppError(429, 'rate_limited', msg, { retryAfter });

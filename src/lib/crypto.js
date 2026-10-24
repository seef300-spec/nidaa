import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();
export const sha256hex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// رمز العميل: 18 بايت = 144 بت عشوائية، 24 حرفًا في الرابط.
export const customerToken = () => crypto.randomBytes(18).toString('base64url');

export function pairingCode() {
  // 6 أحرف من أبجدية بلا التباس (لا O/0/I/1)
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(6);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw.normalize('NFKC'), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function verifyPassword(pw, stored) {
  const [alg, N, r, p, saltB64, keyB64] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const key = Buffer.from(keyB64, 'base64');
  const got = await scrypt(String(pw).normalize('NFKC'), Buffer.from(saltB64, 'base64'), key.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(key, got);
}
// تجزئة وهمية لمساواة زمن الاستجابة عند اسم مستخدم غير موجود
export const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

// إخفاء الرموز في السجلات
export const mask = (s) => (s ? `${String(s).slice(0, 4)}…` : s);

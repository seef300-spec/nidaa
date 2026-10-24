// كل الإعدادات من متغيرات البيئة — لا أسرار داخل الكود.
const env = process.env;

function bool(v, def) {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

export function loadConfig(overrides = {}) {
  const cfg = {
    port: Number(env.PORT || 3000),
    host: env.HOST || '0.0.0.0',
    databaseUrl: env.DATABASE_URL || 'postgres://postgres@localhost:5432/nidaa',
    databaseSsl: bool(env.DATABASE_SSL, false),
    // الرابط العام الذي يُطبع في QR. يجب أن يكون HTTPS في الإنتاج.
    // على Render يُضبط RENDER_EXTERNAL_URL تلقائيًا، فلا حاجة لإدخال الرابط يدويًا
    publicUrl: (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/+$/, ''),
    setupToken: env.SETUP_TOKEN || '',
    secureCookies: bool(env.SECURE_COOKIES, (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || '').startsWith('https://')),
    trustProxy: bool(env.TRUST_PROXY, true),
    retentionDays: Number(env.RETENTION_DAYS || 90),
    logLevel: env.LOG_LEVEL || 'info',
    vapid: {
      publicKey: env.VAPID_PUBLIC_KEY || '',
      privateKey: env.VAPID_PRIVATE_KEY || '',
      subject: env.VAPID_SUBJECT || '',
    },
    apns: {
      keyId: env.APNS_KEY_ID || '',
      teamId: env.APNS_TEAM_ID || '',
      // محتوى ملف ‎.p8 (يمكن وضع \n بدل الأسطر الجديدة)
      privateKey: (env.APNS_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      bundleId: env.APNS_BUNDLE_ID || '',          // معرّف App Clip
      appId: env.APPLE_APP_ID || '',               // TEAMID.bundle للـ AASA
      host: env.APNS_HOST || '',                   // للاختبار فقط
    },
    maintenanceIntervalMs: Number(env.MAINTENANCE_INTERVAL_MS || 15000),
    disableMaintenance: bool(env.DISABLE_MAINTENANCE, false),
    ...overrides,
  };
  return cfg;
}

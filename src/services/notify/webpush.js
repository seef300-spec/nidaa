import webpush from 'web-push';

// مزود Web Push (VAPID). يعيد نتيجة موحدة بلا استثناءات.
export class WebPushProvider {
  constructor({ publicKey, privateKey, subject }) {
    this.publicKey = publicKey;
    this.privateKey = privateKey;
    this.subject = subject;
  }
  async send(sub, payload, { ttl = 1800, topic } = {}) {
    try {
      const res = await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
        {
          vapidDetails: { subject: this.subject, publicKey: this.publicKey, privateKey: this.privateKey },
          TTL: ttl,
          urgency: 'high',
          topic,
          timeout: 10000,
          ...(process.env.PUSH_HTTPS_PROXY ? { proxy: process.env.PUSH_HTTPS_PROXY } : {}),
        });
      return { accepted: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode };
    } catch (e) {
      const status = e.statusCode || 0;
      return {
        accepted: false,
        status,
        expired: status === 404 || status === 410,
        retryable: status === 0 || status === 429 || status >= 500,
        error: (e.body || e.message || 'error').toString().slice(0, 300),
      };
    }
  }
}

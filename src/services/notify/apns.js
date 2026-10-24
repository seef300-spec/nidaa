import http2 from 'node:http2';
import crypto from 'node:crypto';

// مزود APNs بالمصادقة عبر رمز JWT (مفتاح ‎.p8). يُستخدم لـ App Clip والـ Live Activities.
export class ApnsProvider {
  constructor({ keyId, teamId, privateKey, bundleId, host }) {
    this.keyId = keyId; this.teamId = teamId; this.privateKey = privateKey; this.bundleId = bundleId;
    this.hostOverride = host;
    this.jwt = null; this.jwtAt = 0;
    this.sessions = new Map();
  }
  get configured() { return !!(this.keyId && this.teamId && this.privateKey && this.bundleId); }

  token() {
    // يُجدد كل 50 دقيقة (آبل ترفض التجديد الأسرع من 20 دقيقة والأقدم من ساعة)
    if (this.jwt && Date.now() - this.jwtAt < 50 * 60 * 1000) return this.jwt;
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: this.keyId })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ iss: this.teamId, iat: Math.floor(Date.now() / 1000) })).toString('base64url');
    const sig = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key: this.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    this.jwt = `${header}.${claims}.${sig}`; this.jwtAt = Date.now();
    return this.jwt;
  }

  session(env) {
    const host = this.hostOverride || (env === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com');
    let s = this.sessions.get(host);
    if (s && !s.closed && !s.destroyed) return s;
    s = http2.connect(host);
    s.on('error', () => this.sessions.delete(host));
    s.on('close', () => this.sessions.delete(host));
    s.setTimeout(5 * 60 * 1000, () => s.close());
    this.sessions.set(host, s);
    return s;
  }

  // kind: 'alert' | 'liveactivity'
  send(sub, payload, { kind = 'alert', collapseId, expirationSec = 1800 } = {}) {
    return new Promise((resolve) => {
      let s;
      try { s = this.session(sub.apns_env); } catch (e) { return resolve({ accepted: false, status: 0, retryable: true, error: e.message }); }
      const headers = {
        ':method': 'POST',
        ':path': `/3/device/${sub.endpoint}`,
        authorization: `bearer ${this.token()}`,
        'apns-push-type': kind === 'liveactivity' ? 'liveactivity' : 'alert',
        'apns-topic': kind === 'liveactivity' ? `${this.bundleId}.push-type.liveactivity` : this.bundleId,
        'apns-priority': '10',
        'apns-expiration': String(Math.floor(Date.now() / 1000) + expirationSec),
      };
      if (collapseId) headers['apns-collapse-id'] = collapseId.slice(0, 64);
      const req = s.request(headers);
      let status = 0; let body = '';
      req.setTimeout(10000, () => { req.close(); resolve({ accepted: false, status: 0, retryable: true, error: 'timeout' }); });
      req.on('response', (h) => { status = h[':status']; });
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        if (status === 200) return resolve({ accepted: true, status });
        let reason = '';
        try { reason = JSON.parse(body).reason; } catch { reason = body.slice(0, 200); }
        resolve({
          accepted: false, status, error: reason || `HTTP ${status}`,
          expired: status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered',
          retryable: status === 429 || status >= 500,
        });
      });
      req.on('error', (e) => resolve({ accepted: false, status: 0, retryable: true, error: e.message }));
      req.end(JSON.stringify(payload));
    });
  }
  close() { for (const s of this.sessions.values()) s.close(); }
}

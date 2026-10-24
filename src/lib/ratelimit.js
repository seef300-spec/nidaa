import { tooMany } from './errors.js';

// محدد معدل بسيط في الذاكرة (نافذة منزلقة تقريبية). يكفي لنسخة خادم واحدة.
export class RateLimiter {
  constructor() { this.buckets = new Map(); setInterval(() => this.sweep(), 60000).unref(); }
  hit(key, limit, windowMs) {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b || now - b.start >= windowMs) { b = { start: now, count: 0, windowMs }; this.buckets.set(key, b); }
    b.count++;
    if (b.count > limit) {
      const retryAfter = Math.ceil((b.start + windowMs - now) / 1000);
      throw tooMany('طلبات كثيرة، حاول بعد قليل', retryAfter);
    }
  }
  sweep() { const now = Date.now(); for (const [k, b] of this.buckets) if (now - b.start >= b.windowMs) this.buckets.delete(k); }
}

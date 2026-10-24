// عامل خدمة نداء: يستقبل إشعار النداء ويعرضه فورًا، ثم يؤكد الاستلام للخادم.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { title: 'نداء', body: event.data?.text() || '' }; }
  const title = d.title || 'طلبك جاهز';
  const opts = {
    body: d.body || '',
    tag: d.tag || 'nidaa',
    renotify: true,
    requireInteraction: true,
    lang: 'ar',
    dir: 'rtl',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    vibrate: [400, 150, 400, 150, 800],
    timestamp: Date.now(),
    data: { url: d.url || '/' },
  };
  const tasks = [self.registration.showNotification(title, opts)];
  // تأكيد استلام الجهاز للتنبيه (دليل تقني يظهر للموظف)
  if (d.deliveryId && d.url) {
    const token = new URL(d.url).pathname.split('/')[2];
    tasks.push(fetch(`/api/public/o/${token}/receipt`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nidaa': '1' },
      body: JSON.stringify({ channel: 'push', deliveryId: d.deliveryId }), keepalive: true,
    }).catch(() => {}));
  }
  tasks.push(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => cs.forEach((c) => c.postMessage({ t: d.t || 'call' }))));
  event.waitUntil(Promise.all(tasks));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const path = new URL(url, self.location.origin).pathname;
    for (const c of cs) {
      if (new URL(c.url).pathname === path && 'focus' in c) return c.focus();
    }
    return self.clients.openWindow(url);
  })());
});

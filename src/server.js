import { loadConfig } from './config.js';
import { buildApp } from './app.js';

const config = loadConfig();
if (config.publicUrl.startsWith('http://') && process.env.NODE_ENV === 'production') {
  console.warn('تحذير: PUBLIC_URL ليس HTTPS — الإشعارات وكاميرا المسح تتطلب HTTPS.');
}
const app = await buildApp(config);
await app.listen({ port: config.port, host: config.host });

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    app.log.info(`received ${sig}, shutting down`);
    await app.close().catch(() => {});
    process.exit(0);
  });
}

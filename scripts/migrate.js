import { loadConfig } from '../src/config.js';
import { createPool, migrate } from '../src/db.js';
const pool = createPool(loadConfig());
await migrate(pool, console);
await pool.end();
console.log('migrations up to date');

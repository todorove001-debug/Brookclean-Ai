import { buildApp } from "./app.js";
import { config } from "./config.js";
import { createPool } from "./db/pool.js";
import { migrate } from "./db/migrate.js";
import { LocalStorage } from "./storage/index.js";
import { ConsoleSms } from "./services/sms.js";

const pool = createPool();
await migrate(pool);
const app = await buildApp({ pool, storage: new LocalStorage(config.storageDir), sms: new ConsoleSms() }, { logger: true });
await app.listen({ port: config.port, host: config.host });

for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, async () => { await app.close(); await pool.end(); process.exit(0); });

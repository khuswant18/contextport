import http from 'node:http';
import { config, assertConfig } from './config.js';
import { migrate, pruneOldUsage, closeDb } from './db.js';
import { handle } from './app.js';

assertConfig();
await migrate();
pruneOldUsage().catch(() => {});
setInterval(() => pruneOldUsage().catch(() => {}), 24 * 3600_000).unref();

const server = http.createServer(handle);
// Slow-client protections.
server.headersTimeout = 15_000;
server.requestTimeout = 90_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 60;

server.listen(config.port, config.host, () => {
  console.log(`ContextPort server listening on http://${config.host}:${config.port} (${config.env})`);
});

function shutdown() {
  server.close(() => closeDb().finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

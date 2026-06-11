/**
 * Forge server — Fastify on localhost. Serves the API and, when built,
 * the web UI from web/dist.
 */

import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { getDb } from './db/db.js';
import { registerRoutes } from './api/routes.js';
import { activateOnBoot } from './workspaces/workspaces.js';

const app = Fastify({ logger: { level: 'info' } });

await app.register(fastifyCors, {
  origin: ['http://localhost:5173', 'http://127.0.0.1:5173', `http://localhost:${config.port}`, `http://127.0.0.1:${config.port}`],
});

await app.register(fastifyMultipart, { limits: { fileSize: 25 * 1024 * 1024 } });

registerRoutes(app);

// Serve the built UI when present
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web/dist');
if (fs.existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
    return reply.sendFile('index.html');
  });
}

activateOnBoot(); // open the active matter workspace (falls back to demo if locked)
getDb();

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
if (!LOOPBACK.has(config.host)) {
  app.log.warn(
    `FORGE_HOST=${config.host} binds beyond loopback. Forge has NO authentication — every matter, document and API ` +
      `action becomes available to anyone who can reach this machine on port ${config.port}. Only do this behind a ` +
      `firewall or reverse proxy that adds auth.`,
  );
}

try {
  await app.listen({ port: config.port, host: config.host });
  const counts = getDb().prepare(`SELECT (SELECT COUNT(*) FROM funds) AS funds, (SELECT COUNT(*) FROM obligations) AS obligations`).get() as {
    funds: number;
    obligations: number;
  };
  app.log.info(`Forge up at http://${config.host}:${config.port} — ${counts.funds} funds, ${counts.obligations} obligations${counts.funds === 0 ? ' (run `npm run seed`)' : ''}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

import path from 'node:path';
import { initQueue, stopQueue, isQueueReady } from './core/queue';
import { startWorkers } from './core/worker';
import { loadAgents, agentRegistry } from './core/agent';
import { dispatch } from './core/dispatch';
import { loadAllTools } from './core/registry';
import { loadContextQueries, setContextQueries } from './core/assemble';
import { startConnection, closeSocket, isConnected } from './whatsapp/connection';
import { attachReceiveHandler } from './whatsapp/receive';
import { drainQueue } from './whatsapp/send';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { client, db } from './db/client';
import { config } from './config';
import { log } from './logger';

const PORT = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error(`Invalid PORT: "${process.env.PORT}" — must be an integer between 1 and 65535`);
}

// Graceful shutdown — registered before main() so signal handlers are always active.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('[shutdown] received signal, shutting down gracefully', { signal });

  // 1. Drain the outbound send queue (max 5s).
  await Promise.race([
    drainQueue(),
    new Promise<void>((r) => setTimeout(r, 5_000)),
  ]);

  // 2. Close WhatsApp socket (suppresses reconnect loop).
  closeSocket();

  // 3. Stop pg-boss (drains active jobs, then stops).
  await stopQueue();

  // 4. Close DB pool.
  await client.end();
  log.info('[shutdown] complete');
  process.exit(0);
}
process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)); });
process.on('SIGINT',  () => { shutdown('SIGINT').catch(() => process.exit(1)); });

async function main(): Promise<void> {
  // 0. Validate required env vars — fail fast with a clear message
  const required = ['ANTHROPIC_API_KEY', 'ALLOWED_CHAT_ID'] as const;
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  // 1. Run pending DB migrations — idempotent, safe to run on every startup
  log.info('[startup] running database migrations');
  await migrate(db, { migrationsFolder: path.join(import.meta.dir, 'db/migrations') });

  // 2. Load tools, agents, and context queries before any message can arrive
  log.info('[startup] loading tools, agents, and context queries');
  await loadAllTools(path.join(import.meta.dir, 'tools'));
  await loadAgents(path.join(import.meta.dir, 'agents'));
  const contextQueries = await loadContextQueries(path.join(import.meta.dir, 'context'));
  setContextQueries(contextQueries);
  await import('./commands/register');

  // 3. Start pgboss queue
  log.info('[startup] initializing queue and workers');
  await initQueue();
  await startWorkers();

  // 4. Register cron schedules for agents that declare a schedule field
  for (const def of agentRegistry.values()) {
    if (def.schedule) {
      log.info('[startup] registering cron schedule', { agent: def.name, schedule: def.schedule });
      await dispatch({
        agent: def.name,
        objective: `Scheduled run of ${def.name}`,
        mode: { kind: 'cron', schedule: def.schedule },
        chatId: 'system',
        caller: 'scheduler',
      });
    }
  }

  // 5. Start WhatsApp connection with a timeout so the process doesn't hang forever
  log.info('[startup] connecting to WhatsApp');
  const { connectionTimeoutMs } = config.startup;
  const socket = await Promise.race([
    startConnection(),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`WhatsApp connection timed out after ${connectionTimeoutMs}ms`)),
        connectionTimeoutMs,
      ),
    ),
  ]);
  attachReceiveHandler(socket);

  // 6. Health check
  Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/healthz') {
        const dbStatus = await client`SELECT 1`.then(() => 'ok' as const).catch(() => 'error' as const);
        const whatsapp = isConnected() ? 'connected' : 'disconnected';
        const queue = isQueueReady() ? 'ok' : 'not_ready';
        const status = dbStatus === 'ok' && whatsapp === 'connected' && queue === 'ok' ? 'ok' : 'degraded';
        return Response.json({ status, ts: new Date().toISOString(), db: dbStatus, whatsapp, queue });
      }
      return new Response('Not Found', { status: 404 });
    },
  });

  log.info('[startup] ready', { port: PORT });
}

main().catch((err: unknown) => {
  log.error('[startup] fatal', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});

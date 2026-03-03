import path from 'path';
import { initQueue } from './core/queue';
import { startWorkers } from './core/worker';
import { loadAgents } from './core/agent';
import { loadAllTools } from './tools/registry';
import { loadContextQueries, setContextQueries } from './core/assemble';
import { startConnection } from './whatsapp/connection';
import { attachReceiveHandler } from './whatsapp/receive';
import { log } from './logger';

const PORT = Number(process.env.PORT ?? 3000);

async function main(): Promise<void> {
  // 1. Load tools, agents, and context queries before any message can arrive
  log.info('[startup] loading tools, agents, and context queries');
  await loadAllTools(path.join(import.meta.dir, 'tools'));
  await loadAgents(path.join(import.meta.dir, 'agents'));
  const contextQueries = await loadContextQueries(path.join(import.meta.dir, 'context'));
  setContextQueries(contextQueries);

  // 2. Start pgboss queue
  log.info('[startup] initializing queue and workers');
  await initQueue();
  await startWorkers();

  // 3. Start WhatsApp connection and attach message handler
  log.info('[startup] connecting to WhatsApp');
  const socket = await startConnection();
  attachReceiveHandler(socket);

  // 4. Health check
  Bun.serve({
    port: PORT,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/healthz') {
        return Response.json({ status: 'ok', ts: new Date().toISOString() });
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

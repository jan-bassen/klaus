import path from 'path';
import { initQueue } from './core/queue';
import { startWorkers } from './core/worker';
import { loadAgents } from './core/agent';
import { loadAllTools } from './tools/registry';
import { startConnection } from './whatsapp/connection';
import { attachReceiveHandler } from './whatsapp/receive';

const PORT = Number(process.env.PORT ?? 3000);

async function main(): Promise<void> {
  // 1. Load tools and agents before any message can arrive
  await loadAllTools();
  await loadAgents(path.join(import.meta.dir, 'agents'));

  // 2. Start pgboss queue
  await initQueue();
  await startWorkers();

  // 3. Start WhatsApp connection and attach message handler
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

  console.log(`Klaus running — health check on :${PORT}/healthz`);
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

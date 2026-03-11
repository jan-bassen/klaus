import { $ } from 'bun';
import { afterAll, afterEach, beforeAll, describe, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

// bun-types incorrectly requires a fn argument for it.todo at the type level,
// but bun supports it.todo(label) without a function at runtime.
export const todo = (label: string) => (it.todo as unknown as (label: string) => void)(label);

// Gate: DB tests only run when RUN_DB_TESTS=1 is explicitly set (e.g. via test:db script).
// DATABASE_URL is always present from .env, so we use a dedicated opt-in flag instead.
export const DB_AVAILABLE = process.env.RUN_DB_TESTS === '1';
export const describeDb: typeof describe = DB_AVAILABLE ? describe : describe.skip;

// test:db script sets DATABASE_URL to the test DB (klaus_test).
// All modules that import db from client.ts will also use that URL.
const DB_URL =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/klaus_test';

async function startPostgres(): Promise<void> {
  try {
    await $`docker compose up -d postgres`.quiet();
  } catch {
    throw new Error('Failed to start postgres via docker compose — is Docker running?');
  }
}

async function waitForPostgres(timeoutMs = 30_000): Promise<void> {
  const url = new URL(DB_URL);
  url.pathname = '/postgres';
  const adminUrl = url.toString();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const client = postgres(adminUrl, { max: 1, connect_timeout: 2 });
      await client`SELECT 1`;
      await client.end();
      return;
    } catch {
      await Bun.sleep(500);
    }
  }
  throw new Error(`Postgres did not become ready within ${timeoutMs / 1000}s`);
}

async function ensureTestDb(): Promise<void> {
  const url = new URL(DB_URL);
  const dbName = url.pathname.slice(1);
  url.pathname = '/postgres';
  // Always drop and recreate so we start from a guaranteed clean state.
  // This avoids "type already exists" errors from partially-applied migrations
  // left over by a previous failed run.
  const admin = postgres(url.toString(), { max: 1 });
  try {
    // Terminate any open connections first — DROP DATABASE fails if others are connected.
    // This handles stale connections from a previously crashed run and the parallel
    // test runner starting a second file before the first has fully torn down.
    await admin`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = ${dbName} AND pid <> pg_backend_pid()
    `;
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }
}

// Call setupTestDb() once at the top of each DB test file.
// It registers beforeAll/afterAll/afterEach hooks for that file.
export function setupTestDb(): void {
  if (!DB_AVAILABLE) return;

  let client!: ReturnType<typeof postgres>;
  let cleanupDb!: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    await startPostgres();
    await waitForPostgres();
    await ensureTestDb();
    client = postgres(DB_URL, { max: 1 });
    cleanupDb = drizzle(client);
    await migrate(cleanupDb, { migrationsFolder: 'src/db/migrations' });
  });

  afterEach(async () => {
    if (!cleanupDb) return;
    // Truncate in reverse FK order so CASCADE handles child rows.
    // Exclude __drizzle_migrations so migration state is preserved.
    await cleanupDb.execute(
      sql`TRUNCATE TABLE invocations, costs, budgets, reactions, provenance, node_versions, chunks, edges, files, messages, tasks, nodes RESTART IDENTITY CASCADE`,
    );
  });

  afterAll(async () => {
    if (!client) return;
    await client.end();
  });
}

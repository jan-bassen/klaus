import { $ } from 'bun';
import { afterAll, afterEach, beforeAll, describe, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

// bun-types incorrectly requires a fn argument for it.todo at the type level,
// but bun supports it.todo(label) without a function at runtime.
export const todo = (label: string) => (it.todo as unknown as (label: string) => void)(label);

// Gate: DB tests only run when DATABASE_URL is explicitly set (e.g. via test:db script).
export const DB_AVAILABLE = !!process.env.DATABASE_URL;
export const describeDb: typeof describe = DB_AVAILABLE ? describe : describe.skip;

// test:db script sets DATABASE_URL to the test DB (klaus_test).
// All modules that import db from client.ts will also use that URL.
const DB_URL =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/klaus_test';

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
  const admin = postgres(url.toString(), { max: 1 });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } catch (e: unknown) {
    if (!String((e as { message?: string }).message).includes('already exists')) throw e;
  } finally {
    await admin.end();
  }
  // pgvector must be enabled before migrations run (idempotent)
  const ext = postgres(DB_URL, { max: 1 });
  try {
    await ext.unsafe('CREATE EXTENSION IF NOT EXISTS vector');
  } finally {
    await ext.end();
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
    // Generate migrations from current schema (no-op if already up to date).
    // drizzle-kit generate is filesystem-only — no DB connection required.
    await $`bun run db:generate`.quiet();
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
      sql`TRUNCATE TABLE llm_costs, llm_budgets, provenance, node_versions, chunks, edges, messages, tasks, nodes RESTART IDENTITY CASCADE`,
    );
  });

  afterAll(async () => {
    if (!client) return;
    await client.end();
  });
}

#!/usr/bin/env bun
/**
 * Drop and recreate the dev database, then run migrations.
 * Respects DATABASE_URL env var — defaults to the local dev DB.
 *
 * Usage:
 *   bun run db:reset
 *   DATABASE_URL=postgres://... bun run db:reset
 */
import { $ } from 'bun';
import postgres from 'postgres';

const base = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/klaus';
const url = new URL(base);
const dbName = url.pathname.slice(1);
url.pathname = '/postgres';

const admin = postgres(url.toString(), { max: 1 });
try {
  await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`);
  await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  console.log(`Recreated database: ${dbName}`);
} finally {
  await admin.end();
}

await $`bun run db:migrate`;

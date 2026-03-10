import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema';
import { config } from '@/config';

export const client = postgres(config.database.url);

export const db = drizzle(client, { schema });

export type Db = typeof db;

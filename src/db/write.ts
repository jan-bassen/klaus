import { embed } from 'ai';
import { voyage } from 'voyage-ai-provider';
import { desc, eq, sql } from 'drizzle-orm';
import type { InferInsertModel } from 'drizzle-orm';
import { config } from '@/config';
import type { Node } from '@/types';
import { db } from './client';
import { chunks, nodeVersions, nodes } from './schema';

export type NodeInsert = InferInsertModel<typeof nodes>;

const EMBED_MODEL = voyage.textEmbeddingModel(config.models.embed);

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export async function embedText(text: string): Promise<number[]> {
  const { embedding } = await embed({ model: EMBED_MODEL, value: text });
  return embedding;
}

function tsvectorExpr(title: string | null | undefined, body: string | null | undefined) {
  const text = [title, body].filter(Boolean).join(' ');
  return text ? sql`to_tsvector('english', ${text})` : sql`''::tsvector`;
}

function splitBody(body: string): string[] {
  const paragraphs = body.split(/\n\n+/);
  const result: string[] = [];
  let current = '';
  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para;
    if (current && estimateTokens(candidate) > config.chunking.thresholdTokens) {
      result.push(current);
      current = para;
    } else {
      current = candidate;
    }
  }
  if (current) result.push(current);
  return result;
}

async function syncChunks(nodeId: string, body: string): Promise<void> {
  const texts = splitBody(body);
  await db.delete(chunks).where(eq(chunks.nodeId, nodeId));
  if (texts.length === 0) return;

  const rows = await Promise.all(
    texts.map(async (text, ordinal) => ({
      nodeId,
      ordinal,
      body: text,
      embedding: await embedText(text),
      searchTsv: sql`to_tsvector('english', ${text})`,
      tokenCount: estimateTokens(text),
    })),
  );
  await db.insert(chunks).values(rows);
}

export async function writeNode(insert: NodeInsert): Promise<Node> {
  const searchText = [insert.title, insert.body].filter(Boolean).join(' ');
  const embedding = searchText ? await embedText(searchText) : undefined;
  const tokenCount = insert.body ? estimateTokens(insert.body) : 0;

  const [node] = await db
    .insert(nodes)
    .values({ ...insert, embedding, searchTsv: tsvectorExpr(insert.title, insert.body), tokenCount })
    .returning();

  if (!node) throw new Error('Insert returned no row');

  if (node.body && tokenCount > config.chunking.thresholdTokens) {
    await syncChunks(node.id, node.body);
  }

  return node;
}

export async function upsertNode(
  id: string,
  update: Partial<NodeInsert>,
  reason: 'user_edit' | 'contradiction_resolved' | 'merged' | 'reflection',
): Promise<Node> {
  const [current] = await db.select().from(nodes).where(eq(nodes.id, id));
  if (!current) throw new Error(`Node not found: ${id}`);

  const [latestVer] = await db
    .select({ version: nodeVersions.version })
    .from(nodeVersions)
    .where(eq(nodeVersions.nodeId, id))
    .orderBy(desc(nodeVersions.version))
    .limit(1);

  await db.insert(nodeVersions).values({
    nodeId: id,
    version: (latestVer?.version ?? 0) + 1,
    title: current.title,
    body: current.body,
    tags: current.tags,
    reason,
  });

  const newTitle = update.title !== undefined ? update.title : current.title;
  const newBody = update.body !== undefined ? update.body : current.body;
  const searchText = [newTitle, newBody].filter(Boolean).join(' ');
  const embedding = searchText ? await embedText(searchText) : undefined;
  const tokenCount = newBody ? estimateTokens(newBody) : 0;

  const [updated] = await db
    .update(nodes)
    .set({
      ...update,
      embedding,
      searchTsv: tsvectorExpr(newTitle, newBody),
      tokenCount,
      updatedAt: new Date(),
    })
    .where(eq(nodes.id, id))
    .returning();

  if (!updated) throw new Error(`Update returned no row for node: ${id}`);

  if (update.body !== undefined) {
    if (updated.body && tokenCount > config.chunking.thresholdTokens) {
      await syncChunks(id, updated.body);
    } else {
      await db.delete(chunks).where(eq(chunks.nodeId, id));
    }
  }

  return updated;
}

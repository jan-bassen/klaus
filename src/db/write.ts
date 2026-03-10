import { embed } from 'ai';
import { voyage } from 'voyage-ai-provider';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { InferInsertModel } from 'drizzle-orm';
import { config } from '@/config';
import type { Node } from '@/types';
import { db } from './client';
import { apiCosts, chunks, files, messages, nodeVersions, nodes, reactions } from './schema';
import { log } from '@/logger';

export type NodeInsert = InferInsertModel<typeof nodes>;

const EMBED_MODEL = voyage.textEmbeddingModel(config.models.embed);

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export async function embedText(text: string): Promise<number[]> {
  const { embedding, usage } = await embed({ model: EMBED_MODEL, value: text });
  const tokens = usage?.tokens ?? estimateTokens(text);
  const costUsd = (tokens / 1_000_000) * config.apiPricing.embed.perMTok;
  db.insert(apiCosts).values({ service: 'embed', units: tokens, costUsd: String(costUsd) }).catch(() => {});
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
    try {
      await syncChunks(node.id, node.body);
    } catch (err) {
      log.warn('[write] chunk sync failed after insert — chunks may be stale', {
        nodeId: node.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return node;
}

export type FileInsert = InferInsertModel<typeof files>;

export async function saveFile(
  insert: FileInsert,
): Promise<{ id: string; path: string } | Error> {
  try {
    const [row] = await db
      .insert(files)
      .values(insert)
      .returning({ id: files.id, path: files.path });
    if (!row) return new Error('saveFile: insert returned no row');
    return row;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * Resolve a Baileys stanzaId to our internal DB message UUID within a chat.
 * Used to set the quotedMessageId FK when persisting a reply.
 * Returns null if the quoted message is not in our DB (e.g. predates Klaus).
 */
export async function resolveQuotedMessageId(chatId: string, externalId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.chatId, chatId), eq(messages.externalId, externalId)))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Look up the first image file linked to a given message.
 * Used by pipeline.ts to attach quoted image media to the turn context.
 */
export async function resolveQuotedMessageFile(
  messageId: string,
): Promise<{ fileId: string; path: string; mimeType: string } | null> {
  const [row] = await db
    .select({ id: files.id, path: files.path, mimeType: files.mimeType })
    .from(files)
    .where(eq(files.messageId, messageId))
    .limit(1);
  return row && row.mimeType.startsWith('image/')
    ? { fileId: row.id, path: row.path, mimeType: row.mimeType }
    : null;
}

/**
 * Upsert an emoji reaction to a message. Pass an empty emoji to remove the reaction.
 * Uses messageExternalId (Baileys stanza ID) rather than a FK to messages — reactions
 * may arrive for messages that predate Klaus or before the message row is inserted.
 */
export async function persistReaction(
  chatId: string,
  messageExternalId: string,
  emoji: string,
  senderId: string,
  fromMe: boolean,
): Promise<void | Error> {
  try {
    if (!emoji) {
      await db.delete(reactions).where(
        and(
          eq(reactions.chatId, chatId),
          eq(reactions.messageExternalId, messageExternalId),
          eq(reactions.senderId, senderId),
        ),
      );
    } else {
      await db.insert(reactions)
        .values({ chatId, messageExternalId, emoji, senderId, fromMe })
        .onConflictDoUpdate({
          target: [reactions.chatId, reactions.messageExternalId, reactions.senderId],
          set: { emoji, createdAt: new Date() },
        });
    }
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

export async function updateFileMessageId(
  fileId: string,
  messageId: string,
): Promise<void | Error> {
  try {
    await db.update(files).set({ messageId }).where(eq(files.id, fileId));
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
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
    try {
      if (updated.body && tokenCount > config.chunking.thresholdTokens) {
        await syncChunks(id, updated.body);
      } else {
        await db.delete(chunks).where(eq(chunks.nodeId, id));
      }
    } catch (err) {
      log.warn('[write] chunk sync failed after upsert — chunks may be stale', {
        nodeId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return updated;
}

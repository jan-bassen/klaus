import { inArray, sql } from "drizzle-orm";
import { log } from "@/logger";
import type { Node } from "@/types";
import { db } from "./client";
import { nodes } from "./schema";
import { embedText } from "./write";

// Reciprocal Rank Fusion constant — standard IR value; higher K reduces the impact of rank differences.
const RRF_K = 60;
// Max candidates fetched from each source before fusion and final slicing.
const CANDIDATE_LIMIT = 50;

export interface SearchOptions {
	query: string;
	embedding?: number[];
	tags?: string[];
	limit?: number;
	expandEdges?: boolean;
}

export interface SearchResult {
	node: Node;
	score: number;
	matchingChunk?: string;
}

type RankedHit = { nodeId: string; chunkBody: string | null; rank: number };

async function ftsSearch(
	query: string,
	tags: string[] | undefined,
): Promise<RankedHit[]> {
	const tagFilter =
		tags && tags.length > 0
			? sql`AND n.tags && ARRAY[${sql.join(
					tags.map((t) => sql`${t}`),
					sql`, `,
				)}]::text[]`
			: sql``;

	const rows = await db.execute(sql`
    SELECT node_id, chunk_body, ROW_NUMBER() OVER (ORDER BY fts_score DESC)::int AS rank
    FROM (
      SELECT n.id AS node_id, NULL::text AS chunk_body, ts_rank(n.search_tsv, q) AS fts_score
      FROM nodes n, plainto_tsquery('english', ${query}) q
      WHERE NOT n.archived AND n.search_tsv @@ q ${tagFilter}
      UNION ALL
      SELECT n.id AS node_id, c.body AS chunk_body, ts_rank(c.search_tsv, q) AS fts_score
      FROM chunks c
      JOIN nodes n ON n.id = c.node_id, plainto_tsquery('english', ${query}) q
      WHERE NOT n.archived AND c.search_tsv @@ q ${tagFilter}
    ) t
    ORDER BY fts_score DESC
    LIMIT ${CANDIDATE_LIMIT}
  `);

	return [...rows].map((r) => {
		const row = r as {
			node_id: string;
			chunk_body: string | null;
			rank: string;
		};
		return {
			nodeId: row.node_id,
			chunkBody: row.chunk_body,
			rank: Number(row.rank),
		};
	});
}

async function vectorSearch(
	embedding: number[],
	tags: string[] | undefined,
): Promise<RankedHit[]> {
	const embStr = `[${embedding.join(",")}]`;
	const tagFilter =
		tags && tags.length > 0
			? sql`AND n.tags && ARRAY[${sql.join(
					tags.map((t) => sql`${t}`),
					sql`, `,
				)}]::text[]`
			: sql``;

	const rows = await db.execute(sql`
    SELECT node_id, chunk_body, ROW_NUMBER() OVER (ORDER BY vec_dist)::int AS rank
    FROM (
      SELECT n.id AS node_id, NULL::text AS chunk_body, n.embedding <=> ${embStr}::vector AS vec_dist
      FROM nodes n
      WHERE NOT n.archived AND n.embedding IS NOT NULL ${tagFilter}
      UNION ALL
      SELECT n.id AS node_id, c.body AS chunk_body, c.embedding <=> ${embStr}::vector AS vec_dist
      FROM chunks c
      JOIN nodes n ON n.id = c.node_id
      WHERE NOT n.archived AND c.embedding IS NOT NULL ${tagFilter}
    ) t
    ORDER BY vec_dist
    LIMIT ${CANDIDATE_LIMIT}
  `);

	return [...rows].map((r) => {
		const row = r as {
			node_id: string;
			chunk_body: string | null;
			rank: string;
		};
		return {
			nodeId: row.node_id,
			chunkBody: row.chunk_body,
			rank: Number(row.rank),
		};
	});
}

export async function hybridSearch(
	opts: SearchOptions,
): Promise<SearchResult[]> {
	const {
		query,
		embedding: providedEmbedding,
		tags,
		limit = 10,
		expandEdges = false,
	} = opts;

	let embedding: number[] | undefined = providedEmbedding;
	if (!embedding) {
		try {
			embedding = await embedText(query);
		} catch (err) {
			log.warn("[search] embedding failed — falling back to FTS only", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	const [ftsResults, vecResults] = await Promise.all([
		ftsSearch(query, tags),
		embedding ? vectorSearch(embedding, tags) : Promise.resolve([]),
	]);

	// RRF fusion: accumulate 1/(k+rank) per node across both sources
	const scoreMap = new Map<
		string,
		{ score: number; matchingChunk: string | null }
	>();

	for (const hits of [ftsResults, vecResults]) {
		for (const { nodeId, chunkBody, rank } of hits) {
			const prev = scoreMap.get(nodeId) ?? { score: 0, matchingChunk: null };
			scoreMap.set(nodeId, {
				score: prev.score + 1 / (RRF_K + rank),
				matchingChunk: prev.matchingChunk ?? chunkBody,
			});
		}
	}

	const topEntries = [...scoreMap.entries()]
		.sort((a, b) => b[1].score - a[1].score)
		.slice(0, limit);

	if (topEntries.length === 0) return [];

	const topIds = topEntries.map(([id]) => id);
	let nodeRows = await db.select().from(nodes).where(inArray(nodes.id, topIds));

	if (expandEdges && nodeRows.length > 0) {
		const idArray = sql`ARRAY[${sql.join(
			topIds.map((id) => sql`${id}`),
			sql`, `,
		)}]::uuid[]`;
		const neighborRows = await db.execute(sql`
      SELECT DISTINCT
        CASE WHEN source_id = ANY(${idArray}) THEN target_id ELSE source_id END AS id
      FROM edges
      WHERE source_id = ANY(${idArray}) OR target_id = ANY(${idArray})
    `);

		const existingIds = new Set(topIds);
		const newIds = [...neighborRows]
			.map((r) => (r as { id: string }).id)
			.filter((id) => !existingIds.has(id));

		if (newIds.length > 0) {
			const extra = await db
				.select()
				.from(nodes)
				.where(inArray(nodes.id, newIds));
			nodeRows = [...nodeRows, ...extra];
		}
	}

	const nodeMap = new Map(nodeRows.map((n) => [n.id, n]));

	return topEntries
		.filter(([id]) => nodeMap.has(id))
		.map(
			([id, { score, matchingChunk }]): SearchResult => ({
				node: nodeMap.get(id) as Node,
				score,
				...(matchingChunk != null ? { matchingChunk } : {}),
			}),
		);
}

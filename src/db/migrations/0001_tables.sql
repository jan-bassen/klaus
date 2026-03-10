CREATE TYPE "public"."cost_service" AS ENUM('tts', 'embed', 'stt', 'llm');--> statement-breakpoint
CREATE TYPE "public"."edge_relation_type" AS ENUM('about', 'part_of', 'derived_from', 'influenced_by', 'references', 'supersedes', 'related_to');--> statement-breakpoint
CREATE TYPE "public"."node_type" AS ENUM('episode', 'procedure', 'topic', 'document', 'project', 'entity', 'assertion');--> statement-breakpoint
CREATE TYPE "public"."node_version_reason" AS ENUM('user_edit', 'contradiction_resolved', 'merged', 'reflection');--> statement-breakpoint
CREATE TYPE "public"."provenance_source_type" AS ENUM('message', 'task', 'external');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('pending', 'running', 'done', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" text NOT NULL,
	"daily_limit_usd" numeric(10, 2),
	"monthly_limit_usd" numeric(10, 2),
	"current_daily_usd" numeric(10, 6) DEFAULT '0',
	"current_monthly_usd" numeric(10, 6) DEFAULT '0',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_budgets_chat" UNIQUE("chat_id")
);
--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"body" text NOT NULL,
	"embedding" vector(1024),
	"search_tsv" "tsvector",
	"token_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "costs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" text,
	"service" "cost_service" NOT NULL,
	"units" integer NOT NULL,
	"cost_usd" numeric(10, 6) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"relation" "edge_relation_type" NOT NULL,
	"weight" real DEFAULT 1,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edges_source_id_target_id_relation_unique" UNIQUE("source_id","target_id","relation")
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"path" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"message_id" uuid,
	"node_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid,
	"task_id" uuid,
	"agent" text NOT NULL,
	"model" text NOT NULL,
	"system_prompt" text,
	"user_message" text,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"external_id" text,
	"quoted_message_id" uuid
);
--> statement-breakpoint
CREATE TABLE "node_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"title" text,
	"body" text,
	"tags" text[],
	"reason" "node_version_reason" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "node_versions_node_id_version_unique" UNIQUE("node_id","version")
);
--> statement-breakpoint
CREATE TABLE "nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "node_type" NOT NULL,
	"title" text,
	"body" text,
	"tags" text[] DEFAULT '{}'::text[],
	"pinned" boolean DEFAULT false NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"embedding" vector(1024),
	"search_tsv" "tsvector",
	"token_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provenance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"source_type" "provenance_source_type" NOT NULL,
	"source_id" uuid,
	"source_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" text NOT NULL,
	"message_external_id" text NOT NULL,
	"emoji" text NOT NULL,
	"sender_id" text NOT NULL,
	"from_me" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_reactions_sender_msg" UNIQUE("chat_id","message_external_id","sender_id")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" text NOT NULL,
	"objective" text NOT NULL,
	"assigned_to" text,
	"caller" text,
	"status" "task_status" NOT NULL,
	"result" jsonb,
	"parent_task_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_source_id_nodes_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_target_id_nodes_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invocations" ADD CONSTRAINT "invocations_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invocations" ADD CONSTRAINT "invocations_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_quoted_message_id_messages_id_fk" FOREIGN KEY ("quoted_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_versions" ADD CONSTRAINT "node_versions_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provenance" ADD CONSTRAINT "provenance_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_task_id_tasks_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_costs_created" ON "costs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_edges_source" ON "edges" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "idx_edges_target" ON "edges" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "idx_edges_relation" ON "edges" USING btree ("relation");--> statement-breakpoint
CREATE INDEX "idx_files_message" ON "files" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "idx_files_node" ON "files" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "idx_invocations_message" ON "invocations" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "idx_messages_chat_time" ON "messages" USING btree ("chat_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_messages_external" ON "messages" USING btree ("chat_id","external_id");--> statement-breakpoint
CREATE INDEX "idx_node_versions_node" ON "node_versions" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "idx_provenance_node" ON "provenance" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "idx_provenance_source" ON "provenance" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "idx_reactions_chat_msg" ON "reactions" USING btree ("chat_id","message_external_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_chat" ON "tasks" USING btree ("chat_id");
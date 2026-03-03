CREATE TABLE "agent_invocations" (
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
ALTER TABLE "agent_invocations" ADD CONSTRAINT "agent_invocations_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_invocations" ADD CONSTRAINT "agent_invocations_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_invocations_message" ON "agent_invocations" USING btree ("message_id");
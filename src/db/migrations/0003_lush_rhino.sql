DROP TABLE "llm_costs" CASCADE;--> statement-breakpoint
ALTER TABLE "agent_invocations" ADD COLUMN "cost_usd" numeric(10, 6);--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "tool_calls";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "tokens_used";
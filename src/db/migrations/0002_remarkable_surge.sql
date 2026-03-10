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
CREATE INDEX "idx_reactions_chat_msg" ON "reactions" USING btree ("chat_id","message_external_id");
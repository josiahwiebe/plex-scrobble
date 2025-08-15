ALTER TABLE "users" ADD COLUMN "webhook_token" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_webhook_token_unique" UNIQUE("webhook_token");
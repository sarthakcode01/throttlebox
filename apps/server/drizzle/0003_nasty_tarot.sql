CREATE TABLE "plans" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"requests_per_window" integer NOT NULL,
	"window_seconds" integer NOT NULL,
	"burst_allowance" numeric(3, 2) DEFAULT '1.00' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
INSERT INTO "plans" ("id", "name", "requests_per_window", "window_seconds", "burst_allowance")
VALUES
  ('free', 'Free', 100, 3600, 1.00),
  ('pro', 'Pro', 5000, 3600, 1.20)
ON CONFLICT ("id") DO NOTHING;

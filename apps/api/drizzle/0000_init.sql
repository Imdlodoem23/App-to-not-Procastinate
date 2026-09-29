CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accountability_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"client_ref" text NOT NULL,
	"kind" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approval_status" text,
	"approval_deadline" timestamp with time zone,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"note" text,
	CONSTRAINT "accountability_events_kind" CHECK (kind IN ('emergency_requested', 'emergency_confirmed', 'emergency_cancelled', 'study_abandoned', 'punishment_started')),
	CONSTRAINT "accountability_events_approval" CHECK (("accountability_events"."approval_status" IS NULL) = ("accountability_events"."approval_deadline" IS NULL)),
	CONSTRAINT "accountability_events_status" CHECK ("accountability_events"."approval_status" IS NULL OR "accountability_events"."approval_status" IN ('pending', 'approved', 'denied')),
	CONSTRAINT "accountability_events_note" CHECK ("accountability_events"."note" IS NULL OR char_length("accountability_events"."note") <= 140)
);
--> statement-breakpoint
CREATE TABLE "ai_global_daily" (
	"day" date PRIMARY KEY NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"cost_micro_usd" bigint DEFAULT 0 NOT NULL,
	"reserved_micro_usd" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_identity_daily" (
	"day" date NOT NULL,
	"identity_hmac" text NOT NULL,
	"feature" text NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"tokens" bigint DEFAULT 0 NOT NULL,
	"cost_micro_usd" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "ai_identity_daily_pk" PRIMARY KEY("day","identity_hmac","feature"),
	CONSTRAINT "ai_identity_daily_feature" CHECK ("ai_identity_daily"."feature" IN ('interpret', 'coach'))
);
--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"user_id" text NOT NULL,
	"day" date NOT NULL,
	"feature" text NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"reserved_tokens" bigint DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_micro_usd" bigint DEFAULT 0 NOT NULL,
	"reserved_micro_usd" bigint DEFAULT 0 NOT NULL,
	"reserved_until" timestamp with time zone,
	CONSTRAINT "ai_usage_pk" PRIMARY KEY("user_id","day","feature"),
	CONSTRAINT "ai_usage_feature" CHECK ("ai_usage"."feature" IN ('interpret', 'coach'))
);
--> statement-breakpoint
CREATE TABLE "app_auth_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"challenge" text NOT NULL,
	"port" integer NOT NULL,
	"authenticated_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_auth_codes_port" CHECK ("app_auth_codes"."port" BETWEEN 1024 AND 65535)
);
--> statement-breakpoint
CREATE TABLE "daily_stats" (
	"device_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"day" date NOT NULL,
	"rev" bigint NOT NULL,
	"focus_minutes" integer NOT NULL,
	"study_minutes" integer NOT NULL,
	"blocks_completed" integer NOT NULL,
	"study_sessions" integer NOT NULL,
	"attempts" integer NOT NULL,
	"emergency_unlocks" integer NOT NULL,
	"punishments" integer NOT NULL,
	"points_earned" integer NOT NULL,
	"points_lost" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_stats_pk" PRIMARY KEY("device_id","day"),
	CONSTRAINT "daily_stats_rev" CHECK ("daily_stats"."rev" >= 0),
	CONSTRAINT "daily_stats_focus" CHECK ("daily_stats"."focus_minutes" BETWEEN 0 AND 1440),
	CONSTRAINT "daily_stats_study" CHECK ("daily_stats"."study_minutes" BETWEEN 0 AND "daily_stats"."focus_minutes"),
	CONSTRAINT "daily_stats_blocks" CHECK ("daily_stats"."blocks_completed" BETWEEN 0 AND 10000),
	CONSTRAINT "daily_stats_sessions" CHECK ("daily_stats"."study_sessions" BETWEEN 0 AND 10000),
	CONSTRAINT "daily_stats_attempts" CHECK ("daily_stats"."attempts" BETWEEN 0 AND 10000),
	CONSTRAINT "daily_stats_emergencies" CHECK ("daily_stats"."emergency_unlocks" BETWEEN 0 AND 10000),
	CONSTRAINT "daily_stats_punishments" CHECK ("daily_stats"."punishments" BETWEEN 0 AND 10000),
	CONSTRAINT "daily_stats_points_earned" CHECK ("daily_stats"."points_earned" BETWEEN 0 AND 100000),
	CONSTRAINT "daily_stats_points_lost" CHECK ("daily_stats"."points_lost" BETWEEN 0 AND 100000)
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"install_id" text NOT NULL,
	"session_id" text,
	"name" text NOT NULL,
	"platform" text NOT NULL,
	"app_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sync_at" timestamp with time zone,
	CONSTRAINT "devices_platform" CHECK ("devices"."platform" IN ('win', 'mac', 'linux'))
);
--> statement-breakpoint
CREATE TABLE "friend_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inviter_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"max_uses" smallint DEFAULT 1 NOT NULL,
	"uses" smallint DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "friend_invites_code_hash_unique" UNIQUE("code_hash"),
	CONSTRAINT "friend_invites_uses" CHECK ("friend_invites"."max_uses" BETWEEN 1 AND 10 AND "friend_invites"."uses" BETWEEN 0 AND "friend_invites"."max_uses")
);
--> statement-breakpoint
CREATE TABLE "friendships" (
	"user_id" text NOT NULL,
	"friend_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "friendships_pk" PRIMARY KEY("user_id","friend_id"),
	CONSTRAINT "friendships_not_self" CHECK ("friendships"."user_id" <> "friendships"."friend_id")
);
--> statement-breakpoint
CREATE TABLE "meta" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"partner_id" text NOT NULL,
	"status" text NOT NULL,
	"require_approval" boolean DEFAULT false NOT NULL,
	"approval_off_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	CONSTRAINT "partner_links_not_self" CHECK ("partner_links"."owner_id" <> "partner_links"."partner_id"),
	CONSTRAINT "partner_links_status" CHECK ("partner_links"."status" IN ('pending', 'active'))
);
--> statement-breakpoint
CREATE TABLE "presence" (
	"user_id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"since" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "presence_state" CHECK ("presence"."state" IN ('focus', 'study'))
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"user_id" text PRIMARY KEY NOT NULL,
	"display_name" text,
	"time_zone" text DEFAULT 'Europe/Madrid' NOT NULL,
	"daily_goal_minutes" smallint,
	"share_sync" boolean DEFAULT false NOT NULL,
	"share_ranking" boolean DEFAULT false NOT NULL,
	"share_presence" boolean DEFAULT false NOT NULL,
	"partner_emails" boolean DEFAULT false NOT NULL,
	"coach_enabled" boolean DEFAULT false NOT NULL,
	"consent_updated_at" timestamp with time zone,
	"ranking_since" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profiles_goal_range" CHECK ("profiles"."daily_goal_minutes" IS NULL OR "profiles"."daily_goal_minutes" BETWEEN 15 AND 600),
	CONSTRAINT "profiles_ranking_needs_sync" CHECK (NOT "profiles"."share_ranking" OR "profiles"."share_sync"),
	CONSTRAINT "profiles_ranking_since" CHECK ("profiles"."share_ranking" = ("profiles"."ranking_since" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "rate_counters" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "rate_counters_pk" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"authenticated_at" timestamp with time zone,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "usage_counters" (
	"user_id" text NOT NULL,
	"day" date NOT NULL,
	"key" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_counters_pk" PRIMARY KEY("user_id","day","key")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "user_blocks" (
	"blocker_id" text NOT NULL,
	"blocked_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_blocks_pk" PRIMARY KEY("blocker_id","blocked_id"),
	CONSTRAINT "user_blocks_not_self" CHECK ("user_blocks"."blocker_id" <> "user_blocks"."blocked_id")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accountability_events" ADD CONSTRAINT "accountability_events_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accountability_events" ADD CONSTRAINT "accountability_events_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_auth_codes" ADD CONSTRAINT "app_auth_codes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_stats" ADD CONSTRAINT "daily_stats_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_stats" ADD CONSTRAINT "daily_stats_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friend_invites" ADD CONSTRAINT "friend_invites_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_friend_id_user_id_fk" FOREIGN KEY ("friend_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_links" ADD CONSTRAINT "partner_links_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_links" ADD CONSTRAINT "partner_links_partner_id_user_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presence" ADD CONSTRAINT "presence_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_blocker_id_user_id_fk" FOREIGN KEY ("blocker_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_blocked_id_user_id_fk" FOREIGN KEY ("blocked_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accountability_events_owner_ref_uq" ON "accountability_events" USING btree ("owner_id","client_ref");--> statement-breakpoint
CREATE INDEX "accountability_events_owner_created_idx" ON "accountability_events" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "accountability_events_created_idx" ON "accountability_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ai_usage_day_idx" ON "ai_usage" USING btree ("day");--> statement-breakpoint
CREATE INDEX "app_auth_codes_expires_idx" ON "app_auth_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "daily_stats_user_day_idx" ON "daily_stats" USING btree ("user_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "devices_user_install_uq" ON "devices" USING btree ("user_id","install_id");--> statement-breakpoint
CREATE INDEX "devices_session_id_idx" ON "devices" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "friend_invites_inviter_idx" ON "friend_invites" USING btree ("inviter_id");--> statement-breakpoint
CREATE INDEX "friend_invites_expires_idx" ON "friend_invites" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "friendships_friend_idx" ON "friendships" USING btree ("friend_id");--> statement-breakpoint
CREATE UNIQUE INDEX "partner_links_owner_partner_uq" ON "partner_links" USING btree ("owner_id","partner_id");--> statement-breakpoint
CREATE INDEX "partner_links_partner_idx" ON "partner_links" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "presence_expires_idx" ON "presence" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "rate_counters_expires_idx" ON "rate_counters" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_blocks_blocked_idx" ON "user_blocks" USING btree ("blocked_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");
-- Phase 2 authentication persistence for Better Auth 1.7.6.
-- Auth/session rows are intentionally deletable: revocation is a physical delete.
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_accounts_provider_account" UNIQUE("provider_id","account_id"),
	CONSTRAINT "ck_accounts_credential_password" CHECK ("accounts"."provider_id" <> 'credential' OR "accounts"."password" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "activation_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_activation_invitations_token_hash" UNIQUE("token_hash"),
	CONSTRAINT "ck_activation_token_hash" CHECK ("activation_invitations"."token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "email_change_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"new_email" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"requested_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_email_change_token_hash" UNIQUE("token_hash"),
	CONSTRAINT "ck_email_change_email_normalized" CHECK ("email_change_requests"."new_email" = lower(btrim("email_change_requests"."new_email"))),
	CONSTRAINT "ck_email_change_token_hash" CHECK ("email_change_requests"."token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "passkeys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text,
	"public_key" text NOT NULL,
	"user_id" uuid NOT NULL,
	"credential_id" text NOT NULL,
	"counter" integer NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"transports" text,
	"aaguid" text,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "uq_passkeys_credential_id" UNIQUE("credential_id")
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "uq_rate_limits_key" UNIQUE("key"),
	CONSTRAINT "ck_rate_limits_count" CHECK ("rate_limits"."count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"auth_method" text DEFAULT 'password' NOT NULL,
	"recent_auth_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_sessions_token" UNIQUE("token"),
	CONSTRAINT "ck_sessions_auth_method" CHECK ("sessions"."auth_method" IN ('password', 'passkey'))
);
--> statement-breakpoint
CREATE TABLE "two_factors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" uuid NOT NULL,
	"verified" boolean DEFAULT true NOT NULL,
	"failed_verification_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	CONSTRAINT "uq_two_factors_user_id" UNIQUE("user_id"),
	CONSTRAINT "ck_two_factors_failed_count" CHECK ("two_factors"."failed_verification_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "two_factor_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "fk_accounts_user_id" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "activation_invitations" ADD CONSTRAINT "fk_activation_invitations_user_id" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "activation_invitations" ADD CONSTRAINT "fk_activation_invitations_created_by" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "email_change_requests" ADD CONSTRAINT "fk_email_change_user" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "email_change_requests" ADD CONSTRAINT "fk_email_change_actor" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "passkeys" ADD CONSTRAINT "fk_passkeys_user_id" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "fk_sessions_user_id" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "two_factors" ADD CONSTRAINT "fk_two_factors_user_id" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "ix_accounts_user_id" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_activation_invitations_user_id" ON "activation_invitations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_activation_invitations_expires_at" ON "activation_invitations" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_activation_invitations_live_user" ON "activation_invitations" USING btree ("user_id") WHERE "activation_invitations"."used_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_email_change_live_user" ON "email_change_requests" USING btree ("user_id") WHERE "email_change_requests"."used_at" IS NULL;--> statement-breakpoint
CREATE INDEX "ix_email_change_expires_at" ON "email_change_requests" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "ix_passkeys_user_id" ON "passkeys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_sessions_user_id" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_sessions_expires_at" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "ix_two_factors_secret" ON "two_factors" USING btree ("secret");--> statement-breakpoint
CREATE INDEX "ix_verifications_identifier" ON "verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "ix_verifications_expires_at" ON "verifications" USING btree ("expires_at");

-- Final integrity layer for concurrent last-admin transitions. The advisory lock
-- serializes otherwise write-skew-prone deactivate/demote operations.
CREATE FUNCTION public.fn_preserve_last_active_admin() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE old_is_admin boolean; new_is_admin boolean; other_count integer;
BEGIN
  SELECT (code = 'ADMIN') INTO old_is_admin FROM public.roles WHERE id = OLD.role_id;
  SELECT (code = 'ADMIN') INTO new_is_admin FROM public.roles WHERE id = NEW.role_id;
  IF old_is_admin AND OLD.status = 'ACTIVE' AND (NOT new_is_admin OR NEW.status <> 'ACTIVE') THEN
    PERFORM pg_advisory_xact_lock(hashtext('disetech:active-admin'));
    SELECT count(*) INTO other_count FROM public.users u JOIN public.roles r ON r.id=u.role_id
      WHERE r.code='ADMIN' AND u.status='ACTIVE' AND u.id <> OLD.id;
    IF other_count = 0 THEN
      RAISE EXCEPTION 'users: cannot remove the last active admin' USING ERRCODE='DTA01';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER trg_users_preserve_last_admin
BEFORE UPDATE OF role_id, status ON public.users
FOR EACH ROW EXECUTE FUNCTION public.fn_preserve_last_active_admin();

CREATE TYPE "public"."role_code" AS ENUM('ADMIN', 'SELLER', 'COMMERCIAL_MANAGER', 'ADMINISTRATIVE_MANAGER');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('PENDING_ACTIVATION', 'ACTIVE', 'INACTIVE');--> statement-breakpoint
CREATE TYPE "public"."catalog_review_status" AS ENUM('PENDING_REVIEW', 'APPROVED', 'REJECTED', 'MERGED');--> statement-breakpoint
CREATE TYPE "public"."customer_status" AS ENUM('ACTIVE', 'INACTIVE');--> statement-breakpoint
CREATE TYPE "public"."identification_type" AS ENUM('FISICA', 'JURIDICA', 'DIMEX', 'NITE', 'PASAPORTE');--> statement-breakpoint
CREATE TYPE "public"."currency_code" AS ENUM('CRC', 'USD');--> statement-breakpoint
CREATE TYPE "public"."exchange_rate_source" AS ENUM('BCCR', 'MANUAL');--> statement-breakpoint
CREATE TYPE "public"."quotation_review_outcome" AS ENUM('APPROVED', 'REJECTED', 'CHANGES_REQUESTED');--> statement-breakpoint
CREATE TYPE "public"."quotation_revision_state" AS ENUM('DRAFT', 'ISSUED');--> statement-breakpoint
CREATE TYPE "public"."audit_actor_type" AS ENUM('USER', 'SYSTEM', 'ANONYMOUS');--> statement-breakpoint
CREATE TYPE "public"."audit_result" AS ENUM('SUCCESS', 'FAILURE', 'DENIED');--> statement-breakpoint
CREATE TYPE "public"."generated_document_kind" AS ENUM('QUOTATION_PDF');--> statement-breakpoint
CREATE TABLE "permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_permissions_code" UNIQUE("code"),
	CONSTRAINT "ck_permissions_code_format" CHECK ("permissions"."code" ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*[.][a-z][a-z0-9]*(_[a-z0-9]+)*$')
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" uuid NOT NULL,
	"permission_id" uuid NOT NULL,
	CONSTRAINT "pk_role_permissions" PRIMARY KEY("role_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" "role_code" NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_roles_code" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"full_name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"phone" varchar(20) NOT NULL,
	"role_id" uuid NOT NULL,
	"status" "user_status" DEFAULT 'PENDING_ACTIVATION' NOT NULL,
	"activated_at" timestamp with time zone,
	"deactivated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "uq_users_email" UNIQUE("email"),
	CONSTRAINT "ck_users_email_normalized" CHECK ("users"."email" = lower(btrim("users"."email"))),
	CONSTRAINT "ck_users_status_coherence" CHECK (("users"."status" = 'PENDING_ACTIVATION' AND "users"."activated_at" IS NULL AND "users"."deactivated_at" IS NULL)
        OR ("users"."status" = 'ACTIVE' AND "users"."activated_at" IS NOT NULL AND "users"."deactivated_at" IS NULL)
        OR ("users"."status" = 'INACTIVE' AND "users"."deactivated_at" IS NOT NULL
            AND ("users"."activated_at" IS NULL OR "users"."deactivated_at" >= "users"."activated_at")))
);
--> statement-breakpoint
CREATE TABLE "catalog_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category_id" uuid,
	"cabys_code" text,
	"unit" text,
	"status" "catalog_review_status" DEFAULT 'PENDING_REVIEW' NOT NULL,
	"merged_into_id" uuid,
	"proposed_by_user_id" uuid NOT NULL,
	"reviewed_by_user_id" uuid,
	"reviewed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_catalog_items_no_self_merge" CHECK ("catalog_items"."merged_into_id" IS NULL OR "catalog_items"."merged_into_id" <> "catalog_items"."id"),
	CONSTRAINT "ck_catalog_items_merge_coherence" CHECK (("catalog_items"."status" = 'MERGED' AND "catalog_items"."merged_into_id" IS NOT NULL)
        OR ("catalog_items"."status" <> 'MERGED' AND "catalog_items"."merged_into_id" IS NULL)),
	CONSTRAINT "ck_catalog_items_review_coherence" CHECK (("catalog_items"."status" = 'PENDING_REVIEW' AND "catalog_items"."reviewed_by_user_id" IS NULL AND "catalog_items"."reviewed_at" IS NULL)
        OR ("catalog_items"."status" <> 'PENDING_REVIEW' AND "catalog_items"."reviewed_by_user_id" IS NOT NULL AND "catalog_items"."reviewed_at" IS NOT NULL)),
	CONSTRAINT "ck_catalog_items_cabys_format" CHECK ("catalog_items"."cabys_code" IS NULL OR "catalog_items"."cabys_code" ~ '^[0-9]{13}$')
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"department" text,
	"email" text,
	"phone" text,
	"extension" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"full_name" text NOT NULL,
	"email" text NOT NULL,
	"identification_type" "identification_type",
	"identification_number" text,
	"phone" text,
	"economic_activity_cabys" text,
	"address" text,
	"notes" text,
	"created_by_user_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"status" "customer_status" DEFAULT 'ACTIVE' NOT NULL,
	"deactivated_at" timestamp with time zone,
	"deactivated_by_user_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_customers_identification_both_or_neither" CHECK (("customers"."identification_type" IS NULL) = ("customers"."identification_number" IS NULL)),
	CONSTRAINT "ck_customers_identification_format" CHECK (("customers"."identification_type" IS DISTINCT FROM 'FISICA'    OR "customers"."identification_number" ~ '^[0-9]{9}$')
        AND ("customers"."identification_type" IS DISTINCT FROM 'JURIDICA'  OR "customers"."identification_number" ~ '^[0-9]{10}$')
        AND ("customers"."identification_type" IS DISTINCT FROM 'DIMEX'     OR "customers"."identification_number" ~ '^[0-9]{11,12}$')
        AND ("customers"."identification_type" IS DISTINCT FROM 'NITE'      OR "customers"."identification_number" ~ '^[0-9]{9,10}$')
        AND ("customers"."identification_type" IS DISTINCT FROM 'PASAPORTE' OR length("customers"."identification_number") BETWEEN 3 AND 20)),
	CONSTRAINT "ck_customers_email_normalized" CHECK ("customers"."email" = lower(btrim("customers"."email"))),
	CONSTRAINT "ck_customers_cabys_format" CHECK ("customers"."economic_activity_cabys" IS NULL OR "customers"."economic_activity_cabys" ~ '^[0-9]{13}$'),
	CONSTRAINT "ck_customers_status_coherence" CHECK (("customers"."status" = 'ACTIVE' AND "customers"."deactivated_at" IS NULL AND "customers"."deactivated_by_user_id" IS NULL)
        OR ("customers"."status" = 'INACTIVE' AND "customers"."deactivated_at" IS NOT NULL AND "customers"."deactivated_by_user_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legal_name" text NOT NULL,
	"commercial_name" text,
	"identification_type" "identification_type",
	"identification_number" text,
	"phone" text,
	"email" text,
	"address" text,
	"contact_name" text,
	"notes" text,
	"status" "catalog_review_status" DEFAULT 'PENDING_REVIEW' NOT NULL,
	"merged_into_id" uuid,
	"proposed_by_user_id" uuid NOT NULL,
	"reviewed_by_user_id" uuid,
	"reviewed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_providers_no_self_merge" CHECK ("providers"."merged_into_id" IS NULL OR "providers"."merged_into_id" <> "providers"."id"),
	CONSTRAINT "ck_providers_merge_coherence" CHECK (("providers"."status" = 'MERGED' AND "providers"."merged_into_id" IS NOT NULL)
        OR ("providers"."status" <> 'MERGED' AND "providers"."merged_into_id" IS NULL)),
	CONSTRAINT "ck_providers_review_coherence" CHECK (("providers"."status" = 'PENDING_REVIEW' AND "providers"."reviewed_by_user_id" IS NULL AND "providers"."reviewed_at" IS NULL)
        OR ("providers"."status" <> 'PENDING_REVIEW' AND "providers"."reviewed_by_user_id" IS NOT NULL AND "providers"."reviewed_at" IS NOT NULL)),
	CONSTRAINT "ck_providers_identification_both_or_neither" CHECK (("providers"."identification_type" IS NULL) = ("providers"."identification_number" IS NULL)),
	CONSTRAINT "ck_providers_identification_format" CHECK (("providers"."identification_type" IS DISTINCT FROM 'FISICA'    OR "providers"."identification_number" ~ '^[0-9]{9}$')
        AND ("providers"."identification_type" IS DISTINCT FROM 'JURIDICA'  OR "providers"."identification_number" ~ '^[0-9]{10}$')
        AND ("providers"."identification_type" IS DISTINCT FROM 'DIMEX'     OR "providers"."identification_number" ~ '^[0-9]{11,12}$')
        AND ("providers"."identification_type" IS DISTINCT FROM 'NITE'      OR "providers"."identification_number" ~ '^[0-9]{9,10}$')
        AND ("providers"."identification_type" IS DISTINCT FROM 'PASAPORTE' OR length("providers"."identification_number") BETWEEN 3 AND 20))
);
--> statement-breakpoint
CREATE TABLE "exchange_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"base_currency" text DEFAULT 'USD' NOT NULL,
	"quote_currency" text DEFAULT 'CRC' NOT NULL,
	"rate_date" date NOT NULL,
	"source" "exchange_rate_source" NOT NULL,
	"buy_rate" numeric(14, 6) NOT NULL,
	"sell_rate" numeric(14, 6) NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"supersedes_id" uuid,
	CONSTRAINT "uq_exchange_rates_id_rate_date" UNIQUE("id","rate_date"),
	CONSTRAINT "uq_exchange_rates_supersedes_id" UNIQUE("supersedes_id"),
	CONSTRAINT "ck_exchange_rates_pair_v1" CHECK ("exchange_rates"."base_currency" = 'USD' AND "exchange_rates"."quote_currency" = 'CRC'),
	CONSTRAINT "ck_exchange_rates_positive" CHECK ("exchange_rates"."buy_rate" > 0 AND "exchange_rates"."sell_rate" > 0),
	CONSTRAINT "ck_exchange_rates_sell_gte_buy" CHECK ("exchange_rates"."sell_rate" >= "exchange_rates"."buy_rate"),
	CONSTRAINT "ck_exchange_rates_manual_creator" CHECK (("exchange_rates"."source" = 'MANUAL' AND "exchange_rates"."created_by_user_id" IS NOT NULL) OR ("exchange_rates"."source" = 'BCCR' AND "exchange_rates"."created_by_user_id" IS NULL)),
	CONSTRAINT "ck_exchange_rates_rates_not_nan" CHECK ("exchange_rates"."buy_rate" <> 'NaN' AND "exchange_rates"."sell_rate" <> 'NaN'),
	CONSTRAINT "ck_exchange_rates_supersedes_manual" CHECK ("exchange_rates"."supersedes_id" IS NULL OR "exchange_rates"."source" = 'MANUAL'),
	CONSTRAINT "ck_exchange_rates_supersedes_not_self" CHECK ("exchange_rates"."supersedes_id" IS NULL OR "exchange_rates"."supersedes_id" <> "exchange_rates"."id")
);
--> statement-breakpoint
CREATE TABLE "quotation_folio_counters" (
	"folio_year" smallint PRIMARY KEY NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ck_quotation_folio_counters_non_negative" CHECK ("quotation_folio_counters"."last_number" >= 0),
	CONSTRAINT "ck_quotation_folio_counters_year_range" CHECK ("quotation_folio_counters"."folio_year" BETWEEN 2000 AND 9999)
);
--> statement-breakpoint
CREATE TABLE "quotation_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quotation_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"catalog_item_id" uuid,
	"provider_id" uuid,
	"item_name" text NOT NULL,
	"item_description" text,
	"unit" text,
	"provider_name_snapshot" text,
	"quantity" numeric(18, 6) NOT NULL,
	"unit_cost" numeric(20, 6) NOT NULL,
	"cost_currency" "currency_code" NOT NULL,
	"margin_percent" numeric(9, 6) NOT NULL,
	"unit_price" numeric(20, 6) NOT NULL,
	"subtotal" numeric GENERATED ALWAYS AS (quantity * unit_price) STORED NOT NULL,
	"tax_percent" numeric(9, 6) DEFAULT '13' NOT NULL,
	"tax_amount" numeric GENERATED ALWAYS AS (quantity * unit_price * tax_percent / 100) STORED NOT NULL,
	"total" numeric GENERATED ALWAYS AS (quantity * unit_price + quantity * unit_price * tax_percent / 100) STORED NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_quotation_items_revision_line" UNIQUE("revision_id","line_number"),
	CONSTRAINT "ck_quotation_items_line_number_positive" CHECK ("quotation_items"."line_number" > 0),
	CONSTRAINT "ck_quotation_items_quantity_positive" CHECK ("quotation_items"."quantity" > 0 AND "quotation_items"."quantity" <> 'NaN'),
	CONSTRAINT "ck_quotation_items_unit_cost_non_negative" CHECK ("quotation_items"."unit_cost" >= 0 AND "quotation_items"."unit_cost" <> 'NaN'),
	CONSTRAINT "ck_quotation_items_margin_range" CHECK ("quotation_items"."margin_percent" > 0 AND "quotation_items"."margin_percent" <= 100 AND "quotation_items"."margin_percent" <> 'NaN'),
	CONSTRAINT "ck_quotation_items_unit_price_non_negative" CHECK ("quotation_items"."unit_price" >= 0 AND "quotation_items"."unit_price" <> 'NaN'),
	CONSTRAINT "ck_quotation_items_tax_percent_v1" CHECK ("quotation_items"."tax_percent" = 13 AND "quotation_items"."tax_percent" <> 'NaN'),
	CONSTRAINT "ck_quotation_items_provider_snapshot" CHECK ("quotation_items"."provider_id" IS NULL OR "quotation_items"."provider_name_snapshot" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "quotation_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quotation_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"revision_version" integer NOT NULL,
	"reviewer_user_id" uuid NOT NULL,
	"outcome" "quotation_review_outcome" NOT NULL,
	"comment" text,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotation_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quotation_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"state" "quotation_revision_state" DEFAULT 'DRAFT' NOT NULL,
	"currency" "currency_code" NOT NULL,
	"exchange_rate_id" uuid,
	"fx_buy" numeric(14, 6),
	"fx_sell" numeric(14, 6),
	"fx_rate_date" date,
	"fx_source" "exchange_rate_source",
	"fx_applied_rate" numeric(14, 6),
	"customer_name" text NOT NULL,
	"customer_identification" text,
	"customer_email" text NOT NULL,
	"customer_phone" text,
	"customer_address" text,
	"customer_contact_name" text,
	"customer_contact_phone" text,
	"customer_contact_email" text,
	"customer_contact_department" text,
	"customer_contact_extension" text,
	"seller_user_id" uuid NOT NULL,
	"seller_name" text NOT NULL,
	"seller_email" text NOT NULL,
	"seller_phone" text NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"issued_by_user_id" uuid,
	"subtotal" numeric,
	"tax_total" numeric,
	"total" numeric,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"issued_at" timestamp with time zone,
	CONSTRAINT "uq_quotation_revisions_quotation_id_id" UNIQUE("quotation_id","id"),
	CONSTRAINT "uq_quotation_revisions_number" UNIQUE("quotation_id","revision_number"),
	CONSTRAINT "ck_quotation_revisions_number_positive" CHECK ("quotation_revisions"."revision_number" > 0),
	CONSTRAINT "ck_quotation_revisions_issued_coherence" CHECK (("quotation_revisions"."state" = 'DRAFT' AND "quotation_revisions"."issued_at" IS NULL AND "quotation_revisions"."issued_by_user_id" IS NULL)
        OR ("quotation_revisions"."state" = 'ISSUED' AND "quotation_revisions"."issued_at" IS NOT NULL AND "quotation_revisions"."issued_by_user_id" IS NOT NULL)),
	CONSTRAINT "ck_quotation_revisions_fx_coherence" CHECK (("quotation_revisions"."fx_buy" IS NULL AND "quotation_revisions"."fx_sell" IS NULL AND "quotation_revisions"."fx_rate_date" IS NULL AND "quotation_revisions"."fx_source" IS NULL AND "quotation_revisions"."exchange_rate_id" IS NULL)
        OR ("quotation_revisions"."fx_buy" IS NOT NULL AND "quotation_revisions"."fx_sell" IS NOT NULL AND "quotation_revisions"."fx_rate_date" IS NOT NULL AND "quotation_revisions"."fx_source" IS NOT NULL AND "quotation_revisions"."exchange_rate_id" IS NOT NULL)),
	CONSTRAINT "ck_quotation_revisions_fx_applied_rate_requires_exchange_rate" CHECK ("quotation_revisions"."fx_applied_rate" IS NULL OR "quotation_revisions"."exchange_rate_id" IS NOT NULL),
	CONSTRAINT "ck_quotation_revisions_fx_values_positive" CHECK (("quotation_revisions"."fx_buy" IS NULL OR ("quotation_revisions"."fx_buy" > 0 AND "quotation_revisions"."fx_buy" <> 'NaN'))
        AND ("quotation_revisions"."fx_sell" IS NULL OR ("quotation_revisions"."fx_sell" > 0 AND "quotation_revisions"."fx_sell" <> 'NaN'))
        AND ("quotation_revisions"."fx_applied_rate" IS NULL OR ("quotation_revisions"."fx_applied_rate" > 0 AND "quotation_revisions"."fx_applied_rate" <> 'NaN'))),
	CONSTRAINT "ck_quotation_revisions_totals_coherence" CHECK (("quotation_revisions"."state" = 'DRAFT' AND "quotation_revisions"."subtotal" IS NULL AND "quotation_revisions"."tax_total" IS NULL AND "quotation_revisions"."total" IS NULL)
        OR ("quotation_revisions"."state" = 'ISSUED' AND "quotation_revisions"."subtotal" IS NOT NULL AND "quotation_revisions"."tax_total" IS NOT NULL AND "quotation_revisions"."total" IS NOT NULL)),
	CONSTRAINT "ck_quotation_revisions_totals_non_negative_finite" CHECK (("quotation_revisions"."subtotal" IS NULL OR ("quotation_revisions"."subtotal" >= 0 AND "quotation_revisions"."subtotal" NOT IN ('NaN','Infinity','-Infinity')))
        AND ("quotation_revisions"."tax_total" IS NULL OR ("quotation_revisions"."tax_total" >= 0 AND "quotation_revisions"."tax_total" NOT IN ('NaN','Infinity','-Infinity')))
        AND ("quotation_revisions"."total" IS NULL OR ("quotation_revisions"."total" >= 0 AND "quotation_revisions"."total" NOT IN ('NaN','Infinity','-Infinity')))),
	CONSTRAINT "ck_quotation_revisions_total_equals_sum" CHECK ("quotation_revisions"."total" = "quotation_revisions"."subtotal" + "quotation_revisions"."tax_total")
);
--> statement-breakpoint
CREATE TABLE "quotation_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "quotation_status_history_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"quotation_id" uuid NOT NULL,
	"revision_id" uuid,
	"from_status" text,
	"to_status" text NOT NULL,
	"changed_by_user_id" uuid NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text,
	CONSTRAINT "uq_quotation_status_history_seq" UNIQUE("seq"),
	CONSTRAINT "ck_quotation_status_history_to_values" CHECK ("quotation_status_history"."to_status" IN ('DRAFT','ISSUED','SENT','WON','LOST','CANCELLED')),
	CONSTRAINT "ck_quotation_status_history_from_values" CHECK ("quotation_status_history"."from_status" IS NULL OR "quotation_status_history"."from_status" IN ('DRAFT','ISSUED','SENT','WON','LOST','CANCELLED')),
	CONSTRAINT "ck_quotation_status_history_revision_required" CHECK ("quotation_status_history"."to_status" NOT IN ('ISSUED','SENT','WON') OR "quotation_status_history"."revision_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "quotations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"folio_year" smallint,
	"folio_number" integer,
	"folio" text GENERATED ALWAYS AS (CASE
      WHEN folio_year IS NULL THEN NULL
      ELSE 'COT-' || folio_year::text || '-' ||
           lpad(folio_number::text, GREATEST(3, length(folio_number::text)), '0')
      END) STORED,
	"sold_revision_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_quotations_folio" UNIQUE("folio_year","folio_number"),
	CONSTRAINT "ck_quotations_folio_coherence" CHECK ((("quotations"."folio_year" IS NULL AND "quotations"."folio_number" IS NULL) OR ("quotations"."folio_year" IS NOT NULL AND "quotations"."folio_number" IS NOT NULL))
        AND ("quotations"."status" <> 'DRAFT' OR "quotations"."folio_year" IS NULL)
        AND ("quotations"."status" NOT IN ('ISSUED','SENT','WON','LOST') OR "quotations"."folio_year" IS NOT NULL)),
	CONSTRAINT "ck_quotations_folio_values" CHECK ("quotations"."folio_year" IS NULL OR ("quotations"."folio_year" BETWEEN 2000 AND 9999 AND "quotations"."folio_number" > 0)),
	CONSTRAINT "ck_quotations_sold_coherence" CHECK (("quotations"."status" = 'WON' AND "quotations"."sold_revision_id" IS NOT NULL) OR ("quotations"."status" <> 'WON' AND "quotations"."sold_revision_id" IS NULL)),
	CONSTRAINT "ck_quotations_status_values" CHECK ("quotations"."status" IN ('DRAFT','ISSUED','SENT','WON','LOST','CANCELLED'))
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" "audit_actor_type" NOT NULL,
	"actor_user_id" uuid,
	"attempted_identifier_hmac" text,
	"target_type" text,
	"target_id" uuid,
	"target_user_id" uuid,
	"action" text NOT NULL,
	"result" "audit_result" NOT NULL,
	"ip_address" "inet",
	"user_agent" text,
	"request_id" uuid,
	"auth_session_id" uuid,
	"metadata" jsonb,
	CONSTRAINT "ck_audit_logs_actor_coherence" CHECK (("audit_logs"."actor_type" = 'USER' AND "audit_logs"."actor_user_id" IS NOT NULL) OR ("audit_logs"."actor_type" <> 'USER' AND "audit_logs"."actor_user_id" IS NULL)),
	CONSTRAINT "ck_audit_logs_target_both_or_neither" CHECK (("audit_logs"."target_type" IS NULL) = ("audit_logs"."target_id" IS NULL)),
	CONSTRAINT "ck_audit_logs_target_user_coherence" CHECK ((("audit_logs"."target_type" IS NOT DISTINCT FROM 'user' AND "audit_logs"."target_user_id" IS NOT NULL AND "audit_logs"."target_user_id" = "audit_logs"."target_id") OR ("audit_logs"."target_type" IS DISTINCT FROM 'user' AND "audit_logs"."target_user_id" IS NULL)) IS TRUE),
	CONSTRAINT "ck_audit_logs_target_type_format" CHECK ("audit_logs"."target_type" IS NULL OR "audit_logs"."target_type" ~ '^[a-z][a-z_]*$'),
	CONSTRAINT "ck_audit_logs_action_format" CHECK ("audit_logs"."action" ~ '^[A-Z][A-Z0-9_]*([.][A-Z][A-Z0-9_]*)*$'),
	CONSTRAINT "ck_audit_logs_attempted_identifier_hmac" CHECK ("audit_logs"."attempted_identifier_hmac" IS NULL OR ("audit_logs"."attempted_identifier_hmac" ~ '^[0-9a-f]{64}$' AND "audit_logs"."actor_type" = 'ANONYMOUS' AND "audit_logs"."result" = 'FAILURE' AND "audit_logs"."action" = 'AUTH.LOGIN_FAILURE')),
	CONSTRAINT "ck_audit_logs_metadata_object" CHECK ("audit_logs"."metadata" IS NULL OR jsonb_typeof("audit_logs"."metadata") = 'object'),
	CONSTRAINT "ck_audit_logs_metadata_size" CHECK ("audit_logs"."metadata" IS NULL OR pg_column_size("audit_logs"."metadata") <= 8192)
);
--> statement-breakpoint
CREATE TABLE "generated_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quotation_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"kind" "generated_document_kind" DEFAULT 'QUOTATION_PDF' NOT NULL,
	"storage_provider" text NOT NULL,
	"storage_bucket" text,
	"storage_key" text NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text DEFAULT 'application/pdf' NOT NULL,
	"byte_size" bigint NOT NULL,
	"sha256" char(64) NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_generated_documents_sha_revision" UNIQUE("revision_id","kind","sha256"),
	CONSTRAINT "ck_generated_documents_storage_provider" CHECK ("generated_documents"."storage_provider" IN ('R2', 'LOCAL_FS')),
	CONSTRAINT "ck_generated_documents_byte_size_positive" CHECK ("generated_documents"."byte_size" > 0),
	CONSTRAINT "ck_generated_documents_sha256_format" CHECK ("generated_documents"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ck_generated_documents_mime_type_pdf" CHECK ("generated_documents"."kind" <> 'QUOTATION_PDF' OR "generated_documents"."mime_type" = 'application/pdf'),
	CONSTRAINT "ck_generated_documents_storage_key_format" CHECK (length("generated_documents"."storage_key") BETWEEN 1 AND 1024 AND "generated_documents"."storage_key" !~ '^/'),
	CONSTRAINT "ck_generated_documents_file_name_length" CHECK (length("generated_documents"."file_name") BETWEEN 1 AND 255)
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"margin_warning_percent" numeric(9, 6) DEFAULT '25' NOT NULL,
	"updated_by_user_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_system_settings_singleton" CHECK ("system_settings"."id"),
	CONSTRAINT "ck_system_settings_margin_range" CHECK ("system_settings"."margin_warning_percent" > 0 AND "system_settings"."margin_warning_percent" <= 100 AND "system_settings"."margin_warning_percent" <> 'NaN')
);
--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "fk_role_permissions_role_id" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "fk_role_permissions_permission_id" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "fk_users_role_id" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "catalog_items" ADD CONSTRAINT "fk_catalog_items_category_id" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "catalog_items" ADD CONSTRAINT "fk_catalog_items_merged_into_id" FOREIGN KEY ("merged_into_id") REFERENCES "public"."catalog_items"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "catalog_items" ADD CONSTRAINT "fk_catalog_items_proposed_by_user_id" FOREIGN KEY ("proposed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "catalog_items" ADD CONSTRAINT "fk_catalog_items_reviewed_by_user_id" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "customer_contacts" ADD CONSTRAINT "fk_customer_contacts_customer_id" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "fk_customers_created_by_user_id" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "fk_customers_owner_user_id" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "fk_customers_deactivated_by_user_id" FOREIGN KEY ("deactivated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "providers" ADD CONSTRAINT "fk_providers_merged_into_id" FOREIGN KEY ("merged_into_id") REFERENCES "public"."providers"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "providers" ADD CONSTRAINT "fk_providers_proposed_by_user_id" FOREIGN KEY ("proposed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "providers" ADD CONSTRAINT "fk_providers_reviewed_by_user_id" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "exchange_rates" ADD CONSTRAINT "fk_exchange_rates_created_by_user_id" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "exchange_rates" ADD CONSTRAINT "fk_exchange_rates_supersedes_id_rate_date" FOREIGN KEY ("supersedes_id","rate_date") REFERENCES "public"."exchange_rates"("id","rate_date") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "quotation_items" ADD CONSTRAINT "fk_quotation_items_quotation_id_revision_id" FOREIGN KEY ("quotation_id","revision_id") REFERENCES "public"."quotation_revisions"("quotation_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "quotation_items" ADD CONSTRAINT "fk_quotation_items_catalog_item_id" FOREIGN KEY ("catalog_item_id") REFERENCES "public"."catalog_items"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "quotation_items" ADD CONSTRAINT "fk_quotation_items_provider_id" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "quotation_reviews" ADD CONSTRAINT "fk_quotation_reviews_quotation_id_revision_id" FOREIGN KEY ("quotation_id","revision_id") REFERENCES "public"."quotation_revisions"("quotation_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "quotation_reviews" ADD CONSTRAINT "fk_quotation_reviews_reviewer_user_id" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "quotation_revisions" ADD CONSTRAINT "fk_quotation_revisions_quotation_id" FOREIGN KEY ("quotation_id") REFERENCES "public"."quotations"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "quotation_revisions" ADD CONSTRAINT "fk_quotation_revisions_customer_id" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "quotation_revisions" ADD CONSTRAINT "fk_quotation_revisions_seller_user_id" FOREIGN KEY ("seller_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "quotation_revisions" ADD CONSTRAINT "fk_quotation_revisions_created_by_user_id" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "quotation_revisions" ADD CONSTRAINT "fk_quotation_revisions_issued_by_user_id" FOREIGN KEY ("issued_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "quotation_revisions" ADD CONSTRAINT "fk_quotation_revisions_exchange_rate_id" FOREIGN KEY ("exchange_rate_id") REFERENCES "public"."exchange_rates"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "quotation_status_history" ADD CONSTRAINT "fk_quotation_status_history_quotation_id" FOREIGN KEY ("quotation_id") REFERENCES "public"."quotations"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "quotation_status_history" ADD CONSTRAINT "fk_quotation_status_history_quotation_id_revision_id" FOREIGN KEY ("quotation_id","revision_id") REFERENCES "public"."quotation_revisions"("quotation_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "quotation_status_history" ADD CONSTRAINT "fk_quotation_status_history_changed_by_user_id" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "fk_quotations_customer_id" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "fk_quotations_created_by_user_id" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "fk_quotations_owner_user_id" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "fk_quotations_id_sold_revision_id" FOREIGN KEY ("id","sold_revision_id") REFERENCES "public"."quotation_revisions"("quotation_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "fk_audit_logs_actor_user_id" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "fk_audit_logs_target_user_id" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "generated_documents" ADD CONSTRAINT "fk_generated_documents_quotation_id_revision_id" FOREIGN KEY ("quotation_id","revision_id") REFERENCES "public"."quotation_revisions"("quotation_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "generated_documents" ADD CONSTRAINT "fk_generated_documents_created_by_user_id" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "system_settings" ADD CONSTRAINT "fk_system_settings_updated_by_user_id" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "ix_role_permissions_permission_id" ON "role_permissions" USING btree ("permission_id");--> statement-breakpoint
CREATE INDEX "ix_users_role_id" ON "users" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "ix_users_status_pending" ON "users" USING btree ("status") WHERE "users"."status" = 'PENDING_ACTIVATION';--> statement-breakpoint
CREATE INDEX "ix_catalog_items_name_normalized" ON "catalog_items" USING btree (lower(btrim("name")));--> statement-breakpoint
CREATE INDEX "ix_catalog_items_status" ON "catalog_items" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_catalog_items_category_id" ON "catalog_items" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "ix_catalog_items_proposed_by" ON "catalog_items" USING btree ("proposed_by_user_id","status");--> statement-breakpoint
CREATE INDEX "ix_catalog_items_merged_into" ON "catalog_items" USING btree ("merged_into_id") WHERE "catalog_items"."merged_into_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_categories_name_normalized" ON "categories" USING btree (lower(btrim("name")));--> statement-breakpoint
CREATE INDEX "ix_customer_contacts_customer_id" ON "customer_contacts" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_customer_contacts_primary" ON "customer_contacts" USING btree ("customer_id") WHERE "customer_contacts"."is_primary";--> statement-breakpoint
CREATE INDEX "ix_customers_owner_status" ON "customers" USING btree ("owner_user_id","status");--> statement-breakpoint
CREATE INDEX "ix_customers_email_normalized" ON "customers" USING btree (lower(btrim("email")));--> statement-breakpoint
CREATE INDEX "ix_customers_identification" ON "customers" USING btree ("identification_type","identification_number") WHERE "customers"."identification_number" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_providers_legal_name_normalized" ON "providers" USING btree (lower(btrim("legal_name")));--> statement-breakpoint
CREATE INDEX "ix_providers_status" ON "providers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_providers_proposed_by" ON "providers" USING btree ("proposed_by_user_id","status");--> statement-breakpoint
CREATE INDEX "ix_providers_identification" ON "providers" USING btree ("identification_type","identification_number") WHERE "providers"."identification_number" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_providers_merged_into" ON "providers" USING btree ("merged_into_id") WHERE "providers"."merged_into_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_providers_identification" ON "providers" USING btree ("identification_type","identification_number") WHERE "providers"."identification_number" IS NOT NULL AND "providers"."status" = 'APPROVED';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_exchange_rates_root_per_date" ON "exchange_rates" USING btree ("rate_date") WHERE "exchange_rates"."supersedes_id" IS NULL;--> statement-breakpoint
CREATE INDEX "ix_exchange_rates_created_by" ON "exchange_rates" USING btree ("created_by_user_id") WHERE "exchange_rates"."created_by_user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_exchange_rates_date_created" ON "exchange_rates" USING btree ("rate_date" DESC NULLS LAST,"created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_quotation_items_quotation_revision" ON "quotation_items" USING btree ("quotation_id","revision_id");--> statement-breakpoint
CREATE INDEX "ix_quotation_items_catalog_item_id" ON "quotation_items" USING btree ("catalog_item_id") WHERE "quotation_items"."catalog_item_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_quotation_items_provider_id" ON "quotation_items" USING btree ("provider_id") WHERE "quotation_items"."provider_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_quotation_reviews_quotation_reviewed" ON "quotation_reviews" USING btree ("quotation_id","reviewed_at");--> statement-breakpoint
CREATE INDEX "ix_quotation_reviews_reviewer_reviewed" ON "quotation_reviews" USING btree ("reviewer_user_id","reviewed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_quotation_revisions_one_draft" ON "quotation_revisions" USING btree ("quotation_id") WHERE "quotation_revisions"."state" = 'DRAFT';--> statement-breakpoint
CREATE INDEX "ix_quotation_revisions_exchange_rate_id" ON "quotation_revisions" USING btree ("exchange_rate_id") WHERE "quotation_revisions"."exchange_rate_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_quotation_status_history_quotation_changed" ON "quotation_status_history" USING btree ("quotation_id","changed_at");--> statement-breakpoint
CREATE INDEX "ix_quotation_status_history_to_changed" ON "quotation_status_history" USING btree ("to_status","changed_at");--> statement-breakpoint
CREATE INDEX "ix_quotations_customer_id" ON "quotations" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "ix_quotations_owner_status" ON "quotations" USING btree ("owner_user_id","status");--> statement-breakpoint
CREATE INDEX "ix_quotations_status_updated" ON "quotations" USING btree ("status","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_audit_logs_occurred_at" ON "audit_logs" USING btree ("occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_audit_logs_actor_user_id" ON "audit_logs" USING btree ("actor_user_id") WHERE "audit_logs"."actor_user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_audit_logs_target" ON "audit_logs" USING btree ("target_type","target_id") WHERE "audit_logs"."target_type" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_audit_logs_target_user_id" ON "audit_logs" USING btree ("target_user_id") WHERE "audit_logs"."target_user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_generated_documents_storage" ON "generated_documents" USING btree ("storage_provider",coalesce("storage_bucket", ''),"storage_key");--> statement-breakpoint
CREATE INDEX "ix_generated_documents_quotation_revision" ON "generated_documents" USING btree ("quotation_id","revision_id");
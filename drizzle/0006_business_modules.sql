CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"legal_id" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_companies_name_nonblank" CHECK (length(btrim("companies"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "payment_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bank" text NOT NULL,
	"account_number" text NOT NULL,
	"currency" "currency_code" NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_payment_accounts_nonblank" CHECK (length(btrim("payment_accounts"."bank")) > 0 AND length(btrim("payment_accounts"."account_number")) > 0)
);
--> statement-breakpoint
CREATE TABLE "provider_costs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"catalog_item_id" uuid,
	"item_name" text NOT NULL,
	"unit_cost" numeric(20, 6) NOT NULL,
	"currency" "currency_code" NOT NULL,
	"quoted_on" date NOT NULL,
	"notes" text,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_provider_costs_unit_cost" CHECK ("provider_costs"."unit_cost" >= 0 AND "provider_costs"."unit_cost" <> 'NaN'),
	CONSTRAINT "ck_provider_costs_item_name" CHECK (length(btrim("provider_costs"."item_name")) > 0)
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "quotation_revisions" ADD COLUMN "concept" text;--> statement-breakpoint
ALTER TABLE "quotation_revisions" ADD COLUMN "valid_until" date;--> statement-breakpoint
ALTER TABLE "quotation_revisions" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "quotation_revisions" ADD COLUMN "payment_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "quotation_revisions" ADD COLUMN "customer_cabys" text;--> statement-breakpoint
ALTER TABLE "provider_costs" ADD CONSTRAINT "fk_provider_costs_provider_id" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "provider_costs" ADD CONSTRAINT "fk_provider_costs_catalog_item_id" FOREIGN KEY ("catalog_item_id") REFERENCES "public"."catalog_items"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "provider_costs" ADD CONSTRAINT "fk_provider_costs_created_by" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_companies_name_normalized" ON "companies" USING btree (lower(btrim("name")));--> statement-breakpoint
CREATE INDEX "ix_provider_costs_owner_item" ON "provider_costs" USING btree ("created_by_user_id","catalog_item_id","quoted_on" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_provider_costs_provider" ON "provider_costs" USING btree ("provider_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "fk_users_company_id" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "ix_users_company_id" ON "users" USING btree ("company_id") WHERE "users"."company_id" IS NOT NULL;--> statement-breakpoint

-- Backfill: vendedores existentes antes de esta migración pertenecen a la empresa por defecto "Disetech"
-- (el administrador puede cambiarla en /admin/empresas y /admin/usuarios).
INSERT INTO public.companies (name)
SELECT 'Disetech'
WHERE EXISTS (SELECT 1 FROM public.users u JOIN public.roles r ON r.id = u.role_id WHERE r.code = 'SELLER' AND u.company_id IS NULL)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE public.users u SET company_id = (SELECT id FROM public.companies WHERE lower(btrim(name)) = 'disetech')
WHERE company_id IS NULL AND role_id = (SELECT id FROM public.roles WHERE code = 'SELLER');
--> statement-breakpoint

-- Reglas de integridad de las tablas nuevas (mismo patrón que 0001): nada se trunca ni se borra,
-- version/updated_at los mantiene la BD, y el historial de costos es append-only.
CREATE TRIGGER trg_companies_no_truncate BEFORE TRUNCATE ON public.companies
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_companies_no_delete BEFORE DELETE ON public.companies
FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_companies_touch_version BEFORE UPDATE ON public.companies
FOR EACH ROW EXECUTE FUNCTION public.fn_touch_version();
--> statement-breakpoint
CREATE TRIGGER trg_payment_accounts_no_truncate BEFORE TRUNCATE ON public.payment_accounts
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_payment_accounts_no_delete BEFORE DELETE ON public.payment_accounts
FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_payment_accounts_touch_version BEFORE UPDATE ON public.payment_accounts
FOR EACH ROW EXECUTE FUNCTION public.fn_touch_version();
--> statement-breakpoint
CREATE TRIGGER trg_provider_costs_no_truncate BEFORE TRUNCATE ON public.provider_costs
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_provider_costs_no_delete BEFORE DELETE ON public.provider_costs
FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER trg_provider_costs_no_update BEFORE UPDATE ON public.provider_costs
FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_mutation();
--> statement-breakpoint

-- Un SELLER debe pertenecer a una empresa: se verifica al activar y al cambiar rol/empresa.
CREATE FUNCTION public.fn_seller_requires_company() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_role public.role_code;
BEGIN
  SELECT code INTO v_role FROM public.roles WHERE id = NEW.role_id;
  IF v_role = 'SELLER' AND NEW.company_id IS NULL THEN
    RAISE EXCEPTION 'a SELLER must belong to a company' USING ERRCODE = 'DTV01';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trg_users_seller_requires_company BEFORE INSERT OR UPDATE OF role_id, company_id ON public.users
FOR EACH ROW EXECUTE FUNCTION public.fn_seller_requires_company();

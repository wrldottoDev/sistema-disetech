ALTER TABLE "quotation_items" ADD COLUMN "margin_mode" text DEFAULT 'PERCENT' NOT NULL;--> statement-breakpoint
ALTER TABLE "quotation_items" ADD COLUMN "margin_amount" numeric(20, 6);--> statement-breakpoint
ALTER TABLE "quotation_revisions" ADD COLUMN "pricing_mode" text DEFAULT 'BY_UNIT' NOT NULL;--> statement-breakpoint
ALTER TABLE "quotation_items" ADD CONSTRAINT "ck_quotation_items_margin_mode" CHECK (("quotation_items"."margin_mode" = 'PERCENT' AND "quotation_items"."margin_amount" IS NULL) OR ("quotation_items"."margin_mode" = 'AMOUNT' AND "quotation_items"."margin_amount" > 0));--> statement-breakpoint
ALTER TABLE "quotation_revisions" ADD CONSTRAINT "ck_quotation_revisions_pricing_mode" CHECK ("quotation_revisions"."pricing_mode" IN ('BY_UNIT','PACKAGE'));
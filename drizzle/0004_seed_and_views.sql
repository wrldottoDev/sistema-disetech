-- B — Seed data (roles, V1 permission catalog per A2 U2 final grid, system_settings
-- singleton) and the two public read views (A2 C2). No DROP, no CASCADE.

-- A §3 — fixed 4-role vocabulary, Spanish display names.
INSERT INTO "roles" ("code", "name") VALUES
  ('ADMIN', 'Administrador'),
  ('SELLER', 'Vendedor'),
  ('COMMERCIAL_MANAGER', 'Gerente Comercial'),
  ('ADMINISTRATIVE_MANAGER', 'Gerente Administrativo');
--> statement-breakpoint

-- A2 U2 — final permission catalog: adds customers.reassign, audit.view, settings.manage
-- to A §3's list. Spanish descriptions.
INSERT INTO "permissions" ("code", "description") VALUES
  ('users.manage',           'Crear usuarios, cambiar rol, activar/desactivar, editar perfil'),
  ('customers.view_own',     'Ver clientes propios'),
  ('customers.manage_own',   'Crear/editar clientes propios'),
  ('customers.view_all',     'Ver todos los clientes'),
  ('customers.manage_all',   'Editar cualquier cliente'),
  ('customers.reassign',     'Reasignar clientes a otro vendedor'),
  ('catalog.propose',        'Proponer nuevos items de catalogo'),
  ('catalog.review',         'Aprobar/corregir/fusionar items de catalogo'),
  ('providers.propose',      'Proponer nuevos proveedores'),
  ('providers.review',       'Aprobar/normalizar/fusionar proveedores'),
  ('quotations.manage_own',  'Crear/editar/emitir cotizaciones propias'),
  ('quotations.view_all',    'Ver todas las cotizaciones'),
  ('quotations.review',      'Registrar revision gerencial de una cotizacion'),
  ('audit.view',             'Ver el registro de auditoria'),
  ('settings.manage',        'Administrar la configuracion del sistema');
--> statement-breakpoint

-- A2 U2 final grid (authoritative — supersedes A §3's role_permissions block).
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON TRUE
WHERE (r."code", p."code") IN (
  ('ADMIN', 'users.manage'),
  ('ADMIN', 'customers.view_all'),
  ('ADMIN', 'customers.manage_all'),
  ('ADMIN', 'customers.reassign'),
  ('ADMIN', 'catalog.review'),
  ('ADMIN', 'providers.review'),
  ('ADMIN', 'quotations.view_all'),
  ('ADMIN', 'audit.view'),
  ('ADMIN', 'settings.manage'),

  ('SELLER', 'customers.view_own'),
  ('SELLER', 'customers.manage_own'),
  ('SELLER', 'catalog.propose'),
  ('SELLER', 'providers.propose'),
  ('SELLER', 'quotations.manage_own'),

  ('COMMERCIAL_MANAGER', 'customers.view_all'),
  ('COMMERCIAL_MANAGER', 'catalog.review'),
  ('COMMERCIAL_MANAGER', 'providers.review'),
  ('COMMERCIAL_MANAGER', 'quotations.view_all'),
  ('COMMERCIAL_MANAGER', 'quotations.review'),

  ('ADMINISTRATIVE_MANAGER', 'customers.view_all'),
  ('ADMINISTRATIVE_MANAGER', 'catalog.review'),
  ('ADMINISTRATIVE_MANAGER', 'providers.review'),
  ('ADMINISTRATIVE_MANAGER', 'quotations.view_all'),
  ('ADMINISTRATIVE_MANAGER', 'quotations.review')
);
--> statement-breakpoint

-- A2 I4 — the one-and-only system_settings row (singleton enforced by ck_system_settings_singleton).
INSERT INTO "system_settings" ("id") VALUES (true);
--> statement-breakpoint

-- A2 C2 — seller/public read surface: APPROVED catalog items only, catalog columns only
-- (no commercial context, no proposer/review data).
CREATE VIEW "public"."catalog_items_public" AS
SELECT "id", "name", "description", "category_id", "cabys_code", "unit"
FROM "public"."catalog_items"
WHERE "status" = 'APPROVED';
--> statement-breakpoint

-- A2 C2 — seller/public read surface: APPROVED providers only, no notes/proposer/review data.
CREATE VIEW "public"."providers_public" AS
SELECT "id", "legal_name", "commercial_name", "identification_type", "identification_number",
       "phone", "email", "address", "contact_name"
FROM "public"."providers"
WHERE "status" = 'APPROVED';

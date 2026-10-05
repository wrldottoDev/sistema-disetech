import { z } from "zod";

z.config(z.locales.es());

export const emailSchema = z.string().trim().toLowerCase().email().max(320);
export const passwordSchema = z.string().min(12, "Usa al menos 12 caracteres").max(128);
export const phoneSchema = z.string().trim().min(7).max(20).regex(/^[+() 0-9-]+$/, "Teléfono inválido");
export const roleSchema = z.enum(["ADMIN", "SELLER", "COMMERCIAL_MANAGER", "ADMINISTRATIVE_MANAGER"]);
export const uuidSchema = z.string().uuid();
export const versionSchema = z.coerce.number().int().positive();

export const createUserSchema = z.object({
  name: z.string().trim().min(2).max(200),
  email: emailSchema,
  phone: phoneSchema,
  role: roleSchema,
  companyId: z.preprocess((v) => (v === "" || v === null ? undefined : v), uuidSchema.optional()),
});

export const activationSchema = z.object({ token: z.string().min(32).max(256), password: passwordSchema });
export const loginSchema = z.object({ email: emailSchema, password: passwordSchema });

// ---- Dominio comercial ----
const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
export const optionalText = (max: number) => z.preprocess(blank, z.string().trim().max(max).optional());
export const requiredText = (min: number, max: number, label: string) =>
  z.string().trim().min(min, `${label} es obligatorio.`).max(max, `${label} es demasiado largo.`);

export const identificationTypeSchema = z.enum(["FISICA", "JURIDICA", "DIMEX", "NITE", "PASAPORTE"]);
const identificationPatterns: Record<z.infer<typeof identificationTypeSchema>, RegExp> = {
  FISICA: /^[0-9]{9}$/,
  JURIDICA: /^[0-9]{10}$/,
  DIMEX: /^[0-9]{11,12}$/,
  NITE: /^[0-9]{9,10}$/,
  PASAPORTE: /^.{3,20}$/,
};
export const customerSchema = z
  .object({
    fullName: requiredText(2, 200, "El nombre"),
    email: emailSchema,
    identificationType: z.preprocess(blank, identificationTypeSchema.optional()),
    identificationNumber: z.preprocess(blank, z.string().trim().max(20).optional()),
    phone: z.preprocess(blank, phoneSchema.optional()),
    cabys: z.preprocess(blank, z.string().trim().regex(/^[0-9]{13}$/, "El código CABYS debe tener 13 dígitos.").optional()),
    address: optionalText(500),
    notes: optionalText(2000),
  })
  .superRefine((v, ctx) => {
    if (!!v.identificationType !== !!v.identificationNumber) ctx.addIssue({ code: "custom", path: ["identificationNumber"], message: "Indica tipo y número de identificación, o ninguno." });
    else if (v.identificationType && v.identificationNumber && !identificationPatterns[v.identificationType].test(v.identificationNumber)) ctx.addIssue({ code: "custom", path: ["identificationNumber"], message: "El número no coincide con el tipo de identificación." });
  });

export const contactSchema = z.object({
  fullName: requiredText(2, 200, "El nombre del contacto"),
  phone: z.preprocess(blank, phoneSchema.optional()),
  email: z.preprocess(blank, emailSchema.optional()),
  department: optionalText(120),
});

export const currencySchema = z.enum(["CRC", "USD"]);
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida.").refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v), "Fecha inválida.");
export const dateSchema = dateOnly;

export const quotationHeaderSchema = z.object({
  contactId: z.preprocess(blank, uuidSchema.optional()),
  concept: requiredText(2, 300, "El concepto"),
  currency: currencySchema,
  validUntil: dateOnly,
  notes: optionalText(4000),
  cabys: z.preprocess(blank, z.string().trim().regex(/^[0-9]{13}$/, "El código CABYS debe tener 13 dígitos.").optional()),
  pricingMode: z.preprocess(blank, z.enum(["BY_UNIT", "PACKAGE"]).optional()),
});

export const quotationItemSchema = z.object({
  itemName: optionalText(300),
  itemDescription: optionalText(2000),
  unit: optionalText(30),
  catalogItemId: z.preprocess(blank, uuidSchema.optional()),
  providerId: z.preprocess(blank, uuidSchema.optional()),
  quantity: z.string().trim().min(1, "La cantidad es obligatoria."),
  unitCost: z.string().trim().min(1, "El costo es obligatorio."),
  costCurrency: currencySchema,
  marginMode: z.preprocess(blank, z.enum(["PERCENT", "AMOUNT"]).default("PERCENT")),
  marginPercent: z.preprocess(blank, z.string().trim().optional()),
  marginAmount: z.preprocess(blank, z.string().trim().optional()),
  saveCost: z.preprocess((v) => v === "on" || v === "true" || v === true, z.boolean()),
});

export const reviewSchema = z.object({
  revisionId: uuidSchema,
  revisionVersion: versionSchema,
  outcome: z.enum(["APPROVED", "REJECTED", "CHANGES_REQUESTED"]),
  comment: optionalText(1000),
});

export const closeSchema = z.object({ to: z.enum(["WON", "LOST", "CANCELLED"]), note: optionalText(500), quotationVersion: versionSchema });

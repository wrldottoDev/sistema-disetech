// Aritmética decimal exacta sobre BigInt (sin floats). Todos los valores internos usan escala 6,
// igual que las columnas NUMERIC(…,6) de PostgreSQL. Se redondea half-up (away from zero).
import { AppError } from "@/lib/errors";

export const SCALE = 6;
const UNIT = 10n ** BigInt(SCALE);
export type Currency = "CRC" | "USD";

const DECIMAL = /^\d{1,14}(\.\d{1,6})?$/;
const GROUPED = /^\d{1,3}(,\d{3})+(\.\d{1,6})?$/;

/** "12.5" -> 12_500_000n. Rechaza negativos, notación científica, separadores y más de 6 decimales. */
export function parseDecimal(value: unknown, label = "valor"): bigint {
  const raw = typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
  // La coma sólo se acepta como separador de miles bien formado (1,234.50); "1,5" es ambiguo y se rechaza.
  const text = GROUPED.test(raw) ? raw.replace(/,/g, "") : raw;
  if (!DECIMAL.test(text)) throw new AppError("VALIDATION", `${label} inválido.`);
  const [whole, frac = ""] = text.split(".");
  return BigInt(whole) * UNIT + BigInt(frac.padEnd(SCALE, "0"));
}

export function fromDb(value: string): bigint {
  const [whole, frac = ""] = value.split(".");
  return BigInt(whole) * UNIT + BigInt(frac.slice(0, SCALE).padEnd(SCALE, "0"));
}

/** Para escribir en columnas NUMERIC: siempre 6 decimales. */
export function toDb(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  return `${negative ? "-" : ""}${abs / UNIT}.${(abs % UNIT).toString().padStart(SCALE, "0")}`;
}

function divRound(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = (2n * n + d) / (2n * d);
  return negative ? -q : q;
}

/** Redondea half-up a `decimals` decimales (conserva escala 6). */
export function round(value: bigint, decimals = 2): bigint {
  const step = 10n ** BigInt(SCALE - decimals);
  return divRound(value, step) * step;
}

export const mul = (a: bigint, b: bigint): bigint => divRound(a * b, UNIT);
export const div = (a: bigint, b: bigint): bigint => divRound(a * UNIT, b);

/**
 * Precio unitario de venta = costo × (1 + utilidad/100), convertido a la moneda de la cotización
 * con el tipo de cambio de venta (USD→CRC multiplica, CRC→USD divide). Se redondea UNA sola vez, a centavos,
 * conservando toda la precisión de la utilidad y del tipo de cambio en los pasos intermedios.
 */
export function unitPrice(input: { cost: bigint; costCurrency: Currency; marginPercent: bigint; currency: Currency; fxRate: bigint; marginAmount?: bigint | null }): bigint {
  const base = 100n * UNIT;
  // Con monto fijo (en la moneda del costo) el precio es costo + monto; el porcentaje queda sólo como dato derivado.
  const grossed = input.marginAmount != null ? (input.cost + input.marginAmount) * base : input.cost * (base + input.marginPercent); // escala 6 + 8
  // numerador/denominador exactos del precio (escala 6); se redondea una sola vez, directo a centavos.
  let numerator = grossed;
  let denominator = base;
  if (input.costCurrency !== input.currency) {
    if (input.costCurrency === "USD") { numerator = grossed * input.fxRate; denominator = base * UNIT; }
    else { numerator = grossed * UNIT; denominator = base * input.fxRate; }
  }
  const CENT = 10n ** BigInt(SCALE - 2);
  return divRound(numerator, denominator * CENT) * CENT;
}

/** Utilidad % equivalente a un monto fijo por unidad (escala 6, redondeado). */
export function marginPercentFromAmount(cost: bigint, amount: bigint): bigint {
  return divRound(amount * 100n * UNIT, cost);
}

export type LineAmounts = { subtotal: bigint; tax: bigint; total: bigint };
/** Mismo cálculo exacto que las columnas generadas de quotation_items (escala 12 → 6 sin pérdida si qty ≤ 2 dec.). */
export function lineAmounts(quantity: bigint, price: bigint, taxPercent: bigint): LineAmounts {
  const subtotal = mul(quantity, price);
  const tax = divRound(subtotal * taxPercent, 100n * UNIT);
  return { subtotal, tax, total: subtotal + tax };
}

/** Formato es-CR visible: 20,721.46 (2 decimales, miles con coma, igual que la cotización real). */
export function formatMoney(value: bigint): string {
  const rounded = round(value, 2);
  const negative = rounded < 0n;
  const abs = negative ? -rounded : rounded;
  const cents = abs / 10_000n;
  const whole = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${whole}.${(cents % 100n).toString().padStart(2, "0")}`;
}

export function formatQuantity(value: bigint): string {
  return formatMoney(value);
}

/** Equivalencia entre monedas: CRC→USD divide, USD→CRC multiplica. */
export function convert(value: bigint, from: Currency, to: Currency, fxRate: bigint): bigint {
  if (from === to) return value;
  return from === "USD" ? mul(value, fxRate) : div(value, fxRate);
}

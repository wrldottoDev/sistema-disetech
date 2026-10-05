import { type Currency, formatMoney, fromDb } from "@/lib/money";

export const STATUS_LABEL: Record<string, string> = { DRAFT: "Borrador", ISSUED: "Emitida", SENT: "Enviada", WON: "Ganada", LOST: "Perdida", CANCELLED: "Cancelada" };
export const symbol = (currency: string) => (currency === "USD" ? "$" : "₡");
export const money = (value: string, currency: string) => `${symbol(currency)}${formatMoney(fromDb(value))}`;
export const asCurrency = (value: string): Currency => (value === "USD" ? "USD" : "CRC");
export const dateTime = (date: Date) => new Intl.DateTimeFormat("es-CR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Costa_Rica" }).format(date);
export const dmy = (iso: string | null) => (iso ? iso.split("-").reverse().join("/") : "—");

// Contrato ÚNICO de lo que ve el cliente (PDF, vista previa, correo). Nunca incluye costo, utilidad ni proveedor:
// el tipo no tiene esos campos, así que ningún renderer puede filtrarlos por accidente.
export type ClientDocumentLine = {
  name: string;
  description?: string;
  unit?: string;
  quantity: string; // "5.00"
  unitPrice: string; // "18,337.58"
  subtotal: string;
  taxPercent: string; // "13.0%"
  total: string;
};

export type ClientDocument = {
  folio: string | null; // null en borrador (vista previa)
  isDraft: boolean;
  date: string; // DD/MM/YYYY
  validUntil: string; // DD/MM/YYYY
  customerName: string;
  contact: string; // teléfono o nombre del contacto; "" si no hay
  cabys: string; // "" si no hay
  sellerName: string;
  concept: string;
  currency: "CRC" | "USD";
  exchangeRate: string; // "462.2900"
  lines: ClientDocumentLine[];
  totals: { subtotal: string; taxPercent: string; tax: string; total: string };
  equivalence: { crc: string; usd: string }; // "₡20,721.46", "$44.82"
  notes: string; // "" si no hay
  paymentAccounts: { bank: string; account: string; currency: string }[];
  footerNote: string;
};

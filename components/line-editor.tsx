"use client";

import { useActionState, useMemo, useState } from "react";
import type { ActionState } from "@/app/actions/users";
import { type Currency, formatMoney, lineAmounts, parseDecimal, round, unitPrice } from "@/lib/money";

type Option = { id: string; name: string; unit?: string | null };
type CostOption = { id: string; providerId: string; catalogItemId: string | null; itemName: string; unitCost: string; currency: Currency; quotedOn: string };
export type LineDefaults = { id?: string; itemName?: string; itemDescription?: string | null; unit?: string | null; catalogItemId?: string | null; providerId?: string | null; quantity?: string; unitCost?: string; costCurrency?: Currency; marginPercent?: string };

type Props = {
  action: (state: ActionState, form: FormData) => Promise<ActionState>;
  quotationId: string;
  revisionId: string;
  revisionVersion: number;
  currency: Currency;
  fxRate: string;
  warningPercent: string;
  catalog: Option[];
  providers: Option[];
  costs: CostOption[];
  defaults?: LineDefaults;
  submitLabel: string;
};

const trim = (v: string | undefined | null) => { const t = v ?? ""; return t.includes(".") ? t.replace(/0+$/, "").replace(/\.$/, "") : t; };

export function LineEditor({ action, quotationId, revisionId, revisionVersion, currency, fxRate, warningPercent, catalog, providers, costs, defaults, submitLabel }: Props) {
  const isNew = !defaults?.id;
  const [name, setName] = useState(defaults?.itemName ?? "");
  const [detail, setDetail] = useState(defaults?.itemDescription ?? "");
  const [unit, setUnit] = useState(defaults?.unit ?? "");
  const [catalogId, setCatalogId] = useState(defaults?.catalogItemId ?? "");
  const [providerId, setProviderId] = useState(defaults?.providerId ?? "");
  const [qty, setQty] = useState(trim(defaults?.quantity) || "1");
  const [cost, setCost] = useState(trim(defaults?.unitCost));
  const [costCurrency, setCostCurrency] = useState<Currency>(defaults?.costCurrency ?? currency);
  const [margin, setMargin] = useState(trim(defaults?.marginPercent) || "25");

  // Tras agregar una línea nueva se limpia el formulario para capturar la siguiente.
  const [state, formAction, pending] = useActionState(async (prev: ActionState, form: FormData) => {
    const result = await action(prev, form);
    if (result.ok && isNew) { setName(""); setDetail(""); setUnit(""); setCatalogId(""); setProviderId(""); setQty("1"); setCost(""); }
    return result;
  }, { ok: false, message: "" });

  const preview = useMemo(() => {
    try {
      const c = parseDecimal(cost);
      const m = parseDecimal(margin);
      const q = parseDecimal(qty);
      if (c <= 0n || m <= 0n || q <= 0n) return null;
      const price = unitPrice({ cost: c, costCurrency, marginPercent: m, currency, fxRate: parseDecimal(fxRate) });
      const a = lineAmounts(q, price, 13_000_000n);
      // Misma política que el PDF: cada importe se redondea a centavos y el total es la suma de los redondeados.
      const subtotal = round(a.subtotal);
      const tax = round(a.tax);
      return { price, subtotal, tax, total: subtotal + tax, low: m < parseDecimal(warningPercent) };
    } catch {
      return null;
    }
  }, [cost, margin, qty, costCurrency, currency, fxRate, warningPercent]);

  const relevantCosts = costs.filter((c) => (catalogId ? c.catalogItemId === catalogId : true)).slice(0, 25);
  const symbol = currency === "USD" ? "$" : "₡";
  const key = defaults?.id ?? "new";

  return (
    <form action={formAction} className="stack">
      <input type="hidden" name="quotationId" value={quotationId} />
      <input type="hidden" name="revisionId" value={revisionId} />
      <input type="hidden" name="revisionVersion" value={revisionVersion} />
      {defaults?.id && <input type="hidden" name="itemId" value={defaults.id} />}
      <label>Producto del catálogo <span className="field-hint">opcional</span>
        <select name="catalogItemId" value={catalogId} onChange={(e) => { setCatalogId(e.target.value); const item = catalog.find((c) => c.id === e.target.value); if (item) { if (!name) setName(item.name); if (!unit && item.unit) setUnit(item.unit); } }}>
          <option value="">— Producto libre —</option>
          {catalog.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>
      <label>Descripción<input name="itemName" value={name} onChange={(e) => setName(e.target.value)} maxLength={300} required={!catalogId} autoComplete="off" /></label>
      <label>Detalle adicional <span className="field-hint">opcional, se muestra al cliente</span><input name="itemDescription" value={detail} onChange={(e) => setDetail(e.target.value)} maxLength={2000} /></label>
      <div className="row">
        <label>Cantidad<input name="quantity" value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" required aria-describedby={`${key}-qty`} /><span id={`${key}-qty`} className="field-hint">Hasta 2 decimales</span></label>
        <label>Unidad<input name="unit" value={unit} onChange={(e) => setUnit(e.target.value)} maxLength={30} placeholder="UND, m, caja…" /></label>
      </div>
      <fieldset className="line-card">
        <legend>Información interna (no se muestra al cliente)</legend>
        <label>Proveedor
          <select name="providerId" value={providerId} onChange={(e) => setProviderId(e.target.value)}>
            <option value="">— Sin proveedor —</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        {relevantCosts.length > 0 && (
          <label>Usar un costo anterior
            <select value="" onChange={(e) => { const c = costs.find((x) => x.id === e.target.value); if (c) { setCost(trim(c.unitCost)); setCostCurrency(c.currency); setProviderId(c.providerId); if (!name) setName(c.itemName); } }}>
              <option value="">— Elegir —</option>
              {relevantCosts.map((c) => <option key={c.id} value={c.id}>{c.itemName} · {c.currency === "USD" ? "$" : "₡"}{trim(c.unitCost)} · {c.quotedOn}</option>)}
            </select>
          </label>
        )}
        <div className="row">
          <label>Costo unitario<input name="unitCost" value={cost} onChange={(e) => setCost(e.target.value)} inputMode="decimal" required /></label>
          <label>Moneda del costo<select name="costCurrency" value={costCurrency} onChange={(e) => setCostCurrency(e.target.value as Currency)}><option value="CRC">CRC</option><option value="USD">USD</option></select></label>
          <label>Utilidad %<input name="marginPercent" value={margin} onChange={(e) => setMargin(e.target.value)} inputMode="decimal" required /></label>
        </div>
        {providerId && <label className="check"><input type="checkbox" name="saveCost" defaultChecked /> Guardar este costo en el historial</label>}
        {preview?.low && <p className="warn" role="status">Utilidad menor a {trim(warningPercent)}%: un gerente deberá aprobar la cotización antes de emitirla.</p>}
      </fieldset>
      <div className="line-card" aria-live="polite">
        {preview ? <>
          <span>Precio unitario de venta: <strong>{symbol}{formatMoney(preview.price)}</strong></span>
          <span>Subtotal {symbol}{formatMoney(preview.subtotal)} · IVA 13% {symbol}{formatMoney(preview.tax)} · <strong>Total {symbol}{formatMoney(preview.total)}</strong></span>
        </> : <span>Completa cantidad, costo y utilidad para ver el precio.</span>}
      </div>
      {state.message && <p role={state.ok ? "status" : "alert"} className={state.ok ? "success" : "error"}>{state.message}</p>}
      <button type="submit" disabled={pending}>{pending ? "Guardando…" : submitLabel}</button>
    </form>
  );
}

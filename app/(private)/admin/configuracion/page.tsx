import { createPaymentAccountAction, recordRateAction, setMarginWarningAction, togglePaymentAccountAction } from "@/app/actions/business";
import { ActionForm } from "@/components/action-form";
import { requireAdminPage } from "@/lib/authorization";
import { getMarginWarning, listPaymentAccounts, listRates } from "@/lib/admin/service";
import { todayCR } from "@/lib/quotations/service";
import { dmy } from "@/lib/ui";

export default async function SettingsPage() {
  const principal = await requireAdminPage("settings.manage");
  const [rates, accounts, margin] = await Promise.all([listRates(principal), listPaymentAccounts(principal), getMarginWarning(principal)]);
  const today = todayCR();
  return (
    <div className="stack gap-lg">
      <h1>Configuración</h1>
      <section className="card stack"><h2>Tipo de cambio (USD → CRC)</h2>
        <p className="field-hint">Las cotizaciones usan el valor de venta vigente. Registrar de nuevo la misma fecha corrige el valor anterior sin borrarlo.</p>
        <ActionForm action={recordRateAction} submitLabel="Registrar tipo de cambio">
          <div className="row"><label>Fecha<input name="rateDate" type="date" max={today} defaultValue={today} required /></label><label>Compra<input name="buy" inputMode="decimal" required /></label><label>Venta<input name="sell" inputMode="decimal" required /></label></div>
        </ActionForm>
        <ul className="plain-list">{rates.map((r) => <li key={r.id}><span>{dmy(r.rateDate)} · compra {Number(r.buyRate).toFixed(4)} · venta {Number(r.sellRate).toFixed(4)}</span><span className="badge">{r.source}</span></li>)}</ul>
      </section>
      <section className="card stack"><h2>Utilidad mínima sin aprobación</h2>
        <p className="field-hint">Líneas con utilidad menor a este porcentaje requieren la aprobación de un gerente para emitirse.</p>
        <ActionForm action={setMarginWarningAction} submitLabel="Guardar"><input type="hidden" name="version" value={margin.version} /><label>Porcentaje<input name="value" inputMode="decimal" defaultValue={Number(margin.value)} required /></label></ActionForm>
      </section>
      <section className="card stack"><h2>Cuentas para pago o depósito</h2>
        <p className="field-hint">Se imprimen en el PDF de cada cotización.</p>
        <ActionForm action={createPaymentAccountAction} submitLabel="Agregar cuenta">
          <label>Banco<input name="bank" required maxLength={120} /></label><label>N° de cuenta / IBAN<input name="accountNumber" required maxLength={60} /></label><label>Moneda<select name="currency"><option value="CRC">CRC</option><option value="USD">USD</option></select></label>
        </ActionForm>
        <ul className="list">{accounts.map((a) => <li key={a.id} className="list-item"><strong>{a.bank}</strong><span className="meta"><span>{a.accountNumber}</span><span>{a.currency}</span>{!a.isActive && <span className="badge">Inactiva</span>}</span>
          <ActionForm action={togglePaymentAccountAction} submitLabel={a.isActive ? "Quitar del PDF" : "Reactivar"} variant="secondary" className="toolbar"><input type="hidden" name="accountId" value={a.id} /><input type="hidden" name="active" value={a.isActive ? "false" : "true"} /></ActionForm></li>)}</ul>
      </section>
    </div>
  );
}

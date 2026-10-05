import type { CustomerRow } from "@/lib/customers/service";

export function CustomerFields({ customer }: { customer?: CustomerRow }) {
  return (
    <>
      <label>Nombre o razón social<input name="fullName" defaultValue={customer?.fullName} required minLength={2} maxLength={200} autoComplete="off" /></label>
      <label>Correo<input name="email" type="email" defaultValue={customer?.email} required autoComplete="off" /></label>
      <div className="row">
        <label>Tipo de identificación
          <select name="identificationType" defaultValue={customer?.identificationType ?? ""}>
            <option value="">Sin identificación</option><option value="FISICA">Cédula física (9 dígitos)</option><option value="JURIDICA">Cédula jurídica (10 dígitos)</option><option value="DIMEX">DIMEX (11–12 dígitos)</option><option value="NITE">NITE (9–10 dígitos)</option><option value="PASAPORTE">Pasaporte</option>
          </select>
        </label>
        <label>Número de identificación<input name="identificationNumber" defaultValue={customer?.identificationNumber ?? ""} inputMode="numeric" maxLength={20} /></label>
      </div>
      <label>Teléfono<input name="phone" type="tel" defaultValue={customer?.phone ?? ""} inputMode="tel" maxLength={20} /></label>
      <label>Código CABYS <span className="field-hint">13 dígitos, opcional</span><input name="cabys" defaultValue={customer?.economicActivityCabys ?? ""} inputMode="numeric" maxLength={13} /></label>
      <label>Dirección<input name="address" defaultValue={customer?.address ?? ""} maxLength={500} /></label>
      <label>Notas internas<textarea name="notes" defaultValue={customer?.notes ?? ""} maxLength={2000} /></label>
    </>
  );
}

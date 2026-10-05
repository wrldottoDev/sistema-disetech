"use client";

import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { reauthenticateAction } from "@/app/actions/security";

type Passkey = { id: string; name?: string | null; createdAt?: Date | string | null };

export function SecurityPanel({ isAdmin, twoFactorEnabled }: { isAdmin: boolean; twoFactorEnabled: boolean }) {
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [message, setMessage] = useState("");
  const [totpURI, setTotpURI] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);

  async function refreshPasskeys() {
    const result = await authClient.passkey.listUserPasskeys();
    setPasskeys((result.data ?? []) as Passkey[]);
  }
  useEffect(() => {
    let active = true;
    void authClient.passkey.listUserPasskeys().then((result) => { if (active) setPasskeys((result.data ?? []) as Passkey[]); });
    return () => { active = false; };
  }, []);

  async function enable2FA(form: FormData) {
    setMessage("");
    const result = await authClient.twoFactor.enable({ password: String(form.get("password")), method: "totp" });
    if (result.error || !result.data || result.data.method !== "totp") return setMessage("No fue posible iniciar la configuración.");
    setTotpURI(result.data.totpURI); setBackupCodes(result.data.backupCodes);
  }
  async function confirm2FA(form: FormData) {
    const result = await authClient.twoFactor.verifyTotp({ code: String(form.get("code")), trustDevice: false });
    setMessage(result.error ? "Código inválido." : "Segundo factor configurado correctamente.");
    if (!result.error) window.location.reload();
  }
  async function addPasskey(form: FormData) {
    setMessage("");
    const verify = await reauthenticateAction({ ok: false, message: "" }, form);
    if (!verify.ok) return setMessage(verify.message);
    const result = await authClient.passkey.addPasskey({ name: String(form.get("name")) || undefined });
    setMessage(result.error ? "No fue posible registrar la passkey." : "Passkey registrada.");
    if (!result.error) await refreshPasskeys();
  }
  async function removePasskey(id: string) {
    const result = await authClient.passkey.deletePasskey({ id });
    setMessage(result.error ? "No fue posible eliminar la passkey." : "Passkey eliminada.");
    if (!result.error) await refreshPasskeys();
  }

  return <div className="stack gap-lg">
    {isAdmin && !twoFactorEnabled && <section className="card stack">
      <h2>2FA obligatorio</h2><p>Configura TOTP antes de usar funciones administrativas.</p>
      {!totpURI ? <form action={enable2FA} className="stack">
        <label>Contraseña actual<input name="password" type="password" minLength={12} required /></label>
        <button>Configurar autenticador</button>
      </form> : <>
        <p>Agrega esta URI en tu aplicación autenticadora:</p><code className="break">{totpURI}</code>
        <p>Guarda estos códigos de recuperación en un lugar seguro. No volverán a mostrarse.</p>
        <ul>{backupCodes.map((code) => <li key={code}><code>{code}</code></li>)}</ul>
        <form action={confirm2FA} className="stack"><label>Código de 6 dígitos<input name="code" inputMode="numeric" required /></label><button>Confirmar 2FA</button></form>
      </>}
    </section>}
    <section className="card stack">
      <h2>Passkeys</h2><p>Puedes usar varias passkeys. Para Admin, el ingreso sigue requiriendo contraseña y 2FA.</p>
      <form action={addPasskey} className="stack">
        <label>Nombre del dispositivo<input name="name" maxLength={100} placeholder="iPhone de trabajo" /></label>
        <label>Confirma tu contraseña<input name="password" type="password" minLength={12} required /></label>
        {isAdmin && <label>Código 2FA<input name="totp" inputMode="numeric" autoComplete="one-time-code" required /></label>}
        <button>Registrar passkey</button>
      </form>
      <ul className="plain-list">{passkeys.map((key) => <li key={key.id}><span>{key.name || "Passkey sin nombre"}</span><button className="danger secondary" onClick={() => void removePasskey(key.id)}>Revocar</button></li>)}</ul>
    </section>
    {message && <p role="status">{message}</p>}
  </div>;
}

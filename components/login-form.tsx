"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

export function LoginForm() {
  const router = useRouter();
  const [phase, setPhase] = useState<"password" | "totp">("password");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function login(form: FormData) {
    setPending(true); setError("");
    const result = await authClient.signIn.email({ email: String(form.get("email")), password: String(form.get("password")) });
    setPending(false);
    if (result.error) return setError("Correo o contraseña incorrectos, o la cuenta no está activa.");
    if (result.data && "twoFactorRedirect" in result.data && result.data.twoFactorRedirect) return setPhase("totp");
    router.push("/panel"); router.refresh();
  }

  async function verify(form: FormData) {
    setPending(true); setError("");
    const code = String(form.get("code")).trim();
    const recovery = form.get("recovery") === "on";
    const result = recovery
      ? await authClient.twoFactor.verifyBackupCode({ code, trustDevice: false })
      : await authClient.twoFactor.verifyTotp({ code, trustDevice: false });
    setPending(false);
    if (result.error) return setError("Código inválido o vencido.");
    router.push("/panel"); router.refresh();
  }

  return phase === "password" ? <form action={login} className="stack">
    <label>Correo corporativo<input name="email" type="email" autoComplete="username" required /></label>
    <label>Contraseña<input name="password" type="password" autoComplete="current-password" minLength={12} required /></label>
    {error && <p role="alert" className="error">{error}</p>}
    <button disabled={pending}>{pending ? "Ingresando…" : "Ingresar"}</button>
    <a href="/recuperar">Olvidé mi contraseña</a>
  </form> : <form action={verify} className="stack">
    <label>Código de autenticación<input name="code" inputMode="numeric" autoComplete="one-time-code" required /></label>
    <label className="check"><input name="recovery" type="checkbox" /> Usar código de recuperación</label>
    {error && <p role="alert" className="error">{error}</p>}
    <button disabled={pending}>{pending ? "Verificando…" : "Verificar"}</button>
  </form>;
}


"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";

export function AccountSecurity() {
  const [message, setMessage] = useState("");
  async function changePassword(form: FormData) {
    const result = await authClient.changePassword({ currentPassword: String(form.get("current")), newPassword: String(form.get("next")), revokeOtherSessions: true });
    setMessage(result.error ? "No fue posible cambiar la contraseña." : "Contraseña actualizada; las otras sesiones fueron cerradas.");
  }
  return <form action={changePassword} className="card stack">
    <h2>Cambiar contraseña</h2>
    <label>Contraseña actual<input name="current" type="password" autoComplete="current-password" required /></label>
    <label>Nueva contraseña<input name="next" type="password" minLength={12} autoComplete="new-password" required /></label>
    {message && <p role="status">{message}</p>}<button>Actualizar contraseña</button>
  </form>;
}


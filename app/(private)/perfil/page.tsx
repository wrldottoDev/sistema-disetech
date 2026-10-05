import { requirePagePrincipal } from "@/lib/authorization";
import { SecurityPanel } from "@/components/security-panel";
import { AccountSecurity } from "@/components/account-security";
import { ActionForm } from "@/components/action-form";
import { updatePhoneAction } from "@/app/actions/users";
export default async function ProfilePage() { const principal = await requirePagePrincipal(); return <div className="stack gap-lg"><h1>Perfil y seguridad</h1><ActionForm action={updatePhoneAction} submitLabel="Guardar teléfono"><label>Teléfono de trabajo<input name="phone" inputMode="tel" required /></label></ActionForm><AccountSecurity /><SecurityPanel isAdmin={principal.role === "ADMIN"} twoFactorEnabled={principal.twoFactorEnabled} /></div>; }

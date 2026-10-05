import { ActionForm } from "@/components/action-form";
import { confirmEmailAction } from "@/app/actions/users";
export default async function ConfirmEmailPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) { const { token = "" } = await searchParams; return <><h1>Confirma el correo</h1><ActionForm action={confirmEmailAction} submitLabel="Confirmar correo"><input type="hidden" name="token" value={token} /></ActionForm><a href="/login">Volver al ingreso</a></>; }

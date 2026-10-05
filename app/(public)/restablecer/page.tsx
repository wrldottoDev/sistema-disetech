import { ResetPasswordForm } from "@/components/recovery-forms";
export default async function ResetPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) { const { token = "" } = await searchParams; return <><h1>Nueva contraseña</h1><ResetPasswordForm token={token} /><a href="/login">Volver al ingreso</a></>; }

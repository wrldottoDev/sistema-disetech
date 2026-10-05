import { RecoveryRequestForm } from "@/components/recovery-forms";
export default function RecoveryPage() { return <><h1>Recuperar acceso</h1><p>Te enviaremos un enlace que vence en 30 minutos.</p><RecoveryRequestForm /><a href="/login">Volver al ingreso</a></>; }

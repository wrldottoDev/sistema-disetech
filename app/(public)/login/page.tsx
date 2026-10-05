import { redirect } from "next/navigation";
import { LoginForm } from "@/components/login-form";
import { getPrincipal } from "@/lib/authorization";
export default async function LoginPage() { if (await getPrincipal()) redirect("/panel"); return <><h1>Iniciar sesión</h1><p>Acceso privado para el equipo de DISETECH.</p><LoginForm /></>; }

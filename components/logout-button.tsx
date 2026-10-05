import { logoutAction } from "@/app/actions/security";
export function LogoutButton() { return <form action={logoutAction}><button className="secondary">Cerrar sesión</button></form>; }

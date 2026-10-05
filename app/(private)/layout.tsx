import Link from "next/link";
import { requirePagePrincipal } from "@/lib/authorization";
import { LogoutButton } from "@/components/logout-button";

type NavItem = { href: string; label: string };

export default async function PrivateLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const principal = await requirePagePrincipal();
  const can = (permission: string) => principal.permissions.has(permission);
  const adminReady = principal.role === "ADMIN" && principal.twoFactorEnabled;
  const items: NavItem[] = [
    { href: "/panel", label: "Inicio" },
    ...(can("quotations.manage_own") || can("quotations.view_all") ? [{ href: "/cotizaciones", label: "Cotizaciones" }] : []),
    ...(can("customers.view_own") || can("customers.view_all") ? [{ href: "/clientes", label: "Clientes" }] : []),
    { href: "/catalogo", label: "Catálogo" },
    { href: "/proveedores", label: "Proveedores" },
    ...(can("quotations.manage_own") || can("quotations.view_all") ? [{ href: "/costos", label: "Costos" }] : []),
    ...(adminReady ? [{ href: "/admin/usuarios", label: "Usuarios" }, { href: "/admin/empresas", label: "Empresas" }, { href: "/admin/configuracion", label: "Configuración" }, { href: "/admin/auditoria", label: "Auditoría" }] : []),
    { href: "/perfil", label: "Mi cuenta" },
  ];
  const links = items.map((item) => <Link key={item.href} href={item.href}>{item.label}</Link>);
  return (
    <>
      <a className="skip-link" href="#contenido">Saltar al contenido</a>
      <header className="app-header">
        <Link href="/panel" className="brand">DISETECH</Link>
        <nav aria-label="Principal" className="nav-desktop">{links}<LogoutButton /></nav>
        <details className="nav-mobile">
          <summary>Menú</summary>
          <nav aria-label="Principal (móvil)">{links}<LogoutButton /></nav>
        </details>
      </header>
      <main id="contenido" className="page-shell">{children}</main>
    </>
  );
}

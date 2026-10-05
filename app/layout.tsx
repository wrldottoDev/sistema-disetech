import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DISETECH",
  description: "Sistema privado de gestión comercial",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  allowedDevOrigins: ["127.0.0.1"],
  // Turbopack es el bundler por defecto (dev y build); el hook de webpack sólo se usa con `next dev --webpack` (E2E).
  turbopack: {},
  // pdfkit lee sus fuentes/AFM del disco en tiempo de ejecución: no se empaqueta.
  serverExternalPackages: ["pdfkit"],
  outputFileTracingIncludes: { "/api/cotizaciones/[id]/pdf": ["./lib/pdf/assets/**/*"], "/cotizaciones/[id]": ["./lib/pdf/assets/**/*"] },
  webpack(config, { dev }) {
    if (dev && process.env.DISABLE_WEBPACK_CACHE === "true") config.cache = false;
    return config;
  },
  async headers() {
    const scriptSrc = process.env.NODE_ENV === "development" ? "'self' 'unsafe-inline' 'unsafe-eval'" : "'self' 'unsafe-inline'";
    const securityHeaders = [
      { key: "Content-Security-Policy", value: `default-src 'self'; script-src ${scriptSrc}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'` },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), publickey-credentials-get=(self), publickey-credentials-create=(self)" },
      { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    ];
    if (process.env.NODE_ENV === "production") securityHeaders.push({ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" });
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;

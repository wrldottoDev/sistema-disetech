# DISETECH

Sistema interno de cotizaciones de Disetech: clientes, catálogo y proveedores, costos internos, cotizaciones con utilidad e IVA, aprobación gerencial, PDF fiel al formato oficial, envío por correo e historial. Next.js 16, PostgreSQL, Drizzle ORM y Better Auth.

## Desarrollo

1. Copia `.env.example` a `.env.local` y usa credenciales locales. Nunca uses la base de producción para desarrollo o pruebas.
2. Ejecuta las migraciones versionadas con `npm run db:migrate`.
3. Inicia con `npm run dev` y abre `http://localhost:3000/inicializar` para crear el primer Admin si todavía no existe ninguno.

El bootstrap sólo crea un Admin `PENDING_ACTIVATION`, sólo funciona una vez y envía una invitación. En desarrollo, `EMAIL_TRANSPORT=memory` evita cualquier correo real. Para una prueba manual del correo se recomienda aportar un adaptador local; `/api/test/emails` únicamente existe cuando `ENABLE_TEST_ENDPOINTS=true`.

## Seguridad de acceso

- No hay registro público. Los endpoints de signup y borrado físico de usuarios están deshabilitados.
- Las sesiones persisten en PostgreSQL hasta 30 días y pueden revocarse inmediatamente.
- Una invitación dura 24 horas; recuperación de contraseña, 30 minutos. Los identificadores de verificación e invitación se almacenan hasheados.
- Los Admin deben completar TOTP y conservar sus recovery codes antes de usar funciones administrativas.
- Better Auth no encadena TOTP automáticamente después de un login passwordless. Por política explícita, un Admin no puede iniciar sesión con passkey: usa password + TOTP/recovery code. Sus passkeys siguen disponibles para coexistencia y futura reautenticación; registrar una exige password + TOTP.
- Roles y permisos se consultan desde PostgreSQL en cada operación, evitando permisos obsoletos en sesiones existentes.
- Las acciones sensibles requieren reautenticación reciente (cinco minutos).

## Correo de producción

Configura `EMAIL_TRANSPORT=smtp` y las variables `SMTP_*` para Zoho. El remitente predeterminado es `info@disetechcr.com`. El transporte deshabilita acceso a archivos y URLs. No hay servidor SMTP propio.

## Flujo de negocio

1. El **Administrador** crea empresas, usuarios (los vendedores pertenecen a una empresa), cuentas de pago y registra el tipo de cambio (`/admin/configuracion`).
2. El **Vendedor** crea clientes propios, propone productos/proveedores, registra costos de proveedor y arma cotizaciones: cada línea tiene costo, proveedor y utilidad (**información interna**); el precio de venta se calcula `costo × (1 + utilidad/100)` (convertido con el tipo de cambio de venta si el costo está en otra moneda y redondeado a centavos) más IVA 13 %.
3. Líneas con utilidad menor al umbral configurado (25 % por defecto) requieren la **aprobación de un gerente** sobre la versión exacta antes de emitir.
4. **Emitir** asigna el folio `COT-AAAA-NNN` (función de BD con contador transaccional, sin duplicados) y congela la revisión. Para cambiar algo después se crea una **nueva revisión** (borrador) que conserva el folio.
5. **Enviar** genera el PDF, lo adjunta y envía el correo; sólo si el envío funciona la cotización pasa a `ENVIADA`. También puede marcarse como enviada manualmente.
6. Cierre: `GANADA`, `PERDIDA` o `CANCELADA` (estados finales, inmutables).

Roles: Admin (usuarios, empresas, configuración, auditoría, ve todo), Vendedor (sólo lo propio, filtrado en el servidor), Gerente Comercial / Administrativo (ven todo y registran revisiones; no modifican).

## Documentos PDF

`lib/quotations/client-document.ts` define lo único que ve el cliente (no tiene campos de costo, utilidad ni proveedor). `lib/pdf/quotation-pdf.ts` (pdfkit + fuente Arimo incluida en `lib/pdf/assets/`) reproduce el formato de la cotización de referencia (A4 horizontal, encabezado azul marino, tabla verde, totales, equivalencia CRC/USD, notas y datos de pago), con paginación automática y encabezado de tabla repetido. La vista previa (`/cotizaciones/:id/vista-previa`) usa el mismo `ClientDocument`. Los PDF de revisiones emitidas se generan una vez, se guardan en `DOCUMENT_STORAGE_DIR` (por defecto `./storage`) con su SHA-256 en `generated_documents` y se sirven desde allí en `/api/cotizaciones/:id/pdf`. Los borradores se generan al vuelo con marca de agua.

Los importes impresos suman los valores ya redondeados de cada línea para que el documento cuadre a simple vista; la BD conserva los totales exactos (diferencia máxima de centavos).

## Producción

```bash
npm ci
npm run db:migrate          # con la cadena del dueño del esquema (DATABASE_URL exportada)
psql "$OWNER_URL" -f db/sql/runtime-grants.sql   # tras cada migración nueva
npm run build && npm start
```

Variables obligatorias en producción: `DATABASE_URL` (rol no dueño `disetech_app`), `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (https), `AUDIT_HMAC_SECRET`, `EMAIL_TRANSPORT=smtp` + `SMTP_*` (Zoho: `smtp.zoho.com:465`, usuario `info@disetechcr.com` con contraseña de aplicación), `BOOTSTRAP_TOKEN`. El primer Admin se crea en `/inicializar` escribiendo ese token. El proxy debe reemplazar `X-Forwarded-For`.

## Calidad

```bash
npm run typecheck
npm run lint
npm test
npm run test:integration
npm run test:db
npm run test:e2e
npm run build
```

`test:integration` crea la base desechable `disetech_it_test`, la migra y ejecuta los servicios reales (aislamiento entre vendedores, cálculos, folios concurrentes, workflow, correo, PDF) conectándose como rol **no dueño** con los permisos de `runtime-grants.sql`. `scripts/seed-demo.ts` carga datos de demostración en una base local (`vendedor@demo.test`, `gerente@demo.test`).

Nota: `next build` necesita las variables de entorno obligatorias (pueden ser valores ficticios). Si el repositorio vive en iCloud Drive, macOS puede “evictar” archivos de `node_modules` y volver extremadamente lentos typecheck/tests/build; mantén el proyecto fuera de iCloud o excluye `node_modules`.

`test:db` fuerza una base local desechable llamada `disetech_test`, la reconstruye desde cero y la elimina. Playwright hace lo mismo con `disetech_e2e_test`; incluye Chromium desktop, Chrome móvil y WebKit móvil. WebKit es una aproximación automatizada a Safari, no una prueba en un iPhone físico.

Las migraciones viven en `drizzle/`. No se usa `drizzle-kit push` ni se migra automáticamente al arrancar la aplicación.

import { expect, test, type Page } from "@playwright/test";
import { generate } from "otplib";

const adminEmail = "admin.e2e@disetech.test";
const sellerEmail = "seller.e2e@disetech.test";
const password = "Correct-Horse-2026!";
let totpSecret = "";

async function latestLink(page: Page, recipient: string): Promise<string> {
  const response = await page.request.get("/api/test/emails");
  const emails = await response.json() as Array<{ to: string; text: string }>;
  const message = [...emails].reverse().find((email) => email.to === recipient);
  if (!message) throw new Error(`No test email for ${recipient}`);
  const link = message.text.match(/https?:\/\/\S+/)?.[0];
  if (!link) throw new Error("No activation link in test email");
  return link;
}

async function login(page: Page, email: string, withTotp = false) {
  await page.goto("/login");
  await page.getByLabel("Correo corporativo").fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Ingresar" }).click();
  if (withTotp) {
    await page.getByLabel("Código de autenticación").fill(await generate({ secret: totpSecret }));
    await page.getByRole("button", { name: "Verificar" }).click();
  }
  await expect(page).toHaveURL(/\/panel$/);
}

test("bootstrap, mandatory 2FA, private seller lifecycle and immediate deactivation", async ({ page, browser }) => {
  await page.goto("/inicializar");
  await page.getByLabel("Nombre completo").fill("Admin E2E");
  await page.getByLabel("Correo corporativo").fill(adminEmail);
  await page.getByLabel("Teléfono de trabajo").fill("8888-0001");
  await page.getByRole("button", { name: "Crear primer Admin" }).click();
  await expect(page.getByRole("status")).toContainText("activar");

  await page.goto(await latestLink(page, adminEmail));
  await page.getByLabel("Nueva contraseña").fill(password);
  await page.getByRole("button", { name: "Activar cuenta" }).click();
  await expect(page.getByRole("status")).toContainText("Cuenta activada");
  await login(page, adminEmail);
  await expect(page.locator("main")).toContainText("Configurar 2FA");
  await page.goto("/perfil");
  await page.getByLabel("Contraseña actual").nth(1).fill(password);
  await page.getByRole("button", { name: "Configurar autenticador" }).click();
  const uri = await page.locator("code.break").textContent();
  totpSecret = new URL(uri ?? "").searchParams.get("secret") ?? "";
  expect(totpSecret).not.toBe("");
  await page.getByLabel("Código de 6 dígitos").fill(await generate({ secret: totpSecret }));
  await page.getByRole("button", { name: "Confirmar 2FA" }).click();
  await expect(page).toHaveURL(/\/perfil$/);

  await page.waitForLoadState("networkidle");
  await page.goto("/admin/empresas");
  await page.getByLabel("Nombre", { exact: true }).fill("Empresa E2E");
  await page.getByRole("button", { name: "Crear empresa" }).click();
  await expect(page.getByRole("status")).toContainText("Empresa creada");
  await page.goto("/admin/configuracion");
  await page.getByLabel("Compra").fill("455");
  await page.getByLabel("Venta").fill("462.29");
  await page.getByRole("button", { name: "Registrar tipo de cambio" }).click();
  await expect(page.getByRole("status").first()).toContainText("Tipo de cambio registrado");

  await page.goto("/admin/usuarios");
  await page.getByRole("heading", { name: "Crear usuario" }).locator("..").getByLabel("Empresa").selectOption({ label: "Empresa E2E" });
  await page.getByRole("heading", { name: "Crear usuario" }).locator("..").getByLabel("Nombre completo").fill("Seller E2E");
  await page.getByRole("heading", { name: "Crear usuario" }).locator("..").getByLabel("Correo").fill(sellerEmail);
  await page.getByRole("heading", { name: "Crear usuario" }).locator("..").getByLabel("Teléfono").fill("8888-0002");
  await page.getByRole("button", { name: "Crear y enviar invitación" }).click();
  await expect(page.getByRole("status")).toContainText("Usuario creado");

  const seller = await browser.newContext();
  const sellerPage = await seller.newPage();
  await sellerPage.goto(await latestLink(page, sellerEmail));
  await sellerPage.getByLabel("Nueva contraseña").fill(password);
  await sellerPage.getByRole("button", { name: "Activar cuenta" }).click();
  await expect(sellerPage.getByRole("status")).toContainText("Cuenta activada");
  await login(sellerPage, sellerEmail);
  const cdp = await seller.newCDPSession(sellerPage);
  await cdp.send("WebAuthn.enable");
  const virtualAuthenticator = { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } } as const;
  let authenticatorId = (await cdp.send("WebAuthn.addVirtualAuthenticator", virtualAuthenticator)).authenticatorId;
  await sellerPage.goto("/perfil");
  const passkeySection = sellerPage.getByRole("heading", { name: "Passkeys" }).locator("xpath=ancestor::section");
  for (const name of ["Teléfono E2E", "Llave E2E"]) {
    // Un mismo autenticador no registra dos credenciales para el mismo usuario (excludeCredentials): cada passkey usa un dispositivo distinto.
    if (name === "Llave E2E") {
      await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
      authenticatorId = (await cdp.send("WebAuthn.addVirtualAuthenticator", virtualAuthenticator)).authenticatorId;
    }
    await passkeySection.getByLabel("Nombre del dispositivo").fill(name);
    await passkeySection.getByLabel("Confirma tu contraseña").fill(password);
    await passkeySection.getByRole("button", { name: "Registrar passkey" }).click();
    await expect(passkeySection).toContainText(name);
  }
  await passkeySection.getByRole("button", { name: "Revocar" }).first().click();
  await expect(passkeySection.getByRole("button", { name: "Revocar" })).toHaveCount(1);
  await sellerPage.goto("/admin/usuarios");
  await expect(sellerPage).toHaveURL(/\/panel$/);

  // Flujo comercial completo del vendedor: cliente -> cotización -> línea -> emisión -> PDF.
  sellerPage.on("dialog", (dialog) => void dialog.accept());
  await sellerPage.goto("/clientes/nuevo");
  await sellerPage.getByLabel("Nombre o razón social").fill("Cliente E2E");
  await sellerPage.getByLabel("Correo", { exact: true }).fill("cliente.e2e@example.test");
  await sellerPage.getByRole("button", { name: "Crear cliente" }).click();
  await expect(sellerPage).toHaveURL(/\/clientes\/[0-9a-f-]{36}$/);
  await sellerPage.getByRole("link", { name: "Nueva cotización" }).click();
  await sellerPage.getByLabel("Concepto").fill("Venta de material eléctrico");
  await sellerPage.getByRole("button", { name: "Crear borrador" }).click();
  await expect(sellerPage.getByRole("heading", { name: "Borrador" })).toBeVisible();
  await sellerPage.getByLabel("Descripción").fill("Ángulo UL interno blanco");
  await sellerPage.getByLabel("Cantidad").fill("5");
  await sellerPage.getByLabel("Costo unitario").fill("2800");
  await expect(sellerPage.getByText("Precio unitario de venta: ₡3,500.00")).toBeVisible();
  await sellerPage.getByRole("button", { name: "Agregar línea" }).click();
  await expect(sellerPage.getByRole("heading", { name: "Líneas (1)" })).toBeVisible();
  await sellerPage.getByRole("button", { name: "Emitir y asignar folio" }).click();
  // Al emitir, la página se recarga con el folio en el encabezado y los controles de edición desaparecen.
  await expect(sellerPage.getByRole("heading", { name: /^COT-\d{4}-\d{3,}/ })).toBeVisible();
  await expect(sellerPage.getByRole("button", { name: "Emitir y asignar folio" })).toHaveCount(0);
  const pdf = await sellerPage.request.get(sellerPage.url().replace(/\/cotizaciones\//, "/api/cotizaciones/") + "/pdf");
  expect(pdf.status()).toBe(200);
  expect((await pdf.body()).subarray(0, 4).toString()).toBe("%PDF");

  const admin = await browser.newContext();
  const adminPage = await admin.newPage();
  await login(adminPage, adminEmail, true);
  await adminPage.goto("/admin/usuarios");
  const sellerCard = adminPage.getByRole("heading", { name: "Seller E2E" }).locator("xpath=ancestor::article");
  await sellerCard.getByText("Sesiones y passkeys").click();
  await sellerCard.getByRole("button", { name: "Revocar passkey" }).click();
  await sellerCard.getByRole("button", { name: "Desactivar" }).click();
  await expect(sellerCard.getByRole("button", { name: "Reactivar por email" })).toBeVisible();
  await sellerPage.goto("/panel");
  await expect(sellerPage).toHaveURL(/\/login$/);
  await seller.close(); await admin.close();
});

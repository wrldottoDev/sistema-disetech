import { expect, test } from "@playwright/test";
test("mobile authentication form is usable", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Iniciar sesión" })).toBeVisible();
  await expect(page.getByLabel("Correo corporativo")).toBeVisible();
  await expect(page.getByRole("button", { name: "Ingresar" })).toBeVisible();
  const box = await page.getByRole("button", { name: "Ingresar" }).boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(44);
});

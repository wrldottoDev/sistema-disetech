"use server";

import { timingSafeEqual } from "node:crypto";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requirePrincipal } from "@/lib/authorization";
import { getServerEnv } from "@/lib/env";
import { AppError, safeError } from "@/lib/errors";
import { consumeRateLimit } from "@/lib/rate-limit";
import {
  activateUser,
  bootstrapFirstAdmin,
  changeEmailByAdmin,
  confirmEmailChange,
  changeRole,
  createUserByAdmin,
  deactivateUser,
  reactivateUser,
  resendActivation,
  updatePhone,
  updateNameByAdmin,
} from "@/lib/users/service";

export type ActionState = { ok: boolean; message: string; data?: Record<string, unknown> };
const ok = (message: string, data?: Record<string, unknown>): ActionState => ({ ok: true, message, data });
const fail = (error: unknown): ActionState => ({ ok: false, message: safeError(error) });

export async function bootstrapAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    const h = await headers();
    await consumeRateLimit("bootstrap", h.get("x-forwarded-for")?.split(",")[0] ?? "local", 60 * 15, 5);
    const expected = getServerEnv().BOOTSTRAP_TOKEN;
    const given = Buffer.from(String(form.get("token") ?? ""));
    if (expected && (given.length !== Buffer.byteLength(expected) || !timingSafeEqual(given, Buffer.from(expected)))) throw new AppError("FORBIDDEN", "Código de inicialización inválido.");
    await bootstrapFirstAdmin({ name: form.get("name"), email: form.get("email"), phone: form.get("phone"), role: "ADMIN" });
    return ok("Revisa el correo de pruebas o tu buzón para activar la cuenta.");
  } catch (error) { return fail(error); }
}

export async function activateAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    const h = await headers();
    await consumeRateLimit("activation", h.get("x-forwarded-for")?.split(",")[0] ?? "local", 60 * 15, 8);
    const result = await activateUser({ token: form.get("token"), password: form.get("password") });
    return ok(result.adminRequires2FA ? "Cuenta activada. Inicia sesión y configura 2FA." : "Cuenta activada. Ya puedes iniciar sesión.", result);
  } catch (error) { return fail(error); }
}

export async function createUserAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    const principal = await requirePrincipal();
    await createUserByAdmin(principal, { name: form.get("name"), email: form.get("email"), phone: form.get("phone"), role: form.get("role"), companyId: form.get("companyId") });
    revalidatePath("/admin/usuarios");
    return ok("Usuario creado e invitación enviada.");
  } catch (error) { return fail(error); }
}

export async function deactivateUserAction(form: FormData): Promise<void> {
  const principal = await requirePrincipal();
  await deactivateUser(principal, form.get("userId"), form.get("version"));
  revalidatePath("/admin/usuarios");
}

export async function reactivateUserAction(form: FormData): Promise<void> {
  const principal = await requirePrincipal();
  await reactivateUser(principal, form.get("userId"), form.get("version"));
  revalidatePath("/admin/usuarios");
}

export async function resendActivationAction(form: FormData): Promise<void> {
  const h = await headers();
  await consumeRateLimit("activation-resend", h.get("x-forwarded-for")?.split(",")[0] ?? "local", 60 * 15, 8);
  await resendActivation(await requirePrincipal(), form.get("userId"), form.get("version"));
  revalidatePath("/admin/usuarios");
}

export async function changeRoleAction(form: FormData): Promise<void> {
  const principal = await requirePrincipal();
  await changeRole(principal, form.get("userId"), form.get("role"), form.get("version"), form.get("companyId"));
  revalidatePath("/admin/usuarios");
}

export async function changeEmailAction(form: FormData): Promise<void> {
  const principal = await requirePrincipal();
  await changeEmailByAdmin(principal, form.get("userId"), form.get("email"), form.get("version"));
  revalidatePath("/admin/usuarios");
}

export async function confirmEmailAction(_: ActionState, form: FormData): Promise<ActionState> {
  try { await confirmEmailChange(form.get("token")); return ok("Correo confirmado. Inicia sesión nuevamente."); }
  catch (error) { return fail(error); }
}

export async function updatePhoneAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    await updatePhone(await requirePrincipal(), form.get("phone"));
    revalidatePath("/perfil");
    return ok("Teléfono actualizado.");
  } catch (error) { return fail(error); }
}

export async function updateNameAction(form: FormData): Promise<void> {
  await updateNameByAdmin(await requirePrincipal(), form.get("userId"), form.get("name"), form.get("version"));
  revalidatePath("/admin/usuarios");
}

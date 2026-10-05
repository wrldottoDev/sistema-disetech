import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { accounts, activationInvitations, auditLogs, companies, emailChangeRequests, passkeys, roles, sessions, twoFactors, users } from "@/db/schema";
import { auth } from "@/lib/auth";
import { type Principal, requirePermission, requireRecentAuthentication } from "@/lib/authorization";
import { sendEmail } from "@/lib/email";
import { getServerEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { activationSchema, createUserSchema, emailSchema, phoneSchema, roleSchema, uuidSchema, versionSchema } from "@/lib/validation";

const INVITATION_SECONDS = 60 * 60 * 24;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function sendActivation(email: string, token: string): Promise<void> {
  const url = new URL("/activar", getServerEnv().BETTER_AUTH_URL);
  url.searchParams.set("token", token);
  await sendEmail({ to: email, subject: "Activa tu cuenta de DISETECH", text: `Abre este enlace durante las próximas 24 horas:\n\n${url.toString()}` });
}

type CreatedInvitation = { userId: string; email: string; token: string };

async function createPendingUser(input: unknown, actor: Principal | null, bootstrap: boolean): Promise<CreatedInvitation> {
  const value = createUserSchema.parse(input);
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${bootstrap ? "disetech:first-admin" : value.email}))`);
    if (bootstrap) {
      const [existingAdmin] = await tx
        .select({ id: users.id })
        .from(users)
        .innerJoin(roles, eq(users.roleId, roles.id))
        .where(eq(roles.code, "ADMIN"))
        .limit(1);
      if (existingAdmin) throw new AppError("CONFLICT", "La inicialización ya fue utilizada.");
      if (value.role !== "ADMIN") throw new AppError("VALIDATION", "El primer usuario debe ser ADMIN.");
    }
    const [role] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.code, value.role)).limit(1);
    if (!role) throw new AppError("CONFLICT", "Los roles estructurales no están inicializados.");
    let companyId: string | null = null;
    if (value.role === "SELLER") {
      if (!value.companyId) throw new AppError("VALIDATION", "Un vendedor debe pertenecer a una empresa.");
      const [company] = await tx.select({ id: companies.id }).from(companies).where(and(eq(companies.id, value.companyId), eq(companies.isActive, true))).for("share").limit(1);
      if (!company) throw new AppError("VALIDATION", "La empresa no existe o está inactiva.");
      companyId = company.id;
    }
    const [existing] = await tx.select().from(users).where(eq(users.email, value.email)).limit(1);
    let userId: string;
    if (existing) {
      if (existing.status !== "PENDING_ACTIVATION") throw new AppError("CONFLICT", "Ya existe una cuenta con ese correo.");
      userId = existing.id;
      await tx.update(activationInvitations).set({ usedAt: new Date() }).where(and(eq(activationInvitations.userId, userId), isNull(activationInvitations.usedAt)));
    } else {
      const [created] = await tx.insert(users).values({ name: value.name, email: value.email, phone: value.phone, roleId: role.id, companyId }).returning({ id: users.id });
      userId = created.id;
    }
    await tx.insert(activationInvitations).values({ userId, tokenHash, expiresAt: new Date(Date.now() + INVITATION_SECONDS * 1000), createdByUserId: actor?.userId });
    await tx.insert(auditLogs).values({
      actorType: actor ? "USER" : "SYSTEM",
      actorUserId: actor?.userId,
      targetType: "user",
      targetId: userId,
      targetUserId: userId,
      action: bootstrap ? "USERS.BOOTSTRAP" : "USERS.CREATE",
      result: "SUCCESS",
      authSessionId: actor?.sessionId,
    });
    return { userId, email: value.email, token };
  });
  await sendActivation(result.email, result.token);
  return result;
}

export async function bootstrapFirstAdmin(input: unknown): Promise<{ userId: string }> {
  const parsed = createUserSchema.parse(input);
  const result = await createPendingUser({ ...parsed, role: "ADMIN" }, null, true);
  return { userId: result.userId };
}

export async function createUserByAdmin(principal: Principal, input: unknown): Promise<{ userId: string }> {
  requirePermission(principal, "users.manage");
  if (createUserSchema.parse(input).role === "ADMIN") requireRecentAuthentication(principal);
  const result = await createPendingUser(input, principal, false);
  return { userId: result.userId };
}

export async function activateUser(input: unknown): Promise<{ userId: string; adminRequires2FA: boolean }> {
  const value = activationSchema.parse(input);
  const context = await auth.$context;
  const passwordHash = await context.password.hash(value.password);
  return db.transaction(async (tx) => {
    const invitations = await tx.execute<{ id: string; user_id: string }>(sql`
      SELECT id, user_id FROM activation_invitations
      WHERE token_hash = ${hashToken(value.token)} AND used_at IS NULL AND expires_at > now()
      FOR UPDATE
    `);
    const invitation = invitations[0];
    if (!invitation) throw new AppError("VALIDATION", "La invitación no es válida o ya venció.");
    const [user] = await tx.select().from(users).where(eq(users.id, invitation.user_id)).for("update").limit(1);
    if (!user || user.status !== "PENDING_ACTIVATION") throw new AppError("VALIDATION", "La invitación no es válida.");
    const [role] = await tx.select({ code: roles.code }).from(roles).where(eq(roles.id, user.roleId)).limit(1);
    const [credential] = await tx.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.userId, user.id), eq(accounts.providerId, "credential"))).limit(1);
    if (credential) await tx.update(accounts).set({ password: passwordHash, updatedAt: new Date() }).where(eq(accounts.id, credential.id));
    else await tx.insert(accounts).values({ accountId: user.id, providerId: "credential", userId: user.id, password: passwordHash });
    await tx.delete(sessions).where(eq(sessions.userId, user.id));
    await tx.update(users).set({ status: "ACTIVE", emailVerified: true, activatedAt: new Date(), deactivatedAt: null, twoFactorEnabled: false }).where(eq(users.id, user.id));
    await tx.update(activationInvitations).set({ usedAt: new Date() }).where(eq(activationInvitations.id, invitation.id));
    await tx.insert(auditLogs).values({ actorType: "SYSTEM", targetType: "user", targetId: user.id, targetUserId: user.id, action: user.activatedAt ? "USERS.REACTIVATE" : "USERS.ACTIVATE", result: "SUCCESS" });
    return { userId: user.id, adminRequires2FA: role?.code === "ADMIN" };
  });
}

export async function deactivateUser(principal: Principal, targetIdInput: unknown, versionInput: unknown): Promise<void> {
  requirePermission(principal, "users.manage");
  requireRecentAuthentication(principal);
  const targetId = uuidSchema.parse(targetIdInput);
  const expectedVersion = versionSchema.parse(versionInput);
  if (principal.userId === targetId) throw new AppError("FORBIDDEN", "Un administrador no puede desactivarse a sí mismo.");
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('disetech:active-admin'))`);
    const rows = await tx.execute<{ id: string; role: string; status: string; version: number }>(sql`
      SELECT u.id, r.code AS role, u.status, u.version FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.id = ${targetId} FOR UPDATE OF u
    `);
    const target = rows[0];
    if (!target) throw new AppError("NOT_FOUND", "Usuario no encontrado.");
    if (target.version !== expectedVersion) throw new AppError("CONFLICT", "El usuario cambió; recarga antes de continuar.");
    if (target.role === "ADMIN") {
      const count = await tx.execute<{ count: string }>(sql`SELECT count(*)::text AS count FROM users u JOIN roles r ON r.id=u.role_id WHERE r.code='ADMIN' AND u.status='ACTIVE'`);
      if (Number(count[0]?.count) <= 1) throw new AppError("CONFLICT", "No puedes desactivar al último administrador activo.");
    }
    await tx.delete(sessions).where(eq(sessions.userId, targetId));
    await tx.update(activationInvitations).set({ usedAt: new Date() }).where(and(eq(activationInvitations.userId, targetId), isNull(activationInvitations.usedAt)));
    await tx.update(users).set({ status: "INACTIVE", deactivatedAt: new Date() }).where(eq(users.id, targetId));
    await tx.insert(auditLogs).values({ actorType: "USER", actorUserId: principal.userId, targetType: "user", targetId, targetUserId: targetId, action: "USERS.DEACTIVATE", result: "SUCCESS", authSessionId: principal.sessionId });
  });
}

export async function reactivateUser(principal: Principal, targetIdInput: unknown, versionInput: unknown): Promise<void> {
  requirePermission(principal, "users.manage");
  requireRecentAuthentication(principal);
  const targetId = uuidSchema.parse(targetIdInput);
  const expectedVersion = versionSchema.parse(versionInput);
  const token = randomBytes(32).toString("base64url");
  const [result] = await db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, targetId)).for("update").limit(1);
    if (!user || user.status !== "INACTIVE") throw new AppError("CONFLICT", "El usuario no está inactivo.");
    if (user.version !== expectedVersion) throw new AppError("CONFLICT", "El usuario cambió; recarga antes de continuar.");
    await tx.delete(sessions).where(eq(sessions.userId, user.id));
    // Una reactivación exige re-enrolar: las credenciales anteriores (passkeys, TOTP, recovery codes) no sobreviven.
    await tx.delete(passkeys).where(eq(passkeys.userId, user.id));
    await tx.delete(twoFactors).where(eq(twoFactors.userId, user.id));
    await tx.update(users).set({ status: "PENDING_ACTIVATION", activatedAt: null, deactivatedAt: null, twoFactorEnabled: false }).where(eq(users.id, user.id));
    await tx.update(activationInvitations).set({ usedAt: new Date() }).where(and(eq(activationInvitations.userId, user.id), isNull(activationInvitations.usedAt)));
    await tx.insert(activationInvitations).values({ userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + INVITATION_SECONDS * 1000), createdByUserId: principal.userId });
    await tx.insert(auditLogs).values({ actorType: "USER", actorUserId: principal.userId, targetType: "user", targetId: user.id, targetUserId: user.id, action: "USERS.REACTIVATION_REQUEST", result: "SUCCESS", authSessionId: principal.sessionId });
    return [{ email: user.email }];
  });
  await sendActivation(result.email, token);
}

export async function resendActivation(principal: Principal, targetIdInput: unknown, versionInput: unknown): Promise<void> {
  requirePermission(principal, "users.manage");
  const targetId = uuidSchema.parse(targetIdInput);
  const expectedVersion = versionSchema.parse(versionInput);
  const token = randomBytes(32).toString("base64url");
  const email = await db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, targetId)).for("update").limit(1);
    if (!user || user.status !== "PENDING_ACTIVATION") throw new AppError("CONFLICT", "El usuario no está pendiente de activación.");
    if (user.version !== expectedVersion) throw new AppError("CONFLICT", "El usuario cambió; recarga antes de continuar.");
    await tx.update(activationInvitations).set({ usedAt: new Date() }).where(and(eq(activationInvitations.userId, user.id), isNull(activationInvitations.usedAt)));
    await tx.insert(activationInvitations).values({ userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + INVITATION_SECONDS * 1000), createdByUserId: principal.userId });
    await tx.insert(auditLogs).values({ actorType: "USER", actorUserId: principal.userId, targetType: "user", targetId: user.id, targetUserId: user.id, action: "USERS.ACTIVATION_RESEND", result: "SUCCESS", authSessionId: principal.sessionId });
    return user.email;
  });
  await sendActivation(email, token);
}

export async function changeRole(principal: Principal, targetIdInput: unknown, roleInput: unknown, versionInput: unknown, companyInput?: unknown): Promise<void> {
  requirePermission(principal, "users.manage");
  requireRecentAuthentication(principal);
  const targetId = uuidSchema.parse(targetIdInput);
  const newRole = roleSchema.parse(roleInput);
  const expectedVersion = versionSchema.parse(versionInput);
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('disetech:active-admin'))`);
    const currentRows = await tx.execute<{ role: string; version: number; company_id: string | null }>(sql`SELECT r.code AS role, u.version, u.company_id FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=${targetId} FOR UPDATE OF u`);
    const current = currentRows[0];
    if (!current) throw new AppError("NOT_FOUND", "Usuario no encontrado.");
    if (current.version !== expectedVersion) throw new AppError("CONFLICT", "El usuario cambió; recarga antes de continuar.");
    if (current.role === "ADMIN" && newRole !== "ADMIN") {
      const count = await tx.execute<{ count: string }>(sql`SELECT count(*)::text AS count FROM users u JOIN roles r ON r.id=u.role_id WHERE r.code='ADMIN' AND u.status='ACTIVE'`);
      if (Number(count[0]?.count) <= 1) throw new AppError("CONFLICT", "No puedes degradar al último administrador activo.");
    }
    let companyId = current.company_id;
    if (newRole === "SELLER") {
      const wanted = companyId ?? createUserSchema.shape.companyId.parse(companyInput);
      if (!wanted) throw new AppError("VALIDATION", "Elige la empresa del nuevo vendedor.");
      // También la empresa que el usuario ya tenía debe seguir activa.
      const [company] = await tx.select({ id: companies.id }).from(companies).where(and(eq(companies.id, wanted), eq(companies.isActive, true))).for("share").limit(1);
      if (!company) throw new AppError("VALIDATION", "La empresa no existe o está inactiva.");
      companyId = company.id;
    }
    const [role] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.code, newRole)).limit(1);
    if (!role) throw new AppError("CONFLICT", "Rol no inicializado.");
    await tx.update(users).set({ roleId: role.id, companyId }).where(eq(users.id, targetId));
    // Los permisos cambian: las sesiones existentes (quizá con otro método de autenticación) no se heredan.
    await tx.delete(sessions).where(eq(sessions.userId, targetId));
    await tx.insert(auditLogs).values({ actorType: "USER", actorUserId: principal.userId, targetType: "user", targetId, targetUserId: targetId, action: "USERS.ROLE_CHANGE", result: "SUCCESS", authSessionId: principal.sessionId, metadata: { from: current.role, to: newRole } });
  });
}

export async function updatePhone(principal: Principal, phoneInput: unknown): Promise<void> {
  const phone = phoneSchema.parse(phoneInput);
  await db.transaction(async (tx) => {
    await tx.update(users).set({ phone }).where(eq(users.id, principal.userId));
    await tx.insert(auditLogs).values({ actorType: "USER", actorUserId: principal.userId, targetType: "user", targetId: principal.userId, targetUserId: principal.userId, action: "USERS.PHONE_CHANGE", result: "SUCCESS", authSessionId: principal.sessionId });
  });
}

export async function updateNameByAdmin(principal: Principal, targetIdInput: unknown, nameInput: unknown, versionInput: unknown): Promise<void> {
  requirePermission(principal, "users.manage");
  const targetId = uuidSchema.parse(targetIdInput);
  const name = createUserSchema.shape.name.parse(nameInput);
  const expectedVersion = versionSchema.parse(versionInput);
  await db.transaction(async (tx) => {
    const changed = await tx.update(users).set({ name }).where(and(eq(users.id, targetId), eq(users.version, expectedVersion))).returning({ id: users.id });
    if (!changed.length) throw new AppError("NOT_FOUND", "Usuario no encontrado.");
    await tx.insert(auditLogs).values({ actorType: "USER", actorUserId: principal.userId, targetType: "user", targetId, targetUserId: targetId, action: "USERS.NAME_CHANGE", result: "SUCCESS", authSessionId: principal.sessionId });
  });
}

export async function changeEmailByAdmin(principal: Principal, targetIdInput: unknown, emailInput: unknown, versionInput: unknown): Promise<void> {
  requirePermission(principal, "users.manage");
  requireRecentAuthentication(principal);
  const targetId = uuidSchema.parse(targetIdInput);
  const email = emailSchema.parse(emailInput);
  const expectedVersion = versionSchema.parse(versionInput);
  const token = randomBytes(32).toString("base64url");
  await db.transaction(async (tx) => {
    const [target] = await tx.select({ id: users.id }).from(users).where(eq(users.id, targetId)).for("update").limit(1);
    if (!target) throw new AppError("NOT_FOUND", "Usuario no encontrado.");
    const [current] = await tx.select({ version: users.version }).from(users).where(eq(users.id, targetId)).limit(1);
    if (current?.version !== expectedVersion) throw new AppError("CONFLICT", "El usuario cambió; recarga antes de continuar.");
    await tx.update(emailChangeRequests).set({ usedAt: new Date() }).where(and(eq(emailChangeRequests.userId, targetId), isNull(emailChangeRequests.usedAt)));
    await tx.insert(emailChangeRequests).values({ userId: targetId, newEmail: email, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 30 * 60 * 1000), requestedByUserId: principal.userId });
    await tx.insert(auditLogs).values({ actorType: "USER", actorUserId: principal.userId, targetType: "user", targetId, targetUserId: targetId, action: "USERS.EMAIL_CHANGE_REQUEST", result: "SUCCESS", authSessionId: principal.sessionId });
  });
  const url = new URL("/confirmar-correo", getServerEnv().BETTER_AUTH_URL);
  url.searchParams.set("token", token);
  await sendEmail({ to: email, subject: "Confirma tu nuevo correo de DISETECH", text: `Confirma el cambio durante los próximos 30 minutos:\n\n${url.toString()}` });
}

export async function confirmEmailChange(tokenInput: unknown): Promise<void> {
  const token = typeof tokenInput === "string" ? tokenInput : "";
  if (token.length < 32 || token.length > 256) throw new AppError("VALIDATION", "El enlace no es válido.");
  await db.transaction(async (tx) => {
    const rows = await tx.execute<{ id: string; user_id: string; new_email: string; requested_by_user_id: string }>(sql`
      SELECT id, user_id, new_email, requested_by_user_id FROM email_change_requests
      WHERE token_hash=${hashToken(token)} AND used_at IS NULL AND expires_at > now() FOR UPDATE
    `);
    const request = rows[0];
    if (!request) throw new AppError("VALIDATION", "El enlace no es válido o ya venció.");
    await tx.update(users).set({ email: request.new_email, emailVerified: true }).where(eq(users.id, request.user_id));
    await tx.delete(sessions).where(eq(sessions.userId, request.user_id));
    await tx.update(emailChangeRequests).set({ usedAt: new Date() }).where(eq(emailChangeRequests.id, request.id));
    await tx.insert(auditLogs).values({ actorType: "USER", actorUserId: request.requested_by_user_id, targetType: "user", targetId: request.user_id, targetUserId: request.user_id, action: "USERS.EMAIL_CHANGE", result: "SUCCESS" });
  });
}

export async function setSellerCompany(principal: Principal, targetIdInput: unknown, companyIdInput: unknown): Promise<void> {
  requirePermission(principal, "users.manage");
  const targetId = uuidSchema.parse(targetIdInput);
  const companyId = uuidSchema.parse(companyIdInput);
  await db.transaction(async (tx) => {
    const [target] = await tx.select({ role: roles.code }).from(users).innerJoin(roles, eq(roles.id, users.roleId)).where(eq(users.id, targetId)).for("update", { of: users }).limit(1);
    if (!target) throw new AppError("NOT_FOUND", "Usuario no encontrado.");
    if (target.role !== "SELLER") throw new AppError("VALIDATION", "Sólo los vendedores pertenecen a una empresa.");
    const [company] = await tx.select({ id: companies.id }).from(companies).where(and(eq(companies.id, companyId), eq(companies.isActive, true))).for("share").limit(1);
    if (!company) throw new AppError("VALIDATION", "La empresa no existe o está inactiva.");
    await tx.update(users).set({ companyId }).where(eq(users.id, targetId));
    await tx.insert(auditLogs).values({ actorType: "USER", actorUserId: principal.userId, targetType: "user", targetId, targetUserId: targetId, action: "USERS.SET_COMPANY", result: "SUCCESS", authSessionId: principal.sessionId, metadata: { companyId } });
  });
}

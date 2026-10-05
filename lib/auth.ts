import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { twoFactor } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { and, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { roles, users } from "@/db/schema";
import { sendEmail } from "@/lib/email";
import { getServerEnv } from "@/lib/env";
import { writeAudit } from "@/lib/audit";

const env = getServerEnv();

export const auth = betterAuth({
  appName: "DISETECH",
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, { provider: "pg", schema }),
  advanced: { database: { generateId: "uuid", validateSchema: true } },
  user: {
    modelName: "users",
    additionalFields: {
      phone: { type: "string", required: true, input: false },
      roleId: { type: "string", required: true, input: false },
      status: { type: "string", required: true, input: false },
      activatedAt: { type: "date", required: false, input: false },
      deactivatedAt: { type: "date", required: false, input: false },
      version: { type: "number", required: true, input: false },
    },
    deleteUser: { enabled: false },
  },
  session: {
    modelName: "sessions",
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
    freshAge: 60 * 5,
    cookieCache: { enabled: false },
    additionalFields: {
      authMethod: { type: "string", required: true, input: false, defaultValue: "password" },
      recentAuthAt: { type: "date", required: false, input: false },
    },
  },
  account: { modelName: "accounts" },
  verification: { modelName: "verifications", storeIdentifier: "hashed" },
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    requireEmailVerification: true,
    minPasswordLength: 12,
    maxPasswordLength: 128,
    resetPasswordTokenExpiresIn: 60 * 30,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url }) => {
      await sendEmail({ to: user.email, subject: "Restablece tu contraseña de DISETECH", text: `Abre este enlace durante los próximos 30 minutos:\n\n${url}` });
      await writeAudit({ targetUserId: user.id, action: "AUTH.RECOVERY_REQUEST", result: "SUCCESS" });
    },
    onPasswordReset: async ({ user }) => {
      await writeAudit({ actorUserId: user.id, targetUserId: user.id, action: "AUTH.RECOVERY_COMPLETE", result: "SUCCESS" });
    },
  },
  rateLimit: {
    enabled: true,
    storage: "database",
    modelName: "rateLimits",
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/email": { window: 60, max: 8 },
      "/request-password-reset": { window: 60 * 15, max: 5 },
      "/reset-password": { window: 60 * 15, max: 5 },
      "/two-factor/verify-totp": { window: 60, max: 6 },
      "/passkey/verify-authentication": { window: 60, max: 8 },
    },
  },
  databaseHooks: {
    session: {
      create: {
        before: async (session, context) => {
          const [record] = await db
            .select({ status: users.status, role: roles.code, twoFactorEnabled: users.twoFactorEnabled })
            .from(users)
            .innerJoin(roles, eq(users.roleId, roles.id))
            .where(eq(users.id, session.userId))
            .limit(1);
          if (!record || record.status !== "ACTIVE") return false;
          const path = context?.path ?? "";
          if (record.role === "ADMIN" && path.includes("passkey")) {
            throw new APIError("FORBIDDEN", { message: "Los administradores deben ingresar con contraseña y segundo factor." });
          }
          return { data: { ...session, authMethod: path.includes("passkey") ? "passkey" : "password", recentAuthAt: new Date() } };
        },
      },
    },
  },
  hooks: {
    after: createAuthMiddleware(async (ctx) => {
      const returned = ctx.context.returned;
      if (ctx.path === "/sign-in/email" && returned instanceof APIError) {
        const email = typeof ctx.body?.email === "string" ? ctx.body.email : undefined;
        if (email) await writeAudit({ attemptedIdentifier: email, action: "AUTH.LOGIN_FAILURE", result: "FAILURE", request: ctx.request });
        return;
      }
      const created = ctx.context.newSession;
      if (created && (ctx.path === "/sign-in/email" || ctx.path === "/two-factor/verify-totp" || ctx.path === "/two-factor/verify-backup-code")) {
        await writeAudit({ actorUserId: created.user.id, targetUserId: created.user.id, action: "AUTH.LOGIN_SUCCESS", result: "SUCCESS", request: ctx.request, authSessionId: created.session.id });
      }
      if (created && ctx.path === "/passkey/verify-authentication") {
        await writeAudit({ actorUserId: created.user.id, targetUserId: created.user.id, action: "AUTH.PASSKEY_LOGIN", result: "SUCCESS", request: ctx.request, authSessionId: created.session.id });
      }
      const current = ctx.context.session as { user?: { id?: string }; session?: { id?: string }; userId?: string; id?: string } | null | undefined;
      const userId = ctx.context.newSession?.user.id ?? current?.user?.id ?? current?.userId;
      // Si Better Auth rotó la sesión (cambio de contraseña/2FA), la vigente es la nueva, no la original.
      const sessionId = ctx.context.newSession?.session.id ?? current?.session?.id ?? current?.id;
      if (!userId) return;
      const actions: Record<string, string> = {
        "/change-password": "AUTH.PASSWORD_CHANGE",
        "/passkey/verify-registration": "AUTH.PASSKEY_REGISTER",
        "/passkey/delete-passkey": "AUTH.PASSKEY_REMOVE",
        "/two-factor/enable": "AUTH.TWO_FACTOR_SETUP",
        "/two-factor/disable": "AUTH.TWO_FACTOR_CHANGE",
      };
      const action = actions[ctx.path];
      if (action && !(returned instanceof APIError)) {
        if (sessionId && ["/change-password", "/two-factor/enable", "/two-factor/disable"].includes(ctx.path)) {
          await db.delete(schema.sessions).where(and(eq(schema.sessions.userId, userId), ne(schema.sessions.id, sessionId)));
        }
        if (ctx.path === "/change-password" && sessionId) {
          // Cambiar la contraseña NO acredita el segundo factor: para Admin el paso reforzado exige contraseña + TOTP (reauthenticateAction).
          const [owner] = await db.select({ role: roles.code }).from(users).innerJoin(roles, eq(roles.id, users.roleId)).where(eq(users.id, userId)).limit(1);
          if (owner && owner.role !== "ADMIN") await db.update(schema.sessions).set({ recentAuthAt: new Date() }).where(eq(schema.sessions.id, sessionId));
        }
        await writeAudit({ actorUserId: userId, targetUserId: userId, action, result: "SUCCESS", request: ctx.request, authSessionId: sessionId });
      }
    }),
  },
  plugins: [
    twoFactor({ twoFactorTable: "twoFactors", issuer: "DISETECH" }),
    passkey({
      rpName: "DISETECH",
      schema: { passkey: { modelName: "passkeys" } },
      authentication: {
        afterVerification: async ({ clientData }) => {
          const credentialId = typeof clientData.id === "string" ? clientData.id : "";
          const [owner] = await db
            .select({ role: roles.code, status: users.status })
            .from(schema.passkeys)
            .innerJoin(users, eq(users.id, schema.passkeys.userId))
            .innerJoin(roles, eq(roles.id, users.roleId))
            .where(eq(schema.passkeys.credentialID, credentialId))
            .limit(1);
          if (!owner || owner.status !== "ACTIVE") throw new APIError("UNAUTHORIZED", { message: "Cuenta no disponible." });
          if (owner.role === "ADMIN") throw new APIError("FORBIDDEN", { message: "Los administradores deben ingresar con contraseña y segundo factor." });
        },
      },
    }),
    nextCookies(),
  ],
  disabledPaths: ["/sign-up/email", "/delete-user"],
  telemetry: { enabled: false },
  onAPIError: { onError: (error) => console.error("Auth request failed", error instanceof APIError ? error.body?.code ?? error.status : "UNEXPECTED") },
});

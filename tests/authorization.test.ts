import { describe, expect, it } from "vitest";
import { canAccessOwnedResource, requireOwnedResource, requirePermission, requireRecentAuthentication, type Principal } from "@/lib/rbac";

const principal = (role: Principal["role"], userId = "seller-a", permissions = ["customers.view_own"]): Principal => ({
  role, userId, sessionId: "session", permissions: new Set(permissions), twoFactorEnabled: role !== "ADMIN" || true, recentAuthAt: new Date(),
});

describe("RBAC and ownership", () => {
  it("rejects a seller IDOR against another seller's resource", () => {
    const sellerA = principal("SELLER", "seller-a");
    expect(canAccessOwnedResource(sellerA, "seller-b")).toBe(false);
    expect(() => requireOwnedResource(sellerA, "seller-b")).toThrow(/acceso/);
  });
  it("allows the seller's own resource and global managerial scope", () => {
    expect(canAccessOwnedResource(principal("SELLER"), "seller-a")).toBe(true);
    expect(canAccessOwnedResource(principal("COMMERCIAL_MANAGER"), "seller-b")).toBe(true);
    expect(canAccessOwnedResource(principal("ADMINISTRATIVE_MANAGER"), "seller-b")).toBe(true);
  });
  it("does not infer admin operations from a role name", () => {
    expect(() => requirePermission(principal("SELLER"), "users.manage")).toThrow(/permiso/);
    expect(() => requirePermission(principal("COMMERCIAL_MANAGER"), "users.manage")).toThrow(/permiso/);
    expect(() => requirePermission(principal("ADMINISTRATIVE_MANAGER"), "users.manage")).toThrow(/permiso/);
  });
  it("blocks an admin without mandatory 2FA", () => {
    const admin = { ...principal("ADMIN", "admin", ["users.manage"]), twoFactorEnabled: false };
    expect(() => requirePermission(admin, "users.manage")).toThrow(/segundo factor/);
  });
  it("requires recent authentication for sensitive actions", () => {
    expect(() => requireRecentAuthentication({ ...principal("ADMIN"), recentAuthAt: new Date(Date.now() - 301_000) })).toThrow(/confirmar/);
    expect(() => requireRecentAuthentication(principal("ADMIN"))).not.toThrow();
  });
});

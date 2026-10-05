import { describe, expect, it } from "vitest";
import { activationSchema, createUserSchema, passwordSchema } from "@/lib/validation";

describe("auth validation", () => {
  it("enforces the 12 character password policy server-side", () => {
    expect(passwordSchema.safeParse("short").success).toBe(false);
    expect(passwordSchema.safeParse("twelve-chars!").success).toBe(true);
  });
  it("normalizes corporate email and accepts only fixed V1 roles", () => {
    const parsed = createUserSchema.parse({ name: "Ana Pérez", email: " ANA@EXAMPLE.COM ", phone: "+506 8888-8888", role: "SELLER" });
    expect(parsed.email).toBe("ana@example.com");
    expect(createUserSchema.safeParse({ ...parsed, role: "SUPERADMIN" }).success).toBe(false);
  });
  it("rejects malformed activation inputs", () => {
    expect(activationSchema.safeParse({ token: "tiny", password: "twelve-chars!" }).success).toBe(false);
  });
});

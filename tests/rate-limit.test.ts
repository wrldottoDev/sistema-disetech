import { describe, expect, it } from "vitest";
import { rateLimitKey } from "@/lib/rate-limit";

describe("sensitive operation rate-limit keys", () => {
  it("does not expose the network identity in storage", () => {
    const key = rateLimitKey("login", "203.0.113.9");
    expect(key).not.toContain("203.0.113.9");
    expect(key).toMatch(/^login:[0-9a-f]{64}$/);
  });
  it("cannot be bypassed by changing irrelevant form input", () => {
    expect(rateLimitKey("activation", "203.0.113.9")).toBe(rateLimitKey("activation", "203.0.113.9"));
    expect(rateLimitKey("activation", "203.0.113.9")).not.toBe(rateLimitKey("activation", "203.0.113.10"));
  });
});

import { describe, expect, it } from "vitest";

import { gravatarHash } from "@/backend/utils/gravatar";

describe("gravatarHash", () => {
  it("matches the canonical Gravatar example (trimmed + lower-cased)", () => {
    // Gravatar documentation example: "MyEmailAddress@example.com " once
    // trimmed and lower-cased hashes to this value.
    expect(gravatarHash("MyEmailAddress@example.com ")).toBe("0bc83cb571cd1c50ba6f3e8a78ef1346");
  });

  it("is case-insensitive", () => {
    expect(gravatarHash("Person@Example.COM")).toBe(gravatarHash("person@example.com"));
  });

  it("ignores surrounding whitespace", () => {
    expect(gravatarHash("  person@example.com  ")).toBe(gravatarHash("person@example.com"));
  });
});

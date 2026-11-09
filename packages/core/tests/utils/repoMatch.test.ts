import { describe, expect, it } from "vitest";

import { repoContainingPath, resolveToKnownRepo } from "@/backend/utils/repoMatch";

describe("repoContainingPath", () => {
  it("returns the repo whose root contains the file", () => {
    expect(repoContainingPath("/work/app/src/index.ts", ["/work/app", "/other"])).toBe("/work/app");
  });

  it("chooses the deepest repo when repos are nested", () => {
    expect(repoContainingPath("/work/app/sub/lib/x.ts", ["/work/app", "/work/app/sub"])).toBe(
      "/work/app/sub"
    );
  });

  it("matches the repo root path itself", () => {
    expect(repoContainingPath("/work/app", ["/work/app"])).toBe("/work/app");
  });

  it("does not match a sibling repo with a shared name prefix", () => {
    expect(repoContainingPath("/work/app2/x.ts", ["/work/app"])).toBeNull();
  });

  it("returns null when no repo contains the file", () => {
    expect(repoContainingPath("/elsewhere/x.ts", ["/work/app"])).toBeNull();
  });

  it("returns null for no repos", () => {
    expect(repoContainingPath("/work/app/x.ts", [])).toBeNull();
  });
});

// Fake realpath: /link/repo and /real/repo are the same repository.
const fakeRealpath = (p: string): string | null =>
  ({ "/link/repo": "/real/repo", "/real/repo": "/real/repo" })[p] ?? p;
const failingRealpath = (): string | null => null;

describe("resolveToKnownRepo", () => {
  it("returns the path unchanged when it is already a known repo", () => {
    expect(resolveToKnownRepo("/real/repo", ["/real/repo", "/other"], fakeRealpath)).toBe(
      "/real/repo"
    );
  });

  it("maps a symlinked path to the known repo with the same real path", () => {
    expect(resolveToKnownRepo("/link/repo", ["/real/repo"], fakeRealpath)).toBe("/real/repo");
  });

  it("returns null when no known repo shares the real path", () => {
    expect(resolveToKnownRepo("/link/repo", ["/unrelated"], fakeRealpath)).toBeNull();
  });

  it("returns null when the path cannot be resolved", () => {
    expect(resolveToKnownRepo("/missing", ["/real/repo"], failingRealpath)).toBeNull();
  });
});

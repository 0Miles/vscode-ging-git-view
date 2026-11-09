import { describe, expect, it, vi } from "vitest";

import { createBlameAvatars } from "@/extension/blameAvatars";

const SHA = "a".repeat(40);

function setup(opts: { enabled: boolean; cache?: Record<string, string> }) {
  const cache = opts.cache ?? {};
  const deps = {
    enabled: vi.fn(() => opts.enabled),
    cached: vi.fn(async (email: string) => cache[email] ?? null),
    fetch: vi.fn()
  };
  return { deps, avatarOf: createBlameAvatars(deps) };
}

describe("createBlameAvatars", () => {
  it("neither reads the cache nor fetches anything while avatars are off", async () => {
    const { deps, avatarOf } = setup({ enabled: false, cache: { "bea@example.com": "data:x" } });

    expect(await avatarOf({ authorEmail: "bea@example.com", sha: SHA }, "/repo")).toBeNull();
    expect(deps.cached).not.toHaveBeenCalled();
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("returns the cached avatar while avatars are on", async () => {
    const { deps, avatarOf } = setup({ enabled: true, cache: { "bea@example.com": "data:x" } });

    expect(await avatarOf({ authorEmail: "bea@example.com", sha: SHA }, "/repo")).toBe("data:x");
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("fetches an avatar not cached yet in the background, once, for the next hover", async () => {
    const { deps, avatarOf } = setup({ enabled: true });

    expect(await avatarOf({ authorEmail: "bo@example.com", sha: SHA }, "/repo")).toBeNull();
    expect(await avatarOf({ authorEmail: "bo@example.com", sha: SHA }, "/repo")).toBeNull();
    expect(deps.fetch).toHaveBeenCalledTimes(1);
    expect(deps.fetch).toHaveBeenCalledWith("bo@example.com", "/repo", [SHA]);
  });

  it("asks for nothing for an author without an email", async () => {
    const { deps, avatarOf } = setup({ enabled: true });

    expect(await avatarOf({ authorEmail: "", sha: SHA }, "/repo")).toBeNull();
    expect(deps.cached).not.toHaveBeenCalled();
    expect(deps.fetch).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";

import { createBlameAvatars } from "@/extension/blameAvatars";

const SHA = "a".repeat(40);
const BEA = { authorEmail: "bea@example.com", sha: SHA };

type Entry = { file: string; savedAt: number };

function setup(opts: { enabled: boolean; cache?: Record<string, Entry> }) {
  const cache = opts.cache ?? {};
  const deps = {
    enabled: vi.fn(() => opts.enabled),
    cached: vi.fn((email: string): Entry | null => cache[email] ?? null),
    read: vi.fn(async (file: string): Promise<string | null> => `data:${file}`),
    fetch: vi.fn()
  };
  return { deps, cache, avatarOf: createBlameAvatars(deps) };
}

describe("createBlameAvatars", () => {
  it("neither reads the cache nor fetches anything while avatars are off", async () => {
    const { deps, avatarOf } = setup({
      enabled: false,
      cache: { "bea@example.com": { file: "h.png", savedAt: 1 } }
    });

    expect(await avatarOf(BEA, "/repo")).toBeNull();
    expect(deps.cached).not.toHaveBeenCalled();
    expect(deps.read).not.toHaveBeenCalled();
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("returns the cached avatar while avatars are on", async () => {
    const { deps, avatarOf } = setup({
      enabled: true,
      cache: { "bea@example.com": { file: "h.png", savedAt: 1 } }
    });

    expect(await avatarOf(BEA, "/repo")).toBe("data:h.png");
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("reads a cached avatar's file once, not on every cursor move", async () => {
    const { deps, avatarOf } = setup({
      enabled: true,
      cache: { "bea@example.com": { file: "h.png", savedAt: 1 } }
    });

    await avatarOf(BEA, "/repo");
    expect(await avatarOf(BEA, "/repo")).toBe("data:h.png");
    expect(deps.read).toHaveBeenCalledTimes(1);
  });

  it("reads the file again once the cache holds another, or saved it anew", async () => {
    const { deps, cache, avatarOf } = setup({
      enabled: true,
      cache: { "bea@example.com": { file: "h.png", savedAt: 1 } }
    });
    await avatarOf(BEA, "/repo");

    cache["bea@example.com"] = { file: "h.jpeg", savedAt: 1 };
    expect(await avatarOf(BEA, "/repo")).toBe("data:h.jpeg");
    cache["bea@example.com"] = { file: "h.jpeg", savedAt: 2 };
    await avatarOf(BEA, "/repo");
    expect(deps.read).toHaveBeenCalledTimes(3);
  });

  it("fetches an avatar not cached yet in the background, once, for the next hover", async () => {
    const { deps, avatarOf } = setup({ enabled: true });
    const bo = { authorEmail: "bo@example.com", sha: SHA };

    expect(await avatarOf(bo, "/repo")).toBeNull();
    expect(await avatarOf(bo, "/repo")).toBeNull();
    expect(deps.fetch).toHaveBeenCalledTimes(1);
    expect(deps.fetch).toHaveBeenCalledWith("bo@example.com", "/repo", [SHA]);
  });

  it("fetches anew, once, an avatar whose cached file can't be read", async () => {
    const { deps, avatarOf } = setup({
      enabled: true,
      cache: { "bea@example.com": { file: "gone.png", savedAt: 1 } }
    });
    deps.read.mockResolvedValue(null);

    expect(await avatarOf(BEA, "/repo")).toBeNull();
    expect(await avatarOf(BEA, "/repo")).toBeNull();
    expect(deps.fetch).toHaveBeenCalledTimes(1);
  });

  it("asks for nothing for an author without an email", async () => {
    const { deps, avatarOf } = setup({ enabled: true });

    expect(await avatarOf({ authorEmail: "", sha: SHA }, "/repo")).toBeNull();
    expect(deps.cached).not.toHaveBeenCalled();
    expect(deps.fetch).not.toHaveBeenCalled();
  });
});

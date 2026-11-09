import * as fs from "node:fs";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AvatarManager, type AvatarConfig, type AvatarStore } from "@ging/core/avatarManager";
import type { Avatar, AvatarCache, ResponseMessage } from "@ging/shared/types";

import { rmrf } from "@ging/core/tests/helpers";

/**
 * AvatarManager against fakes of its two seams, AvatarConfig and AvatarStore
 * (the host passes its Config and ExtensionState). Whether it requested an
 * avatar rather than serving it from its cache is observable at the config: the
 * first thing a request does is ask for the git path. A request then goes on to
 * the network, so `https.get` is stubbed to one that never answers — nothing
 * leaves the machine, and no suite here cares what a download would bring.
 */

vi.mock("node:https", () => ({
  get: vi.fn(() => ({ on: vi.fn() }))
}));

const folders: string[] = [];

afterEach(() => {
  for (const folder of folders.splice(0)) rmrf(folder);
  vi.useRealTimers();
});

/** An avatar folder holding one image file, named the way the manager names them. */
function avatarFolder(file: string, bytes: string): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "ngg-avatars-"));
  folders.push(folder);
  fs.writeFileSync(path.join(folder, file), bytes);
  return folder;
}

function fakeConfig() {
  return { gitPath: vi.fn(() => "git"), gitLabToken: () => "" } satisfies AvatarConfig;
}

function fakeStore(folder: string, cache: AvatarCache) {
  return {
    getAvatarStoragePath: () => folder,
    getAvatarCache: () => cache,
    saveAvatar: vi.fn<(email: string, avatar: Avatar) => void>(),
    removeAvatarFromCache: vi.fn<(email: string) => void>(),
    clearAvatarCache: vi.fn<() => void>()
  } satisfies AvatarStore;
}

const EMAIL = "alice@example.com";
const REPO = "/repo";

/** Cached a minute ago: well inside the 14-day refresh window. */
function freshAvatar(image: string): Avatar {
  return { image, timestamp: Date.now() - 60_000, identicon: false };
}

describe("AvatarManager", () => {
  it("posts a fresh cached avatar from the store's folder without requesting it again", async () => {
    // The file holds the bytes "PNGDATA", which base64-encode to UE5HREFUQQ==.
    const folder = avatarFolder("abc.png", "PNGDATA");
    const config = fakeConfig();
    const manager = new AvatarManager(
      config,
      fakeStore(folder, { [EMAIL]: freshAvatar("abc.png") })
    );
    const posted: ResponseMessage[] = [];
    manager.registerBridge((msg) => posted.push(msg));

    manager.fetchAvatarImage(EMAIL, REPO, ["c1"]);

    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      command: "fetchAvatar",
      email: EMAIL,
      image: "data:image/png;base64,UE5HREFUQQ=="
    });
    expect(config.gitPath).not.toHaveBeenCalled();
  });

  it("posts nothing once the bridge is deregistered", async () => {
    const folder = avatarFolder("abc.png", "PNGDATA");
    const manager = new AvatarManager(
      fakeConfig(),
      fakeStore(folder, { [EMAIL]: freshAvatar("abc.png") })
    );
    const post = vi.fn();
    manager.registerBridge(post);
    manager.deregisterBridge();

    manager.fetchAvatarImage(EMAIL, REPO, ["c1"]);

    // Give a stray file read every chance to land before asserting it didn't.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(post).not.toHaveBeenCalled();
  });

  it("forgets an avatar in the store as well as in memory", async () => {
    // A request starts the queue's 10-second poll; keep it off the real clock.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const store = fakeStore(avatarFolder("abc.png", "PNGDATA"), {
      [EMAIL]: freshAvatar("abc.png")
    });
    const config = fakeConfig();
    const manager = new AvatarManager(config, store);
    const post = vi.fn();
    manager.registerBridge(post);

    manager.removeAvatarFromCache(EMAIL);
    manager.fetchAvatarImage(EMAIL, REPO, ["c1"]);

    expect(store.removeAvatarFromCache).toHaveBeenCalledWith(EMAIL);
    // The same fresh avatar the first case serves from the cache is requested
    // anew, and the old file is not posted in the meantime.
    expect(config.gitPath).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(https.get).toHaveBeenCalled());
    expect(post).not.toHaveBeenCalled();
  });

  it("clears the store's cache when its own is cleared", () => {
    const store = fakeStore(avatarFolder("abc.png", "PNGDATA"), {
      [EMAIL]: freshAvatar("abc.png")
    });
    const manager = new AvatarManager(fakeConfig(), store);

    manager.clearCache();

    expect(store.clearAvatarCache).toHaveBeenCalledTimes(1);
  });
});

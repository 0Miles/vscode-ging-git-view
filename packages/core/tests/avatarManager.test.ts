import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AvatarManager, type AvatarConfig, type AvatarStore } from "@ging/core/avatarManager";
import type { Avatar, AvatarCache, ResponseMessage } from "@ging/shared/types";

import { rmrf } from "@ging/core/tests/helpers";

/**
 * AvatarManager against the two narrow seams it now takes in place of the
 * extension's whole Config and ExtensionState. Only the paths that stay on this
 * machine are driven here: anything that re-requests an avatar goes on to ask
 * git for the remote and then the network, which is not a unit test's business.
 * Whether it re-requested is still observable — the first thing a request does
 * is ask the config for the git path.
 */

const folders: string[] = [];

afterEach(() => {
  for (const folder of folders.splice(0)) rmrf(folder);
});

/** An avatar folder holding one image file, named the way the manager names them. */
function avatarFolder(file: string, bytes: string): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "ngg-avatars-"));
  folders.push(folder);
  fs.writeFileSync(path.join(folder, file), bytes);
  return folder;
}

function fakeConfig(): AvatarConfig & { gitPath: ReturnType<typeof vi.fn> } {
  return { gitPath: vi.fn(() => "git"), gitLabToken: () => "" };
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
    // "PNGDATA" in base64.
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

  it("forgets an avatar in the store as well as in memory", () => {
    const store = fakeStore(avatarFolder("abc.png", "PNGDATA"), {
      [EMAIL]: freshAvatar("abc.png")
    });
    const manager = new AvatarManager(fakeConfig(), store);

    manager.removeAvatarFromCache(EMAIL);

    expect(store.removeAvatarFromCache).toHaveBeenCalledWith(EMAIL);
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

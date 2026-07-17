import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addTag } from "@/backend/actions/tag";

import { bareGit, git, makeRepo } from "@tests/backend/helpers";

let repo: string;
let commitHash: string;

beforeAll(() => {
  repo = makeRepo();
  commitHash = cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("addTag", () => {
  it("creates a lightweight tag at the given commit", async () => {
    await addTag(simpleGit(repo), {
      tagName: "v1.0-lw",
      commitHash,
      lightweight: true,
      message: "",
      pushToRemote: null,
      force: false
    });

    const tagName = cp
      .execFileSync("git", ["tag", "-l", "v1.0-lw"], { cwd: repo })
      .toString()
      .trim();
    expect(tagName).toBe("v1.0-lw");
  });

  it("creates an annotated tag at the given commit", async () => {
    await addTag(simpleGit(repo), {
      tagName: "v1.0",
      commitHash,
      lightweight: false,
      message: "Release v1.0",
      pushToRemote: null,
      force: false
    });

    const tagType = cp
      .execFileSync("git", ["cat-file", "-t", "v1.0"], { cwd: repo })
      .toString()
      .trim();
    expect(tagType).toBe("tag");
  });

  it("throws when the tag already exists", async () => {
    await expect(
      addTag(simpleGit(repo), {
        tagName: "v1.0-lw",
        commitHash,
        lightweight: true,
        message: "",
        pushToRemote: null,
        force: false
      })
    ).rejects.toThrow();
  });

  it("throws when the commit hash is invalid", async () => {
    await expect(
      addTag(simpleGit(repo), {
        tagName: "v2.0",
        commitHash: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        lightweight: true,
        message: "",
        pushToRemote: null,
        force: false
      })
    ).rejects.toThrow();
  });

  it("replaces an existing tag when force is set", async () => {
    // v1.0-lw was created at commitHash; make a newer commit and force-move it.
    fs.writeFileSync(path.join(repo, "tag-newer"), "x");
    cp.execFileSync("git", ["add", "."], { cwd: repo });
    cp.execFileSync("git", ["commit", "-m", "newer for tag"], { cwd: repo });
    const newer = cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();

    await addTag(simpleGit(repo), {
      tagName: "v1.0-lw",
      commitHash: newer,
      lightweight: true,
      message: "",
      pushToRemote: null,
      force: true
    });

    const resolved = cp
      .execFileSync("git", ["rev-list", "-n", "1", "v1.0-lw"], { cwd: repo })
      .toString()
      .trim();
    expect(resolved).toBe(newer);
  });

  it("pushes the new tag to the remote when pushToRemote is set", async () => {
    const r = makeRepo();
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), "neo-tagremote-"));
    try {
      cp.execFileSync("git", ["init", "--bare", "--initial-branch=main"], { cwd: remote });
      cp.execFileSync("git", ["remote", "add", "origin", remote], { cwd: r });
      cp.execFileSync("git", ["push", "origin", "main"], { cwd: r });
      const hash = cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: r }).toString().trim();

      await addTag(simpleGit(r), {
        tagName: "v9.0",
        commitHash: hash,
        lightweight: false,
        message: "released",
        pushToRemote: "origin",
        force: false
      });

      // The tag exists locally and on the remote.
      expect(cp.execFileSync("git", ["tag", "-l", "v9.0"], { cwd: r }).toString().trim()).toBe(
        "v9.0"
      );
      expect(bareGit(["tag", "-l", "v9.0"], remote).trim()).toBe("v9.0");
    } finally {
      fs.rmSync(r, { recursive: true, force: true });
      fs.rmSync(remote, { recursive: true, force: true });
    }
  });

  it("creates a signed annotated tag when signTags is true", async () => {
    const r = makeRepo();
    try {
      // Configure SSH tag signing (no GPG keyring needed).
      const keyPath = path.join(r, "signing_key");
      cp.execFileSync("ssh-keygen", ["-t", "ed25519", "-f", keyPath, "-N", "", "-q", "-C", "t"]);
      fs.chmodSync(keyPath, 0o600); // ssh refuses keys with group/other-readable perms
      git(["config", "gpg.format", "ssh"], r);
      git(["config", "user.signingkey", keyPath + ".pub"], r);
      const hash = cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: r }).toString().trim();

      await addTag(
        simpleGit(r),
        {
          tagName: "v-signed",
          commitHash: hash,
          lightweight: false,
          message: "signed release",
          pushToRemote: null,
          force: false
        },
        true
      );

      const tagObject = cp
        .execFileSync("git", ["cat-file", "tag", "v-signed"], { cwd: r })
        .toString();
      expect(tagObject).toContain("-----BEGIN SSH SIGNATURE-----");
    } finally {
      fs.rmSync(r, { recursive: true, force: true });
    }
  });
});

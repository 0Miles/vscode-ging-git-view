import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { tagDetails } from "@/backend/queries/tagDetails";

import { git, makeRepo } from "@tests/backend/helpers";

let repo: string;

beforeAll(() => {
  repo = makeRepo();
  cp.execFileSync("git", ["tag", "-a", "v1.0", "-m", "annotated tag message"], { cwd: repo });
  cp.execFileSync("git", ["tag", "lightweight1.0"], { cwd: repo });
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("tagDetails", () => {
  it("returns tagger details and message for an annotated tag", async () => {
    const result = await tagDetails(simpleGit(repo), { tagName: "v1.0" });
    expect(result.details).not.toBeNull();
    expect(result.details!.tagHash).toMatch(/^[0-9a-f]{40}$/);
    expect(result.details!.commitHash).toMatch(/^[0-9a-f]{40}$/);
    expect(result.details!.name).toEqual(expect.any(String));
    expect(result.details!.name.length).toBeGreaterThan(0);
    expect(result.details!.email).toEqual(expect.any(String));
    expect(result.details!.date).toEqual(expect.any(Number));
    expect(result.details!.message).toContain("annotated tag message");
  });

  it("reports an empty signature status for an unsigned annotated tag", async () => {
    const result = await tagDetails(simpleGit(repo), { tagName: "v1.0" });
    expect(result.details!.signatureStatus).toBe("");
  });

  it("reports a good signature status for an SSH-signed tag", async () => {
    const r = makeRepo();
    const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "ngg-tagsig-"));
    const keyPath = path.join(keyDir, "id");
    try {
      cp.execFileSync("ssh-keygen", ["-t", "ed25519", "-f", keyPath, "-N", "", "-q", "-C", "t"]);
      git(["config", "gpg.format", "ssh"], r);
      git(["config", "user.signingkey", keyPath + ".pub"], r);
      const pub = fs.readFileSync(keyPath + ".pub", "utf8").trim();
      const allowedSigners = path.join(keyDir, "allowed_signers");
      fs.writeFileSync(allowedSigners, `t@t.com ${pub}\n`);
      git(["config", "gpg.ssh.allowedSignersFile", allowedSigners], r);
      git(["tag", "-s", "signed-tag", "-m", "signed"], r);

      const result = await tagDetails(simpleGit(r), { tagName: "signed-tag" });
      expect(result.details!.signatureStatus).toBe("G");
    } finally {
      fs.rmSync(r, { recursive: true, force: true });
      fs.rmSync(keyDir, { recursive: true, force: true });
    }
  });

  it("returns null for a lightweight tag", async () => {
    const result = await tagDetails(simpleGit(repo), { tagName: "lightweight1.0" });
    expect(result.details).toBeNull();
  });

  it("returns null for a missing tag", async () => {
    const result = await tagDetails(simpleGit(repo), { tagName: "no-such-tag" });
    expect(result.details).toBeNull();
  });
});

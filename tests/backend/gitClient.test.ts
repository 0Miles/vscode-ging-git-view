import * as fs from "node:fs";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { gitClientFactory } from "@/backend/gitClient";

import { git, makeRepo } from "@tests/backend/helpers";

describe("gitClientFactory (real git)", () => {
  let repo: string;
  beforeAll(() => {
    repo = makeRepo();
  });
  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("runs commands with GIT_EDITOR set (needs unsafe.allowUnsafeEditor)", async () => {
    // The factory bakes in GIT_EDITOR=true; without unsafe.allowUnsafeEditor,
    // simple-git rejects EVERY command, which blanked the whole graph.
    const client = gitClientFactory(repo, "git");
    const head = await client.getInstance().raw(["rev-parse", "HEAD"]);
    expect(head.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  // Regression: simple-git spawns each git child with exactly the object handed
  // to .env(), NOT merged with process.env. The factory must rebuild that
  // inheritance, or the child loses HOME/PATH — git can't read ~/.gitconfig or
  // run credential helpers and pushes fail with "Repository not found".
  describe("inherits the parent environment", () => {
    const saved: Record<string, string | undefined> = {};
    const setEnv = (key: string, value: string) => {
      saved[key] = process.env[key];
      process.env[key] = value;
    };
    afterEach(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    it("forwards an inherited variable to git children", async () => {
      const marker = `ngg-marker-${process.pid}`;
      // A `!`-shell alias that echoes a variable only the parent knows: it can
      // only resolve if the spawned git inherited process.env.
      git(["config", "alias.nggechomarker", '!printf %s "$NGG_TEST_MARKER"'], repo);
      setEnv("NGG_TEST_MARKER", marker);
      const client = gitClientFactory(repo, "git");
      const out = await client.getInstance().raw(["nggechomarker"]);
      expect(out.trim()).toBe(marker);
    });

    it("drops vars simple-git would reject so every command still runs", async () => {
      // PAGER and GIT_CONFIG_COUNT are present in many shells; left in the env
      // they make simple-git throw "unsafe" on every command (we don't enable
      // their allowUnsafe* flags). They must be stripped before spawning.
      setEnv("PAGER", "less");
      setEnv("GIT_CONFIG_COUNT", "1"); // companion KEY/VALUE absent on purpose
      const client = gitClientFactory(repo, "git");
      const head = await client.getInstance().raw(["rev-parse", "HEAD"]);
      expect(head.trim()).toMatch(/^[0-9a-f]{40}$/);
    });
  });
});

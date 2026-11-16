import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";

import { Config } from "@ging/vscode/config";
import { RepoManager } from "@ging/vscode/extension/repoManager";
import { createRepoSearch } from "@ging/vscode/extension/workspaceSearch";

import { rmrf } from "@ging/core/tests/helpers";

import { useSharedRepo } from "./helpers";

/**
 * Mocha budget for a test that searches a directory tree.
 *
 * The search asks git about each directory it visits, one spawn apiece, and
 * the deepest tests here visit two. Nothing else is left in a test body: the
 * trees are built once per suite. Measured in the extension host on Windows,
 * those two spawns take 0.2–0.9s on an idle machine and 1.2–2.6s with every
 * core oversubscribed twice over, which is past Mocha's default 2000ms by
 * themselves (#425). With a typecheck and a lint run on top of that load, one
 * test took 8.0s. This is about four times that.
 */
const SEARCH_TIMEOUT_MS = 30_000;

function makeStubs(initialRepoPaths: string[] = [], maxDepth = 2, gitPath = "git") {
  const repos: Record<string, { columnWidths: null }> = {};
  for (const r of initialRepoPaths) repos[r] = { columnWidths: null };

  const added: string[] = [];
  let sendCount = 0;

  const repoManager = {
    getRepos: () => ({ ...repos }),
    addRepo: (path: string) => {
      repos[path] = { columnWidths: null };
      added.push(path);
    },
    sendRepos: () => {
      sendCount++;
    }
  };

  let currentMaxDepth = maxDepth;
  const config = {
    maxDepthOfRepoSearch: () => currentMaxDepth,
    gitPath: () => gitPath
  };

  const repoSearch = createRepoSearch(
    repoManager as unknown as RepoManager,
    config as unknown as Config
  );

  return {
    repoSearch,
    added,
    getSendCount: () => sendCount,
    setMaxDepth: (d: number) => {
      currentMaxDepth = d;
    }
  };
}

suite("workspaceSearch / searchDirectoryForRepos", function () {
  this.timeout(SEARCH_TIMEOUT_MS);

  // Every tree the tests search is laid out once, before the first test, and
  // removed after the last. No test writes to them, and building or removing
  // one inside a test spends that test's budget on it (#425).
  let repo: string;
  let fixtures: string;
  let plainDir: string;
  let nestedParent: string;
  let deepParent: string;

  useSharedRepo((dir) => {
    repo = dir;
  });

  suiteSetup(() => {
    fixtures = fs.mkdtempSync(repo + "-search-");
    plainDir = fixtures + "/plain";
    nestedParent = fixtures + "/nested";
    deepParent = fixtures + "/deep";
    fs.mkdirSync(plainDir);
    fs.cpSync(repo, nestedParent + "/nested-repo", { recursive: true });
    fs.cpSync(repo, deepParent + "/level1/level2/repo", { recursive: true });
  });

  // rmrf, not rmSync: the copies hold git's read-only objects. See `rmrf`.
  suiteTeardown(() => {
    rmrf(fixtures);
  });

  test("returns true and adds repo when a git repo is found", async () => {
    const { repoSearch, added } = makeStubs();
    const found = await repoSearch.searchDirectoryForRepos(repo, 0);
    assert.strictEqual(found, true);
    assert.deepStrictEqual(added, [repo]);
  });

  test("returns false for a non-repo directory", async () => {
    const { repoSearch, added } = makeStubs();
    const found = await repoSearch.searchDirectoryForRepos(plainDir, 0);
    assert.strictEqual(found, false);
    assert.deepStrictEqual(added, []);
  });

  test("returns false for a non-existent directory", async () => {
    const { repoSearch, added } = makeStubs();
    const missing = os.tmpdir() + "/ngg-does-not-exist-xyz";
    const found = await repoSearch.searchDirectoryForRepos(missing, 0);
    assert.strictEqual(found, false);
    assert.deepStrictEqual(added, []);
  });

  test("skips repos already in repoManager", async () => {
    const { repoSearch, added } = makeStubs([repo]);
    const found = await repoSearch.searchDirectoryForRepos(repo, 0);
    assert.strictEqual(found, false);
    assert.deepStrictEqual(added, []);
  });

  test("finds repo nested at depth 1", async () => {
    const { repoSearch, added } = makeStubs();
    const found = await repoSearch.searchDirectoryForRepos(nestedParent, 1);
    assert.strictEqual(found, true);
    assert.deepStrictEqual(added, [nestedParent + "/nested-repo"]);
  });

  test("does not find repos beyond maxDepth", async () => {
    const { repoSearch, added } = makeStubs();
    const found = await repoSearch.searchDirectoryForRepos(deepParent, 1);
    assert.strictEqual(found, false);
    assert.deepStrictEqual(added, []);
  });
});

suite("workspaceSearch / maxDepthChanged", () => {
  test("does not trigger workspace search when depth stays the same", () => {
    const { repoSearch, getSendCount, setMaxDepth } = makeStubs([], 2);
    setMaxDepth(2);
    repoSearch.maxDepthChanged();
    assert.strictEqual(getSendCount(), 0);
  });

  test("does not trigger workspace search when depth decreases", () => {
    const { repoSearch, getSendCount, setMaxDepth } = makeStubs([], 3);
    setMaxDepth(1);
    repoSearch.maxDepthChanged();
    assert.strictEqual(getSendCount(), 0);
  });

  test("after depth increase, same depth again does not re-trigger search", async () => {
    const { repoSearch, getSendCount, setMaxDepth } = makeStubs([], 2);
    setMaxDepth(5);
    repoSearch.maxDepthChanged(); // increases — may trigger workspace search depending on folders
    const countAfterIncrease = getSendCount();
    setMaxDepth(5); // same value, no increase
    repoSearch.maxDepthChanged();
    assert.strictEqual(getSendCount(), countAfterIncrease);
  });
});

import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { rmrf } from "@tests/backend/helpers";

/**
 * `scripts/check-l10n.js` is what CI runs (`pnpm run l10n:check`), so, as with
 * `checkAdr.test.ts`, these tests spawn the real script against a throwaway
 * layout and hold it to its exit code and the key it names.
 *
 * Only the punctuation rule is covered here. Each fixture writes the same
 * strings to the English base and to `zh-tw`, which keeps the completeness and
 * placeholder checks quiet — and shows in passing that the base file is never
 * held to a CJK punctuation rule.
 */

const SCRIPT = fileURLToPath(new URL("../../../scripts/check-l10n.js", import.meta.url));

type Strings = Record<string, string>;

interface Fixture {
  bundle?: Strings;
  nls?: Strings;
}

const roots: string[] = [];

function makeFixture({ bundle = {}, nls = {} }: Fixture): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ngg-l10n-"));
  roots.push(root);
  const write = (relative: string, content: unknown) => {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, JSON.stringify(content));
  };
  write("package.json", {});
  write("package.nls.json", nls);
  write("package.nls.zh-tw.json", nls);
  write("l10n/bundle.l10n.json", bundle);
  write("l10n/bundle.l10n.zh-tw.json", bundle);
  return root;
}

function run(root: string): { status: number | null; output: string } {
  const result = cp.spawnSync(process.execPath, [SCRIPT, root], { encoding: "utf8" });
  return { status: result.status, output: result.stdout + result.stderr };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmrf(root);
});

describe("check-l10n punctuation", () => {
  it("passes brackets that open and close at the same width", () => {
    const { status, output } = run(
      makeFixture({ bundle: { a: "Uncommitted 變更（{0}）", b: "Reset 目前 branch 到此(hard)" } })
    );

    expect(output).toContain("All translations are complete");
    expect(status).toBe(0);
  });

  it("reports a full-width bracket closed by a half-width one", () => {
    const { status, output } = run(makeFixture({ bundle: { uncommittedChanges: "變更（{0})" } }));

    expect(output).toContain("uncommittedChanges");
    expect(status).toBe(1);
  });

  it("reports a half-width bracket closed by a full-width one", () => {
    const { status, output } = run(makeFixture({ bundle: { mixed: "變更({0}）" } }));

    expect(output).toContain("mixed");
    expect(status).toBe(1);
  });

  it("reports a half-width comma next to a CJK character", () => {
    const { status, output } = run(
      makeFixture({ bundle: { "error.webviewFailed": "發生未預期的錯誤,有動作沒有完成。" } })
    );

    expect(output).toContain("error.webviewFailed");
    expect(status).toBe(1);
  });

  it("reports a half-width semicolon next to a CJK character", () => {
    const { status, output } = run(
      makeFixture({ bundle: { "dialog.cleanup.forceNote": "git 會拒絕刪除;完成後再詢問。" } })
    );

    expect(output).toContain("dialog.cleanup.forceNote");
    expect(status).toBe(1);
  });

  it("checks package.nls translations as well as the bundle", () => {
    const { status, output } = run(makeFixture({ nls: { description: "整合,多存放庫" } }));

    expect(output).toContain("description");
    expect(status).toBe(1);
  });

  // A comma between English words is English punctuation, even inside a
  // Chinese sentence; only one touching a CJK character is the defect.
  it("leaves a half-width comma between English words alone", () => {
    const { status, output } = run(
      makeFixture({ bundle: { list: "動作（merge, rebase）建立的 commit" } })
    );

    expect(output).toContain("All translations are complete");
    expect(status).toBe(0);
  });

  // The weekday header is split on the half-width comma in code, so there it
  // is a separator, not punctuation.
  it("exempts stats.weekdays, whose commas are a separator", () => {
    const { status, output } = run(makeFixture({ bundle: { "stats.weekdays": "日,一,二,三" } }));

    expect(output).toContain("All translations are complete");
    expect(status).toBe(0);
  });
});

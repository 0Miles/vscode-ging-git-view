import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { rmrf } from "@tests/backend/helpers";

/**
 * `scripts/check-adr.js` is what CI actually runs (`pnpm run adr:check`), and
 * its contract with CI is two things: the process exit code, and a message
 * naming the offending file. So that is the seam these tests drive — spawning
 * the real script against a throwaway repo layout — rather than importing some
 * inner function. A rule that reported perfectly but exited 0 would still let a
 * bad reference through, and only running the CLI can catch that.
 *
 * They live under `tests/backend` because that is this repo's node-environment
 * vitest project (the other one is jsdom); nothing here touches `src/backend`.
 *
 * The sample file bodies are in `checkAdr.fixtures.txt` rather than inline, so
 * that the deliberately-broken references in them stay out of a file the
 * checker reads. See that file's header for why that beats an exemption list.
 * The assertions below quote message fragments rather than whole lines for the
 * same reason.
 */

const SCRIPT = fileURLToPath(new URL("../../../scripts/check-adr.js", import.meta.url));

const FIXTURES = new Map(
  fs
    .readFileSync(new URL("./checkAdr.fixtures.txt", import.meta.url), "utf8")
    .split(/^== /m)
    .slice(1)
    .map((block) => {
      const heading = block.indexOf("\n");
      return [block.slice(0, heading).trim(), block.slice(heading + 1).trimEnd() + "\n"];
    })
);

/** A sample file body by name, so a typo fails loudly instead of writing "". */
function body(name: string): string {
  const content = FIXTURES.get(name);
  if (content === undefined) throw new Error(`checkAdr.fixtures.txt has no "${name}" block`);
  return content;
}

interface Fixture {
  /**
   * ADRs to create, keyed by bare filename — `null` for a throwaway body. The
   * ADR directory is assembled here rather than spelled out at each call site,
   * so no test has to write a literal path into it that the checker would then
   * read as a reference.
   */
  adrs?: Record<string, string | null>;
  /** Extra files, keyed by their path relative to the fixture root. */
  files?: Record<string, string>;
}

const roots: string[] = [];

function makeFixture({ adrs = { "0001-first.md": null }, files = {} }: Fixture): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ngg-adr-"));
  roots.push(root);
  const write = (relative: string, content: string) => {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  for (const [name, content] of Object.entries(adrs)) {
    write(path.join("docs", "adr", name), content ?? `# ${name}\n`);
  }
  for (const [relative, content] of Object.entries(files)) write(relative, content);
  return root;
}

function run(root: string): { status: number | null; output: string } {
  const result = cp.spawnSync(process.execPath, [SCRIPT, root], { encoding: "utf8" });
  return { status: result.status, output: result.stdout + result.stderr };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmrf(root);
});

describe("check-adr", () => {
  it("reports two ADRs that claim the same number", () => {
    const { status, output } = run(
      makeFixture({ adrs: { "0001-first.md": null, "0001-second.md": null } })
    );

    expect(output).toContain("0001 names 2 decisions");
    expect(status).toBe(1);
  });

  it("reports a path-form reference that `grep ADR-` would never surface", () => {
    const { status, output } = run(makeFixture({ files: { "src/thing.ts": body("path-only") } }));

    expect(output).toContain("src/thing.ts:2");
    expect(status).toBe(1);
  });

  // Naming the file next to the citation is genuinely useful — it saves the
  // reader a directory listing — so the rule is about the citation being
  // present, not about paths being forbidden.
  it("accepts a path that sits alongside the greppable citation", () => {
    const { status, output } = run(
      makeFixture({ files: { "docs/notes.md": body("labelled-path") } })
    );

    expect(output).toContain("every citation resolves");
    expect(status).toBe(0);
  });

  // ADRs cross-reference each other by relative link, which is the one place a
  // path-form reference is the natural thing to type — and so the likeliest
  // place for one to lose its citation.
  it("reports a sibling ADR link with no citation in its label", () => {
    const { status, output } = run(
      makeFixture({
        adrs: { "0001-first.md": null, "0002-second.md": body("sibling-link-unlabelled") }
      })
    );

    expect(output).toContain("0002-second.md:3");
    expect(status).toBe(1);
  });

  it("checks the root-level docs, where CONTEXT.md cites ADRs", () => {
    const { status, output } = run(
      makeFixture({ files: { "CONTEXT.md": body("dangling-citation") } })
    );

    expect(output).toContain("0099 is cited but no such ADR exists");
    expect(output).toContain("CONTEXT.md:1");
    expect(status).toBe(1);
  });

  // This repo really does have `docs/perf/2026-08-webview-large-window.md`, and
  // a rule that read any four-digit filename as an ADR would demand a citation
  // for the year. What keeps it legal is the directory a link crosses: a target
  // that reaches into another directory is somebody else's file. A target that
  // stays put is a sibling — and outside the ADR directory a sibling is just a
  // neighbouring document, so four digits there mean nothing.
  it("leaves four-digit filenames outside the ADR directory alone", () => {
    const { status, output } = run(
      makeFixture({
        adrs: { "0001-first.md": body("link-into-another-directory") },
        files: {
          "docs/perf/2026-08-window.md": "# Measurements\n",
          "docs/notes.md": body("sibling-link-outside-adr")
        }
      })
    );

    expect(output).toContain("every citation resolves");
    expect(status).toBe(0);
  });

  // The flip side, and the reason the rule can be this blunt inside the ADR
  // directory: a sibling link there resolves to a file in that directory, and
  // every file in it is an ADR. So a bare four-digit target names an ADR by
  // definition, and one nothing backs is a dead link worth the noise.
  it("reads a bare sibling link inside the ADR directory as naming an ADR", () => {
    const { status, output } = run(
      makeFixture({ adrs: { "0001-first.md": body("sibling-link-inside-adr") } })
    );

    expect(output).toContain("0001-first.md:3");
    expect(status).toBe(1);
  });

  // `docs/agents/domain.md` discusses the ADR directory for a living, so a
  // relative link from there is the natural way to write one — and just as
  // invisible to `grep ADR-` as the form the rule was built for.
  it("catches a path-form reference that omits the docs/ prefix", () => {
    const { status, output } = run(
      makeFixture({ files: { "docs/agents/guide.md": body("relative-path-reference") } })
    );

    expect(output).toContain("docs/agents/guide.md:1");
    expect(status).toBe(1);
  });

  // Reporting only the format leaves the reader to fix the wording, re-run CI,
  // and only then find out the ADR was never there. Both facts are known on the
  // first pass, so both get said.
  it("also says when a path-form reference names an ADR that does not exist", () => {
    const { status, output } = run(
      makeFixture({ files: { "src/thing.ts": body("path-to-missing-adr") } })
    );

    expect(output).toContain("0099 is cited but no such ADR exists");
    expect(status).toBe(1);
  });
});

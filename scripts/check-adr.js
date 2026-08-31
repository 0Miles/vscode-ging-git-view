/**
 * Hold the `ADR-NNNN` convention up: unique numbers, live citations, and no
 * reference written as a path.
 *
 * Two branches that each add an ADR both pick the next free number, both
 * correctly, and collide only once they are on main together — which has now
 * happened twice (see the renumbering commits). Nothing about the convention
 * prevents it, so this catches it at the point where both sides are finally
 * visible: a pull request's checks.
 *
 * The third rule exists because taking an inventory of an ADR's callers means
 * grepping `ADR-`, and a comment that says `docs/adr/NNNN` instead answers that
 * grep with silence: the reference is there, the inventory says it is not, and
 * the ADR looks safe to change. Rewriting the handful that had drifted was a
 * morning's work; without a check, the next one lands the same week and the
 * inventory is quietly wrong again. Naming the file is still allowed — the rule
 * asks only that the number appear in greppable form on the same line, so
 * `see ADR-0014 (docs/adr/0014-arrow-keys-....md)` passes and the path alone
 * does not.
 */

const fs = require("node:fs");
const path = require("node:path");

/**
 * The tree to check. Defaults to this repo, which is what CI runs; the argument
 * exists so the rules below can be driven against throwaway layouts in a test,
 * because a rule that only ever runs against a green repo is never observed
 * failing and can be silently wrong for as long as it likes.
 */
const ROOT = path.resolve(process.argv[2] ?? path.join(__dirname, ".."));
/** Named once: it is also how a file is recognised as an ADR further down. */
const ADR_DIR_NAME = "docs/adr";
const ADR_DIR = path.join(ROOT, ADR_DIR_NAME);
const SEARCH_ROOTS = ["docs", "src", "tests", "scripts"];
/**
 * Extensions worth reading. `.txt` is deliberately absent, and
 * `tests/backend/scripts/checkAdr.fixtures.txt` relies on that: the samples
 * proving these rules bite have to contain broken references, and a file the
 * checker never opens is a cheaper way to hold them than an exemption anyone
 * could later point at their own file.
 */
const SEARCH_EXTENSIONS = new Set([".md", ".ts", ".js", ".json"]);
/**
 * The one file whose ADR references would not be actionable.
 *
 * Nothing in `CHANGELOG.md` cites an ADR today, so this is prevention rather
 * than a fix: release-please generates the file from commit subjects, so any
 * citation that ever reaches it arrives from a commit message and cannot be
 * edited without rewriting release history. Were a renumbering to strand one,
 * CI would sit red over a line nobody can fix. `.oxfmtrc.jsonc` skips the file
 * for the same reason.
 */
const EXCLUDED = new Set(["CHANGELOG.md"]);
/** The greppable citation form the repo standardised on (see issue #59). */
const CITATION = /\bADR-(\d{4})\b/g;
/**
 * A reference that names an ADR by its location instead of its number.
 *
 * Anchored on `adr/` rather than `docs/adr/` so that a relative link written
 * from somewhere under `docs` — `](../adr/NNNN-slug.md)`, the natural form for
 * a page like `docs/agents/domain.md` that discusses ADRs for a living — is
 * caught too. It is exactly as invisible to `grep ADR-` as the repo-rooted
 * form, and no other directory in this repo is called `adr`.
 */
const PATH_REFERENCE = /\badr\/(\d{4})/g;
/**
 * A relative Markdown link from one ADR to a sibling, e.g. `](0014-slug.md)`.
 *
 * What makes this safe is whether a target *crosses a directory*, not whether
 * it contains a slash — `](./0014-slug.md)` has one and still names a sibling,
 * which is why the `./` is matched rather than excluded. A target that reaches
 * into another directory is left alone, and that is how a link to
 * `docs/perf/2026-08-webview-large-window.md` keeps its year from being read as
 * an ADR number. A target that stays put resolves to a sibling, and inside
 * `docs/adr` every sibling is an ADR, so four leading digits there name an ADR
 * by definition.
 *
 * Hence the rule applies only to files in `docs/adr`. Elsewhere the same text
 * is a link to a sibling of *that* file and has nothing to do with ADRs — a
 * page under `docs/` linking `](2026-08-window.md)` means the file next to it,
 * and reading four digits as an ADR number there would be pure invention.
 */
const SIBLING_LINK = /\]\((?:\.\/)?(\d{4})-[^)/]*\.md[^)/]*\)/g;

function adrFiles() {
  return fs
    .readdirSync(ADR_DIR)
    .filter((name) => name.endsWith(".md"))
    .toSorted();
}

/** A file's path as the report should name it: relative to ROOT, "/"-separated. */
function relativeTo(file) {
  return path.relative(ROOT, file).replace(/\\/g, "/");
}

/**
 * Every file a citation could live in, ADRs included.
 *
 * The repo root is searched alongside `SEARCH_ROOTS`, on the same extensions
 * rather than a narrower set — `CONTEXT.md` is the central domain document and
 * it cites ADRs, so leaving the root out made the file most likely to name a
 * decision the one file never checked for naming a decision that no longer
 * exists. Root files are not recursed into: the directories worth walking are
 * listed above, and the rest of the root is `node_modules` and build output.
 */
function searchableFiles() {
  const found = [];
  const add = (full) => {
    if (SEARCH_EXTENSIONS.has(path.extname(full)) && !EXCLUDED.has(relativeTo(full))) {
      found.push(full);
    }
  };
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else add(full);
    }
  };
  for (const root of SEARCH_ROOTS) {
    const full = path.join(ROOT, root);
    if (fs.existsSync(full)) walk(full);
  }
  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (entry.isFile()) add(path.join(ROOT, entry.name));
  }
  return found;
}

/** Record one `file:line` against an ADR number, in the shape both reports use. */
function note(map, number, at) {
  const where = map.get(number);
  if (where === undefined) map.set(number, [at]);
  else where.push(at);
}

function checkAdrs() {
  const files = adrFiles();
  const problems = [];

  // A number that names two decisions makes every citation of it ambiguous,
  // which is the whole value of the citation form.
  const byNumber = new Map();
  for (const name of files) {
    const match = /^(\d{4})-/.exec(name);
    if (match === null) {
      problems.push(`${name}: filename does not start with a four-digit number`);
      continue;
    }
    const existing = byNumber.get(match[1]);
    if (existing === undefined) byNumber.set(match[1], [name]);
    else existing.push(name);
  }
  for (const [number, names] of byNumber) {
    if (names.length > 1) {
      problems.push(`ADR-${number} names ${names.length} decisions:\n    ${names.join("\n    ")}`);
    }
  }

  // Both are number -> ["file:line", ...], so the two reports at the end are
  // built the same way and read the same way.
  const dangling = new Map();
  const unlabelled = new Map();
  for (const file of searchableFiles()) {
    const relative = relativeTo(file);
    // Sibling links resolve to an ADR only when the file doing the linking is
    // itself in the ADR directory; elsewhere the same text is just a filename.
    const forms = relative.startsWith(`${ADR_DIR_NAME}/`)
      ? [PATH_REFERENCE, SIBLING_LINK]
      : [PATH_REFERENCE];
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const at = `${relative}:${index + 1}`;
      const cited = new Set([...line.matchAll(CITATION)].map(([, number]) => number));
      const byPath = new Set();
      for (const form of forms) {
        for (const [, number] of line.matchAll(form)) {
          if (!cited.has(number)) byPath.add(number);
        }
      }

      // A citation with no ADR behind it is worse than none: it reads as though
      // the decision was recorded somewhere. A path counts as a citation here
      // even though the next rule rejects its form — both facts are known on
      // this pass, and reporting only the form would send the reader off to fix
      // the wording and re-run CI before learning the ADR was never there.
      for (const number of [...cited, ...byPath]) {
        if (!byNumber.has(number)) note(dangling, number, at);
      }

      // Cheap rule, stated once: whatever else the line says about an ADR, the
      // number has to be on it in the form a grep will find.
      for (const number of byPath) note(unlabelled, number, at);
    }
  }
  for (const [number, where] of dangling) {
    problems.push(`ADR-${number} is cited but no such ADR exists:\n    ${where.join("\n    ")}`);
  }
  for (const [number, where] of unlabelled) {
    problems.push(
      `ADR-${number} is named by path, which \`grep ADR-\` cannot find — write "ADR-${number}" on these lines:\n    ${where.join("\n    ")}`
    );
  }

  console.log(`\nChecking ${files.length} ADRs in ${ADR_DIR_NAME}\n`);
  if (problems.length === 0) {
    console.log("✅ ADR numbers are unique and every citation resolves, none by path alone\n");
    return;
  }
  for (const problem of problems) console.log(`  ✗ ${problem}`);
  console.log(`\n⚠️  ${problems.length} ADR problem(s) found\n`);
  process.exit(1);
}

checkAdrs();

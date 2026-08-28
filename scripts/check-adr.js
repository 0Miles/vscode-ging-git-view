/**
 * Check docs/adr for numbering collisions and dangling `ADR-NNNN` references.
 *
 * Two branches that each add an ADR both pick the next free number, both
 * correctly, and collide only once they are on main together — which has now
 * happened twice (see the renumbering commits). Nothing about the convention
 * prevents it, so this catches it at the point where both sides are finally
 * visible: a pull request's checks.
 */

const fs = require("node:fs");
const path = require("node:path");

const ADR_DIR = path.join(__dirname, "../docs/adr");
const SEARCH_ROOTS = ["docs", "src", "tests", "scripts"];
const SEARCH_EXTENSIONS = new Set([".md", ".ts", ".js", ".json"]);
/** The greppable citation form the repo standardised on (see issue #59). */
const CITATION = /\bADR-(\d{4})\b/g;

function adrFiles() {
  return fs
    .readdirSync(ADR_DIR)
    .filter((name) => name.endsWith(".md"))
    .toSorted();
}

/** Every source file a citation could live in, ADRs included. */
function searchableFiles() {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (SEARCH_EXTENSIONS.has(path.extname(entry.name))) found.push(full);
    }
  };
  for (const root of SEARCH_ROOTS) {
    const full = path.join(__dirname, "..", root);
    if (fs.existsSync(full)) walk(full);
  }
  return found;
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

  // A citation with no ADR behind it is worse than none: it reads as though
  // the decision was recorded somewhere.
  const dangling = new Map();
  for (const file of searchableFiles()) {
    const content = fs.readFileSync(file, "utf8");
    for (const [, number] of content.matchAll(CITATION)) {
      if (byNumber.has(number)) continue;
      const where = dangling.get(number) ?? [];
      const relative = path.relative(path.join(__dirname, ".."), file).replace(/\\/g, "/");
      if (!where.includes(relative)) where.push(relative);
      dangling.set(number, where);
    }
  }
  for (const [number, where] of dangling) {
    problems.push(`ADR-${number} is cited but no such ADR exists:\n    ${where.join("\n    ")}`);
  }

  console.log(`\nChecking ${files.length} ADRs in docs/adr\n`);
  if (problems.length === 0) {
    console.log("✅ ADR numbers are unique and every citation resolves\n");
    return;
  }
  for (const problem of problems) console.log(`  ✗ ${problem}`);
  console.log(`\n⚠️  ${problems.length} ADR problem(s) found\n`);
  process.exit(1);
}

checkAdrs();

/**
 * Backend suites shell out to real git, so their results depend on the ambient
 * git configuration of the machine running them.
 *
 * Git for Windows defaults to `core.autocrlf=true`, which rewrites LF to CRLF on
 * checkout — enough to break working-tree assertions like
 * `readFileSync(path.join(repo, "f"), "utf8") === "feature\n"`. Pin the
 * line-ending settings for every git process the tests spawn, including repos
 * created by `git clone`/`git init` that never pass through `makeRepo()`.
 *
 * `GIT_CONFIG_COUNT` + `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` (git >= 2.31) is
 * equivalent to passing `-c key=value`, so it wins over system, global and repo
 * config without any of those files being touched.
 */
const gitConfigOverrides: [string, string][] = [
  ["core.autocrlf", "false"],
  ["core.eol", "lf"]
];

process.env.GIT_CONFIG_COUNT = String(gitConfigOverrides.length);
for (const [i, [key, value]] of gitConfigOverrides.entries()) {
  process.env[`GIT_CONFIG_KEY_${i}`] = key;
  process.env[`GIT_CONFIG_VALUE_${i}`] = value;
}

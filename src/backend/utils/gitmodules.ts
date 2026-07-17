/**
 * Extract the `path = ...` value from each `[submodule "..."]` section of a
 * `.gitmodules` file, in declaration order. Lines outside a submodule section,
 * and properties other than `path`, are ignored.
 */
export function submodulePathsFromGitmodules(content: string): string[] {
  const paths: string[] = [];
  let insideSubmodule = false;
  // trim() on each line absorbs CR from CRLF files, so a plain "\n" split is enough.
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      insideSubmodule = /^\[submodule[\s"]/i.test(line);
    } else if (insideSubmodule) {
      const eq = line.indexOf("=");
      if (eq !== -1 && line.slice(0, eq).trim() === "path") {
        const value = line.slice(eq + 1).trim();
        if (value.length > 0) paths.push(value);
      }
    }
  }
  return paths;
}

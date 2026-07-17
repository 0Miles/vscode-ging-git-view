import * as fs from "node:fs";

/**
 * Resolve VS Code's `git.path` setting, which may be a single path, an array of
 * candidate paths (try each, use the first that exists), or unset. Falls back
 * to "git" (resolved via PATH) when nothing usable is configured.
 */
export function resolveGitPath(
  value: string | string[] | null | undefined,
  exists: (p: string) => boolean = fs.existsSync
): string {
  if (Array.isArray(value)) {
    const candidates = value.filter((p) => typeof p === "string" && p !== "");
    return candidates.find((p) => exists(p)) ?? candidates[0] ?? "git";
  }
  return typeof value === "string" && value !== "" ? value : "git";
}

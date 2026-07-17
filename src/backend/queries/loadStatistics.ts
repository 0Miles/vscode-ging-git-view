import type { SimpleGit } from "simple-git";

export type AuthorStat = { name: string; count: number; percent: number };
export type Statistics = {
  total: number;
  /** True when the log was capped, so the figures cover only recent history. */
  capped: boolean;
  /** The commit cap applied (shown in the "based on N commits" note). */
  limit: number;
  byAuthor: AuthorStat[];
  /** [weekday 0=Sun..6=Sat][hour 0..23] commit counts, in each author's own
   *  local time. */
  heatmap: number[][];
};

/** Parse `%aN<NUL>%aI` lines into author totals and a weekday/hour heatmap.
 *  Exported for unit testing without spawning git.
 *
 *  The heatmap bins by the author's *local* time: %aI is ISO-8601 with the
 *  author's UTC offset, so we read the date/hour fields as written (before any
 *  conversion to the host timezone) and derive the weekday via a UTC Date built
 *  from those fields — which avoids shifting the day across the offset. */
export function parseStatistics(stdout: string): Omit<Statistics, "capped" | "limit"> {
  const byAuthorMap = new Map<string, number>();
  const heatmap: number[][] = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  let total = 0;

  for (const line of stdout.split(/\r?\n/)) {
    const nul = line.indexOf("\0");
    if (nul === -1) continue;
    const name = line.slice(0, nul);
    if (name.length === 0) continue; // skip anonymous commits (empty author name)
    const iso = line.slice(nul + 1);
    total++;
    byAuthorMap.set(name, (byAuthorMap.get(name) ?? 0) + 1);
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):/);
    if (m !== null) {
      const weekday = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
      const hour = Number(m[4]);
      if (hour >= 0 && hour < 24) heatmap[weekday][hour]++;
    }
  }

  const byAuthor: AuthorStat[] = [...byAuthorMap.entries()]
    .map(([name, count]) => ({ name, count, percent: total > 0 ? (count / total) * 100 : 0 }))
    .toSorted((a, b) => b.count - a.count);

  return { total, byAuthor, heatmap };
}

/** Commit statistics across all branches (capped to keep huge repos snappy).
 *  Probes one extra commit so `capped` is only true when history really exceeds
 *  the cap (not when it happens to be exactly `maxCommits`). */
export async function loadStatistics(git: SimpleGit, maxCommits = 5000): Promise<Statistics> {
  const out = await git.raw([
    "log",
    "--all",
    `--max-count=${maxCommits + 1}`,
    "--format=%aN%x00%aI"
  ]);
  const parsed = parseStatistics(out);
  return { ...parsed, capped: parsed.total > maxCommits, limit: maxCommits };
}

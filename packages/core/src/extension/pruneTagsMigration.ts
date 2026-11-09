/**
 * A one-off rescue for the one cohort `fetch.prune`'s new `true` default can
 * hurt (ADR-0012).
 *
 * `--prune-tags` only ever reaches git's argv when both settings are on — that
 * is git's own rule, not ours, and `fetchFromRemotes` mirrors it. So while
 * `fetch.prune` defaulted to false, anyone who turned `fetch.pruneTags` on and
 * left `fetch.prune` alone was holding a setting that did **nothing**, silently:
 * no error, no warning, fetches looked normal. Flipping the default opens that
 * gate, and their very next fetch would start deleting local tags — an
 * irreversible loss they never asked for, on an upgrade they didn't configure.
 *
 * So on first activation after the flip, turn `fetch.pruneTags` back off for
 * exactly those users and tell them. Anyone who chose `fetch.prune` for
 * themselves — either way — is left alone: with pruneTags already visible next
 * to it, that choice was an informed one.
 *
 * This is transitional. Once the flip is far enough back that nobody upgrades
 * across it, the whole module and its `hasRun` flag can go.
 */

/** The two settings this reads, relative to the `ging-git-view` section. */
const PRUNE = "fetch.prune";
const PRUNE_TAGS = "fetch.pruneTags";

/** Where a setting can be written, ordered as VSCode overrides them. */
export type ConfigScope = "global" | "workspace" | "workspaceFolder";

/** The fields of `vscode.WorkspaceConfiguration.inspect` this decision reads.
 *  A scope is `undefined` exactly when nothing was written there. */
export type SettingInspection = {
  readonly globalValue?: unknown;
  readonly workspaceValue?: unknown;
  readonly workspaceFolderValue?: unknown;
};

const SCOPES: readonly { scope: ConfigScope; read: (i: SettingInspection) => unknown }[] = [
  { scope: "global", read: (i) => i.globalValue },
  { scope: "workspace", read: (i) => i.workspaceValue },
  { scope: "workspaceFolder", read: (i) => i.workspaceFolderValue }
];

/**
 * The scopes whose `fetch.pruneTags` must be turned off — those holding an
 * explicit `true` while `fetch.prune` holds no explicit value anywhere, meaning
 * it has only just inherited the new `true` default.
 */
export function pruneTagsScopesToClear(
  prune: SettingInspection | undefined,
  pruneTags: SettingInspection | undefined
): ConfigScope[] {
  if (prune === undefined || pruneTags === undefined) return [];
  // Any explicit value — true or false — means the user decided about pruning
  // with pruneTags in plain sight. Nothing to rescue them from.
  if (SCOPES.some(({ read }) => read(prune) !== undefined)) return [];
  return SCOPES.filter(({ read }) => read(pruneTags) === true).map(({ scope }) => scope);
}

export type PruneTagsMigrationDeps = {
  /** `WorkspaceConfiguration.inspect` for a `ging-git-view` key. */
  inspect: (key: string) => SettingInspection | undefined;
  /** Write `false` to `fetch.pruneTags` at one scope. */
  disablePruneTags: (scope: ConfigScope) => PromiseLike<unknown>;
  hasRun: () => boolean;
  markRun: () => void;
  /** Tell the user their tags were spared, and where the setting lives. */
  notify: () => void;
};

/**
 * Run the rescue once per install, and report the scopes it actually turned off.
 *
 * It marks itself done even when it clears nothing, so a `fetch.pruneTags` the
 * user turns on *later* — deliberately, knowing pruning is on — is never
 * quietly undone by a second pass.
 *
 * A scope that refuses the write is skipped rather than allowed to abort the
 * run: this is activation code, so an escaping rejection would surface as an
 * extension error, and losing `markRun` would leave it retrying every launch.
 */
export async function runPruneTagsMigration(deps: PruneTagsMigrationDeps): Promise<ConfigScope[]> {
  if (deps.hasRun()) return [];
  const cleared: ConfigScope[] = [];
  for (const scope of pruneTagsScopesToClear(deps.inspect(PRUNE), deps.inspect(PRUNE_TAGS))) {
    try {
      await deps.disablePruneTags(scope); // eslint-disable-line no-await-in-loop
      cleared.push(scope);
    } catch {
      // Nothing useful to do about it here — the notification still points the
      // user at the setting, which is where an unwritable scope shows up.
    }
  }
  deps.markRun();
  if (cleared.length > 0) deps.notify();
  return cleared;
}

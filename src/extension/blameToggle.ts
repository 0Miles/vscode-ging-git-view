/**
 * What `ging-git-view.blame.toggle` does: write the opposite of what the user
 * sees into the user-level setting. A workspace or folder value still wins over
 * that, so when the one in effect disagrees with the new value the user has to
 * be told — otherwise the toggle looks broken.
 */
export function blameToggle(state: {
  /** The value in effect now for the active file, overrides included. */
  effective: boolean;
  /** The workspace value, if one is set. */
  workspaceValue: boolean | undefined;
  /** The value set for the active file's workspace folder, if any. */
  workspaceFolderValue: boolean | undefined;
}): { next: boolean; overriddenByWorkspace: boolean } {
  const next = !state.effective;
  // The folder value is the more specific one, so it is the one that applies.
  const override = state.workspaceFolderValue ?? state.workspaceValue;
  return { next, overriddenByWorkspace: override !== undefined && override !== next };
}

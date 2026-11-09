/**
 * What `ging-git-view.blame.toggle` does: write the opposite of what the user
 * sees into the user-level setting. A workspace value still wins over that, so
 * when it disagrees with the new value the user has to be told — otherwise the
 * toggle looks broken.
 */
export function blameToggle(state: {
  /** The value in effect now, workspace included. */
  effective: boolean;
  /** The workspace (or workspace folder) value, if one is set. */
  workspaceValue: boolean | undefined;
}): { next: boolean; overriddenByWorkspace: boolean } {
  const next = !state.effective;
  return {
    next,
    overriddenByWorkspace: state.workspaceValue !== undefined && state.workspaceValue !== next
  };
}

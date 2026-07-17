/** Build the "create pull/merge request" URL for a branch, pre-filled with the
 *  branch as the source, from a remote's URL. Recognises the public
 *  GitHub / GitLab / Bitbucket hosts (HTTPS or SSH remote URLs); returns null
 *  for anything else, so callers can report that PR creation isn't supported. */
export function pullRequestCreateUrl(remoteUrl: string | null, branchName: string): string | null {
  if (remoteUrl === null) return null;
  // Capture host / owner / repo from both https://host/owner/repo[.git] and
  // git@host:owner/repo[.git] forms.
  const match = remoteUrl.match(/^(?:https:\/\/|git@)([^/:]+)[/:]([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (match === null) return null;
  const [, host, owner, repo] = match;
  const branch = encodeURIComponent(branchName);
  switch (host) {
    case "github.com":
      return `https://github.com/${owner}/${repo}/compare/${branch}?expand=1`;
    case "gitlab.com":
      return `https://gitlab.com/${owner}/${repo}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${branch}`;
    case "bitbucket.org":
      return `https://bitbucket.org/${owner}/${repo}/pull-requests/new?source=${branch}&t=1`;
    default:
      return null;
  }
}

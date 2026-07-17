export interface GitHubRemoteSource {
  type: "github";
  owner: string;
  repo: string;
}
export interface GitLabRemoteSource {
  type: "gitlab";
}
export interface GravatarRemoteSource {
  type: "gravatar";
}
export type RemoteSource = GitHubRemoteSource | GitLabRemoteSource | GravatarRemoteSource;

// GitHub remote in either HTTPS (https://github.com/owner/repo[.git]) or SSH
// (git@github.com:owner/repo[.git]) form; the .git suffix is optional.
const githubRegex = /^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+)\/(.+?)(?:\.git)?$/;

/**
 * Determine the avatar source for a repository from its remote URL.
 * Recognises GitHub and GitLab over both HTTPS and SSH; everything else (and a
 * missing remote) falls back to Gravatar.
 */
export function remoteSourceFromUrl(remoteUrl: string | null): RemoteSource {
  if (remoteUrl !== null) {
    const githubMatch = remoteUrl.match(githubRegex);
    if (githubMatch !== null) {
      return { type: "github", owner: githubMatch[1], repo: githubMatch[2] };
    }
    if (remoteUrl.startsWith("https://gitlab.com/") || remoteUrl.startsWith("git@gitlab.com:")) {
      return { type: "gitlab" };
    }
  }
  return { type: "gravatar" };
}

/**
 * Which host serves pull requests for a remote, and what URL opens the
 * "create a pull request from this branch" page there.
 *
 * The mapping is data, not code: a provider is a hostname plus the kind of
 * forge running on it, and the four built-in kinds each know their own URL
 * shape. That is what lets a self-hosted Gitea or GitLab be reached with one
 * line of settings, and it is why the mapping is a visible setting rather than
 * a switch buried in here — see ADR-0021.
 */

/** The forges whose URL shape ships with the extension, plus `custom` for a
 *  host whose URL the user spells out themselves. */
export type PullRequestProviderType = "github" | "gitlab" | "bitbucket" | "gitea" | "custom";

export const PULL_REQUEST_PROVIDER_TYPES: readonly PullRequestProviderType[] = [
  "github",
  "gitlab",
  "bitbucket",
  "gitea",
  "custom"
];

export type PullRequestProvider = {
  /** The remote's hostname, matched case-insensitively — "github.com",
   *  "git.example.com". Any port on the remote URL is ignored. */
  host: string;
  type: PullRequestProviderType;
  /** Required by (and only read for) `type: "custom"`. Placeholders:
   *  `{host}`, `{path}`, `{owner}`, `{repo}`, `{branch}`. */
  urlTemplate?: string;
};

/** The URL each built-in forge opens its "new pull request from this branch"
 *  page at. `{path}` rather than `{owner}/{repo}` so a GitLab subgroup path
 *  ("group/sub/repo") survives; the two are the same string everywhere else.
 *  `{scheme}` follows the remote, so an http-only self-hosted forge is reached
 *  over http rather than over a guess. */
export const BUILT_IN_TEMPLATES: Record<Exclude<PullRequestProviderType, "custom">, string> = {
  github: "{scheme}://{host}/{path}/compare/{branch}?expand=1",
  gitlab: "{scheme}://{host}/{path}/-/merge_requests/new?merge_request%5Bsource_branch%5D={branch}",
  bitbucket: "{scheme}://{host}/{path}/pull-requests/new?source={branch}&t=1",
  // Gitea (and Forgejo) read a compare path with no "..." as "default branch
  // against this one", which is exactly the page we want to land on.
  gitea: "{scheme}://{host}/{path}/compare/{branch}"
};

/**
 * The hosts that work without any configuration: the three public forges the
 * extension has always recognised, plus the two public Gitea/Forgejo instances.
 * A user-configured provider for the same host wins over these.
 */
export const BUILT_IN_PULL_REQUEST_PROVIDERS: readonly PullRequestProvider[] = [
  { host: "github.com", type: "github" },
  { host: "gitlab.com", type: "gitlab" },
  { host: "bitbucket.org", type: "bitbucket" },
  { host: "gitea.com", type: "gitea" },
  { host: "codeberg.org", type: "gitea" }
];

/** A remote URL reduced to what a provider URL is built from. */
export type ParsedRemoteUrl = {
  /** Lower-cased hostname, without user, port or scheme. */
  host: string;
  /** Repository path, without leading/trailing slashes and without ".git" —
   *  "owner/repo", or "group/sub/repo" on a GitLab subgroup. */
  path: string;
  /** The scheme the forge's web UI is reached over: "http" when the remote
   *  itself is http, "https" otherwise — including for ssh and scp remotes,
   *  which say nothing about the web UI. Optional so callers that only need
   *  the host can build one of these by hand. */
  scheme?: "http" | "https";
};

/**
 * Split a git remote URL into host and repository path. Handles the four forms
 * remotes are written in — `https://host/path`, `ssh://git@host:22/path`,
 * `git@host:path`, and `http://host:8080/path` — and returns null for anything
 * else (a local path, say), which callers report as "no provider for this".
 */
export function parseRemoteUrl(remoteUrl: string | null): ParsedRemoteUrl | null {
  if (remoteUrl === null) return null;
  const url = remoteUrl.trim();
  if (url === "") return null;
  // scp-style (`[user@]host:path`) is not a URL and has no scheme; the colon is
  // a separator, not a port, so it has to be matched before the URL forms.
  const scp = url.match(/^(?:[^@/]+@)?([^/:]+):(?!\/)(.+)$/);
  const match =
    scp ?? url.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/);
  if (match === null) return null;
  // The scp form has no scheme, so its capture groups sit one position earlier.
  const [host, rawPath] = scp === null ? [match[2], match[3]] : [match[1], match[2]];
  // Trailing slashes come off before ".git" does, so "owner/repo.git/" parses
  // the same as "owner/repo".
  const path = rawPath.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  if (host === "" || path === "") return null;
  return {
    host: host.toLowerCase(),
    path,
    scheme: scp === null && match[1].toLowerCase() === "http" ? "http" : "https"
  };
}

/**
 * Percent-encode a branch name for a provider URL, leaving `/` intact: branch
 * names are routinely hierarchical ("feature/login"), forges route on the raw
 * slashes, and a slash is legal unencoded in both a path and a query value.
 */
function encodeBranch(branchName: string): string {
  return branchName.split("/").map(encodeURIComponent).join("/");
}

/** Drop entries that cannot produce a URL, so a half-typed settings entry is
 *  ignored rather than silently building a broken link. */
export function normalizePullRequestProviders(value: unknown): PullRequestProvider[] {
  if (!Array.isArray(value)) return [];
  const providers: PullRequestProvider[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const { host, type, urlTemplate } = entry as Record<string, unknown>;
    if (typeof host !== "string" || host.trim() === "") continue;
    if (typeof type !== "string" || !PULL_REQUEST_PROVIDER_TYPES.includes(<never>type)) continue;
    // A custom template that never names the branch cannot pre-fill one, so it
    // is dropped here rather than opened as a link that ignores the branch. The
    // quick-pick enforces the same rule on the way in.
    if (
      type === "custom" &&
      (typeof urlTemplate !== "string" || !urlTemplate.includes("{branch}"))
    ) {
      continue;
    }
    providers.push({
      host: host.trim().toLowerCase(),
      type: <PullRequestProviderType>type,
      ...(typeof urlTemplate === "string" && urlTemplate.trim() !== ""
        ? { urlTemplate: urlTemplate.trim() }
        : {})
    });
  }
  return providers;
}

/**
 * The provider serving a remote's host, or null when none does. Configured
 * providers are searched before the built-ins, so a settings entry for
 * "github.com" replaces the built-in one rather than competing with it.
 */
export function findPullRequestProvider(
  host: string,
  providers: readonly PullRequestProvider[]
): PullRequestProvider | null {
  const wanted = host.toLowerCase();
  return (
    [...providers, ...BUILT_IN_PULL_REQUEST_PROVIDERS].find(
      (provider) => provider.host.toLowerCase() === wanted
    ) ?? null
  );
}

/** Fill a provider's URL template from a parsed remote and a branch name. */
export function fillPullRequestUrlTemplate(
  template: string,
  remote: ParsedRemoteUrl,
  branchName: string
): string {
  const lastSlash = remote.path.lastIndexOf("/");
  const values: Record<string, string> = {
    scheme: remote.scheme ?? "https",
    host: remote.host,
    path: remote.path,
    owner: lastSlash === -1 ? remote.path : remote.path.slice(0, lastSlash),
    repo: lastSlash === -1 ? remote.path : remote.path.slice(lastSlash + 1),
    branch: encodeBranch(branchName)
  };
  return template.replace(
    /\{(scheme|host|path|owner|repo|branch)\}/g,
    (_, key: string) => values[key]
  );
}

/**
 * Build the "create pull/merge request" URL for a branch, pre-filled with the
 * branch as the source. Returns null when the remote URL can't be parsed or no
 * provider covers its host — the caller reports that, and offers to configure
 * one for the host `parseRemoteUrl` found.
 */
export function pullRequestCreateUrl(
  remoteUrl: string | null,
  branchName: string,
  providers: readonly PullRequestProvider[] = []
): string | null {
  const remote = parseRemoteUrl(remoteUrl);
  if (remote === null) return null;
  const provider = findPullRequestProvider(remote.host, providers);
  if (provider === null) return null;
  const template =
    provider.type === "custom" ? provider.urlTemplate : BUILT_IN_TEMPLATES[provider.type];
  if (template === undefined || template === "") return null;
  return fillPullRequestUrlTemplate(template, remote, branchName);
}

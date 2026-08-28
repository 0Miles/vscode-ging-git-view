import { describe, expect, it } from "vitest";

import {
  fillPullRequestUrlTemplate,
  findPullRequestProvider,
  normalizePullRequestProviders,
  parseRemoteUrl,
  pullRequestCreateUrl,
  type PullRequestProvider
} from "@/backend/utils/pullRequest";

describe("parseRemoteUrl", () => {
  it("reads host and path from every remote spelling", () => {
    expect(parseRemoteUrl("https://github.com/owner/repo.git")).toEqual({
      host: "github.com",
      path: "owner/repo",
      scheme: "https"
    });
    expect(parseRemoteUrl("git@github.com:owner/repo")).toEqual({
      host: "github.com",
      path: "owner/repo",
      scheme: "https"
    });
    expect(parseRemoteUrl("ssh://git@git.example.com:2222/owner/repo.git")).toEqual({
      host: "git.example.com",
      path: "owner/repo",
      scheme: "https"
    });
    expect(parseRemoteUrl("http://git.example.com:3000/owner/repo/")).toEqual({
      host: "git.example.com",
      path: "owner/repo",
      scheme: "http"
    });
  });

  it("only calls the scheme http when the remote itself is http", () => {
    // ssh and scp remotes say nothing about the web UI, so they get https.
    expect(parseRemoteUrl("ssh://git@git.example.com/o/r")?.scheme).toBe("https");
    expect(parseRemoteUrl("git@git.example.com:o/r")?.scheme).toBe("https");
    expect(parseRemoteUrl("HTTP://git.example.com/o/r")?.scheme).toBe("http");
  });

  it("keeps a nested group path whole and lower-cases only the host", () => {
    expect(parseRemoteUrl("https://GitLab.com/Group/Sub/Repo.git")).toMatchObject({
      host: "gitlab.com",
      path: "Group/Sub/Repo"
    });
  });

  it("returns null for anything that is not a host and a repository path", () => {
    expect(parseRemoteUrl(null)).toBeNull();
    expect(parseRemoteUrl("")).toBeNull();
    expect(parseRemoteUrl("/srv/git/repo.git")).toBeNull();
    expect(parseRemoteUrl("https://github.com/")).toBeNull();
  });
});

describe("pullRequestCreateUrl", () => {
  it("builds a GitHub compare URL from an https remote", () => {
    expect(pullRequestCreateUrl("https://github.com/owner/repo.git", "dev")).toBe(
      "https://github.com/owner/repo/compare/dev?expand=1"
    );
  });

  it("builds a GitHub URL from an ssh remote", () => {
    expect(pullRequestCreateUrl("git@github.com:owner/repo", "dev")).toBe(
      "https://github.com/owner/repo/compare/dev?expand=1"
    );
  });

  it("builds a GitLab merge-request URL, subgroups included", () => {
    expect(pullRequestCreateUrl("https://gitlab.com/grp/sub/proj.git", "dev")).toBe(
      "https://gitlab.com/grp/sub/proj/-/merge_requests/new?merge_request%5Bsource_branch%5D=dev"
    );
  });

  it("builds a Bitbucket pull-request URL", () => {
    expect(pullRequestCreateUrl("git@bitbucket.org:team/repo.git", "dev")).toBe(
      "https://bitbucket.org/team/repo/pull-requests/new?source=dev&t=1"
    );
  });

  it("covers the public Gitea and Forgejo hosts without configuration", () => {
    expect(pullRequestCreateUrl("https://gitea.com/owner/repo.git", "dev")).toBe(
      "https://gitea.com/owner/repo/compare/dev"
    );
    expect(pullRequestCreateUrl("git@codeberg.org:owner/repo.git", "dev")).toBe(
      "https://codeberg.org/owner/repo/compare/dev"
    );
  });

  it("keeps the slashes in a hierarchical branch name and escapes the rest", () => {
    // Forges route on the raw slashes; a space still has to be encoded.
    expect(pullRequestCreateUrl("https://github.com/owner/repo", "feature/my x")).toBe(
      "https://github.com/owner/repo/compare/feature/my%20x?expand=1"
    );
  });

  it("returns null for an unconfigured host or missing remote", () => {
    expect(pullRequestCreateUrl("https://example.com/owner/repo.git", "dev")).toBeNull();
    expect(pullRequestCreateUrl(null, "dev")).toBeNull();
  });

  it("reaches an http-only self-hosted forge over http, not a guessed https", () => {
    const providers: PullRequestProvider[] = [{ host: "git.internal", type: "gitea" }];
    expect(pullRequestCreateUrl("http://git.internal/owner/repo.git", "dev", providers)).toBe(
      "http://git.internal/owner/repo/compare/dev"
    );
  });

  it("reaches a self-hosted forge from one configured provider", () => {
    const providers: PullRequestProvider[] = [{ host: "git.example.com", type: "gitea" }];
    expect(
      pullRequestCreateUrl("ssh://git@git.example.com:2222/owner/repo.git", "dev", providers)
    ).toBe("https://git.example.com/owner/repo/compare/dev");
  });

  it("lets a configured provider replace a built-in host", () => {
    const providers: PullRequestProvider[] = [{ host: "github.com", type: "gitea" }];
    expect(pullRequestCreateUrl("https://github.com/owner/repo", "dev", providers)).toBe(
      "https://github.com/owner/repo/compare/dev"
    );
  });

  it("follows a custom provider's own template", () => {
    const providers: PullRequestProvider[] = [
      {
        host: "git.example.com",
        type: "custom",
        urlTemplate: "https://review.example.com/{owner}/{repo}/pr?from={branch}"
      }
    ];
    expect(pullRequestCreateUrl("https://git.example.com/team/app.git", "dev", providers)).toBe(
      "https://review.example.com/team/app/pr?from=dev"
    );
  });
});

describe("findPullRequestProvider", () => {
  it("prefers a configured provider over the built-in for the same host", () => {
    const configured: PullRequestProvider = { host: "GitHub.com", type: "gitea" };
    expect(findPullRequestProvider("github.com", [configured])).toBe(configured);
  });

  it("falls back to the built-ins, and reports nothing for an unknown host", () => {
    expect(findPullRequestProvider("GITLAB.COM", [])).toMatchObject({ type: "gitlab" });
    expect(findPullRequestProvider("git.example.com", [])).toBeNull();
  });
});

describe("fillPullRequestUrlTemplate", () => {
  it("splits owner and repo at the last slash of the path", () => {
    expect(
      fillPullRequestUrlTemplate(
        "{host}|{path}|{owner}|{repo}|{branch}",
        { host: "git.example.com", path: "grp/sub/proj" },
        "dev"
      )
    ).toBe("git.example.com|grp/sub/proj|grp/sub|proj|dev");
  });

  it("defaults {scheme} to https for a remote parsed without one", () => {
    expect(fillPullRequestUrlTemplate("{scheme}://x", { host: "h", path: "o/r" }, "dev")).toBe(
      "https://x"
    );
  });
});

describe("normalizePullRequestProviders", () => {
  it("keeps well-formed entries, lower-casing the host", () => {
    expect(normalizePullRequestProviders([{ host: " Git.Example.com ", type: "gitea" }])).toEqual([
      { host: "git.example.com", type: "gitea" }
    ]);
  });

  it("drops entries that could not produce a URL", () => {
    expect(
      normalizePullRequestProviders([
        null,
        "not an object",
        { type: "gitea" }, // no host
        { host: "a.example.com" }, // no type
        { host: "b.example.com", type: "svn" }, // unknown forge
        { host: "c.example.com", type: "custom" }, // custom without a template
        { host: "d.example.com", type: "custom", urlTemplate: "   " },
        // A template that never names the branch cannot pre-fill one, so it is
        // dropped rather than opened as a link that ignores the branch.
        { host: "e.example.com", type: "custom", urlTemplate: "https://e.example.com/pulls/new" }
      ])
    ).toEqual([]);
  });

  it("ignores a value that is not an array at all", () => {
    expect(normalizePullRequestProviders(undefined)).toEqual([]);
    expect(normalizePullRequestProviders({ host: "x", type: "gitea" })).toEqual([]);
  });
});

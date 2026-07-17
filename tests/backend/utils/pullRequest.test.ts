import { describe, expect, it } from "vitest";

import { pullRequestCreateUrl } from "@/backend/utils/pullRequest";

describe("pullRequestCreateUrl", () => {
  it("builds a GitHub compare URL from an https remote", () => {
    expect(pullRequestCreateUrl("https://github.com/owner/repo.git", "feature/x")).toBe(
      "https://github.com/owner/repo/compare/feature%2Fx?expand=1"
    );
  });

  it("builds a GitHub URL from an ssh remote", () => {
    expect(pullRequestCreateUrl("git@github.com:owner/repo", "dev")).toBe(
      "https://github.com/owner/repo/compare/dev?expand=1"
    );
  });

  it("builds a GitLab merge-request URL", () => {
    expect(pullRequestCreateUrl("https://gitlab.com/grp/proj.git", "dev")).toBe(
      "https://gitlab.com/grp/proj/-/merge_requests/new?merge_request%5Bsource_branch%5D=dev"
    );
  });

  it("builds a Bitbucket pull-request URL", () => {
    expect(pullRequestCreateUrl("git@bitbucket.org:team/repo.git", "dev")).toBe(
      "https://bitbucket.org/team/repo/pull-requests/new?source=dev&t=1"
    );
  });

  it("returns null for an unsupported host or missing remote", () => {
    expect(pullRequestCreateUrl("https://example.com/owner/repo.git", "dev")).toBeNull();
    expect(pullRequestCreateUrl(null, "dev")).toBeNull();
  });
});

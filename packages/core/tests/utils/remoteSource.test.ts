import { describe, expect, it } from "vitest";

import { remoteSourceFromUrl } from "@/backend/utils/remoteSource";

describe("remoteSourceFromUrl", () => {
  it("recognises GitHub HTTPS remotes", () => {
    expect(remoteSourceFromUrl("https://github.com/owner/repo.git")).toEqual({
      type: "github",
      owner: "owner",
      repo: "repo"
    });
    // The .git suffix is optional.
    expect(remoteSourceFromUrl("https://github.com/owner/repo")).toEqual({
      type: "github",
      owner: "owner",
      repo: "repo"
    });
  });

  it("recognises GitHub SSH remotes", () => {
    expect(remoteSourceFromUrl("git@github.com:owner/repo.git")).toEqual({
      type: "github",
      owner: "owner",
      repo: "repo"
    });
    expect(remoteSourceFromUrl("git@github.com:owner/repo")).toEqual({
      type: "github",
      owner: "owner",
      repo: "repo"
    });
  });

  it("recognises GitLab HTTPS and SSH remotes", () => {
    expect(remoteSourceFromUrl("https://gitlab.com/group/project.git")).toEqual({ type: "gitlab" });
    expect(remoteSourceFromUrl("git@gitlab.com:group/project.git")).toEqual({ type: "gitlab" });
  });

  it("falls back to gravatar for other hosts and missing remotes", () => {
    expect(remoteSourceFromUrl("https://bitbucket.org/owner/repo.git")).toEqual({
      type: "gravatar"
    });
    expect(remoteSourceFromUrl("git@example.com:owner/repo.git")).toEqual({ type: "gravatar" });
    expect(remoteSourceFromUrl(null)).toEqual({ type: "gravatar" });
  });
});

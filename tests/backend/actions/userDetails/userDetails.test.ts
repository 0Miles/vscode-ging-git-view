import * as cp from "node:child_process";
import * as fs from "node:fs";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { getUserDetails, setUserDetails } from "@/backend/actions/userDetails";

import { makeRepo } from "@tests/backend/helpers";

let repo: string;

afterEach(() => {
  if (repo) fs.rmSync(repo, { recursive: true, force: true });
});

function localConfig(key: string): string {
  try {
    return cp
      .execFileSync("git", ["config", "--local", "--get", key], { cwd: repo })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

describe("user details actions", () => {
  it("reads the configured user name and email", async () => {
    repo = makeRepo(); // makeRepo sets user.name=T, user.email=t@t.com
    expect(await getUserDetails(simpleGit(repo))).toEqual({ name: "T", email: "t@t.com" });
  });

  it("sets the local user name and email", async () => {
    repo = makeRepo();
    await setUserDetails(simpleGit(repo), {
      name: "Alice Example",
      email: "alice@example.com",
      useGlobal: false
    });
    expect(localConfig("user.name")).toBe("Alice Example");
    expect(localConfig("user.email")).toBe("alice@example.com");
  });

  it("unsets a field when given an empty value", async () => {
    repo = makeRepo();
    await setUserDetails(simpleGit(repo), {
      name: "",
      email: "keep@example.com",
      useGlobal: false
    });
    expect(localConfig("user.name")).toBe(""); // unset
    expect(localConfig("user.email")).toBe("keep@example.com");
  });

  it("does not throw when unsetting an already-absent field", async () => {
    repo = makeRepo();
    cp.execFileSync("git", ["config", "--local", "--unset", "user.name"], { cwd: repo });
    await expect(
      setUserDetails(simpleGit(repo), { name: "", email: "", useGlobal: false })
    ).resolves.toBeUndefined();
  });
});

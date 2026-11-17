import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CloneCancelledError,
  CloneFailedError,
  CloneFolderError,
  cloneFolderName,
  type CloneProgress,
  cloneRepository,
  cloneUrlProblem,
  CloneUrlError,
  urlWithoutCredentials
} from "@ging/core/backend/actions/clone";
import { createRepoCloneCommand } from "@ging/core/extension/repoCloneCommand";

import {
  fakePorts,
  makeRepo,
  makeTempDir,
  rejection,
  rmrf,
  toRepoPath
} from "@ging/core/tests/helpers";

// Clone Repository (#395), on real git: from `file://` bare repositories, and
// from local HTTP servers that never let git in (ADR-0032: the network is
// local only). No credential helper or prompt of the machine's may answer for
// git, so every clone runs in an environment kept away from the user's git
// config, with no askpass and no terminal to ask on.

let dirs: string[] = [];
let servers: http.Server[] = [];
const tempDir = (prefix = "ngg-clone-") => {
  const dir = makeTempDir(prefix);
  dirs.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
  servers = [];
  dirs.forEach(rmrf);
  dirs = [];
});

/** git with no config but the repository's, and nobody to ask for a
 *  credential: no askpass, no terminal, no credential helper's GUI. */
function isolatedEnv(): NodeJS.ProcessEnv {
  const home = tempDir("ngg-clone-home-");
  return {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GCM_INTERACTIVE: "never"
  };
}

/** A bare repository of a `makeRepo()` with two more commits, and its
 *  `file://` URL. */
function bareRemote(): { url: string; head: string } {
  const repo = makeRepo();
  dirs.push(repo);
  for (const n of [1, 2]) {
    fs.writeFileSync(path.join(repo, `file${n}`), `${n}\n`);
    cp.execFileSync("git", ["add", "."], { cwd: repo });
    cp.execFileSync("git", ["commit", "-m", `commit ${n}`], { cwd: repo });
  }
  const bare = path.join(tempDir(), "remote.git");
  cp.execFileSync("git", ["clone", "--bare", "--template=", repo, bare], { stdio: "pipe" });
  const head = cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
  return { url: pathToFileURL(bare).href, head };
}

/** A local HTTP server answering every request with `answer`, or never when
 *  it is `null`, and the connections open to it now. */
async function localServer(answer: 401 | null) {
  const sockets = new Set<Socket>();
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    req.resume();
    if (answer === null) return;
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="GING test"' });
    res.end("Unauthorized\n");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/repo.git`,
    requests: () => requests,
    connections: () => sockets.size
  };
}

const git = (args: string[], cwd: string) =>
  cp.execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

describe("cloneRepository", () => {
  it("clones a file:// bare repository into a new folder and answers its top as git spells it", async () => {
    const { url, head } = bareRemote();
    const folder = path.join(tempDir(), "cloned");

    const result = await cloneRepository({ gitPath: "git", url, folder, gitEnv: isolatedEnv() });

    expect(result).toEqual({ repo: toRepoPath(folder) });
    expect(git(["rev-parse", "HEAD"], folder)).toBe(head);
    expect(git(["rev-parse", "--is-bare-repository"], folder)).toBe("false");
  });

  it("reports git's progress as it goes, each stage up to 100%", async () => {
    const { url } = bareRemote();
    const progress: CloneProgress[] = [];

    await cloneRepository({
      gitPath: "git",
      url,
      folder: path.join(tempDir(), "cloned"),
      gitEnv: isolatedEnv(),
      onProgress: (p) => progress.push(p)
    });

    expect(progress.length).toBeGreaterThan(0);
    for (const p of progress) {
      expect(p.percent).toBeGreaterThanOrEqual(0);
      expect(p.percent).toBeLessThanOrEqual(100);
      // git's own words, without the `remote: ` before the remote's.
      expect(p.text).toMatch(/^[A-Z][^:]*: +\d+%/);
    }
    expect(progress).toContainEqual(
      expect.objectContaining({ text: expect.stringMatching(/^Receiving objects: +100%/) })
    );
  });

  it("clones into a folder that is there and empty", async () => {
    const { url, head } = bareRemote();
    const folder = tempDir();

    const result = await cloneRepository({ gitPath: "git", url, folder, gitEnv: isolatedEnv() });

    expect(result).toEqual({ repo: toRepoPath(folder) });
    expect(git(["rev-parse", "HEAD"], folder)).toBe(head);
  });

  it("refuses a folder that is not empty, or a file, or in no folder, before running git", async () => {
    const { url } = bareRemote();
    const full = tempDir();
    fs.writeFileSync(path.join(full, "keep.txt"), "mine");
    const file = path.join(tempDir(), "a-file");
    fs.writeFileSync(file, "x");
    const orphan = path.join(tempDir(), "no", "such", "parent");
    const commands: string[][] = [];

    const failures = await Promise.all(
      [full, file, orphan].map((folder) =>
        rejection(
          cloneRepository({
            gitPath: "git",
            url,
            folder,
            onCommand: (_, args) => commands.push(args)
          })
        )
      )
    );

    expect(failures.map((e) => e instanceof CloneFolderError && e.why)).toEqual([
      "notEmpty",
      "notEmpty",
      "noParent"
    ]);
    expect(commands).toEqual([]);
    expect(fs.readdirSync(full)).toEqual(["keep.txt"]);
    expect(fs.readFileSync(file, "utf8")).toBe("x");
  });

  it("refuses a URL that would run something or read as an option, before running git", async () => {
    const commands: string[][] = [];
    const folder = path.join(tempDir(), "cloned");

    const failure = await rejection(
      cloneRepository({
        gitPath: "git",
        url: "ext::sh -c touch% /tmp/pwned",
        folder,
        onCommand: (_, args) => commands.push(args)
      })
    );

    expect(failure).toBeInstanceOf(CloneUrlError);
    expect((failure as CloneUrlError).problem).toBe("transport");
    expect(commands).toEqual([]);
    expect(fs.existsSync(folder)).toBe(false);
  });

  it("puts `--` before the URL and the folder, and turns git's ext transport off", async () => {
    const { url } = bareRemote();
    const folder = path.join(tempDir(), "cloned");
    const commands: string[][] = [];

    await cloneRepository({
      gitPath: "git",
      url,
      folder,
      gitEnv: isolatedEnv(),
      onCommand: (_, args) => commands.push(args)
    });

    const clone = commands[0];
    expect(clone.slice(clone.indexOf("clone"))).toEqual(["clone", "--progress", "--", url, folder]);
    expect(clone.slice(0, clone.indexOf("clone"))).toEqual(
      expect.arrayContaining(["-c", "protocol.ext.allow=never"])
    );
  });

  it("fails on a remote that turns git away, and leaves no folder behind", async () => {
    const server = await localServer(401);
    const folder = path.join(tempDir(), "cloned");

    const failure = await rejection(
      cloneRepository({ gitPath: "git", url: server.url, folder, gitEnv: isolatedEnv() })
    );

    expect(failure).toBeInstanceOf(CloneFailedError);
    expect((failure as CloneFailedError).leftBehind).toBe(false);
    // git's own reason, without its progress.
    expect((failure as Error).message).toMatch(/fatal:/);
    expect(server.requests()).toBeGreaterThan(0);
    expect(fs.existsSync(folder)).toBe(false);
  });

  it("fails on a remote that is no repository, and leaves the empty folder it was given empty", async () => {
    const folder = tempDir();
    const missing = pathToFileURL(path.join(tempDir(), "nothing-here.git")).href;

    const failure = await rejection(
      cloneRepository({ gitPath: "git", url: missing, folder, gitEnv: isolatedEnv() })
    );

    expect(failure).toBeInstanceOf(CloneFailedError);
    expect(fs.readdirSync(folder)).toEqual([]);
  });

  describe("cancelled", () => {
    /** A clone of a remote that never answers, once git has reached it and
     *  made the folder, and how to cancel it. */
    async function stalledClone(folder: string) {
      const server = await localServer(null);
      const abort = new AbortController();
      const cloning = rejection(
        cloneRepository({
          gitPath: "git",
          url: server.url,
          folder,
          signal: abort.signal,
          gitEnv: isolatedEnv()
        })
      );
      await vi.waitFor(() => expect(server.requests()).toBeGreaterThan(0), { timeout: 10_000 });
      return { server, abort, cloning };
    }

    it("kills git, its remote helper with it, and removes the folder it made", async () => {
      const folder = path.join(tempDir(), "cloned");
      const { server, abort, cloning } = await stalledClone(folder);
      expect(fs.existsSync(folder)).toBe(true);

      abort.abort();
      const failure = await cloning;

      expect(failure).toBeInstanceOf(CloneCancelledError);
      expect((failure as CloneCancelledError).leftBehind).toBe(false);
      expect(fs.existsSync(folder)).toBe(false);
      // Nothing of git's is left holding the remote's connection.
      await vi.waitFor(() => expect(server.connections()).toBe(0), { timeout: 10_000 });
    });

    it("leaves an empty folder it was given there, and empty", async () => {
      const folder = tempDir();
      const { abort, cloning } = await stalledClone(folder);

      abort.abort();

      expect(await cloning).toBeInstanceOf(CloneCancelledError);
      expect(fs.readdirSync(folder)).toEqual([]);
    });
  });
});

describe("cloneUrlProblem", () => {
  it.each([
    "https://example.com/owner/repo.git",
    "http://127.0.0.1:8080/repo.git",
    "HTTPS://EXAMPLE.COM/REPO",
    "ssh://git@example.com:22/owner/repo.git",
    "git://example.com/repo.git",
    "git+ssh://example.com/repo",
    "file:///C:/repos/repo.git",
    "file:///srv/git/repo.git",
    "git@github.com:owner/repo.git",
    "example.com:repo.git",
    "/srv/git/repo.git",
    "C:\\repos\\repo",
    "D:/repos/repo.git",
    "\\\\server\\share\\repo.git"
  ])("takes %s", (url) => {
    expect(cloneUrlProblem(url)).toBeNull();
  });

  it.each([
    ["", "empty"],
    ["ext::sh -c touch% /tmp/pwned", "transport"],
    ["file::/srv/repo.git", "transport"],
    ["fd::17", "transport"],
    ["git-remote-x::anything", "transport"],
    ["-uhelp", "option"],
    ["--upload-pack=touch /tmp/pwned", "option"],
    ["https://example.com/repo\n.git", "control"],
    ["https://example.com/re\u0000po", "control"],
    ["ftp://example.com/repo.git", "scheme"],
    ["javascript://example.com/repo", "scheme"],
    ["repo.git", "relative"],
    ["../other/repo", "relative"],
    ["owner/repo", "relative"],
    ["https://example.com/..", "noName"],
    ["/", "noName"]
  ])("turns away %j as %s", (url, problem) => {
    expect(cloneUrlProblem(url)).toBe(problem);
  });
});

describe("cloneFolderName", () => {
  it.each([
    ["https://example.com/owner/repo.git", "repo"],
    ["https://example.com/owner/repo", "repo"],
    ["https://example.com/owner/repo/", "repo"],
    ["https://example.com/owner/repo/.git", "repo"],
    ["https://example.com", "example.com"],
    ["https://user:token@example.com:8443", "example.com"],
    ["git@github.com:owner/repo.git", "repo"],
    ["example.com:repo.git", "repo"],
    ["file:///C:/repos/remote.git", "remote"],
    ["C:\\repos\\project", "project"],
    ["/srv/git/project.git/", "project"],
    ["https://example.com/a/what?.git", "what-"],
    ["https://example.com/a/trailing.", "trailing"]
  ])("names %s %s", (url, name) => {
    expect(cloneFolderName(url)).toBe(name);
  });
});

describe("urlWithoutCredentials", () => {
  it.each([
    ["https://user:token@example.com/repo.git", "https://example.com/repo.git"],
    ["https://token@example.com", "https://example.com"],
    ["https://example.com/a@b", "https://example.com/a@b"],
    ["git@github.com:owner/repo.git", "git@github.com:owner/repo.git"]
  ])("shows %s as %s", (url, shown) => {
    expect(urlWithoutCredentials(url)).toBe(shown);
  });
});

describe("the Clone Repository command service", () => {
  const command = (ports: ReturnType<typeof fakePorts>["ports"]) =>
    createRepoCloneCommand({ prompts: ports.prompts, l10n: ports.l10n, gitPath: () => "git" });

  it("answers the repository it cloned, saying nothing", async () => {
    const { ports, calls } = fakePorts();
    const { url } = bareRemote();
    const folder = path.join(tempDir(), "cloned");

    expect(await command(ports).cloneRepo(url, folder, { gitEnv: isolatedEnv() })).toEqual({
      repo: toRepoPath(folder)
    });
    expect(calls).toEqual([]);
  });

  it("says why a URL is no URL to clone, in the app's words, spaces around it not counted", () => {
    const { ports } = fakePorts();
    const service = command(ports);

    expect(service.urlProblem("  https://example.com/repo.git  ")).toBeUndefined();
    expect(service.urlProblem("ext::sh -c x")).toBe("clone.url.transport");
    expect(service.urlProblem("-x")).toBe("clone.url.option");
    expect(service.urlProblem("   ")).toBe("clone.url.empty");
  });

  it("puts the clone in a folder under the one chosen, named after the repository", () => {
    const { ports } = fakePorts();
    const parent = tempDir();

    expect(command(ports).folderFor(parent, "git@github.com:owner/project.git")).toBe(
      path.join(parent, "project")
    );
  });

  it("says why, in the app's words, when the folder is taken", async () => {
    const { ports, calls } = fakePorts();
    const folder = tempDir();
    fs.writeFileSync(path.join(folder, "keep.txt"), "mine");

    expect(await command(ports).cloneRepo(bareRemote().url, folder)).toBeUndefined();
    expect(calls).toEqual([["showError", `clone.unableTo: clone.folderNotEmpty|${folder}`]]);
  });

  it("says why, in git's words, when git fails", async () => {
    const { ports, calls } = fakePorts();
    const server = await localServer(401);

    expect(
      await command(ports).cloneRepo(server.url, path.join(tempDir(), "cloned"), {
        gitEnv: isolatedEnv()
      })
    ).toBeUndefined();
    expect(calls).toEqual([["showError", expect.stringMatching(/^clone\.unableTo: .+/)]]);
    expect(calls[0][1]).not.toMatch(/Receiving|Counting|remote:/);
  });

  it("says nothing of a clone that was cancelled", async () => {
    const { ports, calls } = fakePorts();
    const abort = new AbortController();
    abort.abort();

    expect(
      await command(ports).cloneRepo(bareRemote().url, path.join(tempDir(), "cloned"), {
        signal: abort.signal
      })
    ).toBeUndefined();
    expect(calls).toEqual([]);
  });
});

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { type ElectronApplication, expect, type Page, test } from "@playwright/test";

import { isolatedGitEnv, makeFixtureRepo } from "./fixtureRepo";
import { APP_DIR, launchApp } from "./launch";
import { answerFolderDialog, answerMessageBoxes, messageBoxes } from "./mainProcess";
import { focusedTabPage, stripTabs, windowPage } from "./tabPages";

// ssh's own prompt through askpass (#470): cloning an `ssh://` URL of a host
// ssh has not seen asks, without a tty, whether to trust the host's key. ssh
// asks that through SSH_ASKPASS alone, and only when SSH_ASKPASS_REQUIRE is
// `force`. A stand-in for ssh, named by the global config's `core.sshCommand`,
// does what OpenSSH 9.2 does there: without `force` it fails at once; with it,
// it puts OpenSSH's own question to "$SSH_ASKPASS" and, answered `yes`, runs
// the `git-upload-pack` git handed it on this machine.

/** OpenSSH 9.2's host key confirmation, word for word but for the host. */
const FINGERPRINT = "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU";
const QUESTION =
  "The authenticity of host 'fake.example (192.0.2.1)' can't be established.\n" +
  `ED25519 key fingerprint is ${FINGERPRINT}.\n` +
  "This key is not known by any other names.\n" +
  "Are you sure you want to continue connecting (yes/no/[fingerprint])? ";

/** The stand-in for ssh: `ssh.variant` is `simple`, so git hands it the host
 *  and the command to run there, nothing else. The command's path is the
 *  URL's, which on Windows starts `/D:/`; git-upload-pack there wants `D:/`. */
const FAKE_SSH = `#!/bin/sh
if [ "$SSH_ASKPASS_REQUIRE" != force ]; then
  echo "Host key verification failed." >&2
  exit 255
fi
helper=$(printf '%s' "$SSH_ASKPASS" | tr '\\\\' '/')
answer=$("$helper" '${QUESTION.replace(/'/g, "'\\''")}')
if [ "$answer" != yes ]; then
  echo "Host key verification failed." >&2
  exit 255
fi
for command; do :; done
exec sh -c "$(printf '%s' "$command" | sed "s#'/\\([A-Za-z]:\\)#'\\1#")"
`;

let scratch: string;
let env: NodeJS.ProcessEnv;
let app: ElectronApplication | null = null;
let cleanUp: string[] = [];

async function launch(): Promise<ElectronApplication> {
  app = await launchApp(
    ["--lang=en-US", APP_DIR, `--user-data-dir=${path.join(scratch, "userData")}`],
    env
  );
  return app;
}

async function closeAndReadLog(): Promise<string> {
  await app?.close();
  app = null;
  return readFileSync(path.join(scratch, "userData", "logs", "main.log"), "utf8");
}

/** Answer the Welcome page's URL prompt with `url`. */
async function typeUrl(window: Page, url: string): Promise<void> {
  const input = window.locator("#hostPromptInput");
  await expect(window.locator("#hostPrompt")).toBeVisible();
  await expect(input).toBeFocused();
  await window.keyboard.type(url);
  await window.keyboard.press("Enter");
}

/** A bare repository to clone, its `ssh://` URL on the fake host, and the
 *  number of commits in it. */
function sshRemote(): { url: string; commits: number } {
  const fixture = makeFixtureRepo(env);
  cleanUp.push(fixture.path);
  const remote = path.join(scratch, "project.git");
  execFileSync("git", ["clone", "--bare", "--template=", fixture.path, remote], {
    env,
    stdio: "pipe"
  });
  const remotePath = remote.split(path.sep).join("/").replace(/^\//, "");
  return { url: `ssh://fake.example/${remotePath}`, commits: fixture.commits.length };
}

test.beforeEach(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "ging-e2e-"));
  const home = path.join(scratch, "home");
  env = isolatedGitEnv(home);
  cleanUp = [];
  // In `$HOME/.gitconfig`, the global config the app's git reads too.
  const fakeSsh = path.join(scratch, "fake-ssh.sh");
  writeFileSync(fakeSsh, FAKE_SSH, { mode: 0o755 });
  writeFileSync(
    path.join(home, ".gitconfig"),
    `[core]\n\tsshCommand = '${fakeSsh.split(path.sep).join("/")}'\n[ssh]\n\tvariant = simple\n`
  );
});

test.afterEach(async () => {
  await app?.close();
  app = null;
  [scratch, ...cleanUp].forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

test("cloning from a host ssh has not seen asks to trust its key, and trusting it clones", async () => {
  const { url, commits } = sshRemote();
  const parent = path.join(scratch, "clones");
  mkdirSync(parent);

  const electronApp = await launch();
  const window = await windowPage(electronApp);
  await answerFolderDialog(electronApp, parent);
  await window.getByRole("button", { name: "Clone Repository..." }).click();
  await typeUrl(window, url);

  // ssh's question, as a choice, its fingerprint on the page.
  const overlay = window.locator("#hostPrompt");
  await expect(overlay.locator(".hostPromptMessage")).toHaveText(
    "The authenticity of host 'fake.example (192.0.2.1)' can't be established."
  );
  await expect(overlay.locator(".hostPromptDetail")).toContainText(FINGERPRINT);
  await expect(window.locator("#hostPromptInput")).toHaveCount(0);
  const buttons = overlay.locator(".hostPromptButtons button");
  await expect(buttons).toHaveCount(2);
  await buttons.first().click();

  const page = await focusedTabPage(electronApp);
  await expect(page.locator("#commitTable tr.commit")).toHaveCount(commits);
  expect((await stripTabs(window)).map(({ title }) => title)).toEqual(["project"]);
  expect(existsSync(path.join(parent, "project", ".git"))).toBe(true);

  const logged = await closeAndReadLog();
  expect(logged).toContain("clone: cloned");
  expect(logged).not.toContain("ERROR:");
});

test("cancelling the host key question fails the clone with ssh's words, leaving no folder and no Tab", async () => {
  const { url } = sshRemote();
  const parent = path.join(scratch, "clones");
  mkdirSync(parent);

  const electronApp = await launch();
  const window = await windowPage(electronApp);
  await answerFolderDialog(electronApp, parent);
  await answerMessageBoxes(electronApp);
  await window.getByRole("button", { name: "Clone Repository..." }).click();
  await typeUrl(window, url);

  const overlay = window.locator("#hostPrompt");
  await expect(overlay.locator(".hostPromptDetail")).toContainText(FINGERPRINT);
  await overlay.getByRole("button", { name: "Cancel" }).click();

  await expect
    .poll(async () => JSON.stringify(await messageBoxes(electronApp)))
    .toContain("Host key verification failed.");
  await expect(window.locator("#clonePanel")).toBeHidden();
  expect(existsSync(path.join(parent, "project"))).toBe(false);
  await expect(window.locator("#tabStrip")).toBeHidden();

  const logged = await closeAndReadLog();
  expect(logged).toContain("clone: did not clone");
  expect(logged).not.toContain("ERROR:");
});

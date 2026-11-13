/* eslint-disable */
// B1 smoke runner (#383): checks 1-4 against main.cjs, check 5 against git.
import { _electron } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const electronPath = (await import("electron")).default;
const userData = mkdtempSync(path.join(tmpdir(), "b1-smoke-"));
const env = { ...process.env, SMOKE_USERDATA: userData };
const results = {};
const record = (n, ok, detail) => {
  results[n] = { ok, detail };
  console.log(`${ok ? "✅" : "❌"} ${n}: ${JSON.stringify(detail)}`);
};

if (process.platform === "linux") {
  const r = spawnSync("sysctl", ["kernel.apparmor_restrict_unprivileged_userns"], {
    encoding: "utf8"
  });
  console.log(`sysctl: ${(r.stdout || r.stderr || String(r.error)).trim()}`);
}

const app = await _electron.launch({
  executablePath: electronPath,
  args: [path.join(here, "main.cjs")],
  env
});
try {
  const win = await app.firstWindow();
  const url = await win.evaluate(() => location.href);
  record(1, url === "about:blank", { url, platform: process.platform });

  const helper = await app.evaluate(() => globalThis.smoke.helper);
  let parsed = null;
  try {
    parsed = JSON.parse(helper.stdout);
  } catch {}
  record(2, helper.status === 0 && parsed?.node && parsed.type === null, helper);

  const menu = await app.evaluate(({ Menu }) => {
    const m = Menu.getApplicationMenu();
    m.getMenuItemById("smoke.enabled").click();
    return {
      clicks: globalThis.smoke.menuClicks,
      enabled: m.getMenuItemById("smoke.enabled").enabled,
      disabledEnabled: m.getMenuItemById("smoke.disabled").enabled
    };
  });
  record(3, menu.clicks === 1 && menu.enabled === true && menu.disabledEnabled === false, menu);

  const abs = path.resolve(userData, "repo");
  const secondArgs = [
    path.join(here, "main.cjs"),
    `--ging-open=${abs}`,
    "--ging-open=relative/dir",
    "--ging-open"
  ];
  if (process.platform === "linux") secondArgs.unshift("--no-sandbox");
  const second = spawn(electronPath, secondArgs, { env, stdio: "ignore" });
  const exitCode = await new Promise((resolve) => second.on("exit", resolve));
  let forwarded;
  for (let i = 0; i < 50; i++) {
    forwarded = await app.evaluate(() => ({
      forwarded: globalThis.smoke.forwarded,
      ignored: globalThis.smoke.ignored
    }));
    if (forwarded.forwarded.length + forwarded.ignored.length > 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  record(
    4,
    exitCode === 0 &&
      forwarded.forwarded.length === 1 &&
      forwarded.forwarded[0] === abs &&
      forwarded.ignored.length === 2,
    { secondExit: exitCode, ...forwarded }
  );
} finally {
  await app.close();
}

const home = mkdtempSync(path.join(tmpdir(), "b1-home-"));
const globalConfig = path.join(home, "empty.gitconfig");
writeFileSync(globalConfig, "");
const git = spawnSync("git", ["config", "--show-origin", "--get-all", "credential.helper"], {
  env: {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_GLOBAL: globalConfig
  },
  cwd: home,
  encoding: "utf8"
});
const baseline = spawnSync("git", ["config", "--show-origin", "--get-all", "credential.helper"], {
  cwd: home,
  encoding: "utf8"
});
record(5, git.stdout.trim() === "", {
  isolated: git.stdout.trim(),
  status: git.status,
  baseline: baseline.stdout.trim()
});

process.exitCode = Object.values(results).every((r) => r.ok) ? 0 : 1;
